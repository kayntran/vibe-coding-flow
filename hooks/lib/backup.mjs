// backup (lõi): sao lưu dữ liệu app + khôi phục thử vào chỗ tạm + lịch chạy trên máy. Spec: docs/specs/2026-10-13-flow-v7-dot4 (AC-23, AC-23a).
// CLI mỏng nằm ở hooks/backup.mjs. Lõi này KHÔNG in ra màn hình: mỗi hàm trả { exit, lines } (lines = câu đời thường).
//
// Quy tắc cứng:
//  - Mọi lệnh ghi/chạy đòi o.agreed (cờ --dong-y của CLI). Thiếu ⇒ exit 4 + câu hỏi để AI hỏi người dùng, CHƯA làm gì.
//  - Supabase gói miễn phí ⇒ chỉ khuyên nâng Pro (kèm phí), ghi backup.choice="advise-pro", không sao lưu, không cài lịch.
//  - Chỗ cất bản sao nằm NGOÀI thư mục app và NGOÀI repo git của app (bản sao có dữ liệu người dùng, không được vào git).
//  - Khôi phục thử chỉ vào chỗ tạm: D1 `--local` trong thư mục tạm; Postgres DB tạm `flow_restore_<pid>` trên máy này (từ chối máy từ xa), xoá sau (xoá không được ⇒ báo).
//    Truy vấn mẫu Postgres chạy trong phiên chỉ-đọc và bị từ chối nếu gọi hàm đụng file/hệ thống (lo_export, pg_read_file, dblink, COPY…).
//  - Lệnh ngoài (wrangler, pg_dump, psql, pg_restore, schtasks, launchctl, crontab) chỉ chạy qua deps.run(cmd, mảng tham số, {cwd, env, input, timeout}),
//    không qua shell. Chuỗi kết nối Postgres lấy từ biến môi trường, đổi thành PG* env cho lệnh con: không nằm trên dòng lệnh, không in ra, không ghi vào file.
//  - Không bao giờ in nội dung bản sao lưu; chỉ in tên file, kích thước, số bảng/dòng.
// Trạng thái ghi qua release-state.updateState (đọc lại file ngay trước khi ghi, chỉ gộp trường backup — không ghi đè mốc phát hành chạy song song)
// (`.claude/release.json` → backup:{choice, method, dest, everyHours, scheduler, lastBackup, lastRestoreCheck, + db/urlEnv/schemas/storage/timeTravelDays}).
// Exit: 0 xong · 1 không đạt/bị chặn/dùng sai · 3 thiếu công cụ hoặc điều kiện (kèm lệnh cài) · 4 cần người dùng gật.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { backupReady, readState, updateState } from './release-state.mjs'

export const EXIT = { OK: 0, FAIL: 1, MISSING: 3, ASK: 4 }
export const METHODS = ['d1', 'pg']
export const DEFAULT_EVERY_HOURS = 24
export const MARKER = '<!-- flow-backup:auto'
const HOUR_MS = 3600 * 1000
const SCHTASKS_TR_MAX = 261
const T = { export: 30 * 60_000, dump: 60 * 60_000, restore: 60 * 60_000, quick: 120_000 }
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_TABLE = (n) => n.startsWith('sqlite_') || n.startsWith('_cf_')

