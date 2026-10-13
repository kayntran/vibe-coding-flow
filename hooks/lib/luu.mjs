// luu: điểm lưu của dự án (chỉ trên máy) bằng git tag có chú thích `luu/<YYYYMMDD-HHmm>-<slug>`. Spec: docs/specs/2026-10-12-flow-v7-dot3 (AC-16, PLAN mục 2, [tl26]).
// CLI: hooks/luu.mjs. Lời nói với user nằm ở CLI; thư viện trả dữ liệu hoặc ném LuuError (exit 1 lỗi/từ chối · 2 dùng sai · 3 cần biết giữ/bỏ việc dở · 4 chạm file luật).
//
// Hàm xuất (đều nhận thư mục dự án làm đối số đầu):
//   bat(dir, { now })                  → { created, initialized, nested, root, tag?, commit? }   git init nếu chưa có + .gitignore + commit đầu + điểm "Bắt đầu"
//   tao(dir, name, { now })            → { created, tag, name, commit, files? }                 còn thay đổi chưa commit ⇒ lưu chúng thành commit mới (files) rồi gắn điểm; không còn gì dở và HEAD đã có điểm ⇒ trả điểm cũ (created=false)
//   ds(dir)                            → [{ tag, name, time, iso, commit, since }]              mới nhất trước; since = số việc kể từ điểm đó
//   tim(dir, query, { limit })         → [{ ...điểm, score, matched }]                          khớp không dấu trên tên + tiêu đề commit giữa các điểm; tên khớp nguyên văn đứng đầu, cụm từ liền nặng hơn khớp rời
//   xem(dir, tag)                      → { target, after, commits, commitCount, dirty, worktrees, unmerged, changes, ruleFiles, keptData, blocker }
//   quay(dir, tag, { viecDo, doiLuat, runCheck, now }) → { status: 'done'|'same', target, commit, tag, left, saved, restored, keptData, check }
//     xem/quay nhận tag (luu/… hoặc bỏ tiền tố) HOẶC tên đời thường khi khớp DUY NHẤT một điểm (nhiều điểm ⇒ exit 2 liệt kê để chọn).
//     viecDo 'giu' = cất việc dở thành điểm lưu RỒI đặt lại các file dở vào thư mục làm việc (chưa stage/commit) sau khi quay (restored = các file đó); 'bo' = cất rồi thôi.
//   dataGlobs(root) · excludeSpecs(globs) · DEFAULT_DATA  — ranh giới code/dữ liệu (mặc định + .claude/luu.json { "data": [glob…] })
//   defaultRunCheck(root) · checkSummary(report, { script, root }) — máy kiểm sau khi quay, chỉ MỘT dòng tổng (đạt / N mục chưa đạt + lệnh xem chi tiết)
//
// Ranh giới an toàn (đã soát):
//   - Không reset, không xoá tag/commit, không push. Quay = `git restore --source=<commit> --staged --worktree -- :/ <loại trừ dữ liệu>` rồi commit MỚI.
//   - Dữ liệu (db, data/, uploads/, storage/, trạng thái phát hành .claude/release.json + mẫu thêm trong .claude/luu.json) bị loại khỏi restore và khỏi việc dở; mẫu dữ liệu (trừ release.json) được thêm vào .gitignore.
//   - Việc dở luôn được lưu thành commit + điểm lưu trước khi quay (giữ hay bỏ đều không mất), sau khi quét khoá bí mật như cổng commit (lib/secrets.mjs, mirror flow-gate:
//     scanPatch + file nhạy cảm, quá giới hạn quét ⇒ từ chối). Có khoá ⇒ từ chối, chỉ in file:dòng + tên mẫu, không in giá trị; chỉ mục (index) được trả về như cũ.
//   - Quay mà diff HEAD → điểm đích chạm file luật (lib/rule-files.mjs), hoặc file luật trong việc dở khác điểm đích ⇒ exit 4, chỉ chạy với doiLuat.
//   - Commit "lưu tạm" và "Quay lại" chỉ lấy đường code (`:/` trừ dữ liệu, commit --only): dữ liệu đã stage giữ nguyên trạng thái stage, không vào commit.
//     Commit đầu của `bat` (chưa có HEAD nên lấy cả chỉ mục) cũng vậy: dữ liệu đã stage được gỡ khỏi chỉ mục trước khi commit rồi đặt lại đúng như cũ.
//   - Bản đã stage mà bản trên đĩa sắp ghi đè (file khác HEAD VÀ khác chỉ mục) được cất thành một commit RIÊNG ngay dưới commit lưu tạm (cây = HEAD + code đã stage; dữ liệu đã stage KHÔNG vào;
//     quét khoá như phần còn lại): lấy lại bằng `git show <điểm lưu>~1:<file>`. Lý do chọn commit cha thay vì merge: dãy first-parent (đếm "since", ds) không đổi cấu trúc.
//   - Commit của luu dùng --no-verify và tắt ký (gpgsign): đây là điểm lưu cục bộ, đã tự quét khoá ở trên; hook git của dự án (lint, husky) không được chặn đường cứu hộ.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRuleFile } from './rule-files.mjs'
import { isSensitiveFile, scanPatch } from './secrets.mjs'

const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAG_PREFIX = 'luu/'
const SCAN_LIMIT = 20 * 1024 * 1024
const MAX_BUFFER = 1 << 28

export class LuuError extends Error {
  constructor(message, { exit = 1, lines = [] } = {}) {
    super(message)
    this.name = 'LuuError'
    this.exit = exit
    this.lines = lines
  }
}

