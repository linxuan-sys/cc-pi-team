---
description: Connect this conversation to an existing Pi session
argument-hint: [工作目录]
allowed-tools: Bash(ls *) Bash(cat *) Bash(head *) Bash(python3 *) Bash(jq *) Bash(claude plugin list *) Bash(flock *) Bash(mktemp *) Bash(mv *) Bash(echo *)
disable-model-invocation: true
---

把当前对话接到一段**已有的** Pi 会话上。只写绑定，不新建、不派单。

**只有两个问题：先问目录，再让用户回编号。不要多问、不要确认、不要解释。**

## 1. 问目录

用户给了 `$ARGUMENTS` 就跳过。否则只回一句：

> 要连接哪个目录的 Pi 会话？给我路径。

停下等他回。

## 2. 列会话（带编号）

```bash
python3 -I - "<目录>" <<'PY'
import glob, json, os, sys
want = os.path.abspath(os.path.expanduser(sys.argv[1]))
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
    last = ''
    try:
        with open(f, encoding='utf-8') as fh:
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
    rows.append((head.get('timestamp', ''), '', last.replace('\n', ' ')[:60], f))

# 本目录没有会话：去子目录里找，并标出子目录
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
        last = ''
        try:
            with open(f, encoding='utf-8') as fh:
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
        rows.append((head.get('timestamp', ''), rel, last.replace('\n', ' ')[:60], f))

rows.sort(reverse=True)
if not rows:
    print('NO_SESSION')
for i, (ts, rel, last, path) in enumerate(rows, 1):
    print(f'{i}\t{ts}\t{rel}\t{last}\t{path}')
PY
```

- `NO_SESSION` → 回"这个目录和它的子目录下都没有 Pi 会话，可以先在这里 `/pi:start` 建一条"，结束
- 有结果 → 列成清单：

```
1. 11-21 14:50 · 最后一条问题摘要
2. 11-21 12:03 · [lua/] 最后一条问题摘要     ← 子目录里的会话会带前缀
```

**子目录前缀**（`[lua/]` 这种）只在该目录本身没有会话、去子目录里找时才出现；本目录直接命中时不加。

然后只问一句：**"回个编号。"**

## 3. 用户回数字后：写绑定

```bash
set -e
ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
F="$ROOT/pi-bindings.json"
SID="${CLAUDE_CODE_SESSION_ID:-}"
TARGET="<选中的会话文件>"

# 这条 Pi 会话是不是已经被别的对话占着？
OTHER=$(jq -r --arg sid "$SID" --arg p "$TARGET" \
  'to_entries[] | select(.value == $p and .key != $sid) | .key' "$F" 2>/dev/null | head -1)
if [ -n "$OTHER" ]; then
  echo "BOUND_ELSEWHERE:$OTHER"
  exit 0
fi

tmp=$(mktemp -p "$(dirname "$F")")
trap 'rm -f "$tmp"' EXIT
flock "$ROOT/.pi-bindings.lock" bash -c 'jq --arg sid "$1" --arg p "$2" ".[\$sid] = \$p" "$3" > "$4" && mv "$4" "$3"' _ "$SID" "$TARGET" "$F" "$tmp"
echo "BOUND"
```

- 输出 `BOUND` → 继续第 4 步
- 输出 `BOUND_ELSEWHERE:<另一个会话 ID>` → **先问一句**："这条会话已经被另一个对话占用了，要帮你解绑那边、连到这边吗？"
  - 用户说"是" → 删掉那个会话的绑定（同一把锁），再重新写本会话的绑定：

    ```bash
    flock "$ROOT/.pi-bindings.lock" bash -c 'jq --arg sid "$1" "del(.[$sid])" "$2" > "$3" && mv "$3" "$2"' _ "$OTHER" "$F" "$tmp"
    flock "$ROOT/.pi-bindings.lock" bash -c 'jq --arg sid "$1" --arg p "$2" ".[\$sid] = \$p" "$3" > "$4" && mv "$4" "$3"' _ "$SID" "$TARGET" "$F" "$tmp"
    echo "REBOUND"
    ```

    然后回："已把那边解绑并连到这边。"
  - 用户说"不" → 停止，什么都不改。

## 4. 结束

只回一句："已连接，`/pi-pane` 看历史。"

不派单、不改会话、不新建。
