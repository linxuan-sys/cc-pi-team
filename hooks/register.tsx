import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

const PANE = 'pi-view'
const MARK_ART = [
  '████████████    ',
  '████████████    ',
  '████    ████    ',
  '████    ████    ',
  '████████    ████',
  '████████    ████',
  '████        ████',
  '████        ████',
].join('\n')
const CODE_ART = [
  ' '.repeat(35),
  ' '.repeat(35),
  ' '.repeat(35),
  '  ' + ' █████    ████    █████    ██████'.padEnd(33),
  '  ' + '██  ██   ██  ██   ██  ██   ██'.padEnd(33),
  '  ' + '██       ██  ██   ██  ██   █████'.padEnd(33),
  '  ' + '██  ██   ██  ██   ██  ██   ██'.padEnd(33),
  '  ' + ' █████    ████    █████    ██████'.padEnd(33),
].join('\n')
const MAX_READ = 3 * 1024 * 1024 // 单次最多读 3 MiB（引擎上限 4 MiB）
const MAX_KEEP = 500 // 面板只留最近 500 条
const MAX_ENTRY = 200_000 // 单条正文上限，超出截断并加省略号
const SEP = '\u0001'
const CTRL = /\u001b\[[0-9;]*[A-Za-z]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const encoder = new TextEncoder()

type Kind = 'task' | 'tool' | 'text'
type Entry = { key: string; kind: Kind; text: string }

const lines = atom({ plugin: 'pi', key: 'lines' } as const, [] as string[], { shape: 'lines-2' })
const binds = atom({ plugin: 'pi', key: 'binds' } as const, { files: [] as string[], idx: -1 }, { shape: 'binds-1' })

let shownPath = ''
let selected = -1
let savedOffset = -1
let restoring = false
let tickSid = ''
let lastSize = 0
let running = false
let noSkins = false
let stopTick: Timer | null = null
let entries: Entry[] = []

function reset() {
  entries = []
  lastSize = 0
}

async function clear($: any) {
  reset()
  await update($, lines, () => [])
}

async function openPane($: any) {
  const r = await $.ui.open({ id: PANE, title: 'Pi Output' })
  if (r.isPlaced) {
    if (savedOffset < 0) {
      await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
    } else {
      restoring = true
      await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
    }
  }
  return r
}

function parse(raw: string, base: number): Entry[] {
  const out: Entry[] = []
  raw.split('\n').forEach((line, li) => {
    if (!line.trim()) return
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      return
    }
    if (d?.type !== 'message') return
    const m = d.message ?? {}
    if (m.role !== 'assistant' && m.role !== 'user') return
    if (!Array.isArray(m.content)) return
    const mid = String(d.id ?? '').slice(0, 128)
    m.content.forEach((b: any, i: number) => {
      const key = mid ? `${mid}:${i}` : `${base}:${li}:${i}`
      if (b?.type === 'toolCall' && m.role === 'assistant') {
        const cmd = (String(b.arguments?.command ?? b.arguments?.path ?? '').split('\n')[0] ?? '').replace(CTRL, ' ').slice(0, 120)
        const name = String(b.name ?? 'tool').replace(CTRL, ' ').slice(0, 64)
        out.push({ key, kind: 'tool', text: `⚙ ${name}${cmd ? ': ' + cmd : ''}` })
      } else if (b?.type === 'text' && typeof b.text === 'string') {
        let text = b.text.replace(CTRL, '').trim()
        if (text.length > MAX_ENTRY) text = `${text.slice(0, MAX_ENTRY)}…`
        if (text) out.push({ key, kind: m.role === 'user' ? 'task' : 'text', text })
      }
    })
  })
  return out
}

async function consume($: any, file: string, from: number, to: number): Promise<number> {
  const text = await $.fs.read(file, { offset: from, length: Math.min(MAX_READ, to - from) })
  const cut = text.lastIndexOf('\n')
  // 没有完整行：只是还没写完就等下次；单行超过 3 MiB 就丢掉这一块继续
  if (cut < 0) return to - from > MAX_READ ? from + MAX_READ : from
  const body = text.slice(0, cut + 1)
  entries.push(...parse(body, from))
  return from + encoder.encode(body).length
}

