/** SDK transport projection of the real headless guard transcript, not another loop implementation. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { createProcessDeepSeekHarness } from '../src/api.ts'
import { isRecord } from '../src/client.ts'

it('retains the interrupted prefix and attributed continuation until the final SDK result', async () => {
  const fixture = new URL('../../../../snapshots/session/reasoning-loop-recovery/session.v4.jsonl', import.meta.url)
  const rows = (await readFile(fixture, 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line))
    .filter(row => isRecord(row) && (row.type === 'assistant/message'
      || row.type === 'user/message' && isRecord(row.data) && isRecord(row.data.source) && row.data.source.kind === 'reasoning-loop-recovery'))
  const harness = createProcessDeepSeekHarness({
    command: process.execPath, args: [fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))],
    environment: () => ({ ...process.env, FAKE_TEXT: '', FAKE_SESSION_EVENTS: JSON.stringify(rows) }),
    description: 'guard transcript SDK projection', initializeTimeoutMs: 5000,
  })
  try {
    const result = await harness.run('inspect both epochs')
    const partial = result.events.find(event => event.type === 'assistant/message' && event.data.interrupted)
    const continuation = result.events.find(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')
    if (partial?.type !== 'assistant/message' || continuation?.type !== 'user/message') throw new Error('missing guard transcript')
    const last = expandAssistantStream(partial.data.stream).at(-1)?.chunk
    const projection = {
      finalResponse: result.finalResponse,
      partialBlockTypes: partial.data.message.content.map(block => block.type),
      partialFailureCode: last?.type === 'finish' && last.reason.kind === 'error' ? last.reason.failure.code : undefined,
      continuationSource: continuation.data.source.kind,
      turnReasons: result.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
    }
    const expected: unknown = JSON.parse(await readFile(new URL('./expected/reasoning-loop-projection.json', import.meta.url), 'utf8'))
    expect(projection).toEqual(expected)
    expect(partial.seq).toBeLessThan(continuation.seq)
    expect(partial.data.message.source.replayState).toBeUndefined()
  } finally {
    await harness.close()
  }
})
