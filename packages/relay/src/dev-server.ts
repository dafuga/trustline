import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MAX_FRAME_BYTES } from '@dafuga/trustline-protocol'
import { WebSocketServer } from 'ws'
import type { KeyValueStore } from './core/kv.js'
import { MailboxLogic } from './core/mailbox.js'
import { RoomLogic } from './core/room.js'
import { handleFrame, newConnection, type RelayBackend } from './core/session.js'

class MemoryKv implements KeyValueStore {
  private readonly data = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value)
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of [keys].flat()) this.data.delete(key)
  }

  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort()
    return new Map(keys.map((key) => [key, this.data.get(key) as T]))
  }
}

/** Runs each object's calls one at a time, which a Durable Object's input gate does for us. */
class Serialized<T> {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(readonly logic: T) {}

  run<R>(call: (logic: T) => Promise<R>): Promise<R> {
    const result = this.tail.then(() => call(this.logic))
    this.tail = result.catch(() => undefined)
    return result
  }
}

function memoryBackend(now: () => number) {
  const mailboxes = new Map<string, Serialized<MailboxLogic>>()
  const rooms = new Map<string, Serialized<RoomLogic>>()

  const mailbox = (device: string) => {
    let entry = mailboxes.get(device)
    if (!entry) mailboxes.set(device, (entry = new Serialized(new MailboxLogic(new MemoryKv(), now))))
    return entry
  }
  const room = (roomId: string) => {
    let entry = rooms.get(roomId)
    if (!entry) rooms.set(roomId, (entry = new Serialized(new RoomLogic(new MemoryKv(), now))))
    return entry
  }

  const backend: RelayBackend = {
    enqueue: (to, from, payload) => mailbox(to).run((m) => m.enqueue(from, payload)),
    fetch: (device) => mailbox(device).run((m) => m.fetch()),
    ack: (device, ids) => mailbox(device).run((m) => m.ack(ids)),
    block: (device, peer) => mailbox(device).run((m) => m.block(peer)),
    unblock: (device, peer) => mailbox(device).run((m) => m.unblock(peer)),
    roomCreate: (id, device, ttlMs) => room(id).run((r) => r.create(device, ttlMs)),
    roomJoin: (id, device) => room(id).run((r) => r.join(device)),
    roomPost: (id, device, payload) => room(id).run((r) => r.post(device, payload)),
    roomRead: (id, device, after) => room(id).run((r) => r.read(device, after)),
  }
  const purge = async () => {
    await Promise.all([...mailboxes.values()].map((m) => m.run((logic) => logic.purge())))
    await Promise.all([...rooms.values()].map((r) => r.run((logic) => logic.purge())))
  }
  return { backend, purge }
}

export interface DevRelay {
  url: string
  port: number
  close(): Promise<void>
}

export interface DevRelayOptions {
  port?: number
  host?: string
  now?: () => number
}

/** The local relay: same frames and same logic as the Worker, kept in memory. */
export async function startDevRelay(options: DevRelayOptions = {}): Promise<DevRelay> {
  const { port = 8787, host = '127.0.0.1', now = Date.now } = options
  const { backend, purge } = memoryBackend(now)

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('trustline dev relay\n')
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  server.on('upgrade', (request, socket, head) => {
    const match = /^\/v1\/ws\/([0-9a-f]{32})$/.exec(request.url ?? '')
    if (!match) return void socket.destroy()
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const connection = newConnection(match[1])
      let state = connection.state
      let queue: Promise<void> = Promise.resolve()
      ws.send(connection.greeting)
      ws.on('message', (data) => {
        queue = queue.then(async () => {
          const result = await handleFrame(state, data.toString(), backend)
          state = result.state
          ws.send(result.reply)
        })
      })
    })
  })

  const sweep = setInterval(() => void purge(), 30_000)
  sweep.unref()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const bound = (server.address() as AddressInfo).port

  return {
    url: `ws://${host}:${bound}`,
    port: bound,
    close: async () => {
      clearInterval(sweep)
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
