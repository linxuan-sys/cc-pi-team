---
description: Review code with Pi (read-only task), fix and re-review until it passes
argument-hint: [审查目标，可空]
disable-model-invocation: true
---

Pi 有全套工具和全部 MCP；"工作区只读"只写在任务书里。`pi -p` 会自动执行工具，`--approve` 还会加载项目本地扩展/设置；陌生仓库先告诉用户。

用户说「直接跟她说」→ 用「用户原话说：<原话>」转给 Pi，转完照常复核。

审查目标：$ARGUMENTS（空 = 当前未提交改动；非 git 仓库 = 整个目录）

## 模式（开工前先问）

用 `AskUserQuestion` 问「这次审查用哪种模式？」：

1. **自动模式** —— 每轮 Pi 审完，我复核、修复、提交本地 `pi/team`，再送审，直到通过或到轮数上限。
2. **计划模式** —— Pi 每报一条，我只确认是否真实存在并给修复建议；不改代码、不提交。用户说「改」之后才动手。

选了自动模式，再问「自动模式强度？」：**强** 10 轮 / **中** 5 轮 / **弱** 3 轮。

最后问「审核精细度？」（自动/计划都问）：
- **细**：找出所有可能存在的隐患和 Bug，指出代码冗余，并建议可能优化的功能（只建议，不改）。
- **中**：只找所有可能存在的隐患和 Bug，不建议增加新功能。
- **粗**：只找可能影响使用的严重 bug；不影响使用或不触发的不提。

模式、强度、精细度只记在本次对话里，不写文件。

## 0. 准备仓库与分支

`/pi:review` 可以单独跑，不依赖 `/pi:start`，所以 git 这一步全部在这里做完：

1. **不是 git 仓库** → `git init -b pi/team`（默认分支就叫 `pi/team`）→ `git add -A`（排除 `.pi-*`）→ `git commit -m "baseline: before pi review"`。
2. **已经是 git 仓库** → 有 `pi/team` 就 `git switch pi/team`；没有就 `git switch -c pi/team` 新建。切过去后确认仓库有提交：`git rev-parse --verify -q HEAD` 失败 → 报 `NO_HEAD`，停。
3. **记审查起点** → `git rev-parse HEAD > .pi-review-base`。
4. **有未提交改动** → `git add -A`（排除 `.pi-*`）+ `git commit -m "wip: before pi review"`。必须先记起点再提交，审查范围 `git diff .pi-review-base` 才会包含这些改动。
5. 只提交本地，不 push 远程；分支只用 `pi/team`。


- `NO_HEAD`（仓库没有任何提交）/ `SWITCH_FAILED`（切分支失败，通常是有冲突的未提交改动）→ 贴给用户，停。
- 只提交本地，不 push。

## 1. 范围

- `BASE=$(cat .pi-review-base 2>/dev/null); [ -n "$BASE" ] || BASE=HEAD`
- `git diff "$BASE"` 非空 → 审这个
- 为空 → `git show "$BASE"`
- 非 git 仓库 → 整个目录

## 2. 任务书

写入 `.pi-review-task.txt`（第 6 条把开工前选的精细度那一段原样写进去）：

```
【角色】我是 Claude，你是独立的代码审查者。你不改代码，只找问题。
【任务】使用 code-review 技能审查：<上面的审查范围>
【权限】全部工具可用：可以读文件、跑命令、写临时脚本（放 /tmp）。
但工作区只读：禁止修改、新建、删除项目里的任何文件。
【要求】
1. 先跑 git status / git diff 确认范围，再逐个读相关文件，不要只看 diff 摘要。
2. 重点检查：逻辑错误、边界条件、异常被吞、资源泄漏、并发竞态、性能问题、安全风险、死代码与无用变量、与项目约定不一致。
3. 每条问题必须落到具体 文件:行；不确定的标注"待确认"，不要编。
4. 不要改代码，也不要给整段重写，只给问题与修复建议。
5. 每轮修复后我都会提交到本地分支 `pi/team`（不 push）。复审时先用 `git status`、`git log --oneline -3` 和 `git show HEAD` 对比仓库，看这一轮到底改了什么；分支是 `pi/team`。任何情况下你都不能创建分支、不能提交、不能暂存、不能推送（禁止 git add / git commit / git push）。
6. 审核精细度：<开工前所选的那一段，原样写在这里：细 / 中 / 粗>
【输出】
按严重程度排序（阻断 / 重要 / 次要 / 建议），每条：
- 文件:行 — 问题 — 为什么是问题 — 修复建议
最后给结论：通过 / 有条件通过 / 不通过。
```

## 3. 定会话

先读本对话的绑定：`jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" '.[$sid] // empty' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"`。

