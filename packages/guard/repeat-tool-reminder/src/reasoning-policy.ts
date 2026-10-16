/** Optional reasoning-copy policy, independent of advisory tool-call reminders. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AssistantOutputInterruption, AssistantOutputItem, AssistantOutputPolicy } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ReasoningWatch, validateReasoningWatchConfig, type ReasoningWatchConfig } from './reasoning-watch.ts'
import {
  VisibleStallWatch, validateVisibleStallConfig, visibleStallDefaults,
  type VisibleStallConfig, type VisibleStallStage,
} from './visible-stall.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The continuation this guard injects after locally interrupting a
     * reasoning call. It addresses the Step it continues, so a presentation
     * consumer can place and count the recovery without re-deriving either
     * fact from the surrounding window.
     */
    'reasoning-loop-recovery': {
      kind: 'reasoning-loop-recovery'
      /** Turn whose call was interrupted and continued. */
      turn: number
      /** Step whose call was interrupted and continued. */
      step: number
      /** One-based ordinal of this recovery among the Turn's recoveries. */
      attempt: number
      /** Recoveries one Turn may start, as configured on this deployment. */
      limit: number
    }
  }
}

/** Explicit opt-in settings for editable-plain conversation-model output. */
export interface ReasoningLoopConfig extends ReasoningWatchConfig {
  /**
   * Visible-output stall, or `false` to filter only proven exact copies. A stall
   * holds output that looks repetitive, so `maxWindowChars` bounds the characters
   * withheld from the user and session at any moment.
   */
  visibleStall: false | VisibleStallConfig
  /** Maximum locally interrupted calls resumed within one turn, including native child agents. */
  maxRecoveries: number
  /** Post-tool settlement budget: each received event costs one plus its new delta's UTF-16 characters. */
  settlementBudget: number
}

/** Dam settings, defaulted field-by-field so a deployment may override one budget without restating the rest. */
const visibleStallConfig: z<VisibleStallConfig> = z.object({
  windowChars: z.number().default(visibleStallDefaults.windowChars),
  maxWindowChars: z.number().default(visibleStallDefaults.maxWindowChars),
  scanChars: z.number().default(visibleStallDefaults.scanChars),
  minUnits: z.number().default(visibleStallDefaults.minUnits),
  unitShare: z.number().default(visibleStallDefaults.unitShare),
  unitCharShare: z.number().default(visibleStallDefaults.unitCharShare),
  shingleChars: z.number().default(visibleStallDefaults.shingleChars),
  shingleShare: z.number().default(visibleStallDefaults.shingleShare),
  confirmWindows: z.number().default(visibleStallDefaults.confirmWindows),
  recoveryWindows: z.number().default(visibleStallDefaults.recoveryWindows),
})

/** Validated settings; omission at the owning plugin disables this policy entirely. */
export const ReasoningLoopConfig: z<ReasoningLoopConfig> = z.object({
  windowChars: z.number().default(4096),
  scanChars: z.number().default(32),
  holdChars: z.number().default(256),
  confirmChars: z.number().default(1024),
  cancelChars: z.number().default(16384),
  recoveryChars: z.number().default(256),
  maxPeriodChars: z.number().default(192),
  minPoolUnits: z.number().default(16),
  poolShare: z.number().default(0.75),
  visibleStall: z.union([z.const(false), visibleStallConfig]).default({}),
  maxRecoveries: z.number().default(1),
  settlementBudget: z.number().default(65536),
})

/** Why the policy ended a call locally. */
type ReasoningStopReason = 'repetition' | 'visible-repetition' | 'settlement-limit'

const RECOVERY_PROMPT = 'The preceding reasoning was interrupted after sustained repetition. Its retained prefix is available above; repeated copies were discarded. Continue the unfinished task using a different approach. Do not repeat that reasoning. Use the actual tool protocol when an action is needed.'

