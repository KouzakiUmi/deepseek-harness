import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, expandAssistantStream, LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type ReasoningReplayCapability, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Plugin from '../src/index.ts'
import { ReasoningLoopConfig as reasoningLoopSchema, type ReasoningLoopConfig } from '../src/reasoning-policy.ts'
import { visibleStallDefaults } from '../src/visible-stall.ts'
import { fencedScaffold, indexedProgress, nearDuplicateLoop, ordinaryReasoning, reasoningPrelude } from './reasoning-fixtures.ts'

const settings: ReasoningLoopConfig = {
  windowChars: 2048, scanChars: 16, holdChars: 160, confirmChars: 480,
  cancelChars: 4096, recoveryChars: 160, maxPeriodChars: 128,
  minPoolUnits: 12, poolShare: 0.72, visibleStall: false, maxRecoveries: 0, settlementBudget: 65536,
}
const prefix = 'textA 与 textB 的 epoch 不同，需要分别核实重放元数据。'
const phrase = '执行。好。写。让我输出2个edit。停止循环。现在输出工具调用。'

function reasoning(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
  ]
}
function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class Scripted extends LlmAdapter {
  requests: GenerateOptions[] = []
  closed = 0
  yielded = 0
  cleanupError = false
  beforeStream: (() => Promise<void>) | undefined
  /** Deferred provider teardown: `finally` blocks until this settles. */
  cleanupGate: Promise<void> | undefined
  constructor(private readonly responses: StreamChunk[][], readonly capability?: ReasoningReplayCapability) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      ...this.capability === undefined ? {} : { reasoningReplay: this.capability },
    })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.beforeStream?.()
    try {
      const response = this.responses.shift()
      if (response === undefined) throw new Error('unexpected extra call')
      for (const chunk of response) { this.yielded += 1; yield chunk }
    } finally {
      this.closed += 1
      await this.cleanupGate
      if (this.cleanupError) throw new Error('scripted iterator cleanup failed')
    }
  }
}

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })

async function setup(adapter: Scripted, config: Partial<ReasoningLoopConfig> | false = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const policyFiber = await ctx.plugin(Plugin, { reasoningLoop: config === false ? false : Object.assign({}, settings, config) })
  ctx.llm.registerAdapter(['fixture'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('reasoning-policy'), { provider: 'fixture', model: 'fixture' })
  return { ctx, agent, policyFiber }
}
function start(agent: Awaited<ReturnType<typeof setup>>['agent']) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect textA and textB' }], source: { kind: 'user' } }))
  return agent.whenIdle()
}