// ---------- chữ ----------

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
// Một dòng sạch: bỏ ký tự ẩn/điều khiển (tên điểm lưu và tiêu đề commit có thể do người khác viết; AI đọc đầu ra này), gộp khoảng trắng, NFC.
export function oneLine(s, max = 200) {
  const t = String(s ?? '').replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().normalize('NFC')
  const cps = Array.from(t)
  return cps.length > max ? `${cps.slice(0, max - 1).join('').trimEnd()}…` : t
}
export const plain = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
export function slugOf(name) {
  const words = plain(name).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  let s = ''
  for (const w of words) {
    const next = s ? `${s}-${w}` : w
    if (next.length > 40) break
    s = next
  }
  return s || words[0]?.slice(0, 40) || 'diem-luu'
}
const p2 = (n) => String(n).padStart(2, '0')
export const stampOf = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
export const timeText = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`

// ---------- đường dẫn ----------

const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const exists = (p) => { try { fs.lstatSync(p); return true } catch { return false } }
const real = (p) => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)
const same = (a, b) => fold(real(a)) === fold(real(b))
// Git bash đưa đường dẫn kiểu /c/Users/... — đổi sang C:/Users/... để Node hiểu.
const toNative = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p)

// ---------- git ----------

const DROP_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of DROP_ENV) delete env[k]
  return env
}

// env = biến môi trường thêm cho riêng lệnh này (vd GIT_INDEX_FILE trỏ chỉ mục tạm).
function run(cwd, args, { input, max = MAX_BUFFER, env } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', input, maxBuffer: max, windowsHide: true, env: env ? { ...gitEnv(), ...env } : gitEnv(), timeout: 300_000 })
  if (r.error && r.error.code === 'ENOENT') throw new LuuError('Máy chưa có git nên chưa làm điểm lưu được. Cài git rồi chạy lại.')
  return r
}

function subcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') { i++; continue }
    if (!args[i].startsWith('-')) return args[i]
  }
  return args[0]
}

function gitFail(args, r) {
  const err = String(r.stderr ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? ''
  const busy = /index\.lock|another git process/i.test(r.stderr ?? '')
  const msg = busy ? 'Có tiến trình git khác đang chạy trong dự án. Đợi nó xong rồi chạy lại (nếu chắc không còn, xoá file .git/index.lock).' : `git ${subcommand(args)} bị lỗi${err ? `: ${oneLine(err, 200)}` : ''}`
  return new LuuError(msg)
}

// stdout hoặc ném LuuError.
function git(cwd, args, opts) {
  const r = run(cwd, args, opts)
  if (r.status !== 0) throw gitFail(args, r)
  return r.stdout
}
// stdout hoặc null khi git trả lỗi.
function gitTry(cwd, args, opts) {
  const r = run(cwd, args, opts)
  return r.status === 0 ? r.stdout : null
}
// Như git() nhưng chỉ nhận tối đa SCAN_LIMIT byte: { text, truncated }.
function gitCapped(cwd, args) {
  const r = run(cwd, args, { max: SCAN_LIMIT })
  if (r.error?.code === 'ENOBUFS') return { text: typeof r.stdout === 'string' ? r.stdout : '', truncated: true }
  if (r.status !== 0) throw gitFail(args, r)
  return { text: r.stdout, truncated: false }
}

const NOT_GIT = 'Thư mục này chưa có điểm lưu (chưa dùng git). Chạy: luu.mjs bat <thư mục> để bắt đầu.'

// null khi không phải repo git; ném khi thư mục không có.
function openRepo(dir) {
  const abs = path.resolve(String(dir ?? ''))
  if (!dir || !isDir(abs)) throw new LuuError(`Không thấy thư mục dự án: ${oneLine(abs, 200)}`)
  const r = run(abs, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'])
  if (r.status !== 0) {
    if (/dubious ownership/i.test(r.stderr ?? '')) throw new LuuError('Git từ chối thư mục này vì nó thuộc về tài khoản khác. Nhờ chủ máy xác nhận thư mục an toàn (git config --global --add safe.directory) rồi chạy lại.')
    return null
  }
  const [top, gd, cd] = r.stdout.split(/\r?\n/)
  if (!top || !gd || !cd) return null
  const gitDir = path.resolve(abs, toNative(gd))
  const commonDir = path.resolve(abs, toNative(cd))
  return { dir: abs, root: path.resolve(toNative(top)), gitDir, commonDir, linked: !same(gitDir, commonDir) }
}
function needRepo(dir) {
  const repo = openRepo(dir)
  if (!repo) throw new LuuError(NOT_GIT)
  return repo
}
const headOf = (repo) => (gitTry(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) ?? '').trim() || null
function needHead(repo) {
  const head = headOf(repo)
  if (!head) throw new LuuError('Dự án này chưa có lần lưu nào (chưa có commit). Chạy: luu.mjs bat <thư mục> để lập điểm lưu đầu tiên.')
  return head
}
const shortOf = (repo, sha) => (gitTry(repo.root, ['rev-parse', '--short', sha]) ?? '').trim() || String(sha).slice(0, 7)

// Tên + email để commit/tag: dùng của người dùng, thiếu thì dùng tên chung để điểm lưu không hỏng vì máy chưa cài danh tính.
const identity = new Map()
function commitCfg(repo) {
  if (!identity.has(repo.root)) {
    const ok = (v) => run(repo.root, ['var', v]).status === 0
    identity.set(repo.root, ok('GIT_COMMITTER_IDENT') && ok('GIT_AUTHOR_IDENT') ? [] : ['-c', 'user.name=Flow', '-c', 'user.email=flow@localhost'])
  }
  return ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...identity.get(repo.root)]
}

// ---------- ranh giới code / dữ liệu ----------

// Trạng thái phát hành (bản đang chạy, đã thử quay lại, lựa chọn sao lưu, mốc khám) ghi sự thật BÊN NGOÀI repo ⇒ quay về điểm cũ không được kéo nó về bản cũ.
// Không vào .gitignore: lệnh khám sức khoẻ ghi mốc trong worktree rồi gộp nên file vẫn phải commit được.
const STATE_DATA = ['.claude/release.json']
export const DEFAULT_DATA = ['*.db', '*.sqlite', '*.sqlite3', '*.db-wal', '*.db-shm', 'data/**', 'uploads/**', 'storage/**', ...STATE_DATA]

function globProblem(g) {
  if (typeof g !== 'string' || !g.trim()) return 'phải là chuỗi không rỗng'
  if (/[\u0000-\u001f\u007f-\u009f]/.test(g)) return 'có ký tự điều khiển'
  const p = g.trim().replace(/\\/g, '/')
  if (p.startsWith(':') || p.startsWith('!')) return 'không được bắt đầu bằng ":" hoặc "!"'
  if (/^[a-zA-Z]:/.test(p)) return 'phải là đường dẫn tương đối trong dự án'
  if (p.split('/').includes('..')) return 'không được có ".."'
  return null
}

// Mẫu gốc → mẫu cho pathspec `glob`: có "/" ⇒ neo từ gốc dự án; không có "/" ⇒ khớp ở mọi thư mục; "x/" ⇒ "x/**".
function normGlob(g) {
  let p = g.trim().replace(/\\/g, '/')
  const anchored = p.startsWith('/') || p.startsWith('./')
  p = p.replace(/^\.?\//, '')
  if (p.endsWith('/')) p += '**'
  if (!anchored && !p.includes('/')) p = `**/${p}`
  return p
}

// Mặc định + `.claude/luu.json` { "data": [glob…] } của dự án. File hỏng ⇒ ném (không biết đâu là dữ liệu thì không dám quay).
export function dataGlobs(root) {
  const extra = []
  let raw = null
  try {
    raw = fs.readFileSync(path.join(root, '.claude', 'luu.json'), 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') throw new LuuError(`Không đọc được .claude/luu.json (${e.code ?? e.message}).`)
  }
  if (raw !== null) {
    let cfg
    try { cfg = JSON.parse(raw.replace(/^\ufeff/, '')) } catch { throw new LuuError('.claude/luu.json không đọc được. Sửa lại dạng: { "data": ["thư-mục/**", "*.db"] }') }
    const list = cfg?.data
    if (list !== undefined) {
      if (!Array.isArray(list)) throw new LuuError('.claude/luu.json: "data" phải là danh sách mẫu, vd { "data": ["exports/**"] }')
      for (const g of list) {
        const bad = globProblem(g)
        if (bad) throw new LuuError(`.claude/luu.json: mẫu ${JSON.stringify(oneLine(g, 80))} ${bad}.`)
        extra.push(g)
      }
    }
  }
  return [...DEFAULT_DATA, ...extra]
}
export const excludeSpecs = (globs) => globs.map((g) => `:(exclude,glob,top)${normGlob(g)}`)
const includeSpecs = (globs) => globs.map((g) => `:(glob,top)${normGlob(g)}`)
// Dòng .gitignore tương ứng: "x/**" ⇒ "/x/" (neo gốc); có "/" ⇒ neo gốc; không "/" ⇒ giữ nguyên.
function toGitignore(g) {
  let p = g.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (p.endsWith('/**')) p = p.slice(0, -2)
  if (p.includes('/') && !p.startsWith('/')) p = `/${p}`
  return p
}

// ---------- điểm lưu ----------

// Danh sách điểm lưu nằm trong lịch sử HEAD, mới nhất trước.
function listPoints(repo) {
  const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(creatordate:unix)', '%(contents:subject)'].join('%00')
  const out = git(repo.root, ['for-each-ref', '--merged=HEAD', `--format=${fmt}`, `refs/tags/${TAG_PREFIX}`])
  const chain = git(repo.root, ['rev-list', '--first-parent', 'HEAD']).split(/\r?\n/).filter(Boolean)
  const idx = new Map(chain.map((c, i) => [c, i]))
  const points = []
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue
    const [ref, obj, peeled, ts, subject] = line.split('\0')
    const commit = peeled || obj
    const t = Number(ts) || 0
    const when = new Date(t * 1000)
    let since = idx.get(commit)
    if (since === undefined) since = Number((gitTry(repo.root, ['rev-list', '--first-parent', '--count', `${commit}..HEAD`]) ?? '0').trim()) || 0
    points.push({ tag: ref.replace(/^refs\/tags\//, ''), name: oneLine(subject, 160), commit, ts: t, time: timeText(when), iso: when.toISOString(), since })
  }
  return points.sort((a, b) => a.since - b.since || b.ts - a.ts || (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0))
}

// Chữ không dấu, không hoa thường, tách thành từ; inWords: `needle` là cụm từ LIỀN NHAU, nguyên cả từ, nằm trong `hay`.
const wordsOf = (s) => plain(s).split(/[^a-z0-9]+/).filter(Boolean)
const inWords = (hay, needle) => needle.length > 0 && ` ${hay.join(' ')} `.includes(` ${needle.join(' ')} `)

// Điểm lưu có tên đời thường khớp `query`: khớp nguyên văn thắng; không có thì lấy các điểm có tên chứa cụm đó (nguyên cả từ).
function pointsByName(points, query) {
  const q = wordsOf(query)
  if (!q.length) return []
  const exact = points.filter((p) => wordsOf(p.name).join(' ') === q.join(' '))
  return exact.length ? exact : points.filter((p) => inWords(wordsOf(p.name), q))
}

// arg = tag (luu/… hoặc bỏ tiền tố luu/) hoặc tên đời thường khi khớp DUY NHẤT một điểm; nhiều điểm ⇒ exit 2 liệt kê để chọn. Chuỗi bắt đầu bằng "luu/" luôn là tag, không đoán theo tên.
function resolvePoint(repo, arg) {
  const raw = String(arg ?? '').trim()
  if (!raw) throw new LuuError('Thiếu tên điểm lưu. Xem danh sách: luu.mjs ds <thư mục>', { exit: 2 })
  const name = raw.startsWith(TAG_PREFIX) ? raw : `${TAG_PREFIX}${raw}`
  const valid = gitTry(repo.root, ['check-ref-format', `refs/tags/${name}`]) !== null
  const points = listPoints(repo)
  const hit = valid ? points.find((p) => p.tag === name) : null
  if (hit) return hit
  const known = valid && gitTry(repo.root, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]) !== null
  if (known) throw new LuuError(`Điểm lưu "${oneLine(name, 120)}" không nằm trong lịch sử nhánh chính hiện tại nên không dùng được.`)
  if (!raw.startsWith(TAG_PREFIX)) {
    const named = pointsByName(points, raw)
    if (named.length === 1) return named[0]
    if (named.length > 1) {
      throw new LuuError(`Có ${named.length} điểm lưu khớp "${oneLine(raw, 100)}" — gõ rõ hơn hoặc dùng tên đầy đủ:`, {
        exit: 2, lines: [...named.slice(0, 10).map((p) => `- "${p.name}" (${p.time}) ${p.tag}`), ...(named.length > 10 ? [`- …và ${named.length - 10} điểm nữa`] : [])],
      })
    }
  }
  throw new LuuError(`Không có điểm lưu "${oneLine(raw, 120)}". Xem danh sách: luu.mjs ds <thư mục>`)
}

function cleanName(name) {
  const n = oneLine(name, 120)
  if (!n) throw new LuuError('Thiếu tên điểm lưu (viết bằng lời thường, vd "Thêm trang đăng nhập").', { exit: 2 })
  return n
}

// Điểm lưu có sẵn trên một commit (newest trước), hoặc null.
function pointAt(repo, commit) {
  const out = git(repo.root, ['for-each-ref', `--points-at=${commit}`, '--format=%(refname)%00%(contents:subject)', `refs/tags/${TAG_PREFIX}`])
  const rows = out.split(/\r?\n/).filter(Boolean).map((l) => l.split('\0'))
  if (!rows.length) return null
  rows.sort((a, b) => (a[0] < b[0] ? 1 : -1))
  return { tag: rows[0][0].replace(/^refs\/tags\//, ''), name: oneLine(rows[0][1], 160), commit }
}

function makePoint(repo, commit, name, now) {
  const base = `${TAG_PREFIX}${stampOf(now)}-${slugOf(name)}`
  let tag = base
  for (let n = 2; gitTry(repo.root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) !== null; n++) tag = `${base}-${n}`
  git(repo.root, [...commitCfg(repo), 'tag', '-a', '-F', '-', tag, commit], { input: `${name}\n` })
  return { tag, name, commit }
}

// Còn thay đổi chưa commit ⇒ lưu chúng thành commit mới (cùng đường với "lưu tạm" của quay: quét khoá, trừ dữ liệu) rồi gắn điểm ở đó; `files` = các file đã lưu.
// Không còn gì dở và HEAD đã là điểm lưu ⇒ trả điểm cũ (created=false). Nếu không, tạo điểm ở HEAD.
export function tao(dir, name, { now = new Date() } = {}) {
  const label = cleanName(name)
  const repo = needRepo(dir)
  needHead(repo)
  const ex = excludeSpecs(dataGlobs(repo.root))
  const files = unsavedFiles(repo, ex)
  if (files.length) {
    guardGitIdle(repo, 'lưu thay đổi')
    const saved = stageScanCommit(repo, ex, label)
    if (saved) return { created: true, ...makePoint(repo, saved, label, now), files }
  }
  const old = pointAt(repo, headOf(repo))
  if (old) return { created: false, ...old }
  return { created: true, ...makePoint(repo, headOf(repo), label, now) }
}

export function ds(dir) {
  const repo = needRepo(dir)
  needHead(repo)
  return listPoints(repo).map(({ tag, name, time, iso, commit, since }) => ({ tag, name, time, iso, commit: shortOf(repo, commit), since }))
}

// ---------- quét khoá + commit ----------

// specs = phạm vi sẽ vào commit (mặc định cả chỉ mục); dữ liệu đang stage nằm ngoài phạm vi thì không bị quét (nó không vào commit).
function scanStaged(repo, specs = []) {
  const common = ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-prefix']
  const tail = specs.length ? ['--', ...specs] : []
  const patch = gitCapped(repo.root, [...common, '-U0', ...tail])
  const { findings, allowed } = scanPatch(patch.text)
  const names = gitCapped(repo.root, [...common, '--name-only', '-z', '--diff-filter=ACMR', ...tail])
  for (const f of names.text.split('\0')) {
    if (f && isSensitiveFile(f) && !allowed.has(f)) findings.push({ file: f, line: null, name: 'file nhạy cảm' })
  }
  return { findings, truncated: patch.truncated || names.truncated }
}

// Chặn khi staged có khoá bí mật (hoặc quá lớn để quét). Trả chỉ mục về như cũ trước khi ném. before = cây của chỉ mục lúc chưa stage.
function refuseSecrets(repo, before, specs = []) {
  const { findings, truncated } = scanStaged(repo, specs)
  if (!findings.length && !truncated) return
  git(repo.root, ['read-tree', before])
  const list = [...new Set(findings.map((f) => (f.line == null ? `${f.file} — ${f.name}` : `${f.file}:${f.line} — ${f.name}`)))]
  const shown = list.slice(0, 10).join('; ') + (list.length > 10 ? `; …và ${list.length - 10} mục nữa` : '')
  if (findings.length) {
    throw new LuuError(`Có thứ giống mật khẩu hoặc khoá bí mật trong phần sắp lưu nên chưa lưu gì cả: ${shown}. Gỡ chúng ra (dùng biến môi trường, hoặc thêm file vào .gitignore) rồi chạy lại. Nếu báo nhầm: thêm comment "flow-gate: allow-secret" vào dòng đó.`)
  }
  throw new LuuError(`Phần sắp lưu quá lớn (vượt ${SCAN_LIMIT / 1048576} MB) để kiểm có lộ khoá bí mật không nên chưa lưu gì cả. Thêm các file lớn không cần giữ vào .gitignore rồi chạy lại.`)
}

// Stage mọi thứ trừ dữ liệu (file mới, sửa, xoá; bỏ qua file bị .gitignore). Liệt kê tên rồi add đúng tên đó, không dùng `git add -- :/ :(exclude…)`:
// git báo lỗi "paths are ignored" khi mẫu loại trừ trùng một thư mục đã nằm trong .gitignore (vd data/).
function stageAll(repo, ex) {
  const names = git(repo.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':/', ...ex]).split('\0').filter(Boolean)
  inChunks(new Set(names), (chunk) => git(repo.root, ['--literal-pathspecs', 'add', '-A', '--', ...chunk]))
}

// Gọi fn(mảng tên file) từng lô sao cho dòng lệnh dưới giới hạn của Windows.
function inChunks(names, fn) {
  let chunk = []
  let size = 0
  const flush = () => {
    if (chunk.length) fn(chunk)
    chunk = []
    size = 0
  }
  for (const f of names) {
    if (size + f.length > 16000) flush()
    chunk.push(f)
    size += f.length + 1
  }
  flush()
}

// Dữ liệu đang stage khi chưa có commit đầu (vd `git add -f app.db`): gỡ khỏi chỉ mục để không lọt vào commit đầu. Trả bản ghi để đặt lại đúng như cũ (restoreStagedData), '' nếu không có.
function holdStagedData(repo, globs) {
  const staged = git(repo.root, ['ls-files', '-s', '-z', '--', ...includeSpecs(globs)])
  if (!staged) return ''
  const paths = staged.split('\0').filter(Boolean).map((l) => l.slice(l.indexOf('\t') + 1))
  git(repo.root, ['update-index', '--force-remove', '-z', '--stdin'], { input: `${paths.join('\0')}\0` })
  return staged
}
const restoreStagedData = (repo, held) => { if (held) git(repo.root, ['update-index', '-z', '--index-info'], { input: held }) }

// stageAll ghi đè chỉ mục bằng bản trên đĩa. Bản đã stage bị mất khi có file vừa khác HEAD (đã stage trong phạm vi) vừa khác chỉ mục (đĩa đã sửa tiếp / xoá / về lại bản HEAD).
function stagedWouldBeLost(repo, scope) {
  const names = (cached) => new Set(git(repo.root, ['diff', ...(cached ? ['--cached'] : []), '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--', ...scope]).split('\0').filter(Boolean))
  const staged = names(true)
  if (!staged.size) return false
  const onDisk = names(false)
  return [...staged].some((f) => onDisk.has(f))
}

// Commit (chưa nối vào nhánh) giữ nguyên bản đã stage: cây = HEAD + phần code đã stage trong `scope`; dữ liệu giữ như HEAD nên dữ liệu đã stage không vào. Dựng trên chỉ mục tạm, chỉ mục thật không bị đụng.
// head = null (bat: repo chưa có commit, dữ liệu đã được gỡ khỏi chỉ mục trước đó) ⇒ cây = `before`, không có commit cha.
function stagedCommit(repo, head, before, scope) {
  let tree = before
  if (head) {
    const raw = git(repo.root, ['diff-index', '--cached', '-z', '--raw', '--no-renames', head, '--', ...scope]).split('\0')
    let info = ''
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const [, mode, , sha] = raw[i].split(' ') // ":<mode cũ> <mode mới> <sha cũ> <sha mới> <trạng thái>"
      info += `${/^0+$/.test(mode) ? '0' : mode} ${sha} 0\t${raw[i + 1]}\0` // mode 0 = gỡ file khỏi cây
    }
    const env = { GIT_INDEX_FILE: path.join(repo.gitDir, `luu-tmp-index-${process.pid}`) }
    try {
      git(repo.root, ['read-tree', head], { env })
      git(repo.root, ['update-index', '-z', '--index-info'], { input: info, env })
      tree = git(repo.root, ['write-tree'], { env }).trim()
    } finally {
      fs.rmSync(env.GIT_INDEX_FILE, { force: true })
    }
  }
  return git(repo.root, [...commitCfg(repo), 'commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { input: 'Bản đã stage — cất trước khi lưu bản trên đĩa\n' }).trim()
}

// Stage mọi thứ (trừ dữ liệu), quét khoá, rồi commit; trả commit mới, hoặc null khi stage xong mà không có gì khác HEAD (vd chỉ đổi kiểu xuống dòng).
// Ném (đã trả chỉ mục về như cũ) khi có khoá.
// Có HEAD (allowEmpty=false) ⇒ quét, kiểm khác biệt và commit đều CHỈ trên `:/` trừ dữ liệu (commit --only): dữ liệu user đã stage vẫn ở trạng thái stage, không vào commit.
// Bản đã stage sắp bị bản trên đĩa ghi đè (stagedWouldBeLost) ⇒ quét khoá rồi cất thành commit riêng làm CHA của commit đĩa: lấy lại bằng `git show <điểm lưu>~1:<file>`.
function stageScanCommit(repo, ex, message, { allowEmpty = false } = {}) {
  const scope = allowEmpty ? [] : [':/', ...ex]
  const before = git(repo.root, ['write-tree']).trim()
  const oldHead = headOf(repo)
  let keep = null
  if (stagedWouldBeLost(repo, scope)) {
    refuseSecrets(repo, before, scope)
    keep = stagedCommit(repo, oldHead, before, scope)
  }
  try {
    stageAll(repo, ex)
  } catch (e) {
    git(repo.root, ['read-tree', before])
    throw e
  }
  refuseSecrets(repo, before, scope)
  // Commit cất bản stage chỉ nối vào nhánh sau khi bản đĩa đã qua quét khoá; commit đĩa hỏng ⇒ gỡ ra lại (nhánh về đúng chỗ cũ).
  let linked = false // chỉ gỡ commit cất khi nó đã nối vào nhánh thành công
  const undoKeep = () => { if (linked) git(repo.root, oldHead ? ['update-ref', 'HEAD', oldHead, keep] : ['update-ref', '-d', 'HEAD', keep]) }
  try {
    if (keep) {
      git(repo.root, ['update-ref', '-m', 'luu: cất bản đã stage', 'HEAD', keep, oldHead ?? ''])
      linked = true
    }
    if (!allowEmpty && run(repo.root, ['diff', '--cached', '--quiet', '--', ...scope]).status === 0) return keep ? headOf(repo) : null
    git(repo.root, [...commitCfg(repo), 'commit', '--no-verify', '-q', ...(allowEmpty ? ['--allow-empty'] : []), '-F', '-', ...(scope.length ? ['--', ...scope] : [])], { input: `${message}\n` })
  } catch (e) {
    undoKeep()
    git(repo.root, ['read-tree', before])
    throw e
  }
  return headOf(repo)
}

// ---------- bat ----------

const BASE_IGNORE = ['node_modules/', 'dist/', 'build/', '.env', '.env.*', '!.env.example']
const ignoreKey = (l) => l.trim().replace(/^\//, '').replace(/\/$/, '')
// Wails giữ icon/manifest trong build/, chỉ build/bin/ là bản dựng ⇒ không bỏ cả build/.
const baseIgnore = (root) => (isFile(path.join(root, 'wails.json')) ? BASE_IGNORE.map((l) => (l === 'build/' ? 'build/bin/' : l)) : BASE_IGNORE)

function ensureGitignore(root, globs) {
  const file = path.join(root, '.gitignore')
  const cur = isFile(file) ? fs.readFileSync(file, 'utf8') : null
  const have = new Set((cur ?? '').split(/\r?\n/).map(ignoreKey))
  const want = [...baseIgnore(root), ...globs.filter((g) => !STATE_DATA.includes(g)).map(toGitignore)].filter((l, i, a) => a.findIndex((x) => ignoreKey(x) === ignoreKey(l)) === i)
  const missing = want.filter((l) => !have.has(ignoreKey(l)))
  if (cur === null) {
    fs.writeFileSync(file, `# điểm lưu (luu.mjs): giữ khoá bí mật, thư viện cài sẵn và dữ liệu ngoài git\n${want.join('\n')}\n`)
  } else if (missing.length) {
    fs.writeFileSync(file, `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}\n# điểm lưu (luu.mjs): giữ khoá bí mật, thư viện cài sẵn và dữ liệu ngoài git\n${missing.join('\n')}\n`)
  }
}

