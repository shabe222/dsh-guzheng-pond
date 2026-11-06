/**
 * dsh-guzheng-pond — 宿主端。
 *
 * 一个按钮的整条链子都在这边：
 *
 *   按钮 ──POST /api/pond/task──▶ 派子会话（agents.create）
 *                                   │
 *                                   ├─ pond_knowledge()  读工具里的作曲知识
 *                                   └─ pond_play()       把谱面交上来
 *                                          │
 *                                          ▼
 *                                    渲染成 wav → 入队
 *                                          │
 *   水汪 ◀──GET /api/pond/state──── 队列
 *
 * 为什么知识走工具而不是系统提示词：这段手册 11KB，塞进系统提示词等于给
 * 每一个对话都加一遍，而它只对编曲的子会话有用。让子会话自己调
 * pond_knowledge 取，既符合「子会话用工具提供的知识来编曲」，也不污染别人。
 *
 * 渲染沿用项目里跑通的那条链：dev/render-qin.mjs（headless Chrome 里跑引擎、
 * 离线渲成 wav）。它硬编码 http://127.0.0.1:8792/dev/qin.html，所以要保证
 * dev/serve.mjs 在 8792 上活着——这里顺手探活并在需要时拉起来。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 宿主依赖「软失败」：这个包可能装进不同版本的壳（0.1.x / 0.2.x）。
// 三个宿主包如果解析不到、或版本不兼容，宁可让本插件降级，也**不能抛在模块顶层**——
// 顶层 import 失败会拖死整棵插件树，连宿主自己都起不来（README 警告过的那种）。
async function softImport(name, pick) {
  try {
    const m = await import(name)
    return pick(m) || null
  } catch {
    return null
  }
}

const schemastery = await softImport('@deepseek-ai/schemastery', (m) => m.default)
const toolsMod = await softImport('@deepseek-ai/dsh-tools', (m) => m)
const llmMod = await softImport('@deepseek-ai/dsh-llm', (m) => m)

const defineTool = toolsMod && typeof toolsMod.defineTool === 'function'
  ? toolsMod.defineTool
  : (d) => d
const createUserMessage = llmMod && typeof llmMod.createUserMessage === 'function'
  ? llmMod.createUserMessage
  : (x) => x
// 回炉时要把模型自己写的那份谱面作为 assistant 消息塞回对话，用好让模型「就着改」。
// 手搓对象不行：适配器会去读 msg.source.kind，缺了就是一个
// 「Cannot read properties of undefined (reading 'kind')」，还会被包成
// 「内联编曲失败（error）」—— 看着像模型出错，其实是消息形状不对。
const createAssistantMessage = llmMod && typeof llmMod.createAssistantMessage === 'function'
  ? llmMod.createAssistantMessage
  : (x) => ({ ...x, role: 'assistant', source: x?.source ?? { kind: 'assistant' } })

// 最小 schema 兜底：只支持本文件用到的那几个链式调用（string/number/boolean + default）。
// 宿主 schema 引擎在时用自己的，不在时也不会因为 Config 是 undefined 而崩。
const z = schemastery || {
  string: () => ({ default: (v) => v }),
  number: () => ({ default: (v) => v }),
  boolean: () => ({ default: (v) => v }),
  object: (o) => o,
}
import { hardErrors } from './quality.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(HERE, 'assets')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA = path.join(DSH_HOME, 'guzheng-pond')
const AUDIO_DIR = path.join(DATA, 'audio')
const SCORE_DIR = path.join(DATA, 'scores')
const QUEUE_FILE = path.join(DATA, 'queue.json')

/** 项目根：谱面引擎、渲染脚本、知识手册都在这。默认取包内自带的 renderer/。 */
const DEFAULT_PROJECT = path.join(HERE, 'renderer')
const SERVE_PORT = 8792
const RENDER_TIMEOUT_MS = 240000

export const name = 'guzheng-pond'
// agents 是派子会话的硬依赖：声明进 inject，插件会等它就位再启动。
// llm 只在「没有 agents」的内联兜底里用，用 ctx.get() 按需取，不占 required 名额。
export const inject = ['webServer', 'tools', 'agents']

export const Config = z.object({
  projectDir: z.string().default(DEFAULT_PROJECT),
  // 留空 = 自动探测（真 node，绝不能是 electron）
  nodeExe: z.string().default(''),
  servePort: z.number().default(SERVE_PORT),
  maxQueue: z.number().default(24),
})

