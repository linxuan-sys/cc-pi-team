# Pi 代码审查报告

- **日期**：2026-11-21
- **审查对象**：cc-pi-team 插件整个目录（`hooks/register.tsx`、`commands/*.md`、`types/index.d.ts`、清单文件、README）
- **审查者**：Pi（只读，未改动工作区）
- **复核者**：Claude（只读复核，未改动任何文件）
- **代码基线**：`18bd2da 修bug`（工作区干净）
- **说明**：`.claude-plugin/types/**` 为引擎自动生成的 API 类型声明（约 2.9 万行），仅作 API 参考，未逐行审查。
- **Pi 的结论**：**有条件通过** —— 无阻断项；重要 7 条、次要 11 条、建议 6 条。
- **复核结论**：属实 20 条、待确认 2 条（#5、#24）、已修复 1 条（#8）、设计建议 1 条（#20）。

---

## 一、Pi 报告原文汇总

### 阻断

无。

### 重要

1. **hooks/register.tsx:148–151** — 增量轮询用"文件尾部 1MiB 滑动窗口"而非从 `lastSize` 续读 — 两次轮询间新增超过 1MiB 时窗口外的行永久丢失（`seen` 去重使其永不补回）；窗口起点恰落在行边界时第一条完整行被当半行丢弃；单行超过 1MiB 的消息永远无法显示 — 改为从 `lastSize` 起按 ≤1MiB 分块续读并保留 carry。
2. **hooks/register.tsx:124–127** — priming 按字节范围读文本，跨块边界的多字节字符被引擎替换为 U+FFFD，carry 拼接无法恢复 — 用 `as:'bytes'` 读取，在换行字节处切块，只对完整行解码。
3. **hooks/register.tsx:139–143、163–167（与 148 联动）** — `MAX_KEEP` 裁剪后 `seen` 只保留最近 5000 条，但下次追加时尾窗重解析仍覆盖被裁掉的旧 key，它们被当作 fresh 重新追加到末尾，再把真正最新的条目裁掉 — 长会话面板顺序倒置且每次追加都抖动 — 续读修复后自然消失；否则裁剪时同步记录水位。触发频率待确认。
4. **hooks/register.tsx:202–204** — `pi.open` 钩子返回 `undefined`，违反 noun 事件契约（必须 `{value}` 或 `{deny}`）— 改为 `return { value: undefined }`。引擎对失败钩子的具体处置待确认，但契约违反是确定的。
5. **hooks/register.tsx:27–34、178–181、184–198、206–212** — 轮询状态全部是模块级单例：同一进程承载多个会话时，A 的结束会永久停掉 B 的轮询，面板永远显示最后启动会话的绑定 — 按 session id 隔离状态与定时器，或明确拒绝多会话。引擎是否跨会话复用模块实例待确认。
6. **commands/review.md:24–26（与 31–35 联动）** — 审查前先切到 `pi/team` 分支，而范围定义是 `git diff HEAD` — `pi/team` 已存在且与当前分支分叉时，审查范围混入两分支的全部无关差异，审错对象 — 审查不切分支；确需隔离时记录原 HEAD 并显式 `git diff <原HEAD>`。
7. **commands/review.md:47–56、68** — "Pi 只读、工作区禁改"仅靠任务书提示词约束，同时 `--approve-all` 自动批准一切命令，无任何技术性只读保障，也没有 start.md:153 那样的安全提醒 — 至少补上同级风险警示；确认 acpx 是否支持工具白名单/只读模式。

### 次要

