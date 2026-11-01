import { sha256 } from '@noble/hashes/sha2.js'
import nacl from 'tweetnacl'
import { concatBytes, encodeFields, fromBase64, toBase64, toHex, utf8 } from './encoding.js'
import { ProtocolError } from './errors.js'
import { Envelope, Message } from './messages.js'
import { z } from 'zod'

const ENVELOPE_DOMAIN = 'trustline/envelope/v1'
const DEVICE_ID_DOMAIN = 'trustline/device-id/v1'
const RELAY_AUTH_DOMAIN = 'trustline/relay-auth/v1'

export const Identity = z.strictObject({
  deviceId: z.string(),
  signPublicKey: z.string(),
  signSecretKey: z.string(),
  boxPublicKey: z.string(),
  boxSecretKey: z.string(),
})
export type Identity = z.infer<typeof Identity>

export interface PeerKeys {
  deviceId: string
  signPublicKey: string
  boxPublicKey: string
}

/** A device id is derived from its signing key, so ids cannot be claimed without the key. */
export function deviceIdFor(signPublicKey: Uint8Array): string {
  return toHex(sha256(encodeFields(DEVICE_ID_DOMAIN, signPublicKey)).slice(0, 16))
}

export function generateIdentity(): Identity {
  const sign = nacl.sign.keyPair()
  const box = nacl.box.keyPair()
  return {
    deviceId: deviceIdFor(sign.publicKey),
    signPublicKey: toBase64(sign.publicKey),
    signSecretKey: toBase64(sign.secretKey),
    boxPublicKey: toBase64(box.publicKey),
    boxSecretKey: toBase64(box.secretKey),
  }
}

export function randomBytes(length: number): Uint8Array {
  return nacl.randomBytes(length)
}

export function sign(message: Uint8Array, identity: Identity): string {
  return toBase64(nacl.sign.detached(message, fromBase64(identity.signSecretKey)))
}

export function verify(message: Uint8Array, signature: string, signPublicKey: string): boolean {
  const signatureBytes = decodeOrNull(signature)
  const key = decodeOrNull(signPublicKey)
  if (signatureBytes?.length !== nacl.sign.signatureLength) return false
  if (key?.length !== nacl.sign.publicKeyLength) return false
  return nacl.sign.detached.verify(message, signatureBytes, key)
}

function decodeOrNull(text: string): Uint8Array | null {
  try {
    return fromBase64(text)
  } catch {
    return null
  }
}

export function envelopeSigningBytes(e: Omit<Envelope, 'signature'>): Uint8Array {
  return encodeFields(
    ENVELOPE_DOMAIN,
    String(e.v),
    e.from,
    e.to,
    String(e.seq),
    fromBase64(e.nonce),
    fromBase64(e.ciphertext),
  )
}

/** Encrypts to the peer's box key, then signs the ciphertext together with its routing fields. */
export function sealMessage(options: {
  sender: Identity
  recipient: PeerKeys
  seq: number
  message: Message
}): Envelope {
  const { sender, recipient, seq, message } = options
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box(
    utf8(JSON.stringify(Message.parse(message))),
    nonce,
    fromBase64(recipient.boxPublicKey),
    fromBase64(sender.boxSecretKey),
  )
  const unsigned = {
    v: 1 as const,
    from: sender.deviceId,
    to: recipient.deviceId,
    seq,
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  }
  return { ...unsigned, signature: sign(envelopeSigningBytes(unsigned), sender) }
}

/**
 * Verifies, replay-checks, decrypts, and validates an envelope, in that order.
 * The caller must persist the returned `seq` as the new high-water mark.
 */
export function openEnvelope(options: {
  envelope: unknown
  recipient: Identity
  sender: PeerKeys
  lastSeq: number
}): { message: Message; seq: number } {
  const { recipient, sender, lastSeq } = options
  const parsed = Envelope.safeParse(options.envelope)
  if (!parsed.success) throw new ProtocolError('invalid_message', 'Malformed envelope')
  const { signature, ...unsigned } = parsed.data
  if (unsigned.to !== recipient.deviceId) {
    throw new ProtocolError('wrong_recipient', 'Envelope is addressed to another device')
  }
  if (unsigned.from !== sender.deviceId) {
    throw new ProtocolError('wrong_sender', 'Envelope is not from the expected peer')
  }
  let signed: Uint8Array
  let nonce: Uint8Array
  let ciphertext: Uint8Array
  try {
    signed = envelopeSigningBytes(unsigned)
    nonce = fromBase64(unsigned.nonce)
    ciphertext = fromBase64(unsigned.ciphertext)
  } catch {
    throw new ProtocolError('invalid_message', 'Malformed envelope encoding')
  }
  if (nonce.length !== nacl.box.nonceLength) throw new ProtocolError('invalid_message', 'Malformed nonce')
  if (!verify(signed, signature, sender.signPublicKey)) {
    throw new ProtocolError('bad_signature', 'Envelope signature is invalid')
  }
  if (unsigned.seq <= lastSeq) {
    throw new ProtocolError('replay', `Sequence ${unsigned.seq} was already used`)
  }
  const plaintext = nacl.box.open(
    ciphertext,
    nonce,
    fromBase64(sender.boxPublicKey),
    fromBase64(recipient.boxSecretKey),
  )
  if (!plaintext) throw new ProtocolError('decrypt_failed', 'Envelope failed to decrypt')
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    throw new ProtocolError('invalid_message', 'Envelope plaintext is not JSON')
  }
  const message = Message.safeParse(json)
  if (!message.success) throw new ProtocolError('invalid_message', 'Unknown or malformed message')
  return { message: message.data, seq: unsigned.seq }
}

export function secretSeal(plaintext: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  return toBase64(concatBytes(nonce, nacl.secretbox(utf8(plaintext), nonce, key)))
}

export function secretOpen(sealed: string, key: Uint8Array): string | null {
  const bytes = decodeOrNull(sealed)
  if (!bytes || bytes.length < nacl.secretbox.nonceLength) return null
  const nonce = bytes.slice(0, nacl.secretbox.nonceLength)
  const plaintext = nacl.secretbox.open(bytes.slice(nacl.secretbox.nonceLength), nonce, key)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

export function relayAuthBytes(challenge: string, deviceId: string): Uint8Array {
  return encodeFields(RELAY_AUTH_DOMAIN, challenge, deviceId)
}

export function hashHex(data: Uint8Array): string {
  return toHex(sha256(data))
}
