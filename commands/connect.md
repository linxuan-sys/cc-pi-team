---
description: Connect this conversation to an existing Pi session
argument-hint: [工作目录]
allowed-tools: Bash(ls *) Bash(cat *) Bash(head *) Bash(dirname *) Bash(python3 *) Bash(jq *) Bash(flock *) Bash(mktemp *) Bash(mv *) Bash(echo *) Bash(set *) Bash(bash *) Bash(rm *)
disable-model-invocation: true
---

把当前对话接到已有 Pi 会话。只写绑定：不新建会话、不派单、不启动 Pi、不切分支。

## 1. 目录

用户给了 `$ARGUMENTS` → 用它；否则只问一句「要连接哪个目录的 Pi 会话？给我路径。」并停下等他回。

## 2. 列会话

```bash
python3 -I - "<目录>" <<'PY'
import glob, json, os, sys
want = os.path.abspath(os.path.expanduser(sys.argv[1]))

def last_user_text(path):
    last = ''
    try:
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                m = d.get('message') or {}
                if d.get('type') == 'message' and m.get('role') == 'user' and isinstance(m.get('content'), list):
                    t = ' '.join(b.get('text', '') for b in m['content'] if isinstance(b, dict) and b.get('type') == 'text').strip()
                    if t:
                        last = t
    except Exception:
        pass
    return last.replace('\n', ' ')[:60]

rows = []
for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')):
    try:
        with open(f, encoding='utf-8') as fh:
            head = json.loads(fh.readline())
    except Exception:
        continue
    cwd = os.path.abspath(head.get('cwd', ''))
    if cwd != want:
        continue
    rows.append((head.get('timestamp', ''), '', last_user_text(f), f))

if not rows:
    for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')):
        try:
            with open(f, encoding='utf-8') as fh:
                head = json.loads(fh.readline())
        except Exception:
            continue
        cwd = os.path.abspath(head.get('cwd', ''))
        if not cwd.startswith(want + os.sep):
            continue
        rel = os.path.relpath(cwd, want) + '/'
        rows.append((head.get('timestamp', ''), rel, last_user_text(f), f))

rows.sort(reverse=True)
if not rows:
    print('NO_SESSION')
for i, (ts, rel, last, path) in enumerate(rows, 1):
    print(f'{i}\t{ts}\t{rel}\t{last}\t{path}')
PY
```

- `NO_SESSION` → 回「这个目录和子目录下都没有 Pi 会话，可以先在这里 `/pi:start` 建一条」，结束。
- 有结果 → **默认只列你给的那个目录**；只有该目录一条会话都没有时，才自动去子目录找、重新列一遍。
  清单格式：
  ```
  1. 11-21 14:50 · 最后一条问题摘要
  2. 11-21 12:03 · [lua/] 最后一条问题摘要
  ```
  子目录会话带 `[子目录/]` 前缀。然后只问「回个编号。」

## 3. 写绑定

用户回编号后，取对应的会话文件路径：

```bash
set -eu
F="$HOME/.claude/pi-bindings.json"
SID="${CLAUDE_CODE_SESSION_ID:-}"
TARGET="<选中的会话文件>"
OTHER=$(jq -r --arg sid "$SID" --arg p "$TARGET" 'to_entries[] | select(.value == $p and .key != $sid) | .key' "$F" 2>/dev/null | head -1)
if [ -n "$OTHER" ]; then echo "BOUND_ELSEWHERE:$OTHER"; exit 0; fi
tmp=$(mktemp -p "$(dirname "$F")")
trap 'rm -f "$tmp"' EXIT
flock "$F.lock" bash -c 'jq --arg sid "$1" --arg p "$2" ".[\$sid] = \$p" "$3" > "$4" && mv "$4" "$3"' _ "$SID" "$TARGET" "$F" "$tmp"
echo "BOUND"
```

- `BOUND` → 回三行：
  ```
  已连接。接下来：
  1. /pi:start —— 接着这条会话继续干活
  2. /pi-pane —— 打开面板看这条会话的历史
  3. /pi:review —— 用它审查代码
  ```
- `BOUND_ELSEWHERE:<id>` → 先问「这条会话已被另一个对话占用，要解绑那边、连到这边吗？」
  - 同意 → 一条命令重绑：
    ```bash
    set -eu
    F="$HOME/.claude/pi-bindings.json"
    SID="${CLAUDE_CODE_SESSION_ID:-}"
    TARGET="<选中的会话文件>"
    OTHER="<另一个会话 ID>"
    tmp=$(mktemp -p "$(dirname "$F")")
    trap 'rm -f "$tmp"' EXIT
    flock "$F.lock" bash -c 'jq --arg sid "$1" "del(.[$sid])" "$2" > "$3" && mv "$3" "$2"' _ "$OTHER" "$F" "$tmp"
    flock "$F.lock" bash -c 'jq --arg sid "$1" --arg p "$2" ".[\$sid] = \$p" "$3" > "$4" && mv "$4" "$3"' _ "$SID" "$TARGET" "$F" "$tmp"
    echo "REBOUND"
    ```
    然后回「已把那边解绑并连到这边。」
  - 不同意 → 停，什么都不改。
