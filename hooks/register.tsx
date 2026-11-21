import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'pi-view'
const MAX_READ = 3 * 1024 * 1024 // 每次最多读 3 MiB，避开引擎 4 MiB 上限
const MAX_KEEP = 5000
const SEP = '\u0001'
const TOOL = '⚙ '
// 工具命令里不显示控制字符/ANSI 转义
const CTRL = /\u001b\[[0-9;]*[A-Za-z]|[\u0000-\u001f\u007f-\u009f]/g

type Kind = 'task' | 'tool' | 'text'
type Entry = { key: string; kind: Kind; text: string }

let bindingsPath = ''
async function bindingsFile($: any): Promise<string> {
  if (!bindingsPath) {
    const env = await $.process.hookEnv()
    const root = env.CLAUDE_PLUGIN_ROOT
    if (!root) throw new Error('CLAUDE_PLUGIN_ROOT 未设置，无法定位绑定表')
    bindingsPath = `${root}/pi-bindings.json`
  }
  return bindingsPath
}

// atom 每项编码为 `kind␁key␁text`，类型不再靠正文前缀猜
const lines = atom({ plugin: 'pi', key: 'lines' } as const, [] as string[], {
  shape: 'lines-2',
})

let shownPath = ''
let primed = false
let lastSize = -1
let lastMtime = -1
let running = false
let skinsOff = false
let stopTick: (() => void) | null = null
let entries: Entry[] = []
const seen = new Set<string>()

// UTF-8 字节数（代理对算 4 字节），不依赖 TextEncoder
function byteLen(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4
        i++
      } else n += 3 // 孤立高代理会被编成 U+FFFD
    } else n += 3
  }
  return n
}

function parseEntries(raw: string, base: number): Entry[] {
  const out: Entry[] = []
  let at = base
  for (const line of raw.split('\n')) {
    const lineStart = at
    at += byteLen(line) + 1
    if (!line.trim()) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d?.type !== 'message') continue
    const m = d.message ?? {}
    if (m.role !== 'assistant' && m.role !== 'user') continue
    if (!Array.isArray(m.content)) continue
    const mid = String(d.id ?? '')
    m.content.forEach((b: any, i: number) => {
      const key = mid === '' ? `${lineStart}:${i}` : `${mid}:${i}`
      if (b?.type === 'toolCall' && m.role === 'assistant') {
        const cmd = b.arguments?.command ?? b.arguments?.path ?? ''
        const one = String(cmd).split('\n')[0].replace(CTRL, ' ').slice(0, 120)
        out.push({ key, kind: 'tool', text: TOOL + (b.name ?? 'tool') + (one ? ': ' + one : '') })
        return
      }
      if (b?.type !== 'text' || typeof b.text !== 'string') return
      const text = b.text.trim()
      if (!text) return
      if (m.role === 'assistant') out.push({ key, kind: 'text', text })
      else if (m.role === 'user' && text.startsWith('【角色】')) out.push({ key, kind: 'task', text })
    })
  }
  return out
}

async function boundPath($: any): Promise<string> {
  try {
    const self = await $.session.id()
    const map = JSON.parse(await $.fs.read(await bindingsFile($)))
    const p = map?.[self]
    if (typeof p !== 'string' || !p.trim()) return ''
    const st = await $.fs.stat(p.trim(), { resolve: true })
    if (st.kind !== 'file') return ''
    const real = String((st as any).realPath ?? '')
    const home = await $.env.get('HOME')
    if (!home || !real.startsWith(`${home}/.pi/agent/sessions/`) || !real.endsWith('.jsonl')) return ''
    return p.trim()
  } catch {
    return ''
  }
}

function reset() {
  entries = []
  seen.clear()
  lastSize = -1
  lastMtime = -1
  primed = false
}

function trim() {
  if (entries.length <= MAX_KEEP) return
  entries = entries.slice(-MAX_KEEP)
  seen.clear()
  for (const e of entries) seen.add(e.key)
}

function encoded(): string[] {
  return entries.map(e => `${e.kind}${SEP}${e.key}${SEP}${e.text}`)
}

/**
 * 从 `from` 读到 `to`，只处理以换行结尾的完整行；返回真正消费到的字节位置。
 * 读块在换行处截断，绝不落在字符中间，所以不会产生 U+FFFD。
 */
async function consume($: any, target: string, from: number, to: number): Promise<number> {
  let at = from
  while (at < to) {
    const len = Math.min(MAX_READ, to - at)
    const text = await $.fs.read(target, { offset: at, length: len })
    const cut = text.lastIndexOf('\n')
    if (cut < 0) {
      // 整块没有换行：单行超过 MAX_READ。按字节跳会落在字符中间造成漂移，
      // 所以宁可不前进（面板停更）也不破坏位置；3 MiB 的单行极少见。
      break
    }
    const body = text.slice(0, cut + 1)
    for (const e of parseEntries(body, at)) {
      if (!seen.has(e.key)) {
        seen.add(e.key)
        entries.push(e)
      }
    }
    at += byteLen(body)
    if (len < MAX_READ) break
  }
  return at
}

