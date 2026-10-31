import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  Category,
  Identity,
  LogHead,
  PairingState,
  generateIdentity,
  nextLogEntry,
  verifyLog,
  type LogEntry,
  type LogVerification,
} from '@dafuga/trustline-protocol'
import { z } from 'zod'
import { CliError, ExitCode } from './errors.js'

export const Peer = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** What the other device is to us: `helper` sends us requests, `person` receives ours. */
  role: z.enum(['helper', 'person']),
  signPublicKey: z.string(),
  boxPublicKey: z.string(),
  pairedAt: z.number(),
  status: z.enum(['active', 'revoked']),
  revokedAt: z.number().optional(),
  grants: z.array(Category),
  sendSeq: z.number().int().nonnegative(),
  recvSeq: z.number().int().nonnegative(),
})
export type Peer = z.infer<typeof Peer>

export const InboxItem = z.strictObject({
  id: z.string(),
  helperId: z.string(),
  helperName: z.string(),
  category: Category,
  categories: z.array(Category),
  alwaysAsk: z.boolean(),
  instruction: z.string(),
  receivedAt: z.number(),
  expiresAt: z.number(),
  state: z.enum(['pending', 'approved', 'denied', 'expired', 'revoked']),
  decidedBy: z.enum(['person', 'grant']).optional(),
  decidedAt: z.number().optional(),
})
export type InboxItem = z.infer<typeof InboxItem>

export const SentItem = z.strictObject({
  id: z.string(),
  personId: z.string(),
  category: Category,
  instruction: z.string(),
  sentAt: z.number(),
  expiresAt: z.number(),
  state: z.enum(['sent', 'approved', 'denied']),
  decidedAt: z.number().optional(),
})
export type SentItem = z.infer<typeof SentItem>

/** Work owed to the relay, retried on every connection so local actions never wait on it. */
export const OutboxItem = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('send'), to: z.string(), payload: z.string() }),
  z.strictObject({ kind: z.literal('block'), peer: z.string() }),
  z.strictObject({ kind: z.literal('unblock'), peer: z.string() }),
])
export type OutboxItem = z.infer<typeof OutboxItem>

export const PairingFile = z.strictObject({
  state: PairingState,
  cursor: z.number(),
  /** The person's own label for this helper, which beats the name the helper chose. */
  peerLabel: z.string().optional(),
})
export type PairingFile = z.infer<typeof PairingFile>

const Config = z.strictObject({ relayUrl: z.string().optional(), name: z.string().optional() })
export type Config = z.infer<typeof Config>

const LOCK_STALE_MS = 60_000
const LOCK_TIMEOUT_MS = 15_000

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** All on-disk state for one identity, rooted at TRUSTLINE_HOME. */
export class Home {
  private constructor(readonly dir: string) {}

  static async open(env: NodeJS.ProcessEnv): Promise<Home> {
    const dir = env.TRUSTLINE_HOME || join(homedir(), '.trustline')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return new Home(dir)
  }

  private path(name: string): string {
    return join(this.dir, name)
  }

  private async readJson<T>(name: string, schema: z.ZodType<T>): Promise<T | null> {
    let text: string
    try {
      text = await readFile(this.path(name), 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    try {
      return schema.parse(JSON.parse(text))
    } catch {
      throw new CliError(ExitCode.ERROR, 'corrupt_state', `${this.path(name)} is corrupt`)
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    const temp = this.path(`${name}.${nodeRandomBytes(4).toString('hex')}.tmp`)
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temp, this.path(name))
  }

  /** Serializes state changes across concurrent CLI processes on this identity. */
  async locked<T>(run: () => Promise<T>): Promise<T> {
    const lock = this.path('lock')
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        await (await open(lock, 'wx', 0o600)).close()
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const age = await stat(lock).then(
          (info) => Date.now() - info.mtimeMs,
          () => 0,
        )
        if (age > LOCK_STALE_MS) await rm(lock, { force: true })
        else if (Date.now() > deadline) {
          throw new CliError(ExitCode.ERROR, 'state_locked', 'Another trustline command is still running')
        } else await sleep(25)
      }
    }
    try {
      return await run()
    } finally {
      await rm(lock, { force: true })
    }
  }

  async identity(): Promise<Identity> {
    const existing = await this.readJson('identity.json', Identity)
    if (existing) return existing
    const created = generateIdentity()
    await this.writeJson('identity.json', created)
    return created
  }

  async config(): Promise<Config> {
    return (await this.readJson('config.json', Config)) ?? {}
  }

  async saveConfig(config: Config): Promise<void> {
    await this.writeJson('config.json', config)
  }

  async peers(): Promise<Peer[]> {
    return (await this.readJson('peers.json', z.array(Peer))) ?? []
  }

  async savePeers(peers: Peer[]): Promise<void> {
    await this.writeJson('peers.json', peers)
  }

  async inbox(): Promise<InboxItem[]> {
    return (await this.readJson('inbox.json', z.array(InboxItem))) ?? []
  }

  async saveInbox(items: InboxItem[]): Promise<void> {
    await this.writeJson('inbox.json', items)
  }

  async sent(): Promise<SentItem[]> {
    return (await this.readJson('sent.json', z.array(SentItem))) ?? []
  }

  async saveSent(items: SentItem[]): Promise<void> {
    await this.writeJson('sent.json', items)
  }

  async outbox(): Promise<OutboxItem[]> {
    return (await this.readJson('outbox.json', z.array(OutboxItem))) ?? []
  }

  async saveOutbox(items: OutboxItem[]): Promise<void> {
    await this.writeJson('outbox.json', items)
  }

  async pairing(): Promise<PairingFile | null> {
    return this.readJson('pairing.json', PairingFile)
  }

  async savePairing(file: PairingFile): Promise<void> {
    await this.writeJson('pairing.json', file)
  }

  async clearPairing(): Promise<void> {
    await rm(this.path('pairing.json'), { force: true })
  }

  private async logLines(): Promise<string[]> {
    try {
      const text = await readFile(this.path('log.jsonl'), 'utf8')
      return text.split('\n').filter((line) => line.length > 0)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  /** Reads the stored tip. Unreadable means tampered, so callers treat it as a failed check. */
  private async logHead(): Promise<LogHead | null> {
    return this.readJson('log.head.json', LogHead).catch(() => {
      throw new CliError(ExitCode.LOG_TAMPERED, 'log_tampered', 'The log head is unreadable')
    })
  }

  /** The only write path to the log. It is local: no inbound message reaches it directly. */
  async appendLog(ts: number, type: string, data: Record<string, unknown>): Promise<LogEntry> {
    const lines = await this.logLines()
    const entry = nextLogEntry(tipOf(lines) ?? (await this.logHead()), { ts, type, data })
    await appendFile(this.path('log.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    await this.writeJson('log.head.json', { seq: entry.seq, hash: entry.hash })
    return entry
  }

  async readLog(): Promise<LogEntry[]> {
    return (await this.logLines()).flatMap((line) => {
      try {
        return [JSON.parse(line) as LogEntry]
      } catch {
        return []
      }
    })
  }

  async verifyLog(): Promise<LogVerification> {
    return verifyLog(await this.logLines(), await this.logHead())
  }
}

function tipOf(lines: string[]): LogHead | null {
  const last = lines.at(-1)
  if (!last) return null
  try {
    const { seq, hash } = JSON.parse(last) as LogEntry
    return LogHead.parse({ seq, hash })
  } catch {
    return null
  }
}
