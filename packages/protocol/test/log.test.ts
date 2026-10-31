import { describe, expect, it } from 'vitest'
import { GENESIS_HASH, nextLogEntry, verifyLog, type LogEntry, type LogHead } from '../src/index.js'

function buildLog(count: number): { lines: string[]; head: LogHead } {
  const entries: LogEntry[] = []
  for (let i = 0; i < count; i++) {
    entries.push(nextLogEntry(entries.at(-1) ?? null, { ts: 1000 + i, type: 'request.received', data: { n: i } }))
  }
  const last = entries.at(-1) as LogEntry
  return { lines: entries.map((entry) => JSON.stringify(entry)), head: { seq: last.seq, hash: last.hash } }
}

function edited(line: string, change: (entry: LogEntry) => LogEntry): string {
  return JSON.stringify(change(JSON.parse(line) as LogEntry))
}

describe('hash-chained log', () => {
  it('chains each entry to the one before it', () => {
    const { lines } = buildLog(3)
    const [first, second] = lines.map((line) => JSON.parse(line) as LogEntry) as [LogEntry, LogEntry]
    expect(first.prevHash).toBe(GENESIS_HASH)
    expect(second.prevHash).toBe(first.hash)
  })

  it('verifies an untouched log', () => {
    const { lines, head } = buildLog(5)
    expect(verifyLog(lines, head)).toEqual({ ok: true, entries: 5, head })
  })

  it('verifies an empty log', () => {
    expect(verifyLog([], null)).toEqual({ ok: true, entries: 0, head: null })
  })

  it('detects an edited entry', () => {
    const { lines, head } = buildLog(5)
    lines[2] = edited(lines[2] as string, (entry) => ({ ...entry, data: { n: 99 } }))
    expect(verifyLog(lines, head)).toMatchObject({ ok: false, line: 3, reason: 'entry hash mismatch' })
  })

  it('detects an edited entry with a recomputed hash', () => {
    const { lines, head } = buildLog(5)
    const previous = JSON.parse(lines[1] as string) as LogEntry
    lines[2] = JSON.stringify(nextLogEntry(previous, { ts: 1, type: 'request.approved', data: {} }))
    expect(verifyLog(lines, head)).toMatchObject({ ok: false, line: 4, reason: 'broken chain' })
  })

  it('detects a deleted entry', () => {
    const { lines, head } = buildLog(5)
    lines.splice(2, 1)
    expect(verifyLog(lines, head)).toMatchObject({ ok: false, line: 3 })
  })

  it('detects reordered entries', () => {
    const { lines, head } = buildLog(4)
    ;[lines[1], lines[2]] = [lines[2] as string, lines[1] as string]
    expect(verifyLog(lines, head).ok).toBe(false)
  })

  it('detects entries cut from the end', () => {
    const { lines, head } = buildLog(5)
    expect(verifyLog(lines.slice(0, 3), head)).toMatchObject({ ok: false, reason: 'log truncated: expected entry 4' })
    expect(verifyLog([], head).ok).toBe(false)
  })

  it('detects a removed head record', () => {
    const { lines } = buildLog(2)
    expect(verifyLog(lines, null)).toMatchObject({ ok: false, reason: 'head record is missing' })
  })

  it('detects a rewritten tail that does not match the head', () => {
    const { lines, head } = buildLog(3)
    const previous = JSON.parse(lines[1] as string) as LogEntry
    lines[2] = JSON.stringify(nextLogEntry(previous, { ts: 5, type: 'request.denied', data: {} }))
    expect(verifyLog(lines, head)).toMatchObject({ ok: false, reason: 'head hash mismatch' })
  })

  it('detects garbage lines', () => {
    const { lines, head } = buildLog(2)
    expect(verifyLog([...lines, 'not json'], head)).toMatchObject({ ok: false, line: 3, reason: 'unparseable entry' })
  })

  it('tolerates a crash between appending an entry and updating the head', () => {
    const { lines } = buildLog(3)
    const stale = JSON.parse(lines[1] as string) as LogEntry
    expect(verifyLog(lines, { seq: stale.seq, hash: stale.hash }).ok).toBe(true)
  })

  it('keeps multi-line helper text on a single JSONL line', () => {
    const entry = nextLogEntry(null, { ts: 1, type: 'request.received', data: { instruction: 'a\n{"forged":1}' } })
    expect(JSON.stringify(entry)).not.toContain('\n')
  })
})