async function boundPaths($: any): Promise<string[]> {
  try {
    const map = JSON.parse(await $.fs.read(`${$.plugin.root}/pi-bindings.json`))
    const v = map?.[await $.session.id()]
    const list = Array.isArray(v) ? v : v ? [v] : []
    return list.filter((p: unknown) => typeof p === 'string' && p) as string[]
  } catch {
    return []
  }
}

async function poll($: any) {
  if (running) return
  running = true
  let file = ''
  try {
    const files = await boundPaths($)
    if (!files.length) {
      if (shownPath) {
        shownPath = ''
        await clear($)
      }
      const cur = await read($, binds)
      if (cur.files.length) await update($, binds, () => ({ files: [], idx: -1 }))
      return
    }
    const idx = selected >= 0 && selected < files.length ? selected : files.length - 1
    file = files[idx]
    const cur = await read($, binds)
    if (cur.idx !== idx || cur.files.length !== files.length) await update($, binds, () => ({ files, idx }))
    if (file !== shownPath) {
      shownPath = file
      await clear($)
    }
    const st = await $.fs.stat(file)
    if (st.size < lastSize) await clear($)
    const from = lastSize
    const at = await consume($, file, from, st.size)
    if (at > from) {
      if (entries.length > MAX_KEEP) entries = entries.slice(-MAX_KEEP)
      await update($, lines, () => entries.map(e => `${e.kind}${SEP}${e.key}${SEP}${e.text}`))
    }
    lastSize = at
  } catch {
    // 读失败或文件正在写：下一轮再试；绑定文件真没了就清屏
    try {
      if (file && shownPath && !(await $.fs.exists(file))) {
        shownPath = ''
        await clear($)
      }
    } catch {
      // 检查失败也不影响下一轮
    }
  } finally {
    running = false
  }
}

const PI_USAGE = `【Pi 插件使用说明】
/pi:start 开启 Pi 模式并读用法；用户提到 Pi 时先调用它
/pi:team 团队/协同模式：Claude 计划与审核、Pi 写代码；默认单写手，多成员需完整计划书
/pi:review 只读审查：Pi 报问题，Claude 复核修复；支持单审/并行审/疯狂模式
/pi:steer <指令> 给正在跑的 Pi 插话纠偏，不重启；消息发错或重发也走它
/pi:abort 只叫停当前 Pi，不删绑定、不停其他会话
/pi:stop 退出 Pi 模式：中止并杀掉所有绑定的 Pi 进程，然后问是否解绑
/pi:connect 把当前对话接到已有 Pi 会话，只写绑定不启动；一个对话可绑多条
/pi:clear 清理当前工作区 .pi-* 临时文件；不动绑定、会话历史和 review 存档
/pi-pane 打开右侧输出面板，查看当前 Pi 的实时输出和历史
/pi-unbind 清空当前对话的所有 Pi 绑定，不停止正在跑的 Pi
【启用规则】只要用户提到 Pi（例如“让 Pi 做…”“Pi 帮我…”），**先调用 /pi:start 命令**，再按它进入 Pi 模式；
pi模式是多智能体协作模式，但凡用户提到pi，优先去看
用户只说“子智能体”、或完全没提 Pi 时，不要启用、不要推断、不要自动派单。`

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'pi:usage', text: PI_USAGE, scope: 'session' as const }] }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pi-pane', description: 'Open the Pi output pane', immediate: true })
    await $.command.register({ name: 'pi-unbind', description: 'Clear all Pi bindings', immediate: true })
    noSkins = false
    tickSid = await $.session.id()
    stopTick?.cancel()
    stopTick = $.clock.every(1000, () => void poll($))
    return next(e)
  })

  on('engine.create', async ($, e, next) => ({ ...(await next(e)), pi: { open: async () => undefined } }))

  on('pi.open', async $ => {
    await openPane($)
    return { value: undefined }
  })

  on('session.end', async ($, e, next) => {
    const sid = await $.session.id()
    if (tickSid && sid !== tickSid) return next(e)
    // /clear 和 resume 后进程继续、新会话不会再触发 session.start，轮询必须留着
    if (e.reason !== 'clear' && e.reason !== 'resume' && stopTick) {
      stopTick.cancel()
      stopTick = null
    }
    shownPath = ''
    await clear($)
    return next(e)
  })

  on('command.run', { command: 'pi-pane' }, async $ => {
    const { isPlaced } = await openPane($)
    return { text: isPlaced ? 'Pi output pane opened' : 'This surface does not support a side pane' }
  })

  on('command.run', { command: 'pi-unbind' }, async $ => {
    const file = `${$.plugin.root}/pi-bindings.json`
    await $.fs.write(file, '{}')
    shownPath = ''
    selected = -1
    await update($, binds, () => ({ files: [], idx: -1 }))
    await clear($)
    return { text: 'All Pi bindings cleared' }
  })

  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    if (e.origin.kind === 'person') {
      savedOffset = e.offset
      return next(e)
    }
    if (restoring) {
      restoring = false
      return next({ ...e, offset: savedOffset })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}

