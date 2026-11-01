import { z } from 'zod'
import { hashHex } from './crypto.js'
import { canonicalJson, utf8 } from './encoding.js'
import { Hash } from './messages.js'

export const GENESIS_HASH = '0'.repeat(64)

export const LogEntry = z.strictObject({
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  prevHash: Hash,
  hash: Hash,
})
export type LogEntry = z.infer<typeof LogEntry>

export const LogHead = z.strictObject({ seq: z.number().int().nonnegative(), hash: Hash })
export type LogHead = z.infer<typeof LogHead>

function entryHash(entry: Omit<LogEntry, 'hash'>): string {
  return hashHex(utf8(canonicalJson(entry)))
}

export function nextLogEntry(
  previous: LogHead | null,
  event: { ts: number; type: string; data: Record<string, unknown> },
): LogEntry {
  const body = {
    seq: previous ? previous.seq + 1 : 0,
    ts: event.ts,
    type: event.type,
    data: event.data,
    prevHash: previous ? previous.hash : GENESIS_HASH,
  }
  return { ...body, hash: entryHash(body) }
}

export type LogVerification =
  | { ok: true; entries: number; head: LogHead | null }
  | { ok: false; entries: number; line: number; reason: string }

/**
 * Walks the chain. `head` is the separately stored last-known tip; without it,
 * cutting entries off the end of the file would leave a valid-looking chain.
 */
export function verifyLog(lines: readonly string[], head: LogHead | null): LogVerification {
  let previous: LogHead | null = null
  let count = 0
  const fail = (line: number, reason: string): LogVerification => ({ ok: false, entries: count, line, reason })
  if (!head && lines.length > 0) return fail(1, 'head record is missing')

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    let entry: LogEntry
    try {
      entry = LogEntry.parse(JSON.parse(line))
    } catch {
      return fail(lineNumber, 'unparseable entry')
    }
    if (entry.seq !== index) return fail(lineNumber, `expected seq ${index}, found ${entry.seq}`)
    if (entry.prevHash !== (previous?.hash ?? GENESIS_HASH)) return fail(lineNumber, 'broken chain')
    const { hash, ...body } = entry
    if (entryHash(body) !== hash) return fail(lineNumber, 'entry hash mismatch')
    if (head && entry.seq === head.seq && hash !== head.hash) return fail(lineNumber, 'head hash mismatch')
    previous = { seq: entry.seq, hash }
    count++
  }

  // A log longer than the head is a crash between the two writes, not tampering.
  if (head && (previous === null || previous.seq < head.seq)) {
    return fail(lines.length + 1, `log truncated: expected entry ${head.seq}`)
  }
  return { ok: true, entries: count, head: previous }
}
