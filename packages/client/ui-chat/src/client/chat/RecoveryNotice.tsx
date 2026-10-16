import { memo, useState } from 'react'
import { DisclosureRow, IconContextInjectionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantRecoveryChatData, AssistantStallStage } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './RecoveryNotice.module.css'

/** Props for the notice that reports this Step's repetition detection and truncation. */
export interface RecoveryNoticeProps {
  /** Durable facts of the continuation this Step consumed, once it consumed one. */
  recovery?: AssistantRecoveryChatData | undefined
  /** Failure that cut the running call, reported before its settlement exists. */
  interruption?: { readonly message: string } | undefined
  /** Latest withholding stage the live attempt reported, when it reported one. */
  stall?: AssistantStallStage | undefined
  /** Whether the call this notice covers is still running. */
  running: boolean
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Report what this Step's repetition detection is doing beside the content it
 * produced: that output is being withheld while it is checked, that the check
 * released it, that repetition was confirmed and the call is being cut, or which
 * recovery of the Step's allowance is now running. The row follows the live
 * attempt's own transitions, so one episode updates it once.
 * @param props - Live stage, the cut that ended a call, durable recovery facts, and the locale seat.
 * @returns A collapsed notice whose body carries the prompt or the failure account.
 */
/** Locale key of each withholding stage's one-line account. */
const STALL_SUMMARY = {
  suspected: 'message.stall.suspected',
  released: 'message.stall.released',
  barrier: 'message.stall.barrier',
} as const satisfies Record<AssistantStallStage, string>

export const RecoveryNotice = memo(function RecoveryNotice({
  recovery, interruption, stall, running, t,
}: RecoveryNoticeProps) {
  const [open, setOpen] = useState(false)
  const attempt = recovery?.attempt
  const limit = recovery?.limit
  // The most recent fact wins: a cut outranks the recovery this Step already
  // consumed, and an in-flight check outranks both. The next continuation clears
  // `interruption`, so the row reports the new ordinal from that point on.
  const stallStage = interruption === undefined ? stall : undefined
  const summary = interruption !== undefined
    ? t('message.recovery.interrupting')
    : stallStage !== undefined
      ? t(STALL_SUMMARY[stallStage])
      : recovery === undefined
        ? t('message.recovery.interrupting')
        : attempt === undefined || limit === undefined
          ? t(running ? 'message.recovery.running' : 'message.recovery.done')
          : t(running ? 'message.recovery.runningCount' : 'message.recovery.doneCount', { attempt, limit })
  const detail = interruption !== undefined
    ? interruption.message
    : stallStage !== undefined
      ? ''
      : recovery === undefined
        ? ''
        : recovery.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  return (
    <DisclosureRow
      className={css.root}
      icon={<IconContextInjectionOutlineRegular size={14} />}
      chevronClassName={css.chevron}
      title={t(stallStage === undefined ? 'message.recovery.title' : 'message.stall.title')}
      collapsedContent={(
        <>
          <span className={css.sep} aria-hidden />
          <span className={css.summary} data-recovery-summary>{summary}</span>
        </>
      )}
      running={running}
      keepContentWhenOpen
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-recovery-prompt>{detail}</div>
    </DisclosureRow>
  )
})
