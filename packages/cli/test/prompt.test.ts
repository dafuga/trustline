import { describe, expect, it, vi } from 'vitest'
import {
  PROMPT_TIMEOUT_SECONDS,
  appleScriptString,
  kdialogArgs,
  osascriptArgs,
  powerShellArgs,
  powerShellScript,
  powerShellString,
  systemPrompt,
  zenityArgs,
  type PromptHost,
  type PromptRequest,
  type RunResult,
} from '../src/prompt.js'

const request: PromptRequest = {
  title: 'Trustline: approve this request?',
  message: 'Helper: Sam\nExact request:\nhello',
  confirmLabel: 'Approve',
  cancelLabel: 'Cancel',
}

const hostile = [
  '"; do shell script "rm -rf ~"; "',
  '\\" & (do shell script "id") & \\"',
  "'; Remove-Item -Recurse C:\\; '",
  '\u2019; calc.exe; \u2018',
  '$(rm -rf ~) `id` ${PATH} | ; & > <',
  '<span size="1">hidden</span>&amp;',
  '--ok-label=Pwned',
]

describe('AppleScript escaping', () => {
  /** Reads a literal the way AppleScript does, stopping at the first unescaped quote. */
  function parseLiteral(script: string): { value: string; rest: string } {
    expect(script[0]).toBe('"')
    let value = ''
    for (let i = 1; i < script.length; i++) {
      const char = script[i] as string
      if (char === '\\') value += script[++i]
      else if (char === '"') return { value, rest: script.slice(i + 1) }
      else value += char
    }
    throw new Error('unterminated literal')
  }

  it('escapes backslashes before quotes', () => {
    expect(appleScriptString('a"b')).toBe('"a\\"b"')
    expect(appleScriptString('a\\b')).toBe('"a\\\\b"')
    expect(appleScriptString('\\"')).toBe('"\\\\\\""')
  })

  it('never lets hostile text end the string early', () => {
    for (const text of hostile) {
      expect(parseLiteral(appleScriptString(text))).toEqual({ value: text, rest: '' })
    }
  })

  it('keeps hostile text inside the message literal of the dialog', () => {
    for (const text of hostile) {
      const [flag, line] = osascriptArgs({ ...request, message: text })
      expect(flag).toBe('-e')
      const prefix = 'set answer to display dialog '
      expect(line?.startsWith(prefix)).toBe(true)
      const { value, rest } = parseLiteral((line as string).slice(prefix.length))
      expect(value).toBe(text)
      expect(rest.startsWith(' with title ')).toBe(true)
    }
  })

  it('defaults to Cancel and gives up on its own', () => {
    const script = osascriptArgs(request).join(' ')
    expect(script).toContain('default button "Cancel" cancel button "Cancel"')
    expect(script).toContain(`giving up after ${PROMPT_TIMEOUT_SECONDS}`)
  })
})