describe('optional reasoning output policy through the real loop', () => {
  it('keeps native/unknown routes and disabled configuration byte-for-byte unchanged', async () => {
    const raw = prefix + phrase.repeat(180)
    for (const capability of [undefined, 'opaque', 'editable-plain'] as const) {
      const adapter = new Scripted([[...reasoning(raw), ...answer('done')]], capability)
      const { agent } = await setup(adapter, capability === 'editable-plain' ? false : {})
      await start(agent)
      const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(message?.type === 'assistant/message' && message.data.message.content[0]).toEqual({ type: 'reasoning', text: raw })
    }
  })

  it('sanitizes the authoritative block-end, durable stream, and live chunks together', async () => {
    const raw = prefix + phrase.repeat(28)
    const adapter = new Scripted([[...reasoning(raw), ...answer('done')]], 'editable-plain')
    const { ctx, agent } = await setup(adapter)
    const live: StreamChunk[] = []
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk') live.push(frame.chunk) })
    await start(agent)
    const event = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(event?.type).toBe('assistant/message')
    if (event?.type !== 'assistant/message') throw new Error('missing message')
    const block = event.data.message.content[0]
    expect(block?.type === 'reasoning' && block.text.startsWith(prefix)).toBe(true)
    expect(block?.type === 'reasoning' && block.text.length).toBeLessThan(raw.length)
    expect(expandAssistantStream(event.data.stream).map(record => record.chunk)).toEqual(live)
    const end = live.find(chunk => chunk.type === 'block-end' && chunk.index === 0)
    expect(end?.type === 'block-end' && end.block).toEqual(block)
    expect(event.data.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it('interrupts only this call without offering the local stop to request-error retry', async () => {
    const raw = prefix + phrase.repeat(200)
    const adapter = new Scripted([[...reasoning(raw), ...answer('must not finish')]], 'editable-plain')
    const { ctx, agent } = await setup(adapter)
    let recovery = 0
    ctx.on('agent/request-error', async () => { recovery += 1; return { kind: 'retry' } })
    await start(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.signal?.aborted).toBe(true)
    expect(adapter.closed).toBe(1)
    expect(recovery).toBe(0)
    const events = agent.session.snapshotEvents()
    const partial = events.find(event => event.type === 'assistant/message')
    expect(partial).toMatchObject({ data: { interrupted: true } })
    expect(JSON.stringify(partial).length).toBeLessThan(4000)
    expect(events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'REASONING_LOOP' } } } })
    expect(events.some(event => event.type === 'assistant/attempt')).toBe(false)
  })

  it('lets a short repetition finish and execute the genuine complete tool exactly once', async () => {
    const id = ToolCallId('actual-tool')
    const calls: StreamChunk[] = [
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id, name: 'probe', argumentsDelta: '{"epoch":2}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'probe', arguments: '{"epoch":2}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const adapter = new Scripted([[...reasoning(prefix + phrase.repeat(28)), ...calls], answer('finished')], 'editable-plain')
    const { ctx, agent } = await setup(adapter)
    let executions = 0
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'probe', parameters: {}, async execute() { executions += 1; return [{ type: 'text', text: 'observed' }] } }))
    await start(agent)
    expect(executions).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })

  it('does not disable reasoning detection merely because text has appeared', async () => {
    const adapter = new Scripted([[
      { type: 'reasoning-delta', index: 0, text: prefix },
      { type: 'text-delta', index: 1, text: 'I will inspect both epochs.' },
      { type: 'reasoning-delta', index: 0, text: phrase.repeat(200) },
      { type: 'finish', reason: { kind: 'stop' } },
    ]], 'editable-plain')
    const { agent } = await setup(adapter)
    await start(agent)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'REASONING_LOOP' } } } })
  })

  it('protects a complete tool while still suppressing later reasoning copies', async () => {
    const id = ToolCallId('protected-tool')
    const raw = prefix + phrase.repeat(200)
    const adapter = new Scripted([[
      { type: 'reasoning-delta', index: 0, text: prefix },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'probe', arguments: '{}' } },
      { type: 'reasoning-delta', index: 0, text: phrase.repeat(200) },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ], answer('done')], 'editable-plain')
    const { ctx, agent } = await setup(adapter)
    let calls = 0
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { calls += 1; return [{ type: 'text', text: 'done' }] } }))
    await start(agent)
    expect(calls).toBe(1)
    const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && message.data.message.content[0]?.type === 'reasoning' && message.data.message.content[0].text.length).toBeLessThan(1800)
  })

  it.each(['reasoning', 'empty-events'] as const)('bounds unfinished tool settlement with continued %s without dispatch or recovery', async (mode) => {
    const tail: StreamChunk = mode === 'reasoning'
      ? { type: 'reasoning-delta', index: 0, text: phrase.repeat(200) }
      : { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    const adapter = new Scripted([[
      { type: 'reasoning-delta', index: 0, text: prefix },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('never-dispatched'), name: 'probe', arguments: '{}' } },
      ...Array.from({ length: 100 }, () => tail),
    ]], 'editable-plain')
    const { ctx, agent } = await setup(adapter, { maxRecoveries: 1, settlementBudget: 4 })
    let calls = 0
    let retries = 0
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { calls += 1; return [] } }))
    ctx.on('agent/request-error', async () => { retries += 1; return { kind: 'retry' } })
    await start(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.yielded).toBeLessThan(20)
    expect(adapter.closed).toBe(1)
    expect(calls).toBe(0)
    expect(retries).toBe(0)
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'tool/call')).toBe(false)
    expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')).toBe(false)
    const partial = events.find(event => event.type === 'assistant/message')
    expect(partial?.type === 'assistant/message' && partial.data.message.content.some(block => block.type === 'tool-call')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TOOL_SETTLEMENT_LIMIT' } } } })
  })

  it('never treats a valid-looking tool argument delta as a complete executable call', async () => {
    const adapter = new Scripted([[
      { type: 'tool-call-delta', index: 1, id: ToolCallId('incomplete-tool'), name: 'probe', argumentsDelta: '{}' },
      { type: 'reasoning-delta', index: 0, text: prefix + phrase.repeat(200) },
      { type: 'finish', reason: { kind: 'stop' } },
    ]], 'editable-plain')
    const { ctx, agent } = await setup(adapter)
    let calls = 0
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { calls += 1; return [{ type: 'text', text: 'done' }] } }))
    await start(agent)
    expect(calls).toBe(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/call')).toBe(false)
  })

  it('removes the output policy when its plugin fiber unloads', async () => {
    const raw = prefix + phrase.repeat(180)
    const adapter = new Scripted([[...reasoning(raw), ...answer('done')]], 'editable-plain')
    const { agent, policyFiber } = await setup(adapter)
    await policyFiber.dispose()
    await start(agent)
    const event = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(event?.type === 'assistant/message' && event.data.message.content[0]).toEqual({ type: 'reasoning', text: raw })
  })

  it('persists a safe prefix and attributed continuation before another call in the same activity', async () => {
    const adapter = new Scripted([[...reasoning(prefix + phrase.repeat(200)), ...answer('unreachable')], answer('recovered')], 'editable-plain')
    const { ctx, agent } = await setup(adapter, { maxRecoveries: 1 })
    const statuses: string[] = []
    let errors = 0
    let retries = 0
    ctx.on('agent/status', ({ status }) => { statuses.push(status) })
    ctx.on('agent/error', () => { errors += 1 })
    ctx.on('agent/request-error', async () => { retries += 1; return { kind: 'retry' } })
    await start(agent)
    expect(adapter.requests).toHaveLength(2)
    expect(statuses).toEqual(['running', 'idle'])
    expect(errors).toBe(0)
    expect(retries).toBe(0)
    const events = agent.session.snapshotEvents()
    const partial = events.find(event => event.type === 'assistant/message' && event.data.interrupted)
    expect(partial?.type).toBe('assistant/message')
    if (partial?.type !== 'assistant/message') throw new Error('missing retained prefix')
    expect(partial.data.message.source.replayState).toBeUndefined()
    expect(partial.data.message.content.every(block => block.type !== 'tool-call')).toBe(true)
    expect(adapter.requests[1]?.messages).toContainEqual(partial.data.message)
    const continuation = events.find(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')
    expect(continuation?.type).toBe('user/message')
    if (continuation?.type !== 'user/message') throw new Error('missing durable continuation')
    expect(continuation.data.source).toEqual({
      kind: 'reasoning-loop-recovery', turn: 1, step: 1, attempt: 1, limit: 1,
    })
    expect(adapter.requests[1]?.messages).toContainEqual(continuation.data)
    expect(partial.seq).toBeLessThan(continuation.seq)
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('publishes the policy interruption before a stalled provider cleanup finishes', async () => {
    const raw = prefix + phrase.repeat(200)
    const adapter = new Scripted([[...reasoning(raw), ...answer('unreachable')], answer('recovered')], 'editable-plain')
    let releaseCleanup: () => void = () => {}
    adapter.cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const { ctx, agent } = await setup(adapter, { maxRecoveries: 1 })
    const frames: StreamChunk[] = []
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk') frames.push(frame.chunk) })
    const idle = start(agent)
    try {
      await vi.waitFor(
        () => {
          expect(frames.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(true)
        },
        { timeout: 5_000, interval: 10 },
      )
      // The guard cut the call; provider cleanup is still parked, so nothing
      // durable exists yet and the frame above is the reader's only evidence.
      expect(adapter.closed).toBe(1)
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
      const finishes = frames.filter(chunk => chunk.type === 'finish')
      expect(finishes).toHaveLength(1)
      const cut = finishes[0]
      expect(cut?.reason.kind).toBe('error')
      expect(cut?.reason.kind === 'error' ? cut.reason.failure.code : undefined).toBe('REASONING_LOOP')
      expect(cut?.reason.kind === 'error' ? typeof cut.reason.failure.message : undefined).toBe('string')
    } finally {
      releaseCleanup()
    }
    await idle
    // Cleanup adds nothing: one policy finish, one interrupted settlement, one continuation.
    expect(frames.filter(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toHaveLength(1)
    const events = agent.session.snapshotEvents()
    const partial = events.find(event => event.type === 'assistant/message' && event.data.interrupted)
    expect(partial?.type).toBe('assistant/message')
    if (partial?.type !== 'assistant/message') throw new Error('missing retained prefix')
    expect(expandAssistantStream(partial.data.stream)
      .filter(record => record.chunk.type === 'finish')
      .map(record => record.chunk)).toEqual(frames.filter(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'))
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('numbers each recovery against the configured Turn limit', async () => {
    const loop = [...reasoning(prefix + phrase.repeat(200)), ...answer('unreachable')]
    const adapter = new Scripted([loop, loop, loop, answer('must not run')], 'editable-plain')
    const { agent } = await setup(adapter, { maxRecoveries: 2 })
    await start(agent)
    expect(adapter.requests).toHaveLength(3)
    const recoveries = agent.session.snapshotEvents()
      .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery'
        ? [event.data.source]
        : [])
    expect(recoveries).toEqual([
      { kind: 'reasoning-loop-recovery', turn: 1, step: 1, attempt: 1, limit: 2 },
      { kind: 'reasoning-loop-recovery', turn: 1, step: 1, attempt: 2, limit: 2 },
    ])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'REASONING_LOOP' } } } })
  })

  it('bounds local recovery independently of the ordinary retry policy', async () => {
    const loop = [...reasoning(prefix + phrase.repeat(200)), ...answer('unreachable')]
    const adapter = new Scripted([loop, loop, answer('must not run')], 'editable-plain')
    const { ctx, agent } = await setup(adapter, { maxRecoveries: 1 })
    let retries = 0
    ctx.on('agent/request-error', async () => { retries += 1; return { kind: 'retry' } })
    await start(agent)
    expect(adapter.requests).toHaveLength(2)
    expect(retries).toBe(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')).toHaveLength(1)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'REASONING_LOOP' } } } })
  })

  it.each(['user', 'parent', 'disposed'] as const)('lets %s cancellation win after prefix settlement without reviving the activity', async (kind) => {
    const adapter = new Scripted([[...reasoning(prefix + phrase.repeat(200)), ...answer('unused')], answer('must not run')], 'editable-plain')
    const { ctx, agent } = await setup(adapter, { maxRecoveries: 1 })
    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'end' && frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message') agent.cancel({ kind })
    })
    await start(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind } } } })
  })

  it('finishes a captured guard stop but cannot resume after its policy fiber is disposed', async () => {
    const adapter = new Scripted([[...reasoning(prefix + phrase.repeat(200)), ...answer('unused')], answer('must not run')], 'editable-plain')
    const { agent, policyFiber } = await setup(adapter, { maxRecoveries: 1 })
    adapter.beforeStream = async () => { await policyFiber.dispose() }
    await start(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'REASONING_LOOP' } } } })
  })

  it('reports iterator cleanup failure rather than recovering on a guard-like error string', async () => {
    const adapter = new Scripted([[...reasoning(prefix + phrase.repeat(200)), ...answer('unused')]], 'editable-plain')
    adapter.cleanupError = true
    const { ctx, agent } = await setup(adapter, { maxRecoveries: 1 })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    await start(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(AggregateError)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
  })
})

