import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantBlock, AssistantMessageNode, ConversationLocation, ConversationMatch,
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  AssistantChatData, AssistantInterruptionChatData, AssistantRecoveryChatData, AssistantStallStage,
} from '../contract/chat-nodes.ts'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'
import {
  displayFailure, emptyAssistantBlock, isTokenDelta, toAssistantBlock, toAssistantBlocks,
} from './event-projection.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Streaming, settled, or interrupted Assistant step. */
    'assistant-step': AssistantChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    /** Streaming, settled, or interrupted Assistant material for this Step. */
    'assistant-step': AssistantChatData
  }
}

interface AssistantState {
  readonly turn: number
  readonly step: number
  readonly blocks: readonly (AssistantBlock | undefined)[]
  readonly visibleBlocks: number
  readonly firstVisibleSeq: number | undefined
  readonly firstVisibleTime: number | undefined
  readonly firstTokenTime: number | undefined
  readonly final: ConversationMatch | undefined
  readonly usage: unknown
  /**
   * Settlements this Step already delivered before the current attempt, oldest
   * first. A locally interrupted call retains its prefix here, so the content a
   * reader already saw survives the attempt that continues it.
   */
  readonly retained: readonly AssistantMessageNode[]
  /** Continuation this Step consumed after a local interruption, when it consumed one. */
  readonly recovery: RecoveryFact | undefined
  /**
   * Failure that cut the running call before any durable settlement existed.
   * The guard publishes it when it decides, so a stalled provider cleanup
   * cannot leave a reader without the fact that output was truncated.
   */
  readonly interruption: AssistantInterruptionChatData | undefined
  /**
   * Latest stage the live attempt's repetition detection reported. Live state of
   * this attempt, never durable history: settled Steps and reopened windows
   * derive their row from the durable settlement alone.
   */
  readonly stall: AssistantStallStage | undefined
}

/** Durable facts of the continuation that resumes a locally interrupted call. */
type RecoveryFact = AssistantRecoveryChatData

function initialState(turn: number, step: number): AssistantState {
  return {
    turn,
    step,
    blocks: [],
    visibleBlocks: 0,
    firstVisibleSeq: undefined,
    firstVisibleTime: undefined,
    firstTokenTime: undefined,
    final: undefined,
    usage: undefined,
    retained: [],
    recovery: undefined,
    interruption: undefined,
    stall: undefined,
  }
}

function compactBlocks(blocks: readonly (AssistantBlock | undefined)[]): AssistantBlock[] {
  return blocks.filter((block): block is AssistantBlock => block !== undefined)
}

function blockIsVisible(block: AssistantBlock | undefined): boolean {
  if (block === undefined || block.kind === 'tool-call') return false
  if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
  return true
}

function countVisibleBlocks(blocks: readonly AssistantBlock[]): number {
  let count = 0
  for (const block of blocks) if (blockIsVisible(block)) count++
  return count
}

function hasVisibleContent(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some(blockIsVisible)
}

function hasInterruptionEvidence(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
  })
}

/**
 * Whether the Step still owes the reader a row: retained prefixes and a
 * pending continuation both outlive the attempt that produced them.
 */
function hasStepPresentation(state: AssistantState): boolean {
  return state.retained.length > 0 || state.recovery !== undefined
    || state.interruption !== undefined || state.stall !== undefined
}

function resetForRetry(state: AssistantState): AssistantState {
  return {
    ...initialState(state.turn, state.step),
    firstTokenTime: state.firstTokenTime,
    retained: state.retained,
    recovery: state.recovery,
    interruption: state.interruption,
  }
}

