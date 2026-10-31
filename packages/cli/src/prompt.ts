import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

export interface PromptRequest {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
}

export type PromptOutcome = 'confirmed' | 'declined' | 'timeout' | 'unavailable'
export type AuthOutcome = 'verified' | 'declined' | 'timeout' | 'failed' | 'unsupported'

/** Something outside this process that a human answers. Only `confirmed` and `verified` ever allow anything. */
export interface PromptProvider {
  confirm(request: PromptRequest): Promise<PromptOutcome>
  /** The OS's own check of the user, for sensitive decisions. `unsupported` means this platform has none yet. */
  authenticate(reason: string): Promise<AuthOutcome>
}

export const PROMPT_TIMEOUT_SECONDS = 120
/** The dialogs time themselves out; this is the backstop for one that hangs. */
const KILL_AFTER_MS = (PROMPT_TIMEOUT_SECONDS + 5) * 1000

// A bot controls PATH and SystemRoot for any command it runs, so nothing here is
// looked up through them. A fake `zenity` first on PATH must not be able to say yes.
const OSASCRIPT = '/usr/bin/osascript'
const ZENITY = ['/usr/bin/zenity', '/bin/zenity', '/run/current-system/sw/bin/zenity']
const KDIALOG = ['/usr/bin/kdialog', '/bin/kdialog', '/run/current-system/sw/bin/kdialog']
const PKEXEC = ['/usr/bin/pkexec', '/bin/pkexec', '/run/wrappers/bin/pkexec']
const TRUE = ['/usr/bin/true', '/bin/true', '/run/current-system/sw/bin/true']
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Everything a GUI toolkit needs and nothing that can load code, such as LD_PRELOAD or GTK_MODULES. */
const GUI_ENV = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'LANG',
  'LC_ALL',
]

export function appleScriptString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** PowerShell treats the typographic quotes as `'` too, so they need doubling just the same. */
export function powerShellString(text: string): string {
  return `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`
}

export function osascriptArgs(request: PromptRequest): string[] {
  const cancel = appleScriptString(request.cancelLabel)
  const confirm = appleScriptString(request.confirmLabel)
  const lines = [
    `set answer to display dialog ${appleScriptString(request.message)}` +
      ` with title ${appleScriptString(request.title)}` +
      ` buttons {${cancel}, ${confirm}} default button ${cancel} cancel button ${cancel}` +
      ` with icon caution giving up after ${PROMPT_TIMEOUT_SECONDS}`,
    'if gave up of answer then return "timeout"',
    'return button returned of answer',
  ]
  return lines.flatMap((line) => ['-e', line])
}

/** `--no-markup` because zenity otherwise renders Pango markup, which could hide part of a request. */
export function zenityArgs(request: PromptRequest): string[] {
  return [
    '--question',
    '--no-markup',
    '--default-cancel',
    '--width=560',
    `--timeout=${PROMPT_TIMEOUT_SECONDS}`,
    `--title=${request.title}`,
    `--text=${request.message}`,
    `--ok-label=${request.confirmLabel}`,
    `--cancel-label=${request.cancelLabel}`,
  ]
}

/** Forces rich text with `<qt>` and escapes everything, because kdialog guesses at HTML otherwise. */
export function kdialogArgs(request: PromptRequest): string[] {
  const body = request.message
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', '<br>')
  return [
    '--title',
    request.title,
    '--yes-label',
    request.confirmLabel,
    '--no-label',
    request.cancelLabel,
    '--warningyesno',
    `<qt>${body}</qt>`,
  ]
}

export function powerShellScript(request: PromptRequest): string {
  const message = powerShellString(`${request.message}\n\nYes: ${request.confirmLabel}\nNo: ${request.cancelLabel}`)
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    `$answer = [System.Windows.Forms.MessageBox]::Show($owner, ${message}, ${powerShellString(request.title)}, 'YesNo', 'Warning', 'Button2')`,
    '[Console]::Out.Write($answer.ToString())',
  ].join('\n')
}

