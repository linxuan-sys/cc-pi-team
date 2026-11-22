# cc-pi-team RPC 驱动层设计（2026-11-22）

## 目标

把 Pi 驱动层从 `pi -p --mode json` 一次性落盘改为 `pi --mode rpc` 长连接，同时**完整保留**现有侧边栏面板、绑定表、中文团队/协同与审查流程。

## 为什么

现在只能"发任务书 → 等进程退出 → 读文件"，跑起来插不上嘴；RPC 提供 `steer` / `abort` / `agent_settled`，且 `get_state` 能直接返回 `sessionFile`，不再靠 grep 首行和扫目录找会话文件。

## 方案

三选一，选 A：

- **A（选中）**：新增 `scripts/pi-rpc.mjs` broker + `scripts/pi-ctl.sh`，改 `pi-dispatch.sh`。面板零改动。
- B：装 pi-delegate 当驱动层——会丢中文任务书、审查循环、报告。
- C：coproc/FIFO 最小改造——无 steer，双向管道脆弱。

## 改动清单

| 文件 | 动作 |
|---|---|
| `scripts/pi-rpc.mjs` | 新增。broker：spawn `pi --mode rpc`，发任务书，转发事件，监听控制 socket，收尾 |
| `scripts/pi-ctl.sh` | 新增。`steer <消息>` / `abort`，往 `.pi-rpc.sock` 写一行 JSON |
| `scripts/pi-dispatch.sh` | 改。new/bind 都启动 broker；`BOUND=` 从 broker 输出拿 |
| `commands/steer.md`、`commands/abort.md` | 新增。`/pi:steer <消息>`、`/pi:abort` |
| `commands/stop.md` | 改。杀 broker 并转发关闭；pkill 匹配 `--mode rpc` |
| `commands/start.md`、`review.md` | 小改。等待/结束判定以 `.pi-events.jsonl` 末尾 `delegate_done` 为准，`/proc` 轮询保留为兜底 |
| `hooks/register.tsx` | **不动** |

## 复用来源（MIT）

| 层 | 来源 | 处理 |
|---|---|---|
| spawn `pi --mode rpc`、严格 LF JSONL splitter、`prompt`/`steer`/`abort` 发送、terminal event 判定、SIGTERM→SIGKILL 升级、stdin EPIPE 防护 | **pi-delegate `src/dispatch.mjs` / `src/jsonl.mjs` / `src/verdict.mjs`**（MIT，Copyright LarryStanley） | vendor 裁剪，文件头保留版权声明并注明改编自 cc-pi-team 的哪几个文件 |
| 协议参考 | 本机 `/usr/lib/pi/docs/rpc.md`、`rpc-commands.md`、`/usr/lib/pi/examples/rpc-client.ts` | 只读对照，不 import（本机无 `dist/`） |
| 绑定、事件落盘、socket、收尾 | 本仓库新写 | ~80 行胶水 |

**三个必须继承的坑**（pi-delegate 注释里已验证）：
1. RPC 不自己退，完成只认 stdout 里的 `agent_settled`（`agent_end` 仅记录，其后可能还有 retry/compaction/steering）；
2. 命令失败走 `response.success:false`，模型/API 失败走 assistant `stopReason:"error"` + `errorMessage`，两条都要处理；
3. 不用 `readline` 切行；`--cwd` 不存在，工作目录靠 spawn 的 `options.cwd`。

## broker 行为

1. cwd = 工作区，spawn `pi --mode rpc --approve`；bind 模式加 `--session <id>`（`pi --help` 里 1.6.0 的官方参数是 `--session`，不是旧版的 `--session-id`）。
2. stdout 按 **LF 严格切行**（Pi 文档明确不能用 Node `readline`）；stderr 单独写 `.pi-events.stderr.log`，不再混进事件文件。
3. 启动后先发 `{"id":"state","type":"get_state"}`，把返回的 `sessionFile` 写进 `pi-bindings.json[CLAUDE_CODE_SESSION_ID]`。
4. 发 `{"id":"prompt","type":"prompt","message":<任务书>}`。
5. 每条事件原样追加到 `.pi-events.jsonl`（保持现有读取逻辑可用）。
6. Unix socket `.pi-rpc.sock` 收 `{"command":"steer"|"abort"}`，映射为 `{"type":"steer"}` / `{"type":"abort"}` 写入 stdin。
7. 收到 `agent_settled` → 追加 `{"type":"delegate_done","aborted":<bool>}` → 关 stdin → 等进程退出 → 写 `.pi-done`。
8. SIGTERM → 发 abort，3 秒后强杀；确保 Pi 子进程不残留。

## 验证（实现后必跑）

1. 短任务：`BOUND` 正确、绑定文件存在、事件末尾有 `delegate_done`、面板实时刷新；
2. 长任务中途 `/pi:steer`：方向被改变；
3. `/pi:abort`：Pi 停下且 `aborted:true`；
4. `/pi:stop`：broker 与 Pi 都死干净；`/pi:start` 恢复旧会话可继续。

## 风险

- `--session` 恢复、`agent_settled` 语义以本机 1.6.0 自带文档为准，首次实跑验证；
- RPC 拒绝 `@file`，任务书必须走 prompt 文本（已按此设计）；
- 面板实时性取决于 Pi 追加写 session 文件的时机，首跑用 `tail -f` 确认；
- 不新增依赖、不改面板、不碰 MCP。