describe('PowerShell escaping', () => {
  const quotes = /['\u2018\u2019\u201a\u201b]/

  /** Reads a single-quoted literal the way PowerShell does: any quote-like character ends it unless doubled. */
  function parseLiteral(source: string): { value: string; rest: string } {
    expect(quotes.test(source[0] as string)).toBe(true)
    let value = ''
    for (let i = 1; i < source.length; i++) {
      const char = source[i] as string
      if (!quotes.test(char)) value += char
      else if (quotes.test(source[i + 1] ?? '')) value += source[++i]
      else return { value, rest: source.slice(i + 1) }
    }
    throw new Error('unterminated literal')
  }

  it('doubles every character PowerShell reads as a single quote', () => {
    expect(powerShellString("it's")).toBe("'it''s'")
    expect(powerShellString('it\u2019s')).toBe("'it\u2019\u2019s'")
    for (const quote of ['\u2018', '\u2019', '\u201a', '\u201b']) {
      expect(powerShellString(quote)).toBe(`'${quote}${quote}'`)
    }
  })

  it('never lets hostile text end the string early', () => {
    for (const text of hostile) {
      expect(parseLiteral(powerShellString(text))).toEqual({ value: text, rest: '' })
    }
  })

  it('leaves no expansion to do: single-quoted literals are verbatim', () => {
    expect(powerShellString('$(calc) `n')).toBe("'$(calc) `n'")
  })

  it('sends the script encoded, skipping Windows argument quoting', () => {
    const args = powerShellArgs({ ...request, message: hostile.join('\n') })
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(args[3]).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(Buffer.from(args[3] as string, 'base64').toString('utf16le')).toBe(
      powerShellScript({ ...request, message: hostile.join('\n') }),
    )
  })

  it('defaults to No on a topmost box', () => {
    const script = powerShellScript(request)
    expect(script).toContain("'YesNo', 'Warning', 'Button2'")
    expect(script).toContain('TopMost = $true')
  })

  it('fits a worst-case request under the Windows command line limit', () => {
    const args = powerShellArgs({ ...request, message: "'".repeat(4000) })
    expect(args.join(' ').length).toBeLessThan(32_000)
  })
})

describe('Linux dialog arguments', () => {
  it('turns markup off and defaults to Cancel in zenity', () => {
    const args = zenityArgs(request)
    expect(args).toContain('--no-markup')
    expect(args).toContain('--default-cancel')
    expect(args).toContain(`--timeout=${PROMPT_TIMEOUT_SECONDS}`)
  })

  it('keeps hostile text glued to its own zenity flag', () => {
    for (const text of hostile) {
      const args = zenityArgs({ ...request, message: text })
      expect(args).toContain(`--text=${text}`)
      expect(args.filter((arg) => arg.startsWith('--ok-label='))).toEqual(['--ok-label=Approve'])
    }
  })

  it('escapes kdialog text so markup shows as typed', () => {
    const body = kdialogArgs({ ...request, message: '<img src=x> & <b>bold</b>\nline' }).at(-1)
    expect(body).toBe('<qt>&lt;img src=x&gt; &amp; &lt;b&gt;bold&lt;/b&gt;<br>line</qt>')
  })

  it("keeps kdialog from reading text as a flag", () => {
    const args = kdialogArgs({ ...request, message: '--help' })
    expect(args.at(-1)).toBe('<qt>--help</qt>')
    expect(args).not.toContain('--help')
  })
})

interface Call {
  path: string
  args: string[]
  env: NodeJS.ProcessEnv
}

function fakeHost(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  installed?: string[]
  results?: Partial<RunResult>[]
}) {
  const calls: Call[] = []
  const results = [...(options.results ?? [])]
  const host: PromptHost = {
    platform: options.platform ?? 'linux',
    env: options.env ?? { DISPLAY: ':0' },
    trusted: async (path) => (options.installed ?? []).includes(path),
    exec: async (path, args, env) => {
      calls.push({ path, args, env })
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...results.shift() }
    },
  }
  return { host, calls }
}

const ZENITY = '/usr/bin/zenity'
const KDIALOG = '/usr/bin/kdialog'
const OSASCRIPT = '/usr/bin/osascript'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

