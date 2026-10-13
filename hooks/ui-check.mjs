#!/usr/bin/env node
// ui-check.mjs — máy kiểm giao diện (AC-18). Mở app ĐANG CHẠY bằng Playwright của chính dự án, duyệt từng màn ở hai khổ (rộng 1280,
// hẹp 390), chạy luật của lib/ui-rules.mjs (mỗi màn một nút chính · nút chỉ hình · nhãn mơ hồ · hộp thoại lúc mở · nút thiếu tên).
//
//   node ui-check.mjs [--dir <dự án>] [--url <địa chỉ>] [--baseline] [--json]
//
//   Cấu hình dự án .claude/ui.json: { "start": "<lệnh mở app>", "url": "http://localhost:<cổng>", "routes": ["/", …],
//     "states": [{ "route": "/", "setup": "?empty=1", "s": "S-01" }], "whitelistIcons": ["Đóng", …] }
//   url chưa trả lời ⇒ chạy `start`, đợi tối đa 60 s, xong thì diệt CẢ CÂY tiến trình của nó. url phải ở máy này (localhost).
//   {PORT} trong "url" / "start" = biến môi trường PORT (mặc định 5173; phải là số): chạy nhiều bản sao app song song thì mỗi bản đặt PORT riêng.
//   Báo cáo: cùng một lỗi ở cả hai khổ gộp một dòng ("khổ rộng và hẹp"); nút không tên kèm "Nút nào:" (thẻ, icon, phần tử bao quanh). Hai mã S cùng route + setup ⇒ kiểm data-s từng mã.
//   Mốc docs/ui-baseline.json { base, counts: { <khoá>: <số lỗi lúc chốt> } }: có mốc ⇒ app cũ, một khoá chỉ đỏ khi số lỗi VƯỢT số đã
//   chốt; không mốc ⇒ mọi lỗi chặn đều đỏ. --baseline ghi mốc từ kết quả lần chạy này (lỗi chặn hiện có thành "cũ").
//   Playwright nạp từ node_modules CỦA DỰ ÁN (không thuộc kit).
//
// Exit: 0 đạt (hoặc đã ghi mốc) · 1 có lỗi chặn · 2 không chạy được (thiếu/sai ui.json, mốc hỏng, app không lên) · 3 thiếu Playwright/trình duyệt.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { audit, collectScript, countKeys, keyOf, overBaseline } from './lib/ui-rules.mjs'

export const CONFIG_FILE = '.claude/ui.json'
export const BASELINE_FILE = 'docs/ui-baseline.json'
export const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }]
const START_TIMEOUT_MS = 60_000
const POLL_MS = 300
const NAV_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 5_000
const TAIL_CHARS = 4000
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
// Chờ hai khung hình để React vẽ xong sau lúc tải (không sleep cố định).
const SETTLE_SCRIPT = 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))'

class Fail extends Error {
  constructor(msg, code = 2) { super(msg); this.code = code }
}

const USAGE = `ui-check.mjs — máy kiểm giao diện (mở app thật, hai khổ 1280 và 390)
  ui-check [--dir <dự án>] [--url <địa chỉ>] [--baseline] [--json]
  --url       thay "url" trong ${CONFIG_FILE} (phải là localhost) · --baseline  chốt lỗi hiện có làm mốc ${BASELINE_FILE}
  --json      ra JSON · cấu hình: ${CONFIG_FILE} { start, url, routes, states?, whitelistIcons? }
exit: 0 đạt · 1 có lỗi chặn · 2 không chạy được · 3 thiếu Playwright`

const EXAMPLE = '{ "start": "npm run dev", "url": "http://localhost:5173", "routes": ["/"] }'
const VALUE_FLAGS = new Set(['--dir', '--url'])
const BOOL_FLAGS = new Set(['--baseline', '--json', '--help', '-h'])

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (BOOL_FLAGS.has(flag)) a[flag.replace(/^-+/, '')] = true
    else if (VALUE_FLAGS.has(flag)) {
      if (i + 1 >= argv.length) throw new Fail(`${flag} cần một giá trị\n${USAGE}`)
      a[flag.slice(2)] = argv[++i]
    } else throw new Fail(`đối số không hợp lệ: ${flag}\n${USAGE}`)
  }
  return a
}