export function bat(dir, { now = new Date() } = {}) {
  let repo = openRepo(dir)
  let initialized = false
  if (repo && !same(repo.dir, repo.root)) return { created: false, initialized: false, nested: true, root: repo.root }
  if (repo && headOf(repo)) return { created: false, initialized: false, nested: false, root: repo.root }
  if (!repo) {
    const abs = path.resolve(dir)
    const r = run(abs, ['init', '-q', '-b', 'main'])
    if (r.status !== 0) {
      const old = run(abs, ['init', '-q'])
      if (old.status !== 0) throw gitFail(['init'], old)
      git(abs, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    }
    initialized = true
    repo = needRepo(abs)
  }
  const globs = dataGlobs(repo.root)
  ensureGitignore(repo.root, globs)
  // Commit đầu chưa có HEAD nên commit lấy cả chỉ mục: dữ liệu đã stage từ trước phải gỡ ra rồi đặt lại (như quay: dữ liệu không vào commit, vẫn ở trạng thái stage).
  const held = holdStagedData(repo, globs)
  let commit
  try {
    commit = stageScanCommit(repo, excludeSpecs(globs), 'Bắt đầu', { allowEmpty: true })
  } finally {
    restoreStagedData(repo, held)
  }
  return { created: true, initialized, nested: false, root: repo.root, ...makePoint(repo, commit, 'Bắt đầu', now) }
}

// ---------- tim ----------

const STOP = new Set(['quay', 've', 'luc', 'lai', 'diem', 'luu', 'toi', 'muon', 'hay', 'cho', 'khi'])

export function tim(dir, query, { limit = 5 } = {}) {
  const repo = needRepo(dir)
  needHead(repo)
  const all = plain(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 || /\d/.test(t))
  const kept = all.filter((t) => !STOP.has(t))
  const tokens = [...new Set(kept.length ? kept : all)]
  if (!tokens.length) return []
  const points = listPoints(repo)
  // tiêu đề commit "giữa các điểm": từ sau điểm cũ hơn liền kề tới điểm này (đi theo nhánh chính)
  const chain = git(repo.root, ['log', '--first-parent', '--format=%H%x00%s', 'HEAD']).split(/\r?\n/).filter(Boolean).map((l) => { const [sha, subject] = l.split('\0'); return { sha, subject } })
  const at = new Map()
  for (const p of points) at.set(p.commit, [...(at.get(p.commit) ?? []), p])
  const between = new Map()
  let pending = []
  for (const { sha, subject } of chain.reverse()) {
    pending.push(oneLine(subject, 160))
    for (const p of at.get(sha) ?? []) between.set(p.tag, pending.slice())
    if (at.has(sha)) pending = []
  }
  // token khớp khi là TIỀN TỐ của một từ không dấu ("dang nhap" khớp "đăng nhập"); token 2 ký tự phải khớp nguyên từ (tránh "gi" dính "giỏ")
  // Xếp hạng: tên điểm khớp NGUYÊN VĂN cả câu (không dấu, không hoa thường; "trước"/"sau" là từ phân biệt, không bỏ) vượt hẳn mọi thứ khác; cụm từ liền nhau trong tên nặng hơn khớp rời
  // (hơn cả tổng khớp rời + commit); còn lại tính từ rời trong tên (3) và trong tiêu đề commit giữa các điểm (1).
  const typed = wordsOf(query)
  const startsWith = (w, t) => (t.length >= 3 ? w.startsWith(t) : w === t)
  const EXACT = 1000
  const PHRASE = 20
  const out = []
  for (const p of points) {
    const subjects = between.get(p.tag) ?? [oneLine(gitTry(repo.root, ['log', '-1', '--format=%s', p.commit]) ?? '', 160)]
    const nameW = wordsOf(p.name)
    const subjW = subjects.map((s) => ({ s, w: wordsOf(s) }))
    let score = 0
    const hit = new Set()
    for (const t of tokens) {
      if (nameW.some((w) => startsWith(w, t))) { score += 3; hit.add(t) }
      if (subjW.some(({ w }) => w.some((x) => startsWith(x, t)))) { score += 1; hit.add(t) }
    }
    if (!score) continue
    const nameText = nameW.join(' ')
    if (nameText === typed.join(' ') || (kept.length && nameText === kept.join(' '))) score += EXACT
    else if ((all.length > 1 && inWords(nameW, all)) || (tokens.length > 1 && inWords(nameW, tokens))) score += PHRASE
    out.push({
      tag: p.tag, name: p.name, time: p.time, iso: p.iso, commit: shortOf(repo, p.commit), since: p.since, score,
      matched: { tokens: [...hit], subjects: subjW.filter(({ w }) => tokens.some((t) => w.some((x) => startsWith(x, t)))).map(({ s }) => s).slice(0, 3) },
    })
  }
  return out.sort((a, b) => b.score - a.score || a.since - b.since).slice(0, limit)
}

// ---------- xem / quay: dữ liệu chung ----------

// Việc đang dở (đã sửa chưa commit + file mới chưa theo dõi), không tính dữ liệu và file bị .gitignore.
function dirtyFiles(repo, ex) {
  const out = git(repo.root, ['status', '--porcelain', '-z', '--', ':/', ...ex])
  const t = out.split('\0')
  const files = []
  for (let i = 0; i < t.length; i++) {
    const e = t[i]
    if (!e) continue
    files.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C' || e[1] === 'R' || e[1] === 'C') i++
  }
  return files
}

// File code trên đĩa khác HEAD (đã stage hay chưa) + file mới chưa theo dõi (không kể file bị .gitignore), trừ dữ liệu: những gì một điểm lưu ở HEAD sẽ KHÔNG chứa.
// Bản đã stage mà đĩa lại trùng HEAD không tính: đĩa không có gì để lưu (tao không đụng chỉ mục).
function unsavedFiles(repo, ex) {
  const scope = ['--', ':/', ...ex]
  const tracked = git(repo.root, ['diff', 'HEAD', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', ...scope]).split('\0')
  const fresh = git(repo.root, ['ls-files', '-z', '--others', '--exclude-standard', ...scope]).split('\0')
  return [...new Set([...tracked, ...fresh].filter(Boolean))]
}

// File sẽ đổi khi quay từ `from` tới `to`: [{ st: 'A'|'M'|'D'|'T', file }] (A = thêm lại, D = sẽ bị gỡ). specs = cả danh sách pathspec (có ':/' nếu muốn xét hết).
// to = null ⇒ so `from` với cây làm việc (file đã theo dõi): chiều ngược lại (A = có ở cây làm việc mà `from` không có).
function diffStatus(repo, from, to, specs) {
  const out = git(repo.root, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', ...[from, to].filter(Boolean), '--', ...specs])
  const t = out.split('\0')
  const list = []
  for (let i = 0; i + 1 < t.length; i += 2) list.push({ st: t[i].charAt(0), file: t[i + 1] })
  return list
}

// File luật nằm trong việc dở (đã stage, chưa stage, hay mới chưa theo dõi) mà khác nội dung đích: quay lưu tạm việc dở rồi restore về đích nên cũng sẽ đổi chúng,
// kể cả khi HEAD đã là đích. Cùng dạng với diffStatus(HEAD → đích): A = thêm lại, D = sẽ bị gỡ.
function dirtyRuleChanges(repo, to, ex) {
  const flip = { A: 'D', D: 'A' }
  const out = diffStatus(repo, to, null, [':/', ...ex]).filter((c) => isRuleFile(c.file)).map((c) => ({ st: flip[c.st] ?? c.st, file: c.file }))
  const seen = new Set(out.map((c) => c.file))
  for (const f of git(repo.root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ':/', ...ex]).split('\0')) {
    if (!f || seen.has(f) || !isRuleFile(f)) continue
    const theirs = gitTry(repo.root, ['cat-file', 'blob', `${to}:${f}`])
    let mine = null
    try { mine = fs.readFileSync(path.join(repo.root, f), 'utf8') } catch { /* không đọc được ⇒ coi là khác */ }
    if (theirs === null) out.push({ st: 'D', file: f })
    else if (theirs !== mine) out.push({ st: 'M', file: f })
  }
  return out
}

// File luật quay sẽ đổi: lệch giữa HEAD và đích (changes) + file luật trong việc dở khác đích.
function ruleChanges(repo, to, changes, ex, dirty) {
  const list = changes.filter((c) => isRuleFile(c.file))
  if (!dirty.length) return list
  const seen = new Set(list.map((c) => c.file))
  return [...list, ...dirtyRuleChanges(repo, to, ex).filter((c) => !seen.has(c.file))]
}

function otherWorktrees(repo) {
  const out = gitTry(repo.root, ['worktree', 'list', '--porcelain']) ?? ''
  const items = []
  let cur = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: path.resolve(toNative(line.slice(9))), branch: null, skip: false }; items.push(cur) }
    else if (!cur) continue
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'bare' || line.startsWith('prunable')) cur.skip = true
  }
  return items.filter((w) => !w.skip && !same(w.path, repo.root)).map((w) => ({ path: w.path, branch: w.branch }))
}

