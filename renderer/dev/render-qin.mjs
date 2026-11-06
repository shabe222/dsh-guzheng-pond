/**
 * 谱面 → wav。
 *
 * 用法：node dev/render-qin.mjs <scoreFile> <outName>
 *
 *   scoreFile  dev/ 下的谱面模块名，例如 score-pond-abc123.js
 *   outName    产出文件名，落在 <repo>/out/<outName>
 *
 * 前置：dev/serve.mjs 必须已经在 SERVE_PORT 上活着（它把这个仓库当静态根目录）。
 *
 * 环境变量（都有默认值，装好即用）：
 *   GUZHENG_CHROME        Chrome/Edge 可执行文件路径，不设则自动探测
 *   GUZHENG_SERVE_PORT    静态服务端口，默认 8792
 *   GUZHENG_PROJECT       仓库根目录，默认本文件往上两级
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.GUZHENG_PROJECT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.env.GUZHENG_SERVE_PORT || '8792'

const [,, scoreFile, outName] = process.argv
if (!scoreFile || !outName) {
  console.error('用法: node dev/render-qin.mjs <scoreFile> <outName>')
  process.exit(2)
}

/** 找一个能用的 Chromium。playwright-core 不自带浏览器，必须借系统的。 */
function findChrome() {
  const cands = [
    process.env.GUZHENG_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  throw new Error(
    '找不到 Chrome/Edge。设 GUZHENG_CHROME 指向浏览器可执行文件，或装一个 Chrome。',
  )
}

const b = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  // 离线渲染不需要用户手势：不加这个，Web Audio 会一直停在 suspended
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const p = await b.newPage()
const ev = []
p.on('pageerror', (e) => ev.push(e.message))

try {
  await p.goto(
    `http://127.0.0.1:${PORT}/dev/qin.html?score=${encodeURIComponent(scoreFile)}`,
    { waitUntil: 'load', timeout: 30000 },
  )
  await p.waitForFunction(
    () => /OK|ERR/.test(document.getElementById('log')?.textContent || ''),
    { timeout: 200000 },
  )
  const txt = await p.evaluate(() => document.getElementById('log').textContent)
  const b64 = await p.evaluate(() => window.__wavB64)

  console.log(txt.trim())
  console.log('errs:', ev.join('|') || 'none')

  if (b64) {
    const outDir = path.join(ROOT, 'out')
    fs.mkdirSync(outDir, { recursive: true })
    const out = path.join(outDir, outName)
    fs.writeFileSync(out, Buffer.from(b64, 'base64'))
    const buf = fs.readFileSync(out)
    const ch = buf.readUInt16LE(22)
    const sr = buf.readUInt32LE(24)
    const n = (buf.length - 44) / (ch * 2)
    console.log('写出', outName, (n / sr).toFixed(2) + 's')
  } else {
    console.error('页面没有交回 wav（window.__wavB64 为空）')
    process.exitCode = 1
  }
} catch (e) {
  console.error('渲染失败:', e && e.stack || e)
  process.exitCode = 1
} finally {
  await b.close()
}
