# pi

A Claude Code plugin that lets Claude lead and Pi write the code, with Pi's live output rendered in a side pane.

## What it does

- `/pi:start` — team mode: Claude plans, Pi implements, Claude reviews and commits
- `/pi:review` — Pi reviews code read-only, Claude fixes, re-review until it passes
- `/pi:stop` — leave team mode, unbind the conversation
- `/pi-pane` — open the Pi output pane
- `/pi-unbind` — unbind this conversation from its Pi session

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) (`pi` on `PATH`)
- `pi-acp` — ACP adapter for Pi
- `acpx` — headless ACP client
- `jq` — used by `/pi:stop` to edit the bindings file

## Install

```bash
claude plugin marketplace add linxuan-sys/cc-pi-team
claude plugin install pi@cc-pi-team
```

Local development (before pushing): use the folder path instead —
`claude plugin marketplace add /path/to/cc-pi-team`.

Then reload plugins in Claude Code:

```
/reload-plugins
```

## How it works

```
Claude ──acpx──> pi-acp ──> Pi
                    │
                    └── writes ~/.pi/agent/sessions/<cwd>/<id>.jsonl
                                      │
                          this plugin polls it every second
                                      │
                                      └── renders the pane
```

- The bindings file `<plugin>/pi-bindings.json` maps one Claude Code session id
  to one Pi session file. One conversation binds exactly one Pi session.
- Runtime files `.pi-task.txt` and `.pi-events.jsonl` are created in the working
  directory of each dispatch and are safe to delete.

## Layout

| Path | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.claude-plugin/marketplace.json` | Lets the folder act as its own marketplace |
| `commands/start.md` | `/pi:start` prompt |
| `commands/review.md` | `/pi:review` prompt |
| `commands/stop.md` | `/pi:stop` prompt |
| `hooks/hooks.json` | Points the engine at the code entry |
| `hooks/register.tsx` | Registers `/pi-pane` and `/pi-unbind`, polls and renders the pane |
| `types/index.d.ts` | Plugin state declaration |
| `tsconfig.json` | Editor/type-checking configuration only |

## Notes

- The pane shows the task Claude sent, Pi's assistant text, and Pi's tool call
  titles (not tool output, not thinking).
- Only one Pi session per conversation, and one workspace at a time.
- The pane keeps entries in memory; nothing is written to disk by the plugin.

---

# pi（中文）

一个 Claude Code 插件：Claude 领航、Pi 写核心代码，Pi 的实时输出显示在右侧侧边栏。

## 命令

- `/pi:start` —— 团队模式：Claude 出计划，Pi 实现，Claude 审核并提交
- `/pi:review` —— Pi 只读审查代码，Claude 按结论修复，再审直到通过
- `/pi:stop` —— 退出团队模式，解除绑定
- `/pi-pane` —— 打开 Pi 输出面板
- `/pi-unbind` —— 解除当前对话与 Pi 的绑定

## 依赖

- [Pi](https://github.com/badlogic/pi-mono)（`pi` 在 `PATH` 里）
- `pi-acp` —— Pi 的 ACP 适配器
- `acpx` —— 无界面 ACP 客户端
- `jq` —— `/pi:stop` 改绑定表时用

## 安装

```bash
claude plugin marketplace add linxuan-sys/cc-pi-team
claude plugin install pi@cc-pi-team
```

本地开发（推送前）用文件夹路径代替：
`claude plugin marketplace add /path/to/cc-pi-team`。

然后在 Claude Code 里重载插件：

```
/reload-plugins
```

## 工作原理

```
Claude ──acpx──> pi-acp ──> Pi
                    │
                    └── 写 ~/.pi/agent/sessions/<工作区>/<id>.jsonl
                                      │
                          插件每秒读一次这个文件
                                      │
                                      └── 渲染到侧边栏
```

- 绑定表 `<plugin>/pi-bindings.json` 把「一个 Claude Code 会话 ID」映射到
  「一个 Pi 会话文件」。一个对话只绑一条 Pi 会话。
- 每次派单会在工作区生成 `.pi-task.txt` 和 `.pi-events.jsonl`，都是临时文件，可随时删。

## 目录结构

| 路径 | 作用 |
|---|---|
| `.claude-plugin/plugin.json` | 插件清单 |
| `.claude-plugin/marketplace.json` | 让这个目录本身能当市场被安装 |
| `commands/start.md` | `/pi:start` 的提示词 |
| `commands/review.md` | `/pi:review` 的提示词 |
| `commands/stop.md` | `/pi:stop` 的提示词 |
| `hooks/hooks.json` | 指向代码入口 |
| `hooks/register.tsx` | 注册 `/pi-pane`、`/pi-unbind`，轮询并渲染面板 |
| `types/index.d.ts` | 插件状态声明 |
| `tsconfig.json` | 只给编辑器和类型检查用，运行时不参与 |

## 说明

- 面板显示三类内容：Claude 发出的任务书、Pi 的正文、Pi 的工具调用标题
  （不显示工具输出，也不显示思考过程）。
- 一个对话只绑一条 Pi 会话；同一时间只支持一个工作区。
- 面板内容全部在内存里，插件不往磁盘写任何东西。