import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import {
  deviceIdFor,
  randomBytes,
  secretOpen,
  secretSeal,
  sign,
  verify,
  type Identity,
  type PeerKeys,
} from './crypto.js'
import { encodeFields, fromBase64, toBase64, toHex } from './encoding.js'
import { ProtocolError } from './errors.js'
import { Base64, DisplayName } from './messages.js'

export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000
export const MAX_PAIRING_TTL_MS = 15 * 60 * 1000

/** Crockford base32: no I, L, O, or U, so codes survive being read aloud. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 12

const ROOM_DOMAIN = 'trustline/pair-room/v1'
const KEY_DOMAIN = 'trustline/pair-key/v1'
const COMMIT_DOMAIN = 'trustline/pair-commit/v1'
const TRANSCRIPT_DOMAIN = 'trustline/pair-transcript/v1'
const SAS_DOMAIN = 'trustline/pair-sas/v1'
const CONFIRM_DOMAIN = 'trustline/pair-confirm/v1'

/** 32 bytes of base64. Keys come from the other side, so their shape is checked on arrival. */
const Key = Base64.length(44)

const Party = z.strictObject({
  signPublicKey: Key,
  boxPublicKey: Key,
  name: DisplayName,
  nonce: Key,
})
type Party = z.infer<typeof Party>

const PairingPost = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('join'), commitment: z.string() }),
  z.strictObject({
    kind: z.literal('accept'),
    party: Party,
    expiresAt: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('reveal'), party: Party }),
  z.strictObject({ kind: z.literal('confirm'), signature: Base64 }),
  z.strictObject({ kind: z.literal('abort'), reason: z.enum(['safety_mismatch', 'cancelled', 'protocol_error']) }),
])
type PairingPost = z.infer<typeof PairingPost>

export type AbortReason = Extract<PairingPost, { kind: 'abort' }>['reason']

export const PairingStage = z.enum([
  'awaiting_join',
  'awaiting_accept',
  'awaiting_reveal',
  'awaiting_confirmation',
  'completed',
  'aborted',
])
export type PairingStage = z.infer<typeof PairingStage>

export const PairingState = z.strictObject({
  role: z.enum(['person', 'helper']),
  roomId: z.string(),
  pairKey: Base64,
  expiresAt: z.number().int().nonnegative(),
  stage: PairingStage,
  self: Party,
  peer: Party.optional(),
  commitment: z.string().optional(),
  transcript: z.string().optional(),
  safetyString: z.string().optional(),
  localConfirmed: z.boolean(),
  peerConfirmed: z.boolean(),
  abortReason: z.enum(['safety_mismatch', 'cancelled', 'protocol_error']).optional(),
})
export type PairingState = z.infer<typeof PairingState>

export interface PairingStep {
  state: PairingState
  /** Sealed posts for the pairing room, in order. */
  outbound: string[]
}

