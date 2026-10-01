# 审阅线程状态与实测边界

`wait-review-threads.ps1` 只读查询行内线程，不推断代码已修复，不回复、不触发审阅、不解析线程。PR 主评论和 diff 外意见仍用 `get-coderabbit-review-data.ps1` 检查。

## 字段与身份

- `peerAnswered`：根评论作者在首条意见后是否再次发言。这是历史事实，不表示回答了最新回复。
- `ourReplied` / `ourComments`：根评论之后其他参与者是否回复及数量；不是当前登录账号的身份判断。
- `lastPeerOutcome`：原 reviewer 最近回复的措辞分类，在等待新回复时保留作历史依据。
- `outcome`：当前等待状态或原 reviewer 最近回复的分类。
- `isResolved` / `resolvedBy` / `resolution`：平台解析状态。解析方是原 reviewer（`PEER`）、其他账号（`OTHER`）、未知（`UNKNOWN`）；未解析为 `OPEN`。
- `action`：结合措辞与平台状态的建议；执行前仍须核对当前代码与授权。

原 reviewer 由根评论作者确定，不把多个机器人合并成一个对方。CodeRabbit 评论严格要求 REST 的 `coderabbitai[bot]` / `Bot` 或 GraphQL 的 `coderabbitai` / `Bot`；只有 `resolvedBy` 接受平台实际返回的 `coderabbitai[bot]` / `User` 形态。人工和其他机器人意见不套用 CodeRabbit 的确认判据，不能判断时保留 `NEEDS_REVIEW`。

## 类别与动作

| `outcome` | 含义 | 未解析时的 `action` |
|---|---|---|
| `AWAITING_DETECTION` | CodeRabbit 首条意见后没有其他发言 | `REPLY_IF_UNDETECTED` |
| `AWAITING_PEER_REPLY` | 其他参与者的最新回复晚于原 reviewer 的回复 | `WAIT_PEER` |
| `ACCEPTED` | CodeRabbit 确认修复或核对结果 | `WAIT_PEER`，观察实际解析 |
| `ACCEPTED_OPEN` | 明确确认修复，同时说明平台无法解析 | `RESOLVE_MANUALLY` |
| `WITHDRAWN` | 明确撤回意见 | `WAIT_PEER`，观察实际解析 |
| `KEPT_OPEN` | 明确保持审阅线程或意见开放 | `REPLY` |
| `FOLLOW_UP` | 仍要求后续修改 | `REPLY` |
| `RATE_LIMITED` | 回复受限流阻挡 | `WAIT_QUOTA` |
| `NEEDS_REVIEW` | 身份、措辞或确认条件不足 | `REVIEW` |
| `RESOLVED_SILENT` | 原 reviewer 解析，无追加回复 | `NONE` |
| `RESOLVED_BY_OTHER` | 其他或未知账号解析，原 reviewer 无追加回复 | `NONE` |

已解析时，不建议重复回复、等额度或人工解析。`KEPT_OPEN`、`FOLLOW_UP`、`NEEDS_REVIEW` 与已解析状态冲突时返回 `REVIEW`，检查原文和代码；其余返回 `NONE`。线程解析不证明代码已修复；旧措辞也不能推翻当前平台状态。

`REPLY_IF_UNDETECTED` 是有条件的建议：先核实该问题已修复，等覆盖当前 head 的审阅完成，再核对线程是否仍未更新。没有新发言本身不能证明漏检或修复，也不是立即补回复的指令。

## 查询与等待

```powershell
# 只读快照
.\.agents\skills\ok-script-pr-review\wait-review-threads.ps1 -Repo AliceJump/ok-script-toolkit -PrNumber 22 -Once
# 绑定 head，默认等待 900 秒，每 30 秒查询
.\.agents\skills\ok-script-pr-review\wait-review-threads.ps1 -Repo AliceJump/ok-script-toolkit -PrNumber 22 -ExpectedHead <40位SHA>
# 观察指定线程与类别，也可指定 -OutFile
.\.agents\skills\ok-script-pr-review\wait-review-threads.ps1 -Repo AliceJump/ok-script-toolkit -PrNumber 22 -ThreadId <线程ID> -WaitFor ACCEPTED,WITHDRAWN -OutFile review-threads.json
```

