# pi

A Claude Code plugin: Claude plans and reviews, Pi writes the code, and Pi's
output shows in a side pane.

## Commands

- `/pi:start` — plan, delegate the coding to Pi, review, commit
- `/pi:review` — Pi reviews read-only; Claude fixes and automatically re-reviews
- `/pi:connect` — attach an existing Pi session
- `/pi:stop` — kill the bound Pi and unbind
- `/pi-pane` — open the output pane
- `/pi-unbind` — clear the binding

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) (`pi` on `PATH`)
- `python3`

## Install

```bash
claude plugin marketplace add linxuan-sys/cc-pi-team
claude plugin install pi@cc-pi-team
```

Local development: use the folder path instead —
`claude plugin marketplace add /path/to/cc-pi-team`, then `/reload-plugins`.

## How it works

- Claude runs `pi -p --mode json --session-id <id> "<task>"`.
- Pi writes `~/.pi/agent/sessions/<cwd>/<id>.jsonl`.
- The binding is one file, `~/.claude/pi-bindings.json`: `{"file": "..."}`.
- The pane polls that file every second and renders the text and tool calls.

## Layout

| Path | Purpose |
|---|---|
| `commands/*.md` | The four slash commands |
| `hooks/register.tsx` | Registers `/pi-pane`, `/pi-unbind`, polls and renders |
| `.claude-plugin/` | Plugin manifest and marketplace entry |
| `types/index.d.ts` | Plugin state declaration |

## Notes

- One Pi session per workspace at a time.
- `/pi:stop` kills the process and clears the binding; session records stay.
- Type-checking needs the local `.claude-plugin/types` stubs, which are not
  tracked; runtime does not need them.

---

# pi（中文）

一个 Claude Code 插件：Claude 出计划、做审核，Pi 写核心代码，Pi 的输出显示在侧边栏。

## 命令

- `/pi:start` —— 出计划、派给 Pi 实现、审核、提交
- `/pi:review` —— Pi 只读审查；Claude 修复并自动复审
- `/pi:connect` —— 连接一段已有的 Pi 会话
- `/pi:stop` —— 杀掉绑定的 Pi 并解绑
- `/pi-pane` —— 打开输出面板
- `/pi:unbind` —— 清空绑定

## 依赖

- [Pi](https://github.com/badlogic/pi-mono)（`pi` 在 `PATH` 里）
- `python3`

## 安装

```bash
claude plugin marketplace add linxuan-sys/cc-pi-team
claude plugin install pi@cc-pi-team
```

本地开发用文件夹路径：`claude plugin marketplace add /path/to/cc-pi-team`，然后 `/reload-plugins`。

## 工作原理

- Claude 运行 `pi -p --mode json --session-id <id> "<任务书>"`。
- Pi 写 `~/.pi/agent/sessions/<cwd>/<id>.jsonl`。
- 绑定表只有一个文件 `~/.claude/pi-bindings.json`：`{"file": "..."}`。
- 面板每秒轮询这个文件，渲染正文和工具调用。

## 说明

- 同一时间一个工作区只跑一个 Pi。
- `/pi:stop` 只杀进程、清绑定；会话记录保留。
- 类型检查依赖本机 `.claude-plugin/types`，不随仓库分发；插件运行不需要它。