- **有绑定且文件存在** → 从文件第一行取 `id`（没有就从文件名里取）写进 `.pi-session-id`；杀掉本工作区其他还活着的 **headless** `pi`（`pi -p ...`；按 `pgrep -f "^pi .*--session-id"` 找，用 `/proc/<pid>/cwd` 过滤，交互式 `pi --session` 不动）；再看这个 id 是否在跑，输出 `BOUND_RUNNING:<id>` 或 `BOUND_IDLE:<id>`。
- **没有绑定** → 看本工作区有没有在跑的 `pi`，有就输出 `RUNNING=<id>`，没有输出 `RUNNING=`。

- **`BOUND_IDLE:<id>`** → 直接进第 4 节，用这条会话启动审查。
- **`BOUND_RUNNING:<id>`** → 先跑第 5 节等待，它退出后再进第 4 节启动审查。
- **`RUNNING` 非空** → 采用这条会话：写 `.pi-session-id`，在 `~/.pi/agent/sessions/*/*_<RUNNING>.jsonl` 里找首行 `cwd` 匹配的文件（找不到报 `NO_SESSION`），先跑 4.2 绑定（面板能看到），再等它退出、进第 4 节启动审查。
- **`RUNNING` 为空** → 用 `AskUserQuestion` 问「这个工作区没有正在跑的 Pi，要新开一个吗？」：
  1. **是，新开一个 Pi** → `ID=$(cat /proc/sys/kernel/random/uuid)`，写 `.pi-session-id`，进第 4 节。
  2. **否，用已有对话** → 执行 `/pi:connect` 的流程（列该工作区及子目录的 Pi 会话，用户回编号，写绑定）；绑定后从 `pi-bindings.json` 取回 ID 写进 `.pi-session-id`，再进第 4 节启动审查。

## 4. 启动并绑定

### 4.1 启动

启动（一条命令，后台跑）：

`setsid nohup pi -p --approve --mode json --session-id "$(cat .pi-session-id)" "$(cat .pi-review-task.txt)" > .pi-events.jsonl 2>&1 < /dev/null &`

然后在 `~/.pi/agent/sessions/*/*_<ID>.jsonl` 里等一个首行 `cwd` 等于当前工作区的文件，最多 60 秒。等到就输出 `FILE=<路径>`；等不到就杀掉这个 id 的 pi，报 `NO_SESSION`，停。同时确认这个 id 的 pi 真在跑（`pgrep -f` 命中）；没起来就贴 `.pi-events.jsonl` 尾部，停。

### 4.2 写绑定

`FILE` 来自 4.1，或第 3 节直接绑定时找到的会话文件。

绑定表不存在时先建空表：`[ -f "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" ] || printf '{}' > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"`。

用 jq 写绑定（一行）：

`jq --arg sid "$CLAUDE_CODE_SESSION_ID" --arg p "<会话文件>" '.[$sid] = $p' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" && mv "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"`

- 写成功 → 继续。
- `NO_SESSION`（4.1 没等到会话文件）→ 贴 `.pi-events.jsonl` 尾部错误，停。
- jq 报错、或这条会话已归别的对话 → 贴给用户，停；session id 变了就用 `/pi:connect` 重新接。

## 5. 等 Pi 结束

后台运行：

后台循环直到这个 id 的 pi 退出，然后输出 `PI_DONE`：

`while pgrep -f "^pi .*--session-id[= ]$(cat .pi-session-id)" >/dev/null; do sleep 2; done`

10 分钟被工具杀掉（退出码 -1）不代表 Pi 死了：先 `pgrep`，活着就再挂一次。

## 6. 复核

1. `message_end` 里 `role == "assistant"` 的 text 块 = 报告；`tool_execution_end.result.structuredContent` = 命令输出与退出码。
2. 逐条打开 `文件:行` 复核：属实保留，报错标「已复核：误报」。
3. 「Pi 报的」和「我复核过的」分开写。
4. **计划模式**：复核完直接汇报（属实/误报 + 修复建议），停，等用户说「改」；按第 7 节的计划模式走。

## 7. 复核之后（按模式）

- **计划模式**：逐条给用户：是否属实、证据（文件:行）、修复建议；然后停。用户没说「改」之前不动代码、不提交。
- **自动模式**：按下面循环，最多审到开工前选的轮数（强 10 / 中 5 / 弱 3）；到上限仍未通过就停，如实汇报。

1. 修完提交到本地分支 `pi/team`（不 push 远程）：用 `git add -u -- . ':(exclude).pi-*'` 加 `git add -- <本轮新增文件>` 提交。

2. 问题清单和修复说明**追加**到 `.pi-review-task.txt`，要求逐条确认并重扫。
3. **立刻**重跑第 3、4、5 节（同一会话 ID），复核、再修、再提交。
4. **中途不要问用户，不要每轮汇报**；只在通过、达到所选轮数上限、或必须用户拍板时停。
5. 结束时一次性汇报：共几轮、每轮修了什么、最终结论、剩余问题。
6. 修复只针对报告里的问题；新功能建议只汇报，不动代码（用户明确要求才做）。

## 8. 一个会话

不新建、不重复派单、结束不解绑。
