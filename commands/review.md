---
description: Review code with Pi (read-only task), fix and re-review until it passes
argument-hint: [审查目标，可空]
allowed-tools: Bash(pi *) Bash(setsid *) Bash(nohup *) Bash(pgrep *) Bash(pkill *) Bash(seq *) Bash(sleep *) Bash(set *) Bash(claude plugin list *) Bash(cd *) Bash(jq *) Bash(flock *) Bash(git init *) Bash(git add *) Bash(git commit *) Bash(git switch *) Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git rev-parse *) Bash(python3 *) Bash(ls *) Bash(cat *) Bash(head *) Bash(basename *) Bash(echo *) Bash(readlink *) Bash(sed *) Bash(tr *) Bash(kill *) Bash(pwd *) Bash(printf *) Read Grep Glob Write Edit AskUserQuestion
disable-model-invocation: true
---

Pi 有全套工具和全部 MCP；"工作区只读"只写在任务书里。`pi -p` 会自动执行工具，`--approve` 还会加载项目本地扩展/设置；陌生仓库先告诉用户。

用户说「直接跟她说」→ 用「用户原话说：<原话>」转给 Pi，转完照常复核。

审查目标：$ARGUMENTS（空 = 当前未提交改动；非 git 仓库 = 整个目录）

## 0. 准备仓库与分支

`/pi:review` 可以单独跑，不依赖 `/pi:start`，所以 git 这一步全部在这里做完：

1. **不是 git 仓库** → `git init -b pi/team`（默认分支就叫 `pi/team`）→ `git add -A`（排除 `.pi-*`）→ `git commit -m "baseline: before pi review"`。
2. **已经是 git 仓库** → 有 `pi/team` 就 `git switch pi/team`；没有就 `git switch -c pi/team` 新建。
3. **记审查起点** → `git rev-parse HEAD > .pi-review-base`。
4. **有未提交改动** → `git add -A`（排除 `.pi-*`）+ `git commit -m "wip: before pi review"`。必须先记起点再提交，审查范围 `git diff .pi-review-base` 才会包含这些改动。
5. 只提交本地，不 push 远程；分支只用 `pi/team`。

```bash
cd "<工作区>"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -q -b pi/team
  git add -A -- . ':(exclude).pi-*'
  git commit -qm "baseline: before pi review"
fi
git rev-parse --verify HEAD >/dev/null 2>&1 || { echo "NO_HEAD"; exit 1; }
CUR=$(git branch --show-current 2>/dev/null || true)
git rev-parse --verify pi/team >/dev/null 2>&1 \
  && git switch -q pi/team \
  || { git switch -qc pi/team || { echo "SWITCH_FAILED"; exit 1; }; }
[ -n "$CUR" ] && [ "$CUR" != "pi/team" ] && echo "SWITCHED_FROM=$CUR"
git rev-parse HEAD > .pi-review-base
if [ -n "$(git status --porcelain -- . ':(exclude).pi-*')" ]; then
  git add -A -- . ':(exclude).pi-*'
  git commit -qm "wip: before pi review"
fi
```

- `NO_HEAD`（仓库没有任何提交）/ `SWITCH_FAILED`（切分支失败，通常是有冲突的未提交改动）→ 贴给用户，停。
- `SWITCHED_FROM=<branch>` → 先告诉用户「已从 <branch> 切到 pi/team，本次审的是 pi/team」，再继续。
- 只提交本地，不 push。

## 1. 范围

- `BASE=$(cat .pi-review-base 2>/dev/null); [ -n "$BASE" ] || BASE=HEAD`
- `git diff "$BASE"` 非空 → 审这个
- 为空 → `git show "$BASE"`
- 非 git 仓库 → 整个目录

## 2. 任务书

写入 `.pi-review-task.txt`：

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
【输出】
按严重程度排序（阻断 / 重要 / 次要 / 建议），每条：
- 文件:行 — 问题 — 为什么是问题 — 修复建议
最后给结论：通过 / 有条件通过 / 不通过。
```

## 3. 定会话

```bash
cd "<工作区>"
PWD_NOW=$(pwd -P)
ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
[ -n "$ROOT" ] || { echo "NO_PLUGIN"; exit 1; }
SID="${CLAUDE_CODE_SESSION_ID:-}"
BOUND=$(jq -r --arg sid "$SID" '.[$sid] // empty' "$ROOT/pi-bindings.json" 2>/dev/null || true)

