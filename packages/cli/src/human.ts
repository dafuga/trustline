import { describeAction, describeGrant, type Action, type Grant } from '@dafuga/trustline-protocol'
import type { Context } from './context.js'
import { CliError, ExitCode } from './errors.js'
import type { InboxItem, Peer } from './home.js'
import { sanitize } from './output.js'
import { PROMPT_TIMEOUT_SECONDS, type AuthOutcome, type PromptOutcome, type PromptRequest } from './prompt.js'

/** How the OS check went for a decision that went ahead. */
export type LocalAuth = 'verified' | 'unsupported' | 'not_required'

export interface HumanCheck {
  command: 'approve' | 'deny' | 'grant' | 'ungrant' | 'pair confirm'
  prompt: PromptRequest
  /** Also ask the OS to verify the user, where it can. */
  sensitive: boolean
  /** Identifies the decision in the log if it doesn't go through. */
  subject: Record<string, unknown>
}

const NOTHING_CHANGED = 'Nothing was changed.'

function promptFailure(outcome: Exclude<PromptOutcome, 'confirmed'>): CliError {
  switch (outcome) {
    case 'declined':
      return new CliError(ExitCode.NOT_CONFIRMED, 'confirmation_declined', `This was not confirmed. ${NOTHING_CHANGED}`)
    case 'timeout':
      return new CliError(
        ExitCode.NOT_CONFIRMED,
        'confirmation_timeout',
        `Nobody answered the confirmation window within ${PROMPT_TIMEOUT_SECONDS} seconds. ${NOTHING_CHANGED}`,
      )
    case 'unavailable':
      return new CliError(
        ExitCode.PROMPT_UNAVAILABLE,
        'prompt_unavailable',
        `Trustline could not show a confirmation window on this computer. ${NOTHING_CHANGED} ` +
          'This needs a desktop session (on Linux, with zenity or kdialog installed). ' +
          'There is deliberately no way to do this from the command line alone.',
      )
  }
}

function authFailure(outcome: Exclude<AuthOutcome, 'verified' | 'unsupported'>): CliError {
  switch (outcome) {
    case 'declined':
      return new CliError(ExitCode.NOT_CONFIRMED, 'local_auth_declined', `The system password check was cancelled. ${NOTHING_CHANGED}`)
    case 'timeout':
      return new CliError(ExitCode.NOT_CONFIRMED, 'confirmation_timeout', `The system password check timed out. ${NOTHING_CHANGED}`)
    case 'failed':
      return new CliError(ExitCode.NOT_CONFIRMED, 'local_auth_failed', `The system password check did not pass. ${NOTHING_CHANGED}`)
  }
}

async function askPerson(context: Context, prompt: PromptRequest): Promise<PromptOutcome> {
  try {
    return await context.prompt.confirm(prompt)
  } catch {
    return 'unavailable'
  }
}

async function askOs(context: Context, reason: string): Promise<AuthOutcome> {
  try {
    return await context.prompt.authenticate(reason)
  } catch {
    return 'failed'
  }
}

/**
 * The only path to a human-only decision. It asks a process outside the CLI,
 * so no argument or stdin can stand in for the answer, and anything short of
 * an explicit yes throws. Call it outside `home.locked`, since a person can
 * take longer to answer than the lock lasts, and re-check state afterwards.
 */
export async function requireHuman(context: Context, check: HumanCheck): Promise<LocalAuth> {
  context.notify('Waiting for an answer in the Trustline window on this computer...')
  const refuse = async (error: CliError): Promise<never> => {
    await context.home.locked(() =>
      context.home.appendLog(context.now(), 'confirmation.refused', {
        command: check.command,
        reason: error.code,
        ...check.subject,
      }),
    )
    throw error
  }

  const outcome = await askPerson(context, check.prompt)
  if (outcome !== 'confirmed') {
    const known = outcome === 'declined' || outcome === 'timeout' ? outcome : 'unavailable'
    return refuse(promptFailure(known))
  }
  if (!check.sensitive) return 'not_required'

  const auth = await askOs(context, check.prompt.title)
  if (auth === 'verified' || auth === 'unsupported') return auth
  const known = auth === 'declined' || auth === 'timeout' ? auth : 'failed'
  return refuse(authFailure(known))
}

