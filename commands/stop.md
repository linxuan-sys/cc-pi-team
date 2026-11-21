---
description: Exit Pi team mode, unbind and resume normal work
argument-hint:
allowed-tools: Bash(pgrep *) Bash(pkill *) Bash(head *) Bash(python3 *) Bash(echo *)
disable-model-invocation: true
---

# 退出 Pi 模式

```bash
B="$HOME/.claude/pi-bindings.json"
FILE=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get("file",""))' "$B" 2>/dev/null || true)
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "NOT_BOUND"; exit 0; }
ID=$(head -1 "$FILE" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
[ -n "$ID" ] && pkill -f -- "--session-id $ID" >/dev/null 2>&1 || true
python3 -I -c 'import json,sys;open(sys.argv[1],"w").write("{}")' "$B"
echo "UNBOUND"
echo "ID=$ID"
echo "FILE=$FILE"
```

- `NOT_BOUND` → 当前没绑定。
- `UNBOUND` → 已杀进程并解绑；会话记录保留。
