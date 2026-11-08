// Nhiều tài khoản Codex trên một máy (chốt 0ufuusz3): mỗi tài khoản là một thư mục CODEX_HOME có auth.json
// (~/.codex, ~/.codex-2, ~/.codex-cong-ty…). Kit gọi Codex làm việc phụ (soát code, soát plan, tìm lỗi) ⇒ thử tài khoản
// chưa bị ghi là hết lượt; hết lượt ⇒ ghi lại tới lúc mở lại, báo một dòng, sang tài khoản kế. Chỉ áp cho lượt kit gọi,
// không đụng phiên Codex user đang chat (chốt ez3k9cjd). Không đọc nội dung auth.json, chỉ xem file có tồn tại.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_WAIT_MS = 60 * 60 * 1000
const MAX_WAIT_MS = 40 * 24 * 60 * 60 * 1000 // gói miễn phí có thể khoá cả tháng
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 }

export const statePath = (home = os.homedir()) => path.join(home, '.claude', 'cache', 'codex-het-luot.json')

/** Tên ngắn cho user: ~/.codex ⇒ "1", ~/.codex-2 ⇒ "2", ~/.codex-cong-ty ⇒ "cong-ty". */
export function label(dir) {
  const b = path.basename(dir)
  return b === '.codex' ? '1' : b.replace(/^\.codex-/, '')
}

/**
 * Danh sách tài khoản theo thứ tự thử: FLOW_CODEX_HOMES (cách nhau bằng path.delimiter) nếu có; không thì CODEX_HOME
 * hiện tại (hoặc ~/.codex) trước, rồi các ~/.codex-* có auth.json theo tên.
 */
export function listHomes({ env = process.env, home = os.homedir(), exists = fs.existsSync, readdir = fs.readdirSync } = {}) {
  const hasAuth = (d) => exists(path.join(d, 'auth.json'))
  if (env.FLOW_CODEX_HOMES) {
    return [...new Set(env.FLOW_CODEX_HOMES.split(path.delimiter).filter(Boolean).map((d) => path.resolve(d)))].filter(hasAuth)
  }
  const first = path.resolve(env.CODEX_HOME || path.join(home, '.codex'))
  let others = []
  try { others = readdir(home).filter((n) => /^\.codex(?:-[\w.-]+)?$/.test(n)).sort().map((n) => path.join(home, n)) } catch {}
  const all = [...new Set([first, ...others.map((d) => path.resolve(d))])]
  return all.filter((d, i) => (i === 0 && exists(d)) || hasAuth(d))
}

/**
 * Thời gian chờ tới lúc mở lại: "try again in 2 days 3 hours" / "in 45 minutes" / "in 1h 20m", hoặc ngày cụ thể
 * "try again at Dec 5th, 2026 1:53 PM" (giờ máy) [KIỂM 2026-11-08, Codex gói miễn phí]. Không đọc được ⇒ 1 giờ.
 */
export function waitMs(text, now = Date.now()) {
  const s = String(text ?? '')
  const at = /(?:try again|resets?|available again)\s+(?:at|on)\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:,?\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:[AP]M)?(?:\s*(?:UTC|GMT|[+-]\d{2}:?\d{2}))?)?)/i.exec(s)
  if (at) {
    const t = Date.parse(at[1].replace(/(\d)(?:st|nd|rd|th)/i, '$1').replace(/,?\s+at\s+/i, ' ').replace(/\.(?=\s)/, ''))
    if (Number.isFinite(t) && t > now) return Math.min(Math.max(t - now, 60_000), MAX_WAIT_MS)
  }
  const m = /(?:try again|resets?|available again)[^.\n]*?\bin\s+((?:\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)[\s,and]*)+)/i.exec(s)
  if (!m) return DEFAULT_WAIT_MS
  let ms = 0
  for (const [, n, u] of m[1].matchAll(/(\d+)\s*([dhm])/gi)) ms += Number(n) * UNIT_MS[u.toLowerCase()]
  return Math.min(Math.max(ms, 60_000), MAX_WAIT_MS)
}

export function readState(file = statePath()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch { return {} }
}

// Đổi đúng một mục: đọc lại sổ ngay trước khi ghi (lượt Codex khác có thể vừa ghi tài khoản khác), ghi qua file tạm rồi rename.
/** Khoá sổ cho một thư mục tài khoản: đường dẫn tuyệt đối; Windows không phân biệt hoa thường ⇒ hạ chữ thường. Mọi nơi đọc/ghi sổ dùng hàm này. */
export const homeKey = (p, platform = process.platform) => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))