async function drawPane($: any, e: any) {
  const { Box, Text, Markdown, Button } = $.ui.resolve(e)
  const raw = await read($, lines)
  const bs = await read($, binds)
  if (!shownPath)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="#425f5b">{MARK_ART}</Text>
          <Text color="#7ea898">{CODE_ART}</Text>
        </Box>
        <Text> </Text>
        <Text dimColor>Not bound to a Pi session</Text>
        <Text> </Text>
        <Text color="#7ea898">/pi:start</Text>
        <Text dimColor>  enable Pi mode / read manual</Text>
        <Text color="#7ea898">/pi:team</Text>
        <Text dimColor>  team or collaboration</Text>
        <Text color="#7ea898">/pi:review</Text>
        <Text dimColor>  Pi reviews, Claude fixes</Text>
        <Text color="#7ea898">/pi:connect</Text>
        <Text dimColor>  bind an existing Pi session</Text>
        <Text color="#7ea898">/pi:steer</Text>
        <Text dimColor>  course correction to the running Pi</Text>
        <Text color="#7ea898">/pi:abort</Text>
        <Text dimColor>  abort the running Pi</Text>
        <Text color="#7ea898">/pi:stop</Text>
        <Text dimColor>  stop Pi, optionally unbind</Text>
        <Text color="#7ea898">/pi:clear</Text>
        <Text dimColor>  clear temporary Pi files</Text>
        <Text color="#7ea898">/pi-pane</Text>
        <Text dimColor>  open this output pane</Text>
        <Text color="#7ea898">/pi-unbind</Text>
        <Text dimColor>  clear all Pi bindings</Text>
      </Box>
    )
  const list = raw.map(s => {
    const first = s.indexOf(SEP)
    const second = s.indexOf(SEP, first + 1)
    return { kind: s.slice(0, first) as Kind, key: s.slice(first + 1, second), text: s.slice(second + 1) }
  })
  const columns = Math.max(20, Math.round(e.props.bodyColumns) - 2)
  const surface = e.surface as 'terminal' | 'desktop' | 'vscode' | 'mobile'
  const drawn = await Promise.all(
    list.map(async item => {
      if (item.kind !== 'text' || noSkins) return null
      try {
        return (await ($ as any).skins.markdown({ surface, text: item.text, columns })) ?? null
      } catch {
        noSkins = true
        return null
      }
    }),
  )
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text dimColor>Pi</Text>
        {bs.files.length > 1 && bs.files.map((_, i) => (
          <Button
            key={`b${i}`}
            label={`${i + 1}`}
            hotkey={i < 9 ? `${i + 1}` : undefined}
            variant={i === bs.idx ? 'primary' : undefined}
            onPress={() => { selected = i; void update($, binds, () => ({ files: bs.files, idx: i })) }}
          >
            <Text color={i === bs.idx ? '#cba6f7' : '#82869e'} bold={i === bs.idx}>
              {`[${i + 1}]`}
            </Text>
          </Button>
        ))}
      </Box>
      <Text dimColor>{shownPath.split('/').pop()}</Text>
      {list.length === 0 ? (
        <Text dimColor>等待 Pi 输出…</Text>
      ) : (
        list.map((item, i) =>
          item.kind === 'task' ? (
            <Box key={item.key} borderStyle="round" borderColor="#b4befe" paddingX={1}>
              <Text color="#cba6f7">{item.text}</Text>
            </Box>
          ) : item.kind === 'tool' ? (
            <Text key={item.key} dimColor>
              {item.text}
            </Text>
          ) : drawn[i] !== null ? (
            <Box key={item.key} flexDirection="column">
              {drawn[i]}
            </Box>
          ) : (
            <Markdown key={item.key} text={item.text} />
          ),
        )
      )}
    </Box>
  )
}
