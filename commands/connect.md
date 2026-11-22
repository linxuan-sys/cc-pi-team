---
description: Connect this conversation to an existing Pi session
argument-hint: [工作目录]
disable-model-invocation: true
---

把当前对话接到一条已有 Pi 会话。只写绑定：不启动 Pi、不派单、不切分支。

**所有提问都用 `AskUserQuestion`**，不要用文字问；拿到答案就在同一个命令里继续。

## 1. 工作区

如果是由 `/pi:start` 或 `/pi:review` 转入，工作区用调用方已经确定的 `<工作区>`。

否则：`$ARGUMENTS` 有 → 直接用（`~` 先展开，必须是绝对路径）。
没有 → 用 `AskUserQuestion` 问「要连接哪个工作区？」：

- 选项：「当前目录（`<cwd>`）」和「取消」；Other 输入绝对路径。

## 2. 列会话

把 `<工作区>` 换成上一步的路径，`<编号或空>` 先留空，跑：

```bash
DIR="<工作区>"
DIR="${DIR%/}"
DIR="$(cd "$DIR" 2>/dev/null && pwd -P || printf '%s' "$DIR")"
N="<编号或空>"
n=0
FILE=""
while IFS=$'\t' read -r ts cwd f; do
  [ -n "$f" ] || continue
  n=$((n+1))
  if [ -n "$N" ]; then
    [ "$n" -eq "$N" ] && { FILE=$f; break; }
    continue
  fi
  q=$(tac "$f" 2>/dev/null | jq -r 'select(.type=="message" and .message.role=="user") | [.message.content[]? | select(.type=="text") | .text] | select(length > 0) | join(" ")' 2>/dev/null | head -1 | tr '\n\r\t' '   ' | cut -c1-60)
  [ -n "$q" ] || q="(无提问)"
  rel=${cwd#"$DIR"/}; [ "$rel" = "$cwd" ] && rel=""
  [ -n "$rel" ] && prefix="[$rel/] " || prefix=""
  printf '%d. %s %s · %s%s\n' "$n" "${ts:5:5}" "${ts:11:5}" "$prefix" "$q"
done < <(
  for f in ~/.pi/agent/sessions/*/*.jsonl; do
    head -1 "$f" 2>/dev/null | jq -r --arg f "$f" --arg d "$DIR" '
      select(.cwd == $d) |
      [.timestamp, .cwd, $f] | @tsv' 2>/dev/null
  done | sort -r
)
if [ -n "$N" ]; then
  [ -n "$FILE" ] || { echo NOT_FOUND; exit 1; }
  [ -f "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" ] || printf '{}' > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"
  OTHER=$(jq -r --arg sid "$CLAUDE_CODE_SESSION_ID" --arg p "$FILE" 'to_entries[] | select(.key != $sid) | select((.value | if type=="array" then . else [.] end) | index($p)) | .key' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" 2>/dev/null | head -1)
  [ -n "$OTHER" ] && { echo OCCUPIED; exit 0; }
  jq --arg sid "$CLAUDE_CODE_SESSION_ID" --arg p "$FILE" '.[$sid] = ((.[$sid] // []) | if type=="array" then . else [.] end | if index($p) then . else . + [$p] end)' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" && mv "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" || { echo BIND_FAILED; exit 1; }
  echo "BOUND"
fi
```

- 没有输出 → 说「这个工作区没有 Pi 会话」，结束。
- 只有 1 条 → 把 `<编号或空>` 换成 `1` 再跑同一条，看到 `BOUND` 才算完成。
- 2 条以上 → 用 `AskUserQuestion` 问「连接哪条会话？」：
  - 选项：列出的前 3 条，label 用 `1. 11-22 03:44`，description 用那一行的问题；Other 输入编号。
  - 拿到编号后，把 `<编号或空>` 换成编号再跑同一条，看到 `BOUND` 才算完成。

## 3. 完成

**看到 `BOUND` 才算完成**；绑定是追加：一个 Claude 可绑多条 Pi，一条 Pi 只能归一个 Claude。`OCCUPIED` 说明这条会话已被另一个对话占用，先在那边解绑再回来；`NOT_FOUND` / `BIND_FAILED` 也贴出来并停。然后问一次（`AskUserQuestion`）「是否开启审查模式？」：

- **是** → 先删当前对话的绑定（jq del 当前 sid，不要清空整表），再读 `${CLAUDE_PLUGIN_ROOT}/commands/review.md`，按它新建一个干净的 Pi 会话审查。
- **否** → 回三行：
  - 已连接
  - `/pi-pane` 看这条会话的历史
  - `/pi:start` 或 `/pi:review` 直接用它
