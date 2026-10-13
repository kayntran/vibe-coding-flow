// release-state: thư viện DUY NHẤT đọc/ghi `<dự án>/.claude/release.json` (trạng thái phát hành, sao lưu, khám sức khoẻ).
// Spec: docs/specs/2026-10-13-flow-v7-dot4/PLAN.md (Kiến trúc dòng 2) · docs/adr/0007-release-state.md.
// `release`, `backup`, `health`, `session-start` chỉ gọi thư viện này.
//
// Hình dạng (v:1): { v, platform, target, lastRelease:{at,version,commit,smoke}, releaseCount?, checkAt:[ISO…], rollbackTested,
//   logs:{source,retentionDays}, backup:{choice, method?, dest?, everyHours?, scheduler?:{kind,id}, lastBackup?, lastRestoreCheck?},
//   health:{lastAt?} }. Trường lạ được giữ nguyên khi ghi lại.
//
// File hỏng (không phải JSON / không phải object / `v` sai hoặc mới hơn bản này) ⇒ coi như chưa có (readState trả null),
// ghi MỘT dòng vào ~/.claude/logs/release-state.log, không ném lỗi, không in ra stdout.
// Thêm trường mới = tăng VERSION + thêm hàm chuyển đổi vào MIGRATIONS[vCũ] (nhận object v cũ, trả object v mới hơn một bậc).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const VERSION = 1
export const STATE_REL = '.claude/release.json'
const HEALTH_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// MIGRATIONS[n] đưa trạng thái từ v n lên v n+1. Hiện chưa có bậc nào (v1 là bản đầu).
const MIGRATIONS = {}

const REASON_TEXT = {
  'no-scheduler': 'Chưa cài lịch sao lưu tự động',
  'no-interval': 'Chưa đặt chu kỳ sao lưu',
  'no-backup': 'Chưa có bản sao lưu nào',
  'stale': 'Bản sao lưu gần nhất đã quá cũ',
  'no-restore-check': 'Chưa khôi phục thử bản sao lưu',
}

// ---------- tiện ích nhỏ ----------

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
// Chấp nhận Date | số ms | chuỗi ISO; không hiểu ⇒ NaN.
const toMs = (t) => {
  if (t instanceof Date) return t.getTime()
  if (typeof t === 'number') return t
  if (typeof t === 'string' && t.trim()) return Date.parse(t)
  return NaN
}

export function statePath(dir) {
  return path.join(dir, ...STATE_REL.split('/'))
}

// Một dòng log, không bao giờ ném (log hỏng không được làm hỏng việc chính).
function logLine(msg, opts = {}) {
  try {
    const logDir = opts.logDir || path.join(os.homedir(), '.claude', 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const one = String(msg).replace(/[\r\n]+/g, ' ').slice(0, 300)
    fs.appendFileSync(path.join(logDir, 'release-state.log'), `${new Date().toISOString()} ${one}\n`)
  } catch { /* bỏ qua */ }
}

// Đưa object đọc được lên VERSION hiện tại. Trả { state } hoặc { error }.
function migrate(raw) {
  if (!isObj(raw)) return { error: 'nội dung không phải object' }
  let v = raw.v
  if (!Number.isInteger(v) || v < 1) return { error: 'thiếu hoặc sai trường v' }
  if (v > VERSION) return { error: `v${v} mới hơn bản hỗ trợ (v${VERSION})` }
  let cur = raw
  while (v < VERSION) {
    const step = MIGRATIONS[v]
    if (typeof step !== 'function') return { error: `không có bước chuyển v${v}` }
    cur = step(cur)
    if (!isObj(cur)) return { error: `bước chuyển v${v} trả kết quả sai` }
    v += 1
    cur = { ...cur, v }
  }
  return { state: cur }
}

// ---------- đọc / ghi ----------

// Trả trạng thái (đã chuyển lên VERSION hiện tại) hoặc null nếu chưa có / hỏng. Không ném.
export function readState(dir, opts = {}) {
  const file = statePath(dir)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code !== 'ENOENT') logLine(`không đọc được ${file}: ${e.code || e.message}`, opts)
    return null
  }
  let raw
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    logLine(`file hỏng (không phải JSON) ${file}: ${e.message}`, opts)
    return null
  }
  const r = migrate(raw)
  if (r.error) {
    logLine(`file hỏng ${file}: ${r.error}`, opts)
    return null
  }
  return r.state
}

// Ghi nguyên tử: file tạm cùng thư mục rồi rename đè. Luôn ghi v = VERSION. Trả true/false, không ném.
export function writeState(dir, state, opts = {}) {
  const file = statePath(dir)
  if (!isObj(state)) {
    logLine(`không ghi ${file}: state không phải object`, opts)
    return false
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ ...state, v: VERSION }, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* bỏ qua */ }
    logLine(`không ghi được ${file}: ${e.code || e.message}`, opts)
    return false
  }
}

