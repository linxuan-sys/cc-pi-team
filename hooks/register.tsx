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

let shownPath = ''
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

const openPane = ($: any) => $.ui.open({ id: PANE, title: 'Pi Output' })

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

async function boundPath($: any): Promise<string> {
  try {
    const map = JSON.parse(await $.fs.read(`${$.plugin.root}/pi-bindings.json`))
    const p = map?.[await $.session.id()]
    return typeof p === 'string' && p ? p : ''
  } catch {
    return ''
  }
}

async function poll($: any) {
  if (running) return
  running = true
  let file = ''
  try {
    file = await boundPath($)
    if (!file) {
      if (shownPath) {
        shownPath = ''
        await clear($)
      }
      return
    }
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pi-pane', description: 'Open the Pi output pane', immediate: true })
    await $.command.register({ name: 'pi-unbind', description: 'Clear all Pi bindings', immediate: true })
    noSkins = false
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
    return { text: isPlaced ? 'Pi 输出面板已打开' : '这个界面不支持侧栏面板' }
  })

  on('command.run', { command: 'pi-unbind' }, async $ => {
    const file = `${$.plugin.root}/pi-bindings.json`
    await $.fs.write(file, '{}')
    shownPath = ''
    await clear($)
    return { text: '绑定表已清空' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}

async function drawPane($: any, e: any) {
  const { Box, Text, Markdown } = $.ui.resolve(e)
  const raw = await read($, lines)
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
        <Text dimColor>  Claude plans, Pi writes the code, Claude reviews and commits</Text>
        <Text color="#7ea898">/pi:review</Text>
        <Text dimColor>  Pi reviews code read-only, Claude fixes until it passes</Text>
        <Text color="#7ea898">/pi:connect</Text>
        <Text dimColor>  attach this conversation to an existing Pi session</Text>
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
      <Text dimColor>{`Pi · ${shownPath.split('/').pop()}`}</Text>
      {list.length === 0 ? (
        <Text dimColor>等待 Pi 输出…</Text>
      ) : (
        list.map((item, i) =>
          item.kind === 'task' ? (
            <Box key={item.key} borderStyle="round" borderColor="cyan" paddingX={1}>
              <Text color="cyan">{item.text}</Text>
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
