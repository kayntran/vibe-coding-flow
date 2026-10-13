// release (lõi): kiểm trước phát hành, phát hành Cloudflare Workers (build → kiểm trước phát hành trên bản vừa build → tải lên → gắn bản mới
// ở 0% vào deployment → xác nhận địa chỉ phục vụ đúng bản mới → thử nhanh → mở 100%; lần đầu chưa có Worker thì `wrangler deploy`) và quay lại,
// lệnh VPS, đọc nhật ký sau phát hành.
// Hàm thuần: KHÔNG in ra màn hình, KHÔNG gọi công cụ ngoài trực tiếp — mọi lệnh ngoài (wrangler,
// playwright, git, ssh, scp, pnpm/yarn/npm build, node flow-gate/flow-check) đi qua tham số `run(cmd, args, opts) → { status, stdout, stderr, error }`
// (CLI `hooks/release.mjs` truyền spawnSync mảng tham số; test truyền bản giả), HTTP đi qua `fetch` truyền vào.
// Spec: docs/specs/2026-10-13-flow-v7-dot4 (AC-22b, 48, 48a, 48c, 48e, 48f) · PLAN Kiến trúc dòng 2, 4, 6, 9.
// Chỉ import `release-state` (sở hữu .claude/release.json); không import lib khác.
//
// Hợp đồng với dự án app (lane D/H phải đáp ứng):
//  - Thử nhanh = `playwright test --grep @smoke --retries=2` chạy trong thư mục dự án với env BASE_URL=<địa chỉ thật>.
//    Phát hành Workers thêm env SMOKE_EXTRA_HTTP_HEADERS = JSON {"Cloudflare-Workers-Version-Overrides":"<worker>=\"<version-id>\""};
//    playwright.config của dự án phải đọc BASE_URL → use.baseURL và SMOKE_EXTRA_HTTP_HEADERS → use.extraHTTPHeaders.
//    Header đó CHỈ trúng bản đang nằm trong deployment hiện tại (đã đo thật, nghiệm thu đợt 4 K2) ⇒ trước khi thử nhanh bản mới phải được
//    gắn vào deployment ở 0% cùng bản đang chạy 100% (`versions deploy <cũ>@100% <mới>@0%`).
//  - Dự án có script `build` trong package.json ⇒ `release cf` tự build (trình quản lý gói của app) TRƯỚC preflight (K7): khoá bí mật được quét
//    trên chính bản vừa build, rồi tải đúng bản đó lên (không quét dist cũ rồi tải dist mới). Build/preflight lỗi ⇒ chưa tải gì.
//  - Worker của app (công thức Workers/D1) khai binding `"version_metadata": { "binding": "CF_VERSION_METADATA" }` và đặt header phản hồi
//    `x-flow-version: env.CF_VERSION_METADATA.id`. Trước khi thử nhanh, `release cf` GET địa chỉ thật kèm header override và đợi (có giới hạn)
//    tới khi header đó đúng bằng mã bản mới; không xác nhận được ⇒ gỡ bản mới, không mở (override chưa áp dụng / --worker hay --url sai
//    sẽ không còn khiến bài thử chạy nhầm vào bản cũ rồi mở bản mới 100%).
//  - Nhật ký Workers: token chỉ-đọc trong env CF_LOGS_TOKEN (hoặc CLOUDFLARE_API_TOKEN) + CLOUDFLARE_ACCOUNT_ID.
//    Supabase: SUPABASE_ACCESS_TOKEN + --project-ref. VPS: ssh vào máy chủ (khoá ssh sẵn, không hỏi mật khẩu).
//  - Kit KHÔNG tự xoá bản VPS nào: chỉ liệt kê bản cũ hơn `keep` (≥ 3) để user dọn tay.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backupReady, dueReminders, readState, releaseCount, updateState } from './release-state.mjs'

export const EXIT = { OK: 0, FAIL: 1, WARN: 2, MISSING: 3, NEED_OK: 4 }
export const OVERRIDE_HEADER = 'Cloudflare-Workers-Version-Overrides'
export const VERSION_HEADER = 'x-flow-version'
// Dò bản đang phục vụ địa chỉ thật: chạy trong tiến trình node riêng (qua `run`, cùng đường với mọi lệnh ngoài) vì releaseCf chạy đồng bộ.
// URL và header đi qua biến môi trường (không qua dòng lệnh); in {status, version}; lỗi mạng ⇒ exit 2 + lý do ở stderr.
export const PROBE_SRC = `fetch(process.env.PROBE_URL,{headers:JSON.parse(process.env.PROBE_HEADERS||'{}'),redirect:'manual',signal:AbortSignal.timeout(15000)}).then(r=>{console.log(JSON.stringify({status:r.status,version:r.headers.get('${VERSION_HEADER}')}))}).catch(e=>{console.error(String((e&&e.cause&&e.cause.code)||(e&&e.message)||e));process.exit(2)})`
const PROBE_TRIES = 10
const PROBE_GAP_MS = 2000
const PROBE_TIMEOUT_MS = 30_000
const defaultSleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const SMOKE_TIMEOUT_MS = 10 * 60_000
const UPLOAD_TIMEOUT_MS = 10 * 60_000
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const DATA_NOTE = 'Lưu ý: dữ liệu không quay theo — dữ liệu (D1, KV, R2, database) vẫn là bản hiện tại, chỉ phần mềm quay về bản trước.'

// ---------- tiện ích nhỏ ----------

const okRun = (r) => !!r && !r.error && r.status === 0

// Che thứ giống khoá/token/email trước khi in một dòng lấy từ output công cụ hoặc nhật ký.
const SECRET_RES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
]
export const scrub = (s) => SECRET_RES.reduce((t, re) => t.replace(re, '[ẩn]'), String(s))

// n dòng cuối của output (ưu tiên stderr), đã che bí mật và cắt ngắn.
function tailLines(r, n) {
  const text = (r?.stderr ?? '').trim() ? r.stderr : (r?.stdout ?? '')
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).map((l) => scrub(l).slice(0, 200))
}
const why = (r) => (r?.error ? scrub(String(r.error)) : tailLines(r, 1)[0] || `mã thoát ${r?.status}`)
const miss = (what, fix) => ({ code: EXIT.MISSING, lines: [what, `Cách xử lý: ${fix}`] })
const shortId = (id) => String(id).slice(0, 8)

const span = (ms) => (ms % DAY_MS === 0 ? `${ms / DAY_MS} ngày` : ms % HOUR_MS === 0 ? `${ms / HOUR_MS} giờ` : `${Math.round(ms / 60_000)} phút`)
const pad2 = (n) => String(n).padStart(2, '0')
const fmtTime = (ms) => { const d = new Date(ms); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

// "90m" | "24h" | "7d" → mili giây; sai dạng hoặc 0 ⇒ null.
export function parseSince(s) {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(s ?? '').trim())
  if (!m || !(Number(m[1]) > 0)) return null
  return Number(m[1]) * { m: 60_000, h: HOUR_MS, d: DAY_MS }[m[2].toLowerCase()]
}

export function parseVersionId(text) {
  const t = String(text ?? '')
  const m = new RegExp(`Version ID:\\s*(${UUID})`, 'i').exec(t) || new RegExp(`version[_ -]?id["'\\s:=]+(${UUID})`, 'i').exec(t)
  return m ? m[1].toLowerCase() : null
}

export const isHttpUrl = (u) => {
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' } catch { return false }
}
const stateUrl = (st) => { const t = st?.target; const u = typeof t === 'string' ? t : t?.url; return isHttpUrl(u) ? u : null }

// ---------- tìm công cụ trong dự án (không qua shell: node <đường dẫn bin>) ----------

// node_modules/<gói>/package.json có bin `bin` → đường dẫn file; đi ngược lên thư mục cha (monorepo). Không thấy ⇒ null.
export function findBin(dir, pkgs, bin) {
  let cur = path.resolve(dir)
  for (;;) {
    for (const pkg of pkgs) {
      const pj = path.join(cur, 'node_modules', ...pkg.split('/'), 'package.json')
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
        const rel = typeof j.bin === 'string' ? j.bin : j.bin?.[bin]
        const file = rel ? path.join(path.dirname(pj), rel) : null
        if (file && fs.existsSync(file)) return file
      } catch { /* thử gói kế */ }
    }
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}
const wranglerBin = (dir) => findBin(dir, ['wrangler'], 'wrangler')
const playwrightBin = (dir) => findBin(dir, ['@playwright/test', 'playwright'], 'playwright')

// Trình quản lý gói của app theo file khoá gần nhất, tìm từ thư mục dự án đi lên (monorepo) và dừng ở gốc repo (.git):
// pnpm-lock.yaml → pnpm, yarn.lock → yarn, còn lại (package-lock.json hoặc không có) → npm.
export function pkgManager(dir) {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'pnpm-lock.yaml'))) return 'pnpm'
    if (fs.existsSync(path.join(cur, 'yarn.lock'))) return 'yarn'
    if (fs.existsSync(path.join(cur, 'package-lock.json')) || fs.existsSync(path.join(cur, '.git')) || path.dirname(cur) === cur) return 'npm'
  }
}
// pnpm 10 chặn script cài đặt của gói lạ: workerd (lõi của wrangler) phải được cho phép ngay lúc cài.
const addDev = (pm, pkg) => (pm === 'pnpm' ? `pnpm add -D ${pkg}${pkg === 'wrangler' ? ' --allow-build=workerd' : ''}` : pm === 'yarn' ? `yarn add -D ${pkg}` : `npm i -D ${pkg}`)
const execOf = (pm) => (pm === 'pnpm' ? 'pnpm exec' : pm === 'yarn' ? 'yarn' : 'npx')
const wranglerCli = (dir) => `${execOf(pkgManager(dir))} wrangler`
const needWrangler = (dir) => {
  const pm = pkgManager(dir)
  const old = pm === 'pnpm' ? ' (pnpm báo không có cờ --allow-build thì chạy `pnpm add -D wrangler` rồi `pnpm approve-builds`)' : ''
  return miss('Thiếu wrangler (công cụ của Cloudflare) trong dự án.', `chạy \`${addDev(pm, 'wrangler')}\`${old} rồi thử lại.`)
}
const needPlaywright = (dir) => {
  const pm = pkgManager(dir)
  return miss('Thiếu Playwright (công cụ chạy bài thử nhanh) trong dự án.', `chạy \`${addDev(pm, '@playwright/test')}\` rồi \`${execOf(pm)} playwright install chromium\`, rồi thử lại.`)
}