/** Encoded, so the text never meets Windows argument quoting at all. */
export function powerShellArgs(request: PromptRequest): string[] {
  const encoded = Buffer.from(powerShellScript(request), 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** The operating system, as far as the prompt code sees it. Tests replace this. */
export interface PromptHost {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** True if `path` is an executable a non-root process couldn't have swapped out. */
  trusted(path: string): Promise<boolean>
  exec(path: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult>
}

async function firstTrusted(host: PromptHost, paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await host.trusted(path)) return path
  }
  return undefined
}

function guiEnv(host: PromptHost): NodeJS.ProcessEnv {
  const picked = GUI_ENV.flatMap((name) => {
    const value = host.env[name]
    return value === undefined ? [] : [[name, value]]
  })
  return { ...Object.fromEntries(picked), PATH: '/usr/bin:/bin' }
}

async function macConfirm(host: PromptHost, request: PromptRequest): Promise<PromptOutcome> {
  if (!(await host.trusted(OSASCRIPT))) return 'unavailable'
  const result = await host.exec(OSASCRIPT, osascriptArgs(request), guiEnv(host))
  if (result.timedOut) return 'timeout'
  if (result.code === 0) {
    const answer = result.stdout.trim()
    if (answer === request.confirmLabel) return 'confirmed'
    return answer === 'timeout' ? 'timeout' : 'declined'
  }
  // -128 is the Cancel button. Anything else is osascript failing to show a dialog.
  return result.stderr.includes('(-128)') ? 'declined' : 'unavailable'
}

function readZenity(result: RunResult): PromptOutcome {
  if (result.timedOut || result.code === 5) return 'timeout'
  if (result.code === 0) return 'confirmed'
  if (result.code === 1) return result.stderr.includes('cannot open display') ? 'unavailable' : 'declined'
  return 'unavailable'
}

function readKdialog(result: RunResult): PromptOutcome {
  if (result.timedOut) return 'timeout'
  if (result.code === 0) return 'confirmed'
  return result.code === 1 ? 'declined' : 'unavailable'
}

async function linuxConfirm(host: PromptHost, request: PromptRequest): Promise<PromptOutcome> {
  if (!host.env.DISPLAY && !host.env.WAYLAND_DISPLAY) return 'unavailable'
  const zenity = await firstTrusted(host, ZENITY)
  if (zenity) {
    const outcome = readZenity(await host.exec(zenity, zenityArgs(request), guiEnv(host)))
    if (outcome !== 'unavailable') return outcome
  }
  const kdialog = await firstTrusted(host, KDIALOG)
  if (!kdialog) return 'unavailable'
  return readKdialog(await host.exec(kdialog, kdialogArgs(request), guiEnv(host)))
}

async function windowsConfirm(host: PromptHost, request: PromptRequest): Promise<PromptOutcome> {
  if (!(await host.trusted(POWERSHELL))) return 'unavailable'
  // The real values: an inherited SystemRoot is the bot's to choose.
  const env = { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', USERPROFILE: host.env.USERPROFILE }
  const result = await host.exec(POWERSHELL, powerShellArgs(request), env)
  if (result.timedOut) return 'timeout'
  if (result.code !== 0) return 'unavailable'
  return result.stdout.trim() === 'Yes' ? 'confirmed' : 'declined'
}

/** `pkexec` runs a no-op as root, purely to make polkit ask the user to prove who they are. */
async function linuxAuthenticate(host: PromptHost): Promise<AuthOutcome> {
  const pkexec = await firstTrusted(host, PKEXEC)
  const noop = await firstTrusted(host, TRUE)
  if (!pkexec || !noop) return 'unsupported'
  const result = await host.exec(pkexec, ['--disable-internal-agent', noop], guiEnv(host))
  if (result.timedOut) return 'timeout'
  if (result.code === 0) return 'verified'
  return result.code === 126 ? 'declined' : 'failed'
}

async function promptOnThisOs(host: PromptHost, request: PromptRequest): Promise<PromptOutcome> {
  if (host.platform === 'darwin') return macConfirm(host, request)
  if (host.platform === 'linux') return linuxConfirm(host, request)
  if (host.platform === 'win32') return windowsConfirm(host, request)
  return 'unavailable'
}

/** The provider every real run uses. Any failure here is a refusal, never a yes. */
export function systemPrompt(host: PromptHost): PromptProvider {
  return {
    confirm: (request) => promptOnThisOs(host, request).catch(() => 'unavailable' as const),
    // macOS LocalAuthentication and Windows Hello aren't wired up yet: see the README.
    authenticate: async () => {
      if (host.platform !== 'linux') return 'unsupported'
      return linuxAuthenticate(host).catch(() => 'failed' as const)
    },
  }
}

async function isTrustedExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    return process.platform === 'win32' || (info.uid === 0 && (info.mode & 0o022) === 0)
  } catch {
    return false
  }
}

function execDialog(path: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    // stdin is closed: nothing a bot pipes into `trustline` can reach a dialog.
    const child = spawn(path, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, KILL_AFTER_MS)
    child.stdout.on('data', (chunk) => (stdout = `${stdout}${chunk}`.slice(-4096)))
    child.stderr.on('data', (chunk) => (stderr = `${stderr}${chunk}`.slice(-4096)))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

export function hostFor(env: NodeJS.ProcessEnv): PromptHost {
  return { platform: process.platform, env, trusted: isTrustedExecutable, exec: execDialog }
}