const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stripAnsi = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'), '')

// undefined = không có file; JSON hỏng ⇒ Fail (không coi là "chưa có": mốc/cấu hình hỏng không được nới luật im lặng).
function readJson(file, label) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return undefined
    throw new Fail(`Không đọc được ${label}: ${e.message}`)
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch {
    throw new Fail(`${label} sai cú pháp JSON (thiếu dấu phẩy, ngoặc hoặc nháy). Sửa lại cho đúng${label === BASELINE_FILE ? ' hoặc chạy lại ui-check --baseline' : ''}.`)
  }
}

// --- cấu hình + mốc ---------------------------------------------------------------------------------------------------------------------

function checkUrl(value, problems, where) {
  let u
  try { u = new URL(String(value)) } catch { problems.push(`${where} "${value}" không phải địa chỉ (vd http://localhost:5173)`); return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') problems.push(`${where} phải bắt đầu bằng http:// hoặc https://`)
  else if (!LOOPBACK.has(u.hostname)) problems.push(`${where} chỉ được là app chạy trên máy này (localhost, 127.0.0.1), không phải ${u.hostname}`)
  return String(value).replace(/\/+$/, '')
}

const isStr = (v) => typeof v === 'string' && v.trim() !== ''

// {PORT} trong "url" / "start" = biến môi trường PORT, không có thì 5173 (nhiều bản sao app / nhiều lần kiểm chạy song song đặt PORT khác nhau
// để khỏi đụng cổng; app của kit cũng đọc PORT, mặc định 5173). PORT phải là số: giá trị này được ghép vào lệnh "start" chạy qua shell.
export const DEFAULT_PORT = '5173'
function substPort(value, env) {
  if (typeof value !== 'string' || !value.includes('{PORT}')) return value
  const port = String(env?.PORT ?? '').trim() || DEFAULT_PORT
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Fail(`Biến môi trường PORT="${port.slice(0, 20)}" không phải số cổng (vd 5173) nên không điền được {PORT} trong ${CONFIG_FILE}. Bỏ biến PORT hoặc đặt lại.`)
  return value.replaceAll('{PORT}', port)
}

export function loadConfig(dir, urlOverride, env = process.env) {
  const raw = readJson(path.join(dir, CONFIG_FILE), CONFIG_FILE)
  if (raw === undefined) throw new Fail(`Chưa có ${CONFIG_FILE}. Tạo file này để máy kiểm biết mở app ở đâu, ví dụ:\n${EXAMPLE}`)
  const problems = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Fail(`${CONFIG_FILE} phải là một đối tượng JSON, ví dụ:\n${EXAMPLE}`)
  let url = null
  if (urlOverride !== undefined) url = checkUrl(substPort(urlOverride, env), problems, '--url')
  else if (isStr(raw.url)) url = checkUrl(substPort(raw.url, env), problems, '"url"')
  else problems.push('thiếu "url" (địa chỉ app, vd "http://localhost:5173")')
  if (raw.start !== undefined && !isStr(raw.start)) problems.push('"start" phải là lệnh mở app dạng chữ (vd "npm run dev")')
  const routes = raw.routes === undefined ? [] : raw.routes
  if (!Array.isArray(routes) || routes.some((r) => !isStr(r) || !r.startsWith('/'))) problems.push('"routes" phải là danh sách đường dẫn bắt đầu bằng "/" (vd ["/", "/don-hang"])')
  const states = raw.states === undefined ? [] : raw.states
  const badState = (s) => !s || typeof s !== 'object' || !isStr(s.route) || !s.route.startsWith('/') || !isStr(s.s) || (s.setup !== undefined && (!isStr(s.setup) || !/^[?#]/.test(s.setup)))
  if (!Array.isArray(states) || states.some(badState)) problems.push('"states" phải là danh sách { "route": "/…", "setup": "?…" hoặc "#…" (không bắt buộc), "s": "S-01" }')
  if (raw.whitelistIcons !== undefined && (!Array.isArray(raw.whitelistIcons) || raw.whitelistIcons.some((x) => typeof x !== 'string'))) problems.push('"whitelistIcons" phải là danh sách tên nút (chữ)')
  if (!problems.length && !routes.length && !states.length) problems.push('"routes" cần ít nhất một đường dẫn (vd ["/"])')
  if (problems.length) throw new Fail(`${CONFIG_FILE} chưa đúng:\n${problems.map((p) => `- ${p}`).join('\n')}`)

  // Mỗi (route + setup) duyệt một lần; state trùng đích thì gắn THÊM mã S (codes giữ mọi mã, mỗi mã được kiểm data-s riêng). s = các mã nối bằng ", " (hiện trong lời báo).
  const targets = []
  const add = (p, s, state) => {
    let t = targets.find((x) => x.label === p)
    if (!t) { t = { label: p, s: null, codes: [], state }; targets.push(t) }
    if (s && !t.codes.includes(s)) { t.codes.push(s); t.s = t.codes.join(', ') }
  }
  for (const r of routes) add(r, null, false)
  for (const s of states) add(`${s.route}${s.setup ?? ''}`, s.s, true)
  return { start: substPort(raw.start, env), url, targets, whitelistIcons: raw.whitelistIcons ?? [] }
}

function loadBaseline(dir) {
  const raw = readJson(path.join(dir, BASELINE_FILE), BASELINE_FILE)
  if (raw === undefined) return null
  const counts = raw?.counts
  const ok = counts && typeof counts === 'object' && !Array.isArray(counts) && Object.values(counts).every((n) => Number.isInteger(n) && n >= 0)
  if (!ok) throw new Fail(`${BASELINE_FILE} sai dạng (cần { "base": …, "counts": { "<khoá>": <số lỗi> } }). Chạy lại ui-check --baseline để ghi mốc mới.`)
  return counts
}

function writeBaseline(dir, counts) {
  const g = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true })
  const base = g.status === 0 && /^[0-9a-f]{7,64}$/.test(String(g.stdout).trim()) ? String(g.stdout).trim() : null
  const file = path.join(dir, BASELINE_FILE)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ base, counts }, null, 2)}\n`)
}

// --- Playwright của dự án ----------------------------------------------------------------------------------------------------------------

// `playwright` rồi `playwright-core`, cuối cùng `@playwright/test` (pnpm chỉ thấy gói khai trực tiếp). Không thấy ⇒ null.
export function loadPlaywright(dir) {
  const req = createRequire(path.join(path.resolve(dir), 'package.json'))
  for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
    let mod
    try { mod = req(name) } catch { continue } // không có gói, hoặc cài dở ⇒ thử tên khác; hết tên ⇒ báo thiếu
    const chromium = mod?.chromium ?? mod?.default?.chromium
    if (chromium) return { chromium, name }
  }
  return null
}

function installLines(dir, browserOnly) {
  const has = (f) => fs.existsSync(path.join(dir, f))
  const [add, browser] = has('pnpm-lock.yaml') ? ['pnpm add -D playwright', 'pnpm exec playwright install chromium']
    : has('yarn.lock') ? ['yarn add -D playwright', 'yarn playwright install chromium']
      : ['npm i -D playwright', 'npx playwright install chromium']
  return browserOnly ? [browser] : [add, browser]
}

// --- bật/tắt app --------------------------------------------------------------------------------------------------------------------------

async function defaultProbe(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    await res.body?.cancel()
    return true // có trả lời (kể cả 404/500) là app đã lên
  } catch {
    return false
  }
}

// Diệt cả cây: Windows taskkill /T /F (tiến trình con không tự chết theo cmd.exe); macOS/Linux kill cả nhóm (app chạy detached ⇒ làm trưởng nhóm).
function killTree(child) {
  return new Promise((resolve) => {
    const fallback = () => { try { child.kill('SIGKILL') } catch { /* tiến trình đã thoát */ } resolve() }
    try {
      if (process.platform === 'win32') {
        const root = process.env.SystemRoot || process.env.windir
        const exe = root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill'
        const k = spawn(exe, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        k.on('error', fallback)
        k.on('close', () => resolve())
      } else {
        process.kill(-child.pid, 'SIGKILL')
        resolve()
      }
    } catch {
      fallback()
    }
  })
}

function startServer(command, cwd) {
  const win = process.platform === 'win32'
  const child = spawn(command, { cwd, shell: true, detached: !win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' } })
  const srv = { child, exited: false, code: null, tail: '', unguard: null }
  const keep = (d) => { srv.tail = (srv.tail + d).slice(-TAIL_CHARS) }
  child.stdout.setEncoding('utf8').on('data', keep)
  child.stderr.setEncoding('utf8').on('data', keep)
  srv.done = new Promise((resolve) => {
    child.on('exit', (code, sig) => { srv.exited = true; srv.code = code ?? sig; resolve() })
    child.on('error', (e) => { srv.exited = true; srv.code = 'ERR'; srv.tail += `\n${e.message}`; resolve() })
  })
  srv.closed = new Promise((resolve) => child.on('close', () => resolve())) // ống stdout/stderr đã đọc hết
  // Bấm Ctrl-C / bị yêu cầu dừng giữa chừng ⇒ vẫn diệt app đã bật (SIGKILL thì không bắt được).
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => {
    const h = () => { killTree(child).finally(() => process.exit(130)) }
    process.once(sig, h)
    return [sig, h]
  })
  srv.unguard = () => handlers.forEach(([sig, h]) => process.off(sig, h))
  return srv
}

async function stopServer(srv) {
  if (!srv) return
  srv.unguard()
  await killTree(srv.child)
  await Promise.race([srv.done, sleep(5000)])
  srv.child.stdout.destroy()
  srv.child.stderr.destroy()
}

const tailText = (srv) => {
  const lines = stripAnsi(srv.tail).split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-8)
  return lines.length ? `\nDòng cuối app in ra:\n${lines.map((l) => `  ${l}`).join('\n')}` : ''
}

// Trả true nếu dùng app ĐANG chạy sẵn (không bật gì). App do ta bật gắn vào `holder` NGAY khi bật để finally của run() luôn tắt được kể cả khi chờ lỗi.
async function ensureServer(cfg, dir, io, holder) {
  const probe = io.probe ?? defaultProbe
  if (await probe(cfg.url)) return true
  if (!cfg.start) throw new Fail(`App chưa chạy ở ${cfg.url} và ${CONFIG_FILE} chưa có "start" (lệnh mở app, vd "npm run dev"). Mở app lên rồi chạy lại, hoặc thêm "start".`)
  const srv = startServer(cfg.start, dir)
  holder.srv = srv
  const limit = io.startTimeoutMs ?? START_TIMEOUT_MS
  const t0 = Date.now()
  for (;;) {
    if (await probe(cfg.url)) return false
    if (srv.exited && srv.code !== 0) {
      await Promise.race([srv.closed, sleep(500)]) // cho dòng cuối app in ra kịp về trước khi báo
      throw new Fail(`Lệnh mở app "${cfg.start}" đã dừng (mã ${srv.code}) trước khi app lên.${tailText(srv)}`)
    }
    if (Date.now() - t0 > limit) throw new Fail(`Đợi ${Math.round(limit / 1000)} giây mà app chưa trả lời ở ${cfg.url}. Kiểm tra "start" và "url" trong ${CONFIG_FILE} có cùng cổng không.${tailText(srv)}`)
    await sleep(POLL_MS)
  }
}

// --- duyệt + kiểm ---------------------------------------------------------------------------------------------------------------------------

async function visit(page, url, target) {
  let resp
  try {
    resp = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
  } catch (e) {
    throw new Fail(`Không mở được ${url}: ${firstLine(e.message)}`)
  }
  if (!target.state && resp && resp.status() >= 400) throw new Fail(`${url} trả lỗi ${resp.status()} — kiểm lại "routes" trong ${CONFIG_FILE}.`)
  // Chờ mạng yên tối đa 5 s; app còn long-poll/SSE thì không bao giờ yên ⇒ hết giờ cứ đo (hai khung hình ngay sau đảm bảo đã vẽ).
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {})
  try {
    await page.evaluate(SETTLE_SCRIPT)
    return await page.evaluate(collectScript)
  } catch (e) {
    throw new Fail(`Không đọc được nội dung màn ${url}: ${firstLine(e.message)}`)
  }
}

async function auditAll(browser, cfg) {
  const findings = []
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: vp })
    try {
      for (const t of cfg.targets) {
        const page = await context.newPage()
        try {
          const snap = await visit(page, `${cfg.url}${t.label}`, t)
          for (const f of audit(snap, { route: t.label, viewport: vp.width, whitelistIcons: cfg.whitelistIcons })) findings.push({ ...f, route: t.label, viewport: vp.width, s: t.s })
          // Mã S trong ui.json mà trang không có phần tử data-s đó ⇒ đang kiểm nhầm trạng thái (hoặc app đã bỏ trạng thái đã duyệt).
          for (const code of t.codes) {
            if (await page.evaluate((s) => !!document.querySelector(`[data-s="${CSS.escape(s)}"]`), code)) continue
            findings.push({
              rule: 'state-missing', key: keyOf(t.label, vp.width, 'state-missing', code), severity: 'error',
              msg: `Không thấy trạng thái ${code} trên màn này.`,
              fix: `Gắn data-s="${code}" vào phần tử gốc của trạng thái đó, hoặc sửa "setup"/"s" trong ${CONFIG_FILE} cho đúng cách mở trạng thái.`,
              route: t.label, viewport: vp.width, s: t.s,
            })
          }
        } finally {
          await page.close()
        }
      }
    } finally {
      await context.close()
    }
  }
  return findings
}

// --- báo cáo ----------------------------------------------------------------------------------------------------------------------------------

const vpName = (w) => (w >= 800 ? 'khổ rộng' : 'khổ hẹp')
// Một khổ: "khổ rộng 1280"; nhiều khổ: "khổ rộng và hẹp (1280, 390)".
const vpText = (widths) => {
  if (widths.length === 1) return `${vpName(widths[0])} ${widths[0]}`
  const names = [...new Set(widths.map(vpName))].map((n, i) => (i ? n.replace('khổ ', '') : n))
  return `${names.join(' và ')} (${widths.join(', ')})`
}
const plain = (f) => ({ rule: f.rule, key: f.key, route: f.route, viewport: f.viewport, s: f.s ?? null, severity: f.severity, msg: f.msg, fix: f.fix })

// Nút không tên: nêu "nút nào" (hint) ngay sau lời báo để tìm ra trong code.
const hintText = (f) => (f.hints?.length ? ` Nút nào: ${f.hints.join('; ')}.` : f.hint ? ` Nút nào: ${f.hint}.` : '')

// Cùng một lỗi (cùng màn, cùng lời báo, cùng cách sửa) ở nhiều khổ ⇒ gộp thành một dòng; thứ tự theo lần xuất hiện đầu tiên.
function mergeViewports(list, extraOf = () => '') {
  const groups = new Map()
  for (const f of list) {
    const text = `${f.msg}${hintText(f)}${extraOf(f)}`
    const id = `${f.route}\u0000${f.s ?? ''}\u0000${text}\u0000${f.fix}`
    const g = groups.get(id)
    if (g) g.widths.push(f.viewport)
    else groups.set(id, { route: f.route, s: f.s, text, fix: f.fix, widths: [f.viewport] })
  }
  return [...groups.values()].map((g) => ({ ...g, where: `Màn ${g.route}${g.s ? ` (${g.s})` : ''}, ${vpText([...new Set(g.widths)].sort((a, b) => b - a))}` }))
}

function report(cfg, findings, baselineCounts, json) {
  const { blocking, inBaseline } = overBaseline(findings, baselineCounts)
  const warns = findings.filter((f) => f.severity === 'warn')
  const checked = `${cfg.targets.length} màn ở 2 khổ (${VIEWPORTS.map((v) => v.width).join(', ')})`
  const code = blocking.length ? 1 : 0
  if (json) {
    const data = { ok: code === 0, code, checked: { screens: cfg.targets.map((t) => t.label), viewports: VIEWPORTS.map((v) => v.width) }, baseline: baselineCounts !== null, inBaseline, blocking: blocking.map((f) => ({ ...plain(f), count: f.count, allowed: f.allowed, extra: f.extra })), warnings: warns.map(plain) }
    return { lines: [JSON.stringify(data)], errLines: [], code }
  }
  const lines = []
  const rows = mergeViewports(blocking, (f) => (baselineCounts !== null && f.allowed > 0 ? ` (thêm ${f.extra} so với mốc)` : ''))
  if (rows.length) {
    lines.push(`KHÔNG  Giao diện còn ${rows.length} lỗi chặn (đã kiểm ${checked}):`)
    rows.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.where}: ${r.text}`)
      lines.push(`     Sửa: ${r.fix}`)
    })
  } else {
    lines.push(`ĐẠT  Giao diện: đã kiểm ${checked}, không có lỗi chặn.`)
  }
  if (inBaseline) lines.push(`Còn ${inBaseline} lỗi cũ đã chốt trong ${BASELINE_FILE} (không chặn; sửa dần).`)
  const warnRows = mergeViewports(warns)
  if (warnRows.length) {
    lines.push(`Cảnh báo (không chặn): ${warnRows.length}`)
    for (const r of warnRows.slice(0, 10)) lines.push(`  - ${r.where}: ${r.text}`)
    if (warnRows.length > 10) lines.push(`  … và ${warnRows.length - 10} cảnh báo nữa`)
  }
  return { lines, errLines: [], code }
}

