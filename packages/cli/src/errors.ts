/** Stable, documented process exit codes. Add new ones; never renumber. */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  RELAY_UNAVAILABLE: 4,
  PAIRING_FAILED: 5,
  SAFETY_MISMATCH: 6,
  REVOKED: 7,
  CONFLICT: 8,
  LOG_TAMPERED: 9,
  NOT_CONFIRMED: 10,
  PROMPT_UNAVAILABLE: 11,
} as const
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    /** Stable machine-readable identifier, reported in `--json` output. */
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'CliError'
  }
}
