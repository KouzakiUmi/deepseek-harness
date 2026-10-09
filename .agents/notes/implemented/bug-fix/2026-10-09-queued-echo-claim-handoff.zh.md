# Agent Note: 排队提交回显保留到其消息入档为止

Status: implemented

[English](2026-10-09-queued-echo-claim-handoff.md) | 中文

## 问题

agent 运行期间提交的消息会排队：Host 把它存进 `inbox` 投影的 `next-turn` 列表，QueueDock 渲染该行，同时 Session 为同一 `rpcId` 保留一条本地提交回显。回显过去在该行出现后的一个动画帧退休，因而假定此后由该行负责展示。

该假定在领取时失效。运行中的轮次把排队消息取作下一步输入时，Host 会把消息移出 `next-turn`：普通领取会移除该行，而 QueueDock Steer 取消 `next-turn` 行并把同一条消息重新插入 `next-step`。持久 `user/message` 要等下一步开始后才追加。QueueDock 只读 `next-turn`，因此在领取与该追加之间消息没有任何渲染归属；在报告该问题的桌面会话上，该行比 transcript 节点早约 78 毫秒消失，而窗口一直持续到步骤边界。

## 决策

排队回显与其他位置遵循同一条入档规则：入档使其退休，只有拒绝才会让它更早退休。[session.ts](../../../../packages/api/session-controller/src/client/sessions/session.ts) 中由四点支撑：

- Inbox 插入同样为排队结算记录 receipt，于是领取会更新 receipt（`index: null`），入档交接像其他已受理提交一样等待 Inbox 水位。
- `updateQueue` 记录 Steer 请求的关联 id，`observeSubmissionEvent` 的 canceled 分支会查这份记录。客户端没有请求提升的取消就是拒绝——被删除，或取消清空队列——会立即按 failed 退休回显，因此不会有"发送中"的行比它代表的消息活得更久。
- Inbox 观察本身不触发退休。退休来源只有入档、拒绝，以及既有的 `turn/end` 规则（把被领取却始终未入档的回显判为失败）。
- 销毁时把已受理的回显（携 receipt 者）按 observed 并附带持久附件引用结算，只有 Host 从未受理的回显才按 failed。把已受理的工作判为失败，会让 composer 为队列仍然持有的消息还原草稿。

[QueueDock.tsx](../../../../packages/client/ui-conversation/src/client/queue/QueueDock.tsx) 在提升进行期间让位于 Chat：它的未入档回显过滤同时把 `next-step` 的用户行视为已受理，因为 Chat 已经把这些行渲染为待处理输入。当领取清空 `next-step` 后，队列条重新持有该排队回显——这正是本记录关注的那段窗口。

## 考虑过的替代方案

**在领取移除该行时退休回显。** 这保留注入点，只是把触发时机往后挪。被领取的消息仍要等步骤开始才会有持久节点，同一空档会以更短的形式复现。

**把所有 canceled 的排队行都当作提升，交给 `turn/end` 兜底。** 这是本次改动的第一版，审查否决了它：被删除的队列行会留下"发送中"的回显直到当前轮次结束，而轮次可能持续数分钟。删除与提升携带同一个 canceled 结果，所以客户端必须知道自己请求的是哪一种。

**让 QueueDock 直接渲染 `next-step` 行，而不是让位于 Chat。** 提升进行期间仍会有两个属主重叠，而且 `next-step` 还承载队列条不展示的非用户输入。

**把持久 `user/message` 与领取放进同一次提交。** 这从源头消除窗口而非覆盖它，但它横跨 agent loop 的步骤边界与投影追加，且当轮次在两者之间中止时，消息归属会变得含糊。

## 后果

+ 排队消息在交接的每一刻都有归属：受理前的 composer 回显、受理后的 Host 队列行、提升进行中或等待领取时的回显，最后是持久节点。
+ 队列操作保持各自预期的结果：删除或取消清空队列会立即拒绝提交，而 Steer 会在整个提升过程中保持消息可见。
- 替换 follow 基线仍会按 observed 撤去排队回显，因此在领取与持久追加之间重连时，该行可能短暂缺失；同样的限制此前已适用于 Chat 位置。
- 入档会在持久事件后一个动画帧才退休回显，那一帧正是 Chat 用来按 `rpcId` 隐藏重叠的帧。QueueDock 没有对应 transcript 的去重，因此持久节点出现后，队列条可能仍显示该行一帧。

## 验证

[session-pending-submissions.client.spec.ts](../../../../packages/api/session-controller/tests/session-pending-submissions.client.spec.ts) 固定了两种退休来源：`keeps a queued echo through acceptance and claim until transcript admission`、`keeps a steered queued echo visible after its next-turn row is canceled`、`retires a canceled queued echo the client never asked to promote`，以及 `settles an accepted queued echo as observed when disposed before admission`。[queue-dock.client.spec.tsx](../../../../packages/client/ui-conversation/tests/queue-dock.client.spec.tsx) 固定了队列条在 `next-step` 持有同一 `rpcId` 时让位于 Chat。[README.zh.md](../../../../packages/api/session-controller/README.zh.md) 及其英文对照陈述了入档与拒绝两条规则。
