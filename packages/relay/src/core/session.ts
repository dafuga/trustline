import {
  ClientFrame,
  MAX_FRAME_BYTES,
  deviceIdFor,
  fromBase64,
  randomBytes,
  relayAuthBytes,
  toBase64,
  utf8,
  verify,
  type QueuedItem,
  type RelayErrorCode,
  type RoomReadResult,
  type ServerFrame,
} from '@dafuga/trustline-protocol'
import type { Result } from './kv.js'
import { DEFAULT_LIMITS, takeToken, type Bucket, type RateGuard, type RelayLimits } from './rate-limit.js'

/** What a connection needs from storage, whether in-process or across Durable Objects. */
export interface RelayBackend {
  enqueue(to: string, from: string, payload: string): Promise<Result<{ id: string; expiresAt: number }>>
  fetch(device: string): Promise<QueuedItem[]>
  ack(device: string, ids: string[]): Promise<void>
  block(device: string, peer: string): Promise<void>
  unblock(device: string, peer: string): Promise<void>
  roomCreate(roomId: string, device: string, ttlMs: number): Promise<Result<{ expiresAt: number }>>
  roomJoin(roomId: string, device: string): Promise<Result<{ expiresAt: number }>>
  roomPost(roomId: string, device: string, payload: string): Promise<Result<null>>
  roomRead(roomId: string, device: string, after: number): Promise<Result<RoomReadResult>>
}

/** Plain data, so a Durable Object can persist it across hibernation. */
export interface ConnectionState {
  challenge: string
  /** The device this connection was routed to, which auth must match. */
  expectedDeviceId?: string
  deviceId?: string
  /** The caller's rate-limit key (see `ipKey`). */
  ip: string
  bucket?: Bucket
  /** Refused frames, less one for each frame let through. */
  strikes: number
}

export interface FrameOptions {
  limits?: RelayLimits
  now?: () => number
}

export interface FrameResult {
  state: ConnectionState
  reply: string
  /** Set when the relay is done with this connection. */
  close?: boolean
}

export function newConnection(
  expectedDeviceId: string | undefined,
  ip: string,
): { state: ConnectionState; greeting: string } {
  const challenge = toBase64(randomBytes(32))
  const frame: ServerFrame = { kind: 'challenge', nonce: challenge }
  return { state: { challenge, expectedDeviceId, ip, strikes: 0 }, greeting: JSON.stringify(frame) }
}

function encode(frame: ServerFrame): string {
  return JSON.stringify(frame)
}

function errorFrame(reqId: number, code: RelayErrorCode, message: string): string {
  return encode({ kind: 'error', reqId, code, message })
}

function resultFrame<T>(reqId: number, result: Result<T>): string {
  return result.ok
    ? encode({ kind: 'ok', reqId, result: result.value })
    : errorFrame(reqId, result.code, result.code)
}

function authenticate(state: ConnectionState, frame: Extract<ClientFrame, { op: 'auth' }>): boolean {
  if (state.expectedDeviceId && state.expectedDeviceId !== frame.deviceId) return false
  try {
    if (deviceIdFor(fromBase64(frame.signPublicKey)) !== frame.deviceId) return false
  } catch {
    return false
  }
  return verify(relayAuthBytes(state.challenge, frame.deviceId), frame.signature, frame.signPublicKey)
}

/** Every frame pays, including malformed ones, or junk would be the free way to flood. */
async function admit(
  state: ConnectionState,
  guard: RateGuard,
  limits: RelayLimits,
  now: number,
): Promise<{ state: ConnectionState; allowed: boolean }> {
  const bucket = takeToken(state.bucket, limits.messagesPerConnection, now)
  if (!bucket) return { state, allowed: false }
  const allowed = await guard.message(state.ip, state.deviceId)
  return { state: { ...state, bucket }, allowed }
}

function refuse(state: ConnectionState, raw: string, limits: RelayLimits): FrameResult {
  const strikes = state.strikes + 1
  return {
    state: { ...state, strikes },
    reply: errorFrame(replyId(raw), 'rate_limited', 'Too many messages; slow down'),
    close: strikes >= limits.maxStrikes,
  }
}

