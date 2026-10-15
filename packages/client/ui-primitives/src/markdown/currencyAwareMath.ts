/** Preserve dollar prices without changing upstream math tokens or source positions. */

import { math } from 'micromark-extension-math'
import { codes } from 'micromark-util-symbol'
import type { Construct, Extension, Tokenizer } from 'micromark-util-types'

function guardDollarBoundary(construct: Construct): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const start = this.now()
    return construct.tokenize.call(this, effects, (code) => {
      const source = this.sliceSerialize({ start, end: this.now() })
      if (!source.startsWith('$$')) {
        const followedByDigit = code !== null && code >= 48 && code <= 57
        const closingSpace = /\s/u.test(source.slice(-2, -1))
        const currencyProse = /^\$[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?=\s|[,;，；])/u.test(source)
          && /\p{Script=Han}|(?:\s|[(),;:，；：（）])[A-Za-z]{2,}/u.test(source)
          && !/[\\^_=+*<>]/u.test(source)
        // Prices must not close each other or consume a later formula. Other
        // formulas retain upstream padding, including asymmetric whitespace.
        if (followedByDigit || (closingSpace && currencyProse)) return nok(code)
      }
      return ok(code)
    }, nok)
  }
  return { ...construct, tokenize }
}

/**
 * Reuse dollar math with currency-safe single-dollar closing boundaries.
 * @returns Upstream math grammar with guarded inline dollar constructs.
 * @throws If the installed math extension no longer declares dollar text syntax.
 */
export function currencyAwareMath(): Extension {
  const extension = math()
  const dollar = extension.text?.[codes.dollarSign]
  if (dollar === undefined) throw new Error('The math extension must declare dollar text syntax')
  return {
    ...extension,
    text: {
      ...extension.text,
      [codes.dollarSign]: Array.isArray(dollar) ? dollar.map(guardDollarBoundary) : guardDollarBoundary(dollar),
    },
  }
}
