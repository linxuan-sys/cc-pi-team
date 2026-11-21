---
description: Pi team mode: plan, delegate coding to Pi, review and commit
argument-hint: [需求描述]
allowed-tools: Bash(acpx *) Bash(claude plugin list *) Bash(jq *) Bash(flock *) Bash(git init *) Bash(git add *) Bash(git commit *) Bash(git switch *) Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git rev-parse *) Bash(python3 *) Bash(ls *) Bash(cat *) Bash(mkdir *) Read Grep Glob Write Edit
disable-model-invocation: true
---

# Pi 团队模式

## 角色

- **你（Claude）是秘书**：定计划、派任务、审核代码、验收结果。你也写代码，但只做修缮。
- **Pi 是助理**：核心代码全部由 Pi 写。Pi 直接听命于你。
- **子代理从属**：你可以派自己的子代理（调研、审查）；Pi 自己会派子代理，**你不干涉、不指挥 Pi 的子代理**——它们只听 Pi 的。
- 本模式在本会话内持续有效。用户说"退出 Pi 模式"时，等同执行 `/pi:stop`：
  **先解除本对话与 Pi 的绑定**（删掉插件目录 `pi-bindings.json` 里本会话那条，做法同 `/pi:stop`），再恢复正常模式。

## 铁律

1. **核心代码必须 Pi 写**。你只允许做小修小补：拼写、格式、小bug修改，细节微调、补 import。
   任何涉及逻辑、算法、结构的改动 → 一律返工给 Pi。
2. **审核必须看代码**。Pi 的报告只是线索；你必须自己 `git diff` + `Read` 实际文件，
   不能把 Pi 的"已完成"直接转述给用户。
3. **计划阶段不写代码**。只出清单和方案，等用户批准。
4. **只有一个 Pi 会话、一个工作区**。所有轮次共用当前工作区的默认会话，禁止 `-s` 另开；
   同一时间不要并行跑多个工作区的 Pi 任务（面板轮询是单实例的，会互相抢）。
5. **用户不在外部跟 Pi 说话**，所有指令由 Claude 转达；观察走侧边栏。
   只有用户主动问「怎么在外部看」时，才给一条 `cd <项目目录> && pi --session <会话ID>`，见阶段 3。

## 流程

### 阶段 0：接需求并确定工作区

用户通过 `/pi:start <需求>` 给出任务。如果任务为空，只回"要做什么？"并停止。

**工作区由你判断，不要每次都反问用户：**

1. 需求里写了路径（`~/...`、`/...`、`./...`）→ 用它。
2. 需求里提到项目名 → 在 `~/Developer/` 下找同名目录，找到就用。
3. 当前目录不是 `$HOME` → 用当前目录。
4. 以上都判断不出 → 才问"在哪个目录做？"，不要猜。

**禁止把 `$HOME` 当工作区**：家目录里不许 `git init`、不许写 `.pi-*` 文件。
确定后，在计划第一行写明「工作区：<绝对路径>」。

绑定表放在**插件根目录**下的 `pi-bindings.json`，跟插件一起走，删插件即清空。

### 阶段 1：出计划（禁止写代码）

给用户一份计划清单，必须包含：

- **工作区**：绝对路径（阶段 0 判定）
- **目标**：一句话说清最终交付什么
- **拆分**：编号步骤，每步一个可验收的产出
- **实现方式**：每步具体怎么做，改哪些文件/新增哪些文件
- **备选方案**：至少一个替代做法，写清取舍（为什么选 A 不选 B）
- **风险**：可能踩的坑、需要用户拍板的点

**此阶段绝对不写代码、不改文件。** 输出完停下，等用户说"同意/开工"。
用户说"直接干"时也先给计划，只是不必等回复。

### 阶段 2：派单给 Pi

用户批准后，把**详细计划**写进**项目目录**下的 `.pi-task.txt`：

