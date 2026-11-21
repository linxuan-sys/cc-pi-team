---
description: Pi team mode: plan, delegate coding to Pi, review and commit
argument-hint: [需求描述]
allowed-tools: Bash(pi *) Bash(setsid *) Bash(nohup *) Bash(pgrep *) Bash(pkill *) Bash(seq *) Bash(sleep *) Bash(set *) Bash(claude plugin list *) Bash(cd *) Bash(jq *) Bash(flock *) Bash(git init *) Bash(git add *) Bash(git commit *) Bash(git switch *) Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git rev-parse *) Bash(python3 *) Bash(ls *) Bash(cat *) Bash(head *) Bash(basename *) Bash(echo *) Bash(readlink *) Bash(sed *) Bash(tr *) Bash(kill *) Bash(pwd *) Bash(printf *) Read Grep Glob Write Edit EnterPlanMode ExitPlanMode AskUserQuestion
disable-model-invocation: true
---

Pi 有全套工具和全部 MCP；`pi -p` 会自动执行工具，`--approve` 还会加载项目本地扩展/设置；陌生仓库先告诉用户。

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

禁止把 `$HOME` 当工作区。

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

分支名只有一个：`pi/team`。新建仓库的默认分支也用 `pi/team`。

```bash
cd "<工作区>"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -q -b pi/team
  git add -A -- . ':(exclude).pi-*'
  git commit -qm "baseline: before pi task"
fi
git rev-parse --verify HEAD >/dev/null 2>&1 || { echo "NO_HEAD"; exit 1; }
CUR=$(git branch --show-current 2>/dev/null || true)
git rev-parse --verify pi/team >/dev/null 2>&1 \
  && git switch -q pi/team \
  || { git switch -qc pi/team || { echo "SWITCH_FAILED"; exit 1; }; }
[ -n "$CUR" ] && [ "$CUR" != "pi/team" ] && echo "SWITCHED_FROM=$CUR"

# 切到 pi/team 之后再提交 wip，别把脏改动留在 main
if [ -n "$(git status --porcelain -- . ':(exclude).pi-*')" ]; then
  git add -A -- . ':(exclude).pi-*'
  git commit -qm "wip: before pi task"
fi
```

- `NO_HEAD` → 贴给用户，停。
- `SWITCH_FAILED` → 切分支失败（通常是有冲突的未提交改动），贴给用户，停。
- `SWITCHED_FROM=<branch>` → 先告诉用户「已从 <branch> 切到 pi/team」，再继续。
- 未提交的改动在切到 pi/team 之后再本地提交（`wip: before pi task`），**不 push 远程**。
- 所有 Pi 改动只在 `pi/team` 分支上；没有别的分支名。

## 3. 准备任务书（先别落盘）

先按下面的模板备好内容；等第 4 节确定会话、确认不会覆盖正在运行的任务后，再写入 `.pi-start-task.txt`：

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

```bash
cd "<工作区>"
PWD_NOW=$(pwd -P)
ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
SID="${CLAUDE_CODE_SESSION_ID:-}"
BOUND=$(jq -r --arg sid "$SID" '.[$sid] // empty' "$ROOT/pi-bindings.json" 2>/dev/null || true)

# 1) 本对话已绑定 → 直接沿用；顺手清掉本工作区其他活着的 Pi
if [ -n "$BOUND" ] && [ -f "$BOUND" ]; then
  ID=$(head -1 "$BOUND" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("id") or "")')
  [ -n "$ID" ] || { ID=$(basename "$BOUND" .jsonl); ID=${ID##*_}; }
  echo "$ID" > .pi-session-id
  for pid in $(pgrep -f -- '(^|/)pi( |$).*--session-id[= ]' 2>/dev/null); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$PWD_NOW" ] || continue
    sid=$(printf '%s' "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" | sed -n 's/.*--session-id[= ]\([^ ]*\).*/\1/p')
    [ -n "$sid" ] && [ "$sid" != "$ID" ] && { kill "$pid" 2>/dev/null || true; sleep 0.2; }
  done
  if pgrep -f -- "(^|/)pi( |\$).*--session-id[= ]$ID" >/dev/null 2>&1; then
    echo "BOUND_RUNNING:$ID"
  else
    echo "BOUND_IDLE:$ID"
  fi
  exit 0
fi

# 2) 未绑定 → 看本工作区有没有 headless Pi 在跑
RUNNING=""
for pid in $(pgrep -f -- '(^|/)pi( |$).*--session-id[= ]' 2>/dev/null); do
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$PWD_NOW" ] || continue
  sid=$(printf '%s' "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" | sed -n 's/.*--session-id[= ]\([^ ]*\).*/\1/p')
  [ -n "$sid" ] && { RUNNING=$sid; break; }
done
echo "RUNNING=$RUNNING"
```

