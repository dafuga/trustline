import { describe, expect, it } from 'vitest'
import {
  Action,
  CATEGORIES,
  GRANTABLE_ACTIONS,
  Grant,
  Message,
  NEVER_AUTO_CATEGORIES,
  canonicalUrl,
  describeAction,
  evaluateRequest,
  isGrantableAction,
  isNeverAuto,
  parseGrants,
  type Grant as GrantType,
} from '../src/index.js'

const STATUS = { kind: 'check_status' } as const
const FOLDER = '/Users/mom/Shared'
const URL_OK = 'https://www.weather.gov/'

const everySafeGrant: GrantType[] = [
  { action: 'check_status' },
  { action: 'list_files', folder: FOLDER },
  { action: 'open_url', url: URL_OK },
]

const decide = (action: unknown, grants: unknown = everySafeGrant) => evaluateRequest({ action, grants }).decision

describe('evaluateRequest', () => {
  it('is ask-only by default', () => {
    expect(decide(STATUS, [])).toBe('ask')
    expect(decide({ kind: 'list_files', folder: FOLDER }, [])).toBe('ask')
    expect(decide({ kind: 'open_url', url: URL_OK }, [])).toBe('ask')
  })

  it('auto-approves a read-only action the person granted', () => {
    expect(decide(STATUS)).toBe('auto')
    expect(decide({ kind: 'list_files', folder: FOLDER })).toBe('auto')
    expect(decide({ kind: 'open_url', url: URL_OK })).toBe('auto')
  })

  it('needs a grant for that action, not just any grant', () => {
    expect(decide(STATUS, [{ action: 'list_files', folder: FOLDER }])).toBe('ask')
    expect(decide({ kind: 'open_url', url: URL_OK }, [{ action: 'check_status' }])).toBe('ask')
  })

  it('matches a folder exactly: no parents, children, or traversal', () => {
    for (const folder of ['/Users/mom', '/Users/mom/Shared/private', '/Users/mom/Shared2', '/users/mom/shared']) {
      expect(decide({ kind: 'list_files', folder }), folder).toBe('ask')
    }
    expect(decide({ kind: 'list_files', folder: `${FOLDER}/../Documents` })).toBe('ask')
  })

  it('matches a URL exactly: no other paths, queries, or lookalike hosts', () => {
    for (const url of [
      'https://www.weather.gov/login',
      'https://www.weather.gov/?next=https://evil.example/',
      'https://www.weather.gov.evil.example/',
      'http://www.weather.gov/',
    ]) {
      expect(decide({ kind: 'open_url', url }), url).toBe('ask')
    }
  })

  it('never auto-approves free text, in any category, with every grant', () => {
    for (const category of CATEGORIES) {
      const result = evaluateRequest({ action: { kind: 'instruction', category, text: 'hello' }, grants: everySafeGrant })
      expect(result).toEqual({ decision: 'ask', sensitive: true })
    }
  })

  it("treats free text the same whatever the helper labels it", () => {
    const honest = evaluateRequest({
      action: { kind: 'instruction', category: 'payments', text: 'Buy gift cards' },
      grants: [],
    })
    const disguised = evaluateRequest({
      action: { kind: 'instruction', category: 'other', text: 'Buy gift cards' },
      grants: [],
    })
    expect(disguised).toEqual(honest)
  })

  it('leaves no keyword path into approval: wording never changes the outcome', () => {
    const bland = decide({ kind: 'instruction', category: 'other', text: 'check_status' })
    expect(bland).toBe('ask')
  })

  it('ignores forged grants passed straight to the gate', () => {
    const forged = [...NEVER_AUTO_CATEGORIES, 'other', 'instruction', 'info', { action: 'instruction' }, { action: 'payments' }]
    for (const category of CATEGORIES) {
      expect(decide({ kind: 'instruction', category, text: 'hello' }, forged)).toBe('ask')
    }
    expect(decide(STATUS, forged)).toBe('ask')
  })

  it('asks when given something that is not an action', () => {
    expect(evaluateRequest({ action: { kind: 'wire_money' }, grants: everySafeGrant })).toEqual({
      decision: 'ask',
      sensitive: true,
    })
    expect(decide(null)).toBe('ask')
    expect(decide({ kind: 'check_status', extra: true })).toBe('ask')
  })

  it('reads a structured action as known, and free text as not', () => {
    expect(evaluateRequest({ action: STATUS, grants: [] }).sensitive).toBe(false)
    expect(evaluateRequest({ action: { kind: 'instruction', category: 'other', text: 'x' }, grants: [] }).sensitive).toBe(true)
  })
})

