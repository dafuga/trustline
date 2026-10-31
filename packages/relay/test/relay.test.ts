import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  generateIdentity,
  relayAuthBytes,
  sign,
  ServerFrame,
  type Identity,
} from '@dafuga/trustline-protocol'
import WebSocket from 'ws'
import {
  MAILBOX_TTL_MS,
  MAX_POSTS_PER_SIDE,
  MAX_QUEUE,
  MAX_QUEUE_PER_SENDER,
  MailboxLogic,
  RoomLogic,
  TOMBSTONE_MS,
  startDevRelay,
  type DevRelay,
  type KeyValueStore,
} from '../src/index.js'

class TestKv implements KeyValueStore {
  readonly data = new Map<string, unknown>()
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, value)
  }
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.data.delete(key)
  }
  async list<T>({ prefix }: { prefix: string }) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort()
    return new Map(keys.map((key) => [key, this.data.get(key) as T]))
  }
}

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)
const ROOM = 'f'.repeat(64)

describe('MailboxLogic', () => {
  let now = 1000
  let kv: TestKv
  let mailbox: MailboxLogic

  beforeEach(() => {
    now = 1000
    kv = new TestKv()
    mailbox = new MailboxLogic(kv, () => now)
  })

  it('queues in order until acknowledged', async () => {
    await mailbox.enqueue(A, 'one')
    await mailbox.enqueue(A, 'two')
    const items = await mailbox.fetch()
    expect(items.map((item) => item.payload)).toEqual(['one', 'two'])
    expect((await mailbox.fetch()).length).toBe(2)
    await mailbox.ack([items[0]?.id as string])
    expect((await mailbox.fetch()).map((item) => item.payload)).toEqual(['two'])
  })

  it('hides and then purges items past their TTL', async () => {
    await mailbox.enqueue(A, 'old')
    now += MAILBOX_TTL_MS
    expect(await mailbox.fetch()).toEqual([])
    expect(await mailbox.purge()).toBeNull()
    expect([...kv.data.keys()].filter((key) => key.startsWith('q:'))).toEqual([])
  })

  it('keeps no ciphertext after acknowledgement', async () => {
    await mailbox.enqueue(A, 'secret-ciphertext')
    const items = await mailbox.fetch()
    await mailbox.ack(items.map((item) => item.id))
    expect(JSON.stringify([...kv.data.entries()])).not.toContain('secret-ciphertext')
  })

  it('reports the next expiry for alarms', async () => {
    await mailbox.enqueue(A, 'one')
    expect(await mailbox.purge()).toBe(now + MAILBOX_TTL_MS)
  })

  it('refuses blocked senders and drops what they had queued', async () => {
    await mailbox.enqueue(A, 'queued')
    await mailbox.enqueue(B, 'kept')
    await mailbox.block(A)
    expect(await mailbox.enqueue(A, 'more')).toEqual({ ok: false, code: 'blocked' })
    expect((await mailbox.fetch()).map((item) => item.payload)).toEqual(['kept'])
    await mailbox.unblock(A)
    expect((await mailbox.enqueue(A, 'back')).ok).toBe(true)
  })

  it('caps one sender below the whole queue', async () => {
    for (let i = 0; i < MAX_QUEUE_PER_SENDER; i++) await mailbox.enqueue(A, 'x')
    expect(await mailbox.enqueue(A, 'x')).toEqual({ ok: false, code: 'queue_full' })
    expect((await mailbox.enqueue(B, 'x')).ok).toBe(true)
  })

  it('caps the whole queue', async () => {
    for (let i = 0; i < MAX_QUEUE; i++) {
      await mailbox.enqueue(i.toString(16).padStart(32, '0'), 'x')
    }
    expect(await mailbox.enqueue(A, 'x')).toEqual({ ok: false, code: 'queue_full' })
  })
})

