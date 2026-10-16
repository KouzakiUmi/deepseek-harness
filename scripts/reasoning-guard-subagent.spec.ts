/** Cross-package ownership checks for guard recovery in native child activations. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as Guard from '@deepseek-ai/dsh-repeat-tool-reminder'
import { mountLocalActivations, startTestActivation } from '../packages/subagent/subagent/tests/local-activation.ts'

const phrase = '执行。好。写。让我输出2个edit。停止循环。现在输出工具调用。'
const prefix = 'textA/textB 的 epoch 必须分别核对，不能套用旧签名。'
function answer(text: string): StreamChunk[] {
  return [{ type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }]
}
const loop: StreamChunk[] = [{ type: 'reasoning-delta', index: 0, text: prefix + phrase.repeat(200) }]

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, reasoningReplay: 'editable-plain' })
  }
  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('unexpected child restart')
    yield* chunks
  }
}

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function setup(recoveries: number, responses: StreamChunk[][]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  await ctx.plugin(Guard, { reasoningLoop: {
    windowChars: 2048, scanChars: 16, holdChars: 160, confirmChars: 480,
    cancelChars: 4096, recoveryChars: 160, maxPeriodChars: 128,
    minPoolUnits: 12, poolShare: 0.72, visibleStall: false, maxRecoveries: recoveries, settlementBudget: 65536,
  } })
  const adapter = new Adapter(responses)
  ctx.llm.registerAdapter(['fixture'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('guard-parent'), { provider: 'fixture', model: 'fixture' })
  parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'parent seed' }] }))
  await parent.whenIdle()
  return { ctx, parent, adapter }
}

describe('reasoning guard recovery preserves native activation ownership', () => {
  it.each(['spawn', 'fork'])('%s recovers before idle and settles its result only once', async (provider) => {
    const { ctx, parent, adapter } = await setup(1, [answer('parent ready'), loop, answer('child recovered')])
    const starts: string[] = []
    const ends: string[] = []
    let errors = 0
    const childStatuses: string[] = []
    ctx.on('subagent/start', ({ id }) => { starts.push(id) })
    ctx.on('subagent/end', ({ id }) => { ends.push(id) })
    ctx.on('agent/error', () => { errors += 1 })
    ctx.on('agent/status', ({ agent, status }) => { if (agent !== parent) childStatuses.push(status) })
    const run = await startTestActivation(ctx, provider, { parent, prompt: [{ type: 'text', text: 'inspect both epochs' }] })
    const child = run.localAgent
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'child recovered' }])
    expect(starts).toEqual([child.id])
    expect(ends).toEqual([child.id])
    expect(childStatuses).toEqual(['running', 'idle'])
    expect(errors).toBe(0)
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[1]?.sessionId).toBe(child.id)
    expect(adapter.requests[2]?.sessionId).toBe(child.id)
    expect(child.session.header.parentSession).toBe(parent.id)
    expect(child.session.header.delegationDepth).toBe(1)
    const own = child.session.snapshotEvents().slice(child.session.inheritedEventCount)
    expect(own.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(own.filter(event => event.type === 'assistant/message' && event.data.interrupted)).toHaveLength(1)
    expect(own.filter(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')).toHaveLength(1)
    expect(ctx.agents.get(child.id)).toBeUndefined()
    await run.dispose()
  })

  it('exhaustion settles a failed child once rather than restarting a disposed activation', async () => {
    const { ctx, parent, adapter } = await setup(1, [answer('parent ready'), loop, loop, answer('must not run')])
    const ends: string[] = []
    ctx.on('subagent/end', ({ id }) => { ends.push(id) })
    const run = await startTestActivation(ctx, 'spawn', { parent, prompt: [{ type: 'text', text: 'inspect both epochs' }] })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(ends).toEqual([run.id])
    expect(adapter.requests).toHaveLength(3)
    expect(ctx.agents.get(run.id)).toBeUndefined()
    await run.dispose()
  })

  it('parent interruption wins before the local continuation is admitted', async () => {
    const { ctx, parent, adapter } = await setup(1, [answer('parent ready'), loop, answer('must not run')])
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent !== parent && frame.type === 'end' && frame.outcome.kind === 'committed') agent.cancel({ kind: 'parent' })
    })
    const run = await startTestActivation(ctx, 'fork', { parent, prompt: [{ type: 'text', text: 'inspect both epochs' }] })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(adapter.requests).toHaveLength(2)
    expect(run.localAgent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'reasoning-loop-recovery')).toBe(false)
    await run.dispose()
  })
})
