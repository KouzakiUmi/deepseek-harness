import { describe, expect, it } from 'vitest'
import {
  VisibleStallWatch, validateVisibleStallConfig, visibleStallDefaults, visibleStallRetentionCeiling,
  type VisibleStallConfig,
} from '../src/visible-stall.ts'
import { fencedScaffold, indexedProgress, nearDuplicateLoop, ordinaryReasoning, reasoningPrelude } from './reasoning-fixtures.ts'

/** Small budgets that make a release reachable; the shipped confirmations interrupt first otherwise. */
const patient: VisibleStallConfig = {
  windowChars: 256, maxWindowChars: 1024, scanChars: 32, minUnits: 8,
  unitShare: 0.5, unitCharShare: 0.15, shingleChars: 4, shingleShare: 0.6, confirmWindows: 1000, recoveryWindows: 2,
}

const recordedLoop = reasoningPrelude + nearDuplicateLoop(30)

function consume(text: string, options: VisibleStallConfig = visibleStallDefaults, protect = false) {
  const watch = new VisibleStallWatch(options)
  if (protect) watch.protectCommit()
  let output = ''
  let interrupted = false
  let held = 0
  let retained = 0
  let overCeiling = 0
  let window = watch.windowChars
  for (let position = 0; position < text.length; position += 1) {
    const result = watch.push(text.charAt(position))
    output += result.text
    held = Math.max(held, watch.heldChars)
    retained = Math.max(retained, watch.retainedChars)
    if (watch.retainedChars > options.maxWindowChars) overCeiling += 1
    window = Math.max(window, watch.windowChars)
    if (result.interrupt) { interrupted = true; break }
  }
  output += watch.flush()
  return { output, interrupted, held, retained, overCeiling, window, released: output === text }
}