describe('RoomLogic', () => {
  let now = 1000
  let kv: TestKv
  let room: RoomLogic

  beforeEach(() => {
    now = 1000
    kv = new TestKv()
    room = new RoomLogic(kv, () => now)
  })

  it('passes posts between the two members only', async () => {
    await room.create(A, 60_000)
    await room.join(B)
    await room.post(B, 'from-b')
    await room.post(A, 'from-a')
    expect(await room.read(A, 0)).toEqual({ ok: true, value: { posts: ['from-b'], cursor: 2 } })
    expect(await room.read(B, 0)).toEqual({ ok: true, value: { posts: ['from-a'], cursor: 2 } })
    expect(await room.read(A, 2)).toEqual({ ok: true, value: { posts: [], cursor: 2 } })
    expect(await room.read(C, 0)).toEqual({ ok: false, code: 'unauthorized' })
    expect(await room.post(C, 'x')).toEqual({ ok: false, code: 'unauthorized' })
  })

  it('is single-use', async () => {
    await room.create(A, 60_000)
    expect((await room.join(B)).ok).toBe(true)
    expect(await room.join(C)).toEqual({ ok: false, code: 'room_used' })
    expect(await room.join(B)).toEqual({ ok: false, code: 'room_used' })
    expect(await room.create(C, 60_000)).toEqual({ ok: false, code: 'room_exists' })
  })

  it("won't let the owner fill its own slot", async () => {
    await room.create(A, 60_000)
    expect(await room.join(A)).toEqual({ ok: false, code: 'room_used' })
  })

  it('reports unknown and expired rooms distinctly', async () => {
    expect(await room.join(B)).toEqual({ ok: false, code: 'room_not_found' })
    await room.create(A, 60_000)
    now += 60_000
    expect(await room.join(B)).toEqual({ ok: false, code: 'room_expired' })
    expect(await room.read(A, 0)).toEqual({ ok: false, code: 'room_expired' })
  })

  it('caps the ttl at the protocol maximum', async () => {
    const result = await room.create(A, 24 * 60 * 60 * 1000)
    expect(result).toEqual({ ok: true, value: { expiresAt: now + 15 * 60 * 1000 } })
  })

  it('drops ciphertext at expiry and the tombstone an hour later', async () => {
    await room.create(A, 60_000)
    await room.join(B)
    await room.post(B, 'ciphertext')
    now += 60_000
    expect(await room.purge()).toBe(now + TOMBSTONE_MS)
    expect(JSON.stringify([...kv.data.entries()])).not.toContain('ciphertext')
    expect(await room.join(C)).toEqual({ ok: false, code: 'room_expired' })
    now += TOMBSTONE_MS
    expect(await room.purge()).toBeNull()
    expect(kv.data.size).toBe(0)
  })

  it('limits posts per side', async () => {
    await room.create(A, 60_000)
    await room.join(B)
    for (let i = 0; i < MAX_POSTS_PER_SIDE; i++) await room.post(B, 'x')
    expect(await room.post(B, 'x')).toEqual({ ok: false, code: 'room_full' })
    expect((await room.post(A, 'x')).ok).toBe(true)
  })
})

interface Socket {
  ws: WebSocket
  next(): Promise<ServerFrame>
  call(frame: Record<string, unknown>): Promise<ServerFrame>
}