function updateChunk(
  state: AssistantState,
  chunk: StreamChunk,
  seq: number,
  time: number,
): AssistantState {
  if (chunk.type === 'tool-call-delta') {
    const previous = state.blocks[chunk.index]
    if (previous?.kind === 'tool-call' && previous.callId !== ''
      && (chunk.name === undefined || chunk.name === previous.name)
      && (state.firstTokenTime !== undefined || !isTokenDelta(chunk))) return state
  }
  const blocks = [...state.blocks]
  let changedIndex = -1
  let previousVisible = false
  switch (chunk.type) {
    case 'block-start':
      changedIndex = chunk.index
      previousVisible = blockIsVisible(blocks[chunk.index])
      blocks[chunk.index] = emptyAssistantBlock(chunk.blockType)
      break
    case 'text-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      blocks[chunk.index] = { kind: 'text', text: (previous?.kind === 'text' ? previous.text : '') + chunk.text }
      break
    }
    case 'reasoning-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      blocks[chunk.index] = { kind: 'reasoning', text: (previous?.kind === 'reasoning' ? previous.text : '') + chunk.text }
      break
    }
    case 'tool-call-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      // Tool Nodes own streamed arguments; Assistant protocol blocks retain identity until full settlement.
      blocks[chunk.index] = {
        kind: 'tool-call',
        callId: (previous?.kind === 'tool-call' ? previous.callId : '') || String(chunk.id),
        name: chunk.name ?? (previous?.kind === 'tool-call' ? previous.name : ''),
        argsRaw: previous?.kind === 'tool-call' ? previous.argsRaw : '',
      }
      break
    }
    case 'block-end':
      changedIndex = chunk.index
      previousVisible = blockIsVisible(blocks[chunk.index])
      blocks[chunk.index] = toAssistantBlock(chunk.block)
      break
    case 'usage':
      return { ...state, usage: chunk.usage }
    case 'finish': {
      // Only the loop guard's own cut is a truncation this Step reports; a
      // provider failure keeps its existing presentation.
      if (chunk.reason.kind !== 'error' || chunk.reason.failure.code !== REASONING_LOOP_CODE) return state
      return { ...state, interruption: displayFailure(chunk.reason.failure) }
    }
    default:
      return state
  }
  const visibleBlocks = state.visibleBlocks
    - Number(previousVisible)
    + Number(blockIsVisible(blocks[changedIndex]))
  const firstToken = isTokenDelta(chunk)
  return {
    ...state,
    blocks,
    visibleBlocks,
    ...visibleBlocks > 0 && state.firstVisibleSeq === undefined
      ? { firstVisibleSeq: seq, firstVisibleTime: time }
      : {},
    ...firstToken && state.firstTokenTime === undefined
      ? { firstTokenTime: time }
      : {},
  }
}

/** Durable presentation node of one Assistant settlement in this Step. */
function settlementNode(
  state: Pick<AssistantState, 'turn' | 'step' | 'firstTokenTime'>,
  match: ConversationMatch,
  context: ConversationNodeContext<AssistantState>,
): AssistantMessageNode | undefined {
  if (match.event.type !== 'assistant/message') return undefined
  const event = match.event
  return {
    kind: 'assistant',
    seq: event.seq,
    messageId: event.data.message.id,
    time: event.time,
    turn: state.turn,
    step: state.step,
    blocks: toAssistantBlocks(event.data.message.content),
    usage: event.data.usage,
    timing: {
      stepStartTime: context.start?.event.time ?? null,
      firstTokenTime: state.firstTokenTime ?? null,
      completedTime: event.time,
    },
    ...event.data.interrupted === true ? { interrupted: true } : {},
  }
}

function settleMessage(
  state: AssistantState,
  match: ConversationMatch,
  event: SessionEvent<'assistant/message'>,
  context: ConversationNodeContext<AssistantState>,
): AssistantState {
  const blocks = toAssistantBlocks(event.data.message.content)
  const superseded = state.final === undefined ? undefined : settlementNode(state, state.final, context)
  return {
    ...state,
    blocks,
    visibleBlocks: countVisibleBlocks(blocks),
    final: match,
    usage: event.data.usage,
    // The durable settlement now carries the outcome.
    interruption: undefined,
    stall: undefined,
    ...superseded?.interrupted === true ? { retained: [...state.retained, superseded] } : {},
  }
}

/**
 * Adopt a recovery continuation for the Step it addresses: the attempt it
 * continues becomes retained history, and the Step returns to a running
 * presentation instead of the terminal one its interrupted settlement implied.
 */
function detachTruncated(
  state: AssistantState,
  recovery: { readonly fact: RecoveryFact; readonly turn: number; readonly step: number },
  context: ConversationNodeContext<AssistantState>,
): AssistantState {
  const truncated = state.final === undefined ? undefined : settlementNode(state, state.final, context)
  return {
    ...state,
    blocks: [],
    visibleBlocks: 0,
    final: undefined,
    usage: undefined,
    interruption: undefined,
    stall: undefined,
    recovery: recovery.fact,
    ...truncated === undefined ? {} : { retained: [...state.retained, truncated] },
  }
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

/**
 * Failure code the reasoning-loop guard records when it cuts a repetitive
 * call. The guard owns the code and this row renders it; the two strings meet
 * here because a feature plugin may not import another package's values.
 */
const REASONING_LOOP_CODE = 'REASONING_LOOP'

/**
 * Continuation one recovery message addresses. The guard records the Step, the
 * recovery ordinal, and the Turn's limit on the message source because
 * `user/message` carries no Turn or Step of its own; a log without the ordinal
 * still identifies the recovery by its kind.
 */
function recoveryTarget(event: ConversationEvent): {
  readonly turn: number
  readonly step: number
  readonly fact: RecoveryFact
} | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source as {
    kind?: unknown
    turn?: unknown
    step?: unknown
    attempt?: unknown
    limit?: unknown
  }
  if (source.kind !== 'reasoning-loop-recovery'
    || typeof source.turn !== 'number'
    || typeof source.step !== 'number') return undefined
  return {
    turn: source.turn,
    step: source.step,
    fact: {
      ...typeof source.attempt === 'number' ? { attempt: source.attempt } : {},
      ...typeof source.limit === 'number' ? { limit: source.limit } : {},
      prompt: event.data.content,
    },
  }
}