// ---------- tiện ích nhỏ ----------

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const pad = (n, w = 2) => String(n).padStart(w, '0')
export const dayStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const clockStamp = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const humanSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`)
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const redact = (text, secrets = []) => secrets.filter((s) => s && String(s).length >= 4).reduce((t, s) => t.split(String(s)).join('***'), String(text ?? ''))
const ago = (ms) => (ms < 2 * HOUR_MS ? `${Math.max(0, Math.round(ms / 60000))} phút trước` : ms < 48 * HOUR_MS ? `${Math.round(ms / HOUR_MS)} giờ trước` : `${Math.round(ms / (24 * HOUR_MS))} ngày trước`)

export function slugify(name) {
  const s = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, 40) || 'app'
}
const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6)
export const scheduleId = (appDir) => `flow-backup-${slugify(path.basename(appDir))}-${shortHash(path.resolve(appDir))}`

const defaultRun = (cmd, args, o = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', input: o.input, cwd: o.cwd, env: o.env, timeout: o.timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true })

// deps: { run, now:Date, platform, env, home, nodePath, script, pid, uid, logDir, tmpRoot, appDir? }
export function makeDeps(over = {}) {
  return {
    run: defaultRun, now: new Date(), platform: process.platform, env: process.env, home: os.homedir(), nodePath: process.execPath,
    script: '', pid: process.pid, uid: typeof process.getuid === 'function' ? process.getuid() : 501, logDir: undefined, tmpRoot: os.tmpdir(), ...over,
  }
}

// Một dòng log lỗi nội bộ, không bao giờ ném.
export function logLine(msg, d) {
  try {
    const dir = d.logDir || path.join(os.homedir(), '.claude', 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'backup.log'), `${new Date().toISOString()} ${clean(msg, 300)}\n`)
  } catch { /* bỏ qua */ }
}

const isMissing = (r) => r?.error?.code === 'ENOENT'
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g
const errText = (r, secrets) => redact(clean(String(r?.stderr || r?.error?.message || r?.stdout || '').replace(ANSI_RE, ''), 220), secrets)

// Trình quản lý gói của app theo file khoá gần nhất, tìm từ thư mục app đi lên (monorepo) và dừng ở gốc repo (.git):
// pnpm-lock.yaml → pnpm, yarn.lock → yarn, còn lại (package-lock.json hoặc không có) → npm.
export function pkgManager(dir) {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'pnpm-lock.yaml'))) return 'pnpm'
    if (fs.existsSync(path.join(cur, 'yarn.lock'))) return 'yarn'
    if (fs.existsSync(path.join(cur, 'package-lock.json')) || fs.existsSync(path.join(cur, '.git')) || path.dirname(cur) === cur) return 'npm'
  }
}
// Lệnh chạy wrangler của app (để đăng nhập): npx / pnpm exec / yarn.
const wranglerCli = (appDir) => { const pm = appDir ? pkgManager(appDir) : 'npm'; return `${pm === 'pnpm' ? 'pnpm exec' : pm === 'yarn' ? 'yarn' : 'npx'} wrangler` }

export function installHint(tool, platform, appDir) {
  if (tool === 'wrangler') {
    const pm = appDir ? pkgManager(appDir) : 'npm'
    if (pm === 'pnpm') return 'Cài wrangler: chạy "pnpm add -D wrangler --allow-build=workerd" trong thư mục app (pnpm báo không có cờ --allow-build thì chạy "pnpm add -D wrangler" rồi "pnpm approve-builds").'
    if (pm === 'yarn') return 'Cài wrangler: chạy "yarn add -D wrangler" trong thư mục app.'
    return 'Cài wrangler: chạy "npm install --save-dev wrangler" trong thư mục app.'
  }
  if (['pg_dump', 'psql', 'pg_restore'].includes(tool)) {
    if (platform === 'win32') return 'Cài bộ công cụ Postgres: winget install PostgreSQL.PostgreSQL.17 (xong thêm thư mục "bin" của nó vào PATH rồi mở lại cửa sổ lệnh).'
    if (platform === 'darwin') return 'Cài bộ công cụ Postgres: brew install libpq (xong chạy: brew link --force libpq).'
    return 'Cài bộ công cụ Postgres: sudo apt install postgresql-client.'
  }
  if (tool === 'crontab') return 'Cài cron: sudo apt install cron (rồi bật dịch vụ cron).'
  return `Máy này chưa có lệnh "${tool}".`
}

// Lệnh ngoài hỏng ⇒ { exit, lines } (null nếu chạy tốt). tool = tên lệnh để gợi ý cài khi thiếu.
function failed(r, what, tool, d, secrets = []) {
  if (r && r.status === 0 && !r.error) return null
  if (isMissing(r)) return { exit: EXIT.MISSING, lines: [`${what}: máy này chưa có "${tool}".`, installHint(tool, d.platform, d.appDir)] }
  if (r?.error?.code === 'ETIMEDOUT') return { exit: EXIT.FAIL, lines: [`${what}: chạy quá lâu nên đã dừng.`] }
  const text = errText(r, secrets)
  if (tool === 'wrangler' && /not authenticated|wrangler login|CLOUDFLARE_API_TOKEN|authentication error|\[code: 10000\]|not logged in/i.test(text)) {
    return { exit: EXIT.MISSING, lines: [`${what}: chưa đăng nhập Cloudflare.`, `Đăng nhập: chạy "${wranglerCli(d.appDir)} login" (hoặc đặt biến CLOUDFLARE_API_TOKEN), rồi chạy lại.`] }
  }
  return { exit: EXIT.FAIL, lines: [`${what}: không thành công${text ? ` — ${text}` : ''}.`] }
}

// ---------- đường dẫn: chỗ cất phải nằm ngoài repo ----------

export function expandHome(p, home) {
  const s = String(p ?? '')
  if (s === '~') return home
  return /^~[\\/]/.test(s) ? path.join(home, s.slice(2)) : s
}
// Đường dẫn trong thư mục home ⇒ viết dạng ~/… (không lộ tên máy trong release.json, dùng được cả Mac lẫn Windows).
export function portablePath(abs, home) {
  const rel = path.relative(home, abs)
  if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return `~/${rel.split(path.sep).join('/')}`
  return abs
}
export function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}
// realpath của phần đã tồn tại + phần còn lại (để chống đường dẫn lòng vòng qua symlink).
function realish(p) {
  let cur = path.resolve(p)
  const tail = []
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()) } catch { /* đi lên một cấp */ }
    const up = path.dirname(cur)
    if (up === cur) return path.resolve(p)
    tail.push(path.basename(cur))
    cur = up
  }
}
function repoRootOf(dir) {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    if (path.dirname(cur) === cur) return null
  }
}
// -> { ok:true, abs, stored } | { ok:false, reason }
export function checkDest(destInput, appDir, d) {
  const raw = String(destInput ?? '').trim()
  if (!raw) return { ok: false, reason: 'Chưa có chỗ cất bản sao lưu.' }
  const abs = path.resolve(expandHome(raw, d.home))
  const real = realish(abs)
  const roots = [realish(appDir)]
  const repo = repoRootOf(appDir)
  if (repo) roots.push(realish(repo))
  if (roots.some((r) => isInside(real, r))) return { ok: false, reason: `Chỗ cất "${abs}" nằm trong thư mục dự án/repo — bản sao lưu có dữ liệu người dùng, không được để cạnh code (dễ bị đưa lên git). Chọn một thư mục ngoài dự án.` }
  return { ok: true, abs, stored: portablePath(abs, d.home) }
}
export const defaultDest = (appDir) => `~/.flow-backups/${slugify(path.basename(appDir))}`

// ---------- đọc cấu hình app ----------

const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const WRANGLER_FILES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']
// Tên D1 trong cấu hình wrangler của app; đúng một tên ⇒ trả về, không thì null.
export function detectD1Name(appDir) {
  const names = new Set()
  for (const f of WRANGLER_FILES) for (const m of readText(path.join(appDir, f)).matchAll(/database_name["']?\s*[=:]\s*["']([^"']+)["']/g)) names.add(m[1])
  return names.size === 1 ? [...names][0] : null
}
export const detectR2 = (appDir) => WRANGLER_FILES.some((f) => /r2_buckets/.test(readText(path.join(appDir, f))))

// ---------- trạng thái (release.json → backup) ----------

function loadBackup(appDir, d) {
  const state = readState(appDir, { logDir: d.logDir }) ?? {}
  return { state, b: isObj(state.backup) ? state.backup : {} }
}
// Gộp patch vào backup (giá trị undefined = bỏ trường) trên trạng thái MỚI NHẤT của file: lệnh chạy lâu (export, pg_dump, khôi phục thử)
// không giữ bản đọc từ lúc đầu để ghi đè, nên mốc `release cf` vừa ghi (lastRelease, checkAt, logs…) không bị mất. Trả kết quả của updateState.
function saveBackup(appDir, patch, d) {
  return updateState(appDir, (state) => {
    const merged = { ...(isObj(state.backup) ? state.backup : {}), ...patch }
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
    return { ...state, backup: merged }
  }, { logDir: d.logDir })
}
const SAVE_FAIL = { exit: EXIT.FAIL, lines: ['Không ghi được .claude/release.json (kiểm tra quyền ghi thư mục dự án).'] }
const SAVE_CORRUPT = { exit: EXIT.FAIL, lines: ['Không ghi được .claude/release.json vì file đang hỏng (không đọc được hoặc của bản kit mới hơn) — kit không ghi đè. Sửa hoặc xoá file đó rồi chạy lại.'] }
// Kết quả updateState → null nếu đã ghi, không thì câu báo lỗi để trả thẳng.
const saveFailed = (res) => (res.ok ? null : res.reason === 'corrupt' ? SAVE_CORRUPT : SAVE_FAIL)

const ask = (lines) => ({ exit: EXIT.ASK, lines: ['Cần hỏi người dùng trước — CHƯA làm gì.', ...lines, 'Người dùng đồng ý thì chạy lại đúng lệnh này, thêm --dong-y.'] })

export const SUPABASE_ADVICE = [
  'Supabase gói miễn phí KHÔNG có sao lưu tự động, và kit không tự sao lưu giúp.',
  'Khuyên nâng gói Pro: khoảng 25 USD/tháng, được sao lưu hằng ngày giữ 7 ngày (muốn quay về từng phút phải thêm khoảng 100 USD/tháng; giá có thể đổi — xem trang giá Supabase).',
]

const schemasOf = (b) => (Array.isArray(b.schemas) && b.schemas.length ? b.schemas : ['public'])
function describeMethod(b) {
  return b.method === 'd1' ? `xuất toàn bộ cơ sở dữ liệu D1 "${b.db}" thành một file .sql` : `xuất Postgres (schema ${schemasOf(b).join(', ')}) bằng pg_dump`
}

// Đọc cấu hình sao lưu ĐANG BẬT; sai/thiếu ⇒ { fail: {exit, lines} }.
function needOn(appDir, d) {
  const { b } = loadBackup(appDir, d)
  if (b.choice === 'advise-pro') return { fail: { exit: EXIT.FAIL, lines: ['Đã chọn khuyên nâng Supabase Pro — kit không sao lưu gói miễn phí.', ...SUPABASE_ADVICE] } }
  if (b.choice !== 'on') return { fail: { exit: EXIT.FAIL, lines: ['Chưa bật sao lưu cho app này (hoặc chưa hỏi người dùng). Hỏi người dùng rồi chạy "chon on" kèm --dong-y.'] } }
  if (!METHODS.includes(b.method)) return { fail: { exit: EXIT.FAIL, lines: ['Cấu hình sao lưu thiếu cách làm (d1 hoặc pg). Chạy lại "chon on --method d1|pg".'] } }
  if (b.method === 'd1' && !NAME_RE.test(String(b.db ?? ''))) return { fail: { exit: EXIT.FAIL, lines: ['Cấu hình sao lưu thiếu tên D1. Chạy lại "chon on --method d1 --db <tên>".'] } }
  if (b.method === 'pg' && (!IDENT_RE.test(String(b.urlEnv ?? '')) || !schemasOf(b).every((s) => IDENT_RE.test(String(s))))) {
    return { fail: { exit: EXIT.FAIL, lines: ['Cấu hình sao lưu Postgres thiếu/sai tên biến kết nối hoặc tên schema. Chạy lại "chon on --method pg".'] } }
  }
  const dest = checkDest(b.dest, appDir, d)
  if (!dest.ok) return { fail: { exit: EXIT.FAIL, lines: [dest.reason] } }
  return { b, dest }
}

// ---------- chon on|off ----------

// Chọn "không sao lưu" (off) hoặc "khuyên nâng Pro" (advise-pro) ⇒ gỡ mọi trường của cách sao lưu cũ (cách làm, nơi cất, chu kỳ, lịch…)
// để không ai đọc nhầm là vẫn đang sao lưu. lastBackup / lastRestoreCheck giữ lại vì là lịch sử đã xảy ra; backupReady chỉ xét choice "on".
const CLEARED = { method: undefined, db: undefined, urlEnv: undefined, schemas: undefined, timeTravelDays: undefined, storage: undefined, dest: undefined, everyHours: undefined, scheduler: undefined }

// o = { appDir, mode:'on'|'off', method, db, dest, every, urlEnv, schemas, supabaseFree, storage, agreed }
export function choose(o, deps) {
  const d = makeDeps(deps)
  const { b: old } = loadBackup(o.appDir, d)

  if (o.mode === 'off') {
    if (!o.agreed) return ask([`Ghi lại: KHÔNG sao lưu dữ liệu của app này${old.scheduler ? ' (và tắt lịch sao lưu đang chạy trên máy)' : ''}.`])
    const lines = []
    if (old.scheduler) {
      const r = removeSchedule(old.scheduler, d)
      lines.push(r.line)
      if (!r.ok) return { exit: EXIT.FAIL, lines }
    }
    const bad = saveFailed(saveBackup(o.appDir, { ...CLEARED, choice: 'off' }, d))
    if (bad) return bad
    return { exit: EXIT.OK, lines: [...lines, 'Đã ghi: không sao lưu. Đổi ý thì hỏi lại người dùng rồi chạy "chon on".'] }
  }

  if (o.supabaseFree) {
    if (!o.agreed) return ask(['Ghi lại: app dùng Supabase gói miễn phí — chỉ khuyên nâng Pro, KHÔNG sao lưu.', ...SUPABASE_ADVICE])
    const lines = []
    if (old.scheduler) {
      const r = removeSchedule(old.scheduler, d)
      lines.push(r.line)
      if (!r.ok) return { exit: EXIT.FAIL, lines }
    }
    const bad = saveFailed(saveBackup(o.appDir, { ...CLEARED, choice: 'advise-pro' }, d))
    if (bad) return bad
    return { exit: EXIT.OK, lines: [...lines, ...SUPABASE_ADVICE, 'Không sao lưu gì cả. Đã ghi lựa chọn "khuyên nâng Pro".'] }
  }

  const method = o.method
  if (!METHODS.includes(method)) return { exit: EXIT.FAIL, lines: ['Cần --method d1 (Cloudflare D1) hoặc --method pg (Postgres).'] }
  const cfg = { choice: 'on', method, everyHours: o.every ?? DEFAULT_EVERY_HOURS }
  if (!Number.isInteger(cfg.everyHours) || cfg.everyHours < 1 || cfg.everyHours > 8760) return { exit: EXIT.FAIL, lines: ['--every cần số giờ nguyên từ 1 đến 8760.'] }
  if (method === 'd1') {
    cfg.db = o.db ?? detectD1Name(o.appDir)
    if (!cfg.db) return { exit: EXIT.FAIL, lines: ['Không tự tìm ra tên D1 trong cấu hình wrangler của app. Thêm --db <tên>.'] }
    if (!NAME_RE.test(cfg.db)) return { exit: EXIT.FAIL, lines: [`Tên D1 "${clean(cfg.db, 60)}" không hợp lệ (chỉ chữ, số, gạch ngang, gạch dưới).`] }
    cfg.timeTravelDays = 7
    cfg.urlEnv = undefined
    cfg.schemas = undefined
  } else {
    cfg.db = undefined
    cfg.timeTravelDays = undefined
    cfg.urlEnv = o.urlEnv ?? 'DATABASE_URL'
    if (!IDENT_RE.test(cfg.urlEnv)) return { exit: EXIT.FAIL, lines: [`--url-env cần tên biến môi trường hợp lệ, nhận "${clean(cfg.urlEnv, 60)}".`] }
    cfg.schemas = o.schemas?.length ? o.schemas : ['public']
    const badSchema = cfg.schemas.find((s) => !IDENT_RE.test(s))
    if (badSchema) return { exit: EXIT.FAIL, lines: [`Tên schema "${clean(badSchema, 60)}" không hợp lệ.`] }
  }
  const dest = checkDest(o.dest ?? defaultDest(o.appDir), o.appDir, d)
  if (!dest.ok) return { exit: EXIT.FAIL, lines: [dest.reason] }
  cfg.dest = dest.stored
  cfg.storage = Boolean(o.storage || detectR2(o.appDir)) || undefined

  if (!o.agreed) {
    return ask([
      `Bật sao lưu dữ liệu của app này? Cách: ${describeMethod(cfg)}. Chỗ cất: ${dest.abs} (ngoài thư mục dự án, không đưa lên git). Tần suất: mỗi ${cfg.everyHours} giờ.`,
      'Sau khi bật sẽ thử khôi phục một bản vào chỗ tạm (không đụng dữ liệu thật) để chắc là dùng được.',
      ...(method === 'pg' ? [`Chuỗi kết nối Postgres lấy từ biến môi trường ${cfg.urlEnv} (không ghi vào file).`] : []),
      ...(cfg.storage ? ['Lưu ý: file đính kèm (Storage/R2) chưa được sao lưu — chỉ dữ liệu bảng.'] : []),
    ])
  }

  const same = old.choice === 'on' && old.method === cfg.method && old.db === cfg.db && old.urlEnv === cfg.urlEnv && old.dest === cfg.dest
  const reset = same ? {} : { lastBackup: undefined, lastRestoreCheck: undefined }
  const saveBad = saveFailed(saveBackup(o.appDir, { ...cfg, ...reset }, d))
  if (saveBad) return saveBad
  const lines = [
    `Đã bật sao lưu: ${describeMethod(cfg)}. Cất ở ${dest.abs} (ngoài dự án), mỗi ${cfg.everyHours} giờ.`,
    'Bước tiếp: "chay" (sao lưu lần đầu) → "khoi-phuc-thu" (thử khôi phục vào chỗ tạm) → "lich" (cài lịch tự chạy).',
  ]
  if (old.scheduler && old.everyHours !== cfg.everyHours) lines.push('Chu kỳ đã đổi — chạy lại "lich" để lịch trên máy theo chu kỳ mới.')
  return { exit: EXIT.OK, lines }
}

// ---------- hash + đọc dump ----------

function eachChunk(file, fn) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      fn(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
}
export function hashFile(file) {
  const h = crypto.createHash('sha256')
  eachChunk(file, (c) => h.update(c))
  return h.digest('hex')
}

const IDENT_SQL = '(?:"((?:[^"]|"")+)"|`([^`]+)`|\\[([^\\]]+)\\]|([A-Za-z_][\\w$]*))'
const CREATE_RE = new RegExp(`^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT_SQL}`, 'i')
const INSERT_RE = new RegExp(`^\\s*INSERT\\s+INTO\\s+${IDENT_SQL}`, 'i')
const identOf = (m) => (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2] ?? m[3] ?? m[4])

