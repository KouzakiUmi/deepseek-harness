import type {
  AssistantBlock, AssistantMessageNode, CommandNode, CompactionSummaryNode,
  ConversationLocation, ConversationViewNode, ModelRetryNode, RunningToolCall,
  ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ChatGroupTree } from './group-tree.ts'

/** Final Chat render unit produced by a Chat business Definition. */
export interface ChatConversationViewNode extends ConversationViewNode {
  readonly target: 'chat'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly visibility: 'visible' | 'hidden'
  /**
   * Group-tree position, visible or hidden; absence joins the surrounding step
   * run. An `exchange` Node's Turn and every later Turn before the next opening
   * Turn form one exchange; the latest loaded exchange starts at the last loaded
   * opening Turn, or at the first loaded Turn when none is loaded.
   */
  readonly groupTree?: ChatGroupTree | undefined
}

/** Merge-extensible payload registry keyed by final Chat renderer kind. */
export interface ChatNodeDataMap {}

/** Renderer kinds contributed by the currently installed Chat business modules. */
export type ChatNodeKind = Extract<keyof ChatNodeDataMap, string>

/** Final Chat Node narrowed to one registered renderer kind and payload. */
export type ChatNode<Kind extends ChatNodeKind = ChatNodeKind> = {
  [RegisteredKind in Kind]: ChatConversationViewNode & {
    readonly kind: RegisteredKind
    readonly data: ChatNodeDataMap[RegisteredKind]
  }
}[Kind]

/** Final Assistant row payload shared by streaming and settled states. */
export interface AssistantChatData {
  readonly status: 'running' | 'settled' | 'interrupted'
  readonly turn: number
  readonly step: number
  readonly blocks: readonly AssistantBlock[]
  readonly time: number
  readonly usage?: unknown
  readonly finalNode?: AssistantMessageNode
  /**
   * Settlements this Step delivered before the current attempt, oldest first.
   * A locally interrupted call whose prefix was already shown keeps it here, so
   * the continuing attempt never replaces content the reader has seen.
   */
  readonly retained?: readonly AssistantMessageNode[]
  /** Locally interrupted call this Step continues, when one was detected. */
  readonly recovery?: AssistantRecoveryChatData
  /**
   * Failure that cut the running call before its durable settlement existed.
   * Present only while a locally interrupted call has not settled yet.
   */
  readonly interruption?: AssistantInterruptionChatData
  /**
   * Latest withholding stage the live attempt reported. Live state only: a
   * reopened window derives its row from durable events and carries no stage.
   */
  readonly stall?: AssistantStallStage
}

/** Stage of one live repetition-check episode this Step reported. */
export type AssistantStallStage = 'suspected' | 'released' | 'barrier'

/** Local cut of a running Assistant call, reported before its settlement exists. */
export interface AssistantInterruptionChatData {
  /** Stable failure code the cutting policy recorded. */
  readonly code?: string
  /** Sanitized failure account; never a credential or provider payload. */
  readonly message: string
}

/** Durable facts of the continuation that resumes a locally interrupted call. */
export interface AssistantRecoveryChatData {
  /** One-based recovery ordinal the producer recorded, when the log carries it. */
  readonly attempt?: number
  /** Recoveries one Turn may start, when the log carries it. */
  readonly limit?: number
  /** Continuation prompt exactly as the model received it. */
  readonly prompt: readonly ContentBlock[]
}

/** Settled or interrupted Assistant payload with its durable presentation node. */
export type FinalAssistantChatData = AssistantChatData & {
  readonly finalNode: AssistantMessageNode
}

/** Root Tool row payload; the root lifecycle owns all recursive subcalls. */
export interface ToolChatData {
  readonly root: ToolCallBlock
}

/** One manual command and its correlated compaction transaction. */
export interface ManualCompactionChatData {
  readonly command: CommandNode
  readonly compaction: CompactionSummaryNode | null
}

/** One durable retry chain rendered as a single row. */
export interface RetryChatData {
  readonly attempts: readonly ModelRetryNode[]
  readonly current: ModelRetryNode
}

/** One provider/model route that contributed a billed request attempt. */
export interface TurnTokenUsageRoute {
  readonly provider: string
  readonly model: string
}

/** Exact provider-reported token accounting for every attempt in one completed Turn. */
export interface TurnTokenUsage {
  /** Sum of uncached prompt input across all attempts. */
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  /** Exact aggregate prompt plus output total across all attempts. */
  readonly totalTokens: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheReadTokens?: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheWriteTokens?: number
  /** Output subset, present only when every attempt reported it. */
  readonly reasoningTokens?: number
  /** Present only when every billed attempt has provider/model attribution. */
  readonly routes?: readonly TurnTokenUsageRoute[]
}

/** Turn-local footer row that owns actions and optional feature contributions. */
export interface TurnTailChatData {
  readonly turn: number
  readonly seq: number
  readonly time: number
  /** Last finalized content-bearing Assistant in this Turn. */
  readonly closing: FinalAssistantChatData | null
  /** Whether non-rendered later evidence makes the closing seq non-tail. */
  readonly branchUnavailable: boolean
  /** Exact per-Turn accounting; absent when the loaded evidence is incomplete. */
  readonly tokenUsage?: TurnTokenUsage
}

/** Turn-level process disclosure projected before the finalized answer. */
export interface TurnProcessChatData {
  readonly turn: number
  readonly controlAnchorSeq: number
  readonly processStartSeq: number
  readonly answerAnchorSeq: number | null
  readonly answerStep: number | null
  readonly inlineReasoning: boolean
  readonly messageCount: number
  readonly toolCallCount: number
  readonly subagentCount: number
}

/**
 * Test whether a Tool root has settled.
 * @param block - Tool root lifecycle value.
 * @returns whether the root carries its final result.
 */
export function isSettledTool(block: ToolCallBlock): block is Extract<ToolCallBlock, { kind: 'tool-result' }> {
  return 'kind' in block
}

/**
 * Test whether a Tool root is still running.
 * @param block - Tool root lifecycle value.
 * @returns whether the root lacks a final result.
 */
export function isRunningTool(block: ToolCallBlock): block is RunningToolCall {
  return !isSettledTool(block)
}
