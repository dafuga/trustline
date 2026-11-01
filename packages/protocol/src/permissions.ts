import { Action, parseGrants, type Grant } from './actions.js'

export interface GateResult {
  decision: 'auto' | 'ask'
  /**
   * True when nothing is known about what the request would do. Only the
   * closed list of read-only actions is known; free text can say anything,
   * so its helper-chosen label neither sets nor clears this.
   */
  sensitive: boolean
}

function covers(grant: Grant, action: Action): boolean {
  switch (action.kind) {
    case 'check_status':
      return grant.action === 'check_status'
    case 'list_files':
      return grant.action === 'list_files' && grant.folder === action.folder
    case 'open_url':
      return grant.action === 'open_url' && grant.url === action.url
    case 'instruction':
      return false
  }
}

/**
 * The single permission gate. Ask-only is the default: a request is
 * auto-approved only when it is a read-only action in exactly the scope the
 * person granted. Both inputs are re-checked here, so a caller can't widen it.
 */
export function evaluateRequest(request: { action: unknown; grants: unknown }): GateResult {
  const action = Action.safeParse(request.action)
  if (!action.success || action.data.kind === 'instruction') return { decision: 'ask', sensitive: true }
  const granted = parseGrants(request.grants).some((grant) => covers(grant, action.data))
  return { decision: granted ? 'auto' : 'ask', sensitive: false }
}
