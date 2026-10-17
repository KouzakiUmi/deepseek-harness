/**
 * Adaptive visible-output stall for near-duplicate reasoning. Normal reasoning is
 * released as it arrives; only after one observation qualifies does the stall
 * withhold the following characters, and it either releases them verbatim or
 * discards the withheld suffix when it interrupts. It never rewrites or removes
 * characters it already released.
 */

import { countTerminators, UNIT_PATTERN } from './sentence-units.ts'

/** Largest observation window and held suffix this stall may retain, whatever the configuration says. */
export const visibleStallRetentionCeiling = 8192

/** Deployment-selected observation, retention, and confirmation budgets, in UTF-16 characters. */
export interface VisibleStallConfig {
  /** Initial observation window; output is released as it arrives until one observation qualifies. */
  windowChars: number
  /** Ceiling for the expanding observation window and therefore for the held suffix. */
  maxWindowChars: number
  /** Observation cadence in observed characters, independent of provider delta boundaries. */
  scanChars: number
  /** Minimum complete sentence units inside one observation. */
  minUnits: number
  /** Minimum fraction of units whose trimmed text also occurs elsewhere in the observation. */
  unitShare: number
  /**
   * Minimum fraction of sentence characters inside recurring sentences. A
   * recurring interjection alone cannot qualify an observation whose content
   * keeps arriving as new sentences, so this is the evidence that recurring
   * sentences carry real mass rather than filler.
   */
  unitCharShare: number
  /** Length of the exact fragments that measure reused characters. */
  shingleChars: number
  /** Minimum fraction of observation characters inside a fragment repeated at least `shingleChars * 2` away. */
  shingleShare: number
  /** Consecutive qualifying observations that confirm repetition and discard the held suffix. */
  confirmWindows: number
  /** Consecutive non-qualifying observations that release the held suffix verbatim. */
  recoveryWindows: number
}

/** Defaults materialized by the owning plugin's configuration schema. */
export const visibleStallDefaults: VisibleStallConfig = {
  windowChars: 1024,
  maxWindowChars: visibleStallRetentionCeiling,
  scanChars: 128,
  minUnits: 16,
  unitShare: 0.5,
  unitCharShare: 0.15,
  shingleChars: 8,
  shingleShare: 0.6,
  confirmWindows: 3,
  recoveryWindows: 2,
}

/**
 * Reject settings that would defeat the bounded, majority-evidence contract.
 * @param config - deployment-selected complete budgets.
 * @throws when a count is not a positive safe integer, the window exceeds
 * {@link visibleStallRetentionCeiling}, or a share is not a majority below one.
 */
export function validateVisibleStallConfig(config: VisibleStallConfig): void {
  for (const key of ['windowChars', 'maxWindowChars', 'scanChars', 'minUnits', 'shingleChars', 'confirmWindows', 'recoveryWindows'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new Error(`reasoningLoop.visibleStall.${key} must be a positive safe integer`)
    }
  }
  if (config.maxWindowChars > visibleStallRetentionCeiling || config.windowChars > config.maxWindowChars
    || config.scanChars > config.windowChars || config.minUnits < 3 || config.shingleChars < 4
    || config.shingleChars * 4 > config.windowChars || config.confirmWindows < 2 || config.recoveryWindows < 2
    || !Number.isFinite(config.unitShare) || config.unitShare < 0.5 || config.unitShare > 1
    || !Number.isFinite(config.unitCharShare) || config.unitCharShare <= 0 || config.unitCharShare > config.unitShare
    || !Number.isFinite(config.shingleShare) || config.shingleShare <= 0.5 || config.shingleShare > 1) {
    throw new Error('reasoningLoop.visibleStall requires initial <= maximum <= 8192, scan <= initial, units >= 3, 4 <= fragment <= initial / 4, confirmations/recovery >= 2, majority unit evidence, and 0 < unitCharShare <= unitShare')
  }
}

/** One withholding transition this stall made while consuming a character. */
export type VisibleStallStage =
  /** Observation began withholding output to check it. */
  | 'suspected'
  /** Observation stopped qualifying, so the withheld output was released. */
  | 'released'
  /** A barrier released the withheld output without judging it (fence or explicit flush). */
  | 'barrier'

/** One stall decision for one original character. */
export interface VisibleStallResult {
  /** Original text released now, in arrival order; empty while the stall withholds. */
  text: string
  /** Whether the held suffix was discarded because repetition was confirmed. */
  interrupt: boolean
  /** Withholding transition this character caused; absent while the withholding state is unchanged. */
  transition?: VisibleStallStage
}

/** Characters that may delimit a fenced code block, and the delimiter run that counts as one. */
const FENCE_MARKERS = '`~'
const FENCE_MIN_RUN = 3
const FENCE_MAX_INDENT = 3