async function open(relay: DevRelay, path: string): Promise<Socket> {
  const ws = new WebSocket(`${relay.url}${path}`)
  const frames: ServerFrame[] = []
  const waiters: ((frame: ServerFrame) => void)[] = []
  ws.on('message', (data) => {
    const frame = ServerFrame.parse(JSON.parse(data.toString()))
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else frames.push(frame)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const next = () =>
    new Promise<ServerFrame>((resolve) => {
      const frame = frames.shift()
      if (frame) resolve(frame)
      else waiters.push(resolve)
    })
  return {
    ws,
    next,
    call: (frame) => {
      ws.send(JSON.stringify(frame))
      return next()
    },
  }
}

async function authed(relay: DevRelay, identity: Identity): Promise<Socket> {
  const socket = await open(relay, `/v1/ws/${identity.deviceId}`)
  const challenge = await socket.next()
  if (challenge.kind !== 'challenge') throw new Error('expected challenge')
  const reply = await socket.call({
    op: 'auth',
    reqId: 1,
    deviceId: identity.deviceId,
    signPublicKey: identity.signPublicKey,
    signature: sign(relayAuthBytes(challenge.nonce, identity.deviceId), identity),
  })
  expect(reply.kind).toBe('ok')
  return socket
}

describe('dev relay over WebSockets', () => {
  let relay: DevRelay
  const alice = generateIdentity()
  const bob = generateIdentity()

  beforeEach(async () => {
    relay = await startDevRelay({ port: 0 })
  })

  afterEach(async () => {
    await relay.close()
  })

  it('refuses every operation before authentication', async () => {
    const socket = await open(relay, `/v1/ws/${alice.deviceId}`)
    await socket.next()
    expect(await socket.call({ op: 'fetch', reqId: 2 })).toMatchObject({ kind: 'error', code: 'unauthorized' })
    socket.ws.close()
  })

  it("won't let one device authenticate as another", async () => {
    const socket = await open(relay, `/v1/ws/${alice.deviceId}`)
    const challenge = await socket.next()
    if (challenge.kind !== 'challenge') throw new Error('expected challenge')
    const claimed = {
      op: 'auth',
      reqId: 1,
      deviceId: alice.deviceId,
      signPublicKey: bob.signPublicKey,
      signature: sign(relayAuthBytes(challenge.nonce, alice.deviceId), bob),
    }
    expect(await socket.call(claimed)).toMatchObject({ kind: 'error', code: 'unauthorized' })
    const wrongKey = { ...claimed, signPublicKey: alice.signPublicKey }
    expect(await socket.call(wrongKey)).toMatchObject({ kind: 'error', code: 'unauthorized' })
    socket.ws.close()
  })

  it('rejects a signature over a different challenge', async () => {
    const socket = await open(relay, `/v1/ws/${alice.deviceId}`)
    await socket.next()
    const reply = await socket.call({
      op: 'auth',
      reqId: 1,
      deviceId: alice.deviceId,
      signPublicKey: alice.signPublicKey,
      signature: sign(relayAuthBytes('stale-challenge', alice.deviceId), alice),
    })
    expect(reply).toMatchObject({ kind: 'error', code: 'unauthorized' })
    socket.ws.close()
  })

  it('stamps the authenticated sender on queued items', async () => {
    const a = await authed(relay, alice)
    const b = await authed(relay, bob)
    await a.call({ op: 'send', reqId: 2, to: bob.deviceId, payload: 'ciphertext' })
    const fetched = await b.call({ op: 'fetch', reqId: 2 })
    expect(fetched).toMatchObject({ kind: 'ok', result: { items: [{ from: alice.deviceId, payload: 'ciphertext' }] } })
    a.ws.close()
    b.ws.close()
  })

  it('refuses malformed frames without dropping the connection', async () => {
    const a = await authed(relay, alice)
    a.ws.send('not json')
    expect(await a.next()).toMatchObject({ kind: 'error', code: 'bad_frame' })
    expect(await a.call({ op: 'fetch', reqId: 3 })).toMatchObject({ kind: 'ok' })
    a.ws.close()
  })

  it('tells a blocked sender so', async () => {
    const a = await authed(relay, alice)
    const b = await authed(relay, bob)
    await b.call({ op: 'block', reqId: 2, peer: alice.deviceId })
    const sent = await a.call({ op: 'send', reqId: 2, to: bob.deviceId, payload: 'x' })
    expect(sent).toMatchObject({ kind: 'error', code: 'blocked' })
    a.ws.close()
    b.ws.close()
  })

  it('gives concurrent joiners exactly one slot', async () => {
    const owner = await authed(relay, alice)
    await owner.call({ op: 'room.create', reqId: 2, roomId: ROOM, ttlMs: 60_000 })
    const joiners = await Promise.all(Array.from({ length: 5 }, () => authed(relay, generateIdentity())))
    const replies = await Promise.all(joiners.map((socket) => socket.call({ op: 'room.join', reqId: 2, roomId: ROOM })))
    expect(replies.filter((reply) => reply.kind === 'ok').length).toBe(1)
    expect(replies.filter((reply) => reply.kind === 'error' && reply.code === 'room_used').length).toBe(4)
    for (const socket of [owner, ...joiners]) socket.ws.close()
  })

  it('refuses connections to other paths', async () => {
    await expect(open(relay, '/somewhere/else')).rejects.toThrow()
  })
})
