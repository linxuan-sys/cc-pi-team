---
description: Connect this conversation to an existing Pi session
argument-hint: [工作目录]
disable-model-invocation: true
---

把当前对话接到已有 Pi 会话。只写绑定：不新建会话、不派单、不启动 Pi、不切分支。

## 1. 目录

用户给了 `$ARGUMENTS` → 用它；否则只问一句「要连接哪个目录的 Pi 会话？给我路径。」并停下等他回。

## 2. 列会话

```bash
for f in ~/.pi/agent/sessions/*/*.jsonl; do head -1 "$f" | jq -r --arg f "$f" '[.cwd, .timestamp, $f] | @tsv'; done
```

- 一条都没有 → 回「这个目录和子目录下都没有 Pi 会话，可以先在这里 `/pi:start` 建一条」，结束。
- 有结果 → **默认只列你给的那个目录**；只有该目录一条会话都没有时，才自动去子目录找、重新列一遍。
  清单格式：
  ```
  1. 11-21 14:50 · 最后一条问题摘要
  2. 11-21 12:03 · [lua/] 最后一条问题摘要
  ```
  子目录会话带 `[子目录/]` 前缀。然后只问「回个编号。」

## 3. 写绑定

用户回编号后，取对应的会话文件路径：

```bash
jq --arg sid "$CLAUDE_CODE_SESSION_ID" --arg p "<选中的会话文件>" '.[$sid] = $p' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" && mv "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"
```

- 写成功 → 回三行：
  ```
  已连接。接下来：
  1. /pi:start —— 接着这条会话继续干活
  2. /pi-pane —— 打开面板看这条会话的历史
  3. /pi:review —— 用它审查代码
  ```
- jq 报错 → 贴给用户，停。
- 如果这条会话已被另一个对话占用，先问「这条会话已被另一个对话占用，要解绑那边、连到这边吗？」
  - 同意 → 重绑：
    ```bash
    jq --arg sid "$CLAUDE_CODE_SESSION_ID" --arg p "<选中的会话文件>" --arg o "<另一个会话 ID>" 'del(.[$o]) | .[$sid] = $p' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" && mv "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"
    ```
  - 不同意 → 停，什么都不改。
