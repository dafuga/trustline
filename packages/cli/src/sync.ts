import {
  ProtocolError,
  RequestMessage,
  evaluateRequest,
  openEnvelope,
  sealMessage,
  type DecisionMessage,
  type Message,
} from '@dafuga/trustline-protocol'
import { updatePeer, withRelay, type Context } from './context.js'
import type { InboxItem, Peer } from './home.js'
import { RelayRejection, type RelayClient } from './relay-client.js'
import { CliError, ExitCode } from './errors.js'

export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000

export interface SyncResult {
  relay: 'ok' | 'unreachable' | 'not_configured'
  received: number
  rejected: number
}

/** Seals a message to a peer and queues it, bumping the persisted send counter first. */
export async function queueMessage(context: Context, peerId: string, message: Message): Promise<void> {
  const { home, identity } = context
  const peer = (await home.peers()).find((candidate) => candidate.id === peerId)
  if (!peer) throw new Error(`Unknown peer ${peerId}`)
  const seq = peer.sendSeq + 1
  const envelope = sealMessage({
    sender: identity,
    recipient: { deviceId: peer.id, ...peer },
    seq,
    message,
  })
  await updatePeer(home, peer.id, { sendSeq: seq })
  await home.saveOutbox([...(await home.outbox()), { kind: 'send', to: peer.id, payload: JSON.stringify(envelope) }])
}

async function flushOutbox(context: Context, client: RelayClient): Promise<void> {
  const { home } = context
  const items = await home.outbox()
  let sent = 0
  try {
    for (const item of items) {
      try {
        if (item.kind === 'send') await client.send(item.to, item.payload)
        else if (item.kind === 'block') await client.block(item.peer)
        else await client.unblock(item.peer)
      } catch (error) {
        if (!(error instanceof RelayRejection)) throw error
        // Only a block is permanent. Anything else, such as a full queue, is retried later.
        if (error.code !== 'blocked') break
      }
      sent++
    }
  } finally {
    if (sent > 0) await home.saveOutbox((await home.outbox()).slice(sent))
  }
}

async function logRejection(context: Context, peer: Peer, reason: string): Promise<void> {
  await context.home.appendLog(context.now(), 'message.rejected', { peerId: peer.id, peerName: peer.name, reason })
}

async function acceptRequest(context: Context, peer: Peer, message: RequestMessage): Promise<void> {
  const { home, now } = context
  const inbox = await home.inbox()
  if (inbox.some((item) => item.id === message.requestId)) {
    await logRejection(context, peer, 'duplicate_request_id')
    return
  }
  const receivedAt = now()
  const gate = evaluateRequest({ action: message.action, grants: peer.grants })
  const item: InboxItem = {
    id: message.requestId,
    helperId: peer.id,
    helperName: peer.name,
    action: message.action,
    sensitive: gate.sensitive,
    receivedAt,
    // A helper can shorten a request's life, but not extend it past the local limit.
    expiresAt: Math.min(message.expiresAt, receivedAt + REQUEST_TTL_MS),
    state: gate.decision === 'auto' ? 'approved' : 'pending',
    ...(gate.decision === 'auto' ? { decidedBy: 'grant' as const, decidedAt: receivedAt } : {}),
  }
  await home.saveInbox([...inbox, item])
  await home.appendLog(receivedAt, 'request.received', {
    requestId: item.id,
    helperId: peer.id,
    helperName: peer.name,
    action: item.action,
  })
  if (gate.decision === 'auto') {
    await home.appendLog(receivedAt, 'request.approved', { requestId: item.id, decidedBy: 'grant' })
    await queueMessage(context, peer.id, decisionFor(item, 'approved', 'grant', receivedAt))
  }
}

export function decisionFor(
  item: InboxItem,
  decision: DecisionMessage['decision'],
  decidedBy: DecisionMessage['decidedBy'],
  decidedAt: number,
): DecisionMessage {
  return { type: 'decision', requestId: item.id, decision, decidedBy, decidedAt }
}

