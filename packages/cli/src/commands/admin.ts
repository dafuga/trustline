import {
  Grant,
  canonicalUrl,
  describeGrant,
  isGrantableAction,
  isNeverAuto,
  sameGrant,
} from '@dafuga/trustline-protocol'
import { findPeer, updatePeer, type Context } from '../context.js'
import { CliError, ExitCode } from '../errors.js'
import type { Peer } from '../home.js'
import { grantCheck, requireHuman } from '../human.js'
import type { CommandResult } from '../main.js'
import { formatTime, sanitize } from '../output.js'
import { queueMessage, relayNote, sync } from '../sync.js'

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
      ...relayNote(relay),
      `Pending requests: ${pending}`,
      ...peers.map(
        (peer) =>
          `${peer.role}: ${sanitize(peer.name)} ${peer.id} [${peer.status}]` +
          (peer.role === 'helper' ? ` grants: ${grantsText(peer.grants)}` : ''),
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

export interface GrantOptions {
  helper: string
  action: string
  folder?: string
  url?: string
  granted: boolean
}

function grantFrom({ action, folder, url }: GrantOptions): Grant {
  if (isNeverAuto(action)) {
    throw new CliError(ExitCode.CONFLICT, 'not_grantable', `"${action}" always needs your approval and cannot be granted`)
  }
  if (!isGrantableAction(action)) throw new CliError(ExitCode.USAGE, 'invalid_action', `Unknown action "${action}"`)
  const scope = { check_status: {}, list_files: { folder }, open_url: { url: url && canonicalUrl(url) } }[action]
  const extra = (folder !== undefined && action !== 'list_files') || (url !== undefined && action !== 'open_url')
  if (extra) throw new CliError(ExitCode.USAGE, 'usage', `--folder goes with list_files and --url with open_url`)
  return Grant.parse({ action, ...scope })
}

function grantsText(grants: Grant[]): string {
  return grants.map(describeGrant).join(', ') || 'none (ask-only)'
}

async function activeHelper(context: Context, reference: string): Promise<Peer> {
  const peer = findPeer(await context.home.peers(), reference, 'helper')
  if (peer.status !== 'active') throw new CliError(ExitCode.REVOKED, 'helper_revoked', 'This helper was revoked')
  return peer
}

function grantResult(peer: Peer, grants: Grant[], extra: Record<string, unknown> = {}): CommandResult {
  return {
    data: { helper: publicPeer({ ...peer, grants }), ...extra },
    text: `${sanitize(peer.name)} grants: ${grantsText(grants)}`,
  }
}

export async function setGrant(context: Context, options: GrantOptions): Promise<CommandResult> {
  const { home, now } = context
  const grant = grantFrom(options)
  const shown = await home.locked(() => activeHelper(context, options.helper))
  // Nothing to change means nothing to ask about.
  if (shown.grants.some((existing) => sameGrant(existing, grant)) === options.granted) {
    return grantResult(shown, shown.grants, { changed: false })
  }
  const localAuth = await requireHuman(context, grantCheck(shown, grant, options.granted))
  return home.locked(async () => {
    const peer = await activeHelper(context, shown.id)
    const others = peer.grants.filter((existing) => !sameGrant(existing, grant))
    const grants = options.granted ? [...others, grant] : others
    await updatePeer(home, peer.id, { grants })
    await home.appendLog(now(), 'permissions.changed', { helperId: peer.id, grants, localAuth })
    return grantResult(peer, grants, { changed: true, localAuth })
  })
}
