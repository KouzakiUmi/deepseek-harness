/** Bounded exact-copy evidence and tentative buffering for streamed reasoning. */

import { countTerminators, patternIsInformative } from './sentence-units.ts'

/** Deployment-selected detection, buffering, and delayed interruption budgets, in UTF-16 characters. */
export interface ReasoningWatchConfig {
  /** Maximum raw and accepted suffix retained independently. */
  windowChars: number
  /** Fixed internal observation cadence, independent of provider chunk boundaries. */
  scanChars: number
  /** Minimum exact repeated extent before subsequent input becomes tentative. */
  holdChars: number
  /** Minimum exact repeated extent before proven copies can be suppressed. */
  confirmChars: number
  /** Cumulative suppressed extent before a still-looping call can be interrupted. */
  cancelChars: number
  /** Unproven text retained before releasing a recovered suffix. */
  recoveryChars: number
  /** Maximum period searched by the exact-cycle detector. */
  maxPeriodChars: number
  /** Minimum complete sentence units for reordered-pool evidence. */
  minPoolUnits: number
  /** Minimum fraction of unit characters belonging to repeated exact units. */
  poolShare: number
}

interface Span { start: number; end: number }
interface Pending { start: number; text: string }
interface Evidence { extent: number; copies: Span[] }


/** Accepted text and the local decision after consuming one provider delta. */
export interface ReasoningWatchResult {
  /** Accepted text, including any previously tentative text released by this observation. */
  text: string
  /** Whether the suppression budget ended this call; no provider finish is fabricated. */
  interrupt: boolean
}

/**
 * Validate the complete resolved settings before installing a policy.
 * @param config - deployment-selected complete budgets.
 * @throws when a count is invalid or the buffering/confirmation bounds conflict.
 */
export function validateReasoningWatchConfig(config: ReasoningWatchConfig): void {
  for (const key of ['windowChars', 'scanChars', 'holdChars', 'confirmChars', 'cancelChars', 'recoveryChars', 'maxPeriodChars', 'minPoolUnits'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new Error(`reasoningLoop.${key} must be a positive safe integer`)
    }
  }
  if (config.scanChars > config.holdChars || config.holdChars >= config.confirmChars
    || config.confirmChars > config.windowChars || config.recoveryChars > config.windowChars
    || config.maxPeriodChars * 3 > config.windowChars || config.cancelChars <= config.confirmChars
    || config.minPoolUnits < 3 || !Number.isFinite(config.poolShare) || config.poolShare <= 0.5 || config.poolShare > 1) {
    throw new Error('reasoningLoop requires scan <= hold < confirm <= window, recovery <= window, 3 * period <= window, cancel > confirm, pool units >= 3, and 0.5 < poolShare <= 1')
  }
}

/**
 * Conservatively suppress exact copies only after sustained repetition evidence.
 * Normal text is accepted immediately. Raw and accepted suffixes, pending text,
 * and pending span metadata are bounded by the configured window. This is not a
 * semantic classifier: changed identifiers, numbers, and negations remain new text.
 */
export class ReasoningWatch {
  private raw = ''
  private accepted = ''
  private offset = 0
  private pending: Pending[] = []
  private pendingChars = 0
  private phase: 'normal' | 'tentative' | 'suppressing' = 'normal'
  private protected = false
  private stopped = false
  private omitted = 0

  constructor(private readonly config: ReasoningWatchConfig) {}

  /** Number of confirmed copy characters omitted so far. */
  get suppressedChars(): number { return this.omitted }

  /** Retained character count, excluding output returned to the caller. */
  get retainedChars(): number { return this.raw.length + this.accepted.length + this.pendingChars }

  /**
   * Disable repetition-driven cancellation after a complete protocol tool block.
   * Filtering remains active; the caller must independently bound unfinished tool settlement.
   */
  protectCommit(): void { this.protected = true }

  /**
   * Consume one delta; internal observation positions do not depend on delta sizes.
   * @param text - the original reasoning delta, without normalization.
   * @returns accepted text and whether the local suppression budget was exhausted.
   */
  push(text: string): ReasoningWatchResult {
    return this.consume(text, true)
  }

  /**
   * Settle text that a caller withheld at a barrier, together with this watch's
   * own unresolved text. Confirmed copies stay suppressed, and the arrival order
   * of every character is preserved. A settle never starts a cancellation: the
   * observation window for text withheld this long has passed, and a stop that
   * can no longer abort the call would otherwise drop characters the caller
   * still owes its own consumer.
   * @param text - caller-withheld original text in arrival order.
   * @returns accepted text in arrival order, with confirmed copies removed.
   */
  release(text: string): string {
    const unresolved = this.flush()
    const settled = this.consume(text, false)
    return unresolved + settled.text + this.flush()
  }

