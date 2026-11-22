---
description: Exit Pi mode: stop the running headless Pi, optionally unbind
argument-hint:
disable-model-invocation: true
---

退出 Pi 模式：停掉正在跑的 headless Pi，然后问你要不要解绑。所有提问都用 `AskUserQuestion`。

## 1. 读绑定并停进程

```bash
FILE=$(jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" '.[$sid] // empty' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" 2>/dev/null)
[ -n "$FILE" ] || { echo NOT_BOUND; exit 0; }
[ -f "$FILE" ] || { echo STALE; exit 0; }
ID=$(head -1 "$FILE" | jq -r '.id // empty')
[ -n "$ID" ] || { echo NO_ID; exit 0; }
CWD=$(head -1 "$FILE" | jq -r '.cwd // empty')
is_pi() { [ -n "$1" ] && [ "$(cat /proc/$1/comm 2>/dev/null)" = "pi" ]; }
PID=$(cat "$CWD/.pi-pid" 2>/dev/null)
if is_pi "$PID"; then
  kill "$PID"
else
  pkill -f "^pi -p .*--session-id[= ]${ID}"
fi
sleep 1
if is_pi "$PID"; then echo "STILL_RUNNING=$ID"; else echo "STOPPED=$ID"; fi
echo "REOPEN=cd $CWD && pi --session $ID"
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
