---
description: Pi team mode: plan, delegate coding to Pi, review and commit
argument-hint: [需求描述]
disable-model-invocation: true
---

# Pi 团队模式

- Claude：定计划、派单、审核、验收；只做拼写、格式、少量修补。
- Pi：写核心代码；子代理自己派，Claude 不指挥。
- 审核必须自己看 diff 和代码，不能转述 Pi 的结论。
- 一个对话只用一个 Pi 会话；同一工作区不并跑。

**所有提问都用 `AskUserQuestion`**，不要用文字问；拿到答案就在同一轮继续。

## 0. 工作区

1. 需求里有路径（`~/...`、`/...`、`./...`）→ 用它。
2. 当前目录是 git 仓库，且不是 `$HOME` → 用它。
3. 判断不出 → 用 `AskUserQuestion` 问「在哪个目录做？」：选项给「当前目录（`<cwd>`）」和「取消」，Other 输入绝对路径。

确定后 `cd <工作区>`，后续命令都在这里执行。禁止把 `$HOME` 当工作区。

## 1. 计划 + 任务书

调用 `EnterPlanMode`，用户批准前不写代码、不派单。计划必须写清：

- 工作区（绝对路径）、目标（可验收）。
- 编号步骤，每步一个能单独验证的产出。
- 每步改哪些文件/接口；拿不准的点标出来。
- 风险与验证方式（具体命令或测试）。

用户批准后，**立刻**把计划写进工作区的 `.pi-start-task.txt`（放在这里方便你手动改计划）：

```
【角色】我是 Claude，你是本项目的秘书，核心编码全部由你完成，我负责计划与审核。
【要求】
1. 按下面的计划实现；子代理由你自己派遣（pi-subagents），不用等 Claude 指令。
2. 每完成一步，立刻汇报：怎么实现的、改了哪些文件、关键 diff 位置。
3. 全部完成后输出：改动文件清单、实现思路、如何验证、剩余风险。
4. 计划里没写的改动不要做；要偏离计划先停下说明原因。
5. 不能暂存、不能推送：禁止 `git add`、`git push`。
【计划】
（用户批准的完整计划，原样贴进来）
【需求原文】
（用户原始需求）
```

## 2. 准备分支

先问用户：

- **不是 git 仓库** → `AskUserQuestion` 问「这个目录不是 git 仓库，要创建吗？」：选项「创建（pi/team）」/「不创建，直接改」。
  - 创建 → `git init -b pi/team`，把当前目录（排除 `.pi-*`）提交为 `baseline: before pi task`；提交失败就停。
  - 不创建 → 不走 git；后面所有 git 步骤跳过，直接改文件。
- **已经是 git 仓库** → `AskUserQuestion` 问「要新建/切换到 pi/team 分支吗？」：选项「新建/切换 pi/team」/「不建，就在当前分支改」。
  - 同意 → 切到 `pi/team`，没有就新建；切不过去就贴错误停。有未提交改动 → 提交为 `wip: before pi task`（排除 `.pi-*`），提交失败就停。
  - 不同意 → 留在当前分支，不提交，直接改。

只提交本地，不 push。

## 3. 派单 + 绑定

先看这个对话有没有绑定记录：

```bash
jq -e --arg sid "$CLAUDE_CODE_SESSION_ID" 'has($sid)' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" >/dev/null 2>&1 && echo "ALREADY_BOUND"
```

- 有 `ALREADY_BOUND` → 用 `AskUserQuestion` 问「这个对话已经绑定了一条 Pi 会话，直接用它吗？」：选项「直接用它」/「不用，重新选」。
  - 直接用它 → 第二个参数传 `bind`，跳到下面的派单脚本。
  - 不用 → 继续下面的问题。
- 没有输出 → 直接继续下面的问题。

用 `AskUserQuestion` 问「这次是新建 Pi 会话，还是绑定已有会话？」：

- **新建** → 第二个参数传 `new`，直接启动一个新的 Pi 会话。
- **绑定已有** → 读 `${CLAUDE_PLUGIN_ROOT}/commands/connect.md` 并照它执行（不要在这里重写列会话/绑定逻辑）；看到 `BOUND` 后回来，第二个参数传 `bind`。

陌生仓库先用 `AskUserQuestion` 确认「允许加载本地扩展吗？」（继续 / 取消），取消就停。

运行这条命令：新建时先启动 Pi，从 Pi 的会话事件里拿 ID，再写绑定；用旧会话时直接拿旧 ID 启动，绑定表本来就有，不用重写。**看到 `BOUND=` 才算成功**；`BAD_TASK_MODE` / `NOT_BOUND` / `NO_SESSION` / `BIND_FAILED` 就贴出来并停。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pi-dispatch.sh" "<工作区>" "<new|bind>" "start"
```

## 4. 等 Pi 结束

用 Bash 的 `run_in_background` 跑这一条，收到退出通知再进第 5 步：

```bash
while [ "$(cat /proc/$(cat .pi-pid)/comm 2>/dev/null)" = "pi" ]; do sleep 2; done; echo PI_DONE
```

## 5. 审核

1. 读工作区的 `.pi-events.jsonl`：`message_end` 里 assistant 的 text = 汇报；`tool_execution_end.result.structuredContent` = 命令输出与退出码。如果最后一条 assistant 的 `stopReason` 是 `error`，把 `errorMessage` 原样贴给用户并停，不要继续审核。
2. 走了 git：跑 `git status --short -- . ':(exclude).pi-*'`、`git diff --stat`、`git diff`；有 `wip: before pi task` 就对照它，没有就只看 Pi 汇报的文件。没走 git：按 Pi 的汇报逐个读改动文件，跑项目测试。
3. Read 关键文件确认逻辑真的实现（不是注释、占位、假数据）。
4. 查：功能是否实现、是否删了原逻辑或吞异常、是否有计划外改动、声称的测试是否真跑过。

## 6. 返工 / 收尾

- 核心问题 → 返工单**追加**到 `.pi-start-task.txt`，直接执行第 3 节末尾的 bash（参数固定 `bind`），再等第 4 节；不要再走第 3 节的提问。最多两轮。
- 小问题（拼写、格式、一行修补）→ 自己改，报告注明「这部分由我修补」。
- 通过后：用户同意建仓库/分支才提交到 `pi/team`（排除 `.pi-*`，提交信息 `fix: <简述>`，不要 `git add -A`）；没同意就跳过提交，直接汇报。

## 7. 汇报

- 结论：成功 / 部分完成 / 失败
- Pi 做了什么（按步骤，每步一句）
- 实际改动（文件 + 增删行数，以 diff 为准）
- 审核意见（通过 / 问题清单 / 我修补了什么）
- 风险与未完成项

## 禁止

- 替 Pi 写核心代码
- 不看代码就转述 Pi 的结论
- 没有 `BOUND=` 就往下走
- 同时开两个 headless Pi 写同一会话
- 计划未批准就开工（说「直接干」除外）
- 指挥 Pi 的子代理
- 用户选了分支后还在 main/master 上改动或提交；push 一律禁止