function closedBoundary(location: ConversationLocation): { seq: number; time: number } | undefined {
  if (location.kind === 'step' && location.step.status === 'closed' && location.step.end !== undefined) {
    return location.step.end
  }
  if ((location.kind === 'step' || location.kind === 'turn')
    && location.turn.status === 'closed' && location.turn.end !== undefined) {
    return location.turn.end
  }
  return undefined
}

function finalNode(
  state: AssistantState,
  context: ConversationNodeContext<AssistantState>,
): AssistantMessageNode | undefined {
  const final = state.final
  if (final !== undefined) {
    const settled = settlementNode(state, final, context)
    if (settled !== undefined) return settled
  }
  const location = context.start?.location ?? context.matches.at(-1)?.location
  const boundary = location === undefined ? undefined : closedBoundary(location)
  if (boundary === undefined) return undefined
  const blocks = compactBlocks(state.blocks)
  if (!hasInterruptionEvidence(blocks)) return undefined
  return {
    kind: 'assistant',
    seq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
    time: boundary.time,
    turn: state.turn,
    step: state.step,
    blocks,
    interrupted: true,
  }
}

function fallbackState(context: ConversationNodeContext<AssistantState>): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    if (match.event.type === 'assistant/live-chunk') {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = 'chunk' in match.event.data
        ? updateChunk(state, match.event.data.chunk, match.event.seq, match.event.time)
        : { ...state, stall: match.event.data.stage }
      continue
    }
    if (match.event.type === 'assistant/message') {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = settleMessage(state, match, match.event, context)
      continue
    }
    if (match.event.type === 'user/message') {
      const recovery = recoveryTarget(match.event)
      if (recovery !== undefined) {
        state ??= initialState(recovery.turn, recovery.step)
        state = detachTruncated(state, recovery, context)
      }
      continue
    }
    if (match.event.type === 'step/end' && state !== undefined) {
      state = { ...state, interruption: undefined, stall: undefined }
      continue
    }
    if (match.event.type === 'llm/retry' && state !== undefined) {
      state = resetForRetry(state)
    }
  }
  return state
}

interface AssistantProjection {
  readonly data: AssistantChatData
  readonly anchorSeq: number
  readonly visible: boolean
  readonly settled: AssistantMessageNode | undefined
}

function projectAssistant(context: ConversationNodeContext<AssistantState>): AssistantProjection | undefined {
  const state = context.state ?? fallbackState(context)
  if (state === undefined) return undefined
  const settled = finalNode(state, context)
  const blocks = settled?.blocks ?? compactBlocks(state.blocks)
  const visible = hasStepPresentation(state)
    || (settled === undefined ? state.visibleBlocks > 0 : hasVisibleContent(blocks))
  const status = settled?.interrupted === true
    ? 'interrupted'
    : settled === undefined ? 'running' : 'settled'
  const anchorSeq = assistantAnchorSeq(state, settled, context)
  const time = settled?.time ?? state.firstVisibleTime ?? context.matches[0]?.event.time ?? 0
  return {
    anchorSeq,
    visible,
    settled,
    data: {
      status,
      turn: state.turn,
      step: state.step,
      blocks,
      time,
      ...state.retained.length === 0 ? {} : { retained: state.retained },
      ...state.recovery === undefined ? {} : { recovery: state.recovery },
      ...state.interruption === undefined ? {} : { interruption: state.interruption },
      ...state.stall === undefined ? {} : { stall: state.stall },
      ...state.usage === undefined ? {} : { usage: state.usage },
      ...settled === undefined ? {} : { finalNode: settled },
    },
  }
}