const VISIBLE_RECOVERY_PROMPT = 'The preceding reasoning was interrupted after sustained repetition of nearly identical sentences. Its retained prefix is available above exactly as written; the unconfirmed repetitive tail was discarded. Continue the unfinished task using a different approach. Do not repeat that reasoning. Use the actual tool protocol when an action is needed.'

const REPETITION_FAILURE = 'Reasoning output was interrupted after sustained exact-copy repetition.'

const VISIBLE_REPETITION_FAILURE = 'Reasoning output was interrupted after sustained repetition of nearly identical reasoning sentences.'

const SETTLEMENT_FAILURE = 'Output after a tool call exceeded the local settlement budget before finishing. No tools from this call were dispatched.'

/**
 * Filter one reasoning block without retaining another complete copy of its text.
 * Interleaved non-reasoning events release unresolved text before passing through.
 * Additional reasoning indexes are observed unchanged; the first remains protected
 * against a full block-end restoring any copies already suppressed.
 */
export class ReasoningOutputPolicy implements AssistantOutputPolicy {
  private readonly watch: ReasoningWatch
  private readonly stall: VisibleStallWatch | undefined
  private index: number | undefined
  private closed = false
  private localInterruption: AssistantOutputInterruption | undefined
  private settlementLeft: number | undefined
  private readonly settlementBudget: number

  constructor(
    config: ReasoningLoopConfig,
    private readonly interrupt: (reason: ReasoningStopReason) => AssistantOutputInterruption,
    /** Whether the owning plugin still authorizes this call's presentation. */
    private readonly enabled: () => boolean,
  ) {
    this.watch = new ReasoningWatch(config)
    this.stall = config.visibleStall === false ? undefined : new VisibleStallWatch(config.visibleStall)
    this.settlementBudget = config.settlementBudget
  }

  get interruption(): AssistantOutputInterruption | undefined { return this.localInterruption }

  push(chunk: StreamChunk): readonly AssistantOutputItem[] {
    if (this.settlementLeft !== undefined && chunk.type !== 'finish') {
      const characters = chunk.type === 'reasoning-delta' || chunk.type === 'text-delta' ? chunk.text.length
        : chunk.type === 'tool-call-delta' ? chunk.argumentsDelta.length : 0
      const cost = 1 + characters
      if (cost > this.settlementLeft) {
        this.localInterruption = this.interrupt('settlement-limit')
        return this.flush()
      }
      this.settlementLeft -= cost
    }
    if (chunk.type === 'reasoning-delta') {
      if (this.index === undefined) this.index = chunk.index
      if (chunk.index !== this.index || this.closed) return [...this.flush(), chunk]
      const accepted = this.accept(chunk.text)
      const items: AssistantOutputItem[] = this.stageItems(accepted.stages)
      if (accepted.text.length > 0) items.push({ ...chunk, text: accepted.text })
      if (accepted.reason !== undefined) {
        items.push(...this.flush())
        this.localInterruption = this.interrupt(accepted.reason)
      }
      return items
    }
    const items = [...this.flush()]
    if (chunk.type === 'block-end' && chunk.block.type === 'reasoning' && chunk.index === this.index) {
      this.closed = true
      items.push({ type: 'accepted-reasoning-end', index: chunk.index })
    } else {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.id.length > 0 && chunk.block.name.length > 0) {
        this.watch.protectCommit()
        this.stall?.protectCommit()
        this.settlementLeft ??= this.settlementBudget
      }
      items.push(chunk)
    }
    return items
  }

  flush(): readonly AssistantOutputItem[] {
    const stall = this.stall
    // Withheld characters prove a barrier released a real hold, rather than a stage invented here.
    const items: AssistantOutputItem[] = stall !== undefined && stall.heldChars > 0
      ? this.stageItems(['barrier'])
      : []
    const withheld = stall?.flush() ?? ''
    const text = withheld.length === 0 ? this.watch.flush() : this.watch.release(withheld)
    if (text.length > 0 && this.index !== undefined) items.push({ type: 'reasoning-delta', index: this.index, text })
    return items
  }

  /**
   * Gate one delta through the stall, then through exact-copy filtering. The stall
   * sees every original character, so neither detector depends on delta
   * boundaries. Text the stall withholds reaches the exact-copy filter when the
   * stall releases it, and an interruption discards the withheld suffix instead.
   */
  private accept(text: string): {
    text: string
    reason?: 'repetition' | 'visible-repetition'
    stages: readonly VisibleStallStage[]
  } {
    const stall = this.stall
    if (stall === undefined) {
      const result = this.watch.push(text)
      return result.interrupt
        ? { text: result.text, reason: 'repetition', stages: [] }
        : { text: result.text, stages: [] }
    }
    let emitted = ''
    const stages: VisibleStallStage[] = []
    for (let position = 0; position < text.length; position += 1) {
      const gate = stall.push(text.charAt(position))
      // One character can start or end withholding; every transition is kept in
      // arrival order, so a single large delta reports its whole episode.
      if (gate.transition !== undefined) stages.push(gate.transition)
      if (gate.text.length > 0) {
        const filtered = this.watch.push(gate.text)
        emitted += filtered.text
        if (filtered.interrupt) return { text: emitted, reason: 'repetition', stages }
      }
      if (gate.interrupt) return { text: emitted, reason: 'visible-repetition', stages }
    }
    return { text: emitted, stages }
  }

  /** Announce each withholding transition this call made; a disposed policy announces nothing. */
  private stageItems(stages: readonly VisibleStallStage[]): AssistantOutputItem[] {
    const index = this.index
    if (index === undefined || stages.length === 0 || !this.enabled()) return []
    return stages.map(stage => ({ type: 'reasoning-stall', stage, index }))
  }
}

