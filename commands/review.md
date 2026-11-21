---
description: Review code with Pi (read-only), fix and re-review until it passes
argument-hint: [审查目标，可空]
allowed-tools: Bash(pi *) Bash(setsid *) Bash(nohup *) Bash(pgrep *) Bash(seq *) Bash(sleep *) Bash(cat *) Bash(cd *) Bash(echo *) Bash(python3 *) Bash(git *) Read Grep Glob Write Edit AskUserQuestion
disable-model-invocation: true
---

# Pi 审查

审查目标：$ARGUMENTS（空 = 当前未提交改动）

## 1. 任务书

写 `.pi-review-task.txt`：

```
【角色】我是 Claude，你是独立的代码审查者。你不改代码，只找问题。
【任务】审查：<范围>
【要求】读完整文件；找逻辑错误、边界、异常、并发、性能、安全、死代码；每条落到 文件:行；不确定标"待确认"。
【输出】按严重程度：阻断/重要/次要/建议；每条 文件:行 — 问题 — 为什么 — 修复建议；最后结论：通过/有条件通过/不通过。
【只读】不改项目文件，不暂存，不提交，不推送。
```

## 2. 启动并绑定

```bash
cd "<工作区>"
ID=$(cat .pi-session-id 2>/dev/null || python3 -I -c 'import uuid;print(uuid.uuid4())')
echo "$ID" > .pi-session-id
pgrep -f -- "--session-id $ID" >/dev/null 2>&1 && { echo "ALREADY_RUNNING"; exit 1; }
setsid nohup pi -p --approve --mode json --session-id "$ID" \
  "$(cat .pi-review-task.txt)" > .pi-events.jsonl 2>&1 < /dev/null &
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

## 3. 等 Pi 结束

```bash
cd "<工作区>"
ID=$(cat .pi-session-id)
while pgrep -f -- "--session-id $ID" >/dev/null 2>&1; do sleep 2; done
echo "PI_DONE"
```

## 4. 复核

读 `.pi-events.jsonl` 的最后一段 assistant text；逐条打开 `文件:行` 核对，属实的保留，误报标注。

## 5. 修复 → 自动复审（不停）

1. 修完提交到本地 `pi/team`（不 push）：

   ```bash
   git add -u
   git add -- "<本轮新增的文件>"
   git commit -m "pi: 第 N 轮修复"
   ```

2. 把问题清单和修复说明追加到 `.pi-review-task.txt`。
3. **立刻**重跑第 2、3 节（同一会话 ID），复核、再修、再提交。
4. **中途不要问用户，不要每轮汇报**；只在通过、5 轮上限、或必须用户拍板时停。
5. 结束时一次性汇报：几轮、每轮修了什么、结论、剩余问题。