/**
 * Seq the Step's Assistant row is anchored at. A settled attempt uses the
 * Step's own settlement, and a retained settlement keeps that same anchor, so
 * live streaming and a reopened window order the row identically.
 */
function assistantAnchorSeq(
  state: AssistantState,
  settled: AssistantMessageNode | undefined,
  context: ConversationNodeContext<AssistantState>,
): number {
  return (settled?.interrupted === true ? settled.seq : state.retained[0]?.seq ?? state.firstVisibleSeq ?? settled?.seq)
    ?? context.matches[0]?.event.seq ?? 0
}

function publishedAssistantData(
  context: ConversationNodeContext<AssistantState>,
): Readonly<AssistantChatData> | undefined {
  const location = context.start?.location ?? context.matches.at(-1)?.location
  return location?.kind === 'step' ? location.step.data.get('assistant-step') : undefined
}

/** Per-step Assistant lifecycle; materialized keys survive cleared stream content as hidden Nodes. */
export const assistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'assistant-step',
  target: 'chat',
  match: (event) => {
    if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (event.type === 'assistant/live-chunk'
      || (event.type === 'assistant/message' && event.surfaceOp === 'append')) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    if (event.type === 'llm/retry' || event.type === 'step/end') {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    const recovery = recoveryTarget(event)
    return recovery === undefined ? null : { id: `${recovery.turn}:${recovery.step}`, role: 'update' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') throw new Error('assistant-step start requires step/start')
    return initialState(match.event.data.turn, match.event.data.step)
  },
  update: (context, match) => {
    if (match.event.type === 'assistant/live-chunk') {
      // One live row type carries either the next streamed chunk or a detection stage.
      return 'chunk' in match.event.data
        ? updateChunk(context.state, match.event.data.chunk, match.event.seq, match.event.time)
        : { ...context.state, stall: match.event.data.stage }
    }
    if (match.event.type === 'assistant/message') return settleMessage(context.state, match, match.event, context)
    if (match.event.type === 'llm/retry') {
      return resetForRetry(context.state)
    }
    // The Step closed before any settlement replaced the live cut, so the
    // terminal rows own the outcome: an interrupted call with no delivered
    // content is recorded as an attempt, and a failed cleanup ends the Turn
    // with its own error. Neither leaves a running cut on screen.
    if (match.event.type === 'step/end') {
      return { ...context.state, interruption: undefined, stall: undefined }
    }
    const recovery = recoveryTarget(match.event)
    return recovery === undefined ? context.state : detachTruncated(context.state, recovery, context)
  },
  publication: (match) => {
    if (match.event.type === 'step/start') return 'none'
    if (match.event.type !== 'assistant/live-chunk') return 'immediate'
    // A detection stage is a decision of its own, not a streaming delta.
    if (!('chunk' in match.event.data)) return 'immediate'
    const type = match.event.data.chunk.type
    // A finish frame is a decision (the call ended or was cut), so it reaches
    // the reader without waiting for a streaming frame boundary.
    if (type === 'finish') return 'immediate'
    return type === 'usage' ? 'none' : 'animation-frame'
  },
  buildLocationData: (context, scope) => {
    if (scope !== 'step') return null
    const projected = projectAssistant(context)
    if (projected === undefined) return null
    return {
      kind: 'step',
      turn: projected.data.turn,
      step: projected.data.step,
      key: 'assistant-step',
      value: projected.data,
    }
  },
  buildViewNode: (context) => {
    const current = context.current.get('chat')
    const state = context.state ?? fallbackState(context)
    const data = publishedAssistantData(context)
    if (state === undefined || data === undefined) {
      return current == null ? null : { ...current, visibility: 'hidden' }
    }
    const settled = data.finalNode
    const visible = hasStepPresentation(state)
      || (settled === undefined ? state.visibleBlocks > 0 : hasVisibleContent(data.blocks))
    if (settled === undefined && !visible && current == null) return null
    // A successful message retains its live anchor alongside pending Tool calls.
    const anchorSeq = assistantAnchorSeq(state, settled, context)
    return chatNode(context, 'assistant-step', anchorSeq, data, {
      visibility: settled?.interrupted === true || visible ? 'visible' : 'hidden',
    })
  },
}

/**
 * Register the Assistant lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerAssistantConversationNode(ctx: Context): void {
  const match = assistantDefinition.match.bind(assistantDefinition)
  ctx.uiConversation.events.register({
    ...assistantDefinition,
    match: {
      'step/start': match,
      'assistant/live-chunk': match,
      'assistant/message': match,
      'user/message': match,
      'step/end': match,
      'llm/retry': match,
    },
  })
}
