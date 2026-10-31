import {
  DisplayName,
  MAX_PAIRING_TTL_MS,
  ProtocolError,
  abortPairing,
  confirmPairing,
  formatPairingCode,
  joinPairing,
  normalizePairingCode,
  pairedPeer,
  receivePairingPost,
  startPairing,
  DEFAULT_PAIRING_TTL_MS,
  type PairingState,
} from '@dafuga/trustline-protocol'
import { setTimeout as sleep } from 'node:timers/promises'
import { withRelay, type Context } from '../context.js'
import { CliError, ExitCode } from '../errors.js'
import type { PairingFile, Peer } from '../home.js'
import { RelayRejection, type RelayClient } from '../relay-client.js'
import type { CommandResult } from '../main.js'
import { sanitize } from '../output.js'

// Each poll is a new relay connection, so this has to sit inside the relay's per-device rate.
const POLL_MS = 1000

const SCAM_WARNING = [
  'Only share this code with someone you already know and trust.',
  'If someone called, texted, or emailed you first and asked for this code, stop: it is a scam.',
  'Real tech support, banks, and government agencies never ask for it.',
]

function pairingFailure(code: string, message: string): CliError {
  return new CliError(ExitCode.PAIRING_FAILED, code, message)
}

function fromRelay(error: unknown): never {
  if (error instanceof RelayRejection) {
    if (error.code === 'room_expired') throw pairingFailure('code_expired', 'This pairing code has expired')
    if (error.code === 'room_used') throw pairingFailure('code_used', 'This pairing code has already been used')
    if (error.code === 'room_not_found') throw pairingFailure('code_invalid', 'That pairing code was not found')
    throw pairingFailure(error.code, `The relay refused: ${error.code}`)
  }
  throw error
}