// File .sql của D1 export -> { tableName: số dòng } (mỗi INSERT = một dòng; bảng chưa có dòng nào = 0).
export function scanSqlDump(file) {
  const tables = new Map()
  const feed = (line) => {
    let m = CREATE_RE.exec(line)
    if (m) {
      const n = identOf(m)
      if (!RESERVED_TABLE(n) && !tables.has(n)) tables.set(n, 0)
      return
    }
    m = INSERT_RE.exec(line)
    if (m) {
      const n = identOf(m)
      if (!RESERVED_TABLE(n)) tables.set(n, (tables.get(n) ?? 0) + 1)
    }
  }
  const dec = new StringDecoder('utf8')
  let rest = ''
  eachChunk(file, (c) => {
    rest += dec.write(c)
    const lines = rest.split('\n')
    rest = lines.pop()
    for (const l of lines) feed(l)
  })
  rest += dec.end()
  if (rest) feed(rest)
  return Object.fromEntries(tables)
}

// ---------- Postgres: kết nối qua PG* env ----------

export function pgEnvFromUrl(url) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return null
  const env = {}
  const host = decodeURIComponent(u.hostname).replace(/^\[|\]$/g, '')
  if (host) env.PGHOST = host
  if (u.port) env.PGPORT = u.port
  if (u.username) env.PGUSER = decodeURIComponent(u.username)
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password)
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (db) env.PGDATABASE = db
  const ssl = u.searchParams.get('sslmode')
  if (ssl) env.PGSSLMODE = ssl
  return env
}
// Môi trường cho lệnh con: bỏ mọi PG* có sẵn rồi thêm đúng cái cần (không vô tình nối nhầm máy).
function childEnv(base, extra) {
  const env = {}
  for (const [k, v] of Object.entries(base)) if (!k.toUpperCase().startsWith('PG')) env[k] = v
  return { ...env, ...extra }
}
export const isLocalHost = (h) => !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || String(h).startsWith('/')

