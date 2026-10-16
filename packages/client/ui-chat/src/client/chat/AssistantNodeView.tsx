import { memo, useCallback, useMemo } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps, PresentationInjected, TurnTailOwnerProps } from '../contract/slots.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import { RecoveryNotice } from './RecoveryNotice.tsx'

type AssistantNodeViewProps = ChatNodeViewProps<'assistant-step'> & InjectFace<PresentationInjected>
  & PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.message.images'>

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, groupPart, useDisclosure, useGroupAction, useTurnData, turnProcess, openFile, loadImage, fileMentions,
  usePresentation, renderSlot, t,
}: AssistantNodeViewProps) {
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable
    && turnProcess.spec.answerStep === data.step
    && turnProcess.spec.inlineReasoning
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  return (
    <>
      {/* The notice belongs to the Step, not to one of its rendering groups. */}
      {(data.recovery !== undefined || data.interruption !== undefined || data.stall !== undefined)
        && groupPart !== 'reasoning' && (
        <RecoveryNotice
          recovery={data.recovery}
          interruption={data.interruption}
          stall={data.stall}
          running={data.status === 'running'}
          t={t}
        />
      )}
      {/* A Step that recovered from a local interruption renders the prefix it
          already delivered before the attempt that continued it. */}
      {data.retained?.map(segment => (
        <AssistantMarkdown
          key={segment.seq}
          blocks={segment.blocks}
          groupPart={groupPart}
          useDisclosure={useDisclosure}
          streaming={false}
          truncated={segment.interrupted === true}
          loadImage={loadImage}
          reasoningHidden={reasoningHidden}
          useGroupAction={useGroupAction}
          usePresentation={usePresentation}
          renderSlot={renderSlot}
          revealProcess={revealProcess}
          t={t}
        />
      ))}
      <AssistantMarkdown
        blocks={data.blocks}
        groupPart={groupPart}
        useDisclosure={useDisclosure}
        streaming={data.status === 'running'}
        interrupted={data.status === 'interrupted'}
        loadImage={loadImage}
        reasoningHidden={reasoningHidden}
        useGroupAction={useGroupAction}
        usePresentation={usePresentation}
        renderSlot={renderSlot}
        revealProcess={revealProcess}
        mentions={mentions}
        t={t}
      />
    </>
  )
})
