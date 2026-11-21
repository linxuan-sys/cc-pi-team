---
description: Exit Pi team mode, unbind and resume normal work
argument-hint:
allowed-tools: Bash(acpx *) Bash(claude plugin list *) Bash(jq *) Bash(mktemp *) Bash(mv *) Bash(rm *) Bash(echo *)
disable-model-invocation: true
---

退出 Pi 团队模式。

1. **解除当前对话与 Pi 的绑定**（只删本会话那一条；没有就直说，不许假报成功）：

   ```bash
   set -e
   ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="pi@cc-pi-team") | (.readFromFolder // .installPath)')
   F="$ROOT/pi-bindings.json"
   if [ -f "$F" ] && jq -e --arg sid "$CLAUDE_CODE_SESSION_ID" 'has($sid)' "$F" >/dev/null; then
     tmp=$(mktemp)
     trap 'rm -f "$tmp"' EXIT
     jq --arg sid "$CLAUDE_CODE_SESSION_ID" 'del(.[$sid])' "$F" > "$tmp"
     mv "$tmp" "$F"
     echo "已解绑"
   else
     echo "本来就没绑定"
   fi
   ```

   解绑后侧边栏下一次轮询（1 秒内）会清空变白。

2. 如果 Pi 还有在跑的任务，先取消：`acpx pi cancel`

3. 汇报三件事：
   - 本轮 Pi 模式下完成了什么（一句话）
   - 会话 ID，以及以后重新打开的命令：`cd <目录> && pi --session <会话ID>`
   - 会话记录保留，未删除

4. 从下一条消息起恢复正常模式：Claude 自己写代码，不再派单给 Pi。

5. 不关闭、不删除任何 Pi 会话或记录。