export function pgCountSql(schemas) {
  const list = schemas.map((s) => `'${s}'`).join(',')
  return `SELECT table_schema || '.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN (${list}) ORDER BY 1`
}
const PSQL_BASE = ['-X', '-w', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1']
const psqlRows = (stdout) => String(stdout ?? '').split(/\r?\n/).filter((l) => l !== '').map((l) => l.split('\t'))

// Chạy psql -c sql; trả { r, rows }.
function psql(d, env, sql, db) {
  const r = d.run('psql', [...PSQL_BASE, ...(db ? ['-d', db] : []), '-c', sql], { env, timeout: T.quick })
  return { r, rows: r.status === 0 ? psqlRows(r.stdout) : [] }
}
function pgCounts(d, env, schemas, secrets) {
  const { r, rows } = psql(d, env, pgCountSql(schemas))
  const bad = failed(r, 'Đếm số dòng từng bảng', 'psql', d, secrets)
  if (bad) return { bad }
  const counts = {}
  for (const [name, n] of rows) counts[name] = Number(n)
  return { counts }
}

// ---------- wrangler ----------

export function wranglerCmd(appDir, d) {
  const rel = ['node_modules', 'wrangler', 'bin', 'wrangler.js']
  const cands = []
  for (let cur = path.resolve(appDir); ; cur = path.dirname(cur)) {
    cands.push(path.join(cur, ...rel))
    if (path.dirname(cur) === cur) break
  }
  for (const dir of String(d.env.PATH ?? d.env.Path ?? '').split(path.delimiter)) if (dir) cands.push(path.join(dir, ...rel))
  const js = cands.find((p) => fs.existsSync(p))
  return js ? { cmd: d.nodePath, pre: [js] } : { cmd: 'wrangler', pre: [] }
}
const wranglerEnv = (d, extra = {}) => ({ ...d.env, WRANGLER_SEND_METRICS: 'false', ...extra })

// stdout của `wrangler ... --json` -> mảng kết quả (bỏ dòng chữ đứng trước nếu có); không đọc được ⇒ null.
export function parseWranglerJson(stdout) {
  const text = String(stdout ?? '')
  for (const m of text.matchAll(/^\[/gm)) {
    try { return JSON.parse(text.slice(m.index)) } catch { /* thử chỗ khác */ }
  }
  return null
}
const cell = (v) => (v === null || v === undefined ? '' : String(v))
function d1Rows(parsed) {
  const first = Array.isArray(parsed) ? parsed[0] : null
  const results = first && Array.isArray(first.results) ? first.results : []
  return results.map((row) => Object.values(row).map(cell))
}

// ---------- chay ----------

function gateRun(b, dest) {
  return ask([`Sao lưu ngay bây giờ: ${describeMethod(b)}. Cất ở ${dest.abs}.`])
}

// o = { appDir, agreed }
export function runBackup(o, deps) {
  const d = makeDeps({ ...deps, appDir: o.appDir }) // appDir: để lời gợi ý cài/đăng nhập wrangler theo trình quản lý gói của app
  const cfg = needOn(o.appDir, d)
  if (cfg.fail) return cfg.fail
  const { b, dest } = cfg
  if (!o.agreed) return gateRun(b, dest)

  const day = dayStamp(d.now)
  const dir = path.join(dest.abs, day)
  const base = `${b.method === 'd1' ? b.db : slugify(path.basename(o.appDir))}-${day.replaceAll('-', '')}-${clockStamp(d.now)}`
  const file = path.join(dir, `${base}${b.method === 'd1' ? '.sql' : '.dump'}`)
  const part = `${file}.partial`
  const secrets = []
  const bail = (res) => {
    try { fs.rmSync(part, { force: true }) } catch { /* bỏ qua */ }
    if (res.exit !== EXIT.OK) logLine(`chay: ${res.lines[0]}`, d)
    return res
  }
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { return bail({ exit: EXIT.FAIL, lines: [`Không tạo được thư mục cất bản sao lưu (${clean(e.code || e.message, 80)}).`] }) }

  let tables
  if (b.method === 'd1') {
    const w = wranglerCmd(o.appDir, d)
    const r = d.run(w.cmd, [...w.pre, 'd1', 'export', b.db, '--remote', '--output', part], { cwd: o.appDir, env: wranglerEnv(d), timeout: T.export })
    const bad = failed(r, `Xuất D1 "${b.db}"`, 'wrangler', d)
    if (bad) return bail(bad)
    if (!fs.existsSync(part) || fs.statSync(part).size === 0) return bail({ exit: EXIT.FAIL, lines: [`Xuất D1 "${b.db}": wrangler không tạo ra file nào (hoặc file rỗng).`] })
    tables = Object.fromEntries(Object.entries(scanSqlDump(part)).map(([n, c]) => [n, { min: c, max: c }]))
  } else {
    const url = d.env[b.urlEnv]
    if (!url) return bail({ exit: EXIT.MISSING, lines: [`Chưa có biến môi trường ${b.urlEnv} (chuỗi kết nối Postgres). Đặt biến này rồi chạy lại; kit không đọc file .env.`] })
    const pgEnv = pgEnvFromUrl(url)
    if (!pgEnv) return bail({ exit: EXIT.FAIL, lines: [`Biến ${b.urlEnv} không phải chuỗi kết nối Postgres (postgres://…).`] })
    secrets.push(url, pgEnv.PGPASSWORD)
    const env = childEnv(d.env, pgEnv)
    const before = pgCounts(d, env, schemasOf(b), secrets)
    if (before.bad) return bail(before.bad)
    const dump = d.run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--no-password', ...schemasOf(b).map((s) => `--schema=${s}`), '--file', part], { env, timeout: T.dump })
    const bad = failed(dump, 'Sao lưu Postgres', 'pg_dump', d, secrets)
    if (bad) return bail(bad)
    const after = pgCounts(d, env, schemasOf(b), secrets)
    if (after.bad) return bail(after.bad)
    tables = {}
    for (const n of new Set([...Object.keys(before.counts), ...Object.keys(after.counts)])) {
      const a = before.counts[n] ?? after.counts[n]
      const z = after.counts[n] ?? a
      tables[n] = { min: Math.min(a, z), max: Math.max(a, z) }
    }
    if (!fs.existsSync(part) || fs.statSync(part).size === 0) return bail({ exit: EXIT.FAIL, lines: ['Sao lưu Postgres: pg_dump không tạo ra file nào (hoặc file rỗng).'] })
  }

  try {
    fs.renameSync(part, file)
    const bytes = fs.statSync(file).size
    const manifest = { v: 1, method: b.method, db: b.method === 'd1' ? b.db : undefined, at: d.now.toISOString(), file: path.basename(file), bytes, sha256: hashFile(file), tables }
    fs.writeFileSync(`${file}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const saveBad = saveFailed(saveBackup(o.appDir, { lastBackup: d.now.toISOString() }, d))
    if (saveBad) return saveBad
    const rows = Object.values(tables).reduce((s, t) => s + t.max, 0)
    return { exit: EXIT.OK, lines: [`Đã sao lưu: ${humanSize(bytes)}, ${Object.keys(tables).length} bảng, ${rows} dòng.`, `Cất ở: ${file}`, 'Bản sao chứa dữ liệu thật — giữ ở máy riêng tư, không đưa lên git.'] }
  } catch (e) {
    return bail({ exit: EXIT.FAIL, lines: [`Sao lưu xong nhưng không ghi được kết quả: ${clean(e.code || e.message, 100)}.`] })
  }
}

// ---------- khôi phục thử ----------

// File truy vấn mẫu docs/restore-check.sql: mỗi câu kết thúc bằng ";" ở cuối dòng; dòng "-- expect: X" ngay trên câu = ô đầu của kết quả phải bằng X.
export function parseSampleQueries(text) {
  const out = []
  let expect
  let buf = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const e = /^--\s*expect:\s*(.*)$/i.exec(line)
    if (e && buf.length === 0) { expect = e[1].trim(); continue }
    if (line.startsWith('--') || (line === '' && buf.length === 0)) continue
    buf.push(line)
    if (line.endsWith(';')) {
      out.push({ sql: buf.join('\n'), expect })
      buf = []
      expect = undefined
    }
  }
  if (buf.length) out.push({ sql: buf.join('\n'), expect })
  return out
}
// Câu bắt đầu bằng SELECT vẫn gọi được hàm đụng file/hệ thống (lo_export, pg_read_file — kể cả tên nối chuỗi qua query_to_xml) ⇒ danh sách
// chặn luôn lách được. Thay bằng luật cho phép: truy vấn mẫu KHÔNG gọi hàm nào, trừ count(…) và các từ khoá có ngoặc (IN, EXISTS…).
// Tên trong ngoặc kép ("bảng") và nội dung chuỗi bị bỏ trước khi xét nên không gây báo nhầm.
const SAMPLE_PAREN_OK = new Set(['count', 'in', 'exists', 'not', 'and', 'or', 'any', 'all', 'values', 'as', 'from', 'where', 'on', 'select'])
const SAMPLE_MAX = 10_000 // câu mẫu chỉ vài dòng; câu khổng lồ làm regex chạy rất lâu
// Chỉ nhận câu đọc, một lệnh mỗi câu, không gọi hàm. Trả lý do sai hoặc null.
export function sampleProblem(sql) {
  // Ghi chú chen giữa tên hàm và "(" (pg_read_file/**/(…), --⏎), chuỗi E'\'' và $tag$…$tag$ làm lệch việc bỏ nội dung chuỗi ⇒ từ chối thẳng.
  if (String(sql).length > SAMPLE_MAX) return `Truy vấn mẫu dài quá ${SAMPLE_MAX} ký tự`
  if (/\/\*|--|\$|\\/.test(String(sql))) return 'Truy vấn mẫu không được có ghi chú (/* */, --), dấu $ hay dấu \\ — viết câu SELECT đơn giản'
  // Bóc chuỗi '…' và tên "…" trong MỘT lượt trái→phải như SQL tự đọc (hai lượt riêng thì "a'b" ghép nhầm cặp nháy với '…' phía sau).
  // "pg_read_file"(…) vẫn là gọi hàm ⇒ tên ngoặc kép thay bằng một tên thường.
  const s = String(sql).replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => (m[0] === "'" ? "''" : 'ten_ngoac_kep')).trim()
  if (/['"]/.test(s.replace(/''/g, ''))) return 'Truy vấn mẫu có dấu nháy chưa đóng'
  if (!/^(select|with|pragma|show|explain)\b/i.test(s)) return 'Truy vấn mẫu chỉ được là câu đọc (SELECT/WITH/PRAGMA/SHOW/EXPLAIN)'
  if (s.replace(/;\s*$/, '').includes(';')) return 'Mỗi truy vấn mẫu chỉ một lệnh'
  if (/^pragma\b/i.test(s)) return null // PRAGMA name(arg) của SQLite: không phải lời gọi hàm
  // Mọi cụm ký tự không phải khoảng trắng/toán tử đứng ngay trước "(" là tên hàm (kể cả dấu kết hợp, ký tự vô hình, emoji).
  for (const m of s.matchAll(/([^\s(),;=<>+\-*/%|&!~^'":]+)\s*\(/gu)) {
    const name = m[1].toLowerCase()
    if (!SAMPLE_PAREN_OK.has(name)) return `Truy vấn mẫu không được gọi hàm ("${name}"); chỉ dùng SELECT cột FROM bảng WHERE … (count(*) được)`
  }
  return null
}
const quoteIdent = (n) => `"${String(n).replace(/"/g, '""')}"`

export function compareCounts(expected, actual) {
  const bad = []
  for (const [n, e] of Object.entries(expected)) {
    if (!(n in actual)) bad.push(`bảng "${n}" không có sau khi khôi phục`)
    else if (actual[n] < e.min || actual[n] > e.max) bad.push(`bảng "${n}": cần ${e.min === e.max ? e.min : `${e.min}–${e.max}`} dòng, khôi phục được ${actual[n]}`)
  }
  for (const n of Object.keys(actual)) if (!(n in expected)) bad.push(`bảng "${n}" có thêm sau khi khôi phục (bản sao không có)`)
  return bad
}

function findLatestBackup(destAbs) {
  let days
  try { days = fs.readdirSync(destAbs).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse() } catch { return null }
  for (const day of days) {
    let ms
    try { ms = fs.readdirSync(path.join(destAbs, day)).filter((n) => n.endsWith('.manifest.json')).sort().reverse() } catch { continue }
    for (const m of ms) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(destAbs, day, m), 'utf8'))
        return { manifest, file: path.join(destAbs, day, manifest.file) }
      } catch { /* thử bản kế */ }
    }
  }
  return null
}

