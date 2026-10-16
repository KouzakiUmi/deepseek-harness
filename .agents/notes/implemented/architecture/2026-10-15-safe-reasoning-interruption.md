# Agent Note: Reasoning policies commit safe output before bounded recovery

Status: implemented

English | [中文](2026-10-15-safe-reasoning-interruption.zh.md)

## Problem

A model can emit a long exact-copy reasoning loop before eventually requesting tools. Cancelling at the first repeated phrase discards recoverable work; filtering only streamed deltas lets an authoritative completed block restore the removed text. Keeping another original response for provider replay preserves the same unwanted payload and may send it back to the model.

## Decision

The adapter declares reasoning editing capability on the same prepared snapshot as dispatch. Unknown and opaque routes are not edited. An explicit pi-ai plain Chat Completions mode rejects opaque metadata, preserves plain reasoning selectors on ordinary tool responses, and projects reasoning-only history as assistant text containing exactly the retained bytes. Direct Messages signatures remain opaque. A protocol or provider name alone is not an editing capability.

The loop selects one call-local output policy before dispatch. Accepted chunks alone feed durable accumulation, canonical assembly, and live publication. A reasoning-close directive uses accepted text rather than the provider's full block. The plugin retains bounded raw/accepted suffixes and unresolved spans, not a second complete response. Exact-copy suppression and delayed interruption have separate budgets; tool argument deltas are not execution authority. A complete identified tool block protects normal settlement while reasoning filtering continues.

A local policy stop owns a derived call signal, not the turn signal. The loop aborts the call and closes its iterator before authorizing recovery. Cleanup failure remains an error; parent, user, and disposal cancellation win. Ordinary middleware exceptions and provider failures are not local policy recovery. Policy stops bypass ordinary request-error retry, including its always mode. An unloaded policy may finish its captured filtering/stop but cannot authorize another call.

`assistant/message.interrupted: true` denotes an incomplete safe text/reasoning prefix, not the identity of the canceller or the final turn outcome. The embedded stream records the policy failure, with no fabricated usage, successful finish, replay signature, or tool result. Undispatched tools are absent from the retained message. The attributed continuation is an ordinary persisted `user/message` before the next request. A finite per-turn budget keeps recovery inside the existing activity and native child activation, before error/idle or child settlement.

The interruption is visible before its settlement. The loop publishes the policy's real failure frame when the policy ends the call, before provider cleanup, because teardown can stall for as long as the transport decides; the durable stream and the interrupted settlement then carry that one truth, and a reader sees neither a fabricated success nor a revived call. A presentation that must keep what the reader already saw retains each superseded interrupted prefix beside the attempt that continued it, reports the recovery ordinal and the Turn limit the continuation source records, and returns the Step to a running presentation the moment that continuation arrives instead of presenting the cut as a stop. A log without the recorded Step, ordinal, or limit leaves those readers on their existing durable presentation.

This decision partially supersedes the restriction to user cancellation in [cancelled-prefix finalization](2026-08-10-cancelled-stream-prefix-finalize.md). Its cancellation ordering, tool omission, and ordinary provider-failure behavior remain in force. The [embedded-stream decision](2026-09-01-v2-embedded-assistant-streams.md) remains the authority for compact stream storage; the stored stream is the accepted output, without a hidden original copy.

The same policy also withholds output once one observation of the initial window contains both recurring sentences and reused characters, releases it verbatim when the observation falls back or a barrier arrives, and ends the call when the repetition persists. Its observation window grows toward a configured ceiling that bounds retention and observation rather than requiring a wait; at that ceiling the policy decides from current evidence, cancelling while repetition is current and releasing once it has fallen back, and a committed tool block keeps withholding while it withholds cancellation. Recurring sentences must also carry real character mass, so a recurring interjection cannot qualify progress whose sentences introduce new identifiers, counters, or verdicts; no identifier, number, or negation is normalized, and no phrase is allow-listed.

## Alternatives considered

**Cancel on the first repeated phrase.** Short repetitive episodes can recover into useful reasoning and real tool calls. Delayed interruption preserves that opportunity while early suppression limits newly committed copies.

**Drop signatures or replay through an implicit foreign fallback.** Missing metadata does not establish provider permission to edit. Explicit plain mode enforces its narrower representation; signed and unknown routes remain conservative.

**Resume from an idle listener.** Idle is whole-agent state, not ownership of one recovery. A child manager can already be closing, or a user or parent can cancel. In-loop settlement keeps the original cancellation and activation owners.

**Introduce another persistent partial-message event.** Existing readers already understand an interrupted prefix with no dispatched tools. Reusing that representation avoids a parallel history projection; the broadened meaning is explicit and the policy cause stays separate from turn outcome.

## Consequences

Immediate normal delivery permits some repetition before detection. Exact evidence does not establish semantic validity or detect arbitrary micro-variations. Only the first reasoning index is filtered; additional indexes pass unchanged without restoring earlier discarded spans. Provider-side generation, accounting, and SDK buffers are not reduced by local suppression. Native spawn/fork activations can recover; external executions need a policy inside their own runtime. Existing sessions remain unchanged.

Recurring-sentence evidence is a heuristic with a measured floor: 7 of the 106 reasoning blocks longer than 2,000 characters in the recorded session behind it crossed the thresholds, and one of those kept repeating for roughly 4,000 further characters before recovering on its own.

## Verification

Package watch/policy tests cover representative reordered phrases, delimiter-free cycles, changed identifiers/numbers/negations, chunk partitioning, canonical block closure, tool protection, cancellation, cleanup failure, finite recovery, and fiber unloading. Native activation tests exercise spawn/fork single settlement and original lineage. Local HTTP wire tests exercise the explicit plain projection and opaque-metadata refusal. The authored headless recovery scenario runs the shipped Loader composition with ordinary retry configured as always and stores no original repeated payload in its resulting Session.

Visible-stall tests cover the recorded near-duplicate shape, indexed progress behind a recurring interjection, fenced scaffolding, barrier release, tool-commit release, the per-character retention ceiling, and equivalence across chunk partitions. The deferred-cleanup test parks the provider iterator's return and asserts the policy failure frame is observable while no durable settlement exists, that cleanup adds no second finish, and that the interrupted settlement and its continuation follow once cleanup completes. Conversation tests assert that a live window and a reopened one produce the same Step row, that no cut is reported as stopped while the guard continues it, and that a stop with nothing continuing it keeps its stopped presentation.
