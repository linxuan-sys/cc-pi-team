---
description: Review code with Pi (read-only task), fix and re-review until it passes
disable-model-invocation: true
---

Pi 有自己的全部工具和 MCP；"工作区只读"只写在任务书里。`pi --mode rpc` 会自动执行工具，`--approve` 还会加载项目本地扩展/设置；陌生仓库先告诉用户。

## 工作区与范围

工作区就是当前目录，后续命令都在这里。

用 `AskUserQuestion` 问「审查范围是什么？」：

- 整个仓库
- 最新提交（仅 Git 仓库）
- Other 输入特定文件夹或文件

不是 git 仓库就不要给「最新提交」这个选项。

**所有提问都用 `AskUserQuestion`**，不要用文字问；拿到答案就在同一轮继续。

## 0. 模式

用一次 `AskUserQuestion` 问三个问题：

1. **模式**：自动修复 / 只报告。
2. **轮数**（自动模式用）：强 10 轮 / 中 5 轮 / 弱 3 轮 / 疯狂模式（不设上限，只认全新审核者首轮通过，慎选）。
3. **精细度**：
   - 细：找所有隐患和 Bug，指出冗余，可建议优化（只建议）。
   - 中：只找隐患和 Bug，不建议新功能。
   - 粗：只找影响使用的严重 bug。
4. **并行审**（可选）：单审 / 并行审（正确性、边界与异常、性能与资源各一条 Pi 会话，各用一个独立目录/worktree，约 3 倍 token）。默认单审。

模式和轮数只记在本次对话里，不写文件。

## 1. 准备仓库

先问用户（`AskUserQuestion`）：

- **不是 git 仓库** → 「要创建吗？」：创建（pi/team）/ 不创建，直接审。
  - 创建 → `git init -b pi/team`，把当前目录（排除 `.pi-*`）提交为 `baseline: before pi review`；提交失败就停。
  - 不创建 → 不走 git；按选定的范围审。
- **已经是 git 仓库** → 「要新建/切换到 pi/team 分支吗？」：新建/切换 pi/team / 不建，就在当前分支审。
  - 同意 → 切到 `pi/team`，没有就新建；切不过去就贴错误停。没有 HEAD → 报 `NO_HEAD` 停；有未提交改动 → 提交为 `wip: before pi review`（排除 `.pi-*`），失败就停。
  - 不同意 → 留在当前分支；没有 HEAD → 报 `NO_HEAD` 停；不提交。
- 只提交本地，不 push。

## 2. 任务书

写入工作区的 `.pi-review-task.txt`（放在这里方便你手动改）：

```
【角色】我是 Claude，你是独立的代码审查者。你不改代码，只找问题。
【任务】使用 code-review 技能审查：<选定的范围：整个仓库 / 最新提交（git show HEAD）/ 指定路径>
【权限】全部工具可用：可以读文件、跑命令、写临时脚本（放 /tmp）。
但工作区只读：禁止修改、新建、删除项目里的任何文件。
【要求】
1. 先确认范围（整个仓库 / git show HEAD / 指定路径），再逐个读相关文件，不要只看 diff 摘要。
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

## 3. 派单 + 绑定

如果是从 `/pi:start` 或 `/pi:connect` 转来的审查：先删当前对话的绑定（jq del 当前 sid，不要清空整表），再走下面的检查；后面必须选「新建」，不要复用旧会话。

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

运行这条命令：新建会话时由 Pi 生成 ID，broker 用 `get_state` 拿到会话文件；用旧会话时直接拿绑定里的 ID 恢复。broker 以 `pi --mode rpc` 常驻，拿到会话文件后写绑定并输出 `BOUND=`。**看到 `BOUND=` 才算成功**；`BAD_TASK_MODE` / `NOT_BOUND` / `NO_SESSION` 就贴出来并停。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pi-dispatch.sh" "$PWD" "<new|bind>" "review"
```

## 4. 等 Pi 结束

Pi 跑着的时候要纠偏用 `/pi:steer <指令>`，要停用 `/pi:abort`；不要重复派单。

用 Bash 的 `run_in_background` 跑这一条，收到退出通知再进第 5 步：

```bash
while [ ! -f .pi-done ] && kill -0 "$(cat .pi-pid 2>/dev/null)" 2>/dev/null; do sleep 2; done; echo PI_DONE
```

## 5. 复核

1. 读 `.pi-events.jsonl`：`message_end` 里 assistant 的 text = 报告；`tool_execution_end.result.structuredContent` = 命令输出与退出码。末尾的 `delegate_done` 是收尾标记：`status` 为 `completed` / `aborted` / `failed`，`error` 非空就是 Pi 报的错。如果最后一条 assistant 的 `stopReason` 是 `error`，把 `errorMessage` 原样贴给用户并停。
2. 逐条打开 `文件:行` 复核：属实保留，报错标「已复核：误报」。
3. 「Pi 报的」和「我复核过的」分开写。
4. 修改前必须再三确认：这个 bug 是否真的会触发、是否真的有必要改；不要完全照 Pi 的清单改。

## 6. 循环

- **疯狂模式**：不设轮数上限。每次修改后**新开**一条 Pi 会话（`new`）审核；只有全新审核者**首轮**结论为“通过”才算通过。首轮不通过就继续修、继续换新审核者，旧审核者的复审“通过”不算数，直到某位首轮通过。
- **并行审**：每个方向一个独立目录/worktree（同一目录只能一个 Pi），各放自己的 `.pi-review-task.txt`，派单传该目录，读各自的 `.pi-events.jsonl` 和 `.pi-done`；等全部完成，Claude 去重、逐条复核、合并成一份清单，再回主工作区按自动/只报告模式继续。修复后的复审回到主会话，不再三路重跑。
- **只报告模式**：复核完逐条给用户：是否属实、证据（文件:行）、修复建议；然后停。用户说「改」→ 按自动模式的 1–3 步修复、提交、复审（轮数上限照所选）。
- **自动模式**：最多审到开工前选的轮数（强 10 / 中 5 / 弱 3）；到上限仍未通过就停，如实汇报。
  1. 只有用户同意建仓库/分支才提交到本地 `pi/team`；没同意就不提交。提交信息 `fix: review round <n>`，排除 `.pi-*`，不 push；HEAD 没变不许重跑第 3、4 节。
  2. 问题清单和修复说明**追加**到 `.pi-review-task.txt`，要求逐条确认并重扫。
  3. **立刻**直接执行第 3 节末尾的 bash（参数固定 `bind`），再等第 4 节；不要再走第 3 节的提问。复核、再修；只有用户同意建分支才再提交。
  4. 中途不要问用户，不要每轮汇报；只在通过、达到轮数上限、或必须用户拍板时停。
  5. 结束时一次性汇报：共几轮、每轮修了什么、最终结论、剩余问题。

## 7. 汇报

- 结论：通过 / 有条件通过 / 不通过
- 共几轮，每轮修了什么
- Pi 报的 vs 我复核过的（误报标出来）
- 剩余问题与风险