// o = { appDir, agreed }
export function restoreCheck(o, deps) {
  const d = makeDeps({ ...deps, appDir: o.appDir })
  const cfg = needOn(o.appDir, d)
  if (cfg.fail) return cfg.fail
  const { b, dest } = cfg
  if (!o.agreed) return ask([`Thử khôi phục bản sao lưu mới nhất vào chỗ tạm (${b.method === 'd1' ? 'D1 chạy trong thư mục tạm của máy này' : 'Postgres: tạo rồi xoá một cơ sở dữ liệu tạm trên máy này'}) — không đụng dữ liệu thật.`])

  const found = findLatestBackup(dest.abs)
  if (!found) return { exit: EXIT.FAIL, lines: [`Chưa có bản sao lưu nào trong ${dest.abs}. Chạy "chay" trước.`] }
  const { manifest, file } = found
  if (!fs.existsSync(file)) return { exit: EXIT.FAIL, lines: [`Thiếu file bản sao lưu ${file}.`] }
  if (hashFile(file) !== manifest.sha256) return { exit: EXIT.FAIL, lines: [`Bản sao lưu ${path.basename(file)} đã bị đổi hoặc hỏng (mã kiểm tra không khớp). Sao lưu lại bằng "chay".`] }
  if (!isObj(manifest.tables)) return { exit: EXIT.FAIL, lines: ['Bản sao lưu không ghi số dòng từng bảng nên không so được. Sao lưu lại bằng "chay".'] }

  // Truy vấn mẫu: file của app nếu có, không thì "lấy 1 dòng từ bảng nhiều dòng nhất".
  let custom = null
  const sqlFile = path.join(o.appDir, 'docs', 'restore-check.sql')
  if (fs.existsSync(sqlFile)) {
    custom = parseSampleQueries(readText(sqlFile))
    if (!custom.length) return { exit: EXIT.FAIL, lines: ['docs/restore-check.sql không có câu truy vấn nào.'] }
    const p = custom.map((q) => sampleProblem(q.sql)).find(Boolean)
    if (p) return { exit: EXIT.FAIL, lines: [`docs/restore-check.sql: ${p}.`] }
  }

  const engine = b.method === 'd1' ? d1Engine(o.appDir, d, file) : pgEngine(b, d)
  if (engine.fail) return engine.fail
  const verify = () => {
    const restored = engine.restore(file)
    if (restored) return restored
    const got = engine.counts(b)
    if (got.bad) return got.bad
    const mismatch = compareCounts(manifest.tables, got.counts)
    if (mismatch.length) return { exit: EXIT.FAIL, lines: ['Khôi phục thử CHƯA đạt — số dòng không khớp bản gốc:', ...mismatch.slice(0, 10).map((s) => `  - ${s}`), ...(mismatch.length > 10 ? [`  … và ${mismatch.length - 10} chỗ nữa`] : []), 'Nếu app đang ghi dữ liệu liên tục, thử lại lúc ít người dùng.'] }

    const queries = custom ?? defaultSamples(got.counts, b.method)
    let sampleNote = 'không có dòng nào để thử truy vấn mẫu'
    for (const q of queries) {
      const res = engine.query(q.sql)
      if (res.bad) return { exit: EXIT.FAIL, lines: [`Truy vấn mẫu lỗi: ${clean(q.sql, 80)}`, ...res.bad.lines] }
      if (q.expect !== undefined ? res.rows[0]?.[0] !== q.expect : res.rows.length === 0) {
        return { exit: EXIT.FAIL, lines: [`Truy vấn mẫu trả sai: ${clean(q.sql, 80)}`, q.expect !== undefined ? `Cần "${q.expect}", nhận "${clean(res.rows[0]?.[0] ?? '(không có dòng)', 60)}".` : 'Không trả dòng nào.'] }
      }
      sampleNote = `${queries.length} truy vấn mẫu đúng`
    }

    const total = Object.values(got.counts).reduce((s, n) => s + n, 0)
    const check = { at: d.now, file: path.basename(file), bytes: manifest.bytes, sha256: manifest.sha256, tables: Object.keys(got.counts).length, rows: total, sample: sampleNote }
    const saved = saveBackup(o.appDir, { lastRestoreCheck: d.now.toISOString() }, d)
    const saveBad = saveFailed(saved)
    if (saveBad) return saveBad
    const md = writeBackupMd(o.appDir, saved.state, check)
    return { exit: EXIT.OK, lines: [`Khôi phục thử ĐẠT: ${check.tables} bảng, ${total} dòng khớp bản gốc, ${sampleNote}.`, `Bản dùng để thử: ${check.file} (${humanSize(check.bytes)}).`, md] }
  }
  let res
  let leftover
  try {
    res = verify()
  } finally {
    leftover = engine.cleanup()
    if (leftover) logLine(`khoi-phuc-thu: ${leftover}`, d)
  }
  // Dọn chỗ tạm không được ⇒ nói thẳng, không âm thầm để cơ sở dữ liệu rác trên máy (kết quả đạt/không đạt giữ nguyên).
  return leftover ? { ...res, lines: [...res.lines, leftover] } : res
}