function stripJsonc(text) {
  let out = ''
  let i = 0
  let str = false
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (str) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === '"') str = false
      i++
    } else if (c === '"') { str = true; out += c; i++ }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++ }
    else if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2 }
    else { out += c; i++ }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

// Tên Worker trong cấu hình wrangler (jsonc/json/toml) ở thư mục dự án; không thấy ⇒ null.
export function readWorkerName(dir) {
  for (const f of ['wrangler.jsonc', 'wrangler.json']) {
    try {
      const j = JSON.parse(stripJsonc(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')))
      if (typeof j?.name === 'string' && j.name) return j.name
    } catch { /* thử file kế */ }
  }
  try {
    for (const line of fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8').split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break
      const m = /^\s*name\s*=\s*["']([^"']+)["']/.exec(line)
      if (m) return m[1]
    }
  } catch { /* không có */ }
  return null
}

// Chạy bài thử nhanh. headers (nếu có) đi qua env SMOKE_EXTRA_HTTP_HEADERS (JSON).
function smoke({ dir, run, pw, url, headers }) {
  const env = { BASE_URL: url, SMOKE_EXTRA_HTTP_HEADERS: headers ? JSON.stringify(headers) : undefined }
  return run(process.execPath, [pw, 'test', '--grep', '@smoke', '--retries=2'], { cwd: dir, env, timeoutMs: SMOKE_TIMEOUT_MS })
}
// Trích output bài thử nhanh trượt để người đọc biết VÌ SAO: tối đa 4 dòng nêu lý do (Error/Expected/Received/Locator/Timeout/net::ERR, không lặp)
// + 3 dòng cuối (tên bài trượt, tổng kết), giữ thứ tự gốc, bỏ mã màu, che bí mật, cắt ngắn.
const REASON_LINE = /^(?:error:|expected\b|received\b|locator:|timeout\b)|\bexpect\(|net::ERR_/i
function smokeTail(r) {
  const lines = `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`.replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const pick = new Set()
  const seen = new Set()
  lines.forEach((l, i) => { if (pick.size < 4 && REASON_LINE.test(l) && !seen.has(l)) { seen.add(l); pick.add(i) } })
  for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) pick.add(i)
  return [...pick].sort((a, b) => a - b).map((i) => scrub(lines[i]).slice(0, 200))
}
const smokeLines = (r) => smokeTail(r).map((l) => `  | ${l}`)

// Một lần dò: GET địa chỉ thật (kèm header nếu có), đọc header x-flow-version của phản hồi. → { version } (null nếu không có header) | { error }.
function probeVersion({ dir, run, url, headers }) {
  const r = run(process.execPath, ['-e', PROBE_SRC], { cwd: dir, env: { PROBE_URL: url, PROBE_HEADERS: JSON.stringify(headers ?? {}) }, timeoutMs: PROBE_TIMEOUT_MS })
  if (!okRun(r)) return { error: why(r) }
  try {
    const j = JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1))
    return { version: typeof j?.version === 'string' && j.version.trim() ? j.version.trim().toLowerCase() : null }
  } catch { return { error: 'không đọc được kết quả dò' } }
}
// Dò lặp (tối đa PROBE_TRIES lần, cách PROBE_GAP_MS) tới khi header đúng bằng `want`. Trả { ok } hoặc { ok:false, saw, seen, error }:
// saw = đã từng thấy header (seen = giá trị gần nhất); error = lý do lần dò lỗi gần nhất (khi chưa lần nào đọc được phản hồi).
function confirmServed({ dir, run, url, headers, want, sleep }) {
  let seen = null
  let error = ''
  for (let i = 0; i < PROBE_TRIES; i++) {
    if (i > 0) sleep(PROBE_GAP_MS)
    const p = probeVersion({ dir, run, url, headers })
    if (p.error) { error = p.error; continue }
    if (p.version) seen = p.version
    if (p.version === want) return { ok: true }
  }
  return { ok: false, saw: seen !== null, seen, error }
}
const gitSha = (dir, run) => {
  const r = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })
  const s = okRun(r) ? String(r.stdout).trim() : ''
  return /^[0-9a-f]{4,40}$/i.test(s) ? s : ''
}
const AUTH_RE = /not authenticated|wrangler login|CLOUDFLARE_API_TOKEN|authentication error|not logged in|unauthorized/i

// Lời của wrangler khi lỗi: bỏ mã màu ANSI và dòng "🪵 Logs were written to …" (chỉ trỏ tới file log, không nói nguyên nhân).
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g
const wranglerLines = (text) => String(text ?? '').replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/Logs were written to/i.test(l))
const wranglerText = (r) => [...wranglerLines(r?.stderr), ...wranglerLines(r?.stdout)].join('\n')
// Nguyên nhân thật: dòng "✘ [ERROR] …" đầu tiên (bỏ phần tiền tố); không có dòng ERROR ⇒ dòng cuối của stderr (không có stderr thì stdout).
export function wranglerError(r) {
  if (r?.error) return scrub(String(r.error))
  const err = wranglerLines(r?.stderr)
  const out = wranglerLines(r?.stdout)
  const hit = [...err, ...out].find((l) => /✘|\bERROR\b/.test(l))
  const line = (hit ?? (err.length ? err : out).at(-1) ?? '').replace(/^(?:[✘X]\s*)?\[ERROR\]\s*/, '').replace(/^ERROR:?\s+/, '').trim()
  return line ? scrub(line).slice(0, 200) : `mã thoát ${r?.status}`
}
const DO_RE = /durable[\s_-]*object|\bmigrations?\b/i
const NO_NAME_RE = /\b(?:worker|script)\s+name\b|--name\b|provide a name/i
// Lời của `wrangler versions upload` khi Worker chưa từng được tạo (wrangler 4.149: "You cannot upload a new version of a Worker that
// does not yet exist. Please run the `deploy` command first.").
const NOT_EXIST_RE = /Worker that does not (?:yet )?exist|run the `?deploy`? command first/i
const UUID_RE = new RegExp(`^${UUID}$`, 'i')

// Script `build` trong package.json của dự án; không có file / không đọc được / script rỗng ⇒ null.
function buildScript(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')).scripts?.build
    return typeof s === 'string' && s.trim() ? s : null
  } catch { return null }
}
// K7: dự án có script build ⇒ build bằng trình quản lý gói của app. → { lines } (lines = dòng báo đã build, rỗng nếu không có script) | { fail } (các dòng lỗi).
function buildApp(dir, run) {
  if (!buildScript(dir)) return { lines: [] }
  const pm = pkgManager(dir)
  const b = run(pm, ['run', 'build'], { cwd: dir, timeoutMs: UPLOAD_TIMEOUT_MS })
  if (!okRun(b)) {
    return { fail: [b.error ? `Build bản mới không chạy được: ${why(b)}` : 'Build bản mới không được — sửa lỗi build rồi phát hành lại:', ...(b.error ? [] : buildTail(b, 6).map((l) => `  | ${l}`))] }
  }
  return { lines: [`Đã build bằng \`${pm} run build\`.`] }
}
const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href } catch { return a === b } }
// n dòng cuối của output build (gộp stdout + stderr: pnpm chỉ in "ELIFECYCLE" ở stderr còn lỗi thật nằm ở stdout), bỏ mã màu, che bí mật.
function buildTail(r, n) {
  return `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`.replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).map((l) => scrub(l).slice(0, 200))
}

// Bản đang chạy 100% từ output của `wrangler deployments status --json` (có thể có vài dòng chữ đứng trước khối JSON: "Using redirected
// Wrangler configuration…"). Trả { id } hoặc { error, split? }.
function deploymentVersions(text) {
  const t = String(text ?? '').replace(ANSI_RE, '')
  let j
  try { j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) } catch { j = null }
  return (Array.isArray(j?.versions) ? j.versions : []).filter((v) => UUID_RE.test(String(v?.version_id))).map((v) => ({ id: v.version_id.toLowerCase(), pct: Number(v.percentage) }))
}
function liveVersion(text) {
  const versions = deploymentVersions(text)
  if (!versions.length) return { error: 'không đọc được danh sách bản trong kết quả của wrangler' }
  const full = versions.filter((v) => v.pct === 100)
  if (full.length !== 1) return { error: 'bản đang chạy đang chia tải giữa nhiều bản', split: true }
  return { id: full[0].id }
}
// Deployment có đúng các bản này với đúng tỷ lệ này không (không thừa, không thiếu).
const sameDeployment = (versions, expect) => !!versions && versions.length === expect.length && expect.every((e) => versions.some((v) => v.id === e.id && v.pct === e.pct))

// ---------- kiểm trước phát hành (AC-22b) ----------

// Đọc output của `flow-gate.mjs status`: review|qa|test là "có" hoặc "không đòi (…)" ⇒ đạt.
export function parseGateStatus(text) {
  const t = String(text ?? '')
  const g = (k) => new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(t)?.[1]?.trim()
  const [pid, review, qa, test] = [g('pid'), g('review'), g('qa'), g('test')]
  const yes = (v) => v === 'có' || (v ?? '').startsWith('không đòi')
  return {
    valid: review !== undefined && qa !== undefined && test !== undefined,
    empty: /^\(diff rỗng\)/.test(pid ?? ''),
    review: yes(review), qa: yes(qa), test: yes(test), qaNote: qa,
  }
}

