import { describe, expect, it } from 'vitest'
import { ReasoningWatch, validateReasoningWatchConfig, type ReasoningWatchConfig } from '../src/reasoning-watch.ts'

const config: ReasoningWatchConfig = {
  windowChars: 2048,
  scanChars: 16,
  holdChars: 160,
  confirmChars: 480,
  cancelChars: 4096,
  recoveryChars: 160,
  maxPeriodChars: 128,
  minPoolUnits: 12,
  poolShare: 0.72,
}

const analysis = 'textA 与 textB 必须分开保留。epoch=7 的响应不得套用 epoch=8 的重放状态。先检查完整块，再修改提交点。'
const phrases = ['执行。', '好。', '写。', '让我输出2个edit。', '停止循环。', '现在输出工具调用。']
const rearranged = Array.from({ length: 180 }, (_, index) =>
  [...phrases.slice(index % phrases.length), ...phrases.slice(0, index % phrases.length)].join('')).join('')

function consume(text: string, size: number, options = config, protect = false) {
  const watch = new ReasoningWatch(options)
  if (protect) watch.protectCommit()
  let output = ''
  let interrupted = false
  let retained = 0
  for (let offset = 0; offset < text.length; offset += size) {
    const result = watch.push(text.slice(offset, offset + size))
    output += result.text
    retained = Math.max(retained, watch.retainedChars)
    if (result.interrupt) {
      interrupted = true
      break
    }
  }
  output += watch.flush()
  return { output, interrupted, suppressed: watch.suppressedChars, retained }
}

