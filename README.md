# dsh-session-management

Session management for a **single agent preset**. One coordinator agent gets 15 tools to drive other sessions — create / list / read / fork / rename / send / queue / model / compact / archive — plus 3 registry tools for GUI placement (pin / unpin / state dump).

Every tool is registered inside the preset's own scope, so no other preset (`standard`, `ptc`, …) can see them, and nothing here mounts a Host-wide plugin.

- **委派优先的协调者**：本包自带的 preset 除 shell 外能力齐全（read / write / edit + web_search / web_fetch + todo / goal），执行类工作（跑命令、跑测试构建、批量重构）必须派给子会话
- **回调式委派**：`session_send(callback: true)` 在目标回合结束时把短回执推回发起方会话，不轮询、不阻塞
- **耐久账本**：一条委派一行记录（pending / done / failed / unknown），重启后仍在
- **问答桥**：被委派的子会话调 `ask_user_question` 时，问题转给委派方回答，避免无人应答的永久挂起（详见下文）
- **静默巡检**：`/loop` 按固定周期检查账本与会话，只在有异常时唤醒你自己

## Tools

### 发现与读取

| Tool | 作用 |
| --- | --- |
| `session_list` | 列出本进程已知的全部会话（live + 持久化），带 cwd / 标题 / 运行状态 / 血统（top-level、fork 自谁、subagent 子会话）与私有备注。默认只看自己的 cwd，`scope: "all"` 看全进程；调用者自己被排除 |
| `session_read` | 读某个会话最近的事件（旧→新）。`detail: text`（默认，只读人话）/ `tools`（加工具调用与结果）/ `all`（加系统消息、推理、标题变更）。只读，不唤醒目标，冷会话也能读；`maxChars` / `totalChars` 自己定，长交付可以一次读完 |
| `session_describe` | 读写某会话的私有备注（这行是哪来的、在等它什么）。备注不是标题，存在本包自己的文件里，不写进会话日志 |

### 投递与排队

| Tool | 作用 |
| --- | --- |
| `session_send` | 往目标会话投一条 prompt 并唤醒它。`mode: queue`（默认，等当前回合结束）/ `steer`（在最近的步骤边界插入）。冷会话会被 resume。`callback: true` 时目标回合结束后把**短回执**（状态、delegation id、有没有回复、回复多长）排队送回你这里，正文用 `session_read` 去取 |
| `session_queue` | 只读：列出目标会话收件箱里还在等的消息及各自投放位置（queue 还是 steer），用来确认自己发的东西是否还挂着 |
| `session_queue_manage` | 写侧：`list` / `remove` / `edit` / `clear` 尚未投放的消息。已进入当前回合的消息属于历史，不可撤不可改；`clear` 需要 `confirm: true`，`dryRun` 可先演练 |
| `session_delegations` | 读委派账本：每行一个 `callback: true` 的投递，含目标、任务摘要、状态与回复摘要。读的时候顺带做一次核对，所以回执通知丢了也能看到结算；`dismiss` 可忘掉某行 |

### 生命周期

| Tool | 作用 |
| --- | --- |
| `session_create` | 新建一个**全新**的顶层会话（不是 fork）：空历史，自带 preset 与 cwd。默认继承调用者的 preset，协调者要显式传 `preset: "standard"` 之类，否则会造出又一个协调者 |
| `session_fork` | 把一个会话分叉成独立副本并返回新 id：以已完成的回合为界复制日志，继承 preset 与 cwd，此后两边各自独立。可给 `title`，默认「源标题 · fork」 |
| `session_stop` | 取消另一个 live 会话的当前回合，保留它待投递的收件箱；冷会话会报 `session/not-found` |
| `session_compact` | 立刻压缩一个 live 且空闲会话的历史（跑它自己的 `/compact`）。目标 preset 必须组合了 compaction，`minimal` 之类没有 `/compact` 可跑 |
| `session_rename` | 读或写会话标题（GUI 侧边栏与 `session_list` 看到的那个短标签）；不传 `title` 就是读 |

### 模型

| Tool | 作用 |
| --- | --- |
| `session_models` | 列出当前部署可达的全部模型路由（按 provider 分组，带 reasoning effort），用来挑合法的 provider/model 组合 |
| `session_model` | 读或切换某个会话的模型路由（会话中途也行）：`next` 是下个请求要用的，`lastUsed` 是上次实际跑的那条 |

### GUI 放置

| Tool | 作用 |
| --- | --- |
| `session_archive` | 经运行中的 workspace registry 归档 / 取消归档：归档只是从侧边栏隐藏，日志、记录、位置都保留；同一笔写入里顺带清掉 pin |
| `workspace_pin_session` | 置顶，让会话排在侧边栏最前；已归档的会话会被拒绝，重复 pin 幂等 |
| `workspace_unpin_session` | 取消置顶，回到它原本的记录位置；未 pin 的 id 直接返回、不写盘 |
| `workspace_state` | 只读 dump：内存里的 archived / pinned 集合 + 各 workspace 的成员关系，默认还对比落盘的 `workspace.json`，用来判断「侧边栏是不是还没跟上」 |

