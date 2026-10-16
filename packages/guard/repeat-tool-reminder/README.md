---
description: "Advisory loop-hygiene guard that nudges the model out of identical tool-call loops, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-repeat-tool-reminder

English | [中文](README.zh.md)

## Summary

This package gives each agent advisory reminders when it repeats identical tool calls. The base bundle enables reminders at 3, 5, and 8 repeats; these reminders never block calls. Separately, opt-in `reasoningLoop` suppresses sustained exact-copy reasoning before delivery on explicitly editable-plain routes, and stalls output once one observation finds repeated sentences. Normal reasoning passes immediately, tentative text is buffered, and confirmed copies cannot return through a completed block. Unknown and signed routes remain unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when the model should catch itself looping on identical tool calls. There is nothing to learn or wire: the `dsh` base bundle already runs it, and the defaults work for most sessions — tune the thresholds and tool scope below when you want the nudge sooner, later, or on fewer tools.

### When to choose it

Choose it when the model works autonomously for long stretches and a stuck loop is the failure you want to break with advice rather than force. Avoid it when identical repeats are legitimate and must run undisturbed — the guard only reminds, and a reminder is a small extra message after the repeated call — and when near-identical variants must be caught, because only exact repeats (same tool, same arguments regardless of property order) are detected.

### Setting the thresholds and scope

When you want to change when reminders fire or which tools they cover, mount the plugin with configuration:

```yaml
- name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # remind at 3, 5, and 8 consecutive repeats
    include: []                  # track every tool; list patterns to track only some
    exclude: [todo_write]        # never track these tools
    argumentsPreviewChars: 500   # cap on arguments shown in the detailed reminder
```

| Field | Default | Meaning |
|---|---|---|
| `thresholds` | `[3, 5, 8]` | Repeat counts that trigger a reminder |
| `include` | `[]` | Only these tools are tracked; empty means every tool |
| `exclude` | `[]` | These tools are never tracked; calls to them neither count nor reset |
| `argumentsPreviewChars` | `500` | How many characters of the repeated arguments the detailed reminder shows |

Invalid configuration fails at startup with a clear error — an empty `thresholds` list, a repeat count below 2, or a duplicate — never a silent change of behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) documents every accepted value.

### Optional reasoning-copy suppression

`reasoningLoop: {}` explicitly enables output editing; omission or `false` disables it. This is separate from advisory tool reminders. The selected adapter must declare `editable-plain` on the same prepared model call. The pi-ai adapter's explicit `reasoningReplay: plain` mode supplies this capability for its checked Chat Completions path; native Messages signatures and unknown routes do not qualify. See the [pi-ai replay mode](../../llm/llm-pi-ai/README.md) before enabling it.

The policy preserves the earliest accepted original and removes exact copies only after sustained evidence from a bounded raw suffix. It detects periodic strings without newlines and reordered complete sentence units, but does not normalize identifiers, numbers, or negations. Detection delay permits some initial copies to pass. Unconfirmed text is released at recovery or before another event; confirmed copies never return, and a completed reasoning block cannot restore them. A complete protocol tool block protects normal settlement from repetition-driven cancellation without making incremental arguments executable. After the first such block, `settlementBudget: 65536` bounds unfinished settlement: every subsequent non-finish event costs one unit plus its new delta's UTF-16 characters. The budget never resets for another tool block. Exceeding it ends the call with `TOOL_SETTLEMENT_LIMIT`, dispatches no tools from that call, and does not continue or enter ordinary retry. This host-side bound does not rely on provider output-limit compliance; silence remains subject to the adapter's idle watchdog.

A visible stall runs on the same characters before exact-copy filtering. Output is released as it arrives until one observation of `windowChars: 1024` characters holds both recurring sentences and reused characters; the following characters are then withheld while the observation window doubles toward `maxWindowChars: 8192`. `confirmWindows: 3` consecutive qualifying observations discard the withheld suffix and end the call with `REASONING_LOOP`; `recoveryWindows: 2` consecutive non-qualifying observations, a tool barrier, or final settlement release it verbatim. Reaching `maxWindowChars` is a retention and observation bound, never a requirement to wait: the stall decides there with the evidence it has, ending a call whose repetition is still current and releasing one that has fallen back. A complete protocol tool block keeps withholding but never lets the stall cancel the call. Fenced code suspends the stall, because example scaffolding repeats without being a reasoning loop. `unitShare: 0.5`, `unitCharShare: 0.15`, `shingleChars: 8`, and `shingleShare: 0.6` require recurring sentences that carry real mass over reused fragments, so progress whose sentences introduce new identifiers, counters, or verdicts is released untouched, and `visibleStall: false` keeps the exact-copy filter alone.

The settings are UTF-16 character counts: `windowChars: 4096`, `scanChars: 32`, `holdChars: 256`, `confirmChars: 1024`, `cancelChars: 16384`, `recoveryChars: 256`, and `maxPeriodChars: 192`; sentence-pool evidence uses `minPoolUnits: 16` and `poolShare: 0.75`. These are conservative heuristics, not measured accuracy guarantees. Invalid bounds fail at plugin activation. A long confirmed loop ends only its model call with `REASONING_LOOP`, not a fabricated stop or token-limit outcome.

`maxRecoveries: 1` permits one continuation per turn in this policy instance; `0` stops without continuing. The safe reasoning/text prefix is stored as an interrupted assistant message, without undispatched tools or replay metadata. A separately attributed, persisted user message requests a different approach before the next call in the same activity; its source records the Step it continues, the one-based recovery ordinal, and the Turn's configured limit, so a presentation consumer needs no inference from the surrounding window. Exhaustion is a real error, not normal completion; ordinary `always` retry cannot resume it. User/parent/disposal cancellation and iterator cleanup failure prevent recovery. Unloading the plugin lets an already captured call finish its filtering/stop but forbids another policy-authorized call.

### What you get

With the defaults, a model that repeats the same call with identical arguments receives a short reminder on the third repeat — to analyze the previous result before calling again — and detailed reminders on the fifth and eighth, naming the tool and the repeated arguments so it can decide whether to change approach, gather more evidence, or finish. A new user message clears the count, so a fresh instruction is never treated as a loop. Reminders appear in the conversation after the repeated call's result, attributed to the plugin, so the model reads them like any other message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard detects repeats and delivers reminders, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Advisory, not veto.** The guard enriches post-execute decisions with model context; it never blocks or rewrites a call, so `PostToolDecision` blocking stays a later listener's job.
- **Count in post-execute.** Detection runs on `tools/post-execute`, which also fires for denied calls; counting there lets one listener cover every attempt with no cross-event state.
- **Exact-match canonicalization.** Arguments reach the guard as the loop's `JSON.parse` output (or its raw-string fallback), so JSON's value domain is the whole input domain and a deep key-sort plus `JSON.stringify` is a complete, deterministic identity — no bigint, cycle, or `undefined` handling exists because no input path can produce them.
- **Fail loud at load.** `thresholds` and `argumentsPreviewChars` validate in `apply` and throw, never falling back to defaults.

### Detection: the repeat chain

Each agent's chain is keyed by `(tool name, canonical arguments)` — two calls with the same tool and canonically identical arguments (property order ignored) count as consecutive, and a different tracked call resets the count to 1. The chain lives in a `WeakMap<Agent, Chain>`.

- **Untracked calls are transparent to the chain.** A call excluded by `include`/`exclude` neither increments nor resets the counter, so `grep X → todo_write → grep X` still counts as two consecutive `grep X` when `todo_write` is excluded — bookkeeping tools interleaved into a loop do not launder it.
- **Denied calls count.** Detection sits on `tools/post-execute`, which also runs for calls a `tools/pre-execute` listener denied; a model hammering a denied call is exactly the loop worth breaking.
- **Calls without an agent are ignored.** A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on.
- **Per-agent keying, reset on user prompts.** One agent's repetition never trips another's reminder; a user prompt (`agent/pre-step`) deletes the submitting agent's chain, and object lifetime bounds the weak entry without a disposal listener.
- **In-memory only.** A session resumed from persistence starts with a fresh chain — the guard is a heuristic nudge, not a logged invariant, so reminders after a resume are the accepted cost.

