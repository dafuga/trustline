import { describe, expect, it } from 'vitest'
import {
  Message,
  ProtocolError,
  deviceIdFor,
  fromBase64,
  generateIdentity,
  openEnvelope,
  sealMessage,
  toBase64,
  type Envelope,
  type Identity,
} from '../src/index.js'

const alice = generateIdentity()
const bob = generateIdentity()
const request = {
  type: 'request' as const,
  requestId: 'req_0123456789abcdef',
  category: 'other' as const,
  instruction: 'Please open the photo album',
  createdAt: 1,
  expiresAt: 2,
}

const seal = (seq = 1): Envelope => sealMessage({ sender: alice, recipient: bob, seq, message: request })
const open = (envelope: unknown, lastSeq = 0, sender: Identity = alice, recipient: Identity = bob) =>
  openEnvelope({ envelope, recipient, sender, lastSeq })

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof ProtocolError) return error.code
    throw error
  }
  return undefined
}

function flipFirstByte(text: string): string {
  const bytes = fromBase64(text)
  bytes[0] = (bytes[0] as number) ^ 1
  return toBase64(bytes)
}

describe('identity', () => {
  it('derives the device id from the signing key', () => {
    expect(alice.deviceId).toBe(deviceIdFor(fromBase64(alice.signPublicKey)))
    expect(alice.deviceId).not.toBe(bob.deviceId)
  })
})

describe('envelopes', () => {
  it('round-trips a message', () => {
    const { message, seq } = open(seal(7))
    expect(message).toEqual(request)
    expect(seq).toBe(7)
  })

  it('does not expose plaintext in the envelope', () => {
    expect(JSON.stringify(seal())).not.toContain('photo album')
    expect(atob(seal().ciphertext)).not.toContain('photo album')
  })

  it('rejects a flipped ciphertext bit', () => {
    const envelope = seal()
    expect(codeOf(() => open({ ...envelope, ciphertext: flipFirstByte(envelope.ciphertext) }))).toBe('bad_signature')
  })

  it('rejects a changed sequence, nonce, or signature', () => {
    const envelope = seal()
    expect(codeOf(() => open({ ...envelope, seq: 2 }))).toBe('bad_signature')
    expect(codeOf(() => open({ ...envelope, nonce: flipFirstByte(envelope.nonce) }))).toBe('bad_signature')
    expect(codeOf(() => open({ ...envelope, signature: flipFirstByte(envelope.signature) }))).toBe('bad_signature')
  })

  it('rejects ciphertext that is validly signed but not encrypted for us', () => {
    const envelope = sealMessage({ sender: alice, recipient: { ...bob, boxPublicKey: alice.boxPublicKey }, seq: 1, message: request })
    expect(codeOf(() => open(envelope))).toBe('decrypt_failed')
  })

  it('rejects an envelope re-addressed to another device', () => {
    const carol = generateIdentity()
    expect(codeOf(() => open(seal(), 0, alice, carol))).toBe('wrong_recipient')
    expect(codeOf(() => open({ ...seal(), to: carol.deviceId }))).toBe('wrong_recipient')
  })

  it('rejects a sender impersonating a paired peer', () => {
    const mallory = generateIdentity()
    const forged = sealMessage({ sender: mallory, recipient: bob, seq: 1, message: request })
    expect(codeOf(() => open({ ...forged, from: alice.deviceId }))).toBe('bad_signature')
    expect(codeOf(() => open(forged))).toBe('wrong_sender')
  })

  it('rejects replays of a used or older sequence number', () => {
    const envelope = seal(5)
    expect(open(envelope, 4).seq).toBe(5)
    expect(codeOf(() => open(envelope, 5))).toBe('replay')
    expect(codeOf(() => open(envelope, 9))).toBe('replay')
  })

  it('refuses a malformed nonce with a protocol error rather than a crash', () => {
    const envelope = seal()
    expect(codeOf(() => open({ ...envelope, nonce: 'AAAA' }))).toBe('invalid_message')
    expect(codeOf(() => open({ ...envelope, nonce: '!!!' }))).toBe('invalid_message')
  })

  it('rejects structurally invalid envelopes', () => {
    expect(codeOf(() => open(null))).toBe('invalid_message')
    expect(codeOf(() => open({ ...seal(), extra: true }))).toBe('invalid_message')
  })
})

describe('message schema', () => {
  it('has no way to express a permission change', () => {
    expect(Message.safeParse({ type: 'grant', category: 'payments' }).success).toBe(false)
    expect(Message.safeParse({ type: 'permissions.update', grants: ['info'] }).success).toBe(false)
    expect(Message.safeParse({ ...request, grants: ['payments'] }).success).toBe(false)
  })
})