describe('visible stall stall', () => {
  it('releases ordinary reasoning as it arrives and keeps one window', () => {
    const text = ordinaryReasoning(200)
    const result = consume(text)
    expect(result.output).toBe(text)
    expect(result.interrupted).toBe(false)
    expect(result.held).toBe(0)
    expect(result.retained).toBeLessThanOrEqual(visibleStallDefaults.windowChars + visibleStallDefaults.scanChars)
  })

  it('stops the recorded near-duplicate loop shape after it covers one observation window', () => {
    const result = consume(recordedLoop)
    expect(result.interrupted).toBe(true)
    // Only the prefix that arrived before repetition was observed is kept, verbatim.
    expect(result.output).toBe(recordedLoop.slice(0, result.output.length))
    expect(result.output.length).toBe(visibleStallDefaults.windowChars)
    expect(result.held).toBeLessThanOrEqual(visibleStallDefaults.maxWindowChars)
    expect(result.retained).toBeLessThanOrEqual(visibleStallDefaults.maxWindowChars)
    expect(recordedLoop.length - result.output.length).toBeGreaterThan(3000)
  })

  it('never treats counter-changed sentences, numbers, or negations as repetition', () => {
    const text = ordinaryReasoning(400)
    expect(consume(text)).toMatchObject({ output: text, interrupted: false, held: 0 })
  })

  it.each([
    ['triple backticks', '```'],
    ['four backticks', '````'],
    ['tilde fences', '~~~'],
  ])('leaves fenced example scaffolding to exact-copy filtering: %s', (_name, fence) => {
    const text = reasoningPrelude + fencedScaffold(fence, 40) + reasoningPrelude
    expect(consume(text)).toMatchObject({ output: text, interrupted: false, held: 0 })
  })

  it('reads a four-backtick fence as one block whose inner three-backtick lines are content', () => {
    const body = '````markdown\n' + '```ts\nconst a = 1\n```\n'.repeat(20) + '````\n'
    const result = consume(body + recordedLoop)
    expect(result.interrupted).toBe(true)
    expect(result.output).toBe((body + recordedLoop).slice(0, result.output.length))
    expect(result.output.length).toBeGreaterThan(body.length)
  })

  it.each([
    ['trailing content on the delimiter line', '```\n' + '``` not a close\n'.repeat(40) + '```\n'],
    ['a shorter delimiter run', '````\n' + '```\n'.repeat(40) + '````\n'],
    ['a backtick run that never reaches three', '``\n' + '`` ts\n'.repeat(40) + '``\n'],
  ])('does not close a fence on %s', (_name, body) => {
    const result = consume(body + recordedLoop)
    expect(result.interrupted).toBe(true)
    expect(result.output.length).toBeGreaterThan(body.length)
  })

  it.each([
    ['a backtick inside the info string', '```js`ts\n'],
    ['a short delimiter run', '``ts\n'],
  ])('does not open a fence on %s', (_name, prefix) => {
    expect(consume(prefix + recordedLoop).interrupted).toBe(true)
  })

  it('opens a tilde fence whose info string contains tildes', () => {
    const text = '~~~a~b\n' + recordedLoop
    expect(consume(text)).toMatchObject({ output: text, interrupted: false, held: 0 })
  })

  it('keeps answering an interruption without releasing the discarded suffix', () => {
    const watch = new VisibleStallWatch(visibleStallDefaults)
    let interrupted = false
    for (const char of recordedLoop) {
      const result = watch.push(char)
      if (result.interrupt) { interrupted = true; break }
    }
    expect(interrupted).toBe(true)
    expect(watch.push('好。')).toEqual({ text: '', interrupt: true })
    expect(watch.flush()).toBe('')
  })

  it('does not require evidence from a window without complete sentences', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta '.repeat(80)
    expect(consume(text)).toMatchObject({ output: text, interrupted: false, held: 0 })
  })

  it('interrupts sustained repetition at the retention ceiling instead of releasing it', () => {
    const text = nearDuplicateLoop(400)
    const result = consume(text, {
      ...patient, windowChars: 1024, maxWindowChars: visibleStallRetentionCeiling,
      scanChars: 128, minUnits: 16, shingleChars: 8,
    })
    expect(result.interrupted).toBe(true)
    expect(result.output).toBe(text.slice(0, result.output.length))
    expect(result.held).toBeLessThanOrEqual(visibleStallRetentionCeiling)
    expect(result.retained).toBeLessThanOrEqual(visibleStallRetentionCeiling)
    expect(result.overCeiling).toBe(0)
    expect(result.window).toBe(visibleStallRetentionCeiling)
  })

  it('releases at the retention ceiling once the observation has fallen back', () => {
    const text = nearDuplicateLoop(3) + ordinaryReasoning(60)
    const result = consume(text, { ...patient, recoveryWindows: 1000 })
    expect(result.interrupted).toBe(false)
    expect(result.held).toBeGreaterThan(0)
    expect(result.output).toBe(text)
    expect(result.retained).toBeLessThanOrEqual(patient.maxWindowChars)
    expect(result.overCeiling).toBe(0)
  })

  it('resolves the retention ceiling with the current evidence at every scan cadence', () => {
    const small = consume('好。执行。直接做。'.repeat(400), {
      windowChars: 64, maxWindowChars: 64, scanChars: 8, minUnits: 3,
      unitShare: 0.5, unitCharShare: 0.15, shingleChars: 4, shingleShare: 0.6, confirmWindows: 1000, recoveryWindows: 1000,
    })
    expect(small.interrupted).toBe(true)
    expect(small.retained).toBeLessThanOrEqual(64)
    expect(small.overCeiling).toBe(0)
    expect(small.output).toBe('好。执行。直接做。'.repeat(400).slice(0, small.output.length))
  })

  it('keeps withholding but never cancels after a complete protocol tool commit', () => {
    const result = consume(recordedLoop, visibleStallDefaults, true)
    expect(result.interrupted).toBe(false)
    expect(result.held).toBeGreaterThan(0)
    expect(result.output).toBe(recordedLoop)
  })

  it('releases at the retention ceiling, rather than cancelling, after a tool commit', () => {
    const text = nearDuplicateLoop(400)
    const result = consume(text, {
      ...patient, windowChars: 1024, maxWindowChars: visibleStallRetentionCeiling,
      scanChars: 128, minUnits: 16, shingleChars: 8,
    }, true)
    expect(result.interrupted).toBe(false)
    expect(result.output).toBe(text)
    expect(result.retained).toBeLessThanOrEqual(visibleStallRetentionCeiling)
    expect(result.overCeiling).toBe(0)
  })

  it('never retains more than the configured ceiling, at any character', () => {
    const result = consume(nearDuplicateLoop(400), { ...visibleStallDefaults, confirmWindows: 100000 })
    expect(result.overCeiling).toBe(0)
    expect(result.retained).toBeLessThanOrEqual(visibleStallRetentionCeiling)
  })

  it('does not treat new identifiers, counters, and verdicts behind a recurring interjection as a loop', () => {
    const text = indexedProgress(80)
    expect(text.length).toBeGreaterThan(4000)
    expect(consume(text)).toMatchObject({ output: text, interrupted: false, held: 0 })
  })

  it.each([
    ['four-space indented', '    ```\n'],
    ['inline in a paragraph', 'inline ``` code\n'],
  ])('does not treat a backtick run as a fence opener when it is %s', (_name, prefix) => {
    const result = consume(prefix + recordedLoop)
    expect(result.interrupted).toBe(true)
  })

  it('suspends detection inside a fence that is indented up to three spaces', () => {
    const text = '  ```\n' + recordedLoop
    expect(consume(text)).toMatchObject({ output: text, interrupted: false, held: 0 })
  })

  it('releases the held suffix verbatim when the repetition stops', () => {
    const text = nearDuplicateLoop(3) + ordinaryReasoning(30)
    const result = consume(text, patient)
    expect(result.interrupted).toBe(false)
    expect(result.held).toBeGreaterThan(0)
    expect(result.output).toBe(text)
  })

  it('releases everything held at a barrier and keeps the released text contiguous', () => {
    const watch = new VisibleStallWatch(visibleStallDefaults)
    let output = ''
    for (const char of recordedLoop) {
      const result = watch.push(char)
      output += result.text
      if (watch.heldChars > 0) break
    }
    const held = watch.heldChars
    expect(held).toBeGreaterThan(0)
    const released = watch.flush()
    expect(released.length).toBe(held)
    expect(recordedLoop.startsWith(output + released)).toBe(true)
    expect(watch.heldChars).toBe(0)
    expect(watch.retainedChars).toBe(0)
    // A barrier is not evidence: the next observation window starts empty.
    expect(watch.windowChars).toBe(visibleStallDefaults.windowChars)
  })

  it('validates the configured budgets before use', () => {
    expect(() => { validateVisibleStallConfig(visibleStallDefaults) }).not.toThrow()
    for (const invalid of [
      { scanChars: 0 }, { windowChars: Number.NaN }, { windowChars: visibleStallDefaults.maxWindowChars + 1 },
      { maxWindowChars: visibleStallRetentionCeiling + 1 }, { scanChars: visibleStallDefaults.windowChars + 1 },
      { minUnits: 2 }, { shingleChars: 2 }, { shingleChars: visibleStallDefaults.windowChars },
      { confirmWindows: 1 }, { recoveryWindows: 1 }, { unitShare: 0.4 }, { unitShare: 1.5 },
      { unitCharShare: 0 }, { unitCharShare: 1.5 }, { unitCharShare: 0.6 },
      { shingleShare: 0.5 }, { shingleShare: 1.5 },
    ]) expect(() => { validateVisibleStallConfig({ ...visibleStallDefaults, ...invalid }) }).toThrow('reasoningLoop.visibleStall')
  })
})

