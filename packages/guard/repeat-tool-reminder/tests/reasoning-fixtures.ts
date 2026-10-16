/**
 * De-identified reasoning corpora for the output-policy specs. They preserve the
 * observable shape of the recorded sessions they come from — sentence length,
 * micro-variation, interjection density, and fence usage — without any project
 * text, path, or private identifier.
 */

/** A short analysis prelude: ordinary reasoning that must always pass through. */
export const reasoningPrelude =
  '用户报告重放投影不匹配。先确认模块边界：读取两个源文件，核对导出签名与测试期望，'
  + '再决定是修改实现还是补充测试。当前 epoch 元数据不同，不能复用旧签名。'

const loopInterjections = ['好。', '执行。', '直接做。', '然后审查。', '果断。']
const loopInstructions = ['读两个文件，审查代码。', '我果断输出 read 工具调用。']
const loopVariation = (index: number): string => `让me执行 read alpha.mjs + read alpha.test.mjs，然后核对第 ${index} 个用例的重放签名。`

/**
 * The loop shape that was recorded in production: instructions to read the same
 * two files with interjections recurring verbatim, while the long sentences
 * change by a counter so no copy is byte-identical. Repetition therefore covers
 * a minority of the window characters, which is why whole-unit evidence missed it.
 * @param cycles - how many variation cycles to emit (30 covers ~5,000 characters).
 * @returns the de-identified loop corpus.
 */
export function nearDuplicateLoop(cycles: number): string {
  let text = ''
  for (let index = 0; index < cycles; index += 1) {
    for (let step = 0; step < loopInterjections.length; step += 1) {
      text += loopInterjections[(index + step) % loopInterjections.length]
    }
    for (let step = 0; step < loopInstructions.length; step += 1) {
      text += loopInstructions[(index + step) % loopInstructions.length]
    }
    text += loopVariation(index * 2)
    text += loopVariation(index * 2 + 1)
  }
  return text
}

/** Long reasoning whose sentences are unique per decision, apart from shared boilerplate. */
export function ordinaryReasoning(lines: number): string {
  return Array.from({ length: lines }, (_, index) =>
    `核对第 ${index} 个用例：textA_${index} 与 textB_${index + 1} 的 epoch 不同，`
    + `不能删除新增标识符，也不能套用第 ${index * 7} 行的旧签名结论。`).join('')
}

/**
 * Ordinary progress expressed as one recurring interjection plus a sentence that
 * carries new identifiers, counter values, and an alternating verdict. The filler
 * recurs; the content does not, so this must never be treated as a loop.
 * @param lines - how many progress sentences to emit.
 * @returns the de-identified progress corpus.
 */
export function indexedProgress(lines: number): string {
  return Array.from({ length: lines }, (_, index) =>
    `好。检查 request_${index} 与 response_${index + 1} 的关系，当前结果 ${index % 2 === 0 ? '允许' : '不允许'}，epoch=${1000 + index}。\n`).join('')
}

/** A fenced code example whose body repeats scaffold lines that must not read as repeated prose. */
export function fencedScaffold(fence: string, repeats: number): string {
  const body = `${fence}ts\n`
    + Array.from({ length: repeats }, (_, index) =>
      `const case${index} = await run('alpha.mjs', { epoch: ${index} })\n`
      + `expect(case${index}).resolves.toEqual({ epoch: ${index} })\n`).join('')
    + `${fence}\n`
  return body
}