// Repo cho phép sửa thẳng nhánh chính: file `.claude/allow-direct-edit` ở gốc repo (thư mục có .git, đi ngược lên từ thư mục dự án).
function allowsDirectEdit(dir) {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return fs.existsSync(path.join(cur, '.claude', 'allow-direct-edit'))
    if (path.dirname(cur) === cur) return false
  }
}

function checkGate({ dir, run, hooksDir }, out) {
  const r = run(process.execPath, [path.join(hooksDir, 'flow-gate.mjs'), 'status'], { cwd: dir })
  const g = okRun(r) ? parseGateStatus(r.stdout) : null
  if (!g?.valid) {
    out.blockers.push({ code: 'gate-unreadable', text: `Chưa kiểm được dấu review/QA/test của thay đổi (${why(r)}) — chạy trong thư mục dự án có git.` })
    return
  }
  if (g.empty) {
    out.notes.push('Không có thay đổi chờ gộp nên không đòi dấu review/QA/test.')
    // Sửa thẳng nhánh chính thì không bao giờ có diff so với main ⇒ cổng không kiểm gì. Không đổi cổng, chỉ nói thẳng (nghiệm thu đợt 4 K5).
    if (allowsDirectEdit(dir)) out.warnings.push('Repo này cho sửa thẳng nhánh chính nên không có dấu review/QA/test để kiểm — chắc chắn đã tự kiểm rồi hãy phát hành.')
    return
  }
  if (!g.review) out.blockers.push({ code: 'gate-review', text: 'Chưa có dấu review (soát code) cho thay đổi này.' })
  if (!g.qa) {
    const note = /\((.*)\)/.exec(g.qaNote ?? '')?.[1]
    out.blockers.push({ code: 'gate-qa', text: `Chưa có dấu QA (chạy thử như người dùng)${note ? ` — ${note}` : ''}.` })
  }
  if (!g.test) out.blockers.push({ code: 'gate-test', text: 'Chưa có dấu chạy test đủ bộ.' })
}

