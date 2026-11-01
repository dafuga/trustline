import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import {
  Identity,
  envelopeSigningBytes,
  fromBase64,
  sealMessage,
  sign,
  toBase64,
  utf8,
} from '@dafuga/trustline-protocol'
import { startDevRelay, type DevRelay } from '@dafuga/trustline-relay'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExitCode } from '../src/errors.js'
import { DEFAULT_RELAY_URL } from '../src/context.js'
import { RelayClient } from '../src/relay-client.js'
import { ScriptedPrompt, cli as runCli } from './harness.js'

const prompt = new ScriptedPrompt()
const cli = (home: string, relayUrl: string | null, ...args: string[]) => runCli(prompt, home, relayUrl, ...args)

/** What a modified helper could send: properly sealed and signed, but outside the schema. */
function sealForged(sender: Identity, recipient: Identity, message: unknown) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box(
    utf8(JSON.stringify(message)),
    nonce,
    fromBase64(recipient.boxPublicKey),
    fromBase64(sender.boxSecretKey),
  )
  const unsigned = {
    v: 1 as const,
    from: sender.deviceId,
    to: recipient.deviceId,
    seq: 1000,
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  }
  return { ...unsigned, signature: sign(envelopeSigningBytes(unsigned), sender) }
}

describe('trustline end to end', () => {
  let relay: DevRelay
  let root: string
  let personHome: string
  let helperHome: string

  const person = (...args: string[]) => cli(personHome, relay.url, ...args, '--json')
  const helper = (...args: string[]) => cli(helperHome, relay.url, ...args, '--json')

  /** Walks both sides through pairing with each confirming what the other shows. */
  async function pair() {
    const started = await person('pair', 'start', '--name', 'Mom')
    expect(started.code).toBe(0)
    const joined = await helper('pair', 'join', started.json.code, '--name', 'Sam')
    expect(joined.code).toBe(0)
    await person('pair', 'status')
    const helperStage = await helper('pair', 'status')
    const personStage = await person('pair', 'status')
    expect(personStage.json.stage).toBe('awaiting_confirmation')
    expect(helperStage.json.safetyString).toBe(personStage.json.safetyString)
    expect(personStage.json.peerName).toBe('Sam')
    expect((await person('pair', 'confirm', helperStage.json.safetyString)).code).toBe(0)
    const finished = await helper('pair', 'confirm', personStage.json.safetyString)
    expect(finished.json.stage).toBe('completed')
    const done = await person('pair', 'status')
    expect(done.json.stage).toBe('completed')
    return done.json.peer as { id: string; name: string }
  }

  beforeEach(async () => {
    relay = await startDevRelay({ port: 0 })
    root = await mkdtemp(join(tmpdir(), 'trustline-e2e-'))
    personHome = join(root, 'person')
    helperHome = join(root, 'helper')
  })

  afterEach(async () => {
    await relay.close()
    await rm(root, { recursive: true, force: true })
  })

  it('runs the whole lifecycle: pair, request, approve, log, revoke', async () => {
    const sam = await pair()
    expect(sam.name).toBe('Sam')

    const sent = await helper('send', 'Please open the family photo album')
    expect(sent.code).toBe(0)
    expect(sent.json).toMatchObject({ ok: true, state: 'sent', to: { name: 'Mom' } })
    const { requestId } = sent.json

    const inbox = await person('inbox')
    expect(inbox.code).toBe(0)
    expect(inbox.json.requests).toHaveLength(1)
    expect(inbox.json.requests[0]).toMatchObject({
      id: requestId,
      helperName: 'Sam',
      state: 'pending',
      action: { kind: 'instruction', category: 'other', text: 'Please open the family photo album' },
    })

    const approved = await person('approve', requestId)
    expect(approved.code).toBe(0)
    expect(approved.json).toMatchObject({ helperNotified: true, request: { state: 'approved', decidedBy: 'person' } })
    expect((await person('inbox')).json.requests).toEqual([])

    const helperStatus = await helper('status')
    expect(helperStatus.json.sentRequests[0]).toMatchObject({ id: requestId, state: 'approved' })

    const log = await person('log')
    const types = log.json.entries.map((entry: { type: string }) => entry.type)
    expect(types).toEqual(
      expect.arrayContaining(['pairing.started', 'pairing.completed', 'request.received', 'request.approved']),
    )
    expect((await person('log', 'verify')).json).toMatchObject({ ok: true, valid: true })

    const revoked = await person('revoke', 'Sam')
    expect(revoked.code).toBe(0)
    expect(revoked.json).toMatchObject({ relayNotified: true, revoked: [{ id: sam.id, status: 'revoked' }] })

    const refused = await helper('send', 'One more thing')
    expect(refused.code).toBe(ExitCode.REVOKED)
    expect(refused.json).toMatchObject({ ok: false, error: { code: 'access_revoked', exitCode: 7 } })
    expect((await person('inbox')).json.requests).toEqual([])
    expect((await helper('status')).json.people[0].status).toBe('revoked')

    const finalLog = await person('log')
    expect(finalLog.json.entries.map((entry: { type: string }) => entry.type)).toContain('helper.revoked')
    expect((await person('log', 'verify')).code).toBe(0)
  })

  it('keeps enforcing a revocation with no help from the relay or the helper', async () => {
    await pair()
    await person('revoke', '--all')

    // Stand-in for a modified helper on a relay that has no block record for it.
    const fresh = await startDevRelay({ port: 0 })
    try {
      const helperIdentity = Identity.parse(JSON.parse(await readFile(join(helperHome, 'identity.json'), 'utf8')))
      const personIdentity = Identity.parse(JSON.parse(await readFile(join(personHome, 'identity.json'), 'utf8')))
      const envelope = sealMessage({
        sender: helperIdentity,
        recipient: personIdentity,
        seq: 100,
        message: {
          type: 'request',
          requestId: 'req_00000000000000ff',
          action: { kind: 'instruction', category: 'other', text: 'Let me back in' },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      })
      const client = await RelayClient.connect(fresh.url, helperIdentity)
      await client.send(personIdentity.deviceId, JSON.stringify(envelope))
      client.close()

      const inbox = await cli(personHome, fresh.url, 'inbox', '--all', '--json')
      expect(inbox.json.requests).toEqual([])
      const log = await cli(personHome, fresh.url, 'log', '--json')
      expect(log.json.entries.at(-1)).toMatchObject({ type: 'message.rejected', data: { reason: 'revoked' } })
    } finally {
      await fresh.close()
    }
  })

  it('cancels pending requests on revoke, so they can no longer be approved', async () => {
    await pair()
    const { requestId } = (await helper('send', 'Open the album')).json
    await person('inbox')
    await person('revoke', 'Sam')
    const approve = await person('approve', requestId)
    expect(approve.code).toBe(ExitCode.REVOKED)
    expect((await person('inbox', '--state', 'revoked')).json.requests[0].id).toBe(requestId)
  })

  it('revokes locally even with the relay down, and tells it later', async () => {
    await pair()
    await relay.close()
    const offline = await person('revoke', 'Sam')
    expect(offline.code).toBe(0)
    expect(offline.json.relayNotified).toBe(false)
    expect((await person('status', '--offline')).json.helpers[0].status).toBe('revoked')

    relay = await startDevRelay({ port: 0 })
    expect((await person('status')).json.relay.state).toBe('ok')
    expect((await helper('send', 'Hello')).code).toBe(ExitCode.REVOKED)
  })

  it('lets a person re-pair a revoked helper, back at ask-only', async () => {
    await pair()
    await person('grant', 'Sam', 'check_status')
    await person('revoke', 'Sam')
    await helper('status')
    await pair()
    const status = await person('status')
    expect(status.json.helpers).toHaveLength(1)
    expect(status.json.helpers[0]).toMatchObject({ status: 'active', grants: [] })
    const sent = await helper('send', '--action', 'check_status')
    expect(sent.code).toBe(0)
    expect((await person('inbox')).json.requests[0].id).toBe(sent.json.requestId)
  })

  it('records denial and tells the helper', async () => {
    await pair()
    const { requestId } = (await helper('send', 'Open the album')).json
    await person('inbox')
    expect((await person('deny', requestId)).json.request.state).toBe('denied')
    expect((await helper('status')).json.sentRequests[0].state).toBe('denied')
    expect((await person('approve', requestId)).code).toBe(ExitCode.CONFLICT)
  })

  it('reports unknown requests and helpers as not found', async () => {
    expect((await person('approve', 'req_0000000000000000')).code).toBe(ExitCode.NOT_FOUND)
    expect((await person('revoke', 'nobody')).code).toBe(ExitCode.NOT_FOUND)
    expect((await helper('send', 'hello')).code).toBe(ExitCode.NOT_FOUND)
  })

  describe('permission gating', () => {
    const folder = '/Users/mom/Shared'

    it('still needs approval for free text, whatever is granted or labeled', async () => {
      await pair()
      expect((await person('grant', 'Sam', 'check_status')).code).toBe(0)

      const scam = await helper('send', 'What is on the calendar today?')
      const labeled = await helper('send', 'check_status', '--category', 'other')
      const inbox = await person('inbox')
      expect(inbox.json.requests.map((item: { id: string }) => item.id)).toEqual([
        scam.json.requestId,
        labeled.json.requestId,
      ])
      expect(inbox.json.requests[0]).toMatchObject({ state: 'pending', sensitive: true })
    })

    it('auto-approves only the action the person granted', async () => {
      await pair()
      await person('grant', 'Sam', 'check_status')
      const sent = await helper('send', '--action', 'check_status')
      expect((await person('inbox')).json.requests).toEqual([])
      const approved = await person('inbox', '--state', 'approved')
      expect(approved.json.requests[0]).toMatchObject({
        id: sent.json.requestId,
        decidedBy: 'grant',
        action: { kind: 'check_status' },
      })
      expect((await helper('status')).json.sentRequests[0].state).toBe('approved')
    })

    it('asks for a read-only action with no grant', async () => {
      await pair()
      await helper('send', '--action', 'check_status')
      expect((await person('inbox')).json.requests[0]).toMatchObject({ state: 'pending', sensitive: false })
    })

    it('scopes list_files to the exact folder the person chose', async () => {
      await pair()
      expect((await person('grant', 'Sam', 'list_files', '--folder', folder)).code).toBe(0)
      await helper('send', '--action', 'list_files', '--folder', folder)
      await helper('send', '--action', 'list_files', '--folder', '/Users/mom/Documents')
      const pending = (await person('inbox')).json.requests
      expect(pending.map((item: { action: unknown }) => item.action)).toEqual([
        { kind: 'list_files', folder: '/Users/mom/Documents' },
      ])
      expect((await person('inbox', '--state', 'approved')).json.requests).toHaveLength(1)
    })

    it('scopes open_url to the exact page, after normalizing what was typed', async () => {
      await pair()
      expect((await person('grant', 'Sam', 'open_url', '--url', 'https://WWW.Weather.gov')).code).toBe(0)
      await helper('send', '--action', 'open_url', '--url', 'https://www.weather.gov/')
      await helper('send', '--action', 'open_url', '--url', 'https://www.weather.gov/login')
      expect((await person('inbox', '--state', 'approved')).json.requests).toHaveLength(1)
      expect((await person('inbox')).json.requests).toHaveLength(1)
    })

    it('stops auto-approving once ungranted', async () => {
      await pair()
      await person('grant', 'Sam', 'list_files', '--folder', folder)
      expect((await person('ungrant', 'Sam', 'list_files', '--folder', folder)).json.helper.grants).toEqual([])
      await helper('send', '--action', 'list_files', '--folder', folder)
      expect((await person('inbox')).json.requests).toHaveLength(1)
    })

    it('hard-rejects granting anything sensitive or free text', async () => {
      await pair()
      for (const name of ['payments', 'sends', 'deletes', 'installs', 'settings', 'other', 'instruction']) {
        const result = await person('grant', 'Sam', name)
        expect(result.code, name).toBe(ExitCode.CONFLICT)
        expect(result.json.error.code).toBe('not_grantable')
      }
      expect((await person('status')).json.helpers[0].grants).toEqual([])
    })

    it('rejects unknown actions and missing or mismatched scope', async () => {
      await pair()
      expect((await person('grant', 'Sam', 'read_screen_summary')).json.error.code).toBe('invalid_action')
      expect((await person('grant', 'Sam', 'info')).json.error.code).toBe('invalid_action')
      expect((await person('grant', 'Sam', 'list_files')).code).toBe(ExitCode.USAGE)
      expect((await person('grant', 'Sam', 'list_files', '--folder', 'relative')).code).toBe(ExitCode.USAGE)
      expect((await person('grant', 'Sam', 'list_files', '--folder', '/a/../b')).code).toBe(ExitCode.USAGE)
      expect((await person('grant', 'Sam', 'open_url', '--url', 'http://example.com/')).code).toBe(ExitCode.USAGE)
      expect((await person('grant', 'Sam', 'check_status', '--folder', '/a')).code).toBe(ExitCode.USAGE)
      expect((await helper('send', '--action', 'wire_money')).json.error.code).toBe('invalid_action')
      expect((await helper('send', '--action', 'check_status', 'and also')).code).toBe(ExitCode.USAGE)
      expect((await helper('send', '--category', 'info', 'hello')).json.error.code).toBe('invalid_category')
      expect((await helper('send')).code).toBe(ExitCode.USAGE)
    })

    it('ignores sensitive grants edited into the file by hand', async () => {
      await pair()
      const path = join(personHome, 'peers.json')
      const peers = JSON.parse(await readFile(path, 'utf8'))
      peers[0].grants = [
        ...['payments', 'sends', 'deletes', 'installs', 'settings', 'info', 'other'],
        ...['payments', 'sends', 'instruction'].map((action) => ({ action })),
        { action: 'list_files' },
        { action: 'list_files', folder: '/a/../..' },
      ]
      await writeFile(path, JSON.stringify(peers))
      expect((await person('status')).json.helpers[0].grants).toEqual([])
      await helper('send', 'hello', '--category', 'payments')
      await helper('send', '--action', 'list_files', '--folder', '/')
      const requests = (await person('inbox')).json.requests
      expect(requests.map((item: { state: string }) => item.state)).toEqual(['pending', 'pending'])
    })

    it('drops an unknown action type on arrival, however it was sent', async () => {
      await pair()
      const helperIdentity = Identity.parse(JSON.parse(await readFile(join(helperHome, 'identity.json'), 'utf8')))
      const personIdentity = Identity.parse(JSON.parse(await readFile(join(personHome, 'identity.json'), 'utf8')))
      const forged = sealForged(helperIdentity, personIdentity, {
        type: 'request',
        requestId: 'req_00000000000000aa',
        action: { kind: 'wire_money', amount: 500 },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })
      const client = await RelayClient.connect(relay.url, helperIdentity)
      await client.send(personIdentity.deviceId, JSON.stringify(forged))
      client.close()

      expect((await person('inbox', '--all')).json.requests).toEqual([])
      const log = await person('log')
      expect(log.json.entries.at(-1)).toMatchObject({ type: 'message.rejected', data: { reason: 'invalid_message' } })
    })

    it('gives a helper no local command that reaches the person', async () => {
      await pair()
      const result = await helper('grant', 'Mom', 'check_status')
      expect(result.code).toBe(ExitCode.NOT_FOUND)
      expect((await person('status')).json.helpers[0].grants).toEqual([])
    })
  })

  describe('pairing failures', () => {
    it('rejects an expired code', async () => {
      const { json } = await person('pair', 'start', '--ttl-seconds', '1')
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const joined = await helper('pair', 'join', json.code)
      expect(joined.code).toBe(ExitCode.PAIRING_FAILED)
      expect(joined.json.error.code).toBe('code_expired')
      expect((await person('pair', 'status')).code).toBe(ExitCode.PAIRING_FAILED)
      expect((await person('pair', 'status')).json.stage).toBe('none')
    })

    it('rejects a reused code', async () => {
      const { json } = await person('pair', 'start')
      expect((await helper('pair', 'join', json.code)).code).toBe(0)
      const second = await cli(join(root, 'scammer'), relay.url, 'pair', 'join', json.code, '--json')
      expect(second.code).toBe(ExitCode.PAIRING_FAILED)
      expect(second.json.error.code).toBe('code_used')
    })

    it('rejects an unknown or malformed code', async () => {
      const unknown = await helper('pair', 'join', 'ABCD-EFGH-JKMN')
      expect(unknown.code).toBe(ExitCode.PAIRING_FAILED)
      expect(unknown.json.error.code).toBe('code_invalid')
      const link = await helper('pair', 'join', 'https://trustline.example/pair?helper=abc')
      expect(link.code).toBe(ExitCode.PAIRING_FAILED)
      expect(link.json.error.code).toBe('invalid_code')
    })

    it('aborts both sides on a mismatched safety string, adding nobody', async () => {
      const { json } = await person('pair', 'start')
      await helper('pair', 'join', json.code)
      await person('pair', 'status')
      const helperStage = await helper('pair', 'status')
      await person('pair', 'status')
      const wrong = helperStage.json.safetyString === '000-000' ? '000-001' : '000-000'

      const mismatch = await person('pair', 'confirm', wrong)
      expect(mismatch.code).toBe(ExitCode.SAFETY_MISMATCH)
      expect(mismatch.json.error.code).toBe('safety_mismatch')

      expect((await helper('pair', 'status')).code).toBe(ExitCode.SAFETY_MISMATCH)
      expect((await person('status')).json.helpers).toEqual([])
      expect((await helper('status')).json.people).toEqual([])
    })

    it('adds no helper until the person confirms, even if the helper has', async () => {
      const { json } = await person('pair', 'start')
      await helper('pair', 'join', json.code)
      await person('pair', 'status')
      const helperStage = await helper('pair', 'status')
      await helper('pair', 'confirm', helperStage.json.safetyString)
      const personStage = await person('pair', 'status')
      expect(personStage.json).toMatchObject({ peerConfirmed: true, localConfirmed: false })
      expect((await person('status')).json.helpers).toEqual([])
      expect((await helper('send', 'Can I go now?')).code).toBe(ExitCode.NOT_FOUND)
    })

    it('completes for humans with blocking waits on both sides', async () => {
      const { json } = await person('pair', 'start')
      const [joined, status] = await Promise.all([
        helper('pair', 'join', json.code, '--wait', '10'),
        person('pair', 'status', '--wait', '10'),
      ])
      expect(joined.json.safetyString).toBe(status.json.safetyString)
    })

    it('does not start a second pairing over a live one', async () => {
      await person('pair', 'start')
      expect((await person('pair', 'start')).code).toBe(ExitCode.CONFLICT)
      expect((await person('pair', 'cancel')).json.cancelled).toBe(true)
      expect((await person('pair', 'start')).code).toBe(0)
    })
  })

  describe('log tampering', () => {
    it('catches an edit to the log file', async () => {
      await pair()
      const { requestId } = (await helper('send', 'Open the album')).json
      await person('inbox')
      await person('deny', requestId)
      expect((await person('log', 'verify')).code).toBe(0)

      const path = join(personHome, 'log.jsonl')
      const original = await readFile(path, 'utf8')
      await writeFile(path, original.replace('request.denied', 'request.approved'))
      const verify = await person('log', 'verify')
      expect(verify.code).toBe(ExitCode.LOG_TAMPERED)
      expect(verify.json.error).toMatchObject({ code: 'log_tampered', reason: 'entry hash mismatch' })
    })

    it('catches entries cut from the end, or added by hand', async () => {
      await pair()
      const path = join(personHome, 'log.jsonl')
      const lines = (await readFile(path, 'utf8')).trim().split('\n')
      await writeFile(path, `${lines.slice(0, -1).join('\n')}\n`)
      expect((await person('log', 'verify')).code).toBe(ExitCode.LOG_TAMPERED)

      await writeFile(path, `${lines.join('\n')}\n`)
      expect((await person('log', 'verify')).code).toBe(0)
      await appendFile(path, '{"seq":999}\n')
      expect((await person('log', 'verify')).code).toBe(ExitCode.LOG_TAMPERED)
    })
  })

  describe('identities and CLI contract', () => {
    it('keeps identities apart by TRUSTLINE_HOME', async () => {
      const a = await person('status', '--offline')
      const b = await helper('status', '--offline')
      expect(a.json.deviceId).not.toBe(b.json.deviceId)
      expect((await person('status', '--offline')).json.deviceId).toBe(a.json.deviceId)
    })

    it('writes secrets readable only by their owner', async () => {
      await person('status', '--offline')
      const { stat } = await import('node:fs/promises')
      expect((await stat(join(personHome, 'identity.json'))).mode & 0o777).toBe(0o600)
    })

    it('uses exit 2 and a JSON error for usage mistakes', async () => {
      const unknown = await person('frobnicate')
      expect(unknown.code).toBe(ExitCode.USAGE)
      expect(unknown.json).toMatchObject({ ok: false, error: { code: 'usage', exitCode: 2 } })
      expect((await person('approve')).code).toBe(ExitCode.USAGE)
      expect((await person('revoke')).code).toBe(ExitCode.USAGE)
      expect((await person('revoke', 'a', 'b')).code).toBe(ExitCode.USAGE)
      expect((await person('revoke', 'a', '--all')).code).toBe(ExitCode.USAGE)
      expect((await helper('send', 'x', '--category', 'nope')).code).toBe(ExitCode.USAGE)
    })

    it('uses exit 4 when the relay is unreachable', async () => {
      const dead = 'ws://127.0.0.1:9'
      const started = await cli(personHome, dead, 'pair', 'start', '--json')
      expect(started.code).toBe(ExitCode.RELAY_UNAVAILABLE)
      expect(started.json.error.code).toBe('relay_unavailable')
      const status = await cli(personHome, dead, 'status', '--json')
      expect(status.code).toBe(0)
      expect(status.json.relay.state).toBe('unreachable')
    })

    it('supports flags before the command', async () => {
      const result = await cli(personHome, null, '--json', '--relay', relay.url, 'status')
      expect(result.json.relay).toEqual({ url: relay.url, state: 'ok' })
      expect((await cli(personHome, null, 'status', '--json')).json.relay.url).toBe(relay.url)
    })

    it('refuses the placeholder relay with a message saying what to set', async () => {
      expect(DEFAULT_RELAY_URL).toBe('wss://trustline-relay.<account>.workers.dev')
      const started = await cli(personHome, null, 'pair', 'start', '--json')
      expect(started.code).toBe(ExitCode.RELAY_UNAVAILABLE)
      expect(started.json.error.code).toBe('relay_not_configured')
      expect(started.json.error.message).toContain('TRUSTLINE_RELAY_URL')
      expect(started.json.error.message).toContain('--relay')
      expect(started.json.error.message).toContain('ws://127.0.0.1:8787')

      const flagged = await cli(personHome, DEFAULT_RELAY_URL, 'pair', 'start', '--json')
      expect(flagged.json.error.code).toBe('relay_not_configured')
    })

    it('keeps local commands working without a relay, and says why it is not syncing', async () => {
      const status = await cli(personHome, null, 'status', '--json')
      expect(status.code).toBe(0)
      expect(status.json.relay).toEqual({ url: DEFAULT_RELAY_URL, state: 'not_configured' })
      expect((await cli(personHome, null, 'inbox')).stdout).toContain('TRUSTLINE_RELAY_URL')
      expect((await cli(personHome, null, 'revoke', '--all', '--json')).code).toBe(0)
    })

    it('still reaches a local dev relay', async () => {
      const result = await cli(personHome, relay.url, 'pair', 'start', '--json')
      expect(result.code).toBe(0)
    })

    it('strips terminal escapes from helper text in human output', async () => {
      await pair()
      await helper('send', 'hello\u001b[2J\u001b]0;pwned\u0007 world')
      const text = await cli(personHome, relay.url, 'inbox')
      expect(text.stdout).toContain('hello[2J]0;pwned world')
      expect(text.stdout).not.toContain('\u001b')
    })

    it('prints help without touching state', async () => {
      const help = await cli(personHome, null, '--help')
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('trustline pair start')
    })
  })
})