# 1) 本对话已绑定 → 沿用；清掉本工作区其他活着的 Pi
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

# 2) 未绑定 → 看本工作区有没有在跑的 Pi
RUNNING=""
for pid in $(pgrep -f -- '(^|/)pi( |$).*--session-id[= ]' 2>/dev/null); do
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$PWD_NOW" ] || continue
  sid=$(printf '%s' "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" | sed -n 's/.*--session-id[= ]\([^ ]*\).*/\1/p')
  [ -n "$sid" ] && { RUNNING=$sid; break; }
done
echo "RUNNING=$RUNNING"
```

- `NO_PLUGIN` → 插件没装或改名了（`pi@cc-pi-team` 查不到），停。
- **`BOUND_IDLE:<id>`** → 直接进第 4 节，用这条会话启动审查。
- **`BOUND_RUNNING:<id>`** → 先跑第 5 节等待，它退出后再进第 4 节启动审查。
- **`RUNNING` 非空** → 采用这条会话：写 `.pi-session-id`，找到 cwd 匹配的会话文件先跑 4.2 绑定（面板能看到），再等它退出、进第 4 节启动审查：
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
- **`RUNNING` 为空** → 用 `AskUserQuestion` 问「这个工作区没有正在跑的 Pi，要新开一个吗？」：
  1. **是，新开一个 Pi** → `ID=$(python3 -I -c "import uuid;print(uuid.uuid4())")`，写 `.pi-session-id`，进第 4 节。
  2. **否，用已有对话** → 执行 `/pi:connect` 的流程（列该工作区及子目录的 Pi 会话，用户回编号，写绑定）；绑定后从 `pi-bindings.json` 取回 ID 写进 `.pi-session-id`，再进第 4 节启动审查。

## 4. 启动并绑定

### 4.1 启动

```bash
set -eu
cd "<工作区>"
ID=$(cat .pi-session-id)
SZ=$(python3 -I -c 'import os,sys;print(os.path.getsize(sys.argv[1]))' .pi-review-task.txt)
[ "$SZ" -le 120000 ] || { echo "TASK_TOO_LONG:$SZ"; exit 1; }
if pgrep -f -- "(^|/)pi( |\$).*--session-id[= ]$ID" >/dev/null 2>&1; then
  echo "ALREADY_RUNNING"; exit 1
fi
START=$(python3 -I -c 'import time;print(int(time.time()))')
setsid nohup pi -p --approve --mode json \
  --session-id "$ID" "$(cat .pi-review-task.txt)" > .pi-events.jsonl 2>&1 < /dev/null &
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

### 4.2 写绑定

`FILE` 来自 4.1，或第 3 节直接绑定时找到的会话文件；`LAUNCHED` 新开 Pi 填 1，复用已有 Pi 填 0。

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

## 5. 等 Pi 结束

后台运行：

```bash
cd "<工作区>"
ID=$(cat .pi-session-id)
while pgrep -f -- "(^|/)pi( |\$).*--session-id[= ]$ID" >/dev/null 2>&1; do sleep 2; done
echo "PI_DONE"
```

10 分钟被工具杀掉（退出码 -1）不代表 Pi 死了：先 `pgrep`，活着就再挂一次。

## 6. 复核

1. `message_end` 里 `role == "assistant"` 的 text 块 = 报告；`tool_execution_end.result.structuredContent` = 命令输出与退出码。
2. 逐条打开 `文件:行` 复核：属实保留，报错标「已复核：误报」。
3. 「Pi 报的」和「我复核过的」分开写。

## 7. 修复 → 复审

1. 修完直接提交到本地分支 `pi/team`（不 push 远程）：
   ```bash
   git add -u -- . ':(exclude).pi-*'
   git add -- "<本轮新增的文件>"
   git commit -qm "pi: 第 N 轮修复"
   ```
2. 问题清单和修复说明**追加**到 `.pi-review-task.txt`，要求逐条确认并重扫；复审用 `git log --oneline -3` + `git show HEAD` 看本轮提交。
3. 重跑第 3、4、5 节（同一会话 ID 接着跑）。
4. 通过 → 汇报；不通过 → 再修。最多 5 轮，第 5 轮还不过就如实报告剩余问题。

每轮汇报：第几轮、修了什么、它的结论。

## 8. 一个会话

不新建、不重复派单、结束不解绑。
