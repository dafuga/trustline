import { parseArgs, type ParseArgsConfig } from 'node:util'
import { ProtocolError } from '@dafuga/trustline-protocol'
import { z } from 'zod'
import { startDevRelay } from '@dafuga/trustline-relay'
import { logShow, logVerify, revoke, setGrant, status } from './commands/admin.js'
import { pairCancel, pairConfirm, pairJoin, pairStart, pairStatus } from './commands/pair.js'
import { approve, deny, inbox, send } from './commands/requests.js'
import { loadContext, type Context } from './context.js'
import { CliError, ExitCode } from './errors.js'
import { hostFor, systemPrompt, type PromptProvider } from './prompt.js'

export interface CommandResult {
  data: Record<string, unknown>
  text: string
}

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
}

type Values = Record<string, string | boolean | undefined>
type Options = NonNullable<ParseArgsConfig['options']>

interface Command {
  options?: Options
  /** Exact positional count, or a minimum when `variadic` is set. */
  positionals?: number
  variadic?: boolean
  usage: string
  run: (context: Context, values: Values, positionals: string[]) => Promise<CommandResult>
}

const wait: Options = { wait: { type: 'string' } }
const grantScope: Options = { folder: { type: 'string' }, url: { type: 'string' } }

function seconds(value: unknown): number {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new CliError(ExitCode.USAGE, 'usage', 'Expected a number of seconds')
  return parsed
}

const COMMANDS: Record<string, Command> = {
  'pair start': {
    options: { 'ttl-seconds': { type: 'string' } },
    usage: 'pair start [--name <you>] [--ttl-seconds <n>]',
    run: (context, values) => pairStart(context, { ttlSeconds: seconds(values['ttl-seconds']) || undefined }),
  },
  'pair join': {
    options: wait,
    positionals: 1,
    usage: 'pair join <code> [--name <you>] [--wait <seconds>]',
    run: (context, values, [code]) => pairJoin(context, { code: code as string, wait: seconds(values.wait) }),
  },
  'pair status': {
    options: wait,
    usage: 'pair status [--wait <seconds>]',
    run: (context, values) => pairStatus(context, { wait: seconds(values.wait) }),
  },
  'pair confirm': {
    options: { ...wait, label: { type: 'string' } },
    positionals: 1,
    usage: 'pair confirm <safety-string> [--label <what you call them>] [--wait <seconds>]',
    run: (context, values, [safetyString]) =>
      pairConfirm(context, {
        safetyString: safetyString as string,
        wait: seconds(values.wait),
        label: values.label as string | undefined,
      }),
  },
  'pair cancel': { usage: 'pair cancel', run: (context) => pairCancel(context) },
  status: {
    options: { offline: { type: 'boolean' } },
    usage: 'status [--offline]',
    run: (context, values) => status(context, { offline: values.offline === true }),
  },
  inbox: {
    options: { offline: { type: 'boolean' }, all: { type: 'boolean' }, state: { type: 'string' } },
    usage: 'inbox [--all | --state <pending|approved|denied|expired|revoked>] [--offline]',
    run: (context, values) =>
      inbox(context, {
        all: values.all === true,
        state: values.state as string | undefined,
        offline: values.offline === true,
      }),
  },
  approve: { positionals: 1, usage: 'approve <id>', run: (context, _values, [id]) => approve(context, id as string) },
  deny: { positionals: 1, usage: 'deny <id>', run: (context, _values, [id]) => deny(context, id as string) },
  log: {
    options: { limit: { type: 'string' } },
    usage: 'log [--limit <n>]',
    run: (context, values) => logShow(context, { limit: seconds(values.limit) || undefined }),
  },
  'log verify': { usage: 'log verify', run: (context) => logVerify(context) },
  revoke: {
    options: { all: { type: 'boolean' } },
    positionals: 0,
    variadic: true,
    usage: 'revoke <helper> | revoke --all',
    run: (context, values, helpers) => {
      if (helpers.length > 1) throw new CliError(ExitCode.USAGE, 'usage', 'Revoke one helper at a time, or use --all')
      return revoke(context, { helper: helpers[0], all: values.all === true })
    },
  },
  grant: {
    options: grantScope,
    positionals: 2,
    usage: 'grant <helper> check_status | list_files --folder <path> | open_url --url <https url>',
    run: (context, values, [helper, action]) =>
      setGrant(context, {
        helper: helper as string,
        action: action as string,
        folder: values.folder as string | undefined,
        url: values.url as string | undefined,
        granted: true,
      }),
  },
  ungrant: {
    options: grantScope,
    positionals: 2,
    usage: 'ungrant <helper> <action> [--folder <path>] [--url <https url>]',
    run: (context, values, [helper, action]) =>
      setGrant(context, {
        helper: helper as string,
        action: action as string,
        folder: values.folder as string | undefined,
        url: values.url as string | undefined,
        granted: false,
      }),
  },
  send: {
    options: { ...grantScope, to: { type: 'string' }, category: { type: 'string' }, action: { type: 'string' } },
    variadic: true,
    usage: 'send [--to <person>] [--category <category>] <instruction...> | send --action <action> [--folder <path>] [--url <url>]',
    run: (context, values, words) =>
      send(context, {
        words,
        to: values.to as string | undefined,
        category: values.category as string | undefined,
        action: values.action as string | undefined,
        folder: values.folder as string | undefined,
        url: values.url as string | undefined,
      }),
  },
}
COMMANDS.request = { ...(COMMANDS.send as Command), usage: 'request (alias of send)' }

