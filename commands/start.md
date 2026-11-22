---
description: Enable Pi mode and read the Pi plugin manual
argument-hint: [需求描述]
disable-model-invocation: true
---

# 开启 Pi 模式

当用户提到 Pi（“让 Pi 做…”“Pi 帮我…”）或输入 `/pi:start` 时，先读这份说明，再确认模式。**不要自动派单。**

## 这是什么

Pi 是另一个独立的编码 agent（本机 `pi` CLI）。这个模式把“写代码”交给 Pi，Claude 负责计划、拆任务、审核和提交。

- **不是子智能体**：Pi 有自己的进程和会话上下文，适合一整块、相对独立的编码任务。
- **靠的是 Pi 的无头模式**：插件把任务书送进去，把 Pi 的输出和工具调用带回来，并把这个 Pi 会话绑定到当前对话。
- 一个工作区同一时间只跑一个 Pi；一个 Pi 只归一个 Claude 对话；一个对话可以绑多个 Pi，用面板 `[1] [2]` 切换。

## 启用示例

Claude 实际派单用的命令：

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pi-dispatch.sh" "<工作区>" "new" "start"
```

## 常用命令

| 命令 | 什么时候用 |
|---|---|
| `/pi:start` | 开启 Pi 模式，读这份说明 |
| `/pi:team` | 让 Pi 写代码：团队或协同模式 |
| `/pi:review` | 让 Pi 只读审查代码，Claude 修复 |
| `/pi:connect` | 把当前对话接到一条已有 Pi 会话 |
| `/pi:steer <指令>` | Pi 跑偏了，插话纠偏，不重启 |
| `/pi:abort` | 叫停正在跑的 Pi |
| `/pi:stop` | 退出 Pi 模式，杀掉所有绑定的 Pi 进程，问是否解绑 |
| `/pi:clear` | 清理当前工作区的临时文件 |
| `/pi-pane` | 打开右侧输出面板 |
| `/pi-unbind` | 清空所有 Pi 绑定 |

最后提示用户：

- 团队模式：`/pi:team`
- 审查模式：`/pi:review`
