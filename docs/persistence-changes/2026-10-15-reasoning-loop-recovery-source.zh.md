---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-15-reasoning-loop-recovery-source

[English](2026-10-15-reasoning-loop-recovery-source.md) | 中文

## 概述

新增可合并扩展的消息来源 kind `reasoning-loop-recovery`，以及它记录的 Step、从 1 开始的续跑序号与 Turn 上限。repeat-tool-reminder guard 在本地中断一次重复推理调用后，记录它注入的续跑提示，使被恢复的调用仍能与用户、父代理或开发者消息区分；展示方据此把续跑挂到对应 Step，并显示本轮额度中的第几次续跑，而不必从周围窗口反推。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录保持有效且不变：没有字段被删除、移动或改型，`SESSION_FORMAT_VERSION` 仍为 4。`MessageSourceMap` 可合并扩展，且 `MessageSource` 的文档要求按 `kind` 分支并对未知变体 fall through，因此未声明该 kind 的读取方会保留持久化的 kind 而不是失败；两个会话投影也已按 kind 标注未知来源。读取 `turn`、`step`、`attempt`、`limit` 时兼容这些字段存在之前写下的会话：Chat 的 assistant 投影要求 `turn` 与 `step` 为数字才会把续跑挂到 Step，否则保留原有的中断展示，同时仍保留被后续结算取代的前缀；当 `attempt` 与 `limit` 缺失时，恢复提示退回不带次数的措辞。这些字段是同一来源上的新增成员，忽略它们的读取方仍可读到全部既有成员，续跑提示也仍是普通内容的 user 角色消息。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/guard/repeat-tool-reminder packages/core/agent-loop：29 个文件、535 个测试通过（1 个跳过），其中包含对 {turn, step, attempt, limit} 序号的断言（1/1，以及在 limit 为 2 时的 1/2 与 2/2）与清理未完成时的提前发布测试。pnpm exec vitest run packages/client/ui-chat packages/client/ui-trajectory：63 个文件、1061 个测试通过，其中包含 Step 行在 live 与重放下的等价、无序号来源的兼容用例，以及提示行展示。

<a id="dev-note"></a>
## 开发备注

无。
