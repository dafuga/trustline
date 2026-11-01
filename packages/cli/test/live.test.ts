import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/main.js'
import { ScriptedPrompt } from './harness.js'

/**
 * Opt-in smoke test against a deployed relay. Skipped unless
 * TRUSTLINE_LIVE_RELAY is set, e.g.
 * TRUSTLINE_LIVE_RELAY=wss://trustline-relay.danielfugere28.workers.dev npx vitest run test/live.test.ts
 */
const LIVE = process.env.TRUSTLINE_LIVE_RELAY

describe.skipIf(!LIVE)('live relay smoke test', () => {
  it('carries the full lifecycle and normal use stays under the rate limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trustline-live-'))
    const prompt = new ScriptedPrompt()
    const cli = async (home: string, ...args: string[]) => {
      let stdout = ''
      const code = await run(
        [...args, '--json'],
        { PATH: process.env.PATH, TRUSTLINE_HOME: join(root, home), TRUSTLINE_RELAY_URL: LIVE },
        { out: (text) => (stdout += text), err: () => undefined },
        { prompt },
      )
      return { code, json: JSON.parse(stdout) }
    }

    const { json: started } = await cli('person', 'pair', 'start', '--name', 'Mom')
    expect((await cli('helper', 'pair', 'join', started.code, '--name', 'Sam')).code).toBe(0)
    await cli('person', 'pair', 'status')
    const { json: stage } = await cli('helper', 'pair', 'status')
    await cli('person', 'pair', 'status')
    expect((await cli('person', 'pair', 'confirm', stage.safetyString)).code).toBe(0)
    expect((await cli('helper', 'pair', 'confirm', stage.safetyString)).code).toBe(0)
    expect((await cli('person', 'pair', 'status')).json.stage).toBe('completed')

    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const sent = await cli('helper', 'send', `Smoke request ${i}`)
      expect(sent.code).toBe(0)
      ids.push(sent.json.requestId)
    }
    const inbox = await cli('person', 'inbox')
    expect(inbox.json.requests.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(ids))
    expect((await cli('person', 'approve', ids[0]!)).code).toBe(0)
    expect((await cli('person', 'deny', ids[1]!)).code).toBe(0)
    const status = await cli('helper', 'status')
    const states = Object.fromEntries(status.json.sentRequests.map((r: { id: string; state: string }) => [r.id, r.state]))
    expect(states[ids[0]!]).toBe('approved')
    expect(states[ids[1]!]).toBe('denied')

    expect((await cli('person', 'revoke', 'Sam')).json.relayNotified).toBe(true)
    expect((await cli('helper', 'send', 'After revoke')).code).toBe(7)
    expect((await cli('person', 'log', 'verify')).code).toBe(0)
  }, 120_000)
})
