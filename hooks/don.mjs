// don: dọn thư mục có kiểm tra trước, thay cho lệnh xoá đệ quy (bị flow-gate + mod chan-nguy-hiem chặn, và làm app bật hộp hỏi) [psic].
//   node ~/.claude/hooks/don.mjs <đường dẫn>…     mỗi đường dẫn in một dòng "đã dọn" / "từ chối: lý do"; có từ chối ⇒ exit 1.
//   node ~/.claude/hooks/don.mjs --quet [--thu] [--ngay <n>] [--tu <mốc ms>]   quét đồ tạm cũ không ai đụng (xem cuối file) [12e1].
// Chỉ dọn 3 loại, còn lại từ chối:
//   1. Bên trong thư mục tạm: thư mục tạm hệ thống, <ổ đĩa>:\tmp, /tmp (không phải chính thư mục tạm), và không chứa repo git độc lập.
//   2. Thư mục build trong một git repo (BUILD_NAMES) mà git đang bỏ qua (.gitignore) và không theo dõi file nào trong đó.
//   3. Worktree phụ đã gộp sạch: không còn thay đổi dở, không khoá, nhánh đã nằm trong nhánh chính (hoặc nội dung trùng nhánh chính).
//      Gỡ bằng `git worktree remove` KHÔNG --force, nên git vẫn tự từ chối nếu có gì bất thường.
//   4. Bản sao làm việc còn sót: <repo>/.claude/worktrees/<tên> mà git đã gỡ khỏi danh sách worktree, không còn .git, git không theo dõi.
//   (1.) Thư mục nhà là repo git thì thư mục tạm bên trong nó vẫn tính là thư mục tạm.
// Không bao giờ dọn: gốc ổ đĩa, thư mục người dùng, thư mục đang đứng hoặc thư mục cha của nó, đường dẫn có ký tự đại diện.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUILD_NAMES = new Set(['dist', 'build', 'out', '.next', '.nuxt', '.output', '.astro', '.turbo', '.cache', '.vite', 'node_modules', 'coverage', 'target', '__pycache__', 'test-results', 'playwright-report'])

const AMBIGUOUS_NAMES = new Set(['dist', 'build', 'out', 'target', 'coverage', '.output'])
const PROJECT_FILES = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'build.gradle', 'composer.json']

const WIN = process.platform === 'win32'
const low = (p) => (WIN ? p.toLowerCase() : p)
const native = (p) => (WIN ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p)
const real = (p) => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
const under = (root, p) => low(p).startsWith(low(root).replace(/[\\/]+$/, '') + path.sep)
const same = (a, b) => low(path.resolve(a)) === low(path.resolve(b))

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.longpaths=true', ...args], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000, windowsHide: true })
  return r.status === 0 ? r.stdout : null
}

function tempRoots(env = process.env) {
  const roots = [os.tmpdir(), env.TEMP, env.TMP, WIN ? null : '/tmp'].filter(Boolean)
  if (WIN) for (const c of 'cdefgh') roots.push(`${c}:\\tmp`)
  return [...new Set(roots.map(real))]
}