8. **hooks/register.tsx:53** — `m.content` 非数组（如字符串）时 `.forEach` 抛 TypeError，被 poll 的空 catch 整体吞掉 — 面板静默停更、零诊断 — 加 `Array.isArray` 守卫；catch 里对非预期错误走 `$.ui.log(..., {to:'debug'})`。
9. **hooks/register.tsx:12** — `homeDir` 声明后从未使用 — 死代码 — 删除。
10. **hooks/register.tsx:47、50** — 消息缺 `id` 时 key 为 `':0'`，不同消息共用 key 被 `seen` 误去重，React key 也冲突 — 无 id 时跳过或用行偏移合成唯一 key。实际 pi 会话均带 id，触发条件待确认。
11. **hooks/register.tsx:219–235 + commands/stop.md:14–24 + commands/start.md:112–135** — 三处对 `pi-bindings.json` 都是无锁的读-改-写整表覆盖 — 两个对话同时绑定/解绑时互相覆盖丢更新 — 用 flock 包住 RMW。
12. **commands/stop.md:29（与 12–27、31–35 顺序联动）** — `acpx pi cancel` 排在解绑之后，且在 CC 当前目录执行而非绑定会话的工作区 — 工作区与 CC 启动目录不一致时取消错对象或失败，`--approve-all` 任务继续跑；第 3 步要汇报的会话 ID 在第 1 步已被删掉。
13. **commands/start.md:4、111 + commands/review.md:4、43** — 绑定块用到 `jq`，但两个命令的 allowed-tools 都没列 `Bash(jq *)`（只有 stop.md 列了）；`cd`、`set -e` 复合命令的权限匹配同样存疑 — 补列 `Bash(jq *)`。
14. **commands/start.md:84（review.md:21 同）** — 基线提交用 `git add -A`，与 start.md:213 自己写的"不要用 `git add -A`"直接矛盾 — 基线把垃圾文件永久写进历史。
15. **README.md:72、146** — "插件不往磁盘写任何东西"与实现不符：register.tsx:230 在 `/pi-unbind` 时写 `pi-bindings.json` — 文档失实。
16. **README.md:18、93（依赖）+ 50、125（运行时文件）** — jq 标注为仅 `/pi:stop` 用（start/review 也用）；绑定脚本依赖的 python3 完全未列；运行时文件清单漏 `.pi-dirty-before.txt`。
17. **hooks/register.tsx:260–264（与 57–60 联动）** — 渲染按文本前缀分类：Pi 的正文以 `%%CLAUDE%%` 或 `⚙ ` 开头即可伪装成"Claude 的任务书"或工具行 — 条目应携带结构化类型标记。
18. **hooks/register.tsx:206–212** — `session.end` 只停定时器，不重置 `shownPath/entries/seen` — resume 后新会话首次 poll 前面板短暂闪现上一会话内容。

### 建议

19. **hooks/register.tsx:72–82** — 空闲时每秒仍走 `session.id` + 读绑定表 + stat + `env.get` 至少 4 次 IPC — 缓存绑定表并按 mtime 失效。
20. **hooks/register.tsx:23–25、50–60、246–249** — `key␁text` 字符串打包是 Primitive Obsession / Data Clumps，第 17 条的伪装问题正源于此 — 条目改 JSON 编码 `{key, kind, text}`。
21. **commands/start.md:115–117** — python 绑定脚本 `json.load(open(f))` 不关句柄，且 `~/.acpx/sessions/` 任一坏文件让整个绑定 traceback 中止。
22. **commands/stop.md:17–20** — `mktemp` 在 /tmp、`mv` 跨文件系统非原子，崩溃可留半截绑定表 — 用 `mktemp -p "$(dirname "$F")"`。
23. **仓库无测试**（tsconfig 引用的 `tests/` 目录不存在）— 轮询/解析属非平凡逻辑，建议固化为回归测试。
24. **hooks/register.tsx:55–56** — 工具标题直接取命令首行渲染，未剥控制字符/ANSI 转义 — 渲染前剥离。Ink 是否已自行处理，待确认。

### Pi 声明的跳过与未检查项

- 本机无 `tsc` 且未获允许下载，类型检查未跑（strict 配置下 `any` 较多，预计可过但未验证）。
- 引擎运行时行为（失败钩子处置、模块实例作用域、CC 权限匹配器）仅依据类型声明推断，相关条目已标"待确认"。
- 自检脚本在 `/tmp/pi-review/selftest.mjs`，项目目录零改动。

---

## 二、Claude 逐条复核