/** Bounded prefix analysis of the line being received; never holds the line text itself. */
interface FenceLine {
  indent: number
  run: number
  marker: string
  rest: number
  restBlank: boolean
  restMarker: boolean
  dead: boolean
}

/** A line that has not started yet. */
function emptyFenceLine(): FenceLine {
  return { indent: 0, run: 0, marker: '', rest: 0, restBlank: true, restMarker: false, dead: false }
}

/**
 * Stop-only stall over one reasoning block's original characters. Detection uses
 * sentence recurrence in a rolling window plus the fraction of characters
 * inside locally repeated fragments; evidence never rewrites text, and every
 * released character leaves the stall exactly once. Fenced code suspends
 * detection so example scaffolding is not mistaken for repeated prose.
 */
export class VisibleStallWatch {
  private raw = ''
  private pendingChars = 0
  private received = 0
  private capacity: number
  private holding = false
  private high = 0
  private low = 0
  private stopped = false
  private protected = false
  private fence: { marker: string; run: number } | undefined
  private line = emptyFenceLine()
  /** Set only while a fence transition releases, so the release reports its real cause. */
  private releasedByFence = false

  constructor(private readonly config: VisibleStallConfig) {
    validateVisibleStallConfig(config)
    this.capacity = config.windowChars
  }

  /**
   * Characters retained independently of every caller-owned string. The withheld
   * suffix is a suffix of this buffer, so the complete retention is one window.
   */
  get retainedChars(): number { return this.raw.length }

  /** Current observation window, which expands toward the configured ceiling while withholding. */
  get windowChars(): number { return this.capacity }

  /** Characters currently withheld from the caller. */
  get heldChars(): number { return this.pendingChars }

  /**
   * Disable cancellation after a complete protocol tool block. Withholding keeps
   * working; a confirmed observation then releases instead of discarding, because
   * unfinished tool output belongs to the settlement budget, not to this stall.
   */
  protectCommit(): void { this.protected = true }

  /**
   * Release every unresolved character at an output barrier or final settlement.
   * @returns withheld original text in arrival order; empty after an interruption, whose suffix is already gone.
   */
  flush(): string {
    const text = this.stopped ? '' : this.releaseHeld()
    this.pendingChars = 0
    this.resetObservation()
    return text
  }

  /**
   * Consume one original character in arrival order.
   * @param char - exactly one character of unmodified reasoning output.
   * @returns the text released for this character, whether the held suffix was
   * discarded, and the withholding transition this character caused.
   */
  push(char: string): VisibleStallResult {
    // One character's cause, read after the step that recorded it.
    this.releasedByFence = false
    const holding = this.holding
    const result = this.step(char)
    if (result.interrupt || this.holding === holding) return result
    return { ...result, transition: this.holding ? 'suspected' : this.releasedByFence ? 'barrier' : 'released' }
  }

  /** One character through the detector; `push` adds the withholding transition around it. */
  private step(char: string): VisibleStallResult {
    if (this.stopped) return { text: '', interrupt: true }
    const transition = this.scanFenceLine(char)
    if (transition !== undefined) {
      // Kept until `push` reads it: a fence suspends detection, so a release it
      // causes is a barrier rather than a fallen-back observation.
      this.releasedByFence = true
      return { text: this.flush() + char, interrupt: false }
    }
    if (this.fence !== undefined) return { text: char, interrupt: false }
    const holding = this.holding
    if (holding) this.pendingChars += 1
    this.raw += char
    this.received += 1
    // Hard retention bound: the buffer keeps at most the ceiling, and the held suffix
    // is its youngest characters, so trimming never drops withheld text.
    if (this.raw.length > this.config.maxWindowChars) this.raw = this.raw.slice(-this.config.maxWindowChars)
    // The ceiling is a decision point, not a release valve: repetition that is still
    // current ends the call locally, and only a fallen-back observation releases.
    if (this.holding && this.pendingChars >= this.config.maxWindowChars) {
      if (!this.protected && this.qualifies()) {
        this.stopped = true
        this.pendingChars = 0
        return { text: '', interrupt: true }
      }
      return { text: this.flush(), interrupt: false }
    }
    if (this.received % this.config.scanChars !== 0) return { text: holding ? '' : char, interrupt: false }
    if (this.holding && this.capacity < this.config.maxWindowChars
      && (this.raw.length >= this.capacity || this.pendingChars >= this.capacity)) {
      this.capacity = Math.min(this.config.maxWindowChars, this.capacity * 2)
    }
    if (this.raw.length > this.capacity) this.raw = this.raw.slice(-this.capacity)
    // Withholding starts only after a full window arrived, so an under-filled window is always released.
    if (this.raw.length < this.config.windowChars) return { text: char, interrupt: false }
    const qualifies = this.qualifies()
    if (!this.holding) {
      if (qualifies) { this.holding = true; this.high = 1 }
      return { text: char, interrupt: false }
    }
    if (qualifies) { this.high += 1; this.low = 0 } else { this.high = 0; this.low += 1 }
    if (!this.protected && this.high >= this.config.confirmWindows) {
      this.stopped = true
      this.pendingChars = 0
      return { text: '', interrupt: true }
    }
    if (this.high >= this.config.confirmWindows || this.low >= this.config.recoveryWindows) {
      return { text: this.flush(), interrupt: false }
    }
    return { text: '', interrupt: false }
  }

