import { z } from 'zod'

export const ALWAYS_ASK_CATEGORIES = ['payments', 'sends', 'deletes', 'installs', 'settings'] as const
export const GRANTABLE_CATEGORIES = ['info', 'reminders'] as const
export const CATEGORIES = [...ALWAYS_ASK_CATEGORIES, ...GRANTABLE_CATEGORIES, 'other'] as const

export const Category = z.enum(CATEGORIES)
export type Category = z.infer<typeof Category>

export const MAX_INSTRUCTION_LENGTH = 4000
export const MAX_NAME_LENGTH = 64

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/)
const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`))

export const DeviceId = hex(16)
export const Hash = hex(32)
export const Base64 = base64

/** Names reach terminals and assistants, so control and bidi characters are refused outright. */
export const DisplayName = z
  .string()
  .min(1)
  .max(MAX_NAME_LENGTH)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+$/)

export const RequestId = z.string().regex(/^req_[0-9a-f]{16}$/)

export const RequestMessage = z.strictObject({
  type: z.literal('request'),
  requestId: RequestId,
  category: Category,
  instruction: z.string().min(1).max(MAX_INSTRUCTION_LENGTH),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
})
export type RequestMessage = z.infer<typeof RequestMessage>

export const DecisionMessage = z.strictObject({
  type: z.literal('decision'),
  requestId: RequestId,
  decision: z.enum(['approved', 'denied']),
  decidedBy: z.enum(['person', 'grant']),
  decidedAt: z.number().int().nonnegative(),
})
export type DecisionMessage = z.infer<typeof DecisionMessage>

export const RevokedMessage = z.strictObject({
  type: z.literal('revoked'),
  revokedAt: z.number().int().nonnegative(),
})
export type RevokedMessage = z.infer<typeof RevokedMessage>

/**
 * Everything one paired device can say to another. There is deliberately no
 * message that changes permissions: a helper has no way to express it.
 */
export const Message = z.discriminatedUnion('type', [RequestMessage, DecisionMessage, RevokedMessage])
export type Message = z.infer<typeof Message>

export const Envelope = z.strictObject({
  v: z.literal(1),
  from: DeviceId,
  to: DeviceId,
  seq: z.number().int().positive(),
  nonce: Base64,
  ciphertext: Base64,
  signature: Base64,
})
export type Envelope = z.infer<typeof Envelope>