// Đọc-sửa-ghi MỘT trường của lệnh chạy lâu (sao lưu, phát hành, khám sức khoẻ): đọc lại file NGAY trước khi ghi, đưa bản mới nhất
// cho fn(state) → trạng thái mới, rồi ghi. Lệnh chỉ gộp đúng trường mình sở hữu qua đây, KHÔNG giữ bản đọc từ lúc bắt đầu để ghi đè
// (lệnh khác chạy song song, vd `release cf` ghi lastRelease/checkAt trong lúc đang export, sẽ không bị mất).
//  - fn nhận object (file chưa có ⇒ {}); trả null/undefined ⇒ không đổi gì, không ghi.
//  - File đang có mà hỏng/không đọc được/v mới hơn ⇒ KHÔNG ghi đè, không gọi fn: { ok:false, reason:'corrupt' }.
//  - Ghi lỗi hoặc fn trả thứ không phải object ⇒ { ok:false, reason:'failed' }. Thành công ⇒ { ok:true, changed, state }.
// Không phải khoá liên tiến trình: cửa sổ giữa đọc và đổi tên file chỉ còn là vài mili giây, không còn là cả thời gian lệnh chạy.
export function updateState(dir, fn, opts = {}) {
  const cur = readState(dir, opts)
  if (cur === null && fs.existsSync(statePath(dir))) return { ok: false, reason: 'corrupt' }
  const next = fn(cur ?? {})
  if (next === null || next === undefined) return { ok: true, changed: false, state: cur ?? {} }
  if (!writeState(dir, next, opts)) return { ok: false, reason: 'failed' }
  return { ok: true, changed: true, state: { ...next, v: VERSION } }
}

// ---------- số lần phát hành ----------

// Số lần `release` đã phát hành thành công (trường tuỳ chọn `releaseCount`). File cũ chưa có trường ⇒ suy từ lastRelease
// (có ⇒ 1, không ⇒ 0) nên không cần tăng VERSION. preflight chỉ đòi "đã thử quay lại" khi số này ≥ 2.
export function releaseCount(state) {
  if (!isObj(state)) return 0
  if (Number.isInteger(state.releaseCount) && state.releaseCount >= 0) return state.releaseCount
  return isObj(state.lastRelease) ? 1 : 0
}

// ---------- sao lưu ----------

// choice≠"on" ⇒ { applicable:false, ready:true, reasons:[] } (không chặn).
// "on" ⇒ cần scheduler + everyHours + lần sao lưu gần nhất ≤ 2×everyHours + đã khôi phục thử.
// Trả { applicable, ready, reasons:[{code,text}] }.
export function backupReady(state, now = Date.now()) {
  const b = isObj(state) && isObj(state.backup) ? state.backup : null
  if (!b || b.choice !== 'on') return { applicable: false, ready: true, reasons: [] }
  const codes = []
  const sch = b.scheduler
  if (!isObj(sch) || !sch.kind || !sch.id) codes.push('no-scheduler')
  const every = Number(b.everyHours)
  const hasEvery = Number.isFinite(every) && every > 0
  if (!hasEvery) codes.push('no-interval')
  const last = toMs(b.lastBackup)
  if (Number.isNaN(last)) codes.push('no-backup')
  else if (hasEvery && toMs(now) - last > 2 * every * HOUR_MS) codes.push('stale')
  if (Number.isNaN(toMs(b.lastRestoreCheck))) codes.push('no-restore-check')
  return { applicable: true, ready: codes.length === 0, reasons: codes.map((code) => ({ code, text: REASON_TEXT[code] })) }
}

// ---------- lời nhắc khi mở phiên ----------

// Trả mảng { kind, text, ... } (rỗng nếu không có gì). Thứ tự: check, backup, health. Hàm thuần.
//  - check: có mốc trong checkAt đã tới hạn (kèm `due` = các mốc đó; nơi gọi tự bỏ mốc đã xem khỏi checkAt).
//  - backup: đã phát hành mà chưa chọn sao lưu; hoặc choice "on" nhưng backupReady chưa đạt.
//  - health: > 30 ngày chưa khám (mốc = health.lastAt, chưa khám lần nào thì lấy lastRelease.at).
export function dueReminders(state, now = Date.now()) {
  if (!isObj(state)) return []
  const t = toMs(now)
  if (Number.isNaN(t)) return []
  const out = []

  const due = (Array.isArray(state.checkAt) ? state.checkAt : []).filter((x) => {
    const m = toMs(x)
    return !Number.isNaN(m) && m <= t
  })
  if (due.length) out.push({ kind: 'check', text: 'Đã tới mốc xem lỗi sau phát hành', due })

  const hasRelease = isObj(state.lastRelease) && !Number.isNaN(toMs(state.lastRelease.at))
  const choice = isObj(state.backup) ? state.backup.choice : undefined
  if (!choice && hasRelease) {
    out.push({ kind: 'backup', text: 'Chưa chọn có sao lưu dữ liệu hay không' })
  } else {
    const br = backupReady(state, now)
    if (br.applicable && !br.ready) {
      out.push({ kind: 'backup', text: `Sao lưu chưa đạt: ${br.reasons.map((r) => r.text.toLowerCase()).join('; ')}`, reasons: br.reasons })
    }
  }

  const base = toMs(isObj(state.health) && state.health.lastAt ? state.health.lastAt : (hasRelease ? state.lastRelease.at : undefined))
  if (!Number.isNaN(base) && t - base > HEALTH_DAYS * DAY_MS) {
    out.push({ kind: 'health', text: `Hơn ${HEALTH_DAYS} ngày chưa khám sức khoẻ ứng dụng` })
  }
  return out
}
