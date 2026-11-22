---
description: Enable Pi mode and read the Pi plugin manual
argument-hint: [需求描述]
disable-model-invocation: true
---

# 开启 Pi 模式

当用户提到 Pi（“让 Pi 做…”“Pi 帮我…”）或输入 `/pi:start` 时，先读这份说明，再确认模式。**不要自动派单。**

## 这是什么

`cc-pi-team` 是一个 Claude Code 插件，让 Claude 和本机的 Pi 一起干活。Claude 负责计划、拆任务、审核和提交；Pi 负责实际写代码。

**原理**：

- Pi 是一个独立的编码 agent 进程，有自己的会话、上下文和模型配置，**不是 Claude 的子智能体**。
- Claude 用无头方式把任务书发给 Pi；Pi 执行时产生的正文、工具调用和结果会实时落进会话文件。
- 插件把这个 Pi 会话绑定到当前 Claude 对话：右侧面板实时显示 Pi 的输出，Claude 也能读到同一份记录。
- 用户随时可以插话纠偏或叫停，不用重启 Pi。
- 一个工作区同时只跑一个 Pi；一个 Pi 只归一个 Claude 对话；一个 Claude 可以绑多个 Pi，面板 `[1] [2]` 切换。

**插件提供**：

- 团队/协同模式：Pi 写代码，Claude 审核；
- 只读审查：Pi 报问题，Claude 修复并复审；
- 会话绑定与恢复：一轮跑完还能接着用同一份上下文；
- 实时输出面板、`/pi:steer` 纠偏、`/pi:abort` 叫停、`/pi:stop` 退出、`/pi:clear` 清理、`/pi-unbind` 解绑。

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
