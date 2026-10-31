import { Category, isGrantable } from '@dafuga/trustline-protocol'
import { findPeer, updatePeer, type Context } from '../context.js'
import { CliError, ExitCode } from '../errors.js'
import type { Peer } from '../home.js'
import type { CommandResult } from '../main.js'
import { formatTime, sanitize } from '../output.js'
import { queueMessage, sync } from '../sync.js'

function publicPeer(peer: Peer) {
  const { id, name, role, status, pairedAt, revokedAt, grants } = peer
  return { id, name, role, status, pairedAt, revokedAt, grants }
}

export async function status(context: Context, options: { offline: boolean }): Promise<CommandResult> {
  const { home, identity, relayUrl } = context
  const synced = options.offline ? null : await sync(context)
  const peers = await home.peers()
  const inbox = await home.inbox()
  const sent = await home.sent()
  const pairing = await home.pairing()
  const pending = inbox.filter((item) => item.state === 'pending').length
  const relay = synced?.relay ?? 'skipped'
  return {
    data: {
      deviceId: identity.deviceId,
      home: home.dir,
      relay: { url: relayUrl, state: relay },
      helpers: peers.filter((peer) => peer.role === 'helper').map(publicPeer),
      people: peers.filter((peer) => peer.role === 'person').map(publicPeer),
      pendingRequests: pending,
      sentRequests: sent,
      pairing: pairing ? { stage: pairing.state.stage, expiresAt: pairing.state.expiresAt } : null,
    },
    text: [
      `Device: ${identity.deviceId}`,
      `Relay: ${relayUrl} (${relay})`,
      `Pending requests: ${pending}`,
      ...peers.map(
        (peer) =>
          `${peer.role}: ${sanitize(peer.name)} ${peer.id} [${peer.status}]` +
          (peer.role === 'helper' ? ` grants: ${peer.grants.join(', ') || 'none (ask-only)'}` : ''),
      ),
      ...sent.map((item) => `sent: ${item.id} [${item.state}]`),
    ].join('\n'),
  }
}

export async function logShow(context: Context, options: { limit?: number }): Promise<CommandResult> {
  const entries = await context.home.readLog()
  const shown = options.limit ? entries.slice(-options.limit) : entries
  return {
    data: { entries: shown },
    text:
      shown
        .map((entry) => `${entry.seq} ${formatTime(entry.ts)} ${entry.type} ${sanitize(JSON.stringify(entry.data))}`)
        .join('\n') || 'The log is empty.',
  }
}

export async function logVerify(context: Context): Promise<CommandResult> {
  const result = await context.home.verifyLog()
  if (!result.ok) {
    throw new CliError(ExitCode.LOG_TAMPERED, 'log_tampered', `Log check failed at line ${result.line}: ${result.reason}`, {
      line: result.line,
      reason: result.reason,
      validEntries: result.entries,
    })
  }
  return {
    data: { valid: true, entries: result.entries, headHash: result.head?.hash ?? null },
    text: `Log intact: ${result.entries} entries.`,
  }
}

/**
 * The kill switch. The local record flips first and is what actually enforces
 * this, so it works with the relay down and cannot be undone by the relay.
 */
export async function revoke(context: Context, options: { helper?: string; all: boolean }): Promise<CommandResult> {
  const { home, now } = context
  if (options.all === (options.helper !== undefined)) {
    throw new CliError(ExitCode.USAGE, 'usage', 'Usage: trustline revoke <helper> | trustline revoke --all')
  }
  const revoked = await home.locked(async () => {
    const peers = await home.peers()
    const targets = options.all
      ? peers.filter((peer) => peer.role === 'helper' && peer.status === 'active')
      : [findPeer(peers, options.helper as string, 'helper')]
    const revokedAt = now()
    const fresh = targets.filter((peer) => peer.status === 'active')
    for (const peer of fresh) await updatePeer(home, peer.id, { status: 'revoked', revokedAt, grants: [] })
    const ids = new Set(fresh.map((peer) => peer.id))
    const inbox = await home.inbox()
    await home.saveInbox(
      inbox.map((item) =>
        item.state === 'pending' && ids.has(item.helperId) ? { ...item, state: 'revoked' as const } : item,
      ),
    )
    for (const peer of fresh) {
      await home.appendLog(revokedAt, 'helper.revoked', { helperId: peer.id, helperName: peer.name })
      await queueMessage(context, peer.id, { type: 'revoked', revokedAt })
      await home.saveOutbox([...(await home.outbox()), { kind: 'block', peer: peer.id }])
    }
    return fresh.map((peer) => ({ ...peer, status: 'revoked' as const, revokedAt, grants: [] }))
  })
  const { relay } = await sync(context)
  return {
    data: { revoked: revoked.map(publicPeer), relayNotified: relay === 'ok' },
    text:
      (revoked.length > 0
        ? `Revoked: ${revoked.map((peer) => sanitize(peer.name)).join(', ')}.`
        : 'Nothing to revoke.') + (relay === 'ok' ? '' : ' Their access is already off; the relay will be told when reachable.'),
  }
}

export async function setGrant(
  context: Context,
  options: { helper: string; category: string; granted: boolean },
): Promise<CommandResult> {
  const { home, now } = context
  const category = Category.safeParse(options.category)
  if (!category.success) throw new CliError(ExitCode.USAGE, 'invalid_category', `Unknown category "${options.category}"`)
  if (options.granted && !isGrantable(category.data)) {
    throw new CliError(ExitCode.CONFLICT, 'not_grantable', `"${category.data}" always needs your approval and cannot be granted`)
  }
  return home.locked(async () => {
    const peers = await home.peers()
    const peer = findPeer(peers, options.helper, 'helper')
    if (peer.status !== 'active') throw new CliError(ExitCode.REVOKED, 'helper_revoked', 'This helper was revoked')
    const others = peer.grants.filter((grant) => grant !== category.data)
    const grants = options.granted ? [...others, category.data] : others
    await updatePeer(home, peer.id, { grants })
    await home.appendLog(now(), 'permissions.changed', { helperId: peer.id, grants })
    return {
      data: { helper: publicPeer({ ...peer, grants }) },
      text: `${sanitize(peer.name)} grants: ${grants.join(', ') || 'none (ask-only)'}`,
    }
  })
}