async function applyDecision(context: Context, peer: Peer, message: DecisionMessage): Promise<void> {
  const { home } = context
  const sent = await home.sent()
  const item = sent.find((entry) => entry.id === message.requestId && entry.personId === peer.id)
  if (!item) return logRejection(context, peer, 'unknown_request_id')
  const updated = { ...item, state: message.decision, decidedAt: message.decidedAt }
  await home.saveSent(sent.map((entry) => (entry === item ? updated : entry)))
  await home.appendLog(context.now(), 'request.decided', { requestId: item.id, decision: message.decision })
}

async function applyRevocation(context: Context, peer: Peer, revokedAt: number): Promise<void> {
  const { home } = context
  await updatePeer(home, peer.id, { status: 'revoked', revokedAt })
  await home.appendLog(context.now(), 'access.revoked', { personId: peer.id, personName: peer.name })
}

/** Routes by the peer's role, so a device we help can't file requests and vice versa. */
async function dispatch(context: Context, peer: Peer, message: Message): Promise<void> {
  if (peer.role === 'helper' && message.type === 'request') return acceptRequest(context, peer, message)
  if (peer.role === 'person' && message.type === 'decision') return applyDecision(context, peer, message)
  if (peer.role === 'person' && message.type === 'revoked') return applyRevocation(context, peer, message.revokedAt)
  await logRejection(context, peer, `unexpected_${message.type}`)
}

async function drainInbound(context: Context, client: RelayClient): Promise<Omit<SyncResult, 'relay'>> {
  const { home, identity } = context
  let received = 0
  let rejected = 0
  for (;;) {
    const items = await client.fetch()
    if (items.length === 0) return { received, rejected }
    for (const item of items) {
      const peer = (await home.peers()).find((candidate) => candidate.id === item.from)
      if (!peer) {
        // Never paired, so nothing it says is worth keeping, including in the log.
        rejected++
      } else if (peer.status === 'revoked') {
        await logRejection(context, peer, 'revoked')
        rejected++
      } else {
        try {
          const { message, seq } = openEnvelope({
            envelope: parseJson(item.payload),
            recipient: identity,
            sender: { deviceId: peer.id, ...peer },
            lastSeq: peer.recvSeq,
          })
          // Dispatch first: a crash here re-delivers, and dispatch tolerates duplicates.
          await dispatch(context, peer, message)
          await updatePeer(home, peer.id, { recvSeq: seq })
          received++
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error
          await logRejection(context, peer, error.code)
          rejected++
        }
      }
    }
    // Acknowledge only after state is saved, so a crash re-delivers rather than loses.
    await client.ack(items.map((item) => item.id))
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Marks stale pending requests. Never touches anything already decided. */
export async function expireRequests(context: Context): Promise<void> {
  const { home, now } = context
  const inbox = await home.inbox()
  const stale = inbox.filter((item) => item.state === 'pending' && item.expiresAt <= now())
  if (stale.length === 0) return
  await home.saveInbox(inbox.map((item) => (stale.includes(item) ? { ...item, state: 'expired' as const } : item)))
  for (const item of stale) await home.appendLog(now(), 'request.expired', { requestId: item.id })
}

/** A line for human output when a command worked from local state alone. */
export function relayNote(relay: SyncResult['relay'] | 'skipped'): string[] {
  return relay === 'not_configured' ? ['No relay is set. Set TRUSTLINE_RELAY_URL or pass --relay <url>.'] : []
}

/** Exchanges queued traffic with the relay. Being offline is reported, not thrown. */
export async function sync(context: Context): Promise<SyncResult> {
  try {
    const result = await context.home.locked(() =>
      withRelay(context, async (client) => {
        await flushOutbox(context, client)
        const inbound = await drainInbound(context, client)
        await flushOutbox(context, client)
        return inbound
      }),
    )
    await context.home.locked(() => expireRequests(context))
    return { relay: 'ok', ...result }
  } catch (error) {
    if (error instanceof CliError && error.exitCode === ExitCode.RELAY_UNAVAILABLE) {
      await context.home.locked(() => expireRequests(context))
      const relay = error.code === 'relay_not_configured' ? 'not_configured' : 'unreachable'
      return { relay, received: 0, rejected: 0 }
    }
    throw error
  }
}
