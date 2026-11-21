import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'pi-view'
const MAX_READ = 1024 * 1024
const MAX_KEEP = 5000
const SEP = '\u0001'

type Kind = 'task' | 'tool' | 'text'
type Entry = { key: string; kind: Kind; text: string }

const lines = atom({ plugin: 'pi', key: 'lines' } as const, [] as string[], {
  shape: 'lines-2',
})

let shownPath = ''
let lastSize = 0
let primed = false
let running = false
let stopTick: (() => void) | null = null
let entries: Entry[] = []
const seen = new Set<string>()

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
      } else n += 3
    } else n += 3
  }
  return n
}

function parse(raw: string): Entry[] {
  const out: Entry[] = []
  let at = 0
  for (const line of raw.split('\n')) {
    const start = at
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
    const mid = String(d.id ?? start)
    m.content.forEach((b: any, i: number) => {
      const key = `${mid}:${i}`
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ key, kind: m.role === 'user' ? 'task' : 'text', text: b.text.trim() })
        return
      }
      if (b?.type === 'toolCall' && m.role === 'assistant') {
        const cmd = b.arguments?.command ?? b.arguments?.path ?? ''
        const one = String(cmd).split('\n')[0].slice(0, 120)
        out.push({ key, kind: 'tool', text: `⚙ ${b.name ?? 'tool'}${one ? ': ' + one : ''}` })
      }
    })
  }
  return out
}

async function bindingFile($: any): Promise<string> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/pi-bindings.json` : ''
}

async function target($: any): Promise<string> {
  const b = await bindingFile($)
  if (!b) return ''
  try {
    const m = JSON.parse(await $.fs.read(b))
    return typeof m?.file === 'string' ? m.file : ''
  } catch {
    return ''
  }
}

function reset() {
  entries = []
  seen.clear()
  lastSize = 0
  primed = false
}

function encoded(): string[] {
  return entries.map(e => `${e.kind}${SEP}${e.key}${SEP}${e.text}`)
}

async function poll($: any) {
  if (running) return
  running = true
  try {
    const p = await target($)
    if (!p) {
      if (shownPath) {
        shownPath = ''
        reset()
        await update($, lines, () => [])
      }
      return
    }
    if (p !== shownPath) {
      shownPath = p
      reset()
      await update($, lines, () => [])
    }
    const st = await $.fs.stat(p)
    if (st.size < lastSize) reset()
    if (st.size === lastSize && primed) return
    const len = Math.min(MAX_READ, st.size - lastSize)
    if (len <= 0) return
    const text = await $.fs.read(p, { offset: lastSize, length: len })
    const cut = text.lastIndexOf('\n')
    if (cut < 0) {
      if (len === MAX_READ) {
        lastSize += MAX_READ
        entries.push({ key: `skip:${lastSize}`, kind: 'tool', text: '⚙ 超大消息已跳过' })
        await update($, lines, encoded)
      }
      primed = true
      return
    }
    const body = text.slice(0, cut + 1)
    let changed = false
    for (const e of parse(body)) {
      if (!seen.has(e.key)) {
        seen.add(e.key)
        entries.push(e)
        changed = true
      }
    }
    lastSize += byteLen(body)
    primed = true
    if (entries.length > MAX_KEEP) entries = entries.slice(-MAX_KEEP)
    if (changed) await update($, lines, encoded)
  } catch {
    // 下一轮再试
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

  on('pi.open', async $ => {
    await $.ui.open({ id: PANE, title: 'Pi Output' })
    return { value: undefined }
  })

  on('command.run', { command: 'pi-pane' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Pi Output' })
    return { text: isPlaced ? 'Pi 输出面板已打开' : '这个界面不支持侧栏面板' }
  })

  on('command.run', { command: 'pi-unbind' }, async $ => {
    const b = await bindingFile($)
    if (b) await $.fs.write(b, '{}').catch(() => undefined)
    shownPath = ''
    reset()
    await update($, lines, () => [])
    return { text: '已解绑' }
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const raw = await read($, lines)
    if (!shownPath) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Not bound to a Pi session</Text>
          <Text dimColor>Use /pi:connect to attach one</Text>
        </Box>
      )
    }
    const list = raw.map(s => {
      const a = s.indexOf(SEP)
      const b = s.indexOf(SEP, a + 1)
      return { kind: s.slice(0, a) as Kind, key: s.slice(a + 1, b), text: s.slice(b + 1) }
    })
    return (
      <Box flexDirection="column">
        <Text dimColor>{`Pi · ${shownPath.split('/').pop()}`}</Text>
        {list.length === 0 ? (
          <Text dimColor>等待 Pi 输出…</Text>
        ) : (
          list.map(item =>
            item.kind === 'task' ? (
              <Box key={item.key} borderStyle="round" borderColor="cyan" paddingX={1}>
                <Text color="cyan">{item.text}</Text>
              </Box>
            ) : item.kind === 'tool' ? (
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
