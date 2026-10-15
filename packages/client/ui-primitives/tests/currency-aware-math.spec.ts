import { expect, it, vi } from 'vitest'
import type { Construct, Extension } from 'micromark-util-types'
import { currencyAwareMath } from '../src/markdown/currencyAwareMath.ts'

const { math } = vi.hoisted(() => ({ math: vi.fn<() => Extension>() }))
vi.mock('micromark-extension-math', () => ({ math }))

it('preserves construct metadata when an extension supplies a dollar construct array', () => {
  const construct: Construct = { name: 'mathText', tokenize: (_effects, ok) => ok }
  math.mockReturnValue({ text: { 36: [construct] } })
  const dollar = currencyAwareMath().text?.[36]
  expect(Array.isArray(dollar)).toBe(true)
  if (!Array.isArray(dollar)) throw new Error('Expected dollar construct array')
  expect(dollar[0]?.name).toBe('mathText')
  expect(dollar[0]?.tokenize).not.toBe(construct.tokenize)
})

it('reports a missing upstream dollar text grammar rather than silently dropping math', () => {
  math.mockReturnValue({})
  expect(() => currencyAwareMath()).toThrow('must declare dollar text syntax')
})
