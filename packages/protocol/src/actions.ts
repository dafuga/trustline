import { z } from 'zod'

/** Never auto-approved. No grant can name these, and the gate has no path that would honor one. */
export const NEVER_AUTO_CATEGORIES = ['payments', 'sends', 'deletes', 'installs', 'settings'] as const
export const CATEGORIES = [...NEVER_AUTO_CATEGORIES, 'other'] as const

/** The helper's own label on free text. It is shown to the person and decides nothing. */
export const Category = z.enum(CATEGORIES)
export type Category = z.infer<typeof Category>

export const MAX_INSTRUCTION_LENGTH = 4000
const MAX_FOLDER_LENGTH = 1024
const MAX_URL_LENGTH = 2048

// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

function isExactFolder(path: string): boolean {
  if (UNSAFE_TEXT.test(path)) return false
  const windows = /^[A-Za-z]:\\/.test(path)
  if (!windows && !path.startsWith('/')) return false
  const parts = (windows ? path.slice(3) : path.slice(1)).split(windows ? /[\\/]/ : '/')
  if (parts.length === 1 && parts[0] === '') return true
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/** Absolute, with no `..` or other spelling that could pass as a different folder under exact matching. */
const Folder = z
  .string()
  .max(MAX_FOLDER_LENGTH)
  .refine(isExactFolder, 'Folder must be an absolute path with no "..", "." or trailing slash')

function isCanonicalHttps(text: string): boolean {
  if (UNSAFE_TEXT.test(text)) return false
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  return url.protocol === 'https:' && !url.username && !url.password && url.href === text
}

/** Must already be in canonical form, so two spellings of one address can't differ under exact matching. */
const HttpsUrl = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine(isCanonicalHttps, 'URL must be a canonical https:// address with no credentials')

/** Normalizes what someone typed. Validity is still `Action`'s and `Grant`'s call. */
export function canonicalUrl(text: string): string {
  try {
    return new URL(text).href
  } catch {
    return text
  }
}

/** Everything a helper can ask for. The list is closed: an unknown `kind` doesn't parse. */
export const Action = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('check_status') }),
  z.strictObject({ kind: z.literal('list_files'), folder: Folder }),
  z.strictObject({ kind: z.literal('open_url'), url: HttpsUrl }),
  z.strictObject({
    kind: z.literal('instruction'),
    category: Category,
    text: z.string().min(1).max(MAX_INSTRUCTION_LENGTH),
  }),
])
export type Action = z.infer<typeof Action>

/** The read-only actions a grant can name. `instruction` is absent: free text is never auto-approved. */
export const GRANTABLE_ACTIONS = ['check_status', 'list_files', 'open_url'] as const
export type GrantableAction = (typeof GRANTABLE_ACTIONS)[number]

/** One person-given permission, scoped as tightly as the action allows. */
export const Grant = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('check_status') }),
  z.strictObject({ action: z.literal('list_files'), folder: Folder }),
  z.strictObject({ action: z.literal('open_url'), url: HttpsUrl }),
])
export type Grant = z.infer<typeof Grant>

export function isGrantableAction(name: string): name is GrantableAction {
  return (GRANTABLE_ACTIONS as readonly string[]).includes(name)
}

/** True for anything a grant must refuse outright, as opposed to a name nobody knows. */
export function isNeverAuto(name: string): boolean {
  return name === 'instruction' || (CATEGORIES as readonly string[]).includes(name)
}

export function sameGrant(a: Grant, b: Grant): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Keeps only well-formed grants, whatever was on disk. Use this on anything
 * loaded: a hand-edited `payments` or an unscoped `list_files` simply vanishes.
 */
export function parseGrants(raw: unknown): Grant[] {
  if (!Array.isArray(raw)) return []
  const grants = raw.flatMap((entry) => {
    const parsed = Grant.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
  return grants.filter((grant, index) => grants.findIndex((other) => sameGrant(other, grant)) === index)
}

/** The wording shown to the person, in the dialog and the inbox alike. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'check_status':
      return 'Check whether this assistant is online and working'
    case 'list_files':
      return `List the file names in this folder: ${action.folder}`
    case 'open_url':
      return `Open this web page: ${action.url}`
    case 'instruction':
      return action.text
  }
}

export function describeGrant(grant: Grant): string {
  switch (grant.action) {
    case 'check_status':
      return 'check_status'
    case 'list_files':
      return `list_files ${grant.folder}`
    case 'open_url':
      return `open_url ${grant.url}`
  }
}
