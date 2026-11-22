---
description: Review code with Pi (read-only task), fix and re-review until it passes
argument-hint: [审查目标，可空]
disable-model-invocation: true
---

Pi 有自己的全部工具和 MCP；"工作区只读"只写在任务书里。`pi -p` 会自动执行工具，`--approve` 还会加载项目本地扩展/设置；陌生仓库先告诉用户。

## 工作区与目标

`$ARGUMENTS` 是目录就用它（否则当前目录），确定后 `cd <工作区>`，后续命令都在这里；是文件或目录就审它，否则审 `.pi-review-base` 之后的改动。

**所有提问都用 `AskUserQuestion`**，不要用文字问；拿到答案就在同一轮继续。

## 0. 模式

用一次 `AskUserQuestion` 问三个问题：

1. **模式**：自动修复 / 只报告。
2. **轮数**（自动模式用）：强 10 轮 / 中 5 轮 / 弱 3 轮。
3. **精细度**：
   - 细：找所有隐患和 Bug，指出冗余，可建议优化（只建议）。
   - 中：只找隐患和 Bug，不建议新功能。
   - 粗：只找影响使用的严重 bug。

模式和轮数只记在本次对话里，不写文件。

## 1. 准备仓库

先问用户（`AskUserQuestion`）：

- **不是 git 仓库** → 「要创建吗？」：创建（pi/team）/ 不创建，直接审。
  - 创建 → `git init -b pi/team`，把当前目录（排除 `.pi-*`）提交为 `baseline: before pi review`；提交失败就停；记下 HEAD 到 `.pi-review-base`。
  - 不创建 → 不走 git，审查范围是整个目录。
- **已经是 git 仓库** → 「要新建/切换到 pi/team 分支吗？」：新建/切换 pi/team / 不建，就在当前分支审。
  - 同意 → 切到 `pi/team`，没有就新建；切不过去就贴错误停。没有 HEAD → 报 `NO_HEAD` 停；记下 HEAD 到 `.pi-review-base`；有未提交改动 → 提交为 `wip: before pi review`（排除 `.pi-*`），失败就停。
  - 不同意 → 留在当前分支；没有 HEAD → 报 `NO_HEAD` 停；记下 HEAD 到 `.pi-review-base`；不提交。
- 只提交本地，不 push。

## 2. 审查范围

- 走了 git：`BASE=$(cat .pi-review-base 2>/dev/null); [ -n "$BASE" ] || BASE=HEAD`
  - `git diff "$BASE"` 非空 → 审这个
  - 为空 → `git show "$BASE"`
- 否则没走 git：整个目录。

## 3. 任务书

写入工作区的 `.pi-review-task.txt`（放在这里方便你手动改）：

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
5. 如果用户同意建仓库/分支，我修复后会提交到本地 `pi/team`（不 push）；没同意就不提交。复审时先用 git status / git log --oneline -3 / git show HEAD 对比仓库。任何情况下你都不能创建分支、不能提交、不能暂存、不能推送（禁止 git add / git commit / git push）。
6. 审核精细度：<开工前所选的那一段，原样写在这里：细 / 中 / 粗>
【输出】
按严重程度排序（阻断 / 重要 / 次要 / 建议），每条：
- 文件:行 — 问题 — 为什么是问题 — 修复建议
最后给结论：通过 / 有条件通过 / 不通过。
```

只报告模式：把第 5 条换成「本次只报告，不修复、不提交；不要按修复轮组织输出」。

## 4. 派单 + 绑定

先看这个对话有没有绑定记录：

```bash
jq -e --arg sid "$CLAUDE_CODE_SESSION_ID" 'has($sid)' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" >/dev/null 2>&1 && echo "ALREADY_BOUND"
```

- 有 `ALREADY_BOUND` → 用 `AskUserQuestion` 问「这个对话已经绑定了一条 Pi 会话，直接用它吗？」：直接用它 / 不用，重新选。
  - 直接用它 → 第二个参数传 `bind`，跳到下面的派单脚本。
  - 不用 → 继续下面的问题。
- 没有输出 → 继续下面的问题。

用 `AskUserQuestion` 问「这次是新建 Pi 会话，还是绑定已有会话？」：

- **新建** → 第二个参数传 `new`。
- **绑定已有** → 读 `${CLAUDE_PLUGIN_ROOT}/commands/connect.md` 并照它执行；看到 `BOUND` 后回来，第二个参数传 `bind`。

陌生仓库先用 `AskUserQuestion` 确认「允许加载本地扩展吗？」（继续 / 取消），取消就停。

运行这条命令：**看到 `BOUND=` 才算成功**；`BAD_TASK_MODE` / `NOT_BOUND` / `NO_SESSION` / `BIND_FAILED` 就贴出来并停。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pi-dispatch.sh" "<工作区>" "<new|bind>" "review"
```

## 5. 等 Pi 结束

用 Bash 的 `run_in_background` 跑这一条，收到退出通知再进第 6 步：

```bash
while [ "$(cat /proc/$(cat .pi-pid)/comm 2>/dev/null)" = "pi" ]; do sleep 2; done; echo PI_DONE
```

## 6. 复核

1. 读 `.pi-events.jsonl`：`message_end` 里 assistant 的 text = 报告；`tool_execution_end.result.structuredContent` = 命令输出与退出码。如果最后一条 assistant 的 `stopReason` 是 `error`，把 `errorMessage` 原样贴给用户并停。
2. 逐条打开 `文件:行` 复核：属实保留，报错标「已复核：误报」。
3. 「Pi 报的」和「我复核过的」分开写。
4. 修改前必须再三确认：这个 bug 是否真的会触发、是否真的有必要改；不要完全照 Pi 的清单改。

## 7. 循环

- **只报告模式**：复核完逐条给用户：是否属实、证据（文件:行）、修复建议；然后停。用户说「改」→ 按自动模式的 1–3 步修复、提交、复审（轮数上限照所选）。
- **自动模式**：最多审到开工前选的轮数（强 10 / 中 5 / 弱 3）；到上限仍未通过就停，如实汇报。
  1. 只有用户同意建仓库/分支才提交到本地 `pi/team`；没同意就不提交。提交信息 `fix: review round <n>`，排除 `.pi-*`，不 push；HEAD 没变不许重跑第 4、5 节。
  2. 问题清单和修复说明**追加**到 `.pi-review-task.txt`，要求逐条确认并重扫。
  3. **立刻**直接执行第 4 节末尾的 bash（参数固定 `bind`），再等第 5 节；不要再走第 4 节的提问。复核、再修；只有用户同意建分支才再提交。
  4. 中途不要问用户，不要每轮汇报；只在通过、达到轮数上限、或必须用户拍板时停。
  5. 结束时一次性汇报：共几轮、每轮修了什么、最终结论、剩余问题。

## 8. 汇报

- 结论：通过 / 有条件通过 / 不通过
- 共几轮，每轮修了什么
- Pi 报的 vs 我复核过的（误报标出来）
- 剩余问题与风险
