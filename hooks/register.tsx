import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'pi-view'
const MAX_READ = 1024 * 1024 // 每次最多读 1 MiB，避开引擎 4 MiB 上限
const MAX_KEEP = 5000 // 内存里最多保留的条数
const SEP = '\u0001'
const TOOL = '⚙ '
const MARK = '%%CLAUDE%%'

let bindingsPath = ''
let homeDir = ''
async function bindingsFile($: any): Promise<string> {
  if (!bindingsPath) {
    const env = await $.process.hookEnv()
    const root = env.CLAUDE_PLUGIN_ROOT
    if (!root) throw new Error('CLAUDE_PLUGIN_ROOT 未设置，无法定位绑定表')
    bindingsPath = `${root}/pi-bindings.json`
  }
  return bindingsPath
}

// atom 里存 `${key}␁${text}`：key 用于 React 复用，text 是要显示的内容
const lines = atom({ plugin: 'pi', key: 'lines' } as const, [] as string[], {
  shape: 'lines-1',
})

let shownPath = ''
let primed = false
let lastSize = -1
let lastMtime = -1
let running = false
let stopTick: (() => void) | null = null
let entries: Array<{ key: string; text: string }> = []
const seen = new Set<string>()

function parseEntries(raw: string): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d?.type !== 'message') continue
    const m = d.message ?? {}
    const mid = String(d.id ?? '')
    // system 消息的 content 常常是字符串；不是数组就直接跳过，别再让整个解析炸掉
    if (m.role !== 'assistant' && m.role !== 'user') continue
    if (!Array.isArray(m.content)) continue
    m.content.forEach((b: any, i: number) => {
      const key = `${mid}:${i}`
      if (b?.type === 'toolCall' && m.role === 'assistant') {
        const cmd = b.arguments?.command ?? b.arguments?.path ?? ''
        const one = String(cmd).split('\n')[0].slice(0, 120)
        out.push({ key, text: TOOL + (b.name ?? 'tool') + (one ? ': ' + one : '') })
        return
      }
      if (b?.type !== 'text' || typeof b.text !== 'string') return
      const text = b.text.trim()
      if (!text) return
      if (m.role === 'assistant') out.push({ key, text })
      else if (m.role === 'user' && text.startsWith('【角色】')) out.push({ key, text: MARK + text })
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
    if (st.size === lastSize && mtime === lastMtime) return

    // 首次读这条会话：分块读完整个文件，历史一条不漏
    if (!primed) {
      let off = 0
      let carry = ''
      while (off < st.size) {
        const len = Math.min(MAX_READ, st.size - off)
        const part = carry + (await $.fs.read(target, { offset: off, length: len }))
        const cut = part.lastIndexOf('\n')
        const body = cut >= 0 ? part.slice(0, cut) : ''
        carry = cut >= 0 ? part.slice(cut + 1) : part
        for (const e of parseEntries(body)) {
          if (!seen.has(e.key)) {
            seen.add(e.key)
            entries.push(e)
          }
        }
        off += len
      }
      primed = true
      lastSize = st.size
      lastMtime = mtime
      if (entries.length > MAX_KEEP) {
        entries = entries.slice(-MAX_KEEP)
        seen.clear()
        for (const e of entries) seen.add(e.key)
      }
      await update($, lines, () => entries.map(e => e.key + SEP + e.text))
      return
    }

    const start = Math.max(0, st.size - MAX_READ)
    const chunk = await $.fs.read(target, { offset: start, length: st.size - start })
    const nl = start > 0 ? chunk.indexOf('\n') : 0
    const body = start > 0 && nl >= 0 ? chunk.slice(nl + 1) : chunk
    if (!body.trim()) return // 窗口里还没有完整的行，下次再试，不清屏
    const fresh = parseEntries(body).filter(e => !seen.has(e.key))
    if (fresh.length === 0) {
      lastSize = st.size
      lastMtime = mtime
      return
    }
    for (const e of fresh) {
      seen.add(e.key)
      entries.push(e)
    }
    if (entries.length > MAX_KEEP) {
      entries = entries.slice(-MAX_KEEP)
      seen.clear()
      for (const e of entries) seen.add(e.key)
    }
    lastSize = st.size
    lastMtime = mtime
    await update($, lines, () => entries.map(e => e.key + SEP + e.text))
  } catch {
    // 读失败：保留已有内容，下次再试
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
    startTick($)
    return next(e)
  })

  // 别的插件通过 $.pi.open() 打开这个面板
  on('engine.create', async ($, e, next) => ({ ...(await next(e)), pi: { open: async () => undefined } }))

  on('pi.open', async $ => {
    await $.ui.open({ id: PANE, title: 'Pi Output' })
  })

  on('session.end', async ($, e, next) => {
    if (stopTick) {
      stopTick()
      stopTick = null
    }
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
    const { Box, Text, Markdown } = $.ui.resolve(e)
    // 先 read：引擎靠这次读取把面板订阅到 atom 上
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
      const i = s.indexOf(SEP)
      return { key: i >= 0 ? s.slice(0, i) : s, text: i >= 0 ? s.slice(i + 1) : s }
    })
    return (
      <Box flexDirection="column">
        <Text dimColor>{`Pi · ${shownPath.split('/').pop()}`}</Text>
        {list.length === 0 ? (
          <Text dimColor>等待 Pi 输出…</Text>
        ) : (
          list.map(item =>
            item.text.startsWith(MARK) ? (
              <Box key={item.key} borderStyle="round" borderColor="cyan" paddingX={1}>
                <Text color="cyan">{'我 → Pi: ' + item.text.slice(MARK.length)}</Text>
              </Box>
            ) : item.text.startsWith(TOOL) ? (
              <Text key={item.key} dimColor>
                {item.text}
              </Text>
            ) : (
              <Markdown key={item.key} text={item.text} />
            ),
          )
        )}
      </Box>
    )
  })
}
