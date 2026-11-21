---
description: Exit Pi team mode, unbind and resume normal work
argument-hint:
allowed-tools: Bash(pkill *) Bash(pgrep *) Bash(seq *) Bash(sleep *) Bash(basename *) Bash(jq *) Bash(python3 *) Bash(flock *) Bash(mktemp *) Bash(mv *) Bash(rm *) Bash(echo *) Bash(cd *) Bash(sed *) Bash(bash *) Bash(dirname *) Bash(printf *)
disable-model-invocation: true
---

退出 Pi 模式：停掉本对话绑定的 headless Pi → 解绑 → 汇报。

## 1. 停 + 解绑

一条命令跑完：

```bash
set -e
F="$HOME/.claude/pi-bindings.json"
SID="${CLAUDE_CODE_SESSION_ID:-}"
OUT=$(python3 -I - "$F" "$SID" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); sid = sys.argv[2]
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        data = {}
sf = data.get(sid, '')
pi_id = cwd = ''
if sf:
    try:
        head = json.loads(open(sf, encoding='utf-8').readline())
        pi_id = head.get('id', ''); cwd = head.get('cwd', '')
    except Exception:
        pass
print(sf); print(pi_id); print(cwd)
PY
)
SESSION_FILE=$(printf '%s\n' "$OUT" | sed -n 1p)
PI_ID=$(printf '%s\n' "$OUT" | sed -n 2p)
WORKSPACE=$(printf '%s\n' "$OUT" | sed -n 3p)
if [ -z "$SESSION_FILE" ]; then echo "NOT_BOUND"; exit 0; fi
[ -n "$PI_ID" ] || { PI_ID=$(basename "$SESSION_FILE" .jsonl); PI_ID=${PI_ID##*_}; }
if [ -n "$PI_ID" ]; then
  pkill -f -- "--session-id[= ]$PI_ID" >/dev/null 2>&1 || true
  for i in $(seq 1 50); do
    pgrep -f -- "--session-id[= ]$PI_ID" >/dev/null 2>&1 || break
    sleep 0.1
  done
fi
tmp=$(mktemp -p "$(dirname "$F")")
trap 'rm -f "$tmp"' EXIT
flock "$F.lock" bash -c 'jq --arg sid "$1" "del(.[$sid])" "$2" > "$3" && mv "$3" "$2"' _ "$SID" "$F" "$tmp"
echo "UNBOUND"
echo "SESSION_FILE=$SESSION_FILE"
echo "PI_ID=$PI_ID"
echo "WORKSPACE=$WORKSPACE"
```

- `NOT_BOUND` → 回「当前对话本来就没绑定 Pi，跳过」。
- `UNBOUND` → 解绑成功，面板 1 秒内清空。

## 2. 汇报

- 本轮做了什么（一句话）
- 会话：`<PI_ID>`，重开用 `cd <WORKSPACE> && pi --session <PI_ID>`
- 会话记录保留，未删除
- 之后恢复正常模式：Claude 自己写代码，不再派单
