#!/usr/bin/env bash
# pi-dispatch.sh <workspace> <new|bind> <start|review>
# start 读 .pi-start-task.txt，review 读 .pi-review-task.txt。
# 成功只输出 BOUND=<session file>；NOT_BOUND / NO_SESSION / BIND_FAILED / BAD_TASK_MODE 表示失败。

WS="$1"
MODE="$2"
TASK_MODE="${3:-}"
case "$TASK_MODE" in
  start) TASK_FILE=".pi-start-task.txt" ;;
  review) TASK_FILE=".pi-review-task.txt" ;;
  *) echo BAD_TASK_MODE; exit 1 ;;
esac
cd "$WS" || exit 1
TASK="$(cat "$TASK_FILE")"
die() { [ -f .pi-pid ] && kill "$(cat .pi-pid)" 2>/dev/null; echo "$1"; exit 1; }
if [ "$MODE" = "bind" ]; then
  FILE=$(jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" '.[$sid] // empty' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" 2>/dev/null)
  ID=$(head -1 "$FILE" | jq -r '.id // empty')
  [ -n "$ID" ] || { echo NOT_BOUND; exit 1; }
  nohup pi -p --approve --mode json --session-id "$ID" "$TASK" > .pi-events.jsonl 2>&1 < /dev/null &
  echo $! > .pi-pid
  echo "BOUND=$FILE"
  exit 0
fi
nohup pi -p --approve --mode json "$TASK" > .pi-events.jsonl 2>&1 < /dev/null &
echo $! > .pi-pid
for i in $(seq 1 60); do
  ID=$(grep -m1 '"type":"session"' .pi-events.jsonl 2>/dev/null | jq -r '.id // empty')
  [ -n "$ID" ] && break
  sleep 1
done
[ -n "$ID" ] || die NO_SESSION
FILE=$(ls -t ~/.pi/agent/sessions/*/*_${ID}.jsonl 2>/dev/null | head -1)
[ -n "$FILE" ] || die NO_SESSION
[ -f "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" ] || printf '{}' > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"
jq --arg sid "$CLAUDE_CODE_SESSION_ID" --arg p "$FILE" '.[$sid] = $p' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" && mv "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" || die BIND_FAILED
echo "BOUND=$FILE"