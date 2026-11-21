---
description: Review code with Pi (read-only), fix and re-review until it passes
argument-hint: [审查目标，可空]
allowed-tools: Bash(acpx *) Bash(claude plugin list *) Bash(cd *) Bash(jq *) Bash(flock *) Bash(git init *) Bash(git add *) Bash(git commit *) Bash(git switch *) Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git rev-parse *) Bash(python3 *) Read Grep Glob Write Edit
disable-model-invocation: true
---

分工：**Pi 只读**（可读文件、跑命令、写临时脚本到 `/tmp`，但不许改工作区）；**Claude 负责按结论修复**。

**安全提醒**：Pi 以 `--approve-all` 启动，等于放行它想跑的任意命令；"只读"只是任务书里的约定，不是技术限制。工作区来自他人仓库时，先向用户说明这一点。

审查目标：$ARGUMENTS
（为空 = 当前未提交的改动；不是 git 仓库就审查整个项目目录）

## 0. 准备工作区（不切分支）

```bash
cd "<工作区>"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -q
  git add -A -- . ':(exclude).pi-*'
  git commit -qm "baseline: before pi review" || true
fi
git rev-parse HEAD > .pi-review-base   # 记下审查起点，后面按它定范围
```

审查**不切换分支**：在用户当前的分支上审，范围只算 `git diff HEAD`。切到 `pi/team` 会把两条分支的差异全混进来，审错对象。

## 1. 确定范围

- 有 git 且相对起点有改动（含已暂存）→ `BASE=$(cat .pi-review-base 2>/dev/null); [ -n "$BASE" ] || BASE=HEAD`，审 `git diff "$BASE"`
- 有 git 但 `git diff "$BASE"` 为空 → 审最近一次提交 `git show "$BASE"`
- 不是 git 仓库 → 审整个目录

## 2. 确保会话并绑定

```bash
acpx pi sessions ensure
```

解析会话文件：**直接照抄 `/pi:start` 阶段 2 的绑定代码块**（含 `flock` 与 `jq`），不要凭这句话自己重写。把当前 `CLAUDE_CODE_SESSION_ID` → 会话文件路径写进 `$ROOT/pi-bindings.json`，这样侧边栏能看到审查过程。已经绑了别的会话就先停下，让用户 `/pi-unbind`；如果这条 Pi 会话已经被**别的 CC 对话**占用，同样停下，不要两个对话同时驱动一个 Pi 会话。

## 3. 写任务书

把下面内容写入 `.pi-task.txt`：

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
【输出】
按严重程度排序（阻断 / 重要 / 次要 / 建议），每条：
- 文件:行 — 问题 — 为什么是问题 — 修复建议
最后给结论：通过 / 有条件通过 / 不通过。
```

## 4. 后台执行

```bash
acpx --approve-all --timeout 3600 --format json pi -f .pi-task.txt > .pi-events.jsonl 2>&1
```

用后台方式启动，用户通过侧边栏观察。

## 5. 汇总并复核

1. 解析 `.pi-events.jsonl`，把 Pi 的问题清单**原样汇总**，不许美化或扩写。
2. **逐条复核**：打开对应文件和行号确认。
   - 属实的 → 保留
   - 报错的 → 标注"已复核：误报"
3. 汇报时把"Pi 报的"和"我复核过的"分开写，别混在一起。

## 6. 修复 → 复审循环（必须跑到通过）

拿到问题清单后：

1. **逐条修复**（你改，Pi 只读）。修完记下每条对应的改动位置。
   修完立刻暂存这一轮的改动：
   ```bash
   git add -u -- . ':(exclude).pi-*'
   git add -- <本轮新增的文件>
   ```
   只暂存，不 commit、不 push。
2. **再发一轮审查**：用同一个会话，把上一轮的问题清单和你的修复说明一起发过去，要求它逐条确认，并重新扫一遍。
3. 它说**通过** → 停下来汇报。
4. 它说**不通过** → 再修一轮 → **再暂存一轮** → 再发过去，直到它说通过。

**安全阀**：最多 5 轮。第 5 轮仍不通过就停下，如实报告"未通过"，列出剩余问题，交用户决定——不要无限烧下去。

每轮都要在汇报里写清楚：第几轮、修了什么、它这轮的结论。

## 7. 只用这一个会话

不新增、不重复派单。审查结束不解绑（用户下次还能继续用）。
