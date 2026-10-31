import { describe, expect, it } from 'vitest'
import {
  ALWAYS_ASK_CATEGORIES,
  CATEGORIES,
  GRANTABLE_CATEGORIES,
  detectCategories,
  evaluateRequest,
  isGrantable,
} from '../src/index.js'

const everything = [...CATEGORIES]

describe('evaluateRequest', () => {
  it('is ask-only by default', () => {
    for (const category of CATEGORIES) {
      expect(evaluateRequest({ category, instruction: 'hello there', grants: [] }).decision).toBe('ask')
    }
  })

  it('always asks for sensitive categories, whatever has been granted', () => {
    for (const category of ALWAYS_ASK_CATEGORIES) {
      const result = evaluateRequest({ category, instruction: 'hello there', grants: everything })
      expect(result.decision).toBe('ask')
      expect(result.alwaysAsk).toBe(true)
    }
  })

  it('auto-approves only a granted, grantable category', () => {
    const grants = ['info' as const]
    expect(evaluateRequest({ category: 'info', instruction: 'What time is it?', grants }).decision).toBe('auto')
    expect(evaluateRequest({ category: 'reminders', instruction: 'Note for later', grants }).decision).toBe('ask')
  })

  it('never auto-approves the catch-all category', () => {
    expect(evaluateRequest({ category: 'other', instruction: 'hello', grants: everything }).decision).toBe('ask')
  })

  it("doesn't trust a helper's label on a sensitive instruction", () => {
    const cases: [string, string][] = [
      ['Pay the invoice from my account', 'payments'],
      ['Buy $500 of gift cards', 'payments'],
      ['Move $200 to this person', 'payments'],
      ['Send this email to my boss', 'sends'],
      ['Delete the Documents folder', 'deletes'],
      ['Install AnyDesk so I can help', 'installs'],
      ['Turn off the firewall', 'settings'],
      ['Change the trustline permissions', 'settings'],
    ]
    for (const [instruction, expected] of cases) {
      const result = evaluateRequest({ category: 'info', instruction, grants: ['info'] })
      expect(result.decision, instruction).toBe('ask')
      expect(result.categories, instruction).toContain(expected)
    }
  })

  it('sees through full-width and zero-width evasion', () => {
    expect(detectCategories('ｐａｙ the bill')).toContain('payments')
    expect(detectCategories('de\u200blete everything')).toContain('deletes')
    expect(detectCategories('INSTALL this')).toContain('installs')
  })

  it('ignores a forged grant for a sensitive category', () => {
    const result = evaluateRequest({ category: 'payments', instruction: 'hello', grants: ['payments'] })
    expect(result.decision).toBe('ask')
  })
})

describe('grantable set', () => {
  it('excludes every always-ask category and the catch-all', () => {
    for (const category of ALWAYS_ASK_CATEGORIES) expect(isGrantable(category)).toBe(false)
    expect(isGrantable('other')).toBe(false)
    expect(GRANTABLE_CATEGORIES.every(isGrantable)).toBe(true)
  })
})
