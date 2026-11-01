import type { RoomReadResult } from '@dafuga/trustline-protocol'
import { MAX_PAIRING_TTL_MS } from '@dafuga/trustline-protocol'
import { fail, ok, type KeyValueStore, type Result } from './kv.js'

const META_KEY = 'meta'
const POST_PREFIX = 'p:'
/** Keeps a spent room around after expiry, so an old code reads as expired rather than unknown. */
export const TOMBSTONE_MS = 60 * 60 * 1000
export const MAX_POSTS_PER_SIDE = 8

interface RoomMeta {
  owner: string
  joiner: string | null
  expiresAt: number
  posts: number
}

interface RoomPost {
  sender: string
  payload: string
}

/** A short-lived rendezvous for two devices. The first joiner takes the only slot. */
export class RoomLogic {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async meta(): Promise<RoomMeta | undefined> {
    return this.kv.get<RoomMeta>(META_KEY)
  }

  async create(owner: string, ttlMs: number): Promise<Result<{ expiresAt: number }>> {
    if (await this.meta()) return fail('room_exists')
    const expiresAt = this.now() + Math.min(ttlMs, MAX_PAIRING_TTL_MS)
    await this.kv.put<RoomMeta>(META_KEY, { owner, joiner: null, expiresAt, posts: 0 })
    return ok({ expiresAt })
  }

  async join(device: string): Promise<Result<{ expiresAt: number }>> {
    const meta = await this.meta()
    if (!meta) return fail('room_not_found')
    if (this.now() >= meta.expiresAt) return fail('room_expired')
    if (meta.joiner !== null || meta.owner === device) return fail('room_used')
    await this.kv.put<RoomMeta>(META_KEY, { ...meta, joiner: device })
    return ok({ expiresAt: meta.expiresAt })
  }

  private async member(device: string): Promise<Result<RoomMeta>> {
    const meta = await this.meta()
    if (!meta) return fail('room_not_found')
    if (this.now() >= meta.expiresAt) return fail('room_expired')
    if (device !== meta.owner && device !== meta.joiner) return fail('unauthorized')
    return ok(meta)
  }

  async post(device: string, payload: string): Promise<Result<null>> {
    const member = await this.member(device)
    if (!member.ok) return member
    const meta = member.value
    if (meta.posts >= MAX_POSTS_PER_SIDE * 2) return fail('room_full')
    const posts = await this.kv.list<RoomPost>({ prefix: POST_PREFIX })
    const mine = [...posts.values()].filter((post) => post.sender === device).length
    if (mine >= MAX_POSTS_PER_SIDE) return fail('room_full')
    const index = meta.posts
    await this.kv.put<RoomPost>(POST_PREFIX + String(index).padStart(4, '0'), { sender: device, payload })
    await this.kv.put<RoomMeta>(META_KEY, { ...meta, posts: index + 1 })
    return ok(null)
  }

  /** Returns the other side's posts past `after`; `cursor` is what to pass next time. */
  async read(device: string, after: number): Promise<Result<RoomReadResult>> {
    const member = await this.member(device)
    if (!member.ok) return member
    const posts = [...(await this.kv.list<RoomPost>({ prefix: POST_PREFIX })).values()]
    return ok({
      posts: posts
        .slice(after)
        .filter((post) => post.sender !== device)
        .map((post) => post.payload),
      cursor: posts.length,
    })
  }

  /** Drops ciphertext at expiry and the tombstone later. Returns the next wake-up time. */
  async purge(): Promise<number | null> {
    const meta = await this.meta()
    if (!meta) return null
    const now = this.now()
    if (now < meta.expiresAt) return meta.expiresAt
    const keys = [...(await this.kv.list({ prefix: POST_PREFIX })).keys()]
    if (keys.length > 0) await this.kv.delete(keys)
    if (now < meta.expiresAt + TOMBSTONE_MS) return meta.expiresAt + TOMBSTONE_MS
    await this.kv.delete(META_KEY)
    return null
  }
}
