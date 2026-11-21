---
description: Exit Pi team mode, unbind and resume normal work
argument-hint:
allowed-tools: Bash(acpx *) Bash(claude plugin list *) Bash(jq *) Bash(python3 *) Bash(flock *) Bash(mktemp *) Bash(mv *) Bash(rm *) Bash(echo *) Bash(cd *) Bash(sed *)
disable-model-invocation: true
---

退出 Pi 团队模式。**下面整段在一个 bash 调用里跑完**——shell 变量不跨调用保留，拆开就全成空串。

```bash
set -e
ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
F="$ROOT/pi-bindings.json"
SID="${CLAUDE_CODE_SESSION_ID:-}"

# 1) 读出本会话绑定的 Pi 会话文件与它的 Pi id
OUT=$(python3 -I - "$F" "$SID" <<'PY'
import json, os, pathlib, sys
p = pathlib.Path(sys.argv[1]); sid = sys.argv[2]
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        data = {}
sf = data.get(sid, '')
pi_id = ''
if sf:
    try:
        with open(sf, encoding='utf-8') as fh:
            pi_id = json.loads(fh.readline()).get('id', '')
    except Exception:
        pass
print(sf)
print(pi_id)
PY
)
SESSION_FILE=$(printf '%s\n' "$OUT" | sed -n 1p)
PI_ID=$(printf '%s\n' "$OUT" | sed -n 2p)

if [ -z "$SESSION_FILE" ]; then
  echo "NOT_BOUND"
  exit 0
fi

# 2) 先取消还在跑的任务：到这条 Pi 会话自己的目录里去取消
WORKSPACE=$(python3 -I - "$SESSION_FILE" <<'PY'
import glob, json, os, sys
target = os.path.basename(sys.argv[1])
for f in glob.glob(os.path.expanduser('~/.acpx/sessions/*.json')):
    try:
        with open(f, encoding='utf-8') as fh:
            d = json.load(fh)
    except Exception:
        continue
    sf = os.path.basename(d.get('sessionFile', ''))
    if sf == target:
        print(d.get('cwd', ''))
        break
PY
)
if [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE" ]; then
  ( cd "$WORKSPACE" && acpx pi cancel >/dev/null 2>&1 || true )
fi

# 3) 解绑（带锁，同目录临时文件，mv 是原子替换）
tmp=$(mktemp -p "$(dirname "$F")")
trap 'rm -f "$tmp"' EXIT
flock "$ROOT/.pi-bindings.lock" jq --arg sid "$SID" 'del(.[$sid])' "$F" > "$tmp"
mv "$tmp" "$F"

echo "UNBOUND"
echo "SESSION_FILE=$SESSION_FILE"
echo "PI_ID=$PI_ID"
echo "WORKSPACE=$WORKSPACE"
```

按输出汇报：

- `NOT_BOUND` → 说"本来就没绑定 Pi"，跳过取消/解绑
- `UNBOUND` → 解绑成功，侧边栏 1 秒内清空

然后向用户汇报三件事：

1. 本轮 Pi 模式下完成了什么（一句话）
2. 会话：`$PI_ID`，以后重新打开用 `cd <WORKSPACE> && pi --session <PI_ID>`
3. 会话记录保留，未删除

从下一条消息起恢复正常模式：Claude 自己写代码，不再派单给 Pi。