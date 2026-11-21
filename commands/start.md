---
description: Pi team mode: plan, delegate coding to Pi, review and commit
argument-hint: [需求描述]
allowed-tools: Bash(pi *) Bash(setsid *) Bash(nohup *) Bash(pgrep *) Bash(seq *) Bash(sleep *) Bash(cat *) Bash(cd *) Bash(echo *) Bash(python3 *) Bash(git *) Read Grep Glob Write Edit EnterPlanMode ExitPlanMode AskUserQuestion
disable-model-invocation: true
---

# Pi 团队模式

## 1. 计划

用 `EnterPlanMode` 出计划：工作区、目标、步骤、每步改哪些文件、怎么验证。用户同意后继续。

## 2. 任务书

写 `.pi-start-task.txt`：

```
【角色】我是 Claude，你是本项目的秘书，核心编码全部由你完成，我负责计划与审核。
【要求】
1. 按下面的计划实现；子代理由你自己派遣。
2. 每完成一步立刻汇报：怎么实现、改了哪些文件、关键 diff 位置。
3. 全部完成后输出：改动文件清单、实现思路、如何验证、剩余风险。
4. 计划外不要改；需要偏离先停下说明。
5. 不能暂存、不能提交、不能推送。
【计划】
（用户批准的完整计划）
```

把任务书**完整贴给用户**，问「同意按这个任务书派单吗？」。只有明确同意才继续。

## 3. 启动并绑定

```bash
cd "<工作区>"
ID=$(cat .pi-session-id 2>/dev/null || python3 -I -c 'import uuid;print(uuid.uuid4())')
echo "$ID" > .pi-session-id
pgrep -f -- "--session-id $ID" >/dev/null 2>&1 && { echo "ALREADY_RUNNING"; exit 1; }
setsid nohup pi -p --approve --mode json --session-id "$ID" \
  "$(cat .pi-start-task.txt)" > .pi-events.jsonl 2>&1 < /dev/null &
FILE=""
for i in $(seq 1 100); do
  for f in ~/.pi/agent/sessions/*/*_${ID}.jsonl; do
    [ -f "$f" ] && { FILE=$f; break; }
  done
  [ -n "$FILE" ] && break
  sleep 0.2
done
[ -n "$FILE" ] || { echo "NO_SESSION"; exit 1; }
python3 -I -c 'import json,sys;open(sys.argv[1],"w").write(json.dumps({"file":sys.argv[2]}))' \
  "$HOME/.claude/pi-bindings.json" "$FILE"
echo "FILE=$FILE"
```

## 4. 等 Pi 结束

```bash
cd "<工作区>"
ID=$(cat .pi-session-id)
while pgrep -f -- "--session-id $ID" >/dev/null 2>&1; do sleep 2; done
echo "PI_DONE"
```

## 5. 审核与收尾

1. 读 `.pi-events.jsonl`：`message_end` 里 assistant 的 text = 汇报；`tool_execution_end` = 命令输出。
2. 打开改动文件核对，不要只看汇报。
3. 小问题自己修；核心问题追加返工单到 `.pi-start-task.txt`，最多两轮。
4. 通过后在 `pi/team` 上提交（只本地，不 push）：

   ```bash
   git add -u
   git add -- "<本轮新增的文件>"
   git commit -m "pi: 本轮改动"
   ```