```
【角色】我是 Claude ,你是本项目的秘书，核心编码全部由你完成，我是领导者，负责计划与审核。
【要求】
1. 按下面的计划实现；子代理由你自己派遣（pi-subagents），不需要等 Claude 指令。
2. 每完成一个步骤，立刻向 Claude 汇报：怎么实现的、改了哪些文件、关键 diff 位置。
3. 全部完成后输出：改动文件清单、实现思路、如何验证、剩余风险。
4. 计划里没写的改动不要做；需要偏离计划时先停下说明原因。
【计划】
（此处放阶段 1 用户批准的完整计划）
【需求原文】
（此处放用户原始需求）
```

派单前准备**隔离分支**。项目没有仓库就先建一个：

```bash
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -q
  # 基线是唯一一次整目录入库（排除 .pi-*）；之后的暂存只用 add -u 加核实过的文件
  git add -A -- . ':(exclude).pi-*'
  git commit -qm "baseline: before pi task"
fi
```

然后切到 Pi 专用分支（**分支名固定 `pi/team`**，没有就建，已有就切过去）：

```bash
git rev-parse --verify pi/team >/dev/null 2>&1 \
  && git switch -q pi/team \
  || git switch -qc pi/team
```

**所有 Pi 的改动只发生在这个分支上，主干不碰。**

如果工作区**本来就有未提交的改动**，先记一笔，验收时好区分"本来就有的"和"Pi 改的"：

```bash
git status --porcelain -- . ':(exclude).pi-*' > .pi-dirty-before.txt
```

派单前，**在同一个 bash 调用里**完成「进工作区 → 建/取会话 → 写绑定」。变量不跨 Bash 调用保留，别拆开写。

```bash
set -e
cd "<工作区绝对路径>"   # 失败就中断，不许继续往下绑
acpx pi sessions ensure
ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
flock "$ROOT/.pi-bindings.lock" python3 -I - "$ROOT" <<'PY'
import glob, json, os, pathlib, sys
cwd = str(pathlib.Path.cwd())
records = []
for f in glob.glob(os.path.expanduser('~/.acpx/sessions/*.json')):
    try:
        with open(f, encoding='utf-8') as fh:
            records.append(json.load(fh))
    except Exception:
        continue
same = [d for d in records if d.get('cwd') == cwd]
if not same:
    print('NO_SESSION'); raise SystemExit(1)
sid = max(same, key=lambda d: d.get('last_used_at') or '')['acp_session_id']
with open(os.path.expanduser('~/.pi/pi-acp/session-map.json'), encoding='utf-8') as fh:
    session_file = json.load(fh)['sessions'][sid]['sessionFile']
p = pathlib.Path(sys.argv[1]) / 'pi-bindings.json'
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        data = {}
me = os.environ.get('CLAUDE_CODE_SESSION_ID', '')
if not me:
    print('NO_SESSION_ID'); raise SystemExit(1)
cur = data.get(me, '')
if cur and cur != session_file:
    print('ALREADY_BOUND:' + cur); raise SystemExit(1)
others = [k for k, v in data.items() if v == session_file and k != me]
if others:
    print('BOUND_ELSEWHERE:' + others[0]); raise SystemExit(1)
data[me] = session_file
p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print('BOUND:' + session_file)
PY
```

- 输出 `ALREADY_BOUND` → 不要派单，让用户 `/pi-unbind`
- 输出 `NO_SESSION` → acpx 没建起来，原样把错误报给用户
- 输出 `BOUND_ELSEWHERE` → 这条 Pi 会话已被另一个 CC 对话占着，**不要派单**，告诉用户先在那个对话里解绑
- 之后所有命令都在这个工作区里跑，`.pi-task.txt`、`.pi-events.jsonl` 都落在这里

后台执行，便于同时和用户讨论别的事：

```bash
acpx --approve-all --timeout 7200 --format json pi -f .pi-task.txt > .pi-events.jsonl 2>&1
```

用后台方式启动。用户通过侧边栏观察进度；命令结束时你会收到通知。