const SAFETY_LABEL = 'Pairing safety string'

function helperLines(peer: Peer): string[] {
  return [`Helper: ${peer.name}`, `${SAFETY_LABEL}: ${peer.safetyString}`]
}

function labelLines(action: Action): string[] {
  return action.kind === 'instruction' ? [`Helper's label: ${action.category} (set by the helper, not checked)`] : []
}

/** Trusted lines come first, so a long request can't push them out of view or pose as them. */
function requestMessage(item: InboxItem, peer: Peer, decision: 'approved' | 'denied', sensitive: boolean): string {
  const verb = decision === 'approved' ? 'APPROVE' : 'DENY'
  return sanitize(
    [
      `You are about to ${verb} a request from ${peer.name}.`,
      '',
      ...helperLines(peer),
      ...labelLines(item.action),
      '',
      ...(decision === 'approved' && sensitive
        ? [
            'This is free text. It can ask for anything, including money, messages, or passwords, and Trustline cannot tell what it would do.',
            '',
          ]
        : []),
      ...(decision === 'approved' ? ['If anyone is rushing you or telling you what to click, choose Cancel.', ''] : []),
      `Exact request (${item.action.kind}):`,
      '--------',
      describeAction(item.action),
      '--------',
    ].join('\n'),
  )
}

export function requestCheck(item: InboxItem, peer: Peer, decision: 'approved' | 'denied', sensitive: boolean): HumanCheck {
  const approving = decision === 'approved'
  return {
    command: approving ? 'approve' : 'deny',
    sensitive: approving && sensitive,
    subject: { requestId: item.id, helperId: peer.id },
    prompt: {
      title: `Trustline: ${approving ? 'approve' : 'deny'} this request?`,
      message: requestMessage(item, peer, decision, sensitive),
      confirmLabel: approving ? 'Approve' : 'Deny request',
      cancelLabel: 'Cancel',
    },
  }
}

export function grantCheck(peer: Peer, grant: Grant, granted: boolean): HumanCheck {
  const scope = describeGrant(grant)
  return {
    command: granted ? 'grant' : 'ungrant',
    // Only widening is a settings change worth the extra step. Taking a grant away is always safe.
    sensitive: granted,
    subject: { helperId: peer.id, grant },
    prompt: {
      title: `Trustline: ${granted ? 'allow' : 'stop allowing'} this without asking?`,
      message: sanitize(
        [
          granted
            ? `You are about to let ${peer.name} do this WITHOUT asking you each time:`
            : `You are about to make ${peer.name} ask you each time for this again:`,
          '',
          `  ${scope}`,
          '',
          ...helperLines(peer),
          ...(granted ? ['', 'If anyone is rushing you or telling you what to click, choose Cancel.'] : []),
        ].join('\n'),
      ),
      confirmLabel: granted ? 'Allow' : 'Stop allowing',
      cancelLabel: 'Cancel',
    },
  }
}

export function pairingCheck(peerName: string, safetyString: string, roomId: string): HumanCheck {
  return {
    command: 'pair confirm',
    sensitive: false,
    subject: { roomId },
    prompt: {
      title: 'Trustline: confirm this pairing?',
      message: sanitize(
        [
          `You are about to pair with someone calling themselves ${peerName}.`,
          '',
          `Helper or person: ${peerName}`,
          `${SAFETY_LABEL}: ${safetyString}`,
          '',
          'Confirm only if they read this exact string out to you, on a call or in person, and you know who they are.',
          'Real tech support, banks, and government agencies never ask you to do this. If anyone is rushing you, choose Cancel.',
        ].join('\n'),
      ),
      confirmLabel: 'Confirm pairing',
      cancelLabel: 'Cancel',
    },
  }
}