- **`BOUND_IDLE:<id>`** → 绑定的 Pi 空闲。进第 5.1 节，用同一 ID 启动派单。
- **`BOUND_RUNNING:<id>`** → 绑定的 Pi 还在跑。先跑第 6 节等它退出，再进第 5.1 节用同一 ID 启动。
- **`RUNNING` 非空** → 直接绑定它，不新开：

  ```bash
  FILE=$(python3 -I - "$RUNNING" "$PWD_NOW" <<'PY'
import glob, json, os, sys
sid, want = sys.argv[1], os.path.realpath(sys.argv[2])
for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')):
    try:
        head = json.loads(open(f, encoding='utf-8').readline())
    except Exception:
        continue
    if head.get('id') == sid and os.path.realpath(head.get('cwd', '')) == want:
        print(f); break
PY
)
  [ -n "$FILE" ] || { echo "NO_SESSION"; exit 1; }
  echo "$RUNNING" > .pi-session-id
  ```

  然后执行第 5.2 节「写绑定」（用这个 `FILE`）。它如果在跑别的任务，先等它结束（任务书还没落盘，不会覆盖）；结束后按 5.1 用同一 ID 启动。
- **`RUNNING` 为空** → 用 `AskUserQuestion` 问「这个工作区没有正在跑的 Pi，要新开一个吗？」：
  1. **是，新开一个 Pi** → `ID=$(python3 -I -c "import uuid;print(uuid.uuid4())")`，写 `.pi-session-id`，走第 5.1 节启动、5.2 绑定。
  2. **否，用已有对话** → 执行 `/pi:connect` 的流程（列该工作区及子目录的所有 Pi 会话，让用户回编号，写绑定）；绑定后若它在跑就先等它退出，再按 5.1 用同一 ID 启动。

## 5. 启动并绑定（新开、绑定空闲、或已有会话退出后都走这里）

### 5.1 启动

```bash
set -eu
cd "<工作区>"
ID=$(cat .pi-session-id)
SZ=$(python3 -I -c 'import os,sys;print(os.path.getsize(sys.argv[1]))' .pi-start-task.txt)
[ "$SZ" -le 120000 ] || { echo "TASK_TOO_LONG:$SZ"; exit 1; }
if pgrep -f -- "(^|/)pi( |\$).*--session-id[= ]$ID" >/dev/null 2>&1; then
  echo "ALREADY_RUNNING"; exit 1
fi
START=$(python3 -I -c 'import time;print(int(time.time()))')
setsid nohup pi -p --approve --mode json \
  --session-id "$ID" "$(cat .pi-start-task.txt)" > .pi-events.jsonl 2>&1 < /dev/null &
FILE=""
for i in $(seq 1 300); do
  for f in ~/.pi/agent/sessions/*/*_${ID}.jsonl; do
    [ -f "$f" ] || continue
    MT=$(python3 -I -c 'import os,sys;print(int(os.path.getmtime(sys.argv[1])))' "$f")
    [ "$MT" -ge "$START" ] || continue
    if head -1 "$f" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);sys.exit(0 if d.get("id")==sys.argv[1] and d.get("cwd")==sys.argv[2] else 1)' "$ID" "$(pwd -P)"; then
      FILE=$f; break
    fi
  done
  [ -n "$FILE" ] && break
  if [ "$i" -gt 25 ] && ! pgrep -f -- "(^|/)pi( |\$).*--session-id[= ]$ID" >/dev/null 2>&1; then
    echo "PI_DIED"; exit 1
  fi
  sleep 0.2
done
if [ -z "$FILE" ]; then
  pkill -f -- "(^|/)pi( |\$).*--session-id[= ]$ID" >/dev/null 2>&1 || true
  echo "NO_SESSION"
  exit 1
fi
echo "FILE=$FILE"
```

### 5.2 写绑定

`FILE` 来自 5.1，或第 4 节直接绑定时找到的会话文件；`LAUNCHED` 新开 Pi 填 1，复用已有 Pi 填 0。

