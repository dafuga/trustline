import {
  Action,
  Category,
  MAX_INSTRUCTION_LENGTH,
  canonicalUrl,
  describeAction,
  isGrantableAction,
  randomBytes,
  sealMessage,
  toHex,
  type RequestMessage,
} from '@dafuga/trustline-protocol'
import { findPeer, updatePeer, withRelay, type Context } from '../context.js'
import { CliError, ExitCode } from '../errors.js'
import { InboxItem, type Peer } from '../home.js'
import type { CommandResult } from '../main.js'
import { formatTime, sanitize } from '../output.js'
import { RelayRejection } from '../relay-client.js'
import { REQUEST_TTL_MS, decisionFor, expireRequests, queueMessage, relayNote, sync } from '../sync.js'


function renderItem(item: InboxItem): string {
  return [
    `${item.id}  [${item.state}]  from ${sanitize(item.helperName)}`,
    `  action: ${item.action.kind}${item.sensitive ? '  (always needs your approval)' : ''}`,
    ...(item.action.kind === 'instruction' ? [`  helper's label: ${item.action.category} (not verified)`] : []),
    `  received: ${formatTime(item.receivedAt)}   expires: ${formatTime(item.expiresAt)}`,
    // Indented so a multi-line instruction can't pose as another entry.
    `  request: ${sanitize(describeAction(item.action)).replaceAll('\n', '\n    | ')}`,
  ].join('\n')
}

export async function inbox(
  context: Context,
  options: { all: boolean; state?: string; offline: boolean },
): Promise<CommandResult> {
  const { home } = context
  if (options.state !== undefined && !InboxItem.shape.state.safeParse(options.state).success) {
    throw new CliError(ExitCode.USAGE, 'usage', `Unknown state "${options.state}"`)
  }
  const synced = options.offline ? null : await sync(context)
  if (options.offline) await home.locked(() => expireRequests(context))
  const items = await home.inbox()
  const wanted = options.state ?? 'pending'
  const shown = options.all ? items : items.filter((item) => item.state === wanted)
  const relay = synced?.relay ?? 'skipped'
  const listing = shown.length > 0 ? shown.map(renderItem).join('\n\n') : `No ${options.all ? '' : `${wanted} `}requests.`
  return {
    data: { relay, requests: shown },
    text: [...relayNote(relay), listing].join('\n'),
  }
}

async function decide(context: Context, id: string, decision: 'approved' | 'denied'): Promise<CommandResult> {
  const { home, now } = context
  const item = await home.locked(async () => {
    await expireRequests(context)
    const items = await home.inbox()
    const found = items.find((entry) => entry.id === id)
    if (!found) throw new CliError(ExitCode.NOT_FOUND, 'request_not_found', `No request ${id}`)
    if (found.state === 'revoked') {
      throw new CliError(ExitCode.REVOKED, 'helper_revoked', 'This helper was revoked; the request can no longer be approved')
    }
    if (found.state !== 'pending') {
      throw new CliError(ExitCode.CONFLICT, `request_${found.state}`, `Request ${id} is already ${found.state}`)
    }
    const peer = (await home.peers()).find((entry) => entry.id === found.helperId)
    if (peer?.status !== 'active') {
      throw new CliError(ExitCode.REVOKED, 'helper_revoked', 'This helper is no longer active')
    }
    const decidedAt = now()
    const updated: InboxItem = { ...found, state: decision, decidedBy: 'person', decidedAt }
    await home.saveInbox(items.map((entry) => (entry === found ? updated : entry)))
    await home.appendLog(decidedAt, `request.${decision}`, { requestId: id, decidedBy: 'person', helperId: peer.id })
    await queueMessage(context, peer.id, decisionFor(updated, decision, 'person', decidedAt))
    return updated
  })
  // The decision is already final locally, so a relay outage only delays the helper's copy.
  const { relay } = await sync(context)
  return {
    data: { request: item, helperNotified: relay === 'ok' },
    text: `${decision === 'approved' ? 'Approved' : 'Denied'} ${item.id}.${relay === 'ok' ? '' : ' The helper will be told once the relay is reachable.'}`,
  }
}

export const approve = (context: Context, id: string) => decide(context, id, 'approved')
export const deny = (context: Context, id: string) => decide(context, id, 'denied')