| # | 复核结果 | 依据与说明 |
|---|---|---|
| 1 | ✅ 属实 | 代码确实是 `start = max(0, st.size - MAX_READ)`，非从 `lastSize` 续读；`chunk.slice(nl+1)` 会在窗口起点落于行首时切掉完整首行。补充：Pi 称"与 :113 注释矛盾"略牵强——该注释只承诺**首次读取**完整，不含增量。 |
| 2 | ✅ 属实 | 生成的 API 文档明写 "A text range that cuts a character gives U+FFFD at that edge"。影响为边界处 1–2 个替换字符，不是整行丢失。 |
| 3 | ✅ 属实（条件苛刻） | 逻辑推演成立；触发需 1MiB 窗口内条目数 > 5000（平均每条 <210B）。普通会话概率低，长会话可能触发。 |
| 4 | ✅ 属实（契约层面） | `types/index.d.ts` 声明 `pi.open: () => Promise<void>`；`ValueOrDeny<void>` 要求 `{value}` 或 `{deny}`，当前返回 `undefined` 违反契约。运行期处置未证实；目前也无其他插件调用 `$.pi.open()`，实际影响为 0。 |
| 5 | ⚠️ 待确认 | 文档称 `session.start` "Fires once per process for each loaded plugin"，模块实例按进程加载计；同进程多会话是否共享实例无法从类型声明证实。 |
| 6 | ✅ 属实 | review.md 先在 0 步切 `pi/team`，再按 `git diff HEAD` 定范围；分支分叉时确实审错对象。 |
| 7 | ✅ 属实 | review.md 无技术性只读保障，也无 start.md:153 同级安全提醒。 |
| 8 | ✅ 已修复 | 已由 `18bd2da 修bug` 加入 role 过滤 + `Array.isArray` 守卫（当前 register.tsx:50–52）。Pi 的分析基于旧代码，行号是结尾补读的。用两份真实 Pi 日志跑新版逻辑：50 / 98 条，无异常。仅剩 catch 仍吞非预期错误。 |
| 9 | ✅ 属实 | `homeDir` 仅在第 12 行声明，无引用。 |
| 10 | ✅ 属实（边界） | 无 id 时 key 为 `:i`，跨消息冲突；实际 Pi 日志均带 id。 |
| 11 | ✅ 属实 | register.tsx `/pi-unbind`、stop.md、start.md 三处均为无锁 RMW。 |
| 12 | ✅ 属实 | stop.md 先解绑再 cancel，且 cancel 在 CC 当前目录执行；汇报会话 ID 时绑定已删。 |
| 13 | ✅ 属实 | start.md 与 review.md 的 allowed-tools 均无 `Bash(jq *)`，而绑定块使用 jq；复合命令权限匹配规则待确认。 |
| 14 | ✅ 属实（一致性） | start.md:84 用 `git add -A`，与 213 行自身告诫矛盾。 |
| 15 | ✅ 属实 | README 72/146 称插件不写盘；register.tsx `/pi-unbind` 写 `pi-bindings.json`。 |
| 16 | ✅ 属实 | README 将 jq 说成仅 `/pi:stop` 用；python3 未列；`.pi-dirty-before.txt` 未列。 |
| 17 | ✅ 属实（低风险） | 渲染按 `startsWith(MARK)` / `startsWith(TOOL)` 分类，内容前缀可伪造 UI 语义；本地面板，风险低。 |
| 18 | ✅ 属实 | `session.end` 只停定时器，不 reset、不清空 atom。 |
| 19 | ✅ 属实（轻微） | 空闲时每秒 4 次 IPC（session.id、绑定表读取、stat(resolve)、env.get）。 |
| 20 | ✅ 属建议 | `key␁text` 字符串打包确与 #17 同源，属设计建议。 |
| 21 | ✅ 属实 | start.md 绑定块 `json.load(open(f))` 不关句柄；坏文件会 traceback 中止。 |
| 22 | ✅ 属实（低概率） | `mktemp` 默认 /tmp，跨文件系统 `mv` 非原子。 |
| 23 | ✅ 属实 | tsconfig `include` 含 `../../tests`，仓库内无 `tests/` 目录。 |
| 24 | ⚠️ 待确认 | 控制字符/ANSI 渲染问题取决于 Ink 是否处理，未验证。 |

---

## 三、处理优先级建议

1. **数据完整性**：#1、#2、#3 —— 增量续读 + 字节级切行 + 裁剪水位。
2. **契约**：#4 —— `pi.open` 返回 `{ value: undefined }`。
3. **审查流程正确性**：#6 —— review.md 不切分支，按原 HEAD 定范围。
4. **安全与文档**：#7、#13、#14、#15、#16 —— 补安全提醒、allowed-tools、README 事实修正。
5. **低风险清理**：#9、#10、#11、#12、#17、#18、#21、#22、#24。

---

## 四、状态说明

- 工作区干净，HEAD = `18bd2da 修bug`。
- Pi 未改动工作区；Claude 亦未改动任何代码（本文件为应要求新增的审查报告）。
- 本轮未建分支、未暂存、未提交。