```bash
set -eu
cd "<工作区>"
ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
[ -n "$ROOT" ] || { echo "NO_PLUGIN"; exit 1; }
FILE="<会话文件绝对路径>"
LAUNCHED="<1 或 0>"
BIND=$(flock "$ROOT/.pi-bindings.lock" python3 -I - "$ROOT" "$FILE" <<'PY'
import json, os, pathlib, sys
p = pathlib.Path(sys.argv[1]) / 'pi-bindings.json'
target = sys.argv[2]
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
if cur and cur != target:
    print('ALREADY_BOUND:' + cur); raise SystemExit(1)
others = [k for k, v in data.items() if v == target and k != me]
if others:
    print('BOUND_ELSEWHERE:' + others[0]); raise SystemExit(1)
data[me] = target
tmp = p.parent / (p.name + '.tmp')
tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
os.replace(tmp, p)
print('BOUND')
PY
) || true
echo "$BIND"
case "$BIND" in
  BOUND) echo "FILE=$FILE" ;;
  *)
    [ "$LAUNCHED" = "1" ] && pkill -f -- "(^|/)pi( |\$).*--session-id[= ]$(cat .pi-session-id)" >/dev/null 2>&1
    exit 1
    ;;
esac
```

- `BOUND` → 继续。
- `NO_PLUGIN` → 插件没装或改名了（`pi@cc-pi-team` 查不到），停。
- `TASK_TOO_LONG:<bytes>` → 任务书超过 120 KB（Linux 单参数上限 128 KiB），拆成多轮再派。
- `ALREADY_RUNNING` → 同 ID 已有 Pi 在跑，不要双开；先等它结束或跟用户确认。
- `PI_DIED` → Pi 启动后立刻退出，贴 `.pi-events.jsonl` 尾部错误，停。
- `NO_SESSION` → 贴 `.pi-events.jsonl` 尾部错误，停。
- `ALREADY_BOUND:` / `BOUND_ELSEWHERE:` / `NO_SESSION_ID` → 贴给用户，停；session id 变了就用 `/pi:connect` 重新接。

## 6. 等 Pi 结束

后台运行：

```bash
cd "<工作区>"
ID=$(cat .pi-session-id)
while pgrep -f -- "(^|/)pi( |\$).*--session-id[= ]$ID" >/dev/null 2>&1; do sleep 2; done
echo "PI_DONE"
```

10 分钟被工具杀掉（退出码 -1）不代表 Pi 死了：先 `pgrep`，活着就再挂一次。Pi 每完成一步也可能先汇报，不一定要等全部结束。

## 7. 接收汇报并审核

1. 解析 `.pi-events.jsonl`：
   - `message_end` 里 `role == "assistant"` 的 text 块 = 汇报
   - `tool_execution_start` → `toolName` + `args`
   - `tool_execution_end` → `result.content`、`result.structuredContent.output` / `exit_code`、`isError`
2. 自己跑：

   ```bash
   git status --short -- . ':(exclude).pi-*'
   git diff --stat
   git diff
   ```

   派单前的原有改动已单独提交（`wip: before pi task`），用 `git log --oneline` / `git show` 对照。
3. Read 关键文件确认逻辑真的实现（不是注释、占位、假数据）。
4. 审核维度：功能是否实现、是否删了原逻辑或吞异常、是否有计划外改动、声称的测试是否真跑过。

## 8. 返工 / 收尾

- 核心问题（逻辑错、方案不对、质量差）→ 返工单**追加**到 `.pi-start-task.txt`，重跑第 5、6 节（同一会话 ID）。最多两轮，仍不合格就停下如实报告。
- 小问题（拼写、格式、一行修补）→ 直接改，报告注明「这部分由我修补」。
- 审核通过 → 在 `pi/team` 上提交（只本地，不 push，不碰 main）：

  ```bash
  git add -u -- . ':(exclude).pi-*'
  git add -- "<本轮核实过的新增文件>"
  git commit -qm "pi: 本轮改动摘要"
  ```

  禁用 `git add -A`。

## 9. 外部打开（仅用户询问时）

```bash
ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
[ -n "$ROOT" ] || { echo "NO_PLUGIN"; exit 0; }
FILE=$(jq -r --arg sid "${CLAUDE_CODE_SESSION_ID:-}" '.[$sid] // empty' "$ROOT/pi-bindings.json")
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then echo "NOT_BOUND"; exit 0; fi
head -1 "$FILE" | python3 -I -c "import json,sys;d=json.load(sys.stdin);print('ID='+d.get('id',''));print('CWD='+d.get('cwd',''))"
```

- `NOT_BOUND` → 回「当前对话没有绑定 Pi 会话」。
- `NO_PLUGIN` → 回「插件没装或改名了」。
- 否则只回一条：`cd <CWD> && pi --session <ID>`。

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
- 禁止把启动和绑定拆成两条命令
- 禁止同时开多个 headless Pi 写同一会话
- 禁止计划未批准就开工（说「直接干」除外）
- 禁止指挥 Pi 的子代理
- 禁止在 main/master 上直接改动或提交
- 禁止 push
- 禁止删除 `pi/team` 或合并回主干（除非用户明确要求）
- Pi 报错、超时、权限拒绝：原样贴给用户，重试不超过一次