function uniqueName(peers: Peer[], wanted: string): string {
  const taken = new Set(peers.filter((peer) => peer.status === 'active').map((peer) => peer.name.toLowerCase()))
  if (!taken.has(wanted.toLowerCase())) return wanted
  for (let suffix = 2; ; suffix++) {
    const candidate = `${wanted}-${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

async function finish(context: Context, file: PairingFile): Promise<Peer> {
  const { home, now } = context
  const { state } = file
  const verified = pairedPeer(state)
  const peers = await home.peers()
  const others = peers.filter((existing) => existing.id !== verified.deviceId)
  const previous = peers.find((existing) => existing.id === verified.deviceId)
  const peer: Peer = {
    id: verified.deviceId,
    name: uniqueName(others, file.peerLabel ?? verified.name),
    role: state.role === 'person' ? 'helper' : 'person',
    signPublicKey: verified.signPublicKey,
    boxPublicKey: verified.boxPublicKey,
    pairedAt: now(),
    status: 'active',
    grants: [],
    // Counters survive a re-pair, or old envelopes would become replayable.
    sendSeq: previous?.sendSeq ?? 0,
    recvSeq: previous?.recvSeq ?? 0,
  }
  // A re-pair is a new trust decision: it replaces the old record and starts from ask-only.
  await home.savePeers([...others, peer])
  if (previous?.status === 'revoked' && peer.role === 'helper') {
    await home.saveOutbox([...(await home.outbox()), { kind: 'unblock', peer: peer.id }])
  }
  await home.appendLog(now(), 'pairing.completed', { peerId: peer.id, peerName: peer.name, role: peer.role })
  await home.clearPairing()
  return peer
}

/** Reports a finished failure once, then forgets the pairing. */
async function fail(context: Context, state: PairingState, error: CliError): Promise<never> {
  await context.home.appendLog(context.now(), 'pairing.failed', { reason: error.code, roomId: state.roomId })
  await context.home.clearPairing()
  throw error
}

function abortError(state: PairingState): CliError {
  return state.abortReason === 'safety_mismatch'
    ? new CliError(ExitCode.SAFETY_MISMATCH, 'safety_mismatch', 'Safety strings did not match. Pairing was cancelled.')
    : pairingFailure('pairing_aborted', 'The other side cancelled this pairing')
}

interface Advanced {
  file: PairingFile
  peer?: Peer
}

/** Drains the pairing room once, moving the state machine as far as it will go. */
async function advance(context: Context, client: RelayClient, file: PairingFile): Promise<Advanced> {
  const { home, now } = context
  let current = file
  const { posts, cursor } = await client.roomRead(current.state.roomId, current.cursor).catch(fromRelay)
  for (const post of posts) {
    try {
      const step = receivePairingPost(current.state, post, now())
      for (const outbound of step.outbound) await client.roomPost(step.state.roomId, outbound).catch(fromRelay)
      current = { ...current, state: step.state }
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error
      if (error.code === 'code_expired') return fail(context, current.state, pairingFailure('code_expired', error.message))
      const aborted = abortPairing(current.state, 'protocol_error')
      for (const outbound of aborted.outbound) await client.roomPost(aborted.state.roomId, outbound).catch(() => undefined)
      return fail(context, current.state, pairingFailure(error.code, error.message))
    }
  }
  current = { ...current, cursor }
  if (current.state.stage === 'aborted') return fail(context, current.state, abortError(current.state))
  if (current.state.stage === 'completed') return { file: current, peer: await finish(context, current) }
  await home.savePairing(current)
  return { file: current }
}

function checkExpiry(context: Context, file: PairingFile): Promise<void> {
  if (context.now() < file.state.expiresAt) return Promise.resolve()
  return fail(context, file.state, pairingFailure('code_expired', 'This pairing code has expired'))
}

function describe(advanced: Advanced | null): CommandResult {
  if (!advanced) return { data: { stage: 'none' }, text: 'No pairing in progress.' }
  const { file, peer } = advanced
  if (peer) {
    return {
      data: { stage: 'completed', peer: { id: peer.id, name: peer.name, role: peer.role } },
      text: `Paired with ${sanitize(peer.name)} (${peer.role}).`,
    }
  }
  const { state } = file
  const data = {
    stage: state.stage,
    role: state.role,
    expiresAt: state.expiresAt,
    localConfirmed: state.localConfirmed,
    peerConfirmed: state.peerConfirmed,
    ...(state.safetyString
      ? { safetyString: state.safetyString, peerName: state.peer?.name }
      : {}),
  }
  const text = state.safetyString
    ? state.localConfirmed
      ? `Confirmed. Waiting for ${sanitize(state.peer?.name ?? 'the other side')} to confirm.`
      : [
          `Your safety string: ${state.safetyString}`,
          `Other side calls itself: ${sanitize(state.peer?.name ?? 'unknown')}`,
          'Talk to them on a channel you trust. Have them read out their string, then run:',
          '  trustline pair confirm <the string they read out>',
          'Do not continue if it differs, or if anyone is pressuring you.',
        ].join('\n')
    : `Waiting for the other side (${state.stage}).`
  return { data, text }
}

/** Keeps advancing until there is something new for the user, or the wait runs out. */
async function advanceUntil(context: Context, waitSeconds: number, done: (advanced: Advanced) => boolean): Promise<Advanced | null> {
  const deadline = context.now() + waitSeconds * 1000
  for (;;) {
    const advanced = await context.home.locked(async () => {
      const file = await context.home.pairing()
      if (!file) return null
      await checkExpiry(context, file)
      return withRelay(context, (client) => advance(context, client, file))
    })
    if (!advanced || advanced.peer || done(advanced) || context.now() >= deadline) return advanced
    await sleep(POLL_MS)
  }
}

export async function pairStart(context: Context, options: { ttlSeconds?: number }): Promise<CommandResult> {
  const { home, identity, name, now } = context
  return home.locked(async () => {
    const existing = await home.pairing()
    if (existing && now() < existing.state.expiresAt) {
      throw new CliError(ExitCode.CONFLICT, 'pairing_in_progress', 'A pairing is already in progress. Run `trustline pair cancel` first.')
    }
    const ttlMs = Math.min(options.ttlSeconds ? options.ttlSeconds * 1000 : DEFAULT_PAIRING_TTL_MS, MAX_PAIRING_TTL_MS)
    const { code, state } = startPairing({ identity, name, now: now(), ttlMs })
    await withRelay(context, (client) => client.roomCreate(state.roomId, ttlMs).catch(fromRelay))
    await home.savePairing({ state, cursor: 0 })
    await home.appendLog(now(), 'pairing.started', { roomId: state.roomId, expiresAt: state.expiresAt })
    const shown = formatPairingCode(code)
    return {
      data: { stage: state.stage, code: shown, expiresAt: state.expiresAt, warning: SCAM_WARNING.join(' ') },
      text: [`Pairing code: ${shown}`, `Expires: ${new Date(state.expiresAt).toLocaleTimeString()}`, '', ...SCAM_WARNING].join('\n'),
    }
  })
}

export async function pairJoin(context: Context, options: { code: string; wait: number }): Promise<CommandResult> {
  const { home, identity, name, now } = context
  await home.locked(async () => {
    if (await home.pairing()) {
      throw new CliError(ExitCode.CONFLICT, 'pairing_in_progress', 'A pairing is already in progress. Run `trustline pair cancel` first.')
    }
    const code = normalizePairingCode(options.code)
    const { state, outbound } = joinPairing({ identity, name, code, now: now() })
    await withRelay(context, async (client) => {
      await client.roomJoin(state.roomId).catch(fromRelay)
      for (const post of outbound) await client.roomPost(state.roomId, post).catch(fromRelay)
    })
    await home.savePairing({ state, cursor: 0 })
    await home.appendLog(now(), 'pairing.joined', { roomId: state.roomId })
  })
  return describe(await advanceUntil(context, options.wait, hasSafetyString))
}

function hasSafetyString(advanced: Advanced): boolean {
  return advanced.file.state.safetyString !== undefined
}

export async function pairStatus(context: Context, options: { wait: number }): Promise<CommandResult> {
  return describe(await advanceUntil(context, options.wait, hasSafetyString))
}

export async function pairConfirm(
  context: Context,
  options: { safetyString: string; wait: number; label?: string },
): Promise<CommandResult> {
  const { home, identity, now } = context
  if (options.label !== undefined) DisplayName.parse(options.label)
  const advanced = await home.locked(async (): Promise<Advanced> => {
    const initial = await home.pairing()
    if (!initial) throw new CliError(ExitCode.NOT_FOUND, 'no_pairing', 'No pairing in progress')
    await checkExpiry(context, initial)
    return withRelay(context, async (client) => {
      const { file } = await advance(context, client, initial)
      if (file.state.stage !== 'awaiting_confirmation') {
        throw new CliError(ExitCode.CONFLICT, 'not_ready', 'There is no safety string to confirm yet')
      }
      if (file.state.localConfirmed) {
        throw new CliError(ExitCode.CONFLICT, 'already_confirmed', 'You already confirmed; run `trustline pair status`')
      }
      const step = confirmPairing({ state: file.state, identity, entered: options.safetyString, now: now() })
      for (const outbound of step.outbound) await client.roomPost(file.state.roomId, outbound).catch(fromRelay)
      if (!step.matched) return fail(context, step.state, abortError(step.state))
      const next = { ...file, state: step.state, peerLabel: options.label ?? file.peerLabel }
      await home.appendLog(now(), 'pairing.confirmed', { roomId: file.state.roomId })
      if (next.state.stage === 'completed') return { file: next, peer: await finish(context, next) }
      await home.savePairing(next)
      return { file: next }
    })
  })
  if (advanced.peer || options.wait <= 0) return describe(advanced)
  return describe(await advanceUntil(context, options.wait, () => false))
}

export async function pairCancel(context: Context): Promise<CommandResult> {
  const { home, now } = context
  return home.locked(async () => {
    const file = await home.pairing()
    if (!file) return { data: { cancelled: false }, text: 'No pairing in progress.' }
    const { outbound } = abortPairing(file.state, 'cancelled')
    // Cancelling must work offline; the room expires on its own regardless.
    await withRelay(context, async (client) => {
      for (const post of outbound) await client.roomPost(file.state.roomId, post)
    }).catch(() => undefined)
    await home.clearPairing()
    await home.appendLog(now(), 'pairing.cancelled', { roomId: file.state.roomId })
    return { data: { cancelled: true }, text: 'Pairing cancelled.' }
  })
}