/** Collect every withholding transition one text produced, in arrival order. */
function transitions(text: string, options: VisibleStallConfig = patient, protect = false): string[] {
  const watch = new VisibleStallWatch(options)
  if (protect) watch.protectCommit()
  const seen: string[] = []
  for (let position = 0; position < text.length; position += 1) {
    const result = watch.push(text.charAt(position))
    if (result.transition !== undefined) seen.push(result.transition)
    if (result.interrupt) return [...seen, 'interrupt']
  }
  return seen
}

describe('visible stall withholding stages', () => {
  it('reports one transition per episode, in arrival order', () => {
    const loop = nearDuplicateLoop(4)
    // Long enough to withhold twice around a fallback, then confirm.
    const single = transitions(reasoningPrelude + loop + ordinaryReasoning(60) + loop + loop + loop)
    expect(single[0]).toBe('suspected')
    expect(single).toContain('released')
    expect(single.at(-1)).toBe('interrupt')
    // Two episodes: one the observation released, one it confirmed.
    expect(single.filter(stage => stage === 'suspected')).toHaveLength(2)
    expect(single.filter(stage => stage === 'interrupt')).toHaveLength(1)
  })

  it('reports every transition a single large delta produced', () => {
    const text = reasoningPrelude + nearDuplicateLoop(4) + ordinaryReasoning(60) + nearDuplicateLoop(4)
    const once = transitions(text)
    // The same characters delivered in one push must produce the same episode
    // order: stage detection reads the state machine, not the caller's chunking.
    const watch = new VisibleStallWatch(patient)
    const bulk: string[] = []
    for (const char of text) {
      const result = watch.push(char)
      if (result.transition !== undefined) bulk.push(result.transition)
    }
    const charByChar = transitions(text)
    expect(once.length).toBeGreaterThan(0)
    expect(bulk).toEqual(charByChar)
  })

  it('reports nothing for ordinary output and for fenced scaffolding', () => {
    expect(transitions(ordinaryReasoning(60))).toEqual([])
    expect(transitions(fencedScaffold('```', 40))).toEqual([])
    expect(transitions(indexedProgress(80))).toEqual([])
  })

  it('reports no stage after a confirmed interruption', () => {
    const text = reasoningPrelude + nearDuplicateLoop(40)
    const watch = new VisibleStallWatch(visibleStallDefaults)
    let interrupted = false
    for (const char of text) {
      const result = watch.push(char)
      if (result.interrupt) { interrupted = true; break }
    }
    expect(interrupted).toBe(true)
    // A stopped watch keeps answering interrupts and never claims a new stage.
    const after = watch.push('x')
    expect(after).toMatchObject({ interrupt: true })
    expect(after.transition).toBeUndefined()
  })
})

