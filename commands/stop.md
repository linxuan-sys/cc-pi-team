---
description: Exit Pi mode: stop the running headless Pi, optionally unbind
argument-hint:
disable-model-invocation: true
---

退出 Pi 模式：停掉正在跑的 headless Pi，然后问你要不要解绑。所有提问都用 `AskUserQuestion`。

## 1. 读绑定并停进程

```bash
FILES=$(jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" '.[$sid] // empty | if type=="array" then .[] else . end' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" 2>/dev/null)
[ -n "$FILES" ] || { echo NOT_BOUND; exit 0; }
# 派单跑在当前工作区，先停这里
if [ -S "$PWD/.pi-rpc.sock" ]; then
  bash "${CLAUDE_PLUGIN_ROOT}/scripts/pi-ctl.sh" "$PWD" abort >/dev/null 2>&1 || true
  sleep 3
  PID=$(cat "$PWD/.pi-pid" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q 'pi-rpc.mjs'; then
    kill "$PID" 2>/dev/null
    sleep 1
  fi
  pkill -f "pi-rpc.mjs $PWD" 2>/dev/null || true
  echo "STOPPED=$PWD"
fi
echo "$FILES" | while IFS= read -r FILE; do
  [ -f "$FILE" ] || { echo "STALE=$FILE"; continue; }
  ID=$(head -1 "$FILE" | jq -r '.id // empty')
  CWD=$(head -1 "$FILE" | jq -r '.cwd // empty')
  [ -n "$CWD" ] || CWD="$(dirname "$FILE")"
  [ "$CWD" = "$PWD" ] && continue
  if [ -S "$CWD/.pi-rpc.sock" ]; then
    bash "${CLAUDE_PLUGIN_ROOT}/scripts/pi-ctl.sh" "$CWD" abort >/dev/null 2>&1 || true
    sleep 3
  fi
  PID=$(cat "$CWD/.pi-pid" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q 'pi-rpc.mjs'; then
    kill "$PID" 2>/dev/null
    sleep 1
  fi
  pkill -f "pi-rpc.mjs $CWD" 2>/dev/null || true
  sleep 1
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo "STILL_RUNNING=$ID"; else echo "STOPPED=$ID"; fi
  echo "REOPEN=cd $CWD && pi --session $ID"
done
```

- 输出 `NOT_BOUND` → 回「本来就没绑定，已退出」，结束。
- 输出 `STOPPED` / `STILL_RUNNING` / `STALE` / `NO_ID` → 继续第 2 步。
- `STALE` 说明绑定行还在、会话文件没了：不杀进程，直接问要不要解绑。

## 2. 问是否解绑

用 `AskUserQuestion` 问「要取消这个对话的绑定吗？」：选项「取消绑定」/「不取消，直接退出」。

- **取消绑定**：

```bash
jq --arg sid "$CLAUDE_CODE_SESSION_ID" 'del(.[$sid])' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" && mv "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"
```

- **不取消**：什么都不做。

## 3. 汇报

- 已停止（或本来没在跑）
- 绑定：已取消 / 保留
- 手动重开：把第 1 步的 `REOPEN=...` 命令原样打印给用户（`cd <cwd> && pi --session <ID>`）
- 之后 Claude 自己写代码，不再派单