### Reminder delivery

Reminders ride the post-execute decision's `additionalContexts` (source `{kind: 'repeat-tool-reminder', form: 'notice', summary: '<tool> × <count>'}`), never a `content` replacement: the `tool/result` event stays the tool's own output for audit. The loop buffers the context and appends it as an injected `user/message` after the step's tool results, which the session renders as a plain synthetic user message — model-visible, source-attributed, and reconstructable from the session log with no new session event. The guard always delegates via `next()` and prepends its reminder to the downstream decision's context array, so both decision variants (a blocked call included) still get the nudge while every entry retains its own source and metadata.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, chain listeners |
| [`src/reasoning-policy.ts`](src/reasoning-policy.ts) | Optional call-local output filtering and attributed recovery decisions |
| [`src/reasoning-watch.ts`](src/reasoning-watch.ts) | Bounded raw-copy evidence and tentative buffering |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools waterfall to exhaustive configuration and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` waterfall, `additionalContexts`, and decision shapes this guard consumes.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### First-threshold context message

#### What the model sees

At the first configured consecutive-repeat threshold, that agent receives the reminder below. No tool schema or normal-call text is added.

##### First-threshold reminder

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token effect

Zero tokens before the threshold. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later-threshold context message

#### What the model sees

A later threshold receives the detailed reminder template below. A capped argument preview ends exactly `… (+<omitted> more chars)`.

##### Later-threshold reminder

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token effect

Each reminder is retained history; `argumentsPreviewChars` bounds its data-dependent argument text, while agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Optional reasoning recovery

#### What the model sees

With `reasoningLoop` enabled on an editable route, retained history contains the safe interrupted prefix and an attributed continuation asking for a different approach without repeating it. A stop caused by the visible stall retains the same prefix and states that the unconfirmed repetitive tail was discarded instead of removed copies; both continuations are asserted by the output-policy composition tests, and the exact-copy continuation is additionally pinned by the authored reasoning-loop recovery Session. Native spawn/fork retain the same activation; externally executed agents are not covered by a policy installed only in their parent.

#### Token effect

Accepted copies are removed before history commit; local suppression does not reduce provider-side token generation, accounting, or SDK buffers. A permitted recovery adds one short persisted prompt and another model request; it does not invent missing usage.

#### KV Cache effect

The committed prefix and continuation append to prior history. No earlier history is rewritten. The explicit plain adapter's reasoning-only projection changes representation in the new request and makes no cross-representation cache-reuse guarantee.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Exact-match detection only** — canonicalization is a deep key-sort, so near-identical variants (a tweaked path, extra whitespace inside a value) evade the chain; fuzzy matching is rejected pending evidence of need.
- **Compaction does not reset chains** — a chain spanning a compaction checkpoint keeps counting.
- **Tool reminders remain advisory** — `reasoningLoop` edits reasoning output, not tool calls or their results.
- **Reasoning support is bounded** — the policy filters the first reasoning index per call; additional indexes pass unchanged. Exact-copy evidence cannot establish semantic correctness or catch arbitrary micro-variations. Unknown and opaque replay routes are not edited; external subagent processes need their own composed policy.
- **The visible stall is a heuristic with a measured false-positive floor** — 7 of the 106 reasoning blocks longer than 2,000 characters in the recorded session behind it crossed its thresholds; one of those kept repeating for roughly 4,000 further characters and then recovered on its own, so a stop can land inside a repetitive episode that would have ended by itself. Observations shorter than one window, fenced code, and progress carrying new identifiers or values pass through untouched, and only exact-copy evidence removes characters.
- **No subagent chain-sharing** — chains stay isolated per agent; a parent and its subagent repeating the same call never combine.
- **Legitimate idempotent polling still draws nudges** past the thresholds — the pressure valves are the `thresholds`/`exclude` config.
- **Past the highest threshold a chain goes silent** — reminders fire only at exact configured counts, never beyond them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [repeat-tool-guard feature note](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md) records the original design and alternatives under the former package name; the [naming ledger](../../../.agents/notes/archived/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) records the rename to `repeat-tool-reminder` and its reason.

</details>
