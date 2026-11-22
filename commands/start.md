---
description: Pi team mode: plan, delegate coding to Pi, review and commit
argument-hint: [需求描述]
disable-model-invocation: true
---

# Pi 团队模式

## 分工

- Claude：定计划、派单、审核、验收；只做拼写、格式、少量修补。
- Pi：写核心代码；子代理自己派，Claude 不指挥。
- 「直接跟她说」→ 用「用户原话说：<原话>」转给 Pi，转完照常审核。
- 审核必须自己看 diff 和代码，不能转述 Pi 的结论。
- 一个对话只用一个 Pi 会话（`.pi-session-id`），同一工作区不并跑。

## 0. 工作区

判定顺序：

1. 需求里有路径（`~/...`、`/...`、`./...`）→ 用它。
2. 当前目录是 git 仓库（`git rev-parse --is-inside-work-tree` 成功）→ 直接用当前目录。
3. 判断不出 → 问「在哪个目录做？」。

禁止把 `$HOME` 当工作区。确定后 `cd <工作区>`，后续所有命令都在该目录执行（`.pi-*` 运行时文件也生成在这里）。

## 1. 计划（走计划模式，不写代码）

调用 `EnterPlanMode`，按计划模式自己的流程走。

计划内容必须包含：

- **工作区**：绝对路径。
- **目标**：一句话说清最终交付什么，标准可验收。
- **拆分**：编号步骤，每步一个能单独验证的产出；不要出现「优化一下」「完善功能」这种没法验收的步骤。
- **实现方式**：每步落到文件和接口——改哪个文件、新增哪个文件、删哪个文件、函数/命令/配置怎么变；拿不准的点明确标出来。
- **备选方案**：至少一个替代做法，写清为什么选当前方案、不选另一个（取舍）。
- **风险**：可能踩的坑、外部依赖、需要用户拍板的点（是否兼容旧数据、能否改公开接口、能否动配置等）。
- **验证方式**：每步怎么验证（具体命令、测试名、手动步骤）；项目有测试就写明跑哪条。

然后给出计划，用户同意后再开始

## 2. 准备仓库与分支

分支名只有一个：`pi/team`。新建仓库的默认分支也用它。

1. 不是 git 仓库 → `git init -b pi/team`，把当前目录（排除 `.pi-*`）提交成 `baseline: before pi task`。
2. 仓库没有 HEAD → 报 `NO_HEAD`，停。
3. 切到 `pi/team`，没有就新建；切不过去 → 报 `SWITCH_FAILED`，停。
4. 切过去后，有未提交改动就提交成 `wip: before pi task`（排除 `.pi-*`）。

只提交本地，不 push；所有 Pi 改动只在 `pi/team` 上，没有别的分支名。

## 3. 写任务书

写入 `.pi-start-task.txt`：

```
【角色】我是 Claude，你是本项目的秘书，核心编码全部由你完成，我负责计划与审核。
【要求】
1. 按下面的计划实现；子代理由你自己派遣（pi-subagents），不需要等 Claude 指令。
2. 每完成一个步骤，立刻向 Claude 汇报：怎么实现的、改了哪些文件、关键 diff 位置。
3. 全部完成后输出：改动文件清单、实现思路、如何验证、剩余风险。
4. 计划里没写的改动不要做；需要偏离计划时先停下说明原因。
5. 不能暂存、不能推送：禁止 `git add`、`git push`。
【计划】
（阶段 1 用户批准的完整计划）
【需求原文】
（用户原始需求）
```

## 4. 定会话

先读本对话的绑定：`jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" '.[$sid] // empty' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"`（文件不存在按没有绑定处理）。

- **有绑定且文件存在** → 从文件第一行取 `id`（没有就从 `<时间戳>_<id>.jsonl` 文件名里取）写进 `.pi-session-id`；杀掉本工作区其他还活着的 **headless** `pi`（`pi -p ...`；按 `pgrep -f "^pi .*--session-id"` 找，用 `/proc/<pid>/cwd` 过滤，交互式 `pi --session` 不动）；再看这个 id 是否在跑，输出 `BOUND_RUNNING:<id>` 或 `BOUND_IDLE:<id>`。
- **没有绑定** → 看本工作区有没有在跑的 `pi`，有就输出 `RUNNING=<id>`，没有输出 `RUNNING=`。

- **`BOUND_IDLE:<id>`** → 绑定的 Pi 空闲。进第 5.1 节，用同一 ID 启动派单；等到 `FILE` 后跑 5.2 重绑（绑定可能指向另一个工作区的旧文件）。
- **`BOUND_RUNNING:<id>`** → 绑定的 Pi 还在跑。先跑第 6 节等它退出，再进第 5.1 节用同一 ID 启动；等到 `FILE` 后跑 5.2 重绑。
- **`RUNNING` 非空** → 直接用它，不新开：在 `~/.pi/agent/sessions/*/*_<RUNNING>.jsonl` 里找首行 `cwd` 等于本工作区的文件（找不到报 `NO_SESSION`），把 ID 写进 `.pi-session-id`，然后执行第 5.2 节写绑定（用找到的文件）。它如果在跑别的任务，先等它结束，再按 5.1 用同一 ID 启动。
- **`RUNNING` 为空** → 用 `AskUserQuestion` 问「这个工作区没有正在跑的 Pi，要新开一个吗？」：
  1. **是，新开一个 Pi** → `ID=$(cat /proc/sys/kernel/random/uuid)`，写 `.pi-session-id`，走第 5.1 节启动、5.2 绑定。
  2. **否，用已有对话** → 执行 `/pi:connect` 的流程（列该工作区及子目录的所有 Pi 会话，让用户回编号，写绑定）；绑定后从 `pi-bindings.json` 取回 ID 写进 `.pi-session-id`，若它在跑就先等它退出，再按 5.1 用同一 ID 启动。

