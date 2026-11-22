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

## 标准流程

1. 确认工作区（当前目录或用户指定）。
2. 问模式：团队/协同读 `commands/team.md`；审查读 `commands/review.md`。
3. 写计划/任务书，用户批准后再派单。
4. 派单后等 Pi 完成，读它的输出审核；不满意就用返工单继续。
5. 通过后汇报；要停就 `/pi:stop`。

## 硬规则

- 一个工作区只能跑一个 Pi；一个 Pi 只归一个 Claude 对话。
- 只提交本地，绝不 push；每轮改完提交一次。
- 只有用户提到 Pi 才启用；只说“子智能体”或没提 Pi 时不启用、不推断。
- 多成员和并行审按 `team.md` / `review.md` 的规则，不自行加功能。