/** Best effort, so the client can match the refusal to its call. */
function replyId(raw: string): number {
  try {
    const { reqId } = JSON.parse(raw) as { reqId?: unknown }
    return typeof reqId === 'number' && Number.isSafeInteger(reqId) && reqId >= 0 ? reqId : 0
  } catch {
    return 0
  }
}

/** Processes one raw frame. Shared verbatim by the Worker and the dev relay. */
export async function handleFrame(
  initial: ConnectionState,
  raw: string,
  backend: RelayBackend,
  guard: RateGuard,
  options: FrameOptions = {},
): Promise<FrameResult> {
  const { limits = DEFAULT_LIMITS, now = Date.now } = options
  let state = initial
  try {
    const admitted = await admit(state, guard, limits, now())
    state = admitted.state
    if (raw.length > MAX_FRAME_BYTES || utf8(raw).length > MAX_FRAME_BYTES) {
      return { state, reply: errorFrame(0, 'bad_frame', 'Frame too large') }
    }
    if (!admitted.allowed) return refuse(state, raw, limits)
  } catch {
    return { state, reply: errorFrame(0, 'internal', 'Rate limiter failed') }
  }
  // Decays rather than resets: refills would otherwise excuse any flood too slow to land maxStrikes in a row.
  state = { ...state, strikes: Math.max(0, state.strikes - 1) }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { state, reply: errorFrame(0, 'bad_frame', 'Frame is not JSON') }
  }
  const parsed = ClientFrame.safeParse(json)
  if (!parsed.success) return { state, reply: errorFrame(0, 'bad_frame', 'Unknown or malformed frame') }
  const frame = parsed.data

  if (frame.op === 'auth') {
    if (!authenticate(state, frame)) {
      return { state, reply: errorFrame(frame.reqId, 'unauthorized', 'Authentication failed') }
    }
    let allowed: boolean
    try {
      allowed = await guard.authenticated(frame.deviceId)
    } catch {
      return { state, reply: errorFrame(frame.reqId, 'internal', 'Rate limiter failed') }
    }
    if (!allowed) {
      return { state, reply: errorFrame(frame.reqId, 'rate_limited', 'Too many connections; slow down'), close: true }
    }
    return {
      state: { ...state, deviceId: frame.deviceId },
      reply: encode({ kind: 'ok', reqId: frame.reqId, result: null }),
    }
  }

  const device = state.deviceId
  if (!device) return { state, reply: errorFrame(frame.reqId, 'unauthorized', 'Authenticate first') }

  try {
    return { state, reply: await dispatch(frame, device, backend) }
  } catch {
    return { state, reply: errorFrame(frame.reqId, 'internal', 'Relay storage failed') }
  }
}

async function dispatch(
  frame: Exclude<ClientFrame, { op: 'auth' }>,
  device: string,
  backend: RelayBackend,
): Promise<string> {
  switch (frame.op) {
    case 'send':
      return resultFrame(frame.reqId, await backend.enqueue(frame.to, device, frame.payload))
    case 'fetch': {
      const items = await backend.fetch(device)
      return encode({ kind: 'ok', reqId: frame.reqId, result: { items } })
    }
    case 'ack':
      await backend.ack(device, frame.ids)
      return encode({ kind: 'ok', reqId: frame.reqId, result: null })
    case 'block':
      await backend.block(device, frame.peer)
      return encode({ kind: 'ok', reqId: frame.reqId, result: null })
    case 'unblock':
      await backend.unblock(device, frame.peer)
      return encode({ kind: 'ok', reqId: frame.reqId, result: null })
    case 'room.create':
      return resultFrame(frame.reqId, await backend.roomCreate(frame.roomId, device, frame.ttlMs))
    case 'room.join':
      return resultFrame(frame.reqId, await backend.roomJoin(frame.roomId, device))
    case 'room.post':
      return resultFrame(frame.reqId, await backend.roomPost(frame.roomId, device, frame.payload))
    case 'room.read':
      return resultFrame(frame.reqId, await backend.roomRead(frame.roomId, device, frame.after))
  }
}