// --- chạy -------------------------------------------------------------------------------------------------------------------------------------

// io (cho test): loadPlaywright(dir) → { chromium } | null · probe(url) → boolean · startTimeoutMs.
export async function run(argv, io = {}) {
  let json = false
  const holder = { srv: null }
  let browser = null
  try {
    const a = parseArgs(argv)
    json = !!a.json
    if (a.help || a.h) return { lines: [USAGE], errLines: [], code: 0 }
    const dir = path.resolve(a.dir ?? '.')
    const cfg = loadConfig(dir, a.url, io.env ?? process.env)
    const baselineCounts = a.baseline ? null : loadBaseline(dir)

    const pw = await (io.loadPlaywright ?? loadPlaywright)(dir)
    if (!pw?.chromium) throw new Fail(`Thiếu Playwright (công cụ mở app thử như người dùng) trong dự án này. Cài bằng:\n${installLines(dir, false).map((l) => `  ${l}`).join('\n')}`, 3)
    try {
      browser = await pw.chromium.launch({ headless: true })
    } catch (e) {
      throw new Fail(`Playwright không mở được trình duyệt: ${firstLine(e.message)}\nCài trình duyệt bằng:\n${installLines(dir, true).map((l) => `  ${l}`).join('\n')}`, 3)
    }

    const reused = await ensureServer(cfg, dir, io, holder)
    const findings = await auditAll(browser, cfg)
    // App đang chạy sẵn có thể là bản cũ/của việc khác ⇒ nói rõ để kết quả không bị hiểu nhầm.
    const reuseNote = reused && !json ? [`Dùng app đang chạy sẵn ở ${cfg.url} (không tự bật).`] : []

    if (a.baseline) {
      const counts = countKeys(findings)
      writeBaseline(dir, counts)
      const total = Object.values(counts).reduce((s, n) => s + n, 0)
      const lines = json
        ? [JSON.stringify({ ok: true, code: 0, baselineWritten: BASELINE_FILE, errors: total, keys: Object.keys(counts).length })]
        : [`Đã chốt mốc giao diện: ${total} lỗi cũ → ${BASELINE_FILE}. Từ giờ chỉ lỗi MỚI (hoặc thêm lỗi cùng loại) mới chặn.`, ...reuseNote]
      return { lines, errLines: [], code: 0 }
    }
    const r = report(cfg, findings, baselineCounts, json)
    r.lines.push(...reuseNote)
    return r
  } catch (e) {
    const code = e instanceof Fail ? e.code : 2
    const msg = e instanceof Fail ? e.message : `lỗi bất ngờ: ${e?.message ?? e}`
    if (json) return { lines: [JSON.stringify({ ok: false, code, error: msg })], errLines: [], code }
    return { lines: [], errLines: [`ui-check: ${msg}`], code }
  } finally {
    // Dọn dẹp: lỗi lúc đóng không được che kết quả chính; app bật thì luôn tắt cả cây.
    await browser?.close().catch(() => {})
    await stopServer(holder.srv)
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  const { lines, errLines, code } = await run(process.argv.slice(2))
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`)
  if (errLines.length) process.stderr.write(`${errLines.join('\n')}\n`)
  process.exitCode = code
}
