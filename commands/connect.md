---
description: Connect this conversation to an existing Pi session
argument-hint: [工作目录]
allowed-tools: Bash(ls *) Bash(cat *) Bash(head *) Bash(dirname *) Bash(python3 *) Bash(jq *) Bash(claude plugin list *) Bash(flock *) Bash(mktemp *) Bash(mv *) Bash(echo *) Bash(set *) Bash(printf *) Bash(bash *) Bash(rm *)
disable-model-invocation: true
---

把当前对话接到已有 Pi 会话。只写绑定：不新建会话、不派单、不启动 Pi、不切分支。

## 1. 目录

用户给了 `$ARGUMENTS` → 用它；否则只问一句「要连接哪个目录的 Pi 会话？给我路径。」并停下等他回。

## 2. 列会话

```bash
python3 -I - "<目录>" <<'PY'
import glob, json, os, sys
want = os.path.realpath(os.path.expanduser(sys.argv[1]))

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
    cwd = os.path.realpath(head.get('cwd', ''))
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
        cwd = os.path.realpath(head.get('cwd', ''))
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
ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
[ -n "$ROOT" ] || { echo "NO_PLUGIN"; exit 1; }
SID="${CLAUDE_CODE_SESSION_ID:-}"
TARGET="<选中的会话文件>"
BIND=$(flock "$ROOT/.pi-bindings.lock" python3 -I - "$ROOT" "$SID" "$TARGET" <<'PY'
import json, pathlib, sys
root, me, target = sys.argv[1], sys.argv[2], sys.argv[3]
if not me:
    print('NO_SESSION_ID'); raise SystemExit(1)
p = pathlib.Path(root) / 'pi-bindings.json'
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        data = {}
cur = data.get(me, '')
if cur and cur != target:
    print('ALREADY_BOUND:' + cur); raise SystemExit(1)
others = [k for k, v in data.items() if v == target and k != me]
if others:
    print('BOUND_ELSEWHERE:' + others[0]); raise SystemExit(1)
data[me] = target
tmp = p.with_name(p.name + '.tmp')
tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
tmp.replace(p)
print('BOUND')
PY
) || true
echo "$BIND"
```

- `BOUND` → 回三行：
  ```
  已连接。接下来：
  1. /pi:start —— 接着这条会话继续干活
  2. /pi-pane —— 打开面板看这条会话的历史
  3. /pi:review —— 用它审查代码
  ```
- `NO_PLUGIN` → 插件没装或改名了（`pi@cc-pi-team` 查不到），停。
- `NO_SESSION_ID` → 拿不到当前对话的会话 ID，停。
- `ALREADY_BOUND:<file>` → 当前对话已绑另一条 Pi，先 `/pi:unbind` 再连。
- `BOUND_ELSEWHERE:<id>` → 先问「这条会话已被另一个对话占用，要解绑那边、连到这边吗？」
  - 同意 → 一条命令重绑：
    ```bash
    set -eu
    ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
    [ -n "$ROOT" ] || { echo "NO_PLUGIN"; exit 1; }
    SID="${CLAUDE_CODE_SESSION_ID:-}"
    TARGET="<选中的会话文件>"
    OTHER="<另一个会话 ID>"
    flock "$ROOT/.pi-bindings.lock" python3 -I - "$ROOT" "$SID" "$TARGET" "$OTHER" <<'PY'
import json, pathlib, sys
root, me, target, other = sys.argv[1:5]
if not me:
    print('NO_SESSION_ID'); raise SystemExit(1)
p = pathlib.Path(root) / 'pi-bindings.json'
data = json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
data.pop(other, None)
data[me] = target
tmp = p.with_name(p.name + '.tmp')
tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
tmp.replace(p)
print('REBOUND')
PY
    ```
    然后回「已把那边解绑并连到这边。」
  - 不同意 → 停，什么都不改。
