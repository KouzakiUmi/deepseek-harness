# Agent Note: Keep a queued submission echo visible until its message is admitted

Status: implemented

English | [中文](2026-10-09-queued-echo-claim-handoff.zh.md)

## Problem

A message submitted while the agent is running is queued: the Host stores it in the `inbox` projection's `next-turn` list, QueueDock renders that row, and the Session holds a local submission echo for the same `rpcId`. The echo used to retire one animation frame after that row appeared, so the row was assumed to own the display from then on.

The assumption fails at the claim. When the running turn takes the queued message as its next input, the Host moves the message out of `next-turn`: an ordinary claim removes the row, and QueueDock Steer cancels the `next-turn` row while re-inserting the same message into `next-step`. The durable `user/message` is appended only after the next step starts. QueueDock reads `next-turn` alone, so between the claim and that append the message has no rendering owner; on the reported desktop session the row disappeared about 78 milliseconds before the transcript node appeared, and the window lasts to the step boundary.

## Decision

A queued echo follows the same admission rule as the other placements: admission retires it, and only a rejection retires it earlier. Four parts hold that in [session.ts](../../../../packages/api/session-controller/src/client/sessions/session.ts):

- Inbox insertion records a receipt for queued settlements too, so a claim updates the receipt (`index: null`) and the admission handoff waits on the Inbox watermark like every other accepted submission.
- `updateQueue` records the correlation id of a Steer request, and the canceled-row branch of `observeSubmissionEvent` consults that record. A cancellation the client did not ask to promote is a rejection — a removal, or a cancel that clears the queue — and retires the echo as failed immediately, so no sending row outlives the message it stood for.
- Inbox observation retires nothing by itself. Admission, rejection, and the existing `turn/end` rule (which fails a claimed echo the turn never admitted) are the retirement causes.
- Disposal settles an accepted echo, one carrying a receipt, as observed with its durable attachment references, and only an echo the Host never accepted as failed. Failing accepted work would make the composer restore a draft for a message the queue still owns.

[QueueDock.tsx](../../../../packages/client/ui-conversation/src/client/queue/QueueDock.tsx) defers to Chat while a promotion is in flight: its pending-echo filter also treats `next-step` user rows as admitted, because Chat already renders those as pending input. The strip owns the queued echo again once the claim empties `next-step`, which is the window this note is about.

## Alternatives considered

**Retire the echo when the claim removes its row.** This keeps the injection point and only moves the trigger later. A claimed message still waits for the step to start before its durable node exists, so the same gap returns in shorter form.

**Treat every canceled queued row as a promotion and let `turn/end` clean up.** This was the first version of the change, and review rejected it: a removed queue row left a sending echo behind until the current turn ended, which can be minutes. A removal and a promotion carry the same canceled outcome, so the client has to know which of the two it asked for.

**Have QueueDock draw the `next-step` row itself instead of deferring to Chat.** Two owners would still overlap while a promotion is in flight, and `next-step` also carries non-user input the strip does not present.

**Append the durable `user/message` with the claim.** This removes the window at its source rather than covering it, but it spans the agent loop's step boundary and the projection append, and a turn that aborts between them would leave the message's ownership ambiguous.

## Consequences

+ A queued message has an owner at every moment of the handoff: the composer echo before acceptance, the Host queue row after it, the echo again while a promotion is in flight or a claim is pending, and finally the durable node.
+ Queue actions keep their expected outcomes: a removal or a queue-clearing cancel rejects the submission at once, while Steer keeps the message visible throughout its promotion.
- A replacement follow baseline still withdraws a queued echo as observed, so reconnecting between a claim and the durable append can briefly omit the row. The same limitation already applied to Chat placements.
- Admission retires the echo one animation frame after the durable event, the frame Chat uses to hide the overlap by `rpcId`. QueueDock has no equivalent dedupe against the transcript, so the strip can show that row for one frame after the durable node appears.

## Verification

[session-pending-submissions.client.spec.ts](../../../../packages/api/session-controller/tests/session-pending-submissions.client.spec.ts) pins both retirement causes: `keeps a queued echo through acceptance and claim until transcript admission`, `keeps a steered queued echo visible after its next-turn row is canceled`, `retires a canceled queued echo the client never asked to promote`, and `settles an accepted queued echo as observed when disposed before admission`. [queue-dock.client.spec.tsx](../../../../packages/client/ui-conversation/tests/queue-dock.client.spec.tsx) pins that the strip defers to Chat while `next-step` carries the same `rpcId`. [README.md](../../../../packages/api/session-controller/README.md) and its Chinese counterpart state the admission and rejection rules.
