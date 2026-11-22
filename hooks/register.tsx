import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'pi-view'
const MAX_READ = 3 * 1024 * 1024 // 每次最多读 3 MiB，避开引擎 4 MiB 上限
const MAX_KEEP = 5000
const MAX_BYTES = 1024 * 1024 // encoded 总量：JSON 转义后仍远低于引擎 4 MiB 写入上限
const SEP = '\u0001'
const TOOL = '⚙ '
// 工具命令里不显示控制字符/ANSI 转义
const CTRL = /\u001b\[[0-9;]*[A-Za-z]|[\u0000-\u001f\u007f-\u009f]/g
// 正文只允许 tab 和换行，其余控制字符丢掉（Text/Markdown 的输入约定）
const TEXT_CTRL = /\u001b\[[0-9;]*[A-Za-z]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

type Kind = 'task' | 'tool' | 'text'
type Entry = { key: string; kind: Kind; text: string }

let bindingsPath = ''
async function bindingsFile($: any): Promise<string> {
  if (!bindingsPath) bindingsPath = `${$.plugin.root}/pi-bindings.json`
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
let dirty = false
let skinsOff = false
let stopTick: (() => void) | null = null
let entries: Entry[] = []
const seen = new Set<string>()
let generation = 0
let lastBindError = ''
let drawnCache = new Map<string, any>()
let drawnCacheKey = ''

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
      const text = b.text.replace(TEXT_CTRL, '').trim()
      if (!text) return
      if (m.role === 'assistant') out.push({ key, kind: 'text', text })
      else if (m.role === 'user') out.push({ key, kind: 'task', text })
    })
  }
  return out
}


// 手工 base64 解码，避免依赖运行时是否提供 atob/Buffer
function decodeBase64(s: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buf = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < clean.length; i++) {
    const v = chars.indexOf(clean[i])
    if (v < 0) continue
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

// 在字节空间里跳过一条超长行，返回下一个换行之后的字节位置；不支持字节读则返回 from
async function skipOversizeLine($: any, target: string, from: number, to: number): Promise<number> {
  let at = from
  while (at < to) {
    const len = Math.min(MAX_READ, to - at)
    let bytes: Uint8Array | null = null
    try {
      const res = await $.fs.read(target, { offset: at, length: len, as: 'bytes' })
      const b64 = typeof res === 'string' ? res : res?.base64
      if (typeof b64 === 'string') bytes = decodeBase64(b64)
    } catch {
      return from
    }
    if (bytes === null) return from
    const nl = bytes.indexOf(0x0a)
    if (nl >= 0) return at + nl + 1
    at += bytes.length
    if (bytes.length < len) break
  }
  return to
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
    if (!home || !real.endsWith('.jsonl')) return ''
    // ~/.pi 可能是符号链接，按 sessions 根的真实路径比较，而不是字面前缀
    const rootStat = await $.fs.stat(`${home}/.pi/agent/sessions`, { resolve: true }).catch(() => undefined)
    const root = String((rootStat as any)?.realPath ?? '')
    if (!root || !real.startsWith(root.replace(/\/+$/, '') + '/')) return ''
    lastBindError = ''
    return p.trim()
  } catch (error: unknown) {
    const why = error instanceof Error ? error.message : String(error)
    if (why !== lastBindError) {
      lastBindError = why
      try {
        $.ui.log(`pi-pane: bind ${why}`, { to: 'debug' })
      } catch {
        // 日志失败不影响轮询
      }
    }
    return ''
  }
}

function reset() {
  entries = []
  seen.clear()
  lastSize = -1
  lastMtime = -1
  primed = false
  dirty = false
  drawnCache.clear()
}

// 绑定被解掉/会话结束：让在飞的 poll 作废，别把旧内容写回来
function invalidate() {
  generation++
  reset()
}