function resolvePerson(peers: Peer[], reference: string | undefined): Peer {
  if (reference) return findPeer(peers, reference, 'person')
  const people = peers.filter((peer) => peer.role === 'person')
  const active = people.filter((peer) => peer.status === 'active')
  const [only] = active.length > 0 ? active : people
  if (!only) throw new CliError(ExitCode.NOT_FOUND, 'person_not_found', 'You are not paired with anyone. Run `trustline pair join <code>`.')
  if (active.length > 1) throw new CliError(ExitCode.USAGE, 'person_required', 'You help more than one person; pass --to <person>')
  return only
}

export interface SendOptions {
  words: string[]
  to?: string
  category?: string
  action?: string
  folder?: string
  url?: string
}

/** Builds the action from flags. Plain words are free text; `--action` is for the closed list. */
function actionFrom(options: SendOptions): Action {
  const { words, category, action, folder, url } = options
  if (action === undefined || action === 'instruction') {
    if (folder !== undefined || url !== undefined) {
      throw new CliError(ExitCode.USAGE, 'usage', '--folder and --url go with --action')
    }
    const label = Category.safeParse(category ?? 'other')
    if (!label.success) throw new CliError(ExitCode.USAGE, 'invalid_category', `Unknown category "${category}"`)
    const parsed = Action.safeParse({ kind: 'instruction', category: label.data, text: words.join(' ') })
    if (!parsed.success) {
      throw new CliError(ExitCode.USAGE, 'invalid_instruction', `Instructions must be 1 to ${MAX_INSTRUCTION_LENGTH} characters`)
    }
    return parsed.data
  }
  if (!isGrantableAction(action)) throw new CliError(ExitCode.USAGE, 'invalid_action', `Unknown action "${action}"`)
  if (words.length > 0 || category !== undefined) {
    throw new CliError(ExitCode.USAGE, 'usage', 'An --action takes no free text or --category')
  }
  const scope = { check_status: {}, list_files: { folder }, open_url: { url: url && canonicalUrl(url) } }[action]
  return Action.parse({ kind: action, ...scope })
}

export async function send(context: Context, options: SendOptions): Promise<CommandResult> {
  const { home, identity, now } = context
  const action = actionFrom(options)

  // Picks up any revocation that arrived while we were away.
  await sync(context)

  return home.locked(async () => {
    const peers = await home.peers()
    const peer = resolvePerson(peers, options.to)
    if (peer.status !== 'active') {
      throw new CliError(ExitCode.REVOKED, 'access_revoked', `${peer.name} has revoked your access`)
    }
    const createdAt = now()
    const message: RequestMessage = {
      type: 'request',
      requestId: `req_${toHex(randomBytes(8))}`,
      action,
      createdAt,
      expiresAt: createdAt + REQUEST_TTL_MS,
    }
    const seq = peer.sendSeq + 1
    const envelope = sealMessage({ sender: identity, recipient: { deviceId: peer.id, ...peer }, seq, message })
    await updatePeer(home, peer.id, { sendSeq: seq })
    try {
      await withRelay(context, (client) => client.send(peer.id, JSON.stringify(envelope)))
    } catch (error) {
      if (error instanceof RelayRejection && error.code === 'blocked') {
        // Unauthenticated hint from the relay, so it fails this send but leaves local state alone.
        throw new CliError(ExitCode.REVOKED, 'access_revoked', `${peer.name} has revoked your access`)
      }
      if (error instanceof RelayRejection) {
        throw new CliError(ExitCode.RELAY_UNAVAILABLE, 'relay_rejected', `The relay refused the request: ${error.code}`)
      }
      throw error
    }
    await home.saveSent([
      ...(await home.sent()),
      {
        id: message.requestId,
        personId: peer.id,
        action,
        sentAt: createdAt,
        expiresAt: message.expiresAt,
        state: 'sent',
      },
    ])
    await home.appendLog(createdAt, 'request.sent', { requestId: message.requestId, personId: peer.id })
    return {
      data: { requestId: message.requestId, to: { id: peer.id, name: peer.name }, state: 'sent' },
      text: `Sent ${message.requestId} to ${sanitize(peer.name)}. They must approve it before anything happens.`,
    }
  })
}