  private consume(text: string, allowCancel: boolean): ReasoningWatchResult {
    let emitted = ''
    for (let position = 0; position < text.length; position += 1) {
      if (allowCancel && this.stopped) break
      const char = text.charAt(position)
      const start = this.offset++
      this.raw = (this.raw + char).slice(-this.config.windowChars)
      if (this.phase === 'normal') {
        emitted += char
        this.remember(char)
      } else {
        const previous = this.pending.at(-1)
        if (previous !== undefined && previous.start + previous.text.length === start) previous.text += char
        else this.pending.push({ start, text: char })
        this.pendingChars += 1
      }
      if (this.pendingChars >= this.config.windowChars && this.offset % this.config.scanChars !== 0) {
        emitted += this.flush()
        this.phase = 'normal'
      }
      if (this.offset % this.config.scanChars !== 0) continue
      const evidence = this.evidence()
      if (this.phase === 'normal') {
        if (evidence.extent >= this.config.holdChars) this.phase = 'tentative'
        continue
      }
      if (evidence.extent >= this.config.confirmChars) this.phase = 'suppressing'
      if (this.phase === 'suppressing') {
        this.suppress(evidence.copies)
        if (allowCancel && !this.protected && this.omitted >= this.config.cancelChars && evidence.extent >= this.config.holdChars) {
          this.stopped = true
          break
        }
      }
      if ((this.phase === 'suppressing' && this.pendingChars >= this.config.recoveryChars)
        || (evidence.extent < this.config.holdChars && this.pendingChars >= this.config.recoveryChars)
        || this.pendingChars >= this.config.windowChars) {
        emitted += this.flush()
        this.phase = 'normal'
      }
    }
    return { text: emitted, interrupt: allowCancel && this.stopped }
  }

  /**
   * Release only unresolved text at an ordering barrier or final settlement.
   * Confirmed copies have already been removed and can never be released.
   * @returns pending original text in arrival order.
   */
  flush(): string {
    const text = this.pending.map(part => part.text).join('')
    this.pending = []
    this.pendingChars = 0
    this.remember(text)
    return text
  }

  private remember(text: string): void {
    this.accepted = (this.accepted + text).slice(-this.config.windowChars)
  }

  private evidence(): Evidence {
    const base = this.offset - this.raw.length
    const copies: Span[] = []
    let extent = 0
    for (let period = 4; period <= this.config.maxPeriodChars && period * 3 <= this.raw.length; period += 1) {
      if (!patternIsInformative(this.raw, period)) continue
      const pattern = this.raw.slice(-period)
      let matched = period
      while (matched < this.raw.length
        && this.raw[this.raw.length - matched - 1] === this.raw[this.raw.length - matched - 1 + period]) matched += 1
      if (matched < period * 3) continue
      extent = Math.max(extent, matched)
      if (this.accepted.includes(pattern)) copies.push({ start: this.offset - matched + period, end: this.offset })
    }

    // Every sentence unit ends with at least one terminator, so a window with too
    // few terminators cannot reach minPoolUnits; skip the backtracking-prone scan.
    if (countTerminators(this.raw) >= this.config.minPoolUnits) {
      const units = [...this.raw.matchAll(/[^。！？!?；;\r\n]+[。！？!?；;\r\n]+/gu)]
      if (units.length >= this.config.minPoolUnits) {
        const counts = new Map<string, number>()
        let total = 0
        for (const unit of units) {
          counts.set(unit[0], (counts.get(unit[0]) ?? 0) + 1)
          total += unit[0].length
        }
        let repeated = 0
        const pooled: Span[] = []
        for (const unit of units) {
          const count = counts.get(unit[0])
          if (count === undefined || count < 2) continue
          repeated += unit[0].length
          if (this.accepted.includes(unit[0])) pooled.push({ start: base + unit.index, end: base + unit.index + unit[0].length })
        }
        if (repeated / total >= this.config.poolShare) {
          extent = Math.max(extent, repeated)
          copies.push(...pooled)
        }
      }
    }
    return { extent, copies }
  }

  private suppress(copies: Span[]): void {
    copies.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged: Span[] = []
    for (const copy of copies) {
      const previous = merged.at(-1)
      if (previous !== undefined && copy.start <= previous.end) previous.end = Math.max(previous.end, copy.end)
      else merged.push({ ...copy })
    }
    const remaining: Pending[] = []
    for (const part of this.pending) {
      let position = part.start
      const end = position + part.text.length
      for (const copy of merged) {
        if (copy.end <= position) continue
        if (copy.start >= end) break
        if (copy.start > position) {
          remaining.push({ start: position, text: part.text.slice(position - part.start, copy.start - part.start) })
        }
        const removedEnd = Math.min(end, copy.end)
        this.omitted += removedEnd - Math.max(position, copy.start)
        position = removedEnd
        if (position === end) break
      }
      if (position < end) remaining.push({ start: position, text: part.text.slice(position - part.start) })
    }
    this.pending = remaining
    this.pendingChars = remaining.reduce((sum, part) => sum + part.text.length, 0)
  }
}
