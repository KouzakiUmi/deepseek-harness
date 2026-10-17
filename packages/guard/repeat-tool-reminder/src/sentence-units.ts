/** Sentence-unit scanning shared by the exact-copy pool and the visible-stall metric. */

/** Sentence terminators: the unit metrics intentionally observe the same boundaries. */
const SENTENCE_UNIT = /[^。！？!?；;\r\n]+[。！？!?；;\r\n]+/gu

/** Sentence terminators shared by every sentence-unit metric. */
export const UNIT_PATTERN = SENTENCE_UNIT

/** Whether a code unit is a sentence terminator. */
export function isSentenceTerminator(code: number): boolean {
  return code === 0x3002 || code === 0xff01 || code === 0xff1f || code === 0x21 || code === 0x3f
    || code === 0xff1b || code === 0x3b || code === 0x0d || code === 0x0a
}

/**
 * Count sentence terminators without running the backtracking-prone unit
 * pattern. Every unit produced by {@link UNIT_PATTERN} ends with at least one
 * terminator, so a window with fewer terminators than a threshold cannot reach
 * that many units.
 * @param text - candidate window.
 * @returns terminator count, never negative.
 */
export function countTerminators(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) if (isSentenceTerminator(text.charCodeAt(index))) count += 1
  return count
}

/** Whitespace and line terminators that `String.prototype.trim` removes. */
export function isTrimBlank(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff
}

/**
 * Whether a trailing window can carry periodic evidence: at least two non-blank
 * code points and two distinct code points, tested without allocating a slice or
 * a Set. Equivalent to `pattern.trim().length >= 2 && new Set(pattern).size >= 2`.
 * @param raw - the retained window.
 * @param period - trailing length to inspect.
 * @returns whether the trailing window can serve as a periodic pattern.
 */
export function patternIsInformative(raw: string, period: number): boolean {
  let index = raw.length - period
  let first = -1
  let nonBlank = 0
  let distinct = false
  while (index < raw.length) {
    const code = raw.codePointAt(index)
    if (code === undefined) break
    index += code > 0xffff ? 2 : 1
    if (!isTrimBlank(code)) nonBlank += 1
    if (first === -1) first = code
    else if (code !== first) distinct = true
    if (nonBlank >= 2 && distinct) return true
  }
  return false
}
