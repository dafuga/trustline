/** `burst` tokens to start with, refilled at `perSecond`. */
export interface Rate {
  burst: number
  perSecond: number
}

/** Plain data, so a connection's bucket can survive Durable Object hibernation. */
export interface Bucket {
  tokens: number
  at: number
}

export interface RelayLimits {
  connectionsPerIp: Rate
  connectionsPerDevice: Rate
  messagesPerConnection: Rate
  messagesPerDevice: Rate
  messagesPerIp: Rate
  /** Net refused frames before the relay hangs up. */
  maxStrikes: number
}

/** The CLI opens a connection per command and polls pairing once a second, so bursts are normal. */
export const DEFAULT_LIMITS: RelayLimits = {
  connectionsPerIp: { burst: 60, perSecond: 5 },
  connectionsPerDevice: { burst: 40, perSecond: 2 },
  messagesPerConnection: { burst: 120, perSecond: 30 },
  messagesPerDevice: { burst: 240, perSecond: 60 },
  messagesPerIp: { burst: 600, perSecond: 150 },
  maxStrikes: 20,
}

const MAX_TRACKED_KEYS = 10_000

function refilled(bucket: Bucket | undefined, rate: Rate, now: number): number {
  if (!bucket) return rate.burst
  const elapsed = Math.max(0, now - bucket.at) / 1000
  return Math.min(rate.burst, bucket.tokens + elapsed * rate.perSecond)
}

/** Spends one token. Returns the updated bucket, or null when it is empty. */
export function takeToken(bucket: Bucket | undefined, rate: Rate, now: number): Bucket | null {
  const tokens = refilled(bucket, rate, now)
  return tokens < 1 ? null : { tokens: tokens - 1, at: now }
}

/** In-memory buckets by key. Nothing here is persisted, and a restart simply forgives everyone. */
export class RateLimiter {
  private readonly buckets = new Map<string, { bucket: Bucket; rate: Rate }>()

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, rate: Rate): boolean {
    const now = this.now()
    const bucket = takeToken(this.buckets.get(key)?.bucket, rate, now)
    if (!bucket) return false
    this.buckets.delete(key)
    if (this.buckets.size >= MAX_TRACKED_KEYS) this.evict(now)
    this.buckets.set(key, { bucket, rate })
    return true
  }

  /** Full buckets carry no information. Failing that, the stalest entry goes. */
  private evict(now: number): void {
    for (const [key, { bucket, rate }] of this.buckets) {
      if (refilled(bucket, rate, now) >= rate.burst) this.buckets.delete(key)
    }
    if (this.buckets.size >= MAX_TRACKED_KEYS) {
      const [oldest] = this.buckets.keys()
      if (oldest !== undefined) this.buckets.delete(oldest)
    }
  }
}

/** The allowances a connection shares with others, as opposed to its own bucket. */
export interface RateGuard {
  /** Called per frame. `device` is set only once authenticated, so nobody can spend a victim's allowance. */
  message(ip: string, device: string | undefined): boolean | Promise<boolean>
  /** Called per successful auth, for the same reason: device ids are public, so upgrades can't be charged to them. */
  authenticated(device: string): boolean | Promise<boolean>
}

export function rateGuard(
  limiter: RateLimiter,
  ipAllows: (ip: string) => boolean | Promise<boolean>,
  limits: RelayLimits,
): RateGuard {
  return {
    message: async (ip, device) =>
      (device === undefined || limiter.take(`message:${device}`, limits.messagesPerDevice)) && (await ipAllows(ip)),
    authenticated: (device) => limiter.take(`connect:${device}`, limits.connectionsPerDevice),
  }
}

/** One IPv6 customer usually holds a whole /64, so per-address limits would be free to dodge. */
export function ipKey(ip: string): string {
  const address = ip.replace(/^::ffff:(?=\d+\.)/i, '')
  if (!address.includes(':')) return address
  const groups = (address.split('::')[0] as string).split(':')
  return `${[...groups, '0', '0', '0', '0'].slice(0, 4).join(':')}::/64`
}