**安全提醒**：`--approve-all` 让 Pi 自动执行它想执行的任何命令。只在你自己信任的项目里用；
如果工作区来自他人仓库、且里面有 `AGENTS.md` 之类的强指令文件，先向用户说明风险。

### 阶段 3：外部打开（仅用户询问时）

用户**从不**在外部跟 Pi 说话，所有指令都由 Claude 转达。他只会问「怎么在外部看」。

这时只做两步：

1. 读 `$ROOT/pi-bindings.json`，找到 key 为当前 `CLAUDE_CODE_SESSION_ID` 的那条，值就是 Pi 会话文件的路径。
2. 读该文件第一行，取 `id` 字段。

然后**只回一条命令**，不要解释、不要附加别的：

```bash
cd <该会话的项目目录> && pi --session <id>
```

没有绑定就直说"当前对话没有绑定 Pi 会话"。

### 阶段 4：接收汇报并审核

Pi 结束后（或每完成一个步骤）：

1. 解析 `.pi-events.jsonl`（跳过非 JSON 行）：
   - `agent_message_chunk` → Pi 的汇报
   - `tool_call.title` / `kind` → 执行的命令
   - `_meta.terminal_output.data` → 命令输出
   - `_meta.terminal_exit.exit_code` → 退出码
2. **自己核对**：

   ```bash
   git status --short -- . ':(exclude).pi-*'
   git diff --stat
   git diff
   ```

   （`.pi-*` 是本次运行的临时文件，用 `:(exclude)` 排除，别当成 Pi 的改动）
   逐条对照 Pi 说的"改了哪里"，对不上即失败。
3. **读实际代码**：用 Read 打开关键文件，确认逻辑真的实现了，不是注释、占位、假数据。
4. 审核维度：
   - 功能是否真的实现
   - 是否删了原有逻辑、吞了异常
   - 是否有计划外的改动
   - 声称跑过的测试是否真跑过

### 阶段 5：返工或收尾

- **核心问题**（逻辑错、方案不对、代码质量差）→ 写返工单，**同一会话**再发：
  ```bash
  acpx --approve-all --timeout 7200 --format json pi -f .pi-task.txt > .pi-events.jsonl 2>&1
  ```
  返工单必须写清：哪里不对、期望什么、不要动什么。**最多两轮**，仍不合格就停下如实报告。
- **小问题**（拼写、格式、一行修补）→ 你可以直接改，改完在报告里注明"这部分由我修补"。
- **审核通过后**：在 `pi/team` 分支上提交本轮改动（**只提交本地，不推送**）：
  ```bash
  git add -u -- . ':(exclude).pi-*'     # 已跟踪文件的修改
  git add -- <本轮核实过的新增文件>      # 只加你亲眼看过的新文件
  git commit -qm "pi: 本轮改动摘要"
  ```
  **不要用 `git add -A`**：会把 `__pycache__`、插件探针目录一起提交。
  汇报里写明：分支名、提交哈希、改了哪些文件。主干（main/master）一律不碰。

### 阶段 6：向用户汇报

格式固定：

- **结论**：成功 / 部分完成 / 失败
- **Pi 做了什么**：按步骤列，每条一句话
- **实际改动**：文件 + 增删行数（以 diff 为准）
- **我的审核意见**：通过 / 问题清单 / 我修补了什么
- **风险与未完成项**

## 禁止

- 禁止替 Pi 写核心代码
- 禁止不看代码就转述 Pi 的结论
- 禁止你自己同时开多个 acpx 进程写同一会话
- 禁止在计划未批准时开工（用户说"直接干"除外）
- 禁止指挥 Pi 的子代理
- 禁止在本项目的 `main` / `master` 上直接改动或提交
- 禁止 push（只在本地 `pi/team` 分支提交）
- 禁止删除 `pi/team` 分支、禁止合并回主干（除非用户明确要求）
- acpx 报错、超时、权限拒绝：原样贴给用户，重试不超过一次
