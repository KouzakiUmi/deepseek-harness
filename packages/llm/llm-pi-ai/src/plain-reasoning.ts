/** Explicit plain-reasoning replay for the verified Chat Completions conversion path. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, Api, Model } from '@earendil-works/pi-ai'

/**
 * Reject opaque metadata before an explicitly plain route can persist or replay it.
 * The three permitted strings are upstream Chat Completions field selectors,
 * not provider signatures. Empty, encrypted, structured, and tool signatures
 * cannot be silently removed to make an incompatible response look editable.
 * @param message - native response or reconstructed native assistant history.
 */
export function assertPlainReasoning(message: AssistantMessage): void {
  for (const block of message.content) {
    if (block.type === 'thinking') {
      const marker = block.thinkingSignature
      if (block.redacted || (marker !== undefined && marker !== 'reasoning_content' && marker !== 'reasoning' && marker !== 'reasoning_text')) {
        throw new LlmError('Plain reasoning mode received opaque thinking replay metadata', 'INCOMPATIBLE_REASONING_REPLAY')
      }
    } else if ((block.type === 'toolCall' && block.thoughtSignature !== undefined)
      || (block.type === 'text' && block.textSignature !== undefined)) {
      throw new LlmError('Plain reasoning mode received signed text or tool replay metadata', 'INCOMPATIBLE_REASONING_REPLAY')
    }
  }
}

/**
 * Reconstruct same-route plain history without the implicit foreign-history fallback.
 * Reasoning-only prefixes become assistant text containing exactly those reasoning
 * bytes: upstream Chat Completions otherwise drops a message with no body or tools.
 * Normal responses with text/tools retain their original reasoning-field selector.
 * @param native - history reconstructed from durable content and validated replay metadata.
 * @param target - exact snapshot-bound Chat Completions model.
 * @returns native assistant history with no opaque signatures.
 */
export function plainAssistant(native: AssistantMessage, target: Model<Api>): AssistantMessage {
  if (target.api !== 'openai-completions') throw new LlmError('Plain reasoning mode requires Chat Completions', 'UNSUPPORTED_REASONING_REPLAY')
  assertPlainReasoning(native)
  if (native.provider !== target.provider || native.model !== target.id) return native
  const bodyOrTools = native.content.some(block => block.type === 'toolCall' || (block.type === 'text' && block.text.trim().length > 0))
  return {
    ...native,
    api: target.api,
    provider: target.provider,
    model: target.id,
    content: native.content.map((block) => {
      if (block.type !== 'thinking') return block
      if (!bodyOrTools) return { type: 'text', text: block.thinking }
      return { ...block, thinkingSignature: block.thinkingSignature ?? 'reasoning_content' }
    }),
  }
}
