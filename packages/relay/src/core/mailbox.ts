import type { QueuedItem } from '@dafuga/trustline-protocol'
import { fail, ok, type KeyValueStore, type Result } from './kv.js'

export const MAILBOX_TTL_MS = 72 * 60 * 60 * 1000
export const MAX_QUEUE = 256
export const MAX_QUEUE_PER_SENDER = 64
export const FETCH_BATCH = 64

const QUEUE_PREFIX = 'q:'
const BLOCK_PREFIX = 'b:'
const COUNTER_KEY = 'counter'

/**
 * One device's offline queue of ciphertext. Items leave when acknowledged or
 * when their TTL passes, whichever comes first; nothing else is retained.
 */
export class MailboxLogic {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async live(): Promise<[string, QueuedItem][]> {
    const now = this.now()
    const items = await this.kv.list<QueuedItem>({ prefix: QUEUE_PREFIX })
    return [...items].filter(([, item]) => item.expiresAt > now)
  }

  async enqueue(from: string, payload: string): Promise<Result<{ id: string; expiresAt: number }>> {
    if (await this.kv.get(BLOCK_PREFIX + from)) return fail('blocked')
    const queued = await this.live()
    if (queued.length >= MAX_QUEUE) return fail('queue_full')
    if (queued.filter(([, item]) => item.from === from).length >= MAX_QUEUE_PER_SENDER) return fail('queue_full')
    const counter = ((await this.kv.get<number>(COUNTER_KEY)) ?? 0) + 1
    await this.kv.put(COUNTER_KEY, counter)
    const id = String(counter).padStart(16, '0')
    const queuedAt = this.now()
    const expiresAt = queuedAt + MAILBOX_TTL_MS
    await this.kv.put<QueuedItem>(QUEUE_PREFIX + id, { id, from, payload, queuedAt, expiresAt })
    return ok({ id, expiresAt })
  }

  async fetch(): Promise<QueuedItem[]> {
    return (await this.live()).slice(0, FETCH_BATCH).map(([, item]) => item)
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.kv.delete(ids.map((id) => QUEUE_PREFIX + id))
  }

  async block(peer: string): Promise<void> {
    await this.kv.put(BLOCK_PREFIX + peer, true)
    const fromPeer = (await this.live()).filter(([, item]) => item.from === peer)
    if (fromPeer.length > 0) await this.kv.delete(fromPeer.map(([key]) => key))
  }

  async unblock(peer: string): Promise<void> {
    await this.kv.delete(BLOCK_PREFIX + peer)
  }

  /** Deletes expired items and returns the next expiry, if any, for alarm scheduling. */
  async purge(): Promise<number | null> {
    const now = this.now()
    const items = await this.kv.list<QueuedItem>({ prefix: QUEUE_PREFIX })
    const expired = [...items].filter(([, item]) => item.expiresAt <= now).map(([key]) => key)
    for (let i = 0; i < expired.length; i += 128) await this.kv.delete(expired.slice(i, i + 128))
    const remaining = [...items.values()].filter((item) => item.expiresAt > now).map((item) => item.expiresAt)
    return remaining.length > 0 ? Math.min(...remaining) : null
  }
}
