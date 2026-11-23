---
description: Clear temporary Pi runtime files in this workspace
---

清理当前工作区的 `.pi-*` 临时文件；不动 `pi-bindings.json`、不动 Pi 的会话历史（`~/.pi/agent/sessions`）、不动 `review/` 里的编号任务书。

## 1. 检查

```bash
[ -S "$PWD/.pi-rpc.sock" ] && echo RUNNING || echo IDLE
```

- `RUNNING` → 回「Pi 还在跑，先 `/pi:stop` 再清理」，结束。
- `IDLE` → 继续。

## 2. 清理

```bash
rm -f .pi-*
echo CLEARED
```

- 看到 `CLEARED` → 回「已清理当前工作区的临时文件」。
- 失败 → 贴错误并停。