function updateState(file, dir, entry) {
  try {
    const state = readState(file)
    const k = homeKey(dir)
    const same = Object.keys(state).filter((x) => homeKey(x) === k)
    if (!entry && !same.length) return
    for (const x of same) delete state[x]
    if (entry) state[k] = entry
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } catch {} // không ghi được ⇒ lần sau thử lại từ đầu, không hỏng lượt gọi
}

/** Ghi tài khoản `dir` hết lượt tới giờ mở lại đọc từ `text` (dùng cả khi phiên Codex trong Paseo báo hết lượt). Trả mốc mở lại. */
export function markSpent(dir, text, { file = statePath(), now = Date.now() } = {}) {
  const until = now + waitMs(text, now)
  updateState(file, path.resolve(dir), { until, at: new Date(now).toISOString() })
  return until
}

// Hết lượt thật chỉ nằm ở dòng lỗi cuối của Codex ("ERROR: You've hit your usage limit…"), không phải ở prompt hay đầu ra lệnh
// mà Codex in lại trong nhật ký (prompt có chữ "usage limit" không được làm khoá tài khoản). "rate limit"/429 là nghẽn thoáng qua,
// Codex tự thử lại ⇒ không đổi tài khoản.
const QUOTA_STRICT = /usage[ _]limit|hit your (?:usage )?limit|quota (?:exceeded|exhausted|reached)|insufficient[ _]quota|out of (?:credits|usage)/i
const ERROR_LINE = /^\s*(?:ERROR|Error|error)\b|usage_limit_reached|insufficient_quota/
export function quotaText(r) {
  if (r.timedOut || r.error) return null
  const tail = `${r.stderr ?? ''}\n${String(r.stdout ?? '').slice(-2000)}`.replace(/\r/g, '').split('\n').slice(-40)
  const lines = tail.filter((l) => ERROR_LINE.test(l) && QUOTA_STRICT.test(l))
  return lines.length ? lines.join('\n') : null
}

/** Tài khoản còn lượt trước (giữ thứ tự), tài khoản đang hết lượt xếp sau theo giờ mở lại sớm nhất. */
export function order(homes, state, now = Date.now()) {
  const byKey = new Map(Object.entries(state ?? {}).map(([k, v]) => [homeKey(k), v]))
  const until = (d) => Number(byKey.get(homeKey(d))?.until ?? 0)
  const live = homes.filter((d) => until(d) <= now)
  const spent = homes.filter((d) => until(d) > now).sort((a, b) => until(a) - until(b))
  return { live, spent, list: [...live, ...spent] }
}

/**
 * runOnce(env) ⇒ { status, stdout, stderr, timedOut, error } (dạng runReviewer). ok(r) ⇒ lượt có kết quả dùng được.
 * Trả kết quả lượt cuối kèm `home`. Lỗi không phải hết lượt ⇒ dừng ngay, không đốt tài khoản khác.
 */
export async function runWithAccounts(runOnce, {
  env = process.env, home = os.homedir(), ok = (r) => r.status === 0, say = () => {}, now = () => Date.now(),
  file = statePath(home), homes = listHomes({ env, home }),
} = {}) {
  if (!homes.length) return { ...(await runOnce(env)), home: null }
  const { live, list: all } = order(homes, readState(file), now())
  // Còn tài khoản có lượt ⇒ chỉ thử các tài khoản đó; hết cả ⇒ thử đúng một tài khoản mở lại sớm nhất.
  const list = live.length ? live : all.slice(0, 1)
  if (!live.length) say(`Codex: mọi tài khoản đều đang hết lượt, vẫn thử tài khoản ${label(list[0])} (mở lại sớm nhất).`)
  let r
  for (let i = 0; i < list.length; i++) {
    const dir = list[i]
    r = await runOnce({ ...env, CODEX_HOME: dir })
    const quota = ok(r) ? null : quotaText(r)
    if (!quota) {
      updateState(file, dir, null)
      return { ...r, home: dir }
    }
    markSpent(dir, quota, { file, now: now() })
    const next = list[i + 1]
    say(next
      ? `Codex: tài khoản ${label(dir)} hết lượt ⇒ đã chuyển sang tài khoản ${label(next)}.`
      : `Codex: tài khoản ${label(dir)} cũng hết lượt — hết tài khoản Codex để thử.`)
  }
  return { ...r, home: list.at(-1), quota: true }
}
