---
description: Enable Pi mode and read the Pi plugin manual
argument-hint: [需求描述]
disable-model-invocation: true
---

# 开启 Pi 模式

当用户提到 Pi（“让 Pi 做…”“Pi 帮我…”）或输入 `/pi:start` 时，先读这份说明书，再按流程做。**不要自动派单，先确认模式。**

## 命令

| 命令 | 作用 |
|---|---|
| `/pi:start` | 开启 Pi 模式并读这份说明书 |
| `/pi:team` | 团队/协同模式：Claude 出计划、Pi 写代码、Claude 审核 |
| `/pi:review` | 只读审查：Pi 报问题，Claude 修复并复审 |
| `/pi:connect` | 连接一条已有 Pi 会话，只写绑定，不启动 Pi |
| `/pi:steer <指令>` | 给正在跑的 Pi 插话纠偏，不重启 |
| `/pi:abort` | 叫停正在跑的 Pi |
| `/pi:stop` | 退出 Pi 模式：杀掉所有绑定的 Pi 进程，然后问是否解绑 |
| `/pi:clear` | 清理当前工作区的 `.pi-*` 临时文件 |
| `/pi-pane` | 打开右侧输出面板 |
| `/pi-unbind` | 清空所有 Pi 绑定 |

## 插件怎么运行

- **面板**：`hooks/register.tsx` 注册 `/pi-pane`、`/pi-unbind`，每秒轮询选中的 Pi 会话文件并渲染；`[1] [2]` 按钮切换绑定。
- **派单**：`scripts/pi-dispatch.sh <工作区> <new|bind> <start|review>` 启动 broker，成功输出 `BOUND=会话文件`。
- **broker**：`scripts/pi-rpc.mjs` 拉起 `pi --mode rpc`，把事件写进 `.pi-events.jsonl`；`get_state` 拿到会话文件写绑定；`.pi-rpc.sock` 接收 steer/abort；`agent_settled` 后写 `.pi-done` 并退出。
- **控制**：`scripts/pi-ctl.sh <工作区> steer|abort` 通过 socket 给 broker 发指令。
- **绑定表**：`pi-bindings.json` 把「Claude 会话」映射到「Pi 会话文件数组」；一个 Claude 可绑多个 Pi，一个 Pi 只归一个 Claude。
- **运行时文件**：`.pi-events.jsonl`、`.pi-pid`、`.pi-bound`、`.pi-done`、`.pi-rpc.sock`、`.pi-broker.log`；`/pi:clear` 清理。
- **会话历史**：`~/.pi/agent/sessions/...`，插件只读，不改写。

## 流程

1. 确认工作区（当前目录或用户指定）。
2. 问模式：团队/协同 → 读 `commands/team.md`；审查 → 读 `commands/review.md`。
3. 写计划/任务书，用户批准后再派单。
4. 派单后等 `.pi-done`，读 `.pi-events.jsonl` 审核；返工用同目录 `bind`。
5. 收尾汇报；需要停止时 `/pi:stop`。

## 硬规则

- 一个工作区只能跑一个 Pi；一个 Pi 只归一个 Claude 对话。
- 只提交本地，绝不 push；每轮改完提交一次。
- 只有用户提到 Pi 才启用；只说“子智能体”或没提 Pi 时不启用、不推断。
- 多成员和并行审按 `team.md` / `review.md` 的规则，不自行加功能。
