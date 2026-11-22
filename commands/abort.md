---
description: Abort the running Pi dispatch
disable-model-invocation: true
---

停掉当前跑着的 Pi。所有提问都用 `AskUserQuestion`。

## 1. 找运行中的 Pi

```bash
LIST=$(jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" '.[$sid] // empty | if type=="array" then .[] else . end' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" 2>/dev/null)
[ -n "$LIST" ] || { echo NOT_BOUND; exit 0; }
WS=""
while IFS= read -r FILE; do
  [ -f "$FILE" ] || continue
  CWD=$(head -1 "$FILE" | jq -r '.cwd // empty')
  [ -S "$CWD/.pi-rpc.sock" ] && WS="$CWD"
done <<< "$LIST"
[ -n "$WS" ] && echo "RUNNING=$WS" || echo "NOT_RUNNING"
```

- `NOT_BOUND` → 回「这个对话没有绑定 Pi 会话」，结束。
- `NOT_RUNNING` → 回「Pi 本来就没在跑」，结束。
- `RUNNING` → 继续第 2 步。

## 2. 叫停

用 `AskUserQuestion` 问「要叫停正在跑的 Pi 吗？」：选项「叫停」/「取消」。

- **取消** → 结束。
- **叫停**：

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pi-ctl.sh" "<工作区>" abort
cat "<工作区>/.pi-done" 2>/dev/null
```

- 看到 `ABORTED` → 回「已叫停，Pi 收尾后退出」；`.pi-done` 出现后状态以它为准。
- `NO_SOCKET` → 回「Pi 本来就没在跑」。