## 5. 启动并绑定（新开、绑定空闲、或已有会话退出后都走这里）

进入本节前必须已经拿到第 1 节（计划）的用户明确同意；没有同意就停。

### 5.1 启动

启动（一条命令，后台跑）：

`setsid nohup pi -p --approve --mode json --session-id "$(cat .pi-session-id)" "$(cat .pi-start-task.txt)" > .pi-events.jsonl 2>&1 < /dev/null &`

`--approve` 会加载项目本地扩展/设置；陌生仓库先告诉用户。

然后在 `~/.pi/agent/sessions/*/*_<ID>.jsonl` 里等一个首行 `cwd` 等于当前工作区的文件，最多 60 秒。等到就输出 `FILE=<路径>`；等不到就杀掉这个 id 的 pi，报 `NO_SESSION`，停。等到了 FILE 后，确认这个 id 的 pi 真在跑（`pgrep -f` 命中）；落空时先看 `.pi-events.jsonl` 尾部：已正常结束（有汇报、无错误）就按已完成处理，只有既没进程、events 也报错/为空才贴尾部并停。

### 5.2 写绑定

`FILE` 来自 5.1，或第 4 节直接绑定时找到的会话文件。

绑定表不存在时先建空表：`[ -f "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" ] || printf '{}' > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"`。

用 jq 写绑定（一行）：

`jq --arg sid "$CLAUDE_CODE_SESSION_ID" --arg p "<会话文件>" '.[$sid] = $p' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" && mv "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"`

- 写成功 → 继续。
- `NO_SESSION`（5.1 没等到会话文件）→ 贴 `.pi-events.jsonl` 尾部错误，停。
- jq 报错、或这条会话已归别的对话 → 贴给用户，停；session id 变了就用 `/pi:connect` 重新接。

## 6. 等 Pi 结束

后台运行：

后台循环直到这个 id 的 pi 退出，然后输出 `PI_DONE`：

`while pgrep -f "^pi .*--session-id[= ]$(cat .pi-session-id)" >/dev/null; do sleep 2; done`

10 分钟被工具杀掉（退出码 -1）不代表 Pi 死了：先 `pgrep`，活着就再挂一次。Pi 每完成一步也可能先汇报，不一定要等全部结束。

## 7. 接收汇报并审核

1. 解析 `.pi-events.jsonl`：
   - `message_end` 里 `role == "assistant"` 的 text 块 = 汇报
   - `tool_execution_start` → `toolName` + `args`
   - `tool_execution_end` → `result.content`、`result.structuredContent.output` / `exit_code`、`isError`
2. 自己跑：

   跑 `git status --short -- . ':(exclude).pi-*'`、`git diff --stat`、`git diff`。派单前的原有改动已单独提交（`wip: before pi task`），用 `git log --oneline` / `git show` 对照。
3. Read 关键文件确认逻辑真的实现（不是注释、占位、假数据）。
4. 审核维度：功能是否实现、是否删了原逻辑或吞异常、是否有计划外改动、声称的测试是否真跑过。

## 8. 返工 / 收尾

- 核心问题（逻辑错、方案不对、质量差）→ 返工单**追加**到 `.pi-start-task.txt`，重跑第 5、6 节（同一会话 ID；返工沿用已批准的计划，不再重复征求第 1 节同意）。最多两轮，仍不合格就停下如实报告。
- 小问题（拼写、格式、一行修补）→ 直接改，报告注明「这部分由我修补」。
- 审核通过 → 在 `pi/team` 上提交（只本地，不 push，不碰 main）：

  用 `git add -u -- . ':(exclude).pi-*'` 加 `git add -- <本轮核实过的新增文件>` 提交；禁用 `git add -A`。

## 9. 外部打开（仅用户询问时）

从绑定表取本对话的会话文件，读第一行拿 `id` 和 `cwd`；没有绑定回 `NOT_BOUND`，否则只回一条：`cd <CWD> && pi --session <ID>`。

## 10. 汇报

固定格式：

- 结论：成功 / 部分完成 / 失败
- Pi 做了什么（按步骤，每条一句话）
- 实际改动（文件 + 增删行数，以 diff 为准）
- 我的审核意见（通过 / 问题清单 / 我修补了什么）
- 风险与未完成项

## 禁止

- 禁止替 Pi 写核心代码
- 禁止不看代码就转述 Pi 的结论
- 禁止启动后不写绑定就派单（启动和绑定要连着做完）
- 禁止同时开多个 headless Pi 写同一会话
- 禁止计划未批准就开工（说「直接干」除外）
- 禁止指挥 Pi 的子代理
- 禁止在 main/master 上直接改动或提交
- 禁止 push
- 禁止删除 `pi/team` 或合并回主干（除非用户明确要求）
- Pi 报错、超时、权限拒绝：原样贴给用户，重试不超过一次