// Đường dẫn này là worktree phụ của repo nào? Trả { common, branch, locked } hoặc null. Hỏi từ chính thư mục đó nên repo nào cũng được.
function linkedWorktree(target) {
  const out = git(target, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir')
  if (!out) return null
  const [top, gd, cd] = out.split(/\r?\n/)
  if (!top || !same(real(top), target)) return null
  const gitDir = path.resolve(target, gd)
  const common = path.resolve(target, cd)
  if (same(gitDir, common)) return null
  const branch = (git(target, 'symbolic-ref', '--short', '-q', 'HEAD') ?? '').trim() || null
  return { common, branch, locked: fs.existsSync(path.join(gitDir, 'locked')) }
}

function checkWorktree(target, wt) {
  if (wt.locked) return 'worktree đang bị khoá (phiên khác đang dùng)'
  const status = git(target, 'status', '--porcelain')
  if (status === null) return 'không đọc được trạng thái worktree'
  if (status.trim()) return 'worktree còn thay đổi chưa commit'
  // git status bỏ qua phần bị ignore: repo hoặc worktree lồng trong đó (vd .claude/worktrees) sẽ mất cùng khi gỡ.
  const inner = fs.readdirSync(target, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules')
  if (inner.some((e) => holdsRepo(path.join(target, e.name)))) return 'trong worktree có repo hoặc worktree lồng bên trong'
  const hasBranch = (b) => git(wt.common, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`) !== null
  const remoteHead = (git(wt.common, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD') ?? '').trim().replace(/^origin\//, '')
  const known = remoteHead && hasBranch(remoteHead)
  if (!known && hasBranch('main') && hasBranch('master')) return 'repo có cả main lẫn master, không biết chắc nhánh chính là nhánh nào'
  const main = known ? remoteHead : ['main', 'master'].find(hasBranch)
  if (!main) return 'repo không có nhánh main/master để đối chiếu'
  if (spawnSync('git', ['-C', target, 'merge-base', '--is-ancestor', 'HEAD', main], { windowsHide: true }).status === 0) return null
  if (spawnSync('git', ['-C', target, 'diff', '--quiet', main, 'HEAD', '--'], { windowsHide: true }).status === 0) return null
  return `nhánh ${wt.branch ?? '(không tên)'} còn commit chưa gộp vào ${main}`
}

// Có repo git độc lập ở bất kỳ cấp nào bên trong không (có thể còn commit chưa đẩy lên)? Không đi vào node_modules; đọc lỗi thì coi như có để từ chối.
function holdsRepo(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return true }
  if (entries.some((e) => e.name === '.git')) return true
  const has = (n) => entries.some((e) => e.name === n)
  if (has('HEAD') && has('objects') && has('refs')) return true // repo bare
  return entries.some((e) => e.isDirectory() && e.name !== 'node_modules' && holdsRepo(path.join(dir, e.name)))
}

function gitAbove(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true
    if (path.dirname(d) === d) return false
  }
}

// Loại dọn cho `raw`: { kind: 'temp' | 'build' | 'missing' } hoặc { kind: 'worktree', common } hoặc { refuse: lý do }.
export function classify(raw, { cwd = process.cwd(), temps = tempRoots() } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return { refuse: 'đường dẫn trống' }
  if (/[*?$`]|%[^%]+%/.test(raw)) return { refuse: 'đường dẫn có ký tự đại diện hoặc biến, không biết chắc trỏ đi đâu' }
  const abs = path.resolve(cwd, native(raw))
  if (!fs.existsSync(abs)) return { kind: 'missing', target: abs }
  if (fs.lstatSync(abs).isSymbolicLink()) return { refuse: 'đây là liên kết tắt, không phải thư mục thật' }
  const target = real(abs)
  if (!fs.statSync(target).isDirectory()) return { refuse: 'không phải thư mục (xoá một file thì không cần lệnh này)' }
  if (same(path.parse(target).root, target)) return { refuse: 'đây là gốc ổ đĩa' }
  const home = real(os.homedir())
  if (same(home, target) || under(target, home)) return { refuse: 'đây là thư mục người dùng hoặc thư mục cha của nó' }
  const here = real(cwd)
  if (same(here, target) || under(target, here)) return { refuse: 'đang đứng trong thư mục này' }
  if (path.basename(target).toLowerCase() === '.git' || /[\\/]\.git[\\/]/.test(target)) return { refuse: 'đây là dữ liệu git' }

  const wt = linkedWorktree(target)
  if (wt) {
    const why = checkWorktree(target, wt)
    return why ? { refuse: why } : { kind: 'worktree', target, common: wt.common }
  }
  if (holdsRepo(target)) return { refuse: 'trong này có repo git độc lập, có thể còn commit chưa đẩy lên', code: 'repo' }
  const parent = path.dirname(target)
  const top = (git(parent, 'rev-parse', '--show-toplevel') ?? '').trim()
  // Có .git ở thư mục cha mà git báo lỗi (repo hỏng, khác chủ sở hữu) ⇒ không suy ra là "không có repo".
  if (!top && gitAbove(parent)) return { refuse: 'thư mục này nằm trong một repo mà git đang báo lỗi' }
  // Bản sao làm việc git đã gỡ khỏi danh sách nhưng còn sót file (<repo>/.claude/worktrees/<tên>, không còn .git, git không theo dõi).
  if (top && path.basename(parent).toLowerCase() === 'worktrees' && path.basename(path.dirname(parent)).toLowerCase() === '.claude' && same(real(top), path.dirname(path.dirname(parent)))) {
    const listed = git(top, 'worktree', 'list', '--porcelain')
    const tracked = git(parent, 'ls-files', '--', path.basename(target))
    if (listed === null || tracked === null) return { refuse: 'không kiểm được git về bản sao làm việc này' }
    if (listed.split(/\r?\n/).some((l) => l.startsWith('worktree ') && same(real(l.slice(9)), target))) return { refuse: 'git vẫn ghi đây là worktree nhưng không mở được' }
    if (tracked.trim()) return { refuse: 'git đang theo dõi file trong thư mục này, xoá đi sẽ mất dữ liệu của dự án' }
    return { kind: 'leftover', target }
  }
  // Thư mục con của một repo nằm TRONG thư mục tạm thì xét như trong dự án; repo bọc ngoài thư mục tạm (vd thư mục nhà là repo) không tính.
  for (const root of temps) {
    if (top && (under(root, real(top)) || same(root, real(top)))) continue
    if (under(root, target)) return { kind: 'temp', target }
    if (same(root, target)) return { refuse: 'đây là chính thư mục tạm, chỉ dọn được thứ bên trong' }
  }
  const name = path.basename(target).toLowerCase()
  if (BUILD_NAMES.has(name)) {
    if (!top) return { refuse: 'thư mục build này không nằm trong git repo nên không kiểm được có tạo lại được không' }
    // Tên dễ trùng thư mục code (src/target, scripts/build): chỉ tin khi nằm ngay gốc dự án hoặc cạnh file khai báo dự án.
    if (AMBIGUOUS_NAMES.has(name) && !same(real(top), parent) && !PROJECT_FILES.some((f) => fs.existsSync(path.join(parent, f)))) {
      return { refuse: 'tên giống thư mục build nhưng không nằm ở gốc dự án, có thể là thư mục code' }
    }
    const tracked = git(parent, 'ls-files', '--', path.basename(target))
    if (tracked === null) return { refuse: 'không kiểm được git có đang theo dõi thư mục này không' }
    if (tracked.trim()) return { refuse: 'git đang theo dõi file trong thư mục này, xoá đi sẽ mất dữ liệu của dự án' }
    // Không nằm trong .gitignore ⇒ có thể là code mới chưa commit dù tên giống thư mục build.
    if (spawnSync('git', ['-C', parent, 'check-ignore', '-q', path.basename(target)], { windowsHide: true }).status !== 0) {
      return { refuse: 'git không bỏ qua thư mục này nên có thể là code chưa commit, không phải kết quả build' }
    }
    return { kind: 'build', target }
  }
  return { refuse: 'không phải thư mục tạm, thư mục build hay worktree đã gộp' }
}

export function don(raw, opts = {}) {
  const c = classify(raw, opts)
  if (c.refuse) return { ok: false, line: `từ chối: ${raw} — ${c.refuse}` }
  if (c.kind === 'missing') return { ok: true, line: `không có sẵn: ${raw}` }
  if (c.kind === 'worktree') {
    if (git(c.common, 'worktree', 'remove', c.target) === null) return { ok: false, line: `từ chối: ${raw} — git không gỡ được worktree này` }
    git(c.common, 'worktree', 'prune')
    return { ok: true, line: `đã dọn worktree: ${raw}` }
  }
  fs.rmSync(c.target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  return { ok: true, line: `đã dọn: ${raw}` }
}

// ---------- quét đồ tạm cũ [12e1] ----------
//   node ~/.claude/hooks/don.mjs --quet [--thu] [--ngay <n>] [--tu <mốc ms>]
// Mỗi mục NGAY DƯỚI thư mục tạm của AI (<ổ đĩa>:\tmp) mà suốt <n> ngày (mặc định 7) không có gì bên trong được sửa ⇒ dọn; --thu chỉ liệt kê.
// --tu: chỉ xét mục tạo ra từ mốc đó (lượt tự quét luôn dùng: đồ có sẵn từ trước khi bật là của user, không tự dọn). Không --tu = user bảo dọn cả đồ cũ.
// Không quét thư mục tạm hệ thống (của mọi app khác, hệ điều hành tự lo) và /tmp trên macOS/Linux (tự xoá khi khởi động lại).
// Giữ lại và chỉ kể: bản sao code (worktree), thư mục có repo git còn thứ chưa đẩy lên, liên kết tắt, thứ đang bị tiến trình khác giữ.
const DAY = 86400000

export function sweepRoots() {
  if (!WIN) return []
  return [...'cdefgh'].map((c) => `${c}:\\tmp`).filter((p) => { try { return fs.statSync(p).isDirectory() } catch { return false } })
}

// Lần cuối một mục bị đụng tới: mới nhất trong sửa nội dung, tạo ra, đổi tên/chuyển chỗ. Chỉ nhìn giờ sửa thì đồ vừa giải nén hay vừa chuyển vào
// (giờ sửa giữ nguyên từ nguồn) bị coi là cũ. renamed = chính lượt quét vừa đổi tên mục này ⇒ bỏ qua giờ đổi tên của nó.
const touchedAt = (st, renamed = false) => Math.max(st.mtimeMs, st.birthtimeMs, renamed ? 0 : st.ctimeMs)

// Lần đụng mới nhất và tổng dung lượng của `p`. Gặp thứ bị đụng sau `cutoff` ⇒ fresh và dừng ngay, không đi hết cây.
function scan(p, cutoff, stamp, acc = { newest: 0, bytes: 0, fresh: false }, renamed = false) {
  let st
  try { st = fs.lstatSync(p) } catch { return acc }
  const at = stamp(st, renamed)
  if (at > acc.newest) acc.newest = at
  if (at > cutoff) { acc.fresh = true; return acc }
  if (st.isSymbolicLink() || !st.isDirectory()) { acc.bytes += st.size; return acc }
  let entries
  try { entries = fs.readdirSync(p) } catch { return acc }
  for (const e of entries) {
    scan(path.join(p, e), cutoff, stamp, acc)
    if (acc.fresh) return acc
  }
  return acc
}

// Gốc của MỌI repo git nằm trong `dir` (kể cả chính nó và repo lồng trong repo khác: thư mục bị repo ngoài bỏ qua vẫn có thể là một repo
// còn commit chưa đẩy). Không đi vào node_modules và ruột .git.
function repoRoots(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  const has = (n) => entries.some((e) => e.name === n)
  if (has('.git') || (has('HEAD') && has('objects') && has('refs'))) out.push(dir)
  for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') repoRoots(path.join(dir, e.name), out)
  return out
}

// Nơi đẩy lên nằm trên mạng (https, ssh, git, hoặc dạng user@máy:đường). Đường dẫn trên máy hay file:// không tính: nó có thể đã mất hoặc cũng là đồ tạm.
const isNetUrl = (u) => /^(https?|ssh|git):\/\//i.test(u) || /^[\w.-]+@[\w.-]+:/.test(u)

// null khi MỌI repo trong `dir` chỉ là bản tải về nguyên vẹn: có nơi đẩy lên trên mạng, không commit nào chưa đẩy, không file sửa dở hay file mới, không stash.
// Ngược lại trả lý do giữ. Không hỏi được git ⇒ giữ.
function repoKeepReason(dir) {
  const roots = repoRoots(dir)
  if (roots.length === 0) return 'không đọc được hết bên trong nên không biết có repo git nào' // classify coi thư mục không đọc được là "có repo"
  for (const r of roots) {
    let dotGit
    try { dotGit = fs.statSync(path.join(r, '.git')) } catch { return 'có repo git dạng kho trần (bare), không kiểm được đã đẩy lên chưa' }
    if (!dotGit.isDirectory()) return 'có bản sao code (worktree hoặc submodule) của một dự án bên trong'
    const urls = (git(r, 'config', '--get-regexp', '^remote\\..*\\.url$') ?? '').split(/\r?\n/).map((l) => l.replace(/^\S+\s+/, '').trim()).filter(Boolean)
    if (!urls.some(isNetUrl)) return 'có repo git chỉ nằm trên máy này (chưa có nơi đẩy lên trên mạng)'
    const dirty = git(r, 'status', '--porcelain') // tính cả file mới chưa đưa vào git: việc làm dở chỉ có ở máy này
    if (dirty === null) return 'có repo git không đọc được'
    if (dirty.trim()) return 'có repo git còn file sửa dở hoặc file mới chưa lưu vào git'
    const ahead = git(r, 'log', 'HEAD', '--branches', '--not', '--remotes', '-1', '--format=%h')
    if (ahead === null) return 'có repo git không đọc được lịch sử'
    if (ahead.trim()) return 'có repo git còn commit chưa đẩy lên'
    if ((git(r, 'stash', 'list') ?? 'x').trim()) return 'có repo git còn thay đổi cất tạm (stash)'
  }
  return null
}

// Xoá thư mục cũ `p` theo cách không làm mất gì khi nó đang được dùng: ĐỔI TÊN trước (Windows từ chối ngay nếu có tiến trình đang đứng trong đó
// hoặc đang mở file bên trong ⇒ chưa mất gì), soi lại bản đã đổi tên xem có gì vừa được ghi trong lúc kiểm không (có ⇒ trả tên cũ), rồi mới xoá.
function removeOld(p, cutoff, stamp) {
  const from = real(p)
  const trash = `${from}.don-rac-${process.pid}`
  try { fs.renameSync(from, trash) } catch (e) { return `đang được dùng (${e?.code ?? e?.message ?? e})` }
  if (scan(trash, cutoff, stamp, undefined, true).fresh) {
    try { fs.renameSync(trash, from) } catch { return `vừa có thứ được ghi bên trong; đang nằm ở tên tạm ${trash}` }
    return 'vừa có thứ được ghi bên trong'
  }
  fs.rmSync(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  return null
}

// Lý do giữ thư mục cũ `p`, hoặc null khi dọn được (và đã dọn, trừ khi dry).
function sweepDir(p, { dry, cwd, temps, cutoff, stamp }) {
  const c = classify(p, { cwd, temps })
  if (c.kind === 'worktree') return 'bản sao code (worktree) đã gộp — không thuộc diện tự quét, dọn theo skill flow-worktree'
  if (c.refuse) {
    if (c.code !== 'repo') return c.refuse
    const why = repoKeepReason(p)
    if (why) return why
  } else if (c.kind !== 'temp') return 'không phải đồ tạm'
  return dry ? null : removeOld(p, cutoff, stamp)
}

// → { removed: [{path, bytes, newest}], kept: [{path, bytes, newest, why}], fresh: số mục còn mới, bytes: tổng dung lượng dọn được }
// stamp: cách tính lần đụng cuối (mặc định touchedAt; test thay để dựng đồ "cũ" bằng cách chỉnh giờ sửa).
// since (ms): chỉ xét mục được TẠO RA từ mốc này trở đi; mục có từ trước (hoặc không đọc được giờ tạo) không bao giờ đụng, đếm vào `before`.
// Lượt tự quét của hook mở phiên luôn truyền mốc = lúc bật tính năng: đồ có sẵn trên máy trước đó là của user, user bảo mới dọn.
// Mốc hợp lệ không thể sớm hơn ngày tính năng ra đời: mốc 0, rỗng, rất nhỏ (biến rỗng khi ghép lệnh, đồng hồ máy chạy lùi) mà được nhận
// thì thành quét không mốc ⇒ mất đồ có sẵn. since = 0 chỉ có nghĩa "không truyền mốc" khi gọi hàm; dòng lệnh có --tu thì phải là mốc thật.
export const SINCE_FLOOR = Date.UTC(2026, 10, 25)
const SINCE_ERR = 'mốc --tu phải là số mili giây của một thời điểm từ 2026-11-25 trở đi'
export function quet({ days = 7, dry = false, roots = sweepRoots(), now = Date.now(), cwd = process.cwd(), stamp = touchedAt, since = 0 } = {}) {
  if (!Number.isFinite(days) || days < 1) throw new Error('số ngày phải từ 1 trở lên')
  if (since !== 0 && !(Number.isFinite(since) && since >= SINCE_FLOOR)) throw new Error(SINCE_ERR)
  const cutoff = now - days * DAY
  const res = { removed: [], kept: [], fresh: 0, before: 0, bytes: 0 }
  for (const root of roots) {
    let entries
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = path.join(root, e.name)
      if (since > 0) {
        let born = 0
        try { born = fs.lstatSync(p).birthtimeMs } catch { /* không đọc được ⇒ coi như có từ trước */ }
        if (!(born >= since)) { res.before++; continue }
      }
      const s = scan(p, cutoff, stamp)
      if (s.fresh) { res.fresh++; continue }
      let why
      try {
        if (e.isSymbolicLink()) why = 'liên kết tắt, không tự dọn'
        else if (e.isDirectory()) why = sweepDir(p, { dry, cwd, temps: [real(root)], cutoff, stamp })
        else { if (!dry) fs.rmSync(p, { force: true }); why = null }
      } catch (err) {
        why = `đang được dùng hoặc không xoá được (${err?.code ?? err?.message ?? err})`
      }
      const item = { path: p, bytes: s.bytes, newest: s.newest }
      if (why) res.kept.push({ ...item, why })
      else { res.removed.push(item); res.bytes += s.bytes }
    }
  }
  return res
}

const size = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`)

function cliQuet(args) {
  const dry = args.includes('--thu')
  const i = args.indexOf('--ngay')
  const days = i >= 0 ? Number(args[i + 1]) : 7
  const j = args.indexOf('--tu')
  // Có --tu thì giá trị phải là dãy chữ số: '' / '0' / ' ' mà qua Number() đều ra 0, tức "không mốc" ⇒ ép thành NaN để quet() từ chối.
  const since = j >= 0 ? (/^\d+$/.test(args[j + 1] ?? '') && Number(args[j + 1]) >= SINCE_FLOOR ? Number(args[j + 1]) : Number.NaN) : 0
  let r
  try { r = quet({ days, dry, since }) } catch (e) { console.error(`Dùng: node ~/.claude/hooks/don.mjs --quet [--thu] [--ngay <n ≥ 1>] [--tu <mốc ms>] — ${e.message}`); process.exitCode = 2; return }
  const verb = dry ? 'sẽ dọn' : 'đã dọn'
  for (const x of r.removed) console.log(`${verb}: ${x.path} — ${size(x.bytes)} — sửa lần cuối ${new Date(x.newest).toISOString().slice(0, 10)}`)
  for (const x of r.kept) console.log(`giữ: ${x.path} — ${size(x.bytes)} — ${x.why}`)
  const sum = `${verb} ${r.removed.length} mục (${size(r.bytes)}); giữ ${r.kept.length} mục cũ; ${r.fresh} mục sửa trong ${days} ngày gần đây không đụng` +
    (since > 0 ? `; ${r.before} mục có từ trước khi bật tự dọn không đụng` : '')
  console.log(`Tổng: ${sum}.`)
  if (dry) return
  try {
    const dir = path.join(os.homedir(), '.claude', 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'don-quet.log'), `${new Date().toISOString()} ${sum}\n`)
  } catch { /* không ghi được nhật ký thì thôi: việc dọn đã xong */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Dùng: node ~/.claude/hooks/don.mjs <đường dẫn>…   |   --quet [--thu] [--ngay <n>] [--tu <mốc ms>]')
    process.exitCode = 2
  }
  if (args[0] === '--quet') {
    cliQuet(args.slice(1))
    args.length = 0
  }
  for (const a of args) {
    let r
    try { r = don(a) } catch (e) { r = { ok: false, line: `từ chối: ${a} — ${e?.message ?? e}` } }
    console.log(r.line)
    if (!r.ok) process.exitCode = 1
  }
}