describe('visible stall fence releases', () => {
  /** Hold, then open a fence line while withholding: the fence releases without judging the text. */
  function releaseIntoFence(): { stages: string[]; text: string; suspectAfter: boolean } {
    const watch = new VisibleStallWatch(patient)
    let output = ''
    const stages: string[] = []
    const text = reasoningPrelude + nearDuplicateLoop(4) + '\n\n```ts\nconst a = 1\n'
    for (const char of text) {
      const result = watch.push(char)
      output += result.text
      if (result.transition !== undefined) stages.push(result.transition)
    }
    return { stages, text, suspectAfter: stages.includes('suspected') && stages.at(-1) === 'suspected' }
  }

  it('names a fence release while withholding as a barrier, never as fallen-back evidence', () => {
    const { stages, text } = releaseIntoFence()
    expect(stages).toContain('suspected')
    expect(stages).toContain('barrier')
    expect(stages).not.toContain('released')
    // Nothing the stall withheld is lost, and no extra episode is invented.
    const held = new VisibleStallWatch(patient)
    let released = ''
    for (const char of text) released += held.push(char).text
    expect(released).toBe(text)
    expect(stages.filter(stage => stage === 'suspected')).toHaveLength(1)
  })

  it('reports no stage when a fence arrives without a hold', () => {
    const watch = new VisibleStallWatch(patient)
    const stages: string[] = []
    for (const char of fencedScaffold('```', 40)) {
      const result = watch.push(char)
      if (result.transition !== undefined) stages.push(result.transition)
    }
    expect(stages).toEqual([])
  })
})

describe('visible stall fence release reproduction', () => {
  it('labels the fence that ends a real hold as a barrier', () => {
    const watch = new VisibleStallWatch({ ...visibleStallDefaults, confirmWindows: 100_000 })
    const stages: string[] = []
    let output = ''
    const feed = (text: string): void => {
      for (const char of text) {
        const result = watch.push(char)
        output += result.text
        if (result.transition !== undefined) stages.push(result.transition)
      }
    }
    const loop = nearDuplicateLoop(30)
    for (const char of loop) {
      if (watch.heldChars > 0) break
      const result = watch.push(char)
      output += result.text
      if (result.transition !== undefined) stages.push(result.transition)
    }
    expect(watch.heldChars).toBeGreaterThan(0)
    feed('\n```ts\n')
    expect(stages).toEqual(['suspected', 'barrier'])
    expect(watch.heldChars).toBe(0)
    // The withheld text was released, not discarded.
    expect(output.endsWith('\n```ts\n')).toBe(true)
  })
})
