// don: dọn thư mục có kiểm tra trước, thay cho lệnh xoá đệ quy (bị flow-gate + mod chan-nguy-hiem chặn, và làm app bật hộp hỏi) [psic].
//   node ~/.claude/hooks/don.mjs <đường dẫn>…     mỗi đường dẫn in một dòng "đã dọn" / "từ chối: lý do"; có từ chối ⇒ exit 1.
// Chỉ dọn 3 loại, còn lại từ chối:
//   1. Bên trong thư mục tạm: thư mục tạm hệ thống, <ổ đĩa>:\tmp, /tmp (không phải chính thư mục tạm), và không chứa repo git độc lập.
//   2. Thư mục build trong một git repo (BUILD_NAMES) mà git đang bỏ qua (.gitignore) và không theo dõi file nào trong đó.
//   3. Worktree phụ đã gộp sạch: không còn thay đổi dở, không khoá, nhánh đã nằm trong nhánh chính (hoặc nội dung trùng nhánh chính).
//      Gỡ bằng `git worktree remove` KHÔNG --force, nên git vẫn tự từ chối nếu có gì bất thường.
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
  if (holdsRepo(target)) return { refuse: 'trong này có repo git độc lập, có thể còn commit chưa đẩy lên' }
  const parent = path.dirname(target)
  const top = (git(parent, 'rev-parse', '--show-toplevel') ?? '').trim()
  // Có .git ở thư mục cha mà git báo lỗi (repo hỏng, khác chủ sở hữu) ⇒ không suy ra là "không có repo".
  if (!top && gitAbove(parent)) return { refuse: 'thư mục này nằm trong một repo mà git đang báo lỗi' }
  // Thư mục con của một repo thì xét như trong dự án, dù repo đó nằm trong thư mục tạm.
  if (!top) {
    for (const root of temps) {
      if (under(root, target)) return { kind: 'temp', target }
      if (same(root, target)) return { refuse: 'đây là chính thư mục tạm, chỉ dọn được thứ bên trong' }
    }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Dùng: node ~/.claude/hooks/don.mjs <đường dẫn>…')
    process.exitCode = 2
  }
  for (const a of args) {
    let r
    try { r = don(a) } catch (e) { r = { ok: false, line: `từ chối: ${a} — ${e?.message ?? e}` } }
    console.log(r.line)
    if (!r.ok) process.exitCode = 1
  }
}
