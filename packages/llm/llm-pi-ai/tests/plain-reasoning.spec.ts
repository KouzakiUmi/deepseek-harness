import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createAssistantMessage, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
})

async function runtime(profile: PiAiProviderProfile) {
  let profiles = resolveProfiles({ deepseek: profile })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['deepseek'], new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('plain-reasoning-fixture-key'),
    auth: memoryAuth(),
  }))
  return { ctx, replace: (next: PiAiProviderProfile) => { profiles = resolveProfiles({ deepseek: next }) } }
}

function frames(delta: Record<string, unknown>): string[] {
  return [
    JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    '[DONE]',
  ]
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('explicit plain DeepSeek-style Chat Completions replay', () => {
  it('does not infer editing from the protocol, provider name, or absence of signatures', async () => {
    const server = await mockServer([])
    const { ctx } = await runtime({ baseURL: server.url })
    expect((await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })).reasoningReplay).toBeUndefined()
    expect(server.requests).toHaveLength(0)
  })

  it('binds the enforced plain mode to the prepared snapshot, not a later profile', async () => {
    const server = await mockServer([{ events: frames({ reasoning_content: 'plain reasoning', content: 'done' }) }])
    const { ctx, replace } = await runtime({ baseURL: server.url, reasoningReplay: 'plain' })
    const prepared = await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
    expect(prepared.reasoningReplay).toBe('editable-plain')
    replace({ baseURL: 'http://127.0.0.1:1', reasoningReplay: 'native' })
    const chunks = await collect(prepared.stream({ ...prepared.config, messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests).toHaveLength(1)
    expect((await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })).reasoningReplay).toBeUndefined()
  })

  it('puts a retained reasoning-only prefix in the next actual wire request without inventing text', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await runtime({ baseURL: server.url, reasoningReplay: 'plain' })
    const prefix = 'textA 与 textB 不同；epoch=500002 不能套用 epoch=500001 的签名。'
    const prepared = await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
    await collect(prepared.stream({ ...prepared.config, messages: [
      createAssistantMessage({ source: { provider: 'deepseek', model: 'deepseek-flash' }, content: [{ type: 'reasoning', text: prefix }] }),
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }),
    ] }))
    const assistant: unknown = expect.objectContaining({ role: 'assistant', content: prefix })
    const messages: unknown = expect.arrayContaining([assistant])
    expect(server.requests[0]).toMatchObject({ messages })
  })

  it('keeps a normal tool response reasoning selector rather than treating it as an opaque signature', async () => {
    const server = await mockServer([
      { events: [
        JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'original reasoning', tool_calls: [{ index: 0, id: 'tool_1', type: 'function', function: { name: 'probe', arguments: '{}' } }] }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), '[DONE]',
      ] },
      { events: textEvents },
    ])
    const { ctx } = await runtime({ baseURL: server.url, reasoningReplay: 'plain' })
    const prepared = await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
    const assembler = new BlockAssembler()
    for (const chunk of await collect(prepared.stream({ ...prepared.config, messages: [] }))) assembler.push(chunk)
    expect(assembler.finish.kind).toBe('tool-calls')
    const message = createAssistantMessage({
      source: { provider: 'deepseek', model: 'deepseek-flash', replayState: assembler.replayState },
      content: assembler.blocks().map(block => block.type === 'reasoning' ? { ...block, text: 'retained reasoning' } : block),
    })
    const next = await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
    await collect(next.stream({ ...next.config, messages: [message] }))
    const tools: unknown = expect.any(Array)
    const assistant: unknown = expect.objectContaining({ role: 'assistant', reasoning_content: 'retained reasoning', tool_calls: tools })
    const messages: unknown = expect.arrayContaining([assistant])
    expect(server.requests[1]).toMatchObject({ messages })
    expect(JSON.stringify(server.requests[1])).not.toContain('original reasoning')
  })

  it('rejects opaque reasoning_details even on the same Chat Completions API', async () => {
    const server = await mockServer([{ events: frames({ reasoning_content: 'summary', content: 'body', reasoning_details: [{ type: 'reasoning.encrypted', id: 'opaque', data: 'encrypted-fixture' }] }) }])
    const { ctx } = await runtime({ baseURL: server.url, reasoningReplay: 'plain' })
    const prepared = await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
    const chunks = await collect(prepared.stream({ ...prepared.config, messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'INCOMPATIBLE_REASONING_REPLAY' } } })
    expect(JSON.stringify(chunks)).not.toContain('encrypted-fixture')
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.replayState !== undefined)).toBe(false)
  })

  it('refuses opaque historical signatures rather than silently using foreign replay', async () => {
    const server = await mockServer([])
    const { ctx } = await runtime({ baseURL: server.url, reasoningReplay: 'plain' })
    const prepared = await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
    const chunks = await collect(prepared.stream({ ...prepared.config, messages: [createAssistantMessage({
      source: { provider: 'deepseek', model: 'deepseek-flash', replayState: {
        response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', stopReason: 'stop' },
        blocks: [{ type: 'reasoning', thinkingSignature: 'opaque-signature' }],
      } },
      content: [{ type: 'reasoning', text: 'do not edit signed bytes' }],
    })] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'INCOMPATIBLE_REASONING_REPLAY' } } })
    expect(server.requests).toHaveLength(0)
  })

  it('rejects plain mode on signature-oriented APIs at configuration resolution', () => {
    expect(() => resolveProfiles({ fixture: { api: 'anthropic-messages', baseURL: 'http://localhost', models: [{ id: 'm' }], reasoningReplay: 'plain' } })).toThrow('openai-completions')
  })
})