function defaultSamples(counts, method) {
  const top = Object.entries(counts).sort((a, z) => z[1] - a[1])[0]
  if (!top || top[1] === 0) return []
  const name = top[0]
  const dot = method === 'pg' ? name.indexOf('.') : -1
  const ref = dot > 0 ? `${quoteIdent(name.slice(0, dot))}.${quoteIdent(name.slice(dot + 1))}` : quoteIdent(name)
  return [{ sql: `SELECT * FROM ${ref} LIMIT 1;` }]
}

function d1Engine(appDir, d, sqlFile) {
  const w = wranglerCmd(appDir, d)
  const dbName = `flow_restore_${d.pid}`
  let tmp = null
  const run = (args) => d.run(w.cmd, [...w.pre, 'd1', 'execute', dbName, '--local', '--persist-to', path.join(tmp, 'state'), ...args], { cwd: tmp, env: wranglerEnv(d), timeout: T.restore })
  const toml = `name = "flow-restore-check"\ncompatibility_date = "2025-01-01"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${dbName}"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n`
  try {
    tmp = fs.mkdtempSync(path.join(d.tmpRoot, 'flow-restore-'))
    fs.writeFileSync(path.join(tmp, 'wrangler.toml'), toml, 'utf8')
  } catch (e) {
    return { fail: { exit: EXIT.FAIL, lines: [`Không tạo được thư mục tạm để khôi phục thử (${clean(e.code || e.message, 80)}).`] }, cleanup() {} }
  }
  const query = (sql) => {
    const r = run(['--json', '--command', sql])
    const bad = failed(r, 'Truy vấn trên bản khôi phục thử', 'wrangler', d)
    if (bad) return { bad }
    const parsed = parseWranglerJson(r.stdout)
    if (!parsed) return { bad: { exit: EXIT.FAIL, lines: ['Không đọc được kết quả truy vấn của wrangler.'] } }
    return { rows: d1Rows(parsed) }
  }
  return {
    restore(file) {
      const r = run(['--file', file])
      return failed(r, 'Khôi phục thử vào D1 tạm', 'wrangler', d)
    },
    counts() {
      const t = query("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 4) != '_cf_' ORDER BY name")
      if (t.bad) return { bad: t.bad }
      const names = t.rows.map((r) => r[0])
      if (!names.length) return { counts: {} }
      const c = query(names.map((n, i) => `SELECT ${i} AS i, count(*) AS n FROM ${quoteIdent(n)}`).join(' UNION ALL '))
      if (c.bad) return { bad: c.bad }
      const counts = {}
      for (const [i, n] of c.rows) counts[names[Number(i)]] = Number(n)
      return { counts }
    },
    query,
    cleanup() {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* bỏ qua */ }
    },
  }
}

function pgEngine(b, d) {
  const dbName = `flow_restore_${d.pid}`
  const urlEnv = d.env.FLOW_RESTORE_URL
  const targetEnv = urlEnv ? pgEnvFromUrl(urlEnv) : {}
  if (!targetEnv) return { fail: { exit: EXIT.FAIL, lines: ['FLOW_RESTORE_URL không phải chuỗi kết nối Postgres (postgres://…).'] }, cleanup() {} }
  // FLOW_RESTORE_URL có ⇒ chỉ dùng nó; không có ⇒ dùng PG* sẵn trong môi trường (thường là Postgres local). PGSERVICE bị bỏ để kiểm máy chủ cho chắc.
  const base = urlEnv ? childEnv(d.env, targetEnv) : { ...d.env }
  delete base.PGSERVICE
  delete base.PGSERVICEFILE
  const hosts = [base.PGHOST, base.PGHOSTADDR]
  const secrets = [urlEnv, targetEnv.PGPASSWORD, base.PGPASSWORD]
  const remote = hosts.find((h) => !isLocalHost(h))
  if (remote) return { fail: { exit: EXIT.FAIL, lines: [`Chỉ khôi phục thử vào Postgres trên chính máy này (đang trỏ tới "${clean(remote, 60)}"). Bỏ biến PGHOST/PGHOSTADDR hoặc đặt FLOW_RESTORE_URL trỏ tới máy local.`] }, cleanup() {} }
  const adminEnv = base
  const dbEnv = { ...adminEnv, PGDATABASE: dbName }
  // DB để nối vào khi tạo/xoá DB tạm: DB trong FLOW_RESTORE_URL nếu có, không thì postgres; không nối/tạo được thì thử template1.
  const adminDbs = [...new Set([targetEnv.PGDATABASE || 'postgres', 'template1'])]
  // Phiên chỉ-đọc cho truy vấn mẫu: giữ PGOPTIONS có sẵn của user, thêm cờ sau cùng.
  const readOnlyEnv = { ...dbEnv, PGOPTIONS: `${dbEnv.PGOPTIONS ? `${dbEnv.PGOPTIONS} ` : ''}-c default_transaction_read_only=on` }
  let adminDb = adminDbs[0]
  let created = false
  return {
    restore(file) {
      let first = null
      for (const db of adminDbs) {
        // Đang nối vào template1 thì không dùng nó làm khuôn được ("being accessed by other users") ⇒ tạo từ template0.
        const mk = psql(d, adminEnv, `CREATE DATABASE ${dbName}${db === 'template1' ? ' TEMPLATE template0' : ''}`, db)
        if (isMissing(mk.r)) return failed(mk.r, 'Tạo cơ sở dữ liệu tạm', 'psql', d, secrets)
        if (mk.r.status === 0) { adminDb = db; created = true; break }
        first ??= mk
      }
      if (!created) {
        return { exit: EXIT.MISSING, lines: [`Không nối được Postgres trên máy này để khôi phục thử: ${errText(first.r, secrets)}`, 'Cần một Postgres đang chạy trên máy (cài và bật dịch vụ), hoặc đặt FLOW_RESTORE_URL trỏ tới nó.'] }
      }
      const r = d.run('pg_restore', ['--no-owner', '--no-privileges', '--no-password', '--exit-on-error', '--dbname', dbName, file], { env: dbEnv, timeout: T.restore })
      return failed(r, 'Khôi phục thử vào Postgres tạm', 'pg_restore', d, secrets)
    },
    counts() {
      return pgCounts(d, dbEnv, schemasOf(b), secrets)
    },
    query(sql) {
      const { r, rows } = psql(d, readOnlyEnv, sql)
      const bad = failed(r, 'Truy vấn trên bản khôi phục thử', 'psql', d, secrets)
      return bad ? { bad } : { rows }
    },
    // Trả câu báo nếu không xoá được DB tạm (để người dùng xoá tay), không thì undefined.
    cleanup() {
      if (!created) return undefined
      // WITH (FORCE) (đóng luôn kết nối còn sót) chỉ có từ Postgres 13.
      const ver = psql(d, adminEnv, 'SHOW server_version_num', adminDb)
      const force = ver.r.status === 0 && Number(ver.rows[0]?.[0]) >= 130000
      const drop = psql(d, adminEnv, `DROP DATABASE IF EXISTS ${dbName}${force ? ' WITH (FORCE)' : ''}`, adminDb)
      if (drop.r.status === 0) return undefined
      return `Không xoá được cơ sở dữ liệu tạm "${dbName}" trên Postgres của máy này (${errText(drop.r, secrets)}) — xoá tay: psql -d ${adminDb} -c "DROP DATABASE ${dbName};"`
    },
  }
}