默认等待 `AWAITING_*` 消失，并等待已确认或撤回的开放线程实际解析；其他类别交由人工处理。`-WaitFor` 仅等待指定措辞，可能在线程仍开放时结束。

每轮查询前后重读 PR。head 不同则丢弃该轮数据，以 `HEAD_CHANGED` 结束。未指定 `ExpectedHead` 时绑定启动时的 head。关闭的 PR 仍有待等待线程时不继续轮询；`-Once` 可分析历史快照。

最后一行 stdout 是完整紧凑 JSON，进度走 stderr；包括 `head`、`expectedHead`、`observation`、`counts`、`threads`。

| 退出码 | 含义 |
|---|---|
| `0` | 观察条件已满足，**不代表 PR 审完、问题全修复或可合并**；零线程也是空快照 |
| `2` | 参数、API、权限或指定线程查询错误 |
| `4` | PR 关闭，停止等待 |
| `6` | 仍需等待；`-Once` 的 `timedOut=false`，达到等待期限才为 true |
| `11` | head 变化，本轮线程数据未发布 |

在用户能从 Codex 侧边查看输出的终端会话等待，复用已有进程；不要隐藏运行或另建 automation。

## 2026-10-01 实际校验

只读重新抓取以下 15 个 PR 的完整线程及评论，核对两层分页数量，共 **115 条线程、300 条评论**。这是当时快照，不能推导之后的状态或机器人必然行为。

| 仓库 | PR | 线程数 |
|---|---|---|
| `ok-script-toolkit` | #17、#18、#21、#22、#23 | 7、25、3、4、0 |
| `ok-script-toolkit-jetbrains` | #13、#17、#18 | 27、1、0 |
| `ok-end-field` | #331、#335、#358、#378、#405、#425、#426 | 2、2、20、1、22、1、0 |

已修正的真实误判：

- [ok-end-field #331](https://github.com/AliceJump/ok-end-field/pull/331)、[#335](https://github.com/AliceJump/ok-end-field/pull/335)：曾说无法解析，但当前线程已解析；保留 `ACCEPTED_OPEN` 历史措辞，动作改为 `NONE`。
- [JetBrains #13](https://github.com/AliceJump/ok-script-toolkit-jetbrains/pull/13)：“保持对话框打开”描述保存失败 UI，不是保持审阅线程开放，改为 `ACCEPTED`。
- [ok-end-field #405](https://github.com/AliceJump/ok-end-field/pull/405)：`leave this thread open until the fix is verified` 等待未来修复，归为 `KEPT_OPEN`；安全扫描线程来自另一机器人，需读取原文。
- [主仓 #18](https://github.com/AliceJump/ok-script-toolkit/pull/18)：`keep this finding open` 要求保持意见开放，不应被确认词覆盖。
- 主仓 #22、子仓 #17 仍需核对实际问题；无回复不证明已修复。主仓 #23、子仓 #18、ok-end-field #426 零线程也不代表审完。

`fixtures/review-threads.json` 保存 14 条带来源 URL、head、作者类型的样例。根评论正文只保留首段，后续回复保留原文；预期结果按实际含义人工核对。复放不调用 GitHub，不执行评论命令。

匹配前剥离营销段落、HTML 注释、嵌套或带属性的 `<details>`、围栏代码、内联代码、引用行、链接目标；礼貌感谢、未来验证及无法确认不能单独证明接受。复杂 Markdown 与没有标记的裸引用仍可能误判，遇到可疑结果从 `url` 核对原文。

在 Windows PowerShell 5.1 和 PowerShell 7 各运行：

```powershell
powershell -NoProfile -File .agents/skills/ok-script-pr-review/test-coderabbit-helpers.ps1
powershell -NoProfile -File .agents/skills/ok-script-pr-review/test-coderabbit-wait-mock.ps1
powershell -NoProfile -File .agents/skills/ok-script-pr-review/test-review-threads-mock.ps1
# 用 pwsh 替换 powershell 重跑上述三个脚本。
```

既有 head、限流和一次触发状态机保留。新增测试覆盖回复顺序、解析状态、身份、引用、独立分页、API 错误、关闭 PR、超时、head 变化和单行 JSON。ok-end-field 技能仅作行为参考，本次不修改该仓，也不搬用其人工解析规则。
