---
description: Connect this conversation to an existing Pi session
argument-hint: [工作目录]
allowed-tools: Bash(python3 *) Bash(echo *)
disable-model-invocation: true
---

# 连接 Pi 会话

1. 目录：用户给了 `$ARGUMENTS` 就用，否则问「要连接哪个目录的 Pi 会话？」并停下。

2. 列会话：

```bash
python3 -I - "<目录>" <<'PY'
import glob, json, os, sys
want = os.path.realpath(os.path.expanduser(sys.argv[1]))
for f in sorted(glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')), reverse=True):
    try:
        h = json.loads(open(f, encoding='utf-8').readline())
    except Exception:
        continue
    if os.path.realpath(h.get('cwd', '')) != want:
        continue
    last = ''
    for line in open(f, encoding='utf-8'):
        try:
            d = json.loads(line)
        except Exception:
            continue
        m = d.get('message') or {}
        if d.get('type') == 'message' and m.get('role') == 'user' and isinstance(m.get('content'), list):
            t = ' '.join(b.get('text', '') for b in m['content'] if isinstance(b, dict) and b.get('type') == 'text').strip()
            if t:
                last = t.replace('\n', ' ')[:60]
    print(f"{h.get('timestamp', '')}\t{last}\t{f}")
PY
```

列出「时间 · 摘要 · 路径」，让用户回编号。

3. 写绑定：

```bash
TARGET="<选中的会话文件>"
python3 -I -c 'import json,sys;open(sys.argv[1],"w").write(json.dumps({"file":sys.argv[2]}))' \
  "$HOME/.claude/pi-bindings.json" "$TARGET"
echo "BOUND"
```