// ── 小工具 ────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')
const stamp = () => {
  const d = new Date()
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

async function readBody(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 读到一条活的 URL 就算活着。 */
function probe(url, timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// ── 队列 ──────────────────────────────────────────────────────────────────

function makeStore(cfg) {
  /** @type {{ id: string, title: string, url: string, dur: number, at: string, score?: string }[]} */
  let queue = []
  let loaded = false
  // 主动删掉的 id。写盘前要把盘上的并回来，删掉的那些不能被「并」活过来。
  const tombstones = new Set()

  const load = () => {
    if (loaded) return queue
    loaded = true
    try {
      const raw = fs.readFileSync(QUEUE_FILE, 'utf8')
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) queue = arr.filter((t) => t && typeof t.id === 'string')
    } catch { /* 首次运行没有文件，正常 */ }
    return queue
  }

  const readDisk = () => {
    try {
      const arr = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
      return Array.isArray(arr) ? arr.filter((t) => t && typeof t.id === 'string') : []
    } catch {
      return []
    }
  }

  /**
   * 写盘。**不能拿内存整个覆写**。
   *
   * 本机常常同时开着三个 DSH 实例（3080 / 3098 / 3099 各一个页签），它们共用
   * 这一个 queue.json，各自持一份内存副本。原来这里直接覆写 = 谁最后写谁赢，
   * 另外两个实例刚编好的曲子下一拍就被抹掉；用户读作「队列凭空少了几首」，
   * 再往下就是「我要它放，半天不放；过一会自己又放起来」。
   *
   * 所以先跟盘上并一次：我们这边的顺序优先，盘上多出来的接在后面，主动删掉
   * 的（tombstones）不并回来。
   */
  const save = () => {
    try {
      fs.mkdirSync(DATA, { recursive: true })
      const seen = new Set(queue.map((t) => t.id))
      for (const t of readDisk()) {
        if (seen.has(t.id) || tombstones.has(t.id)) continue
        queue.push(t)
        seen.add(t.id)
      }
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8')
    } catch (e) {
      console.warn('[guzheng-pond] 队列写盘失败', e?.message || e)
    }
  }

  return {
    list() {
      load()
      // 文件被清掉/搬走的条目不要留在队列里，否则水汪会等一首永远播不了的曲子
      queue = queue.filter((t) => {
        const file = path.join(AUDIO_DIR, `${t.id}.wav`)
        return fs.existsSync(file)
      })
      return queue
    },
    push(track) {
      load()
      queue.push(track)
      tombstones.delete(track.id)
      const max = cfg().maxQueue ?? 24
      while (queue.length > max) {
        const drop = queue.shift()
        // 只有「队列满了被挤出去」才真删文件。别的删除都只是移出队伍。
        tombstones.add(drop.id)
        try { fs.unlinkSync(path.join(AUDIO_DIR, `${drop.id}.wav`)) } catch { /* ignore */ }
      }
      save()
      return track
    },
    /**
     * 这首放过一遍。
     *
     * 默认**转到队尾**，不是删掉 —— 这一汪水是「一直放着的背景」，一首放完
     * 就消失等于听两遍就没了；而且它在只放了一首的时候会把队列放空，水就
     * 静在那儿不动。真要移除传 { drop: true }。
     */
    played(id, opts) {
      load()
      const i = queue.findIndex((t) => t.id === id)
      if (i >= 0) {
        const [t] = queue.splice(i, 1)
        if (opts && opts.drop) tombstones.add(t.id)
        else queue.push(t)
      }
      save()
      return queue.length
    },
    clear() {
      load()
      for (const t of queue) tombstones.add(t.id)
      for (const t of readDisk()) tombstones.add(t.id)
      queue = []
      save()
    },
  }
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [DATA, AUDIO_DIR, SCORE_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
  }
}

/** dev/serve.mjs 不在就拉起来（render-qin.mjs 硬编码了 8792）。传已解析的配置对象。 */
async function ensureServe(conf) {
  const project = conf.projectDir || DEFAULT_PROJECT
  const port = conf.servePort ?? SERVE_PORT
  if (await probe(`http://127.0.0.1:${port}/dev/qin.html`)) return true
  const serve = path.join(project, 'dev', 'serve.mjs')
  if (!fs.existsSync(serve)) return false
  const nodeExe = nodeBin(conf)
  const child = spawn(nodeExe, ['dev/serve.mjs', project, String(port)], {
    cwd: project,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => { /* 下面靠探活兜底 */ })
  child.unref()
  for (let i = 0; i < 30; i++) {
    if (await probe(`http://127.0.0.1:${port}/dev/qin.html`)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/**
 * 找一个真的 node。
 *
 * 不能兜底到 process.execPath：DSH 是 Electron 应用，process.execPath 指向
 * 的是 DSH 自己的 exe，拿它跑 dev/render-qin.mjs 不会报错，只会把客户端再
 * 拉起来一次——渲染永远等不到结果，还很难看出原因。宁可在这里明确报错。
 */
function nodeBin(conf) {
  const cands = [
    conf && conf.nodeExe,
    process.env.GUZHENG_POND_NODE,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/nodejs/node.exe'),
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c
  }
  // 最后兜底：PATH 里的 node。仍是「真 node」——不是 electron 的 execPath。
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = spawnSync(finder, ['node'], { encoding: 'utf8', windowsHide: true })
    const hit = (out.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s))
    if (hit) return hit
  } catch { /* 落到下面报错 */ }
  throw new Error(
    '找不到 node 可执行文件。请在插件配置里设 nodeExe（现在是 ' +
    JSON.stringify(conf && conf.nodeExe) + '），或设环境变量 GUZHENG_POND_NODE。',
  )
}

/** 谱面文本 → wav 文件；返回 { file, dur } 或抛错。传已解析的配置对象。 */
async function renderScore(conf, text, id) {
  const project = conf.projectDir || DEFAULT_PROJECT
  const nodeExe = nodeBin(conf)

  if (!(await ensureServe(conf))) {
    throw new Error(`渲染前置服务没起来：${project}\\dev\\serve.mjs 未能在 ${conf.servePort} 上响应`)
  }

  const scoreRel = `score-pond-${id}.js`
  const scoreAbs = path.join(project, 'dev', scoreRel)
  const body = 'export const TEXT = ' + JSON.stringify(text) + ';\nexport default TEXT;\n'
  await fsp.writeFile(scoreAbs, body, 'utf8')

  const renderer = path.join(project, 'dev', 'render-qin.mjs')
  if (!fs.existsSync(renderer)) throw new Error(`找不到渲染脚本：${renderer}`)

  const log = await new Promise((resolve, reject) => {
    const p = spawn(nodeExe, ['dev/render-qin.mjs', scoreRel, id], { cwd: project, windowsHide: true })
    let out = ''
    const timer = setTimeout(() => {
      try { p.kill() } catch { /* ignore */ }
      reject(new Error(`渲染超时（${RENDER_TIMEOUT_MS / 1000}s）`))
    }, RENDER_TIMEOUT_MS)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`渲染失败（exit ${code}）：${out.slice(-400)}`))
    })
  })

  const produced = path.join(project, 'out', id)
  if (!fs.existsSync(produced)) throw new Error('渲染没有产出文件：' + produced)

  const target = path.join(AUDIO_DIR, `${id}.wav`)
  await fsp.rename(produced, target)
  try { await fsp.unlink(scoreAbs) } catch { /* ignore */ }

  // 时长从 wav 头算，别信日志里的数字
  let dur = 0
  try {
    const buf = await fsp.readFile(target)
    const ch = buf.readUInt16LE(22)
    const sr = buf.readUInt32LE(24)
    if (ch > 0 && sr > 0) dur = (buf.length - 44) / (ch * 2) / sr
  } catch { /* ignore */ }

  const verdict = (log.match(/【自查报告[^】]*】[\s\S]*?(?=\n\n|$)/) || [])[0] || ''
  const tech = (log.match(/技法（全部来自谱面）:\s*(.+)/) || [])[1] || ''
  // 渲染器会打印「《标题》 N 句 M 音」。单独抓出来：M=0 是「整份谱没被读懂」的
  // 唯一可靠信号，光看 wav 时长看不出来（0 音也有结尾留白，能凑出几秒静音）。
  const cnt = log.match(/》\s*(\d+)\s*句\s*(\d+)\s*音/)
  return {
    file: target,
    dur,
    log: log.trim().slice(-800),
    verdict: verdict.trim(),
    tech: tech.trim(),
    phrases: cnt ? Number(cnt[1]) : null,
    notes: cnt ? Number(cnt[2]) : null,
  }
}