const IN_PROGRESS = [['rebase-merge', 'đang dở một lần rebase'], ['rebase-apply', 'đang dở một lần rebase'], ['MERGE_HEAD', 'đang dở một lần gộp nhánh'],
  ['CHERRY_PICK_HEAD', 'đang dở một lần cherry-pick'], ['REVERT_HEAD', 'đang dở một lần revert'], ['BISECT_LOG', 'đang dở một lần bisect']]

function isMainBranch(repo, branch) {
  const names = new Set()
  const oh = (gitTry(repo.root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']) ?? '').trim()
  if (oh) names.add(oh.replace(/^[^/]+\//, ''))
  for (const n of ['main', 'master']) if (gitTry(repo.root, ['show-ref', '--verify', '--quiet', `refs/heads/${n}`]) !== null) names.add(n)
  if (names.has(branch)) return true
  const locals = (gitTry(repo.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']) ?? '').split(/\r?\n/).filter(Boolean)
  return names.size === 0 && locals.length === 1 && locals[0] === branch
}

// Đang giữa rebase/gộp/cherry-pick… hoặc còn file xung đột ⇒ ném (commit lúc này sẽ chốt thao tác dở đó). doing = việc đang định làm, vd "quay về".
function guardGitIdle(repo, doing) {
  for (const [name, why] of IN_PROGRESS) {
    if (exists(path.join(repo.gitDir, name))) throw new LuuError(`Dự án ${why} nên chưa ${doing} được. Xong hoặc huỷ việc dở đó (vd git rebase --abort / git merge --abort) rồi chạy lại.`)
  }
  if ((gitTry(repo.root, ['ls-files', '-u']) ?? '').trim()) throw new LuuError(`Dự án còn file đang xung đột chưa giải quyết nên chưa ${doing} được. Giải quyết xong rồi chạy lại.`)
}

// Quay chỉ chạy ở thư mục chính, nhánh chính, không có thao tác git dở. Trả branch.
function guardQuay(repo) {
  if (!same(repo.dir, repo.root)) throw new LuuError(`Hãy chạy ở thư mục gốc của dự án (${oneLine(repo.root, 200)}), không phải thư mục con.`)
  if (repo.linked) throw new LuuError('Đây là bản làm việc riêng của một nhánh (worktree), không phải thư mục chính của dự án. Quay về chỉ chạy ở thư mục chính, trên nhánh chính.')
  const branch = (gitTry(repo.root, ['symbolic-ref', '-q', '--short', 'HEAD']) ?? '').trim()
  if (!branch) throw new LuuError('Dự án đang không đứng trên nhánh nào (HEAD tách rời). Quay về chỉ chạy trên nhánh chính.')
  if (!isMainBranch(repo, branch)) throw new LuuError(`Đang ở nhánh "${oneLine(branch, 80)}", không phải nhánh chính. Quay về chỉ chạy trên nhánh chính của thư mục chính.`)
  guardGitIdle(repo, 'quay về')
  const v = /(\d+)\.(\d+)/.exec(gitTry(repo.root, ['--version']) ?? '')
  if (v && (Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 23))) throw new LuuError(`Git ${v[0]} quá cũ (cần từ 2.23). Cập nhật git rồi chạy lại.`)
  return branch
}

export function xem(dir, tag) {
  const repo = needRepo(dir)
  const head = needHead(repo)
  const target = resolvePoint(repo, tag)
  const globs = dataGlobs(repo.root)
  const ex = excludeSpecs(globs)
  const afterSet = new Set(git(repo.root, ['rev-list', `${target.commit}..HEAD`]).split(/\r?\n/).filter(Boolean))
  const after = listPoints(repo).filter((p) => afterSet.has(p.commit)).map(({ tag: t, name, time, commit }) => ({ tag: t, name, time, commit: shortOf(repo, commit) }))
  const commitCount = Number(git(repo.root, ['rev-list', '--first-parent', '--count', `${target.commit}..HEAD`]).trim()) || 0
  const commits = git(repo.root, ['log', '--first-parent', '-n', '30', '--format=%h%x00%s', `${target.commit}..HEAD`]).split(/\r?\n/).filter(Boolean)
    .map((l) => { const [short, subject] = l.split('\0'); return { commit: short, subject: oneLine(subject, 160) } })
  const changes = diffStatus(repo, head, target.commit, [':/', ...ex])
  const kept = diffStatus(repo, head, target.commit, includeSpecs(globs)).map((c) => c.file)
  let blocker = null
  try { guardQuay(repo) } catch (e) { if (e instanceof LuuError) blocker = e.message; else throw e }
  const dirty = dirtyFiles(repo, ex)
  return {
    target: { tag: target.tag, name: target.name, time: target.time, iso: target.iso, commit: shortOf(repo, target.commit) },
    after, commits, commitCount, dirty, worktrees: otherWorktrees(repo),
    unmerged: (gitTry(repo.root, ['for-each-ref', '--no-merged=HEAD', '--format=%(refname:short)', 'refs/heads']) ?? '').split(/\r?\n/).filter(Boolean).map((b) => oneLine(b, 120)),
    changes, ruleFiles: ruleChanges(repo, target.commit, changes, ex, dirty).map((c) => c.file), keptData: kept, blocker,
  }
}

// ---------- quay ----------

// Một dòng tổng từ báo cáo JSON của flow-check (không in cả bảng dài): đạt, hoặc "N mục chưa đạt" kèm lệnh xem chi tiết. N = mục không đạt + mục thiếu công cụ bắt buộc (đúng những mục làm flow-check đỏ).
const shellArg = (s) => (/\s/.test(s) ? `"${s}"` : s)
export function checkSummary(report, { script, root }) {
  if (!report?.summary || typeof report.ok !== 'boolean') return { exit: null, lines: ['Máy kiểm sau khi quay không cho ra kết quả đọc được.'] }
  if (report.ok) return { exit: 0, lines: ['Máy kiểm sau khi quay: đạt.'] }
  const n = (Number(report.summary.fail) || 0) + (Number(report.summary.missingRequired) || 0)
  return { exit: 1, lines: [oneLine(`Máy kiểm sau khi quay: ${n || 'một số'} mục chưa đạt (không chặn). Xem chi tiết: node ${shellArg(script)} --dir ${shellArg(root)}`, 500)] }
}

// Máy kiểm sau khi quay (không chặn): chạy hooks/flow-check.mjs nếu có, chỉ trả một dòng tổng. null = không có / bỏ qua.
export function defaultRunCheck(root) {
  const script = path.join(HOOKS_DIR, 'flow-check.mjs')
  if (!isFile(script)) return null
  const r = spawnSync(process.execPath, [script, '--dir', root, '--json'], { encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 1 << 26, windowsHide: true })
  if (r.error) return { exit: null, lines: [`Máy kiểm không chạy được (${r.error.code ?? r.error.message}).`] }
  let report = null
  try { report = JSON.parse(String(r.stdout ?? '')) } catch { /* không phải JSON: checkSummary báo không đọc được */ }
  return checkSummary(report, { script, root })
}

const stripQuay = (name) => name.replace(/^(?:Quay lại:\s*)+/, '')

export function quay(dir, tag, { viecDo, doiLuat = false, runCheck = defaultRunCheck, now = new Date() } = {}) {
  if (viecDo !== undefined && viecDo !== 'giu' && viecDo !== 'bo') throw new LuuError('--viec-do chỉ nhận "giu" hoặc "bo".', { exit: 2 })
  const repo = needRepo(dir)
  guardQuay(repo)
  const head = needHead(repo)
  const target = resolvePoint(repo, tag)
  const globs = dataGlobs(repo.root)
  const ex = excludeSpecs(globs)
  const changes = diffStatus(repo, head, target.commit, [':/', ...ex])
  const keptData = diffStatus(repo, head, target.commit, includeSpecs(globs)).map((c) => c.file)
  const dirty = dirtyFiles(repo, ex)
  const base = stripQuay(target.name)

  const rules = ruleChanges(repo, target.commit, changes, ex, dirty)
  if (rules.length && !doiLuat) {
    const verb = { A: 'sẽ được thêm lại', D: 'sẽ bị gỡ', M: 'sẽ đổi nội dung' }
    throw new LuuError(`Quay về "${oneLine(base, 100)}" sẽ đổi luật kiểm tra của dự án (nới hoặc siết so với bây giờ). Chỉ chạy tiếp khi người dùng đã đồng ý việc này; khi đó thêm --doi-luat.`, {
      exit: 4,
      lines: [...rules.slice(0, 20).map((c) => `- ${oneLine(c.file, 200)} (${verb[c.st] ?? 'sẽ đổi'})`), ...(rules.length > 20 ? [`- …và ${rules.length - 20} file luật nữa`] : []),
        ...(dirty.length && !viecDo ? ['Ngoài ra còn việc đang dở: cần thêm --viec-do giu|bo.'] : [])],
    })
  }
  if (dirty.length && !viecDo) {
    throw new LuuError(`Còn ${dirty.length} file đang sửa dở chưa lưu. Giữ hay bỏ? Cả hai đều cất việc dở thành một điểm lưu trước khi quay nên không mất việc: --viec-do giu = quay xong đặt lại các file dở này vào thư mục làm việc (chưa lưu); --viec-do bo = cất rồi thôi, thư mục làm việc về đúng điểm đã chọn. Chạy lại với một trong hai.`, {
      exit: 3, lines: [...dirty.slice(0, 20).map((f) => `- ${oneLine(f, 200)}`), ...(dirty.length > 20 ? [`- …và ${dirty.length - 20} file nữa`] : [])],
    })
  }
  // file riêng trên máy (bị .gitignore) mà quay sẽ ghi đè ⇒ dừng, không đè
  const adds = changes.filter((c) => c.st === 'A' && exists(path.join(repo.root, c.file))).map((c) => c.file)
  if (adds.length) {
    const r = run(repo.root, ['check-ignore', '-z', '--stdin'], { input: `${adds.join('\0')}\0` })
    const ignored = (r.stdout ?? '').split('\0').filter(Boolean)
    if (ignored.length) {
      throw new LuuError('Quay về sẽ ghi đè file riêng trên máy (không nằm trong git). Chuyển chúng đi chỗ khác rồi chạy lại.', { lines: ignored.slice(0, 20).map((f) => `- ${oneLine(f, 200)}`) })
    }
  }
  if (!dirty.length && !changes.length) return { status: 'same', target }

  // 1) việc dở ⇒ lưu tạm (quét khoá như cổng commit) — từ đây việc dở đã an toàn trong lịch sử
  let saved = null
  if (dirty.length) {
    const name = viecDo === 'bo' ? 'Việc dở đã bỏ — lưu tạm trước khi quay lại' : 'Lưu tạm trước khi quay lại'
    const savedCommit = stageScanCommit(repo, ex, name)
    saved = savedCommit ? makePoint(repo, savedCommit, name, now) : null
  }
  // 2) điểm vừa rời (để quay nhầm thì quay về đó)
  const left = saved ?? pointAt(repo, headOf(repo)) ?? makePoint(repo, headOf(repo), `Trước khi quay lại: ${base}`, now)
  // 3) quay = restore rồi commit mới (không reset, không xoá gì)
  // Commit và phép kiểm khác biệt chỉ trên đường code vừa restore (`:/` trừ dữ liệu): dữ liệu user đã stage giữ nguyên trạng thái stage, không vào commit.
  const scope = [':/', ...ex]
  git(repo.root, ['restore', `--source=${target.commit}`, '--staged', '--worktree', '--', ...scope])
  let commit
  let newPoint = null
  if (run(repo.root, ['diff', '--cached', '--quiet', '--', ...scope]).status === 0) {
    commit = headOf(repo)
  } else {
    const msg = `Quay lại: ${base}`
    try {
      git(repo.root, [...commitCfg(repo), 'commit', '--no-verify', '-q', '-F', '-', '--', ...scope], { input: `${msg}\n` })
    } catch (e) {
      git(repo.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ':/', ...ex])
      throw e
    }
    commit = headOf(repo)
    newPoint = makePoint(repo, commit, msg, now)
  }
  // 4) máy kiểm chạy trên cây vừa quay (chưa có việc dở chen vào), rồi `giu` mới đặt việc dở lại vào thư mục làm việc (chưa stage, chưa commit); `bo` thì thôi.
  let check = null
  let restored = []
  try {
    check = typeof runCheck === 'function' ? runCheck(repo.root) : null
  } finally {
    if (viecDo === 'giu' && saved) restored = reapplyWork(repo, head, saved, ex)
  }
  return {
    status: 'done', target: { tag: target.tag, name: target.name, time: target.time }, commit: shortOf(repo, commit), tag: newPoint?.tag ?? null,
    left: { tag: left.tag, name: left.name, commit: shortOf(repo, left.commit) }, saved: saved ? { tag: saved.tag, name: saved.name } : null, restored, keptData, check,
  }
}

// `giu`: đặt lại vào thư mục làm việc đúng những file việc dở đã đổi so với HEAD cũ (from → điểm lưu tạm): file thêm/sửa lấy nội dung từ điểm lưu tạm (chỉ thư mục làm việc, không stage),
// file đã xoá dở thì xoá lại. Trả danh sách file. Lỗi ⇒ nói việc dở vẫn nằm an toàn ở điểm lưu tạm và cách lấy lại.
function reapplyWork(repo, from, saved, ex) {
  const changes = diffStatus(repo, from, saved.commit, [':/', ...ex])
  const put = changes.filter((c) => c.st !== 'D').map((c) => c.file)
  const del = changes.filter((c) => c.st === 'D').map((c) => c.file)
  try {
    inChunks(put, (chunk) => git(repo.root, ['--literal-pathspecs', 'restore', `--source=${saved.commit}`, '--worktree', '--', ...chunk]))
    for (const f of del) {
      try { fs.unlinkSync(path.join(repo.root, f)) } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
  } catch (e) {
    throw new LuuError(`Đã quay xong nhưng chưa đặt lại được việc đang dở vào thư mục làm việc (${oneLine(e.message, 200)}). Việc dở vẫn nằm an toàn trong điểm lưu ${saved.tag}: lấy lại bằng luu.mjs quay <thư mục> ${saved.tag}`)
  }
  return [...put, ...del]
}
