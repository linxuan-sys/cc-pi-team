#!/usr/bin/env bash
# pi-dispatch.sh <workspace> <new|bind> <start|review>
# start 读 .pi-start-task.txt，review 读 .pi-review-task.txt。
# 成功只输出 BOUND=<session file>；NOT_BOUND / NO_SESSION / BAD_TASK_MODE 表示失败。

WS="$1"
MODE="$2"
TASK_MODE="${3:-}"
case "$TASK_MODE" in
  start) TASK_FILE=".pi-start-task.txt" ;;
  review) TASK_FILE=".pi-review-task.txt" ;;
  *) echo BAD_TASK_MODE; exit 1 ;;
esac
cd "$WS" || exit 1
WS="$(pwd -P)"
[ -f "$TASK_FILE" ] || { echo BAD_TASK_MODE; exit 1; }
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# 同一工作区不并跑
OLD=$(cat .pi-pid 2>/dev/null)
if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
  echo ALREADY_RUNNING
  exit 1
fi

if [ "$MODE" = "bind" ]; then
  FILE=""
  while IFS= read -r F; do
    [ -f "$F" ] || continue
    CWD=$(head -1 "$F" | jq -r '.cwd // empty')
    [ -n "$CWD" ] && [ "$(cd "$CWD" 2>/dev/null && pwd -P)" = "$WS" ] && FILE="$F"
  done <<< "$(jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" '.[$sid] // empty | if type=="array" then .[] else . end' "$ROOT/pi-bindings.json" 2>/dev/null)"
  [ -n "$FILE" ] || { echo NOT_BOUND; exit 1; }
  ID=$(head -1 "$FILE" | jq -r '.id // empty')
  [ -n "$ID" ] || { echo NOT_BOUND; exit 1; }
else
  ID=""
fi

# 旧哨兵、socket 残留会让新 broker 绑不上
rm -f .pi-bound .pi-done .pi-events.jsonl .pi-events.stderr.log .pi-rpc.sock

nohup node "$ROOT/scripts/pi-rpc.mjs" "$WS" "$ID" "$TASK_FILE" "$CLAUDE_CODE_SESSION_ID" > .pi-broker.log 2>&1 < /dev/null &
echo $! > .pi-pid

for i in $(seq 1 60); do
  [ -s .pi-bound ] && break
  kill -0 "$(cat .pi-pid)" 2>/dev/null || break
  sleep 0.5
done

FILE=$(cat .pi-bound 2>/dev/null)
[ -n "$FILE" ] || { kill "$(cat .pi-pid 2>/dev/null)" 2>/dev/null; cat .pi-broker.log 2>/dev/null; echo NO_SESSION; exit 1; }
echo "BOUND=$FILE"