function trim() {
  let cut = Math.max(0, entries.length - MAX_KEEP)
  let total = 0
  for (let i = entries.length - 1; i >= cut; i--) {
    const e = entries[i]
    if (!e) break
    total += byteLen(e.kind) + byteLen(e.key) + byteLen(e.text) + 2
    if (total > MAX_BYTES) {
      cut = Math.max(cut, i + 1)
      break
    }
  }
  if (cut === 0) return
  entries = entries.slice(cut)
  seen.clear()
  for (const e of entries) seen.add(e.key)
  for (const k of drawnCache.keys()) if (!seen.has(k)) drawnCache.delete(k)
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
      // 整块没有换行：单行超过 MAX_READ。在字节空间找到下一行的开头再继续，
      // 这样既不漂移，也不会让面板永久停更。
      if (len === MAX_READ) {
        const next = await skipOversizeLine($, target, at, to)
        if (next > at) {
          at = next
          const key = `skip:${at}`
          if (!seen.has(key)) {
            seen.add(key)
            entries.push({ key, kind: 'tool', text: `${TOOL}超大消息已跳过` })
          }
          continue
        }
      }
      break // 只是还没写完，等下次
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
  const gen = generation
  try {
    const target = await boundPath($)
    if (gen !== generation) {
      reset()
      return
    }
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
      if (gen !== generation) {
        reset()
        return
      }
    }
    const st = await $.fs.stat(target)
    if (gen !== generation) {
      reset()
      return
    }
    const mtime = (st as any).mtimeMs ?? 0
    if (st.size < lastSize || (st.size === lastSize && mtime !== lastMtime)) reset() // 截断或等长重写

    if (!primed) {
      const at = await consume($, target, 0, st.size)
      if (gen !== generation) {
        reset()
        return
      }
      trim()
      await update($, lines, encoded)
      if (gen !== generation) {
        reset()
        return
      }
      lastSize = at
      lastMtime = mtime
      primed = true
      dirty = false
      return
    }

    if (st.size === lastSize && mtime === lastMtime && !dirty) return
    const before = entries.length
    const at = await consume($, target, lastSize, st.size)
    if (gen !== generation) {
      reset()
      return
    }
    lastSize = at
    lastMtime = mtime
    if (entries.length !== before || dirty) {
      trim()
      await update($, lines, encoded)
      dirty = false
    }
  } catch (error: unknown) {
    if (gen !== generation) {
      reset()
      return
    }
    // entries 可能已前进而 atom 没写成；下一轮强制重写，避免面板永久落后。
    // prime 中途失败时丢掉半截 entries，下一轮从头读，免得顺序错乱。
    if (!primed) reset()
    dirty = true
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
    invalidate()
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
    // /clear 和 resume 后进程继续、新会话不会再触发 session.start，轮询必须留着
    if (e.reason !== 'clear' && e.reason !== 'resume' && stopTick) {
      stopTick()
      stopTick = null
    }
    shownPath = ''
    invalidate()
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
      map = JSON.parse(await $.fs.read(await bindingsFile($))) ?? {}
    } catch {
      map = {}
    }
    const old = map[self]
    if (!old) return { text: '当前对话本来就没绑定 Pi' }
    delete map[self]
    await $.fs.write(await bindingsFile($), JSON.stringify(map, null, 2))
    shownPath = ''
    invalidate()
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
        <Text dimColor>Use /pi:connect to attach an existing Pi session</Text>
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
  const rawCols = Number(e.props?.bodyColumns ?? e.viewport?.columns ?? 80)
  const columns = Number.isFinite(rawCols) ? Math.max(20, Math.round(rawCols) - 2) : 78
  const surface = (e.surface ?? 'terminal') as 'terminal' | 'desktop' | 'vscode' | 'mobile'
  const cacheKey = `${surface}\u0000${columns}`
  if (cacheKey !== drawnCacheKey) {
    drawnCache.clear()
    drawnCacheKey = cacheKey
  }
  const drawn = await Promise.all(
    list.map(async item => {
      if (item.kind !== 'text' || skinsOff) return null
      const hit = drawnCache.get(item.key)
      if (hit !== undefined) return hit
      try {
        const out = (await ($ as any).skins.markdown({ surface, text: item.text, columns })) ?? null
        if (out !== null) drawnCache.set(item.key, out)
        return out
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