describe('detection stages through the real loop', () => {
  /** Hold without confirming, so the release path is the barrier that ends the block. */
  const patient: Partial<ReasoningLoopConfig> = { visibleStall: { ...visibleStallDefaults, confirmWindows: 1000 } }

  it('announces one stage per transition, outside the durable stream', async () => {
    const text = reasoningPrelude + nearDuplicateLoop(12)
    const adapter = new Scripted([[...reasoning(text), ...answer('done')]], 'editable-plain')
    const { ctx, agent } = await setup(adapter, patient)
    const stages: string[] = []
    const chunks: StreamChunk[] = []
    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'stage') stages.push(frame.stage)
      if (frame.type === 'chunk') chunks.push(frame.chunk)
    })
    await start(agent)
    expect(stages).toEqual(['suspected', 'barrier'])
    const event = agent.session.snapshotEvents().find(candidate => candidate.type === 'assistant/message')
    expect(event?.type).toBe('assistant/message')
    if (event?.type !== 'assistant/message') throw new Error('missing message')
    // A stage never becomes a streamed record or message content.
    expect(expandAssistantStream(event.data.stream).map(record => record.chunk)).toEqual(chunks)
    expect(event.data.message.content.every(block => block.type !== 'text' || block.text === 'done')).toBe(true)
  })

  it('announces nothing for ordinary output or fenced scaffolding', async () => {
    for (const text of [ordinaryReasoning(60), fencedScaffold('```', 40)]) {
      const adapter = new Scripted([[...reasoning(text), ...answer('done')]], 'editable-plain')
      const { ctx, agent } = await setup(adapter)
      let stages = 0
      ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'stage') stages += 1 })
      await start(agent)
      expect(stages).toBe(0)
    }
  })

  it('announces the hold but no release when repetition is confirmed', async () => {
    const loop = [...reasoning(reasoningPrelude + nearDuplicateLoop(30)), ...answer('unreachable')]
    const adapter = new Scripted([loop], 'editable-plain')
    const { ctx, agent } = await setup(adapter, { visibleStall: visibleStallDefaults, maxRecoveries: 0 })
    const stages: string[] = []
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'stage') stages.push(frame.stage) })
    await start(agent)
    expect(stages).toEqual(['suspected'])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'REASONING_LOOP' } } } })
  })

  it('announces no release after the user cancels the call', async () => {
    const text = reasoningPrelude + nearDuplicateLoop(12)
    const adapter = new Scripted([[...reasoning(text), ...answer('unused')]], 'editable-plain')
    const { ctx, agent } = await setup(adapter, patient)
    const stages: string[] = []
    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type !== 'stage') return
      stages.push(frame.stage)
      if (frame.stage === 'suspected') agent.cancel({ kind: 'user' })
    })
    await start(agent)
    expect(stages).toEqual(['suspected'])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  })

  it('announces nothing once the policy fiber is disposed', async () => {
    const text = reasoningPrelude + nearDuplicateLoop(12)
    const adapter = new Scripted([[...reasoning(text), ...answer('done')]], 'editable-plain')
    const { ctx, agent, policyFiber } = await setup(adapter, patient)
    await policyFiber.dispose()
    let stages = 0
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'stage') stages += 1 })
    await start(agent)
    expect(stages).toBe(0)
  })
})