const GLOBAL_OPTIONS: Options = {
  json: { type: 'boolean' },
  relay: { type: 'string' },
  name: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
}

function helpText(): string {
  const lines = Object.values(COMMANDS).map((command) => `  trustline ${command.usage}`)
  return [
    'Usage:',
    ...lines,
    '  trustline relay dev [--port <n>] [--host <addr>]',
    '',
    'approve, deny, grant, ungrant, and pair confirm open a confirmation window on this computer.',
    'They only ask: a person has to answer that window, and nothing on the command line can.',
    '',
    'Global flags: --json  --relay <url>  --help',
    'Environment: TRUSTLINE_HOME (config dir), TRUSTLINE_RELAY_URL',
  ].join('\n')
}

function leadingPositionals(argv: string[]): string[] {
  const words: string[] = []
  for (let i = 0; i < argv.length && words.length < 2; i++) {
    const arg = argv[i] as string
    if (arg === '--relay' || arg === '--name') i++
    else if (!arg.startsWith('-')) words.push(arg)
  }
  return words
}

function findCommand(argv: string[]): { key: string; rest: string[] } {
  const positional = leadingPositionals(argv)
  const [first, second] = positional
  const key = first && second && COMMANDS[`${first} ${second}`] ? `${first} ${second}` : first
  if (!key || !COMMANDS[key]) {
    throw new CliError(ExitCode.USAGE, 'usage', first ? `Unknown command "${first}"` : 'No command given')
  }
  const rest = [...argv]
  for (const word of key.split(' ')) rest.splice(rest.indexOf(word), 1)
  return { key, rest }
}

function parse(command: Command, args: string[]): { values: Values; positionals: string[] } {
  let parsed
  try {
    parsed = parseArgs({
      args,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
    })
  } catch (error) {
    throw new CliError(ExitCode.USAGE, 'usage', `${(error as Error).message}\nUsage: trustline ${command.usage}`)
  }
  const { values, positionals } = parsed
  const expected = command.positionals ?? 0
  const valid = command.variadic ? positionals.length >= expected : positionals.length === expected
  if (!valid) throw new CliError(ExitCode.USAGE, 'usage', `Usage: trustline ${command.usage}`)
  return { values: values as Values, positionals }
}

const RELAY_DEV: Command = {
  options: { port: { type: 'string' }, host: { type: 'string' } },
  usage: 'relay dev [--port <n>] [--host <addr>]',
  run: () => Promise.reject(new Error('relay dev is handled by run()')),
}

async function runRelayDev(args: string[], io: Io, json: boolean): Promise<number> {
  const { values } = parse(RELAY_DEV, args)
  const relay = await startDevRelay({
    port: values.port === undefined ? undefined : Number(values.port),
    host: values.host as string | undefined,
  })
  io.out(
    json
      ? JSON.stringify({ ok: true, url: relay.url, port: relay.port })
      : `Dev relay listening on ${relay.url}\nPoint the CLI at it: export TRUSTLINE_RELAY_URL=${relay.url}`,
  )
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await relay.close()
  return ExitCode.OK
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (error instanceof z.ZodError) {
    return new CliError(ExitCode.USAGE, 'invalid_input', error.issues[0]?.message ?? 'Invalid input')
  }
  if (error instanceof ProtocolError) {
    const exit = error.code === 'invalid_code' ? ExitCode.PAIRING_FAILED : ExitCode.ERROR
    return new CliError(exit, error.code, error.message)
  }
  return new CliError(ExitCode.ERROR, 'internal', error instanceof Error ? error.message : String(error))
}

/**
 * For tests only, and reachable only by calling `run` from code in this
 * process. `bin.ts` never passes it, and on purpose no flag, environment
 * variable, or file can: that would be a bypass any bot could type.
 */
export interface TestOverrides {
  prompt?: PromptProvider
}

/** Runs one CLI invocation and returns its exit code. All state comes from `env`. */
export async function run(argv: string[], env: NodeJS.ProcessEnv, io: Io, overrides: TestOverrides = {}): Promise<number> {
  const json = argv.includes('--json')
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.out(helpText())
      return ExitCode.OK
    }
    if (argv[0] === 'relay' && argv[1] === 'dev') return await runRelayDev(argv.slice(2), io, json)
    const { key, rest } = findCommand(argv)
    const command = COMMANDS[key] as Command
    const { values, positionals } = parse(command, rest)
    const flags = { relay: values.relay as string | undefined, name: values.name as string | undefined }
    const prompt = overrides.prompt ?? systemPrompt(hostFor(env))
    const context = await loadContext(env, flags, { prompt, notify: io.err })
    const result = await command.run(context, values, positionals)
    io.out(json ? JSON.stringify({ ok: true, ...result.data }) : result.text)
    return ExitCode.OK
  } catch (error) {
    const failure = toCliError(error)
    if (json) {
      const { code, message, exitCode, details } = failure
      io.out(JSON.stringify({ ok: false, error: { code, message, exitCode, ...details } }))
    } else {
      io.err(`Error: ${failure.message}`)
    }
    return failure.exitCode
  }
}