describe('systemPrompt on Linux', () => {
  it('prefers zenity', async () => {
    const { host, calls } = fakeHost({ installed: [ZENITY, KDIALOG] })
    expect(await systemPrompt(host).confirm(request)).toBe('confirmed')
    expect(calls.map((call) => call.path)).toEqual([ZENITY])
  })

  it('falls back to kdialog', async () => {
    const { host, calls } = fakeHost({ installed: [KDIALOG] })
    expect(await systemPrompt(host).confirm(request)).toBe('confirmed')
    expect(calls.map((call) => call.path)).toEqual([KDIALOG])
  })

  it('tries kdialog when zenity cannot start, but not when the person said no', async () => {
    const broken = fakeHost({ installed: [ZENITY, KDIALOG], results: [{ code: 255 }, { code: 0 }] })
    expect(await systemPrompt(broken.host).confirm(request)).toBe('confirmed')
    expect(broken.calls).toHaveLength(2)

    const declined = fakeHost({ installed: [ZENITY, KDIALOG], results: [{ code: 1 }] })
    expect(await systemPrompt(declined.host).confirm(request)).toBe('declined')
    expect(declined.calls).toHaveLength(1)
  })

  it('fails closed with neither installed, or with no display', async () => {
    expect(await systemPrompt(fakeHost({ installed: [] }).host).confirm(request)).toBe('unavailable')
    const headless = fakeHost({ env: {}, installed: [ZENITY] })
    expect(await systemPrompt(headless.host).confirm(request)).toBe('unavailable')
    expect(headless.calls).toEqual([])
  })

  it('accepts a Wayland-only session', async () => {
    const { host } = fakeHost({ env: { WAYLAND_DISPLAY: 'wayland-0' }, installed: [ZENITY] })
    expect(await systemPrompt(host).confirm(request)).toBe('confirmed')
  })

  it.each([
    [{ code: 0 }, 'confirmed'],
    [{ code: 1 }, 'declined'],
    [{ code: 5 }, 'timeout'],
    [{ code: 0, timedOut: true }, 'timeout'],
    [{ code: 255 }, 'unavailable'],
    [{ code: null }, 'unavailable'],
    [{ code: 1, stderr: 'cannot open display: :9' }, 'unavailable'],
  ])('reads zenity result %j as %s', async (result, expected) => {
    const { host } = fakeHost({ installed: [ZENITY], results: [result] })
    expect(await systemPrompt(host).confirm(request)).toBe(expected)
  })

  it.each([
    [{ code: 0 }, 'confirmed'],
    [{ code: 1 }, 'declined'],
    [{ code: 0, timedOut: true }, 'timeout'],
    [{ code: 2 }, 'unavailable'],
  ])('reads kdialog result %j as %s', async (result, expected) => {
    const { host } = fakeHost({ installed: [KDIALOG], results: [result] })
    expect(await systemPrompt(host).confirm(request)).toBe(expected)
  })

  it('hands the dialog a clean environment, without anything that loads code', async () => {
    const env = {
      DISPLAY: ':0',
      HOME: '/home/mom',
      PATH: '/tmp/evil:/usr/bin',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/tmp',
      GTK_MODULES: 'evil',
      GTK_PATH: '/tmp',
      QT_PLUGIN_PATH: '/tmp',
      NODE_OPTIONS: '--require /tmp/evil.js',
    }
    const { host, calls } = fakeHost({ env, installed: [ZENITY] })
    await systemPrompt(host).confirm(request)
    expect(calls[0]?.env).toEqual({ DISPLAY: ':0', HOME: '/home/mom', PATH: '/usr/bin:/bin' })
  })

  it('turns a host failure into a refusal, never a yes', async () => {
    const { host } = fakeHost({ installed: [ZENITY] })
    host.exec = () => Promise.reject(new Error('spawn failed'))
    expect(await systemPrompt(host).confirm(request)).toBe('unavailable')
  })
})

describe('systemPrompt on macOS', () => {
  const platform = 'darwin' as const

  it('uses the fixed osascript path and accepts only the confirm button', async () => {
    const yes = fakeHost({ platform, installed: [OSASCRIPT], results: [{ stdout: 'Approve\n' }] })
    expect(await systemPrompt(yes.host).confirm(request)).toBe('confirmed')
    expect(yes.calls[0]?.path).toBe(OSASCRIPT)
    expect(yes.calls[0]?.env.PATH).toBe('/usr/bin:/bin')

    const odd = fakeHost({ platform, installed: [OSASCRIPT], results: [{ stdout: 'Approve anyway\n' }] })
    expect(await systemPrompt(odd.host).confirm(request)).toBe('declined')
  })

  it('tells Cancel, a timeout, and a broken dialog apart', async () => {
    const read = (result: Partial<RunResult>) =>
      systemPrompt(fakeHost({ platform, installed: [OSASCRIPT], results: [result] }).host).confirm(request)
    expect(await read({ code: 1, stderr: 'execution error: User canceled. (-128)' })).toBe('declined')
    expect(await read({ stdout: 'timeout\n' })).toBe('timeout')
    expect(await read({ code: 1, stderr: 'execution error: No user interaction allowed. (-1713)' })).toBe('unavailable')
    expect(await read({ timedOut: true })).toBe('timeout')
  })

  it('fails closed without osascript', async () => {
    expect(await systemPrompt(fakeHost({ platform }).host).confirm(request)).toBe('unavailable')
  })

  it('reports OS auth as not available yet', async () => {
    expect(await systemPrompt(fakeHost({ platform }).host).authenticate('x')).toBe('unsupported')
  })
})