describe('visible stall stall through the real loop', () => {
  const stalled: Partial<ReasoningLoopConfig> = { visibleStall: visibleStallDefaults, maxRecoveries: 1 }
  const loopText = reasoningPrelude + nearDuplicateLoop(30)

  it('stops a near-duplicate loop that whole-copy evidence never proves', async () => {
    const adapter = new Scripted([[...reasoning(loopText), ...answer('unreachable')], answer('recovered')], 'editable-plain')
    const { agent } = await setup(adapter, stalled)
    await start(agent)
    expect(adapter.requests).toHaveLength(2)
    const events = agent.session.snapshotEvents()
    const partial = events.find(event => event.type === 'assistant/message' && event.data.interrupted)
    expect(partial?.type).toBe('assistant/message')
    if (partial?.type !== 'assistant/message') throw new Error('missing interrupted message')
    const block = partial.data.message.content[0]
    expect(block?.type === 'reasoning' && block.text).toBe(loopText.slice(0, visibleStallDefaults.windowChars))
    const continuation = events.find(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')
    expect(continuation?.type).toBe('user/message')
    if (continuation?.type !== 'user/message') throw new Error('missing durable continuation')
    const prompt = continuation.data.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('unconfirmed repetitive tail')
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('lets indexed progress with a recurring interjection finish untouched', async () => {
    const progress = indexedProgress(80)
    const adapter = new Scripted([[...reasoning(progress), ...answer('finished')]], 'editable-plain')
    const { agent } = await setup(adapter, stalled)
    await start(agent)
    const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && message.data.message.content[0]).toEqual({ type: 'reasoning', text: progress })
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('decides identically for one huge delta and for one-character deltas', async () => {
    async function decide(size: number) {
      const deltas: StreamChunk[] = []
      for (let offset = 0; offset < loopText.length; offset += size) {
        deltas.push({ type: 'reasoning-delta', index: 0, text: loopText.slice(offset, offset + size) })
      }
      const adapter = new Scripted([[...deltas, ...answer('unused')]], 'editable-plain')
      const { agent } = await setup(adapter, stalled)
      await start(agent)
      const events = agent.session.snapshotEvents()
      const last = events.at(-1)
      return {
        reason: last?.type === 'turn/end' ? last.data.reason : undefined,
        content: events.find(event => event.type === 'assistant/message')?.data.message.content,
      }
    }
    const whole = await decide(loopText.length)
    for (const size of [1, 7, 511]) expect(await decide(size)).toEqual(whole)
  })

  it('releases stall-withheld text at an interleaved barrier without losing or reordering it', async () => {
    const held = 'read both files before deciding'
    const adapter = new Scripted([[
      { type: 'reasoning-delta', index: 0, text: loopText },
      { type: 'text-delta', index: 1, text: held },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: loopText } },
      { type: 'block-end', index: 1, block: { type: 'text', text: held } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]], 'editable-plain')
    const { agent } = await setup(adapter, { visibleStall: { ...visibleStallDefaults, confirmWindows: 1000 }, maxRecoveries: 1 })
    await start(agent)
    const events = agent.session.snapshotEvents()
    const message = events.find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && message.data.message.content[0]).toEqual({ type: 'reasoning', text: loopText })
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('still lets proven exact copies cancel while the stall is enabled', async () => {
    const cycle = 'execute-write-next-call'.repeat(400)
    const adapter = new Scripted([[...reasoning(cycle), ...answer('unreachable')], answer('recovered')], 'editable-plain')
    const { agent } = await setup(adapter, stalled)
    await start(agent)
    const events = agent.session.snapshotEvents()
    const partial = events.find(event => event.type === 'assistant/message' && event.data.interrupted)
    expect(partial?.type).toBe('assistant/message')
    if (partial?.type !== 'assistant/message') throw new Error('missing interrupted message')
    const block = partial.data.message.content[0]
    expect(block?.type === 'reasoning' && block.text.length).toBeLessThan(cycle.length)
    const continuation = events.find(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')
    expect(continuation?.type).toBe('user/message')
    if (continuation?.type !== 'user/message') throw new Error('missing durable continuation')
    const prompt = continuation.data.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('repeated copies were discarded')
  })

  it('leaves the same near-duplicate loop unfiltered when the stall is disabled', async () => {
    const adapter = new Scripted([[...reasoning(loopText), ...answer('not a loop')]], 'editable-plain')
    const { agent } = await setup(adapter, { visibleStall: false })
    await start(agent)
    const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && message.data.message.content[0]).toEqual({ type: 'reasoning', text: loopText })
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('defaults the stall on and rejects a budget that breaks its bounds', async () => {
    expect(reasoningLoopSchema(undefined).visibleStall).toEqual(visibleStallDefaults)
    expect(reasoningLoopSchema({ ...settings, visibleStall: false }).visibleStall).toBe(false)
    await expect(setup(new Scripted([], 'editable-plain'), { visibleStall: { ...visibleStallDefaults, shingleShare: 0.2 } }))
      .rejects.toThrow('reasoningLoop.visibleStall')
    await expect(setup(new Scripted([], 'editable-plain'), { maxRecoveries: -1 })).rejects.toThrow('maxRecoveries')
    await expect(setup(new Scripted([], 'editable-plain'), { settlementBudget: 0 })).rejects.toThrow('settlementBudget')
  })
})
