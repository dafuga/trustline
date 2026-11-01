import {
  FetchResult,
  RoomReadResult,
  ServerFrame,
  relayAuthBytes,
  sign,
  type ClientFrame,
  type Identity,
  type QueuedItem,
} from '@dafuga/trustline-protocol'
import type { z } from 'zod'
import { CliError, ExitCode } from './errors.js'

const TIMEOUT_MS = 10_000

export class RelayRejection extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RelayRejection'
  }
}

type WithoutReqId<T> = T extends unknown ? Omit<T, 'reqId'> : never
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

function unavailable(url: string): CliError {
  return new CliError(ExitCode.RELAY_UNAVAILABLE, 'relay_unavailable', `Could not reach the relay at ${url}`)
}

function rateLimited(): CliError {
  return new CliError(ExitCode.RELAY_UNAVAILABLE, 'rate_limited', 'The relay is rate limiting this device. Try again in a minute.')
}

function parseFrame(text: string) {
  try {
    return ServerFrame.safeParse(JSON.parse(text))
  } catch {
    return ServerFrame.safeParse(null)
  }
}

/** Checks a relay response, which is no more trusted than anything else on the wire. */
function checked<T>(schema: z.ZodType<T>, value: unknown, url: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw unavailable(url)
  return parsed.data
}

/** A short-lived authenticated connection. CLI commands open one, use it, and close it. */
export class RelayClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  private constructor(
    private readonly socket: WebSocket,
    private readonly url: string,
  ) {
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)))
    socket.addEventListener('close', () => this.failAll())
    socket.addEventListener('error', () => this.failAll())
  }

  private failAll(): void {
    for (const { reject } of this.pending.values()) reject(unavailable(this.url))
    this.pending.clear()
  }

  private onMessage(text: string): void {
    const frame = parseFrame(text)
    if (!frame.success || frame.data.kind === 'challenge') return
    const pending = this.pending.get(frame.data.reqId)
    if (!pending) return
    this.pending.delete(frame.data.reqId)
    if (frame.data.kind === 'ok') pending.resolve(frame.data.result)
    else if (frame.data.code === 'rate_limited') pending.reject(rateLimited())
    else pending.reject(new RelayRejection(frame.data.code))
  }

  static async connect(baseUrl: string, identity: Identity): Promise<RelayClient> {
    const url = `${baseUrl.replace(/\/$/, '')}/v1/ws/${identity.deviceId}`
    const { socket, challenge } = await new Promise<{ socket: WebSocket; challenge: string }>((resolve, reject) => {
      const socket = new WebSocket(url)
      const fail = () => {
        clearTimeout(timer)
        reject(unavailable(baseUrl))
      }
      const timer = setTimeout(() => {
        socket.close()
        fail()
      }, TIMEOUT_MS)
      socket.addEventListener('error', fail, { once: true })
      socket.addEventListener(
        'message',
        (event) => {
          clearTimeout(timer)
          socket.removeEventListener('error', fail)
          const frame = parseFrame(String(event.data))
          if (frame.success && frame.data.kind === 'challenge') {
            resolve({ socket, challenge: frame.data.nonce })
          } else fail()
        },
        { once: true },
      )
    })
    const client = new RelayClient(socket, baseUrl)
    try {
      await client.call({
        op: 'auth',
        deviceId: identity.deviceId,
        signPublicKey: identity.signPublicKey,
        signature: sign(relayAuthBytes(challenge, identity.deviceId), identity),
      })
    } catch (error) {
      client.close()
      throw error instanceof CliError ? error : unavailable(baseUrl)
    }
    return client
  }

  private call(frame: WithoutReqId<ClientFrame>): Promise<unknown> {
    const reqId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(unavailable(this.url))
      }, TIMEOUT_MS)
      this.pending.set(reqId, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      })
      this.socket.send(JSON.stringify({ ...frame, reqId }))
    })
  }

  async send(to: string, payload: string): Promise<void> {
    await this.call({ op: 'send', to, payload })
  }

  async fetch(): Promise<QueuedItem[]> {
    return checked(FetchResult, await this.call({ op: 'fetch' }), this.url).items
  }

  async ack(ids: string[]): Promise<void> {
    await this.call({ op: 'ack', ids })
  }

  async block(peer: string): Promise<void> {
    await this.call({ op: 'block', peer })
  }

  async unblock(peer: string): Promise<void> {
    await this.call({ op: 'unblock', peer })
  }

  async roomCreate(roomId: string, ttlMs: number): Promise<void> {
    await this.call({ op: 'room.create', roomId, ttlMs })
  }

  async roomJoin(roomId: string): Promise<void> {
    await this.call({ op: 'room.join', roomId })
  }

  async roomPost(roomId: string, payload: string): Promise<void> {
    await this.call({ op: 'room.post', roomId, payload })
  }

  async roomRead(roomId: string, after: number): Promise<RoomReadResult> {
    return checked(RoomReadResult, await this.call({ op: 'room.read', roomId, after }), this.url)
  }

  close(): void {
    this.socket.close()
  }
}