describe('Action schema', () => {
  it('accepts each allowlisted action', () => {
    for (const action of [
      STATUS,
      { kind: 'list_files', folder: FOLDER },
      { kind: 'list_files', folder: 'C:\\Users\\Mom\\Shared' },
      { kind: 'list_files', folder: '/' },
      { kind: 'open_url', url: URL_OK },
      { kind: 'instruction', category: 'other', text: 'hello' },
    ]) {
      expect(Action.safeParse(action).success, JSON.stringify(action)).toBe(true)
    }
  })

  it('rejects unknown action types', () => {
    for (const kind of ['read_screen_summary', 'send_email', 'pay', 'delete_file', 'install', 'change_setting', '', 'CHECK_STATUS']) {
      expect(Action.safeParse({ kind }).success, kind).toBe(false)
    }
  })

  it('rejects extra fields and missing scope', () => {
    expect(Action.safeParse({ kind: 'check_status', note: 'also wire money' }).success).toBe(false)
    expect(Action.safeParse({ kind: 'list_files' }).success).toBe(false)
    expect(Action.safeParse({ kind: 'open_url' }).success).toBe(false)
    expect(Action.safeParse({ kind: 'instruction', text: 'no label' }).success).toBe(false)
  })

  it('rejects the retired low-risk labels', () => {
    expect(Action.safeParse({ kind: 'instruction', category: 'info', text: 'x' }).success).toBe(false)
    expect(Action.safeParse({ kind: 'instruction', category: 'reminders', text: 'x' }).success).toBe(false)
  })

  it('rejects folders that could dodge exact matching', () => {
    for (const folder of [
      'relative/path',
      '~/Documents',
      '/a/../b',
      '/a/./b',
      '/a//b',
      '/a/',
      'C:\\a\\..\\b',
      'C:\\a/../b',
      '/a\nb',
      '/a\u202eb',
      `/${'a'.repeat(2000)}`,
    ]) {
      expect(Action.safeParse({ kind: 'list_files', folder }).success, folder).toBe(false)
    }
  })

  it('rejects URLs that are not plain canonical https', () => {
    for (const url of [
      'http://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@example.com/',
      'https://example.com',
      'HTTPS://EXAMPLE.COM/',
      'https://exam\u0440le.com/',
      'not a url',
      `https://example.com/${'a'.repeat(3000)}`,
    ]) {
      expect(Action.safeParse({ kind: 'open_url', url }).success, url).toBe(false)
    }
  })

  it('normalizes typed URLs into the canonical form', () => {
    expect(canonicalUrl('HTTPS://Example.COM')).toBe('https://example.com/')
    expect(Action.safeParse({ kind: 'open_url', url: canonicalUrl('https://Example.com') }).success).toBe(true)
    expect(canonicalUrl('not a url')).toBe('not a url')
  })

  it('makes an unknown action fail on the wire', () => {
    const request = {
      type: 'request',
      requestId: 'req_0000000000000001',
      createdAt: 1,
      expiresAt: 2,
    }
    expect(Message.safeParse({ ...request, action: STATUS }).success).toBe(true)
    expect(Message.safeParse({ ...request, action: { kind: 'wire_money' } }).success).toBe(false)
    expect(Message.safeParse({ ...request, instruction: 'old format', category: 'info' }).success).toBe(false)
  })

  it('describes free text verbatim', () => {
    const text = 'Line one\nLine "two"'
    expect(describeAction({ kind: 'instruction', category: 'other', text })).toBe(text)
    expect(describeAction({ kind: 'open_url', url: URL_OK })).toContain(URL_OK)
    expect(describeAction({ kind: 'list_files', folder: FOLDER })).toContain(FOLDER)
  })
})

describe('Grant schema', () => {
  it('holds only the read-only actions', () => {
    expect([...GRANTABLE_ACTIONS].sort()).toEqual(['check_status', 'list_files', 'open_url'])
    expect(GRANTABLE_ACTIONS).not.toContain('instruction')
    for (const name of GRANTABLE_ACTIONS) {
      expect(isGrantableAction(name)).toBe(true)
      expect(isNeverAuto(name)).toBe(false)
    }
  })

  it('names every sensitive category as never-auto', () => {
    expect([...NEVER_AUTO_CATEGORIES].sort()).toEqual(['deletes', 'installs', 'payments', 'sends', 'settings'])
    for (const name of [...NEVER_AUTO_CATEGORIES, 'other', 'instruction']) {
      expect(isNeverAuto(name), name).toBe(true)
      expect(isGrantableAction(name), name).toBe(false)
      expect(Grant.safeParse({ action: name }).success, name).toBe(false)
    }
  })

  it('requires scope on the scoped actions', () => {
    expect(Grant.safeParse({ action: 'list_files' }).success).toBe(false)
    expect(Grant.safeParse({ action: 'open_url' }).success).toBe(false)
    expect(Grant.safeParse({ action: 'list_files', folder: '/a/../..' }).success).toBe(false)
    expect(Grant.safeParse({ action: 'open_url', url: 'http://example.com/' }).success).toBe(false)
  })
})

describe('parseGrants', () => {
  it('keeps good grants and drops everything else', () => {
    const raw = [
      { action: 'check_status' },
      'payments',
      'info',
      { action: 'payments' },
      { action: 'sends' },
      { action: 'deletes' },
      { action: 'installs' },
      { action: 'settings' },
      { action: 'instruction' },
      { action: 'list_files' },
      { action: 'list_files', folder: '/a/../b' },
      { action: 'list_files', folder: '/a' },
      { action: 'check_status', scope: 'everything' },
      null,
      7,
    ]
    expect(parseGrants(raw)).toEqual([{ action: 'check_status' }, { action: 'list_files', folder: '/a' }])
  })

  it('removes duplicates and survives a non-array', () => {
    expect(parseGrants([{ action: 'check_status' }, { action: 'check_status' }])).toEqual([{ action: 'check_status' }])
    expect(parseGrants('payments')).toEqual([])
    expect(parseGrants(undefined)).toEqual([])
  })
})
