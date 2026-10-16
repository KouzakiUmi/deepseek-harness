---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-15-reasoning-loop-recovery-source

English | [中文](2026-10-15-reasoning-loop-recovery-source.zh.md)

## Summary

Adds the merge-extensible `reasoning-loop-recovery` message-source kind, and the Step, one-based recovery ordinal, and Turn limit it records. The repeat-tool-reminder guard writes the continuation it injects after locally interrupting a repetitive reasoning call, so a recovered call stays distinguishable from a user, parent, or developer message and a presentation consumer can place the recovery on its Step and report which recovery of the Turn's allowance is running instead of inferring either fact from the surrounding window.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-15-reasoning-loop-recovery-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "8a172759b79e0fd700125cbf10927ca1167ab494898ef8b1ff7394b86287227d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "dd6a5c839247c6ffe0ef695768e52dd16e861ec8369968b2e8e42f9832888a85"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "d44322cb11e9ab7a2251a7e7cd40a762885e2198ecd8ffa5f217315c69c35046"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "0099d7506a85d026af775e5b574b8e437b86c22aff046a042676d76ce0ecf358"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records stay valid and unchanged: no field is removed, moved, or retyped, and `SESSION_FORMAT_VERSION` stays 4. `MessageSourceMap` is merge-extensible and `MessageSource` documents switching on `kind` and falling through unknown variants, so a reader built without this declaration keeps the durable kind instead of failing; both conversation projections already label an unknown producer by its kind. Reading `turn`, `step`, `attempt`, and `limit` tolerates a session written before they existed: the Chat assistant projection requires numeric `turn` and `step` before it attaches a recovery to a Step, and otherwise keeps the durable interrupted presentation while still retaining the prefix the resumed settlement replaced; the recovery notice falls back to its ordinal-free wording when `attempt` and `limit` are absent. The fields are additive members of one source, so a reader that ignores them keeps every existing member and the recovery prompt stays a user-role message with ordinary content.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/guard/repeat-tool-reminder packages/core/agent-loop: 29 files, 535 tests passed (1 skipped), including the asserted {turn, step, attempt, limit} ordinals (1/1, then 1/2 and 2/2 against a limit of 2) and the deferred-cleanup publication test. pnpm exec vitest run packages/client/ui-chat packages/client/ui-trajectory: 63 files, 1061 tests passed, including live/replay equality of the Step row, the ordinal-free source test, and the notice presentation.

<a id="dev-note"></a>
## Dev Note

None.