/**
 * Register the optional per-call policy; all listeners and recovery state belong to this fiber.
 * @param ctx - plugin scope, also limiting which Agents receive the policy.
 * @param config - complete resolved settings, validated before registration.
 */
export function installReasoningPolicy(ctx: Context, config: ReasoningLoopConfig): void {
  validateReasoningWatchConfig(config)
  if (config.visibleStall !== false) validateVisibleStallConfig(config.visibleStall)
  if (!Number.isSafeInteger(config.maxRecoveries) || config.maxRecoveries < 0) {
    throw new Error('reasoningLoop.maxRecoveries must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(config.settlementBudget) || config.settlementBudget < 1) {
    throw new Error('reasoningLoop.settlementBudget must be a positive safe integer')
  }
  const recoveries = new WeakMap<Agent, { turn: number; count: number }>()
  let active = true
  ctx.effect(() => () => { active = false })
  ctx.on('agent/output-policy', (call, next) => {
    const downstream = next()
    if (call.preparedCall?.reasoningReplay !== 'editable-plain') return downstream
    if (downstream !== undefined) throw new Error('only one assistant output policy may own a model call')
    return new ReasoningOutputPolicy(config, (reason) => {
      if (reason === 'settlement-limit') {
        return { failure: { code: 'TOOL_SETTLEMENT_LIMIT', message: SETTLEMENT_FAILURE } }
      }
      const visible = reason === 'visible-repetition'
      const previous = recoveries.get(call.agent)
      const count = previous?.turn === call.turn ? previous.count : 0
      recoveries.set(call.agent, { turn: call.turn, count: count + 1 })
      const continuation = !active || count >= config.maxRecoveries ? undefined : createUserMessage({
        content: [{ type: 'text', text: visible ? VISIBLE_RECOVERY_PROMPT : RECOVERY_PROMPT }],
        source: {
          kind: 'reasoning-loop-recovery',
          turn: call.turn,
          step: call.step,
          attempt: count + 1,
          limit: config.maxRecoveries,
        },
      })
      return {
        failure: { code: 'REASONING_LOOP', message: visible ? VISIBLE_REPETITION_FAILURE : REPETITION_FAILURE },
        // A captured policy finishes filtering, but disposal cannot authorize another call.
        get continuation() { return active ? continuation : undefined },
      }
    }, () => active)
  })
}
