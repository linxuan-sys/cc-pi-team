import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'pi-view'
const MAX_LINES = 12
const MAX_READ = 1024 * 1024 // 每次最多读 1 MiB，避开引擎 4 MiB 上限
const TOOL = '⚙ '

let bindingsPath = ''
// 绑定表放固定位置，跟插件装在哪、命令从哪个目录跑都无关
async function bindingsFile($: any): Promise<string> {
  if (!bindingsPath) {
    const home = await $.env.get('HOME')
    if (!home) throw new Error('HOME 未设置，无法定位绑定表')
    bindingsPath = `${home}/.claude/pi-bindings.json`
  }
  return bindingsPath
}

const lines = atom({ plugin: 'pi', key: 'lines' } as const, [] as string[], {
  shape: 'lines-1',
})

let shownPath = ''
let lastSize = -1
let running = false
let stopTick: (() => void) | null = null

const MARK = '%%CLAUDE%%'

// 从一段 jsonl 文本里取出要显示的行：Pi 的正文、工具调用标题、Claude 派出的任务书
function textsFrom(raw: string): string[] {
  const out: string[] = []
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
    for (const b of m.content ?? []) {
      if (b?.type === 'toolCall' && m.role === 'assistant') {
        const cmd = b.arguments?.command ?? b.arguments?.path ?? ''
        const one = String(cmd).split('\n')[0].slice(0, 120)
        out.push(TOOL + (b.name ?? 'tool') + (one ? ': ' + one : ''))
        continue
      }
      if (b?.type !== 'text' || typeof b.text !== 'string') continue
      const text = b.text.trim()
      if (!text) continue
      if (m.role === 'assistant') {
        out.push(text)
      } else if (m.role === 'user' && text.startsWith('【角色】')) {
        out.push(MARK + text)
      }
    }
  }
  return out
}

// 当前这个 Claude Code 会话绑定的 Pi 会话文件；没绑定或路径不可信就返回空串
async function boundPath($: any): Promise<string> {
  try {
    const self = await $.session.id()
    const map = JSON.parse(await $.fs.read(await bindingsFile($)))
    const p = map?.[self]
    if (typeof p !== 'string' || !p.trim()) return ''
    const st = await $.fs.stat(p.trim(), { resolve: true })
    if (st.kind !== 'file') return ''
    const real = String((st as any).realPath ?? p.trim())
    if (!/\.pi\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/.test(real)) return ''
    return p.trim()
  } catch {
    return ''
  }
}

async function poll($: any) {
  if (running) return
  running = true
  try {
    const target = await boundPath($)
    if (!target) {
      if (shownPath) {
        shownPath = ''
        lastSize = -1
        await update($, lines, () => [])
      }
      return
    }
    if (target !== shownPath) {
      shownPath = target
      lastSize = -1
      await update($, lines, () => [])
    }
    const st = await $.fs.stat(target)
    if (st.size === lastSize) return
    const start = Math.max(0, st.size - MAX_READ)
    let chunk = await $.fs.read(target, { offset: start, length: st.size - start })
    if (start > 0) {
      const nl = chunk.indexOf('\n')
      chunk = nl >= 0 ? chunk.slice(nl + 1) : ''
    }
    const found = textsFrom(chunk)
    await update($, lines, () => found.slice(-MAX_LINES))
    lastSize = st.size
  } catch {
    // 读失败就等下一次轮询，不打断面板
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
      description: '打开 Pi 输出的右侧面板',
      immediate: true,
    })
    await $.command.register({
      name: 'pi-unbind',
      description: '解除当前对话与 Pi 的绑定',
      immediate: true,
    })
    startTick($)
    return next(e)
  })

  on('command.run', { command: 'pi-pane' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Pi 输出' })
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
    lastSize = -1
    await update($, lines, () => [])
    return { text: `已解绑: ${old}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    // 先 read：引擎靠这次读取把面板订阅到 atom 上，之后轮询才能触发重绘
    const list = await read($, lines)
    if (!shownPath) return <Box />
    const recent = list.slice(-MAX_LINES)
    return (
      <Box flexDirection="column">
        <Text dimColor>{`Pi · ${shownPath.split('/').pop()}`}</Text>
        {recent.length === 0 ? (
          <Text dimColor>等待 Pi 输出…</Text>
        ) : (
          recent.map((item, i) =>
            item.startsWith(MARK) ? (
              <Box key={'c' + i} borderStyle="round" borderColor="cyan" paddingX={1}>
                <Text color="cyan">{'我 → Pi: ' + item.slice(MARK.length)}</Text>
              </Box>
            ) : item.startsWith(TOOL) ? (
              <Text key={'t' + i} dimColor>
                {item}
              </Text>
            ) : (
              <Markdown key={'m' + i} text={item} />
            ),
          )
        )}
      </Box>
    )
  })
}
