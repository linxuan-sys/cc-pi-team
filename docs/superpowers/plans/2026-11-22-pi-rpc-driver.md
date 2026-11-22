# Pi RPC 驱动层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 cc-pi-team 的驱动层从 `pi -p --mode json` 落盘轮询改为 `pi --mode rpc` 长连接，全部命令适配，保留面板与中文工作流。

**Architecture:** 新增 Node broker 持有 Pi RPC 子进程：发任务书、事件转发到 `.pi-events.jsonl`、`get_state` 写绑定、Unix socket 接收 steer/abort。dispatch 脚本启动 broker；控制命令通过 `pi-ctl.sh` 走 socket。

**Tech Stack:** Bash + Node ≥22（无新依赖），Pi 1.6.0 自带 RPC 文档，复用 pi-delegate MIT 源码片段。

**Spec:** `docs/superpowers/specs/2026-11-22-pi-rpc-driver-design.md`

## Global Constraints

- 不新增 npm 依赖；只允许 Node 内置模块。
- 下载上限 20 MB；实际只取数 KB 源码。
- 面板 `hooks/register.tsx` 不改。
- 中文流程与命令语义保持不变。
- 最简写法：一个文件一件事，不写抽象层。

## Review Focus

- RPC 进程不自己退出：完成只认 `agent_settled`（1.6.0 文档明确），`agent_end` 仅作 2 秒兜底。
- 两类失败：`response.success:false` 与 assistant `stopReason:"error"`。
- 不允许 `readline`；用严格 LF splitter。
- `.pi-pid` 现在是 broker（node）而非 pi，等待逻辑必须改为 `.pi-done`。
- `.pi-rpc.sock` 残留会导致下次 bind 冲突，启动前清理。

---

### Task 1: Vendor MIT 源码

**Files:**
- Create: `vendor/pi-delegate/LICENSE`
- Create: `vendor/pi-delegate/jsonl.mjs`

**Interfaces:**
- Produces: `createJsonlSplitter(): (chunk: string) => string[]`

- [ ] 写入 MIT LICENSE（Copyright (c) 2026 Stanley）。
- [ ] 写入 `jsonl.mjs` 原文（严格 LF 切分，注明来源）。
- [ ] 验证：`node --check vendor/pi-delegate/jsonl.mjs`。

### Task 2: Broker `scripts/pi-rpc.mjs`

**Files:**
- Create: `scripts/pi-rpc.mjs`

**Interfaces:**
- Consumes: `createJsonlSplitter`。
- Produces: CLI `node pi-rpc.mjs <workspace> <sessionId> <taskFile> <claudeSessionId>`。
- 输出文件：`.pi-bound`（sessionFile）、`.pi-done`（status）、`.pi-events.jsonl`、`.pi-events.stderr.log`、`.pi-rpc.sock`。

- [ ] spawn `pi --mode rpc --approve --session-id <id>`，cwd=workspace，stdio 三管。
- [ ] stdout 逐行 JSON：追加原行到 `.pi-events.jsonl`；处理 `get_state` 响应写绑定与 `.pi-bound`；处理 `success:false` 与 `stopReason:"error"`；`agent_settled` 收尾，`agent_end && willRetry!==true` 启动 2 秒兜底。
- [ ] 发 `{"id":"state","type":"get_state"}` 和 `{"id":"prompt","type":"prompt","message":<任务书全文>}`。
- [ ] Unix socket：`{"command":"steer","message":...}` → `{"type":"steer",...}`；`{"command":"abort"}` → `{"type":"abort"}`。
- [ ] 收尾：追加 `{"type":"delegate_done","aborted":bool,"error":string|null}`，关 stdin，2 秒后 SIGKILL，写 `.pi-done`，删 socket。
- [ ] SIGTERM/SIGINT：发 abort，关 stdin，升级强杀。
- [ ] stderr 单独写 `.pi-events.stderr.log`。
- [ ] 文件头注明改编自 pi-delegate `src/dispatch.mjs`（MIT）。
- [ ] 验证：`node --check scripts/pi-rpc.mjs`。

### Task 3: `scripts/pi-dispatch.sh`

**Files:**
- Modify: `scripts/pi-dispatch.sh`（全量重写）

- [ ] 参数与任务书契约不变（`<workspace> <new|bind> <start|review>`）。
- [ ] 清理旧哨兵与 socket；new 用 `uuidgen` 或 `node -e crypto.randomUUID()` 生成 id；bind 从绑定文件首行取 id。
- [ ] 启动 `nohup node pi-rpc.mjs ... &`，`.pi-pid` 记 broker pid。
- [ ] 轮询 `.pi-bound` 最多 30 秒；失败输出 `NO_SESSION`/`BIND_FAILED`；成功 `BOUND=<file>`。
- [ ] 验证：`bash -n scripts/pi-dispatch.sh`。

### Task 4: `scripts/pi-ctl.sh` + 控制命令

**Files:**
- Create: `scripts/pi-ctl.sh`
- Create: `commands/steer.md`
- Create: `commands/abort.md`

- [ ] `pi-ctl.sh <workspace> steer <message>` / `abort`；无 socket 输出 `NO_SOCKET`；成功 `STEERED`/`ABORTED`。
- [ ] 两个命令 md：`disable-model-invocation: true`，用 AskUserQuestion 只在必要时确认，调用 ctl 脚本并贴输出。
- [ ] 验证：`bash -n scripts/pi-ctl.sh`。

### Task 5: 现有命令适配

**Files:**
- Modify: `commands/start.md`、`commands/review.md`、`commands/stop.md`

- [ ] start/review：等待改为 `while [ ! -f .pi-done ]; do sleep 2; done`；审核读 `.pi-events.jsonl` 时补 `delegate_done`；加提示 `/pi:steer`、`/pi:abort`。
- [ ] stop：先 `pi-ctl.sh abort`，再杀 broker（`.pi-pid`），`pkill -f pi-rpc.mjs` 兜底；`REOPEN` 不变。
- [ ] connect 不改。

### Task 6: 清单与说明

**Files:**
- Modify: `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`README.md`

- [ ] 版本 `0.2.0`，描述改为 RPC 长连接 + steer/abort。
- [ ] README 补新命令与架构一句话。
- [ ] 验证：`jq . .claude-plugin/plugin.json`、`jq . .claude-plugin/marketplace.json`。

### Task 7: 静态验收

- [ ] `node --check scripts/pi-rpc.mjs`
- [ ] `bash -n scripts/pi-dispatch.sh scripts/pi-ctl.sh`
- [ ] `grep -rn "mode json" scripts commands README.md` 应无残留（历史文档除外）
- [ ] `git status --short` 汇总改动