// ---------- docs/BACKUP.md ----------

const fmtDate = (t) => `${dayStamp(t)} ${pad(t.getHours())}:${pad(t.getMinutes())}`
const SCHEDULER_NAME = { schtasks: 'Windows Task Scheduler', launchd: 'macOS launchd', cron: 'cron', 'd1-time-travel': 'D1 Time Travel' }

const scheduleLine = (b) => (isObj(b.scheduler) ? `${SCHEDULER_NAME[b.scheduler.kind] ?? b.scheduler.kind} "${b.scheduler.id}", mỗi ${b.everyHours} giờ (chỉ chạy khi máy bật)` : `chưa cài lịch tự động (dự kiến mỗi ${b.everyHours} giờ) — chạy "lich" để cài`)

export function renderBackupMd(state, check) {
  const b = state.backup
  const dest = b.dest
  const lines = [
    `${MARKER} — file tự sinh khi khôi phục thử đạt; chạy lại "backup.mjs khoi-phuc-thu" để cập nhật -->`,
    '# Sao lưu dữ liệu',
    '',
    '## Cách làm',
    `- ${describeMethod(b)}.`,
    ...(b.method === 'd1' ? ['- D1 còn có Time Travel tự động: quay về bất kỳ phút nào trong 7 ngày gần nhất (gói miễn phí; gói trả phí 30 ngày).'] : []),
    '',
    '## Chỗ cất',
    `- ${dest}/<ngày>/ — nằm ngoài thư mục dự án, KHÔNG đưa lên git (có dữ liệu người dùng).`,
    '',
    '## Lịch',
    `- ${scheduleLine(b)}.`,
    '',
    '## Lần thử khôi phục gần nhất',
    `- Ngày: ${fmtDate(check.at)}`,
    `- Bản dùng để thử: ${check.file} (${humanSize(check.bytes)}, mã kiểm tra ${check.sha256.slice(0, 12)}…)`,
    `- Kết quả: đạt — ${check.tables} bảng, ${check.rows} dòng khớp bản gốc, ${check.sample}.`,
    '',
    '## Khi cần khôi phục thật',
    ...(b.method === 'd1'
      ? ['- Mất dữ liệu gần đây: dùng Time Travel (wrangler d1 time-travel restore).', '- Mất xa hơn: nhờ AI nạp lại file .sql mới nhất ở chỗ cất vào D1 (hỏi người dùng trước, vì sẽ ghi vào dữ liệu thật).']
      : ['- Nhờ AI khôi phục file .dump mới nhất ở chỗ cất bằng pg_restore (hỏi người dùng trước, vì sẽ ghi vào dữ liệu thật).']),
    '',
    ...(b.storage ? ['## Chưa sao lưu', '- File đính kèm (Storage/R2): chưa sao lưu — chỉ dữ liệu bảng được sao lưu.', ''] : []),
  ]
  return lines.join('\n')
}
// Ghi docs/BACKUP.md (chỉ khi chưa có hoặc là file do kit sinh). Trả câu báo.
function writeBackupMd(appDir, state, check) {
  const file = path.join(appDir, 'docs', 'BACKUP.md')
  try {
    if (fs.existsSync(file) && !readText(file).startsWith(MARKER)) return 'docs/BACKUP.md đã có nội dung riêng — không ghi đè.'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, renderBackupMd(state, check), 'utf8')
    return 'Đã ghi docs/BACKUP.md.'
  } catch (e) {
    return `Không ghi được docs/BACKUP.md (${clean(e.code || e.message, 60)}).`
  }
}
// Sau khi đổi lịch: chỉ thay dòng dưới mục "## Lịch" của BACKUP.md do kit sinh (các mục khác giữ nguyên).
function refreshBackupMd(appDir, state) {
  const file = path.join(appDir, 'docs', 'BACKUP.md')
  const old = readText(file)
  if (!old.startsWith(MARKER) || !/^## Lịch\r?\n- .*$/m.test(old)) return null
  try {
    fs.writeFileSync(file, old.replace(/^(## Lịch\r?\n)- .*$/m, (_, head) => `${head}- ${scheduleLine(state.backup)}.`), 'utf8')
    return 'Đã làm mới mục Lịch trong docs/BACKUP.md.'
  } catch { return null }
}

// ---------- lịch chạy trên máy ----------

export function cronExpr(h) {
  if (h <= 23) return h === 1 ? '0 * * * *' : `0 */${h} * * *`
  return `0 3 */${Math.max(1, Math.ceil(h / 24))} * *`
}
export function schtasksArgs(id, tr, h) {
  const sched = h <= 23 ? ['/SC', 'HOURLY', '/MO', String(h)] : ['/SC', 'DAILY', '/MO', String(Math.min(365, Math.ceil(h / 24))), '/ST', '03:00']
  return ['/Create', '/TN', id, '/TR', tr, ...sched, '/F']
}
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export function plistFor({ label, args, everyHours, pathEnv }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    `  <key>Label</key><string>${xmlEsc(label)}</string>`,
    `  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xmlEsc(a)}</string>`).join('')}</array>`,
    `  <key>StartInterval</key><integer>${everyHours * 3600}</integer>`,
    '  <key>RunAtLoad</key><false/>',
    ...(pathEnv ? [`  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlEsc(pathEnv)}</string></dict>`] : []),
    '</dict>', '</plist>', '',
  ].join('\n')
}
const plistPath = (d, label) => path.join(d.home, 'Library', 'LaunchAgents', `${label}.plist`)
const launchdLabel = (id) => `com.flow.${id}`
const cronMarker = (id) => `# flow-backup:${id}`

function readCrontab(d) {
  const r = d.run('crontab', ['-l'], { timeout: T.quick })
  if (isMissing(r)) return { missing: r }
  return { lines: r.status === 0 ? String(r.stdout ?? '').split(/\r?\n/).filter((l, i, a) => !(l === '' && i === a.length - 1)) : [] }
}

function installSchedule(id, kind, every, appDir, d) {
  const argv = [d.nodePath, d.script, 'chay', path.resolve(appDir), '--dong-y']
  if (kind === 'schtasks') {
    const tr = argv.map((a) => `"${a}"`).join(' ')
    if (tr.length > SCHTASKS_TR_MAX) return { exit: EXIT.FAIL, lines: [`Đường dẫn quá dài để Windows Task Scheduler nhận (${tr.length} > ${SCHTASKS_TR_MAX} ký tự). Đặt kit hoặc dự án ở thư mục ngắn hơn.`] }
    const r = d.run('schtasks', schtasksArgs(id, tr, every), { timeout: T.quick })
    return failed(r, 'Cài lịch Windows', 'schtasks', d) ?? { exit: EXIT.OK }
  }
  if (kind === 'launchd') {
    const label = launchdLabel(id)
    const file = plistPath(d, label)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, plistFor({ label, args: argv, everyHours: every, pathEnv: d.env.PATH }), 'utf8')
    } catch (e) {
      return { exit: EXIT.FAIL, lines: [`Không ghi được file lịch ${file} (${clean(e.code || e.message, 60)}).`] }
    }
    d.run('launchctl', ['bootout', `gui/${d.uid}/${label}`], { timeout: T.quick })
    const r = d.run('launchctl', ['bootstrap', `gui/${d.uid}`, file], { timeout: T.quick })
    return failed(r, 'Nạp lịch launchd', 'launchctl', d) ?? { exit: EXIT.OK }
  }
  const cur = readCrontab(d)
  if (cur.missing) return failed(cur.missing, 'Cài lịch cron', 'crontab', d)
  const env = d.env.PATH ? `PATH=${shq(d.env.PATH).replace(/%/g, '\\%')} ` : ''
  const cmd = argv.map(shq).join(' ').replace(/%/g, '\\%')
  const line = `${cronExpr(every)} ${env}${cmd} >/dev/null 2>&1 ${cronMarker(id)}`
  const lines = [...cur.lines.filter((l) => !l.includes(cronMarker(id))), line]
  const r = d.run('crontab', ['-'], { input: `${lines.join('\n')}\n`, timeout: T.quick })
  return failed(r, 'Cài lịch cron', 'crontab', d) ?? { exit: EXIT.OK }
}

