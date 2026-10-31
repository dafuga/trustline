import { z } from 'zod'
import { Base64, DeviceId, Hash } from './messages.js'

export const MAX_FRAME_BYTES = 128 * 1024
export const MAX_PAYLOAD_LENGTH = 64 * 1024
export const MAX_ACK_IDS = 128

const reqId = z.number().int().nonnegative()
const Payload = z.string().min(1).max(MAX_PAYLOAD_LENGTH)
const QueueId = z.string().min(1).max(64)

/** Everything a device can ask of the relay. Payloads are opaque ciphertext. */
export const ClientFrame = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('auth'),
    reqId,
    deviceId: DeviceId,
    signPublicKey: Base64,
    signature: Base64,
  }),
  z.strictObject({ op: z.literal('send'), reqId, to: DeviceId, payload: Payload }),
  z.strictObject({ op: z.literal('fetch'), reqId }),
  z.strictObject({ op: z.literal('ack'), reqId, ids: z.array(QueueId).max(MAX_ACK_IDS) }),
  z.strictObject({ op: z.literal('block'), reqId, peer: DeviceId }),
  z.strictObject({ op: z.literal('unblock'), reqId, peer: DeviceId }),
  z.strictObject({ op: z.literal('room.create'), reqId, roomId: Hash, ttlMs: z.number().int().positive() }),
  z.strictObject({ op: z.literal('room.join'), reqId, roomId: Hash }),
  z.strictObject({ op: z.literal('room.post'), reqId, roomId: Hash, payload: Payload }),
  z.strictObject({ op: z.literal('room.read'), reqId, roomId: Hash, after: z.number().int().nonnegative() }),
])
export type ClientFrame = z.infer<typeof ClientFrame>

export const RelayErrorCode = z.enum([
  'bad_frame',
  'unauthorized',
  'blocked',
  'queue_full',
  'room_exists',
  'room_not_found',
  'room_expired',
  'room_used',
  'room_full',
  'internal',
])
export type RelayErrorCode = z.infer<typeof RelayErrorCode>

export const QueuedItem = z.strictObject({
  id: QueueId,
  from: DeviceId,
  payload: Payload,
  queuedAt: z.number(),
  expiresAt: z.number(),
})
export type QueuedItem = z.infer<typeof QueuedItem>

export const FetchResult = z.strictObject({ items: z.array(QueuedItem) })
export const RoomReadResult = z.strictObject({ posts: z.array(z.string()), cursor: z.number() })
export type RoomReadResult = z.infer<typeof RoomReadResult>

export const ServerFrame = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('challenge'), nonce: Base64 }),
  z.strictObject({ kind: z.literal('ok'), reqId, result: z.unknown() }),
  z.strictObject({ kind: z.literal('error'), reqId, code: RelayErrorCode, message: z.string() }),
])
export type ServerFrame = z.infer<typeof ServerFrame>
