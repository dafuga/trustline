import { DurableObject } from 'cloudflare:workers'
import type { QueuedItem } from '@dafuga/trustline-protocol'
import { MailboxLogic } from './core/mailbox.js'
import { RoomLogic } from './core/room.js'
import { handleFrame, newConnection, type ConnectionState, type RelayBackend } from './core/session.js'
import type { KeyValueStore } from './core/kv.js'

export interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>
  ROOM: DurableObjectNamespace<PairingRoom>
}

function storageKv(storage: DurableObjectStorage): KeyValueStore {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    delete: (keys) => (typeof keys === 'string' ? storage.delete(keys) : storage.delete(keys)),
    list: (options) => storage.list(options),
  }
}

function backendFor(env: Env): RelayBackend {
  const mailbox = (device: string) => env.MAILBOX.get(env.MAILBOX.idFromName(device))
  const room = (roomId: string) => env.ROOM.get(env.ROOM.idFromName(roomId))
  return {
    enqueue: (to, from, payload) => mailbox(to).enqueue(from, payload),
    fetch: (device) => mailbox(device).fetch_() as Promise<QueuedItem[]>,
    ack: (device, ids) => mailbox(device).ack(ids),
    block: (device, peer) => mailbox(device).block(peer),
    unblock: (device, peer) => mailbox(device).unblock(peer),
    roomCreate: (id, device, ttlMs) => room(id).create(device, ttlMs),
    roomJoin: (id, device) => room(id).join(device),
    roomPost: (id, device, payload) => room(id).post(device, payload),
    roomRead: (id, device, after) => room(id).read(device, after),
  }
}

/** One per device: holds its WebSocket and its transient ciphertext queue. */
export class Mailbox extends DurableObject<Env> {
  private readonly logic = new MailboxLogic(storageKv(this.ctx.storage))

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
    const expected = new URL(request.url).pathname.split('/').pop()
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    const { state, greeting } = newConnection(expected)
    server.serializeAttachment(state)
    server.send(greeting)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const state = ws.deserializeAttachment() as ConnectionState
    const result = await handleFrame(state, raw, backendFor(this.env))
    ws.serializeAttachment(result.state)
    ws.send(result.reply)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close()
  }

  async enqueue(from: string, payload: string) {
    const result = await this.logic.enqueue(from, payload)
    if (result.ok && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(result.value.expiresAt)
    }
    return result
  }

  // Named with a trailing underscore: `fetch` is the Durable Object's HTTP entry point.
  async fetch_(): Promise<QueuedItem[]> {
    return this.logic.fetch()
  }

  async ack(ids: string[]): Promise<void> {
    await this.logic.ack(ids)
  }

  async block(peer: string): Promise<void> {
    await this.logic.block(peer)
  }

  async unblock(peer: string): Promise<void> {
    await this.logic.unblock(peer)
  }

  override async alarm(): Promise<void> {
    const next = await this.logic.purge()
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }
}

/** One per pairing code hash: a short-lived rendezvous that removes itself. */
export class PairingRoom extends DurableObject<Env> {
  private readonly logic = new RoomLogic(storageKv(this.ctx.storage))

  async create(device: string, ttlMs: number) {
    const result = await this.logic.create(device, ttlMs)
    if (result.ok) await this.ctx.storage.setAlarm(result.value.expiresAt)
    return result
  }

  join(device: string) {
    return this.logic.join(device)
  }

  post(device: string, payload: string) {
    return this.logic.post(device, payload)
  }

  read(device: string, after: number) {
    return this.logic.read(device, after)
  }

  override async alarm(): Promise<void> {
    const next = await this.logic.purge()
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    const match = /^\/v1\/ws\/([0-9a-f]{32})$/.exec(pathname)
    if (match?.[1]) return env.MAILBOX.get(env.MAILBOX.idFromName(match[1])).fetch(request)
    if (pathname === '/health') return new Response('ok')
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