async function poll($: any) {
  if (running) return
  running = true
  try {
    const target = await boundPath($)
    if (!target) {
      if (shownPath) {
        shownPath = ''
        reset()
        await update($, lines, () => [])
      }
      return
    }
    if (target !== shownPath) {
      shownPath = target
      reset()
      await update($, lines, () => [])
    }
    const st = await $.fs.stat(target)
    const mtime = (st as any).mtimeMs ?? 0
    if (st.size < lastSize || (st.size === lastSize && mtime !== lastMtime)) reset() // 截断或等长重写

    if (!primed) {
      lastSize = await consume($, target, 0, st.size)
      primed = true
      lastMtime = mtime
      trim()
      await update($, lines, encoded)
      return
    }

    if (st.size === lastSize && mtime === lastMtime) return
    const before = entries.length
    const at = await consume($, target, lastSize, st.size)
    lastSize = at
    lastMtime = mtime
    if (entries.length !== before) {
      trim()
      await update($, lines, encoded)
    }
  } catch (error: unknown) {
    try {
      const why = error instanceof Error ? error.message : String(error)
      $.ui.log(`pi-pane: ${why}`, { to: 'debug' })
    } catch {
      // 日志本身失败也不影响轮询
    }
  } finally {
    running = false
  }
}

function startTick($: any) {
  if (stopTick) stopTick()
  stopTick = $.clock.every(1000, () => void poll($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pi-pane',
      description: 'Open the Pi output pane',
      immediate: true,
    })
    await $.command.register({
      name: 'pi-unbind',
      description: 'Unbind this conversation from Pi',
      immediate: true,
    })
    skinsOff = false
    startTick($)
    return next(e)
  })

  // 别的插件通过 $.pi.open() 打开这个面板
  on('engine.create', async ($, e, next) => ({ ...(await next(e)), pi: { open: async () => undefined } }))

  on('pi.open', async $ => {
    await $.ui.open({ id: PANE, title: 'Pi Output' })
    return { value: undefined }
  })

  on('session.end', async ($, e, next) => {
    if (stopTick) {
      stopTick()
      stopTick = null
    }
    shownPath = ''
    reset()
    await update($, lines, () => [])
    return next(e)
  })

  on('command.run', { command: 'pi-pane' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Pi Output' })
    return { text: isPlaced ? 'Pi 输出面板已打开' : '这个界面不支持侧栏面板' }
  })

  on('command.run', { command: 'pi-unbind' }, async $ => {
    const self = await $.session.id()
    let map: Record<string, string> = {}
    try {
      map = JSON.parse(await $.fs.read(await bindingsFile($)))
    } catch {
      map = {}
    }
    const old = map[self]
    if (!old) return { text: '当前对话本来就没绑定 Pi' }
    delete map[self]
    await $.fs.write(await bindingsFile($), JSON.stringify(map, null, 2))
    shownPath = ''
    reset()
    await update($, lines, () => [])
    return { text: `已解绑: ${old}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      return await drawPane($, e)
    } catch (error: unknown) {
      // 渲染失败也要有东西显示，绝不留白；先 read 保证这次绘制订阅到 atom
      await read($, lines).catch(() => undefined)
      const { Box, Text } = $.ui.resolve(e)
      const why = error instanceof Error ? error.message : String(error)
      return (
        <Box flexDirection="column">
          <Text dimColor>{`Pi 面板渲染失败：${why}`}</Text>
        </Box>
      )
    }
  })
}

async function drawPane($: any, e: any) {
  const { Box, Text, Markdown } = $.ui.resolve(e)
  const raw = await read($, lines)
  if (!shownPath)
    return (
      <Box flexDirection="column">
        <Text dimColor>Not bound to a Pi session</Text>
        <Text dimColor>Use /pi:start to begin team mode</Text>
        <Text dimColor>Use /pi:review to review code</Text>
      </Box>
    )
  const list = raw.map(s => {
    const first = s.indexOf(SEP)
    const second = s.indexOf(SEP, first + 1)
    return {
      kind: s.slice(0, first) as Kind,
      key: s.slice(first + 1, second),
      text: s.slice(second + 1),
    }
  })
  // 表格只有 skin 的渲染器会画；拿不到就退回内置 Markdown
  const columns = Math.max(20, Number(e.props?.bodyColumns ?? e.viewport?.columns ?? 80) - 2)
  const surface = (e.surface ?? 'terminal') as 'terminal' | 'desktop' | 'vscode' | 'mobile'
  const drawn = await Promise.all(
    list.map(async item => {
      if (item.kind !== 'text' || skinsOff) return null
      try {
        return (await ($ as any).skins.markdown({ surface, text: item.text, columns })) ?? null
      } catch {
        skinsOff = true // 没有 skins 桥：本次会话不再尝试
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
