import { run } from '../src/main.js'
import type { AuthOutcome, PromptOutcome, PromptProvider, PromptRequest } from '../src/prompt.js'

export interface Run {
  code: number
  json: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  stdout: string
  stderr: string
}

/** Stands in for the person at the dialog. Only ever passed to `run` in-process. */
export class ScriptedPrompt implements PromptProvider {
  answer: PromptOutcome | Error = 'confirmed'
  auth: AuthOutcome | Error = 'unsupported'
  readonly seen: PromptRequest[] = []
  authCalls = 0

  async confirm(request: PromptRequest): Promise<PromptOutcome> {
    this.seen.push(request)
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }

  async authenticate(): Promise<AuthOutcome> {
    this.authCalls++
    if (this.auth instanceof Error) throw this.auth
    return this.auth
  }

  get last(): PromptRequest {
    return this.seen.at(-1) as PromptRequest
  }

  reset(): void {
    this.answer = 'confirmed'
    this.auth = 'unsupported'
    this.seen.length = 0
    this.authCalls = 0
  }
}

export async function cli(prompt: PromptProvider, home: string, relayUrl: string | null, ...args: string[]): Promise<Run> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TRUSTLINE_HOME: home }
  if (relayUrl) env.TRUSTLINE_RELAY_URL = relayUrl
  let stdout = ''
  let stderr = ''
  const code = await run(
    args,
    env,
    { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) },
    { prompt },
  )
  let json = {}
  try {
    json = JSON.parse(stdout)
  } catch {
    // Text-mode invocation.
  }
  return { code, json, stdout, stderr }
}
