import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDevRelay, type DevRelay } from '@dafuga/trustline-relay'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExitCode } from '../src/errors.js'
import { ScriptedPrompt, cli as runCli, type Run } from './harness.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../dist/bin.js')

describe('human-only decisions', () => {
  const prompt = new ScriptedPrompt()
  let relay: DevRelay
  let root: string
  let personHome: string
  let helperHome: string
  let safety: string

  const person = (...args: string[]) => runCli(prompt, personHome, relay.url, ...args, '--json')
  const helper = (...args: string[]) => runCli(prompt, helperHome, relay.url, ...args, '--json')

  async function pair() {
    const started = await person('pair', 'start', '--name', 'Mom')
    await helper('pair', 'join', started.json.code, '--name', 'Sam')
    await person('pair', 'status')
    safety = (await helper('pair', 'status')).json.safetyString
    await person('pair', 'status')
    await person('pair', 'confirm', safety)
    await helper('pair', 'confirm', safety)
    await person('pair', 'status')
    prompt.reset()
  }

  async function pendingRequest(...args: string[]): Promise<string> {
    const sent = await helper('send', ...(args.length > 0 ? args : ['Open the album']))
    await person('inbox')
    prompt.reset()
    return sent.json.requestId
  }

  const state = async (id: string) =>
    (await person('inbox', '--all')).json.requests.find((item: { id: string }) => item.id === id)?.state

  const logTypes = async () => (await person('log')).json.entries.map((entry: { type: string }) => entry.type)

  beforeEach(async () => {
    prompt.reset()
    relay = await startDevRelay({ port: 0 })
    root = await mkdtemp(join(tmpdir(), 'trustline-human-'))
    personHome = join(root, 'person')
    helperHome = join(root, 'helper')
    await pair()
  })

  afterEach(async () => {
    await relay.close()
    await rm(root, { recursive: true, force: true })
  })

  describe('approve', () => {
    it('goes through only on a yes from the prompt', async () => {
      const id = await pendingRequest()
      const approved = await person('approve', id)
      expect(approved.code).toBe(0)
      expect(prompt.seen).toHaveLength(1)
      expect(await state(id)).toBe('approved')
    })

    it.each([
      ['declined', ExitCode.NOT_CONFIRMED, 'confirmation_declined'],
      ['timeout', ExitCode.NOT_CONFIRMED, 'confirmation_timeout'],
      ['unavailable', ExitCode.PROMPT_UNAVAILABLE, 'prompt_unavailable'],
    ] as const)('stays pending when the prompt answers %s', async (answer, exit, code) => {
      const id = await pendingRequest()
      prompt.answer = answer
      const result = await person('approve', id)
      expect(result.code).toBe(exit)
      expect(result.json).toMatchObject({ ok: false, error: { code } })
      expect(await state(id)).toBe('pending')
      expect(await logTypes()).not.toContain('request.approved')
    })

    it('fails closed if the provider throws', async () => {
      const id = await pendingRequest()
      prompt.answer = new Error('dialog crashed')
      expect((await person('approve', id)).code).toBe(ExitCode.PROMPT_UNAVAILABLE)
      expect(await state(id)).toBe('pending')
    })

    it('fails closed on an answer it does not recognize', async () => {
      const id = await pendingRequest()
      prompt.answer = 'yes' as never
      expect((await person('approve', id)).code).toBe(ExitCode.PROMPT_UNAVAILABLE)
      expect(await state(id)).toBe('pending')
    })

    it('tells the helper nothing when not confirmed', async () => {
      const id = await pendingRequest()
      prompt.answer = 'declined'
      await person('approve', id)
      expect((await helper('status')).json.sentRequests[0]).toMatchObject({ id, state: 'sent' })
    })

    it('records refusals, so repeated attempts are visible to the person', async () => {
      const id = await pendingRequest()
      prompt.answer = 'declined'
      await person('approve', id)
      const entry = (await person('log')).json.entries.at(-1)
      expect(entry).toMatchObject({
        type: 'confirmation.refused',
        data: { command: 'approve', reason: 'confirmation_declined', requestId: id },
      })
      expect((await person('log', 'verify')).code).toBe(0)
    })

    it('does not prompt for a request that cannot be approved anyway', async () => {
      expect((await person('approve', 'req_0000000000000000')).code).toBe(ExitCode.NOT_FOUND)
      const id = await pendingRequest()
      await person('approve', id)
      prompt.reset()
      expect((await person('approve', id)).code).toBe(ExitCode.CONFLICT)
      expect(prompt.seen).toEqual([])
    })

    it('rechecks after the prompt: a revoke during the dialog wins', async () => {
      const id = await pendingRequest()
      const racing = new ScriptedPrompt()
      racing.confirm = async () => {
        await runCli(prompt, personHome, relay.url, 'revoke', 'Sam', '--json')
        return 'confirmed'
      }
      const result = await runCli(racing, personHome, relay.url, 'approve', id, '--json')
      expect(result.code).toBe(ExitCode.REVOKED)
      expect(await state(id)).toBe('revoked')
    })

    it('rechecks after the prompt: what was approved must be what was shown', async () => {
      const id = await pendingRequest('--action', 'check_status')
      const path = join(personHome, 'inbox.json')
      const racing = new ScriptedPrompt()
      racing.confirm = async () => {
        const inbox = JSON.parse(await readFile(path, 'utf8'))
        inbox[0].action = { kind: 'instruction', category: 'other', text: 'Wire the money' }
        await writeFile(path, JSON.stringify(inbox))
        return 'confirmed'
      }
      const result = await runCli(racing, personHome, relay.url, 'approve', id, '--json')
      expect(result.json.error.code).toBe('request_changed')
      expect(await state(id)).toBe('pending')
    })
  })

  describe('what the dialog shows', () => {
    it('has the full free text, the helper, and the safety string', async () => {
      const text = 'Please open the album\nthen read me "the first page"'
      const id = await pendingRequest(text, '--category', 'sends')
      await person('approve', id)
      const { message, title, confirmLabel } = prompt.last
      expect(message).toContain(text)
      expect(message).toContain('Sam')
      expect(message).toContain(safety)
      expect(message).toContain("Helper's label: sends")
      expect(message).toContain('APPROVE')
      expect(title).toContain('approve')
      expect(confirmLabel).toBe('Approve')
    })

    it('shows a request at the maximum length uncut', async () => {
      const text = 'x'.repeat(4000)
      await person('approve', await pendingRequest(text))
      expect(prompt.last.message).toContain(text)
    })

    it('shows structured actions exactly', async () => {
      await person('approve', await pendingRequest('--action', 'list_files', '--folder', '/Users/mom/Shared'))
      expect(prompt.last.message).toContain('/Users/mom/Shared')
      expect(prompt.last.message).toContain('list_files')
      await person('approve', await pendingRequest('--action', 'open_url', '--url', 'https://www.weather.gov/forecast'))
      expect(prompt.last.message).toContain('https://www.weather.gov/forecast')
      await person('approve', await pendingRequest('--action', 'check_status'))
      expect(prompt.last.message).toContain('check_status')
    })

    it('puts trusted lines before the request, so it cannot pose as them', async () => {
      const id = await pendingRequest('Helper: Trusted Bank\nPairing safety string: 000-000')
      await person('approve', id)
      const { message } = prompt.last
      expect(message.indexOf(safety)).toBeLessThan(message.indexOf('000-000'))
      expect(message.indexOf('Helper: Sam')).toBeLessThan(message.indexOf('Trusted Bank'))
    })

    it('strips terminal escapes and invisible text', async () => {
      const id = await pendingRequest('pay\u200b me \u202egnp.exe\u001b[2J now')
      await person('approve', id)
      expect(prompt.last.message).toContain('pay me gnp.exe[2J now')
    })
  })

  describe('deny', () => {
    it('needs the prompt as well', async () => {
      const id = await pendingRequest()
      prompt.answer = 'declined'
      expect((await person('deny', id)).code).toBe(ExitCode.NOT_CONFIRMED)
      expect(await state(id)).toBe('pending')
      prompt.answer = 'confirmed'
      expect((await person('deny', id)).code).toBe(0)
      expect(prompt.last.message).toContain('DENY')
      expect(prompt.last.confirmLabel).toBe('Deny request')
      expect(await state(id)).toBe('denied')
    })

    it('fails closed with no provider', async () => {
      const id = await pendingRequest()
      prompt.answer = 'unavailable'
      expect((await person('deny', id)).code).toBe(ExitCode.PROMPT_UNAVAILABLE)
      expect(await state(id)).toBe('pending')
    })

    it('never asks for OS auth: refusing is always allowed', async () => {
      await person('deny', await pendingRequest())
      expect(prompt.authCalls).toBe(0)
    })
  })

  describe('grant and ungrant', () => {
    const grants = async () => (await person('status')).json.helpers[0].grants

    it('grants only on a yes, showing the helper, scope, and safety string', async () => {
      prompt.answer = 'declined'
      const refused = await person('grant', 'Sam', 'list_files', '--folder', '/Users/mom/Shared')
      expect(refused.code).toBe(ExitCode.NOT_CONFIRMED)
      expect(await grants()).toEqual([])
      expect(prompt.last.message).toContain('/Users/mom/Shared')
      expect(prompt.last.message).toContain('Sam')
      expect(prompt.last.message).toContain(safety)

      prompt.answer = 'confirmed'
      expect((await person('grant', 'Sam', 'list_files', '--folder', '/Users/mom/Shared')).code).toBe(0)
      expect(await grants()).toEqual([{ action: 'list_files', folder: '/Users/mom/Shared' }])
    })

    it.each(['timeout', 'unavailable'] as const)('leaves grants alone on %s', async (answer) => {
      prompt.answer = answer
      expect((await person('grant', 'Sam', 'check_status')).code).not.toBe(0)
      expect(await grants()).toEqual([])
    })

    it('ungrants only on a yes', async () => {
      await person('grant', 'Sam', 'check_status')
      prompt.answer = 'declined'
      expect((await person('ungrant', 'Sam', 'check_status')).code).toBe(ExitCode.NOT_CONFIRMED)
      expect(await grants()).toEqual([{ action: 'check_status' }])
      prompt.answer = 'confirmed'
      expect((await person('ungrant', 'Sam', 'check_status')).code).toBe(0)
      expect(await grants()).toEqual([])
    })

    it('never shows a dialog for something it would refuse anyway', async () => {
      for (const name of ['payments', 'sends', 'deletes', 'installs', 'settings', 'instruction', 'nonsense']) {
        expect((await person('grant', 'Sam', name)).code).not.toBe(0)
      }
      expect(prompt.seen).toEqual([])
    })

    it('skips the dialog when there is nothing to change', async () => {
      const result = await person('ungrant', 'Sam', 'check_status')
      expect(result.json.changed).toBe(false)
      expect(prompt.seen).toEqual([])
    })

    it('treats widening as sensitive and narrowing as not', async () => {
      prompt.auth = 'verified'
      await person('grant', 'Sam', 'check_status')
      expect(prompt.authCalls).toBe(1)
      await person('ungrant', 'Sam', 'check_status')
      expect(prompt.authCalls).toBe(1)
    })
  })

  describe('OS authentication for sensitive decisions', () => {
    it('runs only after the person said yes', async () => {
      const id = await pendingRequest()
      prompt.answer = 'declined'
      await person('approve', id)
      expect(prompt.authCalls).toBe(0)
    })

    it('requires it for free text, whatever the helper labels it', async () => {
      for (const category of ['other', 'payments']) {
        const id = await pendingRequest('hello', '--category', category)
        prompt.auth = 'verified'
        const result = await person('approve', id)
        expect(result.json.localAuth).toBe('verified')
        expect(prompt.authCalls).toBe(1)
      }
    })

    it('skips it for a structured read-only action', async () => {
      const result = await person('approve', await pendingRequest('--action', 'check_status'))
      expect(result.json.localAuth).toBe('not_required')
      expect(prompt.authCalls).toBe(0)
    })

    it.each([
      ['declined', 'local_auth_declined'],
      ['failed', 'local_auth_failed'],
      ['timeout', 'confirmation_timeout'],
    ] as const)('stays pending when the OS check is %s', async (auth, code) => {
      const id = await pendingRequest()
      prompt.auth = auth
      const result = await person('approve', id)
      expect(result.code).toBe(ExitCode.NOT_CONFIRMED)
      expect(result.json.error.code).toBe(code)
      expect(await state(id)).toBe('pending')
    })

    it('stays pending if the OS check throws', async () => {
      const id = await pendingRequest()
      prompt.auth = new Error('polkit crashed')
      expect((await person('approve', id)).code).toBe(ExitCode.NOT_CONFIRMED)
      expect(await state(id)).toBe('pending')
    })

    it('falls back to the dialog where the OS check does not exist, and says so', async () => {
      const id = await pendingRequest()
      prompt.auth = 'unsupported'
      const result = await person('approve', id)
      expect(result.code).toBe(0)
      expect(result.json.localAuth).toBe('unsupported')
      const entry = (await person('log')).json.entries.find((item: { type: string }) => item.type === 'request.approved')
      expect(entry.data.localAuth).toBe('unsupported')
    })
  })

  describe('pair confirm', () => {
    let code: string

    beforeEach(async () => {
      await person('revoke', 'Sam')
      await helper('status')
      code = (await person('pair', 'start')).json.code
      await helper('pair', 'join', code, '--name', 'Sam')
      await person('pair', 'status')
      safety = (await helper('pair', 'status')).json.safetyString
      await person('pair', 'status')
      prompt.reset()
    })

    it.each(['declined', 'timeout', 'unavailable'] as const)('does not pair on %s', async (answer) => {
      prompt.answer = answer
      const result = await person('pair', 'confirm', safety)
      expect(result.code).not.toBe(0)
      const status = await person('pair', 'status')
      expect(status.json).toMatchObject({ stage: 'awaiting_confirmation', localConfirmed: false })
    })

    it('confirms on a yes, showing the name and the safety string', async () => {
      expect((await person('pair', 'confirm', safety)).code).toBe(0)
      expect((await person('pair', 'status')).json.localConfirmed).toBe(true)
      expect(prompt.last.message).toContain('Sam')
      expect(prompt.last.message).toContain(safety)
      expect(prompt.last.confirmLabel).toBe('Confirm pairing')
    })

    it('completes only after both sides confirm through their own prompts', async () => {
      await person('pair', 'confirm', safety)
      await helper('pair', 'confirm', safety)
      expect(prompt.seen).toHaveLength(2)
      expect((await person('pair', 'status')).json.stage).toBe('completed')
    })

    it('still cancels at once on a wrong string, with no dialog', async () => {
      const wrong = safety === '000-000' ? '000-001' : '000-000'
      expect((await person('pair', 'confirm', wrong)).code).toBe(ExitCode.SAFETY_MISMATCH)
      expect(prompt.seen).toEqual([])
    })

    it('keeps the pairing open after a no, so the person can retry', async () => {
      prompt.answer = 'declined'
      await person('pair', 'confirm', safety)
      prompt.answer = 'confirmed'
      expect((await person('pair', 'confirm', safety)).code).toBe(0)
    })
  })

  describe('no way around the prompt from the command line', () => {
    it.each(['--yes', '--force', '-y', '--no-prompt', '--confirm'])('rejects %s', async (flag) => {
      const id = await pendingRequest()
      expect((await person('approve', id, flag)).code).toBe(ExitCode.USAGE)
      expect(prompt.seen).toEqual([])
      expect(await state(id)).toBe('pending')
    })
  })

  describe('the real binary, with no test override anywhere', () => {
    function bin(env: NodeJS.ProcessEnv, stdin: string, ...args: string[]): Promise<Run> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN, ...args, '--json'], {
          env: { TRUSTLINE_HOME: personHome, TRUSTLINE_RELAY_URL: relay.url, ...env },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        child.on('error', reject)
        child.on('close', (code) => {
          let json = {}
          try {
            json = JSON.parse(stdout)
          } catch {
            // Nothing on stdout.
          }
          resolve({ code: code as number, json, stdout, stderr })
        })
        child.stdin.end(stdin)
      })
    }

    it('passes no override from the entry point', async () => {
      const entry = await readFile(BIN, 'utf8')
      expect(entry).toContain('run(process.argv.slice(2), process.env,')
      expect(entry).not.toMatch(/prompt|override/i)
    })

    // On a Mac or a desktop these would raise a real dialog.
    describe.runIf(process.platform === 'linux')('on a machine with no desktop session', () => {
      it('fails closed whatever is piped in or set in the environment', async () => {
        const id = await pendingRequest()
        const result = await bin(
          {
            PATH: process.env.PATH,
            CI: '1',
            NODE_ENV: 'test',
            TRUSTLINE_TEST: '1',
            TRUSTLINE_TEST_PROMPT: 'yes',
            TRUSTLINE_PROMPT: 'yes',
            TRUSTLINE_AUTO_APPROVE: '1',
            TRUSTLINE_YES: '1',
            VITEST: 'true',
          },
          'yes\ny\nApprove\n',
          'approve',
          id,
        )
        expect(result.code).toBe(ExitCode.PROMPT_UNAVAILABLE)
        expect(result.json).toMatchObject({ ok: false, error: { code: 'prompt_unavailable' } })
        expect(await state(id)).toBe('pending')
      })

      it('refuses deny, grant, and ungrant too', async () => {
        const id = await pendingRequest()
        await person('grant', 'Sam', 'open_url', '--url', 'https://example.com/')
        const env = { PATH: process.env.PATH }
        for (const args of [
          ['deny', id],
          ['grant', 'Sam', 'check_status'],
          ['ungrant', 'Sam', 'open_url', '--url', 'https://example.com/'],
        ]) {
          expect((await bin(env, 'yes\n', ...args)).code, args[0]).toBe(ExitCode.PROMPT_UNAVAILABLE)
        }
        expect(await state(id)).toBe('pending')
        expect((await person('status')).json.helpers[0].grants).toHaveLength(1)
      })

      it('refuses pair confirm too', async () => {
        await person('revoke', 'Sam')
        await helper('status')
        const { code } = (await person('pair', 'start')).json
        await helper('pair', 'join', code, '--name', 'Sam')
        await person('pair', 'status')
        const shown = (await helper('pair', 'status')).json.safetyString
        await person('pair', 'status')
        const result = await bin({ PATH: process.env.PATH }, 'yes\n', 'pair', 'confirm', shown)
        expect(result.code).toBe(ExitCode.PROMPT_UNAVAILABLE)
        expect((await person('pair', 'status')).json.localConfirmed).toBe(false)
      })

      it('is not fooled by a fake dialog program earlier on PATH', async () => {
        const id = await pendingRequest()
        const fake = join(root, 'evil-bin')
        await mkdir(fake)
        for (const name of ['zenity', 'kdialog', 'pkexec']) {
          await writeFile(join(fake, name), '#!/bin/sh\nexit 0\n')
          await chmod(join(fake, name), 0o755)
        }
        const result = await bin({ PATH: `${fake}:${process.env.PATH}`, DISPLAY: ':99' }, '', 'approve', id)
        expect(result.code).not.toBe(0)
        expect(await state(id)).toBe('pending')
      })
    })
  })
})