// ── 知识 ──────────────────────────────────────────────────────────────────

/** 手册正文。传的是已经解析好的配置对象，不是 cfg 函数——三处调用都写 readKnowledge(cfg())。 */
function readKnowledge(conf) {
  const project = (conf && conf.projectDir) || DEFAULT_PROJECT
  const core = path.join(project, 'tray', 'knowledge', 'CORE.md')
  try {
    return fs.readFileSync(core, 'utf8')
  } catch {
    return ''
  }
}

// ── 插件 ──────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  // cordis 会把 schema 归一后的 config 作为第二个参数递进来，但不保证一定有
  // ——手工按 insert 挂载时如果 patch 里漏了 config 块，这里就是 undefined。
  // 与其让后面每个 `cfg().xxx` 抛 TypeError（表现成路由裸 400，什么线索都没有），
  // 不如在入口处就把默认值补齐：Schema 的 default 在这儿再写一遍。
  const conf = {
    projectDir: DEFAULT_PROJECT,
    nodeExe: '',
    servePort: SERVE_PORT,
    maxQueue: 24,
    ...(config && typeof config === 'object' ? config : {}),
  }
  const cfg = () => conf
  const store = makeStore(() => cfg())

  ensureDirs()

  // 前置服务在启动时就探活 / 拉起。8792 上那台 serve 只在第一次渲染时才会
  // 被想到，而探活最多要等 30×250ms=7.5 秒 —— 那笔钱不该算在第一首曲子上。
  // 拿不到就算了：真正的渲染还会再探一次。
  void ensureServe(cfg()).catch(() => {})

  // ── 常驻作曲子会话池（SPEC v0.3 §4）──────────────────────────────────────
  // 原来的做法是每点一次按钮就 agents.create 一个新子会话：冷启动、重发 5 条
  // 规矩、重读 12.6KB 手册全都要再付一遍。用户说的「AI 编曲速度太慢」里，
  // 相当一部分是这笔重复开销，不是作曲本身。
  const POOL_IDLE_MS = 15 * 60 * 1000   // 空闲超过 15 分钟：先探活，探不到就换新
  const POOL_TURN_BUDGET = 8            // 单会话最多接 8 首（SPEC §4.6）
  const CTX_WINDOW_EST = 128000         // 估不到真实窗口，按最常见的 128k 算
  const CTX_MAX_RATIO = 0.6             // 占用到 60% 就换新的
  /** parentKey → { childId, createdAt, turns, chars, tokensEstimate, lastUsed } */
  const composerPool = new Map()

  const agentsOf = () => ctx.get('agents')
  const pickModel = () => {
    try {
      const sel = ctx.get('agentDefaultModel')
      const cur = sel?.currentSelection?.()
      if (cur?.provider && cur?.model) return { provider: cur.provider, model: cur.model }
    } catch { /* optional */ }
    return { provider: 'deepseek', model: 'deepseek-chat' }
  }

  /** 谱面文本收尾：去掉围栏、掐头去尾空白。 */
  function cleanScore(text) {
    let s = String(text || '').trim()
    const fence = s.match(/```(?:qin|text)?\s*\n([\s\S]*?)```/)
    if (fence) s = fence[1].trim()
    return s
  }

  /** 谱面 → 渲染 → 入队。两条路（子会话 / 内联）都从这里落地。 */
  async function submitScore(title, text) {
    const id = `pond-${stamp()}-${Math.floor(Math.random() * 900 + 100)}`
    const score = cleanScore(text)
    if (!score) throw new Error('谱面是空的')
    if (!/@from/.test(score) || !/@to/.test(score)) {
      throw new Error('谱面缺 @from / @to（琴语言要求声明起落，否则渲染会报「没有声明出口」）')
    }
    // 渲染前先做最廉价的格式体检：一句 `|` 都没有 = 这份谱是空的。
    // 解析器只认 `|` 开头的行，别的行静默跳过——不先拦，就要白跑一次渲染，
    // 而且渲染出来的「静音 wav」还会被当成正常曲子入队。
    const phraseLines = score.split(/\r?\n/).filter((l) => l.trim().startsWith('|')).length
    if (phraseLines === 0) {
      throw new Error(
        '这份谱一句都没写对：没有任何一行以 | 开头，等于 0 音。' +
        '琴语言是「一行一句、行首写 |」，例如 "| 2/800 3/800 5/1400 ,900"。' +
        '@from / @to / #标题 这类指令行不带 |，其余每一句都要带。改完再交。'
      )
    }
    await fsp.mkdir(SCORE_DIR, { recursive: true })
    await fsp.writeFile(path.join(SCORE_DIR, `${id}.qin`), score, 'utf8')

    const r = await renderScore(cfg(), score, id)

    // 0 音 = 整份谱没被读懂。必须拦下来：这种「曲子」也能渲染成几秒静音，
    // 一旦入队，用户听到的就是坏掉的水汪，而工具却报成功。
    if (r.notes === 0) {
      try { await fsp.unlink(r.file) } catch { /* ignore */ }
      const noBar = score.split(/\r?\n/).filter((l) => {
        const t = l.trim()
        return t && !t.startsWith('|') && !t.startsWith('@') && !t.startsWith('#')
      }).length
      throw new Error(
        '这份谱一个音都没解析出来（0 句 0 音），渲染只出了静音，已丢弃。' +
        (noBar > 0
          ? `原因基本可以确定：有 ${noBar} 行谱面没以 | 开头——琴语言只认 | 开头的行，其余行会被静默跳过。`
          : '检查每句是否都以 | 开头，以及音名是否都在 1 2 3 5 6 之内。') +
        '改法：一句一行、行首写 |，例如 "| 2/800 3/800 5/1400 ,900"。改完再调一次 pond_play。'
      )
    }

    const track = {
      id,
      title: String(title || '').trim() || '无题',
      url: `/api/pond/audio/${id}.wav`,
      dur: Number(r.dur.toFixed(2)),
      at: new Date().toISOString(),
      score,
      verdict: r.verdict || '',
      tech: r.tech || '',
    }

    // 质量门：硬错不许进队列。
    // 依据 2026-10-26 定的两档规矩——只拦硬错（没落/缺出口/留白超/连续同落音/
    // 都节外音/解析失败），口味建议一律放行。宁可让子会话重写一次，也不要让
    // 用户听到一首「一句都没落住」的曲子。
    const hard = hardErrors(r.verdict)
    if (hard.length) {
      try { await fsp.unlink(r.file) } catch { /* ignore */ }
      throw new Error(
        `这首没过质量门（硬错 ${hard.length} 处），已丢弃不入队：\n` +
        hard.map((h) => `  · ${h.line}（${h.why}）`).join('\n') +
        '\n改法：每句末音要落在 1 或 2，或者在这一行末尾写 ? 表示故意悬着。改完再调一次 pond_play。'
      )
    }

    store.push(track)
    // phrases/notes 一起回去。原来只回 track/queue/log，调用方（子会话、
    // 按钮）根本看不见「几句几音」—— 上一轮排查时就被这个坑住，误判成
    // 「0 音防线是死代码」。渲染器本来就算了，白扔。
    return { track, queue: store.list().length, log: r.log, phrases: r.phrases, notes: r.notes }
  }

  // ── 工具 1：知识 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'pond_knowledge',
    description:
      '读古筝作曲的手册（琴语言语法 + 作曲法则）。要编曲之前先调这个：它返回这个工具唯一的那份知识，' +
      '包括五声音阶的实际音高、余音 3.06 秒这个物理事实、五行配额、旋律四律、摇指/按音/吟猱的写法、以及 @from/@to 必填这类硬规矩。' +
      '返回的是 Markdown 全文，读完直接照着写谱面，然后用 pond_play 提交。',
    parameters: {
      section: {
        type: 'string',
        description: '可选。只看某一节，比如 "五行" 或 "摇指"。不填返回全文。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chars: { type: 'integer' },
          content: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.content }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const all = readKnowledge(cfg())
      if (!all) throw new Error('读不到知识手册：项目里 tray/knowledge/CORE.md 不见了')
      const want = String(args?.section || '').trim()
      if (!want) return { chars: all.length, content: all }
      const lines = all.split('\n')
      const start = lines.findIndex((l) => l.includes(want))
      if (start < 0) return { chars: all.length, content: all }
      const level = (lines[start].match(/^#+/) || ['##'])[0].length
      let end = lines.length
      for (let i = start + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#+)\s/)
        if (m && m[1].length <= level) { end = i; break }
      }
      const slice = lines.slice(start, end).join('\n')
      return { chars: slice.length, content: slice }
    },
    presentCall: (args) => ({ card: 'generic', title: '读作曲手册', kind: 'other', rawInput: args }),
  }))

  // ── 工具 2：提交 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'pond_play',
    description:
      '把一首写好的琴语言谱面交上去：渲染成音频、排进队列，角落那一汪水会按顺序播放它。' +
      '谱面必须带 @from 和 @to（第一句写"起"、最后一句写"落"）。' +
      '渲染大约几秒到几十秒，返回里带时长和谱面自查报告。一次只提交一首；要改就重新写一份再交。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: '这一首的名字，会显在队列里。别写"未命名"，写它是什么：比如「秋·树上的橘子还剩三个」。',
      },
      score: {
        type: 'string',
        required: true,
        description: '琴语言谱面全文（Markdown 代码块或裸文本都行）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          dur: { type: 'number' },
          queue: { type: 'integer' },
          verdict: { type: 'string' },
          // 渲染器本来就会数出「几句几音」，回给子会话看。0 音说明谱面的行
          // 全被静默跳过了（最常见的原因是行首没写 |），它自己就能发现并重交，
          // 不用等人从水汪那边看出「怎么一直是静的」。
          phrases: { type: 'integer' },
          notes: { type: 'integer' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: `已入队：《${v.title}》 ${v.dur}s · ${v.phrases ?? '?'} 句 ${v.notes ?? '?'} 音` +
          `（队列第 ${v.queue} 首）` +
          (v.notes === 0 ? '\n⚠ 这首一个音都没有，多半是行首漏了 |，重交一份。' : '') +
          (v.verdict ? `\n${v.verdict}` : ''),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const { track, queue, phrases, notes } = await submitScore(args?.title, args?.score)
      return {
        id: track.id,
        title: track.title,
        dur: track.dur,
        queue,
        verdict: track.verdict,
        phrases,
        notes,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '提交一首曲子', kind: 'other', rawInput: args }),
  }))

  // ── 派子会话 ────────────────────────────────────────────────────────────
  /**
   * 真子会话：agents.create 建一个子 agent，把「编一曲」这句话作为它的第一条
   * 用户消息。它在自己的对话里读 pond_knowledge、写谱面、调 pond_play，
   * 主对话一个字都不会多。
   *
   * 子会话建失败（factory 没注册之类）时退回内联：主进程直接跑一次模型调用
   * 来编曲。两条路最后都进 submitScore，水汪那边看不出区别——区别只在
   * 「有没有多出一个能点开的子会话」。
   */
  /**
   * 从池里取一条还在的作曲会话。返回 { entry, agent } 或 null。
   *
   * 一条都不该「猜」：任何一项判据不成立就当场把它踢出池，绝不留着半死的
   * 条目等下一次悄悄失败 —— 用户看到的会是「点了没反应」，而日志里什么都没有。
   */
  function poolTake(agents, key) {
    const e = composerPool.get(key)
    if (!e) return null
    const drop = (why) => {
      composerPool.delete(key)
      ctx.logger?.info?.(`[guzheng-pond] 池里那条不用了（${why}），换新的`)
      return null
    }
    if (Date.now() - e.lastUsed > POOL_IDLE_MS) return drop('空闲超 15 分钟')
    if (e.turns >= POOL_TURN_BUDGET) return drop(`已接 ${e.turns} 首，到预算`)
    if (e.tokensEstimate >= CTX_WINDOW_EST * CTX_MAX_RATIO) {
      return drop(`估上下文 ${e.tokensEstimate} tok，过 60%`)
    }
    // 会话可能已经被宿主收掉（父会话关了 / 用户手动结束）。拿不到就当没有。
    // agents.get 在不同宿主版本里可能返回 agent 也可能返回 handle —— 只认
    // 「能 followup 的那个」，认不出来就当池里没有，绝不猜着用。
    let agent = null
    try {
      const got = agents.get(e.childId)
      agent = got && typeof got.followup === 'function' ? got : (got?.agent ?? null)
    } catch { /* 下面按没有处理 */ }
    if (!agent || typeof agent.followup !== 'function') return drop('会话已经不在了')
    return { entry: e, agent }
  }

  async function spawnComposer(parentSessionId, idea) {
    const text = String(idea || '').trim()
    const label = `池 · ${text ? text.slice(0, 24) : '编一曲'}`
    const agents = agentsOf()

    let subErr
    if (agents && typeof agents.create === 'function') {
      try {
        // 父 agent：sessionId 就是共享 id，直接命中。页面上没有活跃 agent
        // （刷新后停在旧会话 / 会话已收）时退回最近的根 agent——只为继承
        // cwd 与模型路由，聊天记录不会带过去。
        let parent = typeof agents.get === 'function' ? agents.get(parentSessionId) : undefined
        if (!parent && typeof agents.roots === 'function') {
          const roots = agents.roots()
          parent = roots[roots.length - 1]
        }
        if (!parent) throw new Error('找不到父会话（当前没有活跃 agent）')

        // ── 池：能复用就绝不新建（SPEC §4.2）────────────────────────────
        // 判据全部满足才复用：同一个父会话、上次用完 < 15 分钟、轮次没超预算、
        // 估的上下文没到 60%、agents.get 还能拿到这条子会话（会话没收）。
        const key = String(parent.id || parentSessionId || 'root')
        const hit = poolTake(agents, key)
        if (hit) {
          // 只发增量（SPEC §4.4）：手册永远走 pond_knowledge 工具，不塞 prompt；
          // 规矩只在第一次说过，不再重发。
          const delta = text
            ? `再来一首。意思：${text}`
            : '再来一首，跟上一首同一个路子。'
          hit.agent.followup(createUserMessage({
            content: [{ type: 'text', text: delta }],
            source: { kind: 'user' },
          }))
          const e = hit.entry
          e.turns += 1
          e.lastUsed = Date.now()
          e.chars += delta.length
          e.tokensEstimate = Math.round(e.chars / 2.2)
          ctx.logger?.info?.(
            `[guzheng-pond] 复用作曲子会话 ${e.childId}（第 ${e.turns}/${POOL_TURN_BUDGET} 首，` +
            `估 ${e.tokensEstimate} tok）`,
          )
          return { via: 'subagent-reuse', childId: e.childId, label }
        }

        const header = parent.session?.header ?? {}
        const depth = (header.delegationDepth ?? parent.options?.subagentDepth ?? 0) + 1

        // 组合按父会话「当前实际生效」的那套复制（工具 / 提示段 / 技能目录），
        // 比 resolve(部署默认预设) 准：父会话中途切过预设也跟得上。
        // meta 里记下预设 id，供以后冷读这条子会话时重建。
        let presetId
        try { presetId = ctx.get('agentPresets')?.composedPreset?.(parent.ctx)?.id } catch { /* 没预设 */ }

        const childId = `session-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
        const handle = await agents.create({
          sessionId: childId,
          parentAgent: parent, // 运行时归属：父 agent 收掉时子会话一起收，不会漏成野会话
          meta: {
            ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
            ...(presetId === undefined ? {} : { agentPreset: presetId }),
            parentSession: parent.id,
            isSeeded: false, // 不继承父会话历史，子会话从零开始
            origin: 'subagent',
            delegationDepth: depth,
          },
          agentOptions: { ...(parent.options ?? {}), subagentDepth: depth },
          // 这里刻意不给 signal：createAgent 会把 caller 的 signal 直接绑到 agent
          // 生命周期上（onCallerAbort → abort.abort）。给个 60s 超时，等于 60 秒后
          // 把一首还没编完的子会话当场掐死。
          setup: (childCtx) => {
            try { childCtx.get('agentPresets')?.composeFrom?.(childCtx, parent.ctx) } catch { /* 空组合也能跑 */ }
          },
        })

        try {
          ctx.get('sessionTitle')?.rename(handle.agent.session, label)
        } catch { /* 标题服务不一定在，不影响编曲 */ }

        const prompt = [
          '这是一个专门编古筝曲的子会话。你只做一件事：写一首琴语言谱面，交给 pond_play。',
          '',
          '1. 先调 pond_knowledge 读手册（全文），再动笔。别凭印象写。',
          '2. 按用户这句话的意思编：' + (text || '一首安静的、能一直放着不抢注意力的曲子'),
          '3. 写成琴语言：每句一行、**行首必须有 |**（不带 | 的行会被静默跳过，整份谱变 0 音）；',
          '   @from / @to 必填，五声音阶，低音少而长，摇指全曲 2-4 处。',
          '   **每句末音落在 1 或 2**（落不住就在这一行末尾写 ?，全曲最多三处）；',
          '   这一条不过会被质量门直接打回，是返工最多的原因。',
          '4. 调 pond_play 提交（title 写它是什么，别写「未命名」）。',
          '5. 被渲染器报了硬错（缺出口之类），照着错误改谱面再交一次，最多三次。',
          '',
          '不要问问题，不要解释过程，不要贴长篇分析。写完、交上去、说一句这是什么就结束。',
        ].join('\n')

        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))

        // 入池。chars 从「实际会进它上下文的那些」起算：这份 prompt + 手册全文
        // （它会调 pond_knowledge 读）+ 谱面和回复的粗估。估得偏保守没关系 ——
        // 偏保守只会早一点换新会话，不会把一次编曲估成失败的。
        composerPool.set(key, {
          childId,
          createdAt: Date.now(),
          turns: 1,
          chars: prompt.length + readKnowledge(cfg()).length + 3000,
          tokensEstimate: Math.round((prompt.length + readKnowledge(cfg()).length + 3000) / 2.2),
          lastUsed: Date.now(),
        })
        ctx.logger?.info?.(`[guzheng-pond] 新建作曲会话 ${childId}（池 ${composerPool.size} 条）`)

        return { via: 'subagent', childId, label }
      } catch (e) {
        // 子会话这条路塌了也别让按钮空转，下面用内联兜住
        subErr = e
        ctx.logger?.warn?.(`[guzheng-pond] 派子会话失败，改走内联：${e?.message || e}`)
      }
    } else {
      subErr = new Error('agents 服务不可用')
    }

    // 内联兜底：主进程自己跑一轮模型调用。llm 不在 inject 里，用 get() 按需取。
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error(
        `派不出子会话（${subErr?.message || subErr || '未知原因'}），也没有 llm 服务可以兜底`
      )
    }
    const brief = readKnowledge(cfg())
    const model = pickModel()
    const ask = text || '安静的、能一直放着不抢注意力的曲子'
    const messages = [{
      id: 'pond-' + Date.now(),
      role: 'user',
      content: [{
        type: 'text',
        text: `编一首古筝曲，意思：${ask}\n\n` +
          '四到六句就够，每句一行、行首必须是 | 。' +
          '每句末音落在 1 或 2（落不住就在这一行末尾写 ?，最多三处）。' +
          '只输出琴语言谱面本身（带 @from / @to），不要解释。',
      }],
      source: { kind: 'user' },
    }]

    // 最多三轮：写 → 交 → 被质量门打回 → 照着错误改 → 再交。
    // 子会话那边一直有「照着错误改，最多三次」的余地，内联这条以前只交一次，
    // 一旦质量门拒了，整次编曲就变成一个错误弹窗 —— 用户读作「点了没反应」。
    // 两条路都进 submitScore，就不该只有一条会重试。
    let lastErr
    for (let attempt = 1; attempt <= 3; attempt++) {
      let out = ''
      let stop
      for await (const chunk of llm.stream({
        provider: model.provider,
        model: model.model,
        system: `你是古筝作曲者。严格按下面这份手册写谱面，只输出谱面，不解释。\n\n${brief}`,
        messages,
        temperature: 0.8,
        // 2200 不够：一首六句的谱面连注释就能把它顶爆，模型在句中间被截断，
        // 现场表现是「内联编曲失败（max-tokens）」，人只会读成「点了没反应」。
        maxTokens: 3600,
      })) {
        if (chunk.type === 'text-delta') out += chunk.text
        // 适配器异常不会抛，而是变成一个终止性 finish 分片。不接住的话，
        // 失败会伪装成「谱面是空的」，排查时完全看不出真因。
        else if (chunk.type === 'finish') stop = chunk.reason
      }
      // 只要有音符行，就先交给质量门 —— 让质量门去说具体哪句不对，比在这里
      // 用正则猜「像不像谱面」准得多，而且它给的错误能原样回炉再改。
      // 被截断也不等于白干：截断点几乎总在末句，前面几句是完整的。
      const hasNotes = /^\s*\|/m.test(out)
      if (stop && stop.kind !== 'stop' && !(stop.kind === 'max-tokens' && hasNotes)) {
        // 连音符行都没有，再问一遍也是白问，直接抛。把长度和尾巴带上：
        // 否则现场只有一句「模型没有返回原因」，谁也看不出是截断、拒答，
        // 还是干脆回了一段散文。
        throw new Error(
          `内联编曲失败（${stop.kind}）：${stop.failure?.message || stop.failure?.code || '模型没有返回原因'}` +
          `；输出 ${out.length} 字，尾部：${JSON.stringify(out.slice(-160))}`
        )
      }
      if (!hasNotes) {
        lastErr = new Error('内联编曲失败：模型没写出可用的谱面（缺行首 | 的音符行）')
        ctx.logger?.warn?.(`[guzheng-pond] 内联第 ${attempt} 轮没写出可用谱面`)
        // 回炉：把 ROI 说清楚，别让它再自由发挥一遍。
        messages.push(createAssistantMessage({
          content: [{ type: 'text', text: out }],
          source: { kind: 'assistant' },
        }))
        messages.push(createUserMessage({
          content: [{
            type: 'text',
            text: '不对：每一句必须是单独一行、行首是 | 的音符行。重写，只输出谱面本体。',
          }],
          source: { kind: 'user' },
        }))
        continue
      }
      try {
        const { track } = await submitScore(label, out)
        return { via: 'inline', childId: null, label, track }
      } catch (e) {
        lastErr = e
        // 质量门拒了：把它给的那几条「第几句没落」原样回给模型，让它就着改。
        // 这比重新写一首省得多 —— 谱面骨架通常是对的，只是落点/出口不合规。
        ctx.logger?.info?.(`[guzheng-pond] 内联第 ${attempt} 轮没过质量门，回炉`)
        messages.push(createAssistantMessage({
          content: [{ type: 'text', text: out }],
          source: { kind: 'assistant' },
        }))
        messages.push(createUserMessage({
          content: [{
            type: 'text',
            text: `这份没过质量门：\n${String(e?.message || e).slice(0, 600)}\n\n` +
              '照着上面这几条改，只输出改好的整份谱面，不要解释。',
          }],
          source: { kind: 'user' },
        }))
      }
    }
    throw lastErr || new Error('内联编曲失败：三轮都没交出可用的谱面')
  }

  // ── 路由 ────────────────────────────────────────────────────────────────

  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[guzheng-pond] webServer 不可用，水汪没地方挂')
    return
  }

  const stateRoute = webServer.register({
    kind: 'exact',
    path: '/api/pond/state',
    handler: (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
      try {
        const list = store.list()
        json(res, 200, {
          queue: list,
          project: cfg().projectDir,
          knowledge: readKnowledge(cfg()).length > 0,
        })
      } catch (e) {
        // 宿主分发出的裸 400 会吞掉堆栈，客户端只看得到「没响应」。这里把原因写出来。
        json(res, 500, { error: String(e?.stack || e?.message || e) })
      }
    },
  })
  ctx.effect(() => stateRoute)

  const submitRoute = webServer.register({
    kind: 'exact',
    path: '/api/pond/submit',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      try {
        const payload = JSON.parse((await readBody(req)) || '{}')
        // phrases / notes 一起透传出去。submitScore 已经算过了，这里再解构掉
        // 就等于又把「几句几音」扔了一次 —— 调用方（子会话、按钮）拿不到这个数，
        // 就分不清「渲染成功但谱面很空」和「谱面正常」，只能靠猜。
        const { track, queue, log, phrases, notes } = await submitScore(payload.title, payload.score)
        json(res, 200, { ok: true, track, queue, log, phrases, notes })
      } catch (e) {
        json(res, 400, { error: String(e?.message || e) })
      }
    },
  })
  ctx.effect(() => submitRoute)

  const taskRoute = webServer.register({
    kind: 'exact',
    path: '/api/pond/task',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      try {
        const payload = JSON.parse((await readBody(req)) || '{}')
        const result = await spawnComposer(String(payload.sessionId || ''), payload.idea)
        json(res, 200, { ok: true, ...result })
      } catch (e) {
        json(res, 500, { error: String(e?.message || e) })
      }
    },
  })
  ctx.effect(() => taskRoute)

  const queueRoute = webServer.register({
    kind: 'exact',
    path: '/api/pond/queue',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      try {
        const payload = JSON.parse((await readBody(req)) || '{}')
        if (payload.op === 'played') {
          // 默认转到队尾（这首还能再听）；要真移除得显式说 drop。
          return json(res, 200, { ok: true, left: store.played(payload.id, { drop: !!payload.drop }) })
        }
        if (payload.op === 'clear') { store.clear(); return json(res, 200, { ok: true, left: 0 }) }
        json(res, 400, { error: 'unknown op' })
      } catch (e) {
        json(res, 400, { error: String(e?.message || e) })
      }
    },
  })
  ctx.effect(() => queueRoute)

  const audioRoute = webServer.register({
    kind: 'prefix',
    path: '/api/pond/audio',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
      // prefix 路由拿到的 req.url 是带前缀的完整路径，用 pathname 而不是字符串裁剪
      const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
      const m0 = /^\/api\/pond\/audio\/([A-Za-z0-9._-]+\.wav)$/.exec(pathname)
      if (!m0) { res.writeHead(400); return res.end('bad name') }
      const nameOnly = m0[1]
      const file = path.join(AUDIO_DIR, nameOnly)
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
      const stat = fs.statSync(file)
      const range = req.headers.range
      const head = {
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      }
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        const start = m && m[1] ? Number(m[1]) : 0
        const end = m && m[2] ? Number(m[2]) : stat.size - 1
        res.writeHead(206, {
          ...head,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        })
        if (req.method === 'HEAD') return res.end()
        return fs.createReadStream(file, { start, end }).pipe(res)
      }
      res.writeHead(200, { ...head, 'Content-Length': stat.size })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(file).pipe(res)
    },
  })
  ctx.effect(() => audioRoute)

  const assetRoute = webServer.register({
    kind: 'prefix',
    path: '/api/pond/asset',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
      const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
      const m0 = /^\/api\/pond\/asset\/([A-Za-z0-9._-]+\.js)$/.exec(pathname)
      if (!m0) { res.writeHead(400); return res.end('bad name') }
      const file = path.join(ASSETS, m0[1])
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
      const stat = fs.statSync(file)
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(file).pipe(res)
    },
  })
  ctx.effect(() => assetRoute)

  ctx.logger?.info?.('[guzheng-pond] 已挂：/api/pond/{state,submit,task,queue,audio,asset}')
}

export default { name, inject, Config, apply }
