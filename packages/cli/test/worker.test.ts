import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_FRAME_BYTES } from '@dafuga/trustline-protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/main.js'
import { ScriptedPrompt } from './harness.js'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../relay')

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/**
 * Proves the Worker speaks the same protocol as the dev relay by running the
 * CLI against it. `wrangler dev --local` is workerd on this machine: it needs
 * no account and touches nothing on Cloudflare.
 */
describe('Cloudflare Worker in local workerd', () => {
  let wrangler: ChildProcess
  let port: number
  let root: string

  const cli = async (home: string, ...args: string[]) => {
    let stdout = ''
    const env = { TRUSTLINE_HOME: join(root, home), TRUSTLINE_RELAY_URL: `ws://127.0.0.1:${port}` }
    const code = await run(
      [...args, '--json'],
      env,
      { out: (text) => (stdout += text), err: () => undefined },
      { prompt: new ScriptedPrompt() },
    )
    return { code, json: JSON.parse(stdout) }
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'trustline-worker-'))
    port = await freePort()
    wrangler = spawn(
      'npx',
      ['wrangler', 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(await freePort())],
      {
        cwd: RELAY_DIR,
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
        stdio: 'ignore',
        detached: true,
      },
    )
    const deadline = Date.now() + 45_000
    for (;;) {
      const healthy = await fetch(`http://127.0.0.1:${port}/health`).then(
        (response) => response.ok,
        () => false,
      )
      if (healthy) return
      if (Date.now() > deadline) throw new Error('wrangler dev did not start')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }, 60_000)

  afterAll(async () => {
    // Negative pid: wrangler runs workerd as a child, so stop the whole group.
    if (wrangler?.pid) process.kill(-wrangler.pid, 'SIGTERM')
    await rm(root, { recursive: true, force: true })
  })

  it('carries the full lifecycle', async () => {
    const { json: started } = await cli('person', 'pair', 'start', '--name', 'Mom')
    expect(await cli('scammer', 'pair', 'join', 'ABCD-EFGH-JKMN')).toMatchObject({ code: 5 })
    await cli('helper', 'pair', 'join', started.code, '--name', 'Sam')
    expect(await cli('scammer', 'pair', 'join', started.code)).toMatchObject({ code: 5, json: { error: { code: 'code_used' } } })
    await cli('person', 'pair', 'status')
    const { json: stage } = await cli('helper', 'pair', 'status')
    await cli('person', 'pair', 'status')
    await cli('person', 'pair', 'confirm', stage.safetyString)
    await cli('helper', 'pair', 'confirm', stage.safetyString)
    expect((await cli('person', 'pair', 'status')).json.stage).toBe('completed')

    const { json: sent } = await cli('helper', 'send', 'Open the photo album')
    expect((await cli('person', 'inbox')).json.requests[0].id).toBe(sent.requestId)
    expect((await cli('person', 'approve', sent.requestId)).code).toBe(0)
    expect((await cli('helper', 'status')).json.sentRequests[0].state).toBe('approved')

    expect((await cli('person', 'revoke', 'Sam')).json.relayNotified).toBe(true)
    expect((await cli('helper', 'send', 'Again')).code).toBe(7)
    expect((await cli('person', 'log', 'verify')).code).toBe(0)
  }, 30_000)
  it('hangs up on a message flood', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/${'a'.repeat(32)}`)
    const codes: string[] = []
    socket.addEventListener('message', (event) => {
      const { code } = JSON.parse(String(event.data)) as { code?: string }
      if (code) codes.push(code)
    })
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)))
    for (let reqId = 1; reqId <= 400; reqId++) socket.send(JSON.stringify({ op: 'fetch', reqId }))
    expect(await closed).toBe(1008)
    expect(codes).toContain('unauthorized')
    expect(codes).toContain('rate_limited')
  }, 30_000)

  it('refuses frames over the size limit', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/${'b'.repeat(32)}`)
    const replies: { code?: string; message?: string }[] = []
    const replied = new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        replies.push(JSON.parse(String(event.data)))
        if (replies.length === 2) resolve()
      })
    })
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    socket.send('x'.repeat(MAX_FRAME_BYTES + 1))
    await replied
    expect(replies[1]).toMatchObject({ code: 'bad_frame', message: 'Frame too large' })
    socket.close()
  })

  it('answers a connection flood from one IP with 429s', async () => {
    // `fetch` won't send an Upgrade header, so this speaks HTTP directly.
    const attempt = () =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          host: '127.0.0.1',
          port,
          path: `/v1/ws/${'c'.repeat(32)}`,
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        })
        request.on('upgrade', (_response, socket) => {
          socket.destroy()
          resolve(101)
        })
        request.on('response', (response) => {
          response.resume()
          resolve(response.statusCode as number)
        })
        request.on('error', reject)
        request.end()
      })
    const statuses: number[] = []
    for (let i = 0; i < 200 && !statuses.includes(429); i++) statuses.push(await attempt())
    expect(statuses).toContain(429)
    expect(statuses.filter((status) => status === 101).length).toBeGreaterThan(5)
  }, 30_000)

  it('refuses plain HTTP on the socket path', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/v1/ws/${'d'.repeat(32)}`)).status).toBe(426)
  })
})