describe('reasoning exact-copy watch', () => {
  it('forwards non-repeated reasoning immediately without retaining the entire output', () => {
    const watch = new ReasoningWatch(config)
    const parts = Array.from({ length: 600 }, (_, index) => `epoch=${index}; textA_${index} != textB_${index + 1}; 不删除新增标识符。`)
    for (const part of parts) expect(watch.push(part)).toEqual({ text: part, interrupt: false })
    expect(watch.flush()).toBe('')
    expect(watch.suppressedChars).toBe(0)
    expect(watch.retainedChars).toBeLessThanOrEqual(config.windowChars * 2)
  })

  it('keeps the useful prefix and suppresses reordered short-sentence copies before delayed interruption', () => {
    const result = consume(analysis + rearranged, 37)
    expect(result.output.startsWith(analysis)).toBe(true)
    for (const phrase of phrases) expect(result.output).toContain(phrase)
    expect(result.output.length).toBeLessThan(1800)
    expect(result.interrupted).toBe(true)
    expect(result.suppressed).toBeGreaterThanOrEqual(config.cancelChars)
    expect(result.retained).toBeLessThanOrEqual(config.windowChars * 3)
  })

  it('handles exact cycles without newlines or sentence delimiters', () => {
    const result = consume(analysis + 'execute-write-next-call'.repeat(400), 23)
    expect(result.output.startsWith(analysis)).toBe(true)
    expect(result.suppressed).toBeGreaterThanOrEqual(config.cancelChars)
    expect(result.interrupted).toBe(true)
  })

  it('makes decisions independent of provider delta boundaries, including a huge delta', () => {
    const input = analysis + rearranged
    const expected = consume(input, 1)
    for (const size of [2, 7, 64, 511, input.length]) {
      const result = consume(input, size)
      expect(result.output).toBe(expected.output)
      expect(result.suppressed).toBe(expected.suppressed)
      expect(result.interrupted).toBe(expected.interrupted)
    }
  })

  it('allows short repetition to recover without restoring confirmed copies', () => {
    const repetition = phrases.join('').repeat(28)
    const recovery = Array.from({ length: 30 }, (_, index) => `新增 epoch_${index}：textA_${index} 与 textB_${index + 1} 不同，不能删除。`).join('')
    const result = consume(analysis + repetition + recovery, 19)
    expect(result.interrupted).toBe(false)
    expect(result.output).toContain(analysis)
    expect(result.output).toContain(recovery)
    expect(result.suppressed).toBeGreaterThan(0)
    expect(result.output.length).toBeLessThan(analysis.length + repetition.length + recovery.length)
  })

  it('retains changed numbers, identifiers, and negations inside a repetition episode', () => {
    const first = phrases.join('').repeat(24)
    const additions = ['textA 必须保留。', 'textB 不得保留。', 'epoch=500001。', 'epoch=500002。', '输出2个edit。', '不要输出2个edit。']
    const input = analysis + first + additions.join('') + phrases.join('').repeat(18)
    const result = consume(input, 11, { ...config, cancelChars: 20000 })
    for (const addition of additions) expect(result.output).toContain(addition)
    expect(result.suppressed).toBeGreaterThan(0)
  })

  it('releases only unresolved text at a tool-ordering barrier and keeps filtering after commit protection', () => {
    const watch = new ReasoningWatch(config)
    let output = watch.push(analysis + phrases.join('').repeat(24)).text
    const before = watch.suppressedChars
    output += watch.flush()
    watch.protectCommit()
    const result = watch.push(rearranged)
    output += result.text + watch.flush()
    expect(result.interrupt).toBe(false)
    expect(watch.suppressedChars).toBeGreaterThan(config.cancelChars)
    expect(watch.suppressedChars).toBeGreaterThan(before)
    expect(output.length).toBeLessThan(1800)
  })

  it('does not call changed whole lines exact duplicates', () => {
    const input = Array.from({ length: 150 }, (_, index) => `现在检查 epoch_${index}，结论 ${index % 2 === 0 ? '允许' : '不允许'}，textA_${index}。\n`).join('')
    expect(consume(input, 13).output).toBe(input)
  })

  it('settles its own unresolved text before the text a caller withheld, in arrival order', () => {
    const unique = Array.from({ length: 40 }, (_, index) => `新增 epoch_${index}：textA_${index} 与 textB_${index + 1} 不同，不能删除。`).join('')
    const watch = new ReasoningWatch(config)
    const head = watch.push(analysis).text
    const repetition = phrases.join('').repeat(24)
    const withheld = watch.push(repetition).text
    expect(withheld.length).toBeLessThan(repetition.length)
    const combined = head + withheld + watch.release(unique) + watch.flush()
    expect(combined.startsWith(analysis)).toBe(true)
    expect(combined.endsWith(unique)).toBe(true)
    expect(combined.length).toBeLessThan(analysis.length + repetition.length + unique.length)
  })

  it('lets a caller settle withheld text past the suppression budget without starting a cancellation', () => {
    const watch = new ReasoningWatch(config)
    const withheld = phrases.join('').repeat(200)
    const settled = watch.release(withheld)
    expect(watch.suppressedChars).toBeGreaterThan(config.cancelChars)
    expect(settled.length).toBeLessThan(withheld.length)
    expect(settled.length).toBeGreaterThan(0)
    expect(watch.push('新增内容。').interrupt).toBe(false)
  })

  it('keeps tracking pending text after a suppressed middle span', () => {
    const watch = new ReasoningWatch(config)
    let output = watch.push(analysis + phrases.join('').repeat(24)).text
    output += watch.push(phrases.join('').repeat(4)).text
    output += watch.flush()
    expect(watch.suppressedChars).toBeGreaterThan(0)
    expect(output.startsWith(analysis)).toBe(true)
  })

  it('validates buffering and interruption budgets before installation', () => {
    expect(() => { validateReasoningWatchConfig(config) }).not.toThrow()
    for (const invalid of [
      { scanChars: 0 }, { windowChars: Number.NaN }, { holdChars: config.confirmChars },
      { confirmChars: config.windowChars + 1 }, { cancelChars: config.confirmChars },
      { recoveryChars: config.windowChars + 1 }, { maxPeriodChars: config.windowChars },
      { minPoolUnits: 2 }, { poolShare: 0.5 }, { poolShare: 1.1 },
    ]) expect(() => { validateReasoningWatchConfig({ ...config, ...invalid }) }).toThrow('reasoningLoop')
  })
})