## 架构

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `lib/tools.mjs` | 1784 | 15 个会话工具 + 委派回调的推送侧 + 延迟归档计时器 |
| `lib/store.mjs` | 587 | 耐久状态与委派账本（单个 JSON，格式 v5） |
| `lib/loop.mjs` | 563 | `/loop` 定时巡检：账本 + 会话列表 + 知识库健康采样 |
| `lib/ask-bridge.mjs` | 440 | 问答桥：把子会话的 `ask_user_question` 交给委派方回答 |
| `lib/workspace.mjs` | 170 | workspace registry 的 pin / unpin / state 三个工具 |
| `cordis.patch.yml` | 87 | 自带 bundle patch：只声明 `session-manager` 这一个 preset 行 |

### 状态文件

`$DSH_HOME/session-manager/state.json` 一个文件装两样东西：每个会话的记录（`description` / `parentId` / `kind` / `cwd` / `title` / `firstSeenAt`）与委派账本。读走 stat 校验，别的进程写过不会被旧缓存骗；写按实例串行、临时文件 + rename，崩了也不会留下半个文件。

### 问答桥解决的是什么

`ask_user_question` 没有超时，它等 Agent 作用域的 `user-questions/request` waterfall。被 `session_send` 派出去的会话自己是 runtime root，能通过那道守卫并抵达 waterfall，但**只有它自己那个会话的浏览器客户端能回答**——没人在看那个会话，于是工具调用永久挂起（实测卡过 107 分钟，任务其实早就做完了）。

`ask-bridge` 在 Host 平面装了一个缺失的应答者：只要提问的 agent 是账本里任一委派的目标，问题就被它认领，转成委派方会话里的一条排队消息；委派方回一条普通消息给子会话，这条回复就成了问题的答案，子会话的阻塞调用随之解除。前端人类问答的路径完全不变（不是委派目标的问题直接 `next()` 放行）。

### `/loop` 巡检

默认 120 s 一轮（最小 30 s，最大 24 h），所有者会话静默跑一轮：读账本（无副作用的持久化读，不会触发核对）、读会话列表、采样知识库健康。**只有查出东西才唤醒你**（一条 `[LOOP patrol]` 排队消息），一切正常就完全不说话——不发消息、不跑 LLM 回合。判定卡住的门槛是 10 分钟无动作，同一条卡住报告 6 小时内不重复。这个插件以读为主，唯一的写是 agent 自己用 `session_delegations dismiss` 清掉已经汇报过的行。

## Wiring

```bash
git clone https://github.com/Hana-ame/dsh-session-management.git
ln -s "$PWD" <profile>/node_modules/dsh-session-management   # Windows: mklink /J
```

`cordis.patch.yml` 会插入一个 preset 行（`id: session-manager`、显示名「会话管理」、`order: 5`），里面组合三行本包插件：`dsh-session-management/tools`、`/workspace`，以及默认 `disabled: true` 的 `/loop` —— 想用巡检再打开。`config.id` 故意保持 `session-manager` 而不是 `session-management`，这样早先建在旧 preset 行下的会话仍能解析到活定义。

想让别的 preset 也获得这些工具，把 `dsh-session-management/tools`（需要 GUI 放置再加 `/workspace`）加进那个 preset 的 `plugins` 即可；工具只在选中该 preset 的会话里可见。

> 当前 profile 通过 `node_modules` 里的符号链接读本地源码目录，不是从 npm 装的。发布这个仓库不改变正在运行的 profile 读的是哪份文件。

## 测试

没有 `npm test`，直接跑五个套件：

```sh
node test/tools.test.mjs
node test/delegation-idempotency.test.mjs
node test/archive-defer.test.mjs
node lib/loop.test.mjs
node lib/ask-bridge.test.mjs
```

覆盖：工具注册与参数校验、委派幂等（同一请求 id 不重复记账）、延迟归档计时器在插件卸载时被取消、`/loop` 轮次分类与知识库采样、问答桥的认领与回答回填。

## legacy/

`legacy/` 下是三代前身的完整快照（`dsh-session-manager`、`dsh-session-manager-deploy`、`dsh-workspace-session-mgmt`），只为追溯历史保留，不参与运行、不被 `exports` 引用。现行代码只看 `lib/` 与 `cordis.patch.yml`。

## 已知边界

- 工具作用域是 preset：换一个 preset 开会话就管不了别的会话，这是设计而非缺陷
- `session_compact` / `session_stop` 只对 live 会话有效；冷会话先靠 `session_send` 唤醒
- `workspace_state` 只读，归档仍走 `session_archive`；两个写入口会让同一个效果出现两条路径
- 侧边栏的归档 / 置顶改动由运行中的 registry 承接，落盘的 `workspace.json` 可能滞后，`workspace_state` 的 `divergence` 就是给这个用的

## License

[MIT](./LICENSE) © 2026 Nanaka
