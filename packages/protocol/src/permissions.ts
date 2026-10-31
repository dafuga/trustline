import { ALWAYS_ASK_CATEGORIES, GRANTABLE_CATEGORIES, type Category } from './messages.js'

const ALWAYS_ASK: readonly Category[] = ALWAYS_ASK_CATEGORIES
const GRANTABLE: readonly Category[] = GRANTABLE_CATEGORIES

export function isAlwaysAsk(category: Category): boolean {
  return ALWAYS_ASK.includes(category)
}

export function isGrantable(category: Category): boolean {
  return GRANTABLE.includes(category)
}

const PATTERNS: Record<(typeof ALWAYS_ASK_CATEGORIES)[number], RegExp> = {
  payments:
    /\b(pay|pays|paid|paying|payment|wire|transfer|bank|credit card|debit|gift ?cards?|bitcoin|crypto|venmo|paypal|zelle|e-?transfer|purchase|buy|invoice|refund|donat\w*|money)\b|\$\s?\d/,
  sends: /\b(send|email|e-mail|text|sms|message|post|share|forward|reply|tweet|dm)\b/,
  deletes: /\b(delete|remove|erase|wipe|trash|rm|uninstall|format|purge|clear)\b/,
  installs:
    /\b(install\w*|download\w*|upgrade|anydesk|teamviewer|rustdesk|remote (access|desktop|support)|extension|plugin|sudo|run (this|the) (command|script))\b/,
  settings:
    /\b(settings?|password|passcode|2fa|two-factor|permissions?|grants?|trustline|preferences|disable|turn off|antivirus|firewall|config\w*)\b/,
}

/**
 * Local, conservative keyword scan. The helper's own label is never enough to
 * lower the bar, because a scammer would simply label a payment "info". This
 * can only ever add categories, so a miss falls back to the helper's label.
 */
export function detectCategories(instruction: string): Category[] {
  const text = instruction
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .toLowerCase()
  return ALWAYS_ASK_CATEGORIES.filter((category) => PATTERNS[category].test(text))
}

export interface GateResult {
  decision: 'auto' | 'ask'
  /** The helper's label plus anything detected locally. */
  categories: Category[]
  /** True when no grant could ever skip approval for this request. */
  alwaysAsk: boolean
}

/**
 * The single permission gate. Ask-only is the default, and a request is only
 * auto-approved when every category it touches is both grantable and granted.
 */
export function evaluateRequest(request: {
  category: Category
  instruction: string
  grants: readonly Category[]
}): GateResult {
  const categories = [...new Set([request.category, ...detectCategories(request.instruction)])]
  const alwaysAsk = categories.some(isAlwaysAsk)
  const auto = !alwaysAsk && categories.every((c) => isGrantable(c) && request.grants.includes(c))
  return { decision: auto ? 'auto' : 'ask', categories, alwaysAsk }
}
