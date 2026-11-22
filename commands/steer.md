---
description: Steer the running Pi dispatch
argument-hint: [纠偏指令]
disable-model-invocation: true
---

把纠偏指令发给正在跑的 Pi。所有提问都用 `AskUserQuestion`。

## 1. 找运行中的 Pi

```bash
FILE=$(jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" '.[$sid] // empty | if type=="array" then .[] else . end' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" 2>/dev/null | tail -1)
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo NOT_BOUND; exit 0; }
WS=$(head -1 "$FILE" | jq -r '.cwd // empty')
[ -S "$WS/.pi-rpc.sock" ] && echo "RUNNING=$WS" || echo "NOT_RUNNING=$WS"
```

- `NOT_BOUND` → 回「这个对话没有绑定 Pi 会话」，结束。
- `NOT_RUNNING` → 回「Pi 当前没在跑，没有可纠偏的任务」，结束。
- `RUNNING` → 继续第 2 步。

## 2. 发指令

`$ARGUMENTS` 为空 → 用 `AskUserQuestion` 问「要 Pi 怎么改？」，Other 输入指令；拿到后继续。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pi-ctl.sh" "<工作区>" steer "<指令>"
```

- 看到 `STEERED` → 回「已把纠偏指令发给 Pi」。
- `NO_SOCKET` / `SEND_FAILED` / `BAD_MESSAGE` → 原样贴出并停。

不要重启 Pi，不要重复派单。