// Chạy flow-check CHỈ với checker quét khoá trong bản build (internal=secret-scan-build trong kit/checkers.json).
function checkSecretBuild({ dir, run, hooksDir }, out) {
  let entries
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(hooksDir, '..', 'kit', 'checkers.json'), 'utf8').replace(/^﻿/, ''))
    entries = reg.checkers.filter((c) => c.internal === 'secret-scan-build')
  } catch (e) {
    out.blockers.push({ code: 'secret-build-unreadable', text: `Chưa kiểm được khoá trong bản build: không đọc được danh sách máy kiểm của kit (${scrub(e.message)}).` })
    return
  }
  if (!entries.length) {
    out.blockers.push({ code: 'secret-build-unreadable', text: 'Chưa kiểm được khoá trong bản build: kit không có máy kiểm secret-build.' })
    return
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sb-'))
  let r
  try {
    const file = path.join(tmp, 'checkers.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, checkers: entries }))
    r = run(process.execPath, [path.join(hooksDir, 'flow-check.mjs'), '--dir', dir, '--json', '--checkers', file], { cwd: dir })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  let results
  try { results = JSON.parse(r.stdout).results } catch { results = null }
  if (!Array.isArray(results)) {
    out.blockers.push({ code: 'secret-build-unreadable', text: `Chưa kiểm được khoá trong bản build (${why(r)}).` })
    return
  }
  const ids = new Set(entries.map((e) => e.id))
  const mine = results.filter((x) => ids.has(x.id))
  if (!mine.length) { out.notes.push('Loại dự án này không có bước quét khoá trong bản build.'); return }
  for (const x of mine) {
    if (x.status === 'pass') continue
    if (x.status === 'skip') { out.notes.push('Bước quét khoá trong bản build không áp dụng cho dự án này.'); continue }
    if (x.status === 'missing') {
      out.blockers.push({ code: 'secret-build', text: 'Chưa build nên chưa kiểm được khoá bí mật trong bản build — build rồi kiểm lại.' })
    } else {
      const files = [...new Set((x.detail ?? []).map((d) => String(d).split(/[\s:]/)[0]).filter(Boolean))].slice(0, 3)
      out.blockers.push({ code: 'secret-build', text: `Bản build đang chứa thứ giống khoá bí mật${files.length ? ` (${files.join(', ')})` : ''} — gỡ khoá khỏi code chạy ở trình duyệt, đổi khoá đã lộ, build lại.` })
    }
  }
}

// opts: { dir, state (đã đọc hoặc null), now, run, hooksDir, zapExit?, hasData? }
// Trả { ok, blockers:[{code,text}], warnings:[text], notes:[text] }. Blockers rỗng ⇒ ok.
export function preflight(opts) {
  const { state, now = Date.now(), zapExit, hasData = false } = opts
  const out = { ok: false, blockers: [], warnings: [], notes: [] }

  checkGate(opts, out)
  checkSecretBuild(opts, out)

  if (zapExit === undefined || zapExit === null) out.notes.push('Chưa có kết quả quét bảo mật (zap-scan) nên không kiểm mục này.')
  else if (zapExit === 2) out.warnings.push('Quét bảo mật có cảnh báo mức vừa — nên xem trước khi phát hành.')
  else if (zapExit === 1) out.blockers.push({ code: 'zap', text: 'Quét bảo mật ZAP còn lỗi mức cao — sửa, hoặc ghi miễn kèm lý do và hạn trong docs/security-ignore.json.' })
  else if (zapExit === 3) out.blockers.push({ code: 'zap', text: 'Chưa quét bảo mật được vì thiếu công cụ (Java/ZAP) — cài theo hướng dẫn của zap-scan rồi quét lại.' })
  else if (zapExit !== 0) out.blockers.push({ code: 'zap', text: `Quét bảo mật báo mã thoát lạ (${zapExit}) — chạy lại zap-scan.` })

  // Chỉ đòi khi release.json ghi đã phát hành ≥ 2 lần: sau lần 1 chỉ có MỘT bản nên chưa thể quay lại (nghiệm thu đợt 4 K3).
  // Sau lần thứ 2, `release` tự nhắc thử quay lại; tới lần thứ 3 mà vẫn chưa thử thì chặn ở đây.
  if (state?.rollbackTested !== true && releaseCount(state) >= 2) {
    out.blockers.push({ code: 'rollback', text: 'Đã phát hành từ 2 lần mà chưa thử quay lại bản trước: chạy `release rollback` (Cloudflare) hoặc `release vps --rollback --run` (VPS) một lần, rồi phát hành lại bản mới.' })
  }

  const br = backupReady(state, now)
  if (br.applicable && !br.ready) for (const r of br.reasons) out.blockers.push({ code: `backup-${r.code}`, text: `Sao lưu chưa đạt: ${r.text.toLowerCase()}.` })
  if (hasData && !['on', 'off', 'advise-pro'].includes(state?.backup?.choice)) {
    out.blockers.push({ code: 'backup-choice', text: 'App có dữ liệu mà user chưa chọn phương án sao lưu — hỏi user bật hay tắt sao lưu rồi ghi lại.' })
  }

  out.ok = out.blockers.length === 0
  return out
}

export function formatPreflight(r) {
  const lines = []
  if (r.ok) lines.push('Đủ điều kiện phát hành.')
  else {
    lines.push(`Chưa được phát hành — còn ${r.blockers.length} mục:`)
    r.blockers.forEach((b, i) => lines.push(`  ${i + 1}. ${b.text}`))
  }
  for (const w of r.warnings) lines.push(`Cảnh báo: ${w}`)
  for (const n of r.notes) lines.push(`Ghi chú: ${n}`)
  return lines
}

// ---------- ghi mốc sau phát hành ----------

// Mọi lần ghi dưới đây đi qua updateState: đọc lại file ngay trước khi ghi, chỉ đổi trường của mình (lịch sao lưu tự chạy song song
// với phát hành ghi lastBackup/scheduler giữa chừng thì không bị mất). Trả kết quả của updateState ({ ok, reason? }).
// Gộp vào trạng thái hiện có (giữ trường lạ), đặt lastRelease + mốc nhắc +1 ngày, +7 ngày, và đếm thêm một lần phát hành.
// `now` = lúc bản mới thật sự được mở cho người dùng (không phải lúc lệnh bắt đầu). target = địa chỉ vừa thử đạt: lượt sau bỏ --url
// vẫn thử đúng site này; target đang là object thì giữ các trường khác, chỉ đổi url.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const targetWith = (cur, url) => (isObj(cur) ? { ...cur, url } : url)
function recordRelease(dir, so, now, patch, release) {
  return updateState(dir, (cur) => {
    const next = {
      ...cur,
      platform: cur.platform ?? patch.platform,
      target: patch.target === undefined ? cur.target : targetWith(cur.target, patch.target),
      ...(patch.extra ?? {}),
      lastRelease: { at: new Date(now).toISOString(), ...(release.version ? { version: release.version } : {}), ...(release.commit ? { commit: release.commit } : {}), smoke: 'pass' },
      releaseCount: releaseCount(cur) + 1,
      checkAt: [new Date(now + DAY_MS).toISOString(), new Date(now + 7 * DAY_MS).toISOString()],
      rollbackTested: cur.rollbackTested === true,
      logs: cur.logs ?? patch.logs,
    }
    if (next.target === undefined) delete next.target
    if (next.logs === undefined) delete next.logs
    return next
  }, so)
}
const markRollbackTested = (dir, so) => updateState(dir, (cur) => ({ ...cur, rollbackTested: true }), so)
// Từ lần phát hành thứ 2 mà chưa thử quay lại: nhắc một dòng (lần thứ 3 preflight sẽ chặn). `how` = lệnh quay lại của nền này.
function rollbackNudge(saved, how) {
  const st = saved.ok ? saved.state : null
  if (!st || st.rollbackTested === true || releaseCount(st) < 2) return []
  return [`Nhắc: nên thử quay lại một lần — \`${how}\` (người dùng thấy bản cũ vài giây), rồi phát hành lại bản mới.`]
}
// Câu báo khi không ghi được trạng thái (file hỏng ⇒ nói thẳng, kit không ghi đè).
const unsaved = (res, what, hint = ' — kiểm quyền ghi thư mục dự án') => (res.reason === 'corrupt'
  ? `Chưa ghi được ${what} vì .claude/release.json đang hỏng (kit không ghi đè) — sửa hoặc xoá file đó rồi ghi lại.`
  : `Chưa ghi được ${what} vào .claude/release.json${hint}.`)

// Phát hành thật (cf, vps --run) PHẢI qua preflight với cùng cờ (hooksDir, zapExit, hasData): còn mục chặn ⇒ dừng exit 1,
// chưa đụng Cloudflare/máy chủ. Thiếu hooksDir ⇒ cũng dừng (không kiểm được thì không phát hành). Trả { block } hoặc { warnings }.
function gateRelease(opts, state, untouched) {
  const { dir, run, now = Date.now(), hooksDir } = opts
  if (!hooksDir) return { block: { code: EXIT.FAIL, lines: ['Chưa kiểm trước phát hành được vì thiếu thư mục hook của kit.', untouched] } }
  const r = preflight({ dir, state, now, run, hooksDir, zapExit: opts.zapExit, hasData: opts.hasData })
  if (!r.ok) return { block: { code: EXIT.FAIL, lines: [...formatPreflight(r), untouched] } }
  return { warnings: r.warnings.map((w) => `Cảnh báo: ${w}`) }
}

// ---------- Cloudflare Workers (AC-48, 48a) ----------

// opts: { dir, url?, worker?, message?, run, now?, clock?, sleep?, stateOpts?, hooksDir, zapExit?, hasData?, firstRelease? } → { code, lines }
// firstRelease = user cho phép tạo Worker bằng `wrangler deploy` NẾU Worker chưa tồn tại; Worker đã có thì cờ này không đổi đường đi.
// now = giờ bắt đầu lệnh (cho preflight); clock() (nếu có) = giờ thật lúc ghi mốc phát hành (lúc bản mới được mở 100%), không có ⇒ dùng now.
// sleep(ms) = chờ giữa hai lần dò header bản (mặc định chờ thật; test truyền hàm rỗng).
export function releaseCf(opts) {
  const { dir, run, now = Date.now(), stateOpts } = opts
  const state = readState(dir, stateOpts)
  const untouched = 'Chưa tải gì lên Cloudflare.'
  // Không kiểm được trước phát hành (thiếu hooksDir) ⇒ không build, không phát hành.
  if (!opts.hooksDir) return gateRelease(opts, state, untouched).block
  // K7 + quét khoá: build TRƯỚC, rồi preflight (quét khoá) trên chính bản vừa build, rồi tải đúng bản đó lên. Quét dist cũ rồi tải dist mới
  // thì khoá lọt ra asset công khai mà scanner không thấy. Build/preflight lỗi ⇒ chưa tải gì.
  const built = buildApp(dir, run)
  if (built.fail) return { code: EXIT.FAIL, lines: [...built.fail, untouched] }
  // Preflight đi trước kiểm công cụ: còn mục chặn thì nói danh sách chặn (exit 1) trước, kể cả khi máy còn thiếu công cụ / địa chỉ / tên Worker.
  const gate = gateRelease(opts, state, untouched)
  if (gate.block) return { ...gate.block, lines: [...built.lines, ...gate.block.lines] }
  const wr = wranglerBin(dir)
  if (!wr) return needWrangler(dir)
  const pw = playwrightBin(dir)
  if (!pw) return needPlaywright(dir)
  const url = opts.url || stateUrl(state)
  if (!url || !isHttpUrl(url)) return miss('Chưa có địa chỉ thật của app để chạy thử nhanh.', 'thêm --url https://… (hoặc ghi target trong .claude/release.json).')
  const worker = opts.worker || readWorkerName(dir)
  if (!worker) return miss('Chưa biết tên Worker để nhắm bài thử vào bản mới.', 'thêm --worker <tên> (hoặc đặt "name" trong wrangler.jsonc).')

  const sha = gitSha(dir, run)
  const msg = opts.message || (sha ? `flow release ${sha}` : 'flow release')
  const saved = stateUrl(state)
  const urlNote = opts.url && saved && !sameUrl(opts.url, saved)
    ? [`Cảnh báo: --url (${opts.url}) khác địa chỉ đã lưu trong .claude/release.json (${saved}) — kiểm lại đây đúng app của Worker "${worker}"; phát hành đạt thì địa chỉ mới được lưu thay địa chỉ cũ.`]
    : []
  const tick = typeof opts.clock === 'function' ? opts.clock : () => now
  const say = typeof opts.say === 'function' ? opts.say : () => {}
  const c = { dir, run, wr, pw, url, worker, sha, msg, tick, stateOpts, say, sleep: opts.sleep ?? defaultSleep, head: [...gate.warnings, ...urlNote, ...built.lines] }

  say('Đang tải bản mới lên Cloudflare…')
  const up = run(process.execPath, [wr, 'versions', 'upload', '--message', msg], { cwd: dir, timeoutMs: UPLOAD_TIMEOUT_MS })
  if (!okRun(up)) {
    if (AUTH_RE.test(`${up.stdout}\n${up.stderr}`)) return miss('Chưa đăng nhập Cloudflare nên chưa tải bản mới lên được.', `chạy \`${wranglerCli(dir)} login\` (hoặc đặt CLOUDFLARE_API_TOKEN) rồi phát hành lại.`)
    // K1: Worker chưa từng tồn tại ⇒ wrangler không cho `versions upload`. Lần đầu chưa có người dùng nên tạo thẳng bằng `wrangler deploy`
    // (cần user nói đây là lần đầu: --first-release). Worker ĐÃ có mà vẫn gặp lỗi khác thì không đi đường này.
    if (NOT_EXIST_RE.test(wranglerText(up))) {
      if (!opts.firstRelease) return miss(`Worker "${worker}" chưa có trên Cloudflare (đây là lần phát hành đầu).`, 'chạy lại có thêm --first-release — kit sẽ tạo Worker bằng `wrangler deploy` (chưa có người dùng nên không cần mở dần) rồi thử nhanh địa chỉ thật.')
      return cfFirstRelease(c)
    }
    return { code: EXIT.FAIL, lines: [`Tải bản mới lên Cloudflare không được: ${wranglerError(up)}`, 'Bản đang chạy của người dùng không bị đụng tới; sửa xong thì chạy lại lệnh.'] }
  }
  const id = parseVersionId(`${up.stdout}\n${up.stderr}`)
  if (!id) return { code: EXIT.FAIL, lines: ['Đã tải lên nhưng không đọc được mã bản mới từ kết quả của wrangler nên chưa thử và chưa mở bản mới cho ai.', `Xem danh sách bản bằng \`${wranglerCli(dir)} versions list\`.`] }
  return cfGradual({ ...c, id })
}

// Lần đầu (Worker chưa có): `wrangler deploy` tạo Worker và mở 100% ngay, rồi thử nhanh địa chỉ thật (không cần header override).
// Trước khi thử: có mã bản ("Current Version ID") thì dò header x-flow-version của địa chỉ thật — khác mã bản vừa tạo ⇒ --url trỏ nhầm app khác
// (dừng, không thử nhầm site); không có header ⇒ chỉ cảnh báo (chưa có người dùng, binding có thể chưa được thêm).
// Trượt ⇒ app đang chạy bản lỗi nhưng chưa có người dùng nào; không ghi trạng thái.
function cfFirstRelease({ dir, run, wr, pw, url, worker, sha, msg, tick, stateOpts, say, sleep, head }) {
  say(`Worker "${worker}" chưa có — đang tạo lần đầu…`)
  const dep = run(process.execPath, [wr, 'deploy', '--message', msg], { cwd: dir, timeoutMs: UPLOAD_TIMEOUT_MS })
  if (!okRun(dep)) {
    if (AUTH_RE.test(`${dep.stdout}\n${dep.stderr}`)) return miss('Chưa đăng nhập Cloudflare nên chưa tạo Worker được.', `chạy \`${wranglerCli(dir)} login\` (hoặc đặt CLOUDFLARE_API_TOKEN) rồi phát hành lại.`)
    return { code: EXIT.FAIL, lines: [`Tạo Worker lần đầu không được: ${wranglerError(dep)}`, 'Chưa có gì chạy cho người dùng; sửa xong thì chạy lại lệnh.'] }
  }
  const openedAt = tick()
  const id = parseVersionId(`${dep.stdout}\n${dep.stderr}`)
  const notes = []
  if (!id) notes.push('Cảnh báo: không đọc được mã bản vừa tạo nên chưa kiểm được địa chỉ thử nhanh có đúng là app của Worker này không.')
  else {
    const conf = confirmServed({ dir, run, url, headers: {}, want: id, sleep })
    if (!conf.ok && conf.saw) {
      return {
        code: EXIT.FAIL,
        lines: [
          ...head,
          `Đã tạo Worker "${worker}" (bản ${shortId(id)}) nhưng ${url} đang trả bản ${shortId(conf.seen)} — địa chỉ này không phải app của Worker vừa tạo, nên CHƯA chạy bài thử nhanh (sẽ thử nhầm site).`,
          'Kiểm lại --url (và --worker) rồi chạy lại cùng lệnh; chưa có người dùng nên chưa ai bị ảnh hưởng.',
        ],
      }
    }
    if (!conf.ok) notes.push(`Cảnh báo: ${conf.error ? `không gọi được ${url} (${conf.error})` : `${url} không trả header ${VERSION_HEADER}`} nên chưa chắc đây là app của Worker vừa tạo — thêm binding version_metadata và header theo công thức Workers (recipes/cloudflare-workers.md).`)
  }
  say('Đang chạy bài thử nhanh trên địa chỉ thật…')
  const sm = smoke({ dir, run, pw, url })
  if (!okRun(sm)) {
    return {
      code: EXIT.FAIL,
      lines: [
        ...head,
        ...notes,
        `Đã tạo Worker lần đầu nhưng bài thử nhanh trượt${id ? ` trên bản ${shortId(id)}` : ''}: app đang chạy bản lỗi, tuy nhiên đây là lần phát hành đầu, chưa có người dùng nên chưa ai bị ảnh hưởng.`,
        ...smokeLines(sm),
        'Sửa lỗi rồi phát hành lại bằng cùng lệnh (Worker đã có nên lần sau đi đường thử ở 0% như thường).',
      ],
    }
  }
  const saved = recordRelease(dir, stateOpts, openedAt, { platform: 'cloudflare-workers', target: url, logs: { source: 'workers-observability', retentionDays: 3 } }, { version: id, commit: sha })
  return {
    code: EXIT.OK,
    lines: [
      ...head,
      ...notes,
      `Đã tạo Worker lần đầu${id ? ` (bản ${shortId(id)})` : ''} và mở cho mọi người; bài thử nhanh trên địa chỉ thật đạt.`,
      saved.ok ? 'Sẽ nhắc xem lỗi sau 1 ngày và 7 ngày.' : unsaved(saved, 'mốc nhắc'),
      ...rollbackNudge(saved, 'release rollback'),
    ],
  }
}

// Phát hành dần (Worker đã có): bản mới `id` đã tải lên nhưng chưa nằm trong deployment. Header override chỉ trúng bản nằm TRONG deployment
// (K2) ⇒ đọc bản đang chạy 100% → `versions deploy <cũ>@100% <mới>@0%` → XÁC NHẬN địa chỉ thật đang phục vụ đúng bản mới (header x-flow-version
// == mã bản mới, dò lặp có giới hạn) → thử nhanh kèm header → đạt: mới@100%; không xác nhận được / trượt: gỡ về cũ@100%.
// Mọi lần đổi lưu lượng thật (mở 100%, gỡ về bản cũ) chỉ làm khi deployment vẫn đúng {cũ@100%, mới@0%} của lượt này (đọc lại ngay trước khi làm:
// lượt phát hành khác chen vào thì không đụng gì), và khi lệnh đổi lưu lượng lỗi/hết giờ thì đọc lại deployment rồi mới kết luận.
function cfGradual({ dir, run, wr, pw, url, worker, sha, tick, stateOpts, say, sleep, head, id }) {
  const cli = wranglerCli(dir)
  const deploy = (specs) => run(process.execPath, [wr, 'versions', 'deploy', ...specs, '-y'], { cwd: dir, timeoutMs: UPLOAD_TIMEOUT_MS })
  // Đọc deployment hiện tại → [{ id, pct }] hoặc null (không đọc được).
  const readDeployment = () => {
    const r = run(process.execPath, [wr, 'deployments', 'status', '--json'], { cwd: dir, timeoutMs: UPLOAD_TIMEOUT_MS })
    const v = okRun(r) ? deploymentVersions(r.stdout) : []
    return v.length ? v : null
  }
  const fail = (lines) => ({ code: EXIT.FAIL, lines: [...head, ...lines] })

  const st = run(process.execPath, [wr, 'deployments', 'status', '--json'], { cwd: dir, timeoutMs: UPLOAD_TIMEOUT_MS })
  const live = okRun(st) ? liveVersion(st.stdout) : { error: wranglerError(st) }
  if (!live.id) {
    return {
      code: EXIT.FAIL,
      lines: [
        `Đã tải bản mới (${shortId(id)}) lên nhưng không đọc được bản đang chạy từ Cloudflare (${live.error}) nên chưa thử và chưa mở bản mới cho ai.`,
        live.split ? `Hoàn tất lượt triển khai dở bằng \`${cli} versions deploy <mã bản>@100% -y\` rồi phát hành lại.` : 'Bản đang chạy giữ nguyên; chạy lại lệnh phát hành được (bản vừa tải chỉ nằm chờ, chưa ai thấy).',
      ],
    }
  }
  const old = live.id
  const ours = [{ id: old, pct: 100 }, { id, pct: 0 }]
  const at100 = (v, which) => !!v && v.some((x) => x.id === which && x.pct === 100)
  const checkCmd = `${cli} deployments status`
  const raceLine = `Có lượt phát hành khác vừa đổi app (deployment không còn như lúc lượt này gắn bản mới) nên lượt này KHÔNG đụng gì thêm — kiểm \`${checkCmd}\`.`
  const unsureLine = `Chưa rõ app đang chạy bản nào (không đọc lại được deployment) nên lượt này KHÔNG đụng gì thêm — kiểm \`${checkCmd}\`.`

  const attach = deploy([`${old}@100%`, `${id}@0%`])
  if (!okRun(attach)) {
    return { code: EXIT.FAIL, lines: [`Chưa gắn được bản mới (${shortId(id)}) vào bản đang chạy ở mức 0%: ${wranglerError(attach)}`, 'Bản đang chạy giữ nguyên, chưa ai thấy bản mới; sửa xong thì chạy lại lệnh.'] }
  }

  // Không mở bản mới: gỡ về cũ@100% (chỉ khi deployment vẫn đúng của lượt này), rồi báo `lead` (vì sao chưa mở) kèm `extra`.
  const pullBack = (lead, extra = []) => {
    const pre = readDeployment()
    if (!sameDeployment(pre, ours)) return fail([`${lead}.`, pre ? raceLine : unsureLine, ...extra])
    const back = deploy([`${old}@100%`])
    let note = []
    if (!okRun(back)) {
      // Lệnh lỗi/hết giờ: đọc lại rồi mới kết luận (có thể Cloudflare đã gỡ xong).
      const after = readDeployment()
      const removed = at100(after, old) && !after.some((x) => x.id === id)
      const fixCmd = `${cli} versions deploy ${old}@100% -y`
      if (!removed && sameDeployment(after, ours)) note = [`Tự gỡ bản mới khỏi deployment không được: ${wranglerError(back)}`, `Bản mới vẫn ở 0% (chưa ai thấy) — gỡ tay bằng: ${fixCmd}`]
      else if (!removed && !after) note = [`Tự gỡ bản mới khỏi deployment không được: ${wranglerError(back)}`, `Chưa rõ kết quả (không đọc lại được deployment) — kiểm \`${checkCmd}\`; nếu bản mới còn trong deployment thì gỡ tay bằng: ${fixCmd}`]
      else if (!removed) note = [`Lệnh gỡ bản mới báo lỗi (${wranglerError(back)}) và deployment đã khác lúc đầu — kiểm \`${checkCmd}\` trước khi làm gì tiếp.`]
    }
    return fail([`${lead}; bản đang chạy giữ nguyên.`, ...note, ...extra])
  }

  // Xác nhận request kèm header override THẬT SỰ vào bản mới (override chưa áp dụng kịp, --worker sai, --url nhầm site ⇒ bài thử sẽ chạm bản cũ).
  const headers = { [OVERRIDE_HEADER]: `${worker}="${id}"` }
  say(`Đã gắn bản mới (${shortId(id)}) ở 0%, chưa ai thấy; đang xác nhận địa chỉ thật trả đúng bản mới (có thể mất tới khoảng 1 phút)…`)
  const conf = confirmServed({ dir, run, url, headers, want: id, sleep })
  if (!conf.ok) {
    const reason = !conf.saw
      ? (conf.error
        ? `Không gọi được ${url} để xác nhận bản đang phục vụ (${conf.error})`
        : `${url} không trả header ${VERSION_HEADER} nên chưa xác nhận được bài thử chạm đúng bản mới — thêm binding "version_metadata" và đặt header ${VERSION_HEADER} = env.CF_VERSION_METADATA.id trong Worker theo công thức Workers (recipes/cloudflare-workers.md), rồi phát hành lại`)
      : `Sau ${PROBE_TRIES} lần dò, ${url} vẫn trả bản ${shortId(conf.seen)} chứ không phải bản mới (${shortId(id)}) — header chọn bản chưa áp dụng, hoặc --worker/--url trỏ nhầm app`
    return pullBack(`${reason}, nên CHƯA mở bản mới cho người dùng`)
  }

  say('Đúng bản mới — đang chạy bài thử nhanh…')
  const sm = smoke({ dir, run, pw, url, headers })
  if (!okRun(sm)) return pullBack(`Bài thử nhanh trượt trên bản mới (${shortId(id)}) nên CHƯA mở cho người dùng`, smokeLines(sm))

  // Mở 100%: chỉ khi deployment vẫn đúng của lượt này.
  say('Bài thử đạt — đang mở cho mọi người…')
  const pre = readDeployment()
  if (!sameDeployment(pre, ours)) return fail([`Bản mới (${shortId(id)}) đã qua bài thử nhanh nhưng CHƯA mở cho người dùng.`, pre ? raceLine : unsureLine])
  const open = deploy([`${id}@100%`])
  let reconciled = null
  if (!okRun(open)) {
    // Lệnh lỗi/hết giờ không có nghĩa là Cloudflare chưa áp dụng: đọc lại rồi mới kết luận.
    const after = readDeployment()
    if (at100(after, id)) reconciled = wranglerError(open)
    else if (sameDeployment(after, ours)) {
      return fail([
        `Bản mới đã qua bài thử nhanh nhưng lệnh mở cho mọi người bị lỗi: ${wranglerError(open)}`,
        `Bản mới vẫn ở 0% (chưa ai thấy), bản cũ vẫn chạy. Mở lại bằng: ${cli} versions deploy ${id}@100% -y`,
      ])
    } else {
      return fail([
        `Lệnh mở bản mới (${shortId(id)}) báo lỗi (${wranglerError(open)}) và chưa rõ kết quả: ${after ? 'deployment đã khác lúc đầu' : 'không đọc lại được deployment'}.`,
        `Kiểm \`${checkCmd}\` trước khi làm gì tiếp (đừng chạy lại phát hành khi chưa biết app đang chạy bản nào).`,
      ])
    }
  }
  const saved = recordRelease(dir, stateOpts, tick(), { platform: 'cloudflare-workers', target: url, logs: { source: 'workers-observability', retentionDays: 3 } }, { version: id, commit: sha })
  return {
    code: EXIT.OK,
    lines: [
      ...head,
      `Đã mở bản mới (${shortId(id)}) cho mọi người dùng; bài thử nhanh trên bản mới đạt trước khi mở.`,
      ...(reconciled ? [`Lệnh mở báo lỗi (${reconciled}) nhưng đối chiếu lại thấy bản mới đã chạy 100%.`] : []),
      saved.ok ? 'Sẽ nhắc xem lỗi sau 1 ngày và 7 ngày.' : unsaved(saved, 'mốc nhắc'),
      ...rollbackNudge(saved, 'release rollback'),
    ],
  }
}

// opts: { dir, url?, worker?, message?, versionId?, run, stateOpts? } → { code, lines }
export function rollbackCf(opts) {
  const { dir, run, stateOpts } = opts
  const wr = wranglerBin(dir)
  if (!wr) return needWrangler(dir)
  const pw = playwrightBin(dir)
  if (!pw) return needPlaywright(dir)
  const url = opts.url || stateUrl(readState(dir, stateOpts))
  if (!url || !isHttpUrl(url)) return miss('Chưa có địa chỉ thật của app để thử lại sau khi quay lại.', 'thêm --url https://… (hoặc ghi target trong .claude/release.json).')

  const rb = run(process.execPath, [wr, 'rollback', ...(opts.versionId ? [opts.versionId] : []), '--message', opts.message || 'flow rollback', ...(opts.worker ? ['--name', opts.worker] : [])], { cwd: dir, timeoutMs: UPLOAD_TIMEOUT_MS })
  if (!okRun(rb)) {
    if (AUTH_RE.test(`${rb.stdout}\n${rb.stderr}`)) return miss('Chưa đăng nhập Cloudflare nên chưa quay lại được.', `chạy \`${wranglerCli(dir)} login\` (hoặc đặt CLOUDFLARE_API_TOKEN) rồi thử lại.`)
    const detail = wranglerText(rb)
    if (NO_NAME_RE.test(detail)) return miss('Thiếu tên Worker nên Cloudflare chưa quay lại được.', 'thêm --worker <tên> (hoặc đặt "name" trong wrangler.jsonc) rồi thử lại.')
    return {
      code: EXIT.FAIL,
      lines: [
        `Cloudflare không quay lại được: ${wranglerError(rb)}`,
        ...(DO_RE.test(detail) ? ['Hay gặp: giữa hai bản có đổi Durable Object, hoặc bản trước trỏ tới tài nguyên đã xoá.'] : []),
        'Bản đang chạy giữ nguyên.',
      ],
    }
  }
  const sm = smoke({ dir, run, pw, url })
  if (!okRun(sm)) {
    return { code: EXIT.FAIL, lines: ['Đã quay về bản trước nhưng bài thử nhanh vẫn trượt — lỗi có thể nằm ở dữ liệu hoặc cấu hình, không chỉ ở phần mềm.', ...smokeLines(sm), DATA_NOTE] }
  }
  const saved = markRollbackTested(dir, stateOpts)
  return { code: EXIT.OK, lines: ['Đã quay về bản trước và bài thử nhanh đạt.', DATA_NOTE, ...(saved.ok ? [] : [unsaved(saved, '"đã thử quay lại"')])] }
}

// ---------- VPS (AC-48c) ----------

const RE_HOST = /^(?!-)[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/
const RE_ROOT = /^\/(?!.*\.\.)[A-Za-z0-9._/-]+$/
const RE_SHA = /^[A-Za-z0-9._-]{4,64}$/
const RE_SERVICE = /^[A-Za-z0-9._@-]+$/
const RE_DIST = /^(?![-/])(?![A-Za-z]:)(?!.*\.\.)[^:\0]+$/

const shq = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)
export const lineOf = (argv) => argv.map(shq).join(' ')

// o: { mode:'symlink'|'docker', host, root, sha?, dist?, service?, sudo?, keep? } → { error } | { mode, host, root, keep, steps, rollback, prune }
// steps = phát hành bản `sha` (cần sha); rollback = quay về bản trước; mỗi bước { label, argv }. Giá trị đi vào lệnh ssh đều qua whitelist ký tự.
export function vpsPlan(o) {
  const mode = o.mode
  if (mode !== 'symlink' && mode !== 'docker') return { error: 'Cần --mode symlink (chép bản vào releases/<mã> rồi trỏ current) hoặc --mode docker (đổi IMAGE_TAG).' }
  if (!RE_HOST.test(o.host ?? '')) return { error: 'Cần --host dạng user@máy-chủ (hoặc tên đã khai trong ssh config), không có dấu cách và không bắt đầu bằng "-".' }
  const root = String(o.root ?? '').replace(/\/+$/, '')
  if (!RE_ROOT.test(root)) return { error: 'Cần --root là đường dẫn tuyệt đối trên máy chủ (vd /srv/app), chỉ gồm chữ, số, . _ - /.' }
  if (o.service !== undefined && !RE_SERVICE.test(o.service)) return { error: 'Tên --service chỉ gồm chữ, số, . _ @ -.' }
  const dist = o.dist ?? 'dist'
  if (mode === 'symlink' && !RE_DIST.test(dist)) return { error: '--dist phải là thư mục tương đối trong dự án (không "..", không ổ đĩa, không bắt đầu bằng "-").' }
  if (o.sha !== undefined && !RE_SHA.test(o.sha)) return { error: '--sha chỉ gồm chữ, số, . _ - (4-64 ký tự).' }
  const keep = Math.max(3, Math.floor(Number(o.keep)) || 3)
  const restart = o.service ? ` && ${o.sudo ? 'sudo -n ' : ''}systemctl restart ${o.service}` : ''
  const host = o.host
  const ssh = (script) => ['ssh', host, script]

  let steps = []
  let rollbackScript
  let prune = null
  if (mode === 'symlink') {
    rollbackScript = `cd ${root} && prev=$(cat .previous 2>/dev/null) && [ -n "$prev" ] && [ -d "$prev" ] && cur=$(readlink current) && ln -sfn "$prev" current && echo "$cur" > .previous${restart}`
    if (o.sha) {
      const rel = `${root}/releases/${o.sha}`
      steps = [
        { label: 'Tạo thư mục cho bản mới', argv: ssh(`mkdir -p ${rel}`) },
        { label: 'Chép bản build lên máy chủ', argv: ['scp', '-r', `${dist}/.`, `${host}:${rel}/`] },
        { label: 'Chuyển sang bản mới', argv: ssh(`cd ${root} && cur=$(readlink current 2>/dev/null || true) && { [ "$cur" = "${rel}" ] || echo "$cur" > .previous; } && ln -sfn ${rel} current${restart}`) },
      ]
    }
    prune = { label: `Liệt kê bản cũ hơn ${keep} bản gần nhất (chỉ liệt kê, kit không tự xoá)`, argv: ssh(`cd ${root}/releases && ls -1t | tail -n +${keep + 1}`) }
  } else {
    rollbackScript = `cd ${root} && prev=$(cat .previous-image-tag 2>/dev/null) && [ -n "$prev" ] && cur=$(cat .image-tag) && echo "$prev" > .image-tag && echo "$cur" > .previous-image-tag && IMAGE_TAG=$prev docker compose up -d`
    if (o.sha) {
      steps = [{ label: 'Chạy bản mới (IMAGE_TAG)', argv: ssh(`cd ${root} && cur=$(cat .image-tag 2>/dev/null || true) && { [ "$cur" = "${o.sha}" ] || echo "$cur" > .previous-image-tag; } && echo ${o.sha} > .image-tag && IMAGE_TAG=${o.sha} docker compose up -d`) }]
    }
  }
  return { mode, host, root, keep, steps, rollback: [{ label: 'Quay về bản trước', argv: ssh(rollbackScript) }], prune }
}

// ssh/scp chạy không có người ngồi gõ ⇒ cấm hỏi mật khẩu (treo). Chỉ thêm lúc chạy thật, không thêm vào dòng lệnh in cho user.
const execArgv = (argv) => (argv[0] === 'ssh' || argv[0] === 'scp' ? [argv[0], '-o', 'BatchMode=yes', ...argv.slice(1)] : argv)
function runSteps(steps, run, dir) {
  for (const s of steps) {
    const [cmd, ...args] = execArgv(s.argv)
    const r = run(cmd, args, { cwd: dir, timeoutMs: UPLOAD_TIMEOUT_MS })
    if (!okRun(r)) return { failed: s, r }
  }
  return null
}
const vpsSaved = (p) => ({ mode: p.mode, host: p.host, root: p.root, ...(p.service ? { service: p.service } : {}), ...(p.sudo ? { sudo: true } : {}), ...(p.dist ? { dist: p.dist } : {}) })

// o: { dir, run, url?, rollback?, doRun?, now?, stateOpts?, hooksDir, zapExit?, hasData?, firstRelease?, ...vpsPlan } → { code, lines }
// Không doRun ⇒ chỉ in kế hoạch (không chạy gì, không ghi trạng thái). doRun ⇒ (phát hành mới) preflight ĐẦU TIÊN (trước cả kiểm
// --host/--root, địa chỉ thử nhanh, Playwright: còn mục chặn thì nói danh sách chặn), rồi chạy thật + thử nhanh;
// thử trượt ⇒ tự quay lại bản trước. --rollback --run không qua preflight.
export function releaseVps(o) {
  const { dir, run, now = Date.now(), stateOpts } = o
  const state = readState(dir, stateOpts)
  // Quay lại là cứu hộ ⇒ không chặn bằng preflight; chỉ phát hành bản mới mới phải qua.
  const gate = o.doRun && !o.rollback ? gateRelease(o, state, 'Chưa đụng tới máy chủ.') : { warnings: [] }
  if (gate.block) return gate.block
  const sha = o.rollback ? undefined : (o.sha ?? (gitSha(dir, run) || undefined))
  const plan = vpsPlan({ ...o, sha })
  if (plan.error) return { code: EXIT.FAIL, lines: [plan.error] }
  if (!o.rollback && !sha) return { code: EXIT.FAIL, lines: ['Không đọc được mã commit hiện tại (git) để đặt tên bản mới.', 'Cách xử lý: thêm --sha <mã>.'] }
  const steps = o.rollback ? plan.rollback : plan.steps

  if (!o.doRun) {
    const lines = [o.rollback ? 'Lệnh quay về bản trước (chưa chạy gì):' : 'Kế hoạch phát hành VPS (chưa chạy gì):']
    steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.label}`, `     ${lineOf(s.argv)}`))
    if (!o.rollback) {
      lines.push('Quay về bản trước (một lệnh):', `     ${lineOf(plan.rollback[0].argv)}`)
      if (plan.prune) lines.push(`${plan.prune.label}:`, `     ${lineOf(plan.prune.argv)}`)
    }
    lines.push('Chạy thật: thêm --run.')
    return { code: EXIT.OK, lines }
  }

  const url = o.url || stateUrl(state)
  const withSmoke = !!url && isHttpUrl(url)
  let pw = null
  if (withSmoke) { pw = playwrightBin(dir); if (!pw) return needPlaywright(dir) }
  if (!o.rollback && !withSmoke) return miss('Chưa có địa chỉ thật của app để chạy thử nhanh sau khi chuyển bản.', 'thêm --url https://… (hoặc ghi target trong .claude/release.json).')

  const bad = runSteps(steps, run, dir)
  if (bad) {
    const hint = o.rollback ? 'Chưa có bản trước, hoặc thư mục bản trước đã mất.' : bad.failed === steps[steps.length - 1] ? 'Có thể đã chuyển dở — kiểm bằng ssh rồi quay lại nếu cần.' : 'Bản đang chạy chưa bị đụng tới.'
    return { code: EXIT.FAIL, lines: [`Bước "${bad.failed.label}" lỗi: ${why(bad.r)}`, hint] }
  }

  if (o.rollback) {
    if (!withSmoke) return { code: EXIT.OK, lines: ['Đã quay về bản trước (chưa thử nhanh lại vì thiếu --url).'] }
    const sm = smoke({ dir, run, pw, url })
    if (!okRun(sm)) return { code: EXIT.FAIL, lines: ['Đã quay về bản trước nhưng bài thử nhanh vẫn trượt.', ...smokeLines(sm), DATA_NOTE] }
    const saved = markRollbackTested(dir, stateOpts)
    return { code: EXIT.OK, lines: ['Đã quay về bản trước và bài thử nhanh đạt.', DATA_NOTE, ...(saved.ok ? [] : [unsaved(saved, '"đã thử quay lại"', '')])] }
  }

  const sm = smoke({ dir, run, pw, url })
  if (!okRun(sm)) {
    const back = runSteps(plan.rollback, run, dir)
    return {
      code: EXIT.FAIL,
      lines: [
        'Bài thử nhanh trượt trên bản mới.',
        back ? `Tự quay về bản trước cũng lỗi (${why(back.r)}) — vào máy chủ kiểm ngay.` : 'Đã tự quay về bản trước.',
        ...smokeLines(sm),
      ],
    }
  }
  const saved = recordRelease(dir, stateOpts, o.clock ? o.clock() : now, {
    platform: 'vps', target: url, extra: { vps: vpsSaved({ ...plan, service: o.service, sudo: o.sudo, dist: o.mode === 'symlink' ? o.dist : undefined }) },
    logs: { source: 'vps-journald' },
  }, { version: sha, commit: sha })
  return {
    code: EXIT.OK,
    lines: [
      ...gate.warnings,
      `Đã chuyển sang bản mới (${sha}); bài thử nhanh đạt.`,
      saved.ok ? 'Sẽ nhắc xem lỗi sau 1 ngày và 7 ngày.' : unsaved(saved, 'mốc nhắc'),
      ...rollbackNudge(saved, 'release vps --rollback --run'),
      ...(plan.prune ? [`Bản cũ hơn ${plan.keep} bản gần nhất (tự dọn tay nếu hết chỗ): ${lineOf(plan.prune.argv)}`] : []),
    ],
  }
}

// ---------- đọc nhật ký sau phát hành (AC-48e) ----------

const DEFAULT_RETENTION = { 'workers-observability': 3, supabase: 1 }
const MAX_EVENTS = 200
const FETCH_TIMEOUT_MS = 30_000 // quá hạn ⇒ fetch ném lỗi ⇒ "không kết nối được", không treo CLI

const normMsg = (m) => String(m).replace(new RegExp(UUID, 'gi'), '<id>').replace(/\b[0-9a-f]{12,}\b/gi, '<id>').replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim().slice(0, 160)

// events: [{ at:ms|null, message, flow? }] → nhóm theo (luồng, thông điệp đã chuẩn hoá), nhiều nhất trước.
export function groupErrors(events) {
  const map = new Map()
  for (const e of events) {
    const flow = e.flow ? scrub(e.flow).slice(0, 80) : ''
    const key = `${flow}\u0000${normMsg(e.message)}`
    let g = map.get(key)
    if (!g) { g = { count: 0, sample: scrub(e.message).replace(/\s+/g, ' ').trim().slice(0, 160), flow, first: null, last: null }; map.set(key, g) }
    g.count++
    if (typeof e.at === 'number' && Number.isFinite(e.at)) {
      g.first = g.first === null ? e.at : Math.min(g.first, e.at)
      g.last = g.last === null ? e.at : Math.max(g.last, e.at)
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

// Mốc thời gian nhiều dạng (ms, giây, micro giây của Logflare, chuỗi ISO) → ms hoặc null.
function toMs(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t > 1e14 ? Math.round(t / 1000) : t > 1e11 ? t : t * 1000
  if (typeof t === 'string' && t.trim()) {
    if (/^\d+$/.test(t.trim())) return toMs(Number(t))
    const ms = Date.parse(t.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/(\.\d{3})\d+/, '$1'))
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

const unreachable = (reason, fix) => ({ error: { reason, fix } })
// 400/401/403 = thông tin truy cập sai (token giả, thiếu quyền, sai ID) ⇒ bảo kiểm lại, thử lại cũng vô ích;
// 429/5xx = phía dịch vụ bận hoặc lỗi ⇒ thử lại sau; mã khác ⇒ kiểm lại thông tin truy cập.
const httpFail = (status, what, ids) => {
  const reason = status === 401 || status === 403 ? `${what} từ chối quyền đọc nhật ký (HTTP ${status})` : `${what} trả lỗi HTTP ${status}`
  if (status === 400 || status === 401 || status === 403) return unreachable(reason, `kiểm lại token / ${ids} (token cần là token chỉ-đọc có quyền đọc nhật ký) rồi chạy lại.`)
  if (status === 429 || status >= 500) return unreachable(reason, 'thử lại sau ít phút.')
  return unreachable(reason, `kiểm lại token / ${ids} rồi chạy lại.`)
}

async function workersEvents({ fetch, env, opts, from, to, now }) {
  const token = env.CF_LOGS_TOKEN || env.CLOUDFLARE_API_TOKEN
  if (!token) return unreachable('thiếu token đọc nhật ký Cloudflare', 'tạo token chỉ-đọc (quyền đọc Workers Observability) và đặt vào biến môi trường CF_LOGS_TOKEN.')
  const account = opts.account || env.CLOUDFLARE_ACCOUNT_ID
  if (!account) return unreachable('thiếu Account ID của Cloudflare', 'thêm --account <id> hoặc đặt biến CLOUDFLARE_ACCOUNT_ID.')
  if (!opts.worker) return unreachable('chưa biết tên Worker', 'thêm --worker <tên> (hoặc đặt "name" trong wrangler.jsonc).')
  const body = {
    queryId: `flow-release-${now}`,
    timeframe: { from, to },
    view: 'events',
    limit: MAX_EVENTS,
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [
        { key: '$metadata.service', type: 'string', operation: 'eq', value: opts.worker },
        { key: '$metadata.level', type: 'string', operation: 'eq', value: 'error' },
      ],
    },
  }
  let res
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/observability/telemetry/query`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch { return unreachable('không kết nối được tới Cloudflare', 'kiểm mạng rồi chạy lại.') }
  if (!res.ok) return httpFail(res.status, 'Cloudflare', 'ID tài khoản')
  let j
  try { j = await res.json() } catch { return unreachable('Cloudflare trả dữ liệu không đọc được', 'thử lại sau ít phút.') }
  const r = j?.result ?? j
  const list = [r?.events?.events, r?.events, r?.invocations, r?.logs].find(Array.isArray) ?? []
  const events = list.map((e) => {
    const md = e?.$metadata ?? {}
    return { at: toMs(e?.timestamp ?? md.timestamp), message: md.error || md.message || e?.message || e?.source?.message || 'lỗi không rõ nội dung', flow: md.trigger || md.url || '' }
  })
  return { events, truncated: events.length >= MAX_EVENTS }
}

async function supabaseEvents({ fetch, env, opts, from, to }) {
  const token = env.SUPABASE_ACCESS_TOKEN
  if (!token) return unreachable('thiếu token Supabase', 'tạo access token ở Supabase (Account → Access Tokens) và đặt vào biến SUPABASE_ACCESS_TOKEN.')
  if (!opts.projectRef) return unreachable('thiếu mã dự án Supabase', 'thêm --project-ref <mã> (chuỗi trong địa chỉ <mã>.supabase.co).')
  if (!/^[a-z0-9]{10,40}$/i.test(opts.projectRef)) return unreachable('mã dự án Supabase không hợp lệ', 'sửa --project-ref thành đúng mã (chỉ chữ và số, chuỗi trong địa chỉ <mã>.supabase.co).')
  const sqls = [
    'select t.timestamp, t.event_message from edge_logs as t cross join unnest(t.metadata) as m cross join unnest(m.response) as r where r.status_code >= 500 order by t.timestamp desc limit 100',
    "select t.timestamp, t.event_message from postgres_logs as t cross join unnest(t.metadata) as m cross join unnest(m.parsed) as p where p.error_severity in ('ERROR','FATAL','PANIC') order by t.timestamp desc limit 100",
  ]
  const events = []
  // Supabase chỉ cho truy vấn tối đa 24 giờ mỗi lần ⇒ cắt khoảng thành từng ngày (tối đa 14).
  for (let end = to, n = 0; end > from && n < 14; end -= DAY_MS, n++) {
    const start = Math.max(from, end - DAY_MS)
    for (const sql of sqls) {
      const qs = new URLSearchParams({ sql, iso_timestamp_start: new Date(start).toISOString(), iso_timestamp_end: new Date(end).toISOString() })
      let res
      try {
        res = await fetch(`https://api.supabase.com/v1/projects/${opts.projectRef}/analytics/endpoints/logs.all?${qs}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      } catch { return unreachable('không kết nối được tới Supabase', 'kiểm mạng rồi chạy lại.') }
      if (!res.ok) return httpFail(res.status, 'Supabase', 'ID tài khoản và mã dự án')
      let j
      try { j = await res.json() } catch { return unreachable('Supabase trả dữ liệu không đọc được', 'thử lại sau ít phút.') }
      if (j?.error) return unreachable('Supabase báo lỗi khi đọc nhật ký', 'xem nhật ký trong bảng điều khiển Supabase (Logs).')
      for (const row of Array.isArray(j?.result) ? j.result : []) events.push({ at: toMs(row.timestamp), message: row.event_message || 'lỗi không rõ nội dung', flow: '' })
    }
  }
  return { events, truncated: false }
}

const TS_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/
const ERR_RE = /\b(error|fatal|panic|exception|unhandled|traceback|segfault)\b/i

// Dòng nhật ký có mốc thời gian đầu dòng (hoặc sau "| " của docker compose) ⇒ một sự kiện; dòng không mốc (vết ngăn xếp, "-- No entries --") bỏ qua.
export function parseLogLines(text, { onlyErrors }) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = TS_RE.exec(line)
    if (!m || m.index > 40) continue
    if (onlyErrors && !ERR_RE.test(line)) continue
    out.push({ at: toMs(m[1].replace(',', '.')), message: line.slice(m.index + m[1].length).replace(/^[\s:|-]+/, '') || line, flow: '' })
  }
  return out
}

function vpsEvents({ run, opts, from, to }) {
  if (!RE_HOST.test(opts.host ?? '')) return unreachable('chưa biết máy chủ VPS', 'thêm --host user@máy-chủ (hoặc phát hành VPS một lần để kit nhớ).')
  if (opts.service !== undefined && !RE_SERVICE.test(opts.service)) return unreachable('tên service không hợp lệ', 'tên chỉ gồm chữ, số, . _ @ -.')
  const secs = Math.max(1, Math.round((to - from) / 1000))
  const docker = opts.mode === 'docker'
  let script
  if (docker) {
    const root = String(opts.root ?? '').replace(/\/+$/, '')
    if (!RE_ROOT.test(root)) return unreachable('chưa biết thư mục app trên VPS', 'thêm --root /đường/dẫn (nơi có docker compose).')
    script = `cd ${root} && docker compose logs --since ${secs}s --no-color -t`
  } else {
    script = `journalctl ${opts.service ? `-u ${opts.service} ` : ''}--since=-${secs}s -p err --no-pager -o short-iso`
  }
  const [cmd, ...args] = execArgv(['ssh', opts.host, script])
  const r = run(cmd, args, { timeoutMs: 120_000 })
  if (r.error || r.status === 255) return unreachable('không kết nối được tới máy chủ qua ssh', 'kiểm khoá ssh và tên máy chủ rồi chạy lại.')
  if (r.status !== 0) return unreachable(`lệnh đọc nhật ký trên máy chủ báo lỗi (${why(r)})`, 'vào máy chủ kiểm quyền đọc nhật ký.')
  return { events: parseLogLines(r.stdout, { onlyErrors: docker }).filter((e) => e.at === null || (e.at >= from && e.at <= to)), truncated: false }
}

// Đọc nhật ký lỗi trong `since` (ms) gần nhất theo state.logs.source. Không ném.
// Trả { source, status:'clean'|'errors'|'beyond-retention'|'unreachable', from, to, retentionDays, availableFrom, total, groups, truncated, reason?, fix? }
//  - clean: đọc được, không lỗi · errors: có lỗi · beyond-retention: khoảng hỏi dài hơn thời gian giữ log (kèm kết quả của phần còn log)
//  - unreachable: không đọc được nguồn (thiếu token/quyền/mạng/cấu hình).
export async function readLogs({ state, since, now = Date.now(), env = {}, fetch = globalThis.fetch, run, opts = {} }) {
  const source = state?.logs?.source
  const base = { source: source ?? 'none', to: now, groups: [], total: 0, truncated: false }
  if (!source || source === 'none') return { ...base, status: 'unreachable', from: now - since, reason: 'chưa chọn nơi đọc nhật ký', fix: 'đặt logs.source trong .claude/release.json (workers-observability, supabase hoặc vps-journald).' }
  const retentionDays = Number(state.logs.retentionDays) > 0 ? Number(state.logs.retentionDays) : DEFAULT_RETENTION[source] ?? null
  const requestedFrom = now - since
  const availableFrom = retentionDays ? now - retentionDays * DAY_MS : null
  const beyond = availableFrom !== null && requestedFrom < availableFrom
  const from = beyond ? availableFrom : requestedFrom
  const meta = { ...base, from, requestedFrom, retentionDays, availableFrom }

  let got
  try {
    const ctx = { fetch, env, run, opts, from, to: now, now }
    if (source === 'workers-observability') got = await workersEvents(ctx)
    else if (source === 'supabase') got = await supabaseEvents(ctx)
    else if (source === 'vps-journald') got = vpsEvents(ctx)
    else got = unreachable(`nguồn nhật ký "${source}" chưa được hỗ trợ`, 'dùng workers-observability, supabase hoặc vps-journald.')
  } catch (e) {
    got = unreachable(`lỗi khi đọc nhật ký (${scrub(e?.message ?? e)})`, 'thử lại; nếu lặp lại thì báo kit.')
  }
  if (got.error) return { ...meta, status: 'unreachable', reason: got.error.reason, fix: got.error.fix }
  const groups = groupErrors(got.events)
  return { ...meta, status: beyond ? 'beyond-retention' : groups.length ? 'errors' : 'clean', total: got.events.length, groups, truncated: got.truncated }
}

// Kết quả readLogs → các dòng bằng lời cho người không code.
export function formatLogs(r) {
  const lines = []
  const win = span(Math.max(60_000, r.to - (r.requestedFrom ?? r.from)))
  if (r.status === 'unreachable') {
    return [`Chưa đọc được nhật ký của app: ${r.reason}.`, `Cách xử lý: ${r.fix}`, 'Chưa kết luận được app có lỗi hay không.']
  }
  if (r.status === 'beyond-retention') {
    lines.push(`Nơi chạy app chỉ giữ nhật ký ${r.retentionDays} ngày, nên từ ${fmtTime(r.requestedFrom)} đến ${fmtTime(r.availableFrom)} không còn log để xem (không có nghĩa là không có lỗi).`)
  }
  const part = r.status === 'beyond-retention' ? `phần còn log (từ ${fmtTime(r.from)})` : `${win} qua`
  if (!r.groups.length) {
    lines.push(`Không thấy lỗi nào trong ${part}.`)
    return lines
  }
  lines.push(`Có ${r.total} lỗi trong ${part}, ${r.groups.length} loại${r.truncated ? ` (chỉ đọc ${MAX_EVENTS} lỗi gần nhất, có thể còn nhiều hơn)` : ''}:`)
  for (const g of r.groups.slice(0, 5)) {
    const when = g.first === null ? '' : g.first === g.last ? ` · lúc ${fmtTime(g.first)}` : ` · từ ${fmtTime(g.first)} đến ${fmtTime(g.last)}`
    lines.push(`  - ${g.count} lần · "${g.sample}"${g.flow ? ` · ở ${g.flow}` : ''}${when}`)
  }
  if (r.groups.length > 5) lines.push(`  …và ${r.groups.length - 5} loại nữa.`)
  return lines
}

// Bỏ các mốc checkAt đã tới hạn khỏi release.json (sau khi đã xem nhật ký). Trả true nếu có ghi.
export function dropDueMarks(dir, now = Date.now(), so) {
  return updateState(dir, (st) => {
    if (!Array.isArray(st.checkAt)) return null
    const due = dueReminders(st, now).find((r) => r.kind === 'check')?.due ?? []
    if (!due.length) return null
    return { ...st, checkAt: st.checkAt.filter((x) => !due.includes(x)) }
  }, so).changed === true
}
