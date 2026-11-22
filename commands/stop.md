---
description: Exit Pi team mode, unbind and resume normal work
argument-hint:
disable-model-invocation: true
---

退出 Pi 模式：停掉本对话绑定的 headless Pi → 解绑 → 汇报。

## 1. 停 + 解绑

一条命令跑完：

1. 从 `${CLAUDE_PLUGIN_ROOT}/pi-bindings.json` 读本对话的会话文件；文件不存在或没有这个键就回 `NOT_BOUND`，结束。
2. 读它第一行，拿 `id` 和 `cwd`（`id` 缺失就从文件名里取）。文件不存在 → 跳过第 3 步，直接做第 4 步，回 `UNBOUND_STALE`（键照样删）。
3. 先 `pgrep -af "^pi .*--session-id[= ]<id>"` 看命中，只杀 **headless**（`pi -p ...`）的，等它退出（最多 5 秒）：`pkill -f "^pi .*--session-id[= ]<id>"`。命中的是交互式 `pi --session` → 先告诉用户、别杀，只解绑。5 秒后还在跑 → 报 `STILL_RUNNING`，不要假称已停；解绑照做，是否 `kill -9` 由用户决定。
4. 删掉本对话的键：`jq --arg sid "$CLAUDE_CODE_SESSION_ID" 'del(.[$sid])' "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json" > "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" && mv "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json.tmp" "${CLAUDE_PLUGIN_ROOT}/pi-bindings.json"`。
5. 回 `UNBOUND` / `UNBOUND_STALE`、`PI_ID`、`WORKSPACE`（还在跑就带 `STILL_RUNNING`）。

- `NOT_BOUND` → 回「当前对话本来就没绑定 Pi，跳过」。
- `UNBOUND` → 解绑成功，面板 1 秒内清空。
- `jq` 报错（绑定表不是合法 JSON）→ 贴给用户，停；不解绑、不动表（先备份再手工修）。

## 2. 汇报

- 本轮做了什么（一句话）
- 会话：`<PI_ID>`，重开用 `cd <WORKSPACE> && pi --session <PI_ID>`
- 会话记录保留，未删除
- 之后恢复正常模式：Claude 自己写代码，不再派单