describe('systemPrompt on Windows', () => {
  const platform = 'win32' as const

  it('uses the fixed PowerShell path, ignoring an inherited SystemRoot', async () => {
    const env = { SystemRoot: 'C:\\evil', USERPROFILE: 'C:\\Users\\Mom', PSModulePath: 'C:\\evil' }
    const { host, calls } = fakeHost({ platform, env, installed: [POWERSHELL], results: [{ stdout: 'Yes' }] })
    expect(await systemPrompt(host).confirm(request)).toBe('confirmed')
    expect(calls[0]?.path).toBe(POWERSHELL)
    expect(calls[0]?.env).toEqual({ SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Mom' })
  })

  it('accepts only an exact Yes', async () => {
    const read = (result: Partial<RunResult>) =>
      systemPrompt(fakeHost({ platform, installed: [POWERSHELL], results: [result] }).host).confirm(request)
    expect(await read({ stdout: 'No' })).toBe('declined')
    expect(await read({ stdout: 'Yes, but' })).toBe('declined')
    expect(await read({ code: 1 })).toBe('unavailable')
    expect(await read({ timedOut: true })).toBe('timeout')
  })

  it('fails closed without PowerShell, and has no OS auth yet', async () => {
    const { host } = fakeHost({ platform })
    expect(await systemPrompt(host).confirm(request)).toBe('unavailable')
    expect(await systemPrompt(host).authenticate('x')).toBe('unsupported')
  })
})

describe('unknown platforms', () => {
  it('fail closed', async () => {
    const { host } = fakeHost({ platform: 'freebsd', installed: [ZENITY] })
    expect(await systemPrompt(host).confirm(request)).toBe('unavailable')
    expect(await systemPrompt(host).authenticate('x')).toBe('unsupported')
  })
})

describe('Linux OS authentication', () => {
  const PKEXEC = '/usr/bin/pkexec'
  const TRUE = '/usr/bin/true'

  it('runs a fixed no-op through pkexec, with no text agent to answer on stdin', async () => {
    const { host, calls } = fakeHost({ installed: [PKEXEC, TRUE] })
    expect(await systemPrompt(host).authenticate('x')).toBe('verified')
    expect(calls[0]).toMatchObject({ path: PKEXEC, args: ['--disable-internal-agent', TRUE] })
  })

  it('reports no polkit as unsupported rather than guessing', async () => {
    expect(await systemPrompt(fakeHost({ installed: [] }).host).authenticate('x')).toBe('unsupported')
  })

  it.each([
    [{ code: 126 }, 'declined'],
    [{ code: 127 }, 'failed'],
    [{ code: 1 }, 'failed'],
    [{ code: 0, timedOut: true }, 'timeout'],
  ])('reads pkexec result %j as %s', async (result, expected) => {
    const { host } = fakeHost({ installed: [PKEXEC, TRUE], results: [result] })
    expect(await systemPrompt(host).authenticate('x')).toBe(expected)
  })

  it('treats a host failure as failed', async () => {
    const { host } = fakeHost({ installed: [PKEXEC, TRUE] })
    host.exec = vi.fn(() => Promise.reject(new Error('spawn failed')))
    expect(await systemPrompt(host).authenticate('x')).toBe('failed')
  })
})