  /** Take the withheld suffix out of the observation window, in arrival order. */
  private releaseHeld(): string {
    const text = this.pendingChars === 0 ? '' : this.raw.slice(this.raw.length - this.pendingChars)
    this.pendingChars = 0
    return text
  }

  /** Drop the observation window; a barrier is not evidence about the text after it. */
  private resetObservation(): void {
    this.raw = ''
    this.received = 0
    this.capacity = this.config.windowChars
    this.holding = false
    this.high = 0
    this.low = 0
  }

  /** Whether two window positions carry the same shingle, compared by code unit. */
  private sameShingle(left: number, right: number, size: number): boolean {
    for (let index = 0; index < size; index += 1) {
      if (this.raw.charCodeAt(left + index) !== this.raw.charCodeAt(right + index)) return false
    }
    return true
  }

  /** Whether the current observation shows repeated sentences over reused characters. */
  private qualifies(): boolean {
    // Each unit ends with at least one terminator; too few terminators cannot reach minUnits.
    if (countTerminators(this.raw) < this.config.minUnits) return false
    const units = [...this.raw.matchAll(UNIT_PATTERN)].map(match => match[0].trim()).filter(unit => unit.length > 0)
    if (units.length < this.config.minUnits) return false
    const counts = new Map<string, number>()
    let totalChars = 0
    for (const unit of units) {
      totalChars += unit.length
      const seen = counts.get(unit)
      if (seen === undefined) counts.set(unit, 1)
      else counts.set(unit, seen + 1)
    }
    let repeated = 0
    let repeatedChars = 0
    for (const [unit, count] of counts) {
      if (count > 1) { repeated += count; repeatedChars += count * unit.length }
    }
    if (repeated / units.length < this.config.unitShare) return false
    if (repeatedChars / totalChars < this.config.unitCharShare) return false
    const size = this.config.shingleChars
    const distance = size * 2
    const raw = this.raw
    const first = new Map<number, number[]>()
    const covered = new Uint8Array(raw.length)
    let coveredChars = 0
    for (let start = 0; start + size <= raw.length; start += 1) {
      let hash = 0
      for (let index = 0; index < size; index += 1) hash = (Math.imul(hash, 31) + raw.charCodeAt(start + index)) | 0
      const positions = first.get(hash)
      let previous: number | undefined
      if (positions === undefined) first.set(hash, [start])
      else {
        previous = positions.find(position => this.sameShingle(position, start, size))
        if (previous === undefined) positions.push(start)
      }
      if (previous === undefined || start - previous < distance) continue
      for (let index = start; index < start + size; index += 1) {
        if (covered[index] === 0) { covered[index] = 1; coveredChars += 1 }
      }
    }
    return coveredChars / raw.length >= this.config.shingleShare
  }

  /**
   * Track fenced-code delimiters from the bounded line prefix.
   * @param char - the character just received.
   * @returns `open` or `close` when this character completed a fence line, otherwise `undefined`.
   */
  private scanFenceLine(char: string): 'open' | 'close' | undefined {
    if (char === '\n' || char === '\r') {
      const line = this.line
      this.line = emptyFenceLine()
      if (line.dead || line.run < FENCE_MIN_RUN) return undefined
      const open = this.fence
      if (open === undefined) {
        if (line.marker === '`' && line.restMarker) return undefined
        this.fence = { marker: line.marker, run: line.run }
        return 'open'
      }
      if (line.marker === open.marker && line.run >= open.run && line.restBlank) {
        this.fence = undefined
        return 'close'
      }
      return undefined
    }
    const line = this.line
    if (line.dead) return undefined
    if (line.run === 0 && line.rest === 0) {
      if (char === ' ') {
        line.indent += 1
        if (line.indent > FENCE_MAX_INDENT) line.dead = true
        return undefined
      }
      if (FENCE_MARKERS.includes(char)) {
        line.marker = char
        line.run = 1
        return undefined
      }
      line.dead = true
      return undefined
    }
    if (line.rest === 0 && char === line.marker) {
      line.run += 1
      return undefined
    }
    if (line.run < FENCE_MIN_RUN) {
      line.dead = true
      return undefined
    }
    line.rest += 1
    if (char === line.marker) line.restMarker = true
    if (char !== ' ' && char !== '\t') line.restBlank = false
    return undefined
  }
}
