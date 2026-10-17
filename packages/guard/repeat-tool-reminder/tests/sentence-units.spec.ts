import { describe, expect, it } from 'vitest'
import { countTerminators, isTrimBlank, patternIsInformative, UNIT_PATTERN } from '../src/sentence-units.ts'

describe('sentence units', () => {
  it('counts only the shared terminator set', () => {
    expect(countTerminators('一二三')).toBe(0)
    expect(countTerminators('一。二！三？')).toBe(3)
    expect(countTerminators('a!b?c;d；e\r\nf')).toBe(6)
    expect(countTerminators('')).toBe(0)
  })

  it('keeps informative-pattern detection equivalent to trim and Set', () => {
    const samples = [
      'ab', 'aa', 'a ', '  ab', 'a  b', '😀😀', '😀a', 'éé', 'éè', '\u3000a\u3000', '\u00a0a\u00a0', 'x', '',
    ]
    for (const pattern of samples) {
      const expected = pattern.trim().length >= 2 && new Set(pattern).size >= 2
      expect(patternIsInformative(pattern, pattern.length)).toBe(expected)
    }
  })

  it('rejects a window shorter than the requested period', () => {
    expect(patternIsInformative('abc', 10)).toBe(false)
  })

  it('treats every trim-removable code unit as blank', () => {
    for (const char of [' ', '\t', '\n', '\r', '\u00a0', '\u1680', '\u2000', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']) {
      expect(isTrimBlank(char.codePointAt(0) ?? 0)).toBe(true)
    }
    expect(isTrimBlank('a'.codePointAt(0) ?? 0)).toBe(false)
  })

  it('produces no sentence units for a window without terminators', () => {
    const text = '啊'.repeat(500)
    expect(countTerminators(text)).toBe(0)
    expect([...text.matchAll(UNIT_PATTERN)].length).toBe(0)
  })
})