// scheduler = { kind, id } -> { ok, line }
export function removeSchedule(scheduler, d) {
  const { kind, id } = scheduler
  if (kind === 'schtasks') {
    const r = d.run('schtasks', ['/Delete', '/TN', id, '/F'], { timeout: T.quick })
    const gone = r.status === 0 || /cannot find|does not exist|không tìm thấy/i.test(`${r.stderr}${r.stdout}`) || isMissing(r)
    return { ok: gone, line: gone ? `Đã tắt lịch Windows "${id}".` : `Không tắt được lịch Windows "${id}": ${errText(r)}` }
  }
  if (kind === 'launchd') {
    const label = launchdLabel(id)
    d.run('launchctl', ['bootout', `gui/${d.uid}/${label}`], { timeout: T.quick })
    try { fs.rmSync(plistPath(d, label), { force: true }) } catch { /* bỏ qua */ }
    return { ok: true, line: `Đã tắt lịch launchd "${label}".` }
  }
  if (kind === 'cron') {
    const cur = readCrontab(d)
    if (cur.missing) return { ok: true, line: 'Máy này không có cron — không còn lịch nào để tắt.' }
    const lines = cur.lines.filter((l) => !l.includes(cronMarker(id)))
    const r = d.run('crontab', ['-'], { input: lines.length ? `${lines.join('\n')}\n` : '', timeout: T.quick })
    return { ok: r.status === 0, line: r.status === 0 ? `Đã tắt lịch cron "${id}".` : `Không tắt được lịch cron "${id}": ${errText(r)}` }
  }
  return { ok: true, line: '' }
}

// Lịch có thật trên máy này không? (hỏi chính hệ điều hành)
export function scheduleExists(scheduler, d) {
  if (!isObj(scheduler) || !scheduler.kind || !scheduler.id) return false
  const { kind, id } = scheduler
  if (kind === 'd1-time-travel') return true
  if (kind === 'schtasks') return d.run('schtasks', ['/Query', '/TN', id], { timeout: T.quick }).status === 0
  if (kind === 'launchd') return d.run('launchctl', ['list', launchdLabel(id)], { timeout: T.quick }).status === 0
  if (kind === 'cron') {
    const cur = readCrontab(d)
    return !cur.missing && cur.lines.some((l) => l.includes(cronMarker(id)))
  }
  return false
}

// Thư mục app, đường dẫn node/backup.mjs và PATH đi vào crontab (mỗi dòng một job) và plist: xuống dòng hay ký tự điều khiển cho phép
// chèn thêm job vào lịch của máy ⇒ từ chối trước khi hỏi hay ghi. Trả câu báo hoặc null.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
function scheduleInputProblem(appDir, d) {
  const hit = [['thư mục app', appDir], ['đường dẫn backup.mjs', d.script], ['đường dẫn node', d.nodePath], ['PATH', d.env.PATH]].find(([, v]) => CONTROL_RE.test(String(v ?? '')))
  return hit ? `Không cài lịch: ${hit[0]} có ký tự xuống dòng hoặc ký tự điều khiển (có thể chèn thêm lệnh vào lịch của máy). Đổi tên thư mục hoặc sửa PATH rồi chạy lại.` : null
}

export const kindFor = (platform) => (platform === 'win32' ? 'schtasks' : platform === 'darwin' ? 'launchd' : 'cron')

// o = { appDir, agreed }
export function schedule(o, deps) {
  const d = makeDeps(deps)
  const unsafe = scheduleInputProblem(o.appDir, d)
  if (unsafe) return { exit: EXIT.FAIL, lines: [unsafe] }
  const cfg = needOn(o.appDir, d)
  if (cfg.fail) return cfg.fail
  const { b } = cfg
  const kind = kindFor(d.platform)
  const every = Number(b.everyHours)
  if (!Number.isInteger(every) || every < 1) return { exit: EXIT.FAIL, lines: ['Cấu hình sao lưu thiếu chu kỳ (số giờ). Chạy lại "chon on --every <giờ>".'] }
  if (!d.script) return { exit: EXIT.FAIL, lines: ['Không biết đường dẫn backup.mjs để đặt lịch.'] }
  if (!o.agreed) return ask([`Cài lịch sao lưu tự động trên máy này: mỗi ${every} giờ một lần (${SCHEDULER_NAME[kind]}). Máy phải bật mới chạy.`])

  const id = scheduleId(o.appDir)
  const bad = installSchedule(id, kind, every, o.appDir, d)
  if (bad.exit !== EXIT.OK) return bad
  if (!scheduleExists({ kind, id }, d)) return { exit: EXIT.FAIL, lines: [`Đã gửi lệnh cài lịch nhưng hỏi lại hệ điều hành thì không thấy "${id}".`] }
  const saved = saveBackup(o.appDir, { scheduler: { kind, id } }, d)
  const saveBad = saveFailed(saved)
  if (saveBad) return saveBad
  const lines = [`Đã cài lịch: ${SCHEDULER_NAME[kind]} "${id}", mỗi ${every} giờ (máy phải bật).`]
  if (b.method === 'd1') lines.push('D1 còn có Time Travel tự động: quay về từng phút trong 7 ngày gần nhất (gói miễn phí).')
  if (b.method === 'pg') lines.push(`Lịch chạy nền không thấy biến của cửa sổ lệnh: biến ${b.urlEnv} phải được đặt ở mức hệ thống (không đọc file .env), nếu không lần chạy tự động sẽ báo thiếu.`)
  const md = refreshBackupMd(o.appDir, saved.state)
  if (md) lines.push(md)
  return { exit: EXIT.OK, lines }
}

// ---------- trang-thai ----------

// o = { appDir }. Chỉ đọc. exit 0 = đạt hoặc không áp dụng, 1 = sao lưu đang bật mà chưa đạt.
export function status(o, deps) {
  const d = makeDeps(deps)
  const { state, b } = loadBackup(o.appDir, d)
  if (b.choice === 'advise-pro') return { exit: EXIT.OK, lines: ['Sao lưu: không (Supabase gói miễn phí — đã khuyên nâng Pro).', ...SUPABASE_ADVICE] }
  if (b.choice === 'off') return { exit: EXIT.OK, lines: ['Sao lưu: TẮT (theo lựa chọn của người dùng).'] }
  if (b.choice !== 'on') return { exit: EXIT.OK, lines: ['Sao lưu: chưa hỏi người dùng. App có dữ liệu thật thì nên hỏi có bật không.'] }

  const real = scheduleExists(b.scheduler, d)
  const view = { ...state, backup: { ...b, scheduler: real ? b.scheduler : undefined } }
  const now = d.now.getTime()
  const r = backupReady(view, now)
  const when = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t }
  const last = when(b.lastBackup)
  const rc = when(b.lastRestoreCheck)
  const lines = [
    `Sao lưu: BẬT — ${describeMethod(b)}, mỗi ${b.everyHours ?? '?'} giờ, cất ở ${b.dest ?? '(chưa chọn)'}.`,
    `- Lịch trên máy: ${real ? `có (${SCHEDULER_NAME[b.scheduler.kind] ?? b.scheduler.kind} "${b.scheduler.id}")` : isObj(b.scheduler) ? `KHÔNG thấy "${b.scheduler.id}" trên máy này` : 'chưa cài'}`,
    `- Bản sao gần nhất: ${last === null ? 'chưa có' : `${dayStamp(new Date(last))} (${ago(now - last)})`}`,
    `- Khôi phục thử: ${rc === null ? 'chưa' : dayStamp(new Date(rc))}`,
  ]
  if (r.ready) return { exit: EXIT.OK, lines: [...lines, 'Kết luận: ĐẠT.'] }
  return { exit: EXIT.FAIL, lines: [...lines, `Kết luận: CHƯA ĐẠT — ${r.reasons.map((x) => x.text.toLowerCase()).join('; ')}.`] }
}