export function generatePairingCode(): string {
  // 256 is a multiple of 32, so masking each byte is uniform.
  const chars = Array.from(randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte & 31])
  return chars.join('')
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`
}

/** Accepts separators, lower case, and the usual I/L/O misreadings. */
export function normalizePairingCode(input: string): string {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (code.length !== CODE_LENGTH || [...code].some((char) => !CODE_ALPHABET.includes(char))) {
    throw new ProtocolError('invalid_code', 'That is not a valid pairing code')
  }
  return code
}

/** The relay only ever sees this hash of the code, never the code itself. */
export function roomIdFor(code: string): string {
  return toHex(sha256(encodeFields(ROOM_DOMAIN, code)))
}

function pairKeyFor(code: string): Uint8Array {
  return sha256(encodeFields(KEY_DOMAIN, code))
}

function newParty(identity: Identity, name: string): Party {
  return {
    signPublicKey: identity.signPublicKey,
    boxPublicKey: identity.boxPublicKey,
    name: DisplayName.parse(name),
    nonce: toBase64(randomBytes(32)),
  }
}

function commitmentFor(party: Party): string {
  return toHex(
    sha256(
      encodeFields(
        COMMIT_DOMAIN,
        fromBase64(party.signPublicKey),
        fromBase64(party.boxPublicKey),
        party.name,
        fromBase64(party.nonce),
      ),
    ),
  )
}

function seal(state: Pick<PairingState, 'pairKey'>, post: PairingPost): string {
  return secretSeal(JSON.stringify(post), fromBase64(state.pairKey))
}

function unseal(state: PairingState, sealed: string): PairingPost {
  const plaintext = secretOpen(sealed, fromBase64(state.pairKey))
  if (plaintext === null) throw new ProtocolError('bad_pairing_message', 'Pairing message failed to decrypt')
  try {
    return PairingPost.parse(JSON.parse(plaintext))
  } catch {
    throw new ProtocolError('bad_pairing_message', 'Pairing message is malformed')
  }
}

function withTranscript(state: PairingState, peer: Party): PairingState {
  const person = state.role === 'person' ? state.self : peer
  const helper = state.role === 'person' ? peer : state.self
  const transcript = sha256(
    encodeFields(
      TRANSCRIPT_DOMAIN,
      state.roomId,
      ...[person, helper].flatMap((party) => [
        fromBase64(party.signPublicKey),
        fromBase64(party.boxPublicKey),
        party.name,
        fromBase64(party.nonce),
      ]),
    ),
  )
  return {
    ...state,
    peer,
    transcript: toHex(transcript),
    safetyString: safetyStringFor(transcript),
    stage: 'awaiting_confirmation',
  }
}

function safetyStringFor(transcript: Uint8Array): string {
  const digest = sha256(encodeFields(SAS_DOMAIN, transcript))
  const number = new DataView(digest.buffer, digest.byteOffset).getUint32(0) % 1_000_000
  const digits = String(number).padStart(6, '0')
  return `${digits.slice(0, 3)}-${digits.slice(3)}`
}

function normalizeSafetyString(input: string): string {
  return input.replace(/\D/g, '')
}

function confirmBytes(role: PairingState['role'], transcript: string): Uint8Array {
  return encodeFields(CONFIRM_DOMAIN, role, transcript)
}

function assertLive(state: PairingState, now: number): void {
  if (now >= state.expiresAt) throw new ProtocolError('code_expired', 'This pairing code has expired')
}

/** Person side: creates a single-use code to be shared out of band. */
export function startPairing(options: {
  identity: Identity
  name: string
  now: number
  ttlMs?: number
}): { code: string; state: PairingState } {
  const ttlMs = Math.min(options.ttlMs ?? DEFAULT_PAIRING_TTL_MS, MAX_PAIRING_TTL_MS)
  const code = generatePairingCode()
  return {
    code,
    state: {
      role: 'person',
      roomId: roomIdFor(code),
      pairKey: toBase64(pairKeyFor(code)),
      expiresAt: options.now + ttlMs,
      stage: 'awaiting_join',
      self: newParty(options.identity, options.name),
      localConfirmed: false,
      peerConfirmed: false,
    },
  }
}

/**
 * Helper side: commits to its keys before seeing the person's, so nobody in the
 * middle can grind keys until the safety strings happen to collide.
 */
export function joinPairing(options: {
  identity: Identity
  name: string
  code: string
  now: number
}): PairingStep {
  const code = normalizePairingCode(options.code)
  const self = newParty(options.identity, options.name)
  const state: PairingState = {
    role: 'helper',
    roomId: roomIdFor(code),
    pairKey: toBase64(pairKeyFor(code)),
    expiresAt: options.now + MAX_PAIRING_TTL_MS,
    stage: 'awaiting_accept',
    self,
    localConfirmed: false,
    peerConfirmed: false,
  }
  return { state, outbound: [seal(state, { kind: 'join', commitment: commitmentFor(self) })] }
}

/** Applies one post from the other side. Throws ProtocolError on anything out of order. */
export function receivePairingPost(state: PairingState, sealed: string, now: number): PairingStep {
  if (state.stage === 'completed' || state.stage === 'aborted') {
    throw new ProtocolError('invalid_stage', 'This pairing has already finished')
  }
  assertLive(state, now)
  const post = unseal(state, sealed)
  switch (post.kind) {
    case 'join':
      return onJoin(state, post)
    case 'accept':
      return onAccept(state, post)
    case 'reveal':
      return onReveal(state, post)
    case 'confirm':
      return onConfirm(state, post)
    case 'abort':
      return { state: { ...state, stage: 'aborted', abortReason: post.reason }, outbound: [] }
  }
}

function onJoin(state: PairingState, post: Extract<PairingPost, { kind: 'join' }>): PairingStep {
  if (state.role !== 'person') throw new ProtocolError('invalid_stage', 'Unexpected join')
  if (state.stage !== 'awaiting_join') {
    throw new ProtocolError('code_used', 'This pairing code has already been used')
  }
  const next: PairingState = { ...state, stage: 'awaiting_reveal', commitment: post.commitment }
  return {
    state: next,
    outbound: [seal(next, { kind: 'accept', party: state.self, expiresAt: state.expiresAt })],
  }
}

function onAccept(state: PairingState, post: Extract<PairingPost, { kind: 'accept' }>): PairingStep {
  if (state.role !== 'helper' || state.stage !== 'awaiting_accept') {
    throw new ProtocolError('invalid_stage', 'Unexpected accept')
  }
  const next = withTranscript({ ...state, expiresAt: Math.min(state.expiresAt, post.expiresAt) }, post.party)
  return { state: next, outbound: [seal(next, { kind: 'reveal', party: state.self })] }
}

function onReveal(state: PairingState, post: Extract<PairingPost, { kind: 'reveal' }>): PairingStep {
  if (state.role !== 'person' || state.stage !== 'awaiting_reveal') {
    throw new ProtocolError('invalid_stage', 'Unexpected reveal')
  }
  if (commitmentFor(post.party) !== state.commitment) {
    throw new ProtocolError('commitment_mismatch', 'Helper keys do not match its commitment')
  }
  return { state: withTranscript(state, post.party), outbound: [] }
}

function onConfirm(state: PairingState, post: Extract<PairingPost, { kind: 'confirm' }>): PairingStep {
  if (state.stage !== 'awaiting_confirmation' || !state.peer || !state.transcript) {
    throw new ProtocolError('invalid_stage', 'Unexpected confirmation')
  }
  const peerRole = state.role === 'person' ? 'helper' : 'person'
  if (!verify(confirmBytes(peerRole, state.transcript), post.signature, state.peer.signPublicKey)) {
    throw new ProtocolError('bad_pairing_message', 'Confirmation signature is invalid')
  }
  return {
    state: { ...state, peerConfirmed: true, stage: state.localConfirmed ? 'completed' : state.stage },
    outbound: [],
  }
}

/**
 * Records this side's confirmation of the string the other side read out. A
 * mismatch aborts the pairing on both sides. Pairing can only complete after
 * both sides have called this, so a helper can never finish it alone.
 */
export function confirmPairing(options: {
  state: PairingState
  identity: Identity
  entered: string
  now: number
}): PairingStep & { matched: boolean } {
  const { state, identity, entered, now } = options
  if (state.stage !== 'awaiting_confirmation' || !state.safetyString || !state.transcript) {
    throw new ProtocolError('invalid_stage', 'Nothing to confirm yet')
  }
  assertLive(state, now)
  if (normalizeSafetyString(entered) !== normalizeSafetyString(state.safetyString)) {
    return { ...abortPairing(state, 'safety_mismatch'), matched: false }
  }
  const signature = sign(confirmBytes(state.role, state.transcript), identity)
  const next: PairingState = {
    ...state,
    localConfirmed: true,
    stage: state.peerConfirmed ? 'completed' : state.stage,
  }
  return { state: next, outbound: [seal(next, { kind: 'confirm', signature })], matched: true }
}

export function abortPairing(state: PairingState, reason: AbortReason): PairingStep {
  return {
    state: { ...state, stage: 'aborted', abortReason: reason },
    outbound: [seal(state, { kind: 'abort', reason })],
  }
}

/** Reads the verified peer out of a completed pairing. */
export function pairedPeer(state: PairingState): PeerKeys & { name: string } {
  if (state.stage !== 'completed' || !state.peer) {
    throw new ProtocolError('invalid_stage', 'Pairing has not completed')
  }
  const { signPublicKey, boxPublicKey, name } = state.peer
  return { deviceId: deviceIdFor(fromBase64(signPublicKey)), signPublicKey, boxPublicKey, name }
}

