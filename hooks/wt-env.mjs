#!/usr/bin/env node
// wt-env.mjs - cấp cửa sổ 20 port cho mỗi worktree (theo mẫu Superset allocate_port_base).
//
//   node wt-env.mjs alloc [path]    in 4 dòng PORT_BASE=<n> / FLOW_DB_NAME=<repo>_wt<n> / FLOW_TEST_DATA=<path>/.flow-test-data / FLOW_SECRET_SCOPE=<repo>_wt<n>; đã có thì in lại
//                                   base cũ (path mặc định = git toplevel của cwd)
//   node wt-env.mjs env [path]      in lại khối biến (kèm một dòng comment dặn) của path đã alloc; chưa alloc => exit 1. Không ghi file vào dự án

//   node wt-env.mjs check <worktree> exit 1 + một câu khi .env* trong worktree (bỏ node_modules/.git, .env.example…) có cặp KEY=VALUE (giá trị ≥ 8 ký tự)
//                                   trùng .env* cùng đường dẫn ở thư mục chính, là symlink/junction (hoặc nằm trong thư mục liên kết) trỏ ra ngoài,
//                                   hoặc chứa chuỗi trong prodRefs của <chính>/.claude/flow.json; flow.json hỏng/prodRefs sai kiểu => exit 1; ổn => in ok.
//                                   Path là thư mục chính / không phải worktree liên kết => exit 2. Chỉ in tên file + tên biến, không in giá trị bí mật
//   node wt-env.mjs release [path]  trả base của path
//   node wt-env.mjs list            bảng path | base | exists
//   node wt-env.mjs prune           xoá mục có path không còn tồn tại
//
// Registry: <state>/ports.json { "<path chuẩn hoá>": <base> }. state = $FLOW_STATE_DIR hoặc ~/.claude/state.
// Khoá: mkdir <state>/ports.lock chứa file `owner` {pid, token ngẫu nhiên} (thử lại 50 ms, tối đa 5 s).
//   Khoá chỉ bị phá khi cũ hơn 30 s VÀ chủ không còn sống (process.kill(pid, 0) báo ESRCH); chủ còn sống => chờ tiếp.
//   Trước khi rename registry và trước khi nhả khoá phải kiểm token trong khoá vẫn là của mình; khác => không ghi, exit 2.
//   Registry ghi file tạm rồi rename.
// Công cụ CLI, không phải hook: lỗi => stderr + exit 2 (không fail-open).
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const BASE_FIRST = 4100
const BASE_LAST = 8980
const STEP = 20
const LOCK_RETRY_MS = 50
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 30000
const WIN = process.platform === 'win32'

const stateDir = () => path.resolve(process.env.FLOW_STATE_DIR || path.join(os.homedir(), '.claude', 'state'))

// Chuẩn hoá khoá registry: tuyệt đối (resolve đã bỏ dấu phân cách cuối), dấu `/`; Windows không phân biệt hoa thường nên hạ chữ thường.
// Cố ý không realpath: path đã bị xoá vẫn ra đúng khoá cũ để release/prune.
function normalizePath(p) {
  const s = path.resolve(p).replace(/\\/g, '/')
  return WIN ? s.toLowerCase() : s
}

function gitToplevel() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' })
  if (r.error) throw new Error(`không chạy được git: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`cwd không nằm trong git repo (${process.cwd()}); truyền path tường minh. ${r.stderr.trim()}`)
  return r.stdout.trim()
}

const targetKey = (arg) => normalizePath(arg ?? gitToplevel())

// ---------- khoá ----------

// owner = {pid, token} trong <lock>/owner; null nếu chưa có / hỏng (chủ chết giữa mkdir và ghi owner).
function readOwner(lock) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8'))
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

// ESRCH = không còn tiến trình. EPERM = còn sống nhưng không có quyền gửi tín hiệu => vẫn là sống.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}

// Chỉ phá khoá khi cũ hơn 30 s VÀ chủ đã chết (hoặc không có owner hợp lệ). Chủ còn sống => giữ nguyên, người gọi chờ tiếp.
function breakIfStale(lock) {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= LOCK_STALE_MS) return
    if (pidAlive(readOwner(lock)?.pid)) return
    // rename nguyên tử: nhiều tiến trình cùng thấy khoá chết thì chỉ một người thắng.
    const grave = `${lock}.stale-${process.pid}-${Date.now()}`
    fs.renameSync(lock, grave)
    fs.rmSync(grave, { recursive: true, force: true })
  } catch {
    // khoá vừa được người khác nhả/phá: vòng thử lại sẽ xử lý
  }
}

// fn nhận assertOwner(): ném lỗi nếu khoá không còn của mình. fn phải gọi nó ngay trước mỗi lần ghi ra ngoài (saveRegistry làm sẵn).
async function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, 'ports.lock')
  const token = randomBytes(16).toString('hex')
  const mine = () => readOwner(lock)?.token === token
  const assertOwner = () => {
    if (!mine()) throw new Error(`mất quyền sở hữu khoá ${lock} (bị phá hoặc đổi chủ giữa chừng); không ghi, chạy lại lệnh`)
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      // Windows trả EPERM/EACCES/EBUSY khi thư mục khoá đang chờ xoá; các mã khác là lỗi thật.
      const busy = e.code === 'EEXIST' || (WIN && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code))
      if (!busy) throw e
      breakIfStale(lock)
      if (Date.now() >= deadline) {
        const holder = readOwner(lock)?.pid
        throw new Error(`không lấy được khoá ${lock} sau ${LOCK_TIMEOUT_MS} ms (${e.code})${holder ? `; chủ khoá pid ${holder}` : ''}`)
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  try {
    try {
      fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, token }))
    } catch (e) {
      fs.rmSync(lock, { recursive: true, force: true }) // chưa có owner thì finally bên dưới không nhận ra khoá là của mình
      throw e
    }
    const result = await fn(assertOwner)
    assertOwner()
    return result
  } finally {
    // chỉ nhả khoá của chính mình; khoá đã đổi chủ thì để nguyên cho chủ mới
    if (mine()) fs.rmSync(lock, { recursive: true, force: true })
  }
}

// ---------- registry ----------

function loadRegistry(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw e
  }
  let reg
  try {
    reg = JSON.parse(text)
  } catch (e) {
    throw new Error(`${file} không phải JSON hợp lệ (${e.message}); sửa hoặc xoá tay, script không ghi đè`)
  }
  if (!reg || typeof reg !== 'object' || Array.isArray(reg) || !Object.values(reg).every(Number.isInteger)) {
    throw new Error(`${file} sai dạng, cần { "<path>": <base nguyên> }; sửa hoặc xoá tay, script không ghi đè`)
  }
  return reg
}

function saveRegistry(file, reg, assertOwner) {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n')
    assertOwner() // ngay trước rename: mất khoá => không đụng tới registry
    // Windows có thể trả EPERM/EBUSY thoáng qua (antivirus quét file) khi rename đè.
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file)
        return
      } catch (e) {
        if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

// ---------- lệnh ----------

async function alloc(dir, arg) {
  const key = targetKey(arg)
  return withLock(dir, async (assertOwner) => {
    const file = path.join(dir, 'ports.json')
    const reg = loadRegistry(file)
    if (key in reg) return reg[key]
    const held = new Set(Object.values(reg))
    for (let base = BASE_FIRST; base <= BASE_LAST; base += STEP) {
      if (held.has(base) || !(await portFree(base))) continue
      reg[key] = base
      saveRegistry(file, reg, assertOwner)
      return base
    }
    throw new Error(`hết cửa sổ port trong ${BASE_FIRST}-${BASE_LAST} (đã giữ ${held.size}); chạy prune hoặc release`)
  })
}

const release = (dir, arg) => {
  const key = targetKey(arg)
  return withLock(dir, async (assertOwner) => {
    const file = path.join(dir, 'ports.json')
    const reg = loadRegistry(file)
    if (!(key in reg)) return { key, base: null }
    const base = reg[key]
    delete reg[key]
    saveRegistry(file, reg, assertOwner)
    return { key, base }
  })
}

const list = (dir) =>
  withLock(dir, async () => {
    const rows = Object.entries(loadRegistry(path.join(dir, 'ports.json')))
      .map(([p, base]) => ({ p, base, exists: fs.existsSync(p) }))
      .sort((a, b) => a.base - b.base)
    const w = Math.max(4, ...rows.map((r) => r.p.length))
    return [`${'path'.padEnd(w)} | base | exists`, ...rows.map((r) => `${r.p.padEnd(w)} | ${String(r.base).padEnd(4)} | ${r.exists ? 'yes' : 'no'}`)]
  })

const prune = (dir) =>
  withLock(dir, async (assertOwner) => {
    const file = path.join(dir, 'ports.json')
    const reg = loadRegistry(file)
    const gone = Object.entries(reg).filter(([p]) => !fs.existsSync(p))
    for (const [p] of gone) delete reg[p]
    if (gone.length) saveRegistry(file, reg, assertOwner)
    return gone
  })

// Tên repo (chính, không phải thư mục worktree) làm sạch cho tên DB: chữ thường a-z0-9_, không `_` đầu/cuối/lặp.
function repoName(worktree) {
  let name = path.basename(worktree)
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktree, encoding: 'utf8' })
  if (!r.error && r.status === 0 && r.stdout.trim()) {
    const common = path.resolve(worktree, r.stdout.trim())
    name = path.basename(common) === '.git' ? path.basename(path.dirname(common)) : path.basename(common).replace(/\.git$/i, '')
  }
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'app'
}

// Khối biến của một worktree đã có base. PORT_BASE luôn là dòng đầu (flow-dispatch và hook cũ đọc bằng regex PORT_BASE=).
function envLines(worktree, base) {
  const wt = path.resolve(worktree)
  // FLOW_SECRET_SCOPE suy ra từ (repo, base) nên đi cùng mục registry của worktree: release/prune xoá mục là scope mất theo.
  const scope = `${repoName(wt)}_wt${base}`
  return [`PORT_BASE=${base}`, `FLOW_DB_NAME=${scope}`, `FLOW_TEST_DATA=${wt.replace(/\\/g, '/')}/.flow-test-data`, `FLOW_SECRET_SCOPE=${scope}`]
}

// ---------- check ----------

const SKIP_DIRS = new Set(['node_modules', '.git'])
const TEMPLATE_ENV = /\.(example|sample|template|dist)$/i // file mẫu được commit nên giống thư mục chính là bình thường
const MIN_SECRET_LEN = 8 // giá trị ngắn hơn (PORT=3000, DEBUG=1…) trùng nhau là chuyện thường, không tính

const lstat = (p) => fs.lstatSync(p)
const isEnvName = (n) => /^\.env/i.test(n) && !TEMPLATE_ENV.test(n) // Windows/macOS không phân biệt hoa thường: `.ENV`, `.Env.local` vẫn là file app đọc

// Nội dung các file ở thư mục chính có cùng đường dẫn với rel, không phân biệt hoa thường tên file (Linux có thể có `.env` mà làn tạo `.ENV`); không có thì ''.
function mainEnvText(main, rel) {
  const full = path.join(main, rel)
  const want = path.basename(full).toLowerCase()
  let names = []
  try {
    names = fs.readdirSync(path.dirname(full)).filter((n) => n.toLowerCase() === want)
  } catch {
    // thư mục chính không có thư mục này: không trùng
  }
  return names.map((n) => {
    try {
      return fs.readFileSync(path.join(path.dirname(full), n), 'utf8')
    } catch {
      return ''
    }
  }).join('\n')
}

// Đường dẫn thật của p nằm trong (hoặc bằng) thư mục root? Cả hai đã là realpath. false khi p không phân giải được.
function insideDir(root, real) {
  const rel = path.relative(normalizeCase(root), normalizeCase(real))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
const normalizeCase = (p) => (WIN ? p.toLowerCase() : p)

function realOrNull(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

// Quét .env* trong dir (đã realpath = root). Trả { files, links }:
//   files = file .env* thật cần so nội dung (đường dẫn tương đối, kể cả symlink trỏ vào CHÍNH worktree: đọc qua liên kết),
//   links = [{ rel, why }] .env* là symlink/junction trỏ ra ngoài (hoặc hỏng), hoặc nằm trong thư mục liên kết trỏ ra ngoài. lstat để thấy được liên kết.
function findEnvFiles(root) {
  const files = []
  const links = []
  const seen = new Set() // realpath thư mục liên kết đã duyệt (chống vòng lặp)
  // via = tên liên kết ngoài worktree đang đi qua (null = đang trong worktree)
  const walk = (dir, rel, via) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = lstat(full)
      if (st.isSymbolicLink()) {
        const real = realOrNull(full)
        if (isEnvName(e.name)) {
          if (real !== null && !via && insideDir(root, real)) files.push(r) // đích trong worktree: đọc nội dung như file thường
          else links.push({ rel: r, why: 'là liên kết (symlink/junction) trỏ ra ngoài làn hoặc hỏng' })
        } else if (real !== null && !SKIP_DIRS.has(e.name) && fs.statSync(real).isDirectory() && !insideDir(root, real) && !seen.has(real)) {
          seen.add(real)
          walk(real, r, via ?? r)
        }
      } else if (st.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, r, via)
      } else if (st.isFile() && isEnvName(e.name)) {
        if (via) links.push({ rel: r, why: `nằm trong thư mục liên kết "${via}" trỏ ra ngoài làn` })
        else files.push(r)
      }
    }
  }
  walk(root, '', null)
  return { files, links }
}

// Thư mục chính của repo + worktree này có phải worktree liên kết (git worktree add) không. Không phải git repo => ném lỗi.
function gitLayout(worktree) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd: worktree, encoding: 'utf8' })
  if (r.error || r.status !== 0) throw new Error(`${worktree} không nằm trong git repo; chạy check trên thư mục worktree của làn (git worktree list để xem)`)
  const [top, gitDir, common] = r.stdout.split(/\r?\n/).map((s) => s.trim())
  if (!top || !gitDir || !common) throw new Error(`${worktree} không nằm trong git repo; chạy check trên thư mục worktree của làn (git worktree list để xem)`)
  const commonAbs = path.resolve(worktree, common)
  return {
    top: path.resolve(worktree, top),
    linked: normalizePath(realOrNull(path.resolve(worktree, gitDir)) ?? path.resolve(worktree, gitDir)) !== normalizePath(realOrNull(commonAbs) ?? commonAbs),
    main: path.basename(commonAbs) === '.git' ? path.dirname(commonAbs) : commonAbs,
  }
}

const FLOW_FIX = 'sửa file đó cho đúng (JSON hợp lệ, prodRefs là danh sách chữ, vd {"prodRefs":["ma-du-an-that"]}) rồi chạy lại'

// prodRefs trong <chính>/.claude/flow.json. Không có file / không khai prodRefs => []. File hỏng hoặc prodRefs sai kiểu => ném lỗi exit 1 (fail closed:
// không biết dấu hiệu production thì không được báo "ok").
function readProdRefs(main) {
  const bad = (what) => Object.assign(new Error(`.claude/flow.json ở thư mục chính ${what}, nên chưa kiểm được làn có dùng dự án thật không; ${FLOW_FIX}`), { exitCode: 1 })
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(main, '.claude', 'flow.json'), 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw bad(e instanceof SyntaxError ? 'không phải JSON hợp lệ' : 'đọc không được')
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw bad('không phải một object JSON')
  if (!('prodRefs' in cfg)) return []
  if (!Array.isArray(cfg.prodRefs) || !cfg.prodRefs.every((s) => typeof s === 'string')) throw bad('có prodRefs sai kiểu (phải là danh sách chữ)')
  return cfg.prodRefs.filter((s) => s.trim())
}

// .env => Map<KEY, Set<value>>: bỏ comment, dòng trống, `export `, khoảng trắng quanh KEY/VALUE, nháy bao quanh giá trị; thứ tự không quan trọng.
function parseEnv(text) {
  const out = new Map()
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    const q = value[0]
    if (q === '"' || q === "'") {
      const close = value.indexOf(q, 1)
      value = value.slice(1, close < 0 ? undefined : close)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    if (!out.has(key)) out.set(key, new Set())
    out.get(key).add(value)
  }
  return out
}

// Tên các biến có giá trị (khác rỗng, ≥ 8 ký tự) trùng giữa hai file .env. Chỉ trả TÊN biến, không bao giờ trả giá trị.
function sharedKeys(wtText, mainText) {
  const mine = parseEnv(wtText)
  const theirs = parseEnv(mainText)
  return [...mine].filter(([k, vs]) => [...vs].some((v) => v.length >= MIN_SECRET_LEN && theirs.get(k)?.has(v))).map(([k]) => k)
}

// Trả danh sách "<file> <lý do>" (không chứa giá trị bí mật). Không phải worktree liên kết => ném lỗi exit 2.
function checkWorktree(worktree) {
  const layout = gitLayout(path.resolve(worktree))
  if (!layout.linked) {
    throw new Error(`${path.resolve(worktree)} là thư mục chính của dự án (hoặc không phải worktree của một làn) nên không kiểm được; chạy check trên thư mục worktree của làn (git worktree list để xem)`)
  }
  const main = layout.main
  const wt = realOrNull(layout.top) ?? layout.top
  const refs = readProdRefs(main)
  const found = findEnvFiles(wt)
  const problems = found.links.map((l) => `${l.rel} ${l.why}; thay bằng file thật chứa khoá test của làn`)
  for (const rel of found.files) {
    const text = fs.readFileSync(path.join(wt, rel), 'utf8')
    const keys = sharedKeys(text, mainEnvText(main, rel))
    if (keys.length) problems.push(`${rel} có biến trùng giá trị với file cùng tên ở thư mục chính (${keys.join(', ')}; dùng khoá thật)`)
    if (refs.some((s) => text.includes(s))) problems.push(`${rel} trỏ tới dự án production (theo prodRefs trong .claude/flow.json)`)
  }
  return problems
}

const ENV_NOTE = '# Dùng DB thử riêng của làn này, khoá test, không chép .env của thư mục chính.'

// Đọc base đã cấp (không cấp mới). Chưa alloc => lỗi exit 1.
const lookup = (dir, key) =>
  withLock(dir, async () => {
    const base = loadRegistry(path.join(dir, 'ports.json'))[key]
    if (base === undefined) throw Object.assign(new Error(`${key} chưa được cấp cổng; chạy \`wt-env.mjs alloc ${key}\` trước`), { exitCode: 1 })
    return base
  })

const USAGE = 'cách dùng: wt-env.mjs alloc [path] | env [path] | release [path] | check <worktree> | list | prune'

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const maxArgs = cmd === 'alloc' || cmd === 'env' || cmd === 'release' || cmd === 'check' ? 1 : 0
  if (!['alloc', 'env', 'release', 'check', 'list', 'prune'].includes(cmd) || rest.length > maxArgs || (cmd === 'check' && rest.length !== 1)) throw new Error(USAGE)
  if (cmd === 'check') {
    const problems = checkWorktree(rest[0])
    if (!problems.length) return console.log('ok')
    process.stderr.write(`wt-env: làn này đang dùng khoá/dữ liệu thật, đổi sang khoá test riêng trước khi chạy thử: ${problems.join('; ')}\n`)
    process.exitCode = 1
    return
  }
  const dir = stateDir()
  if (cmd === 'alloc') {
    const target = rest[0] ?? gitToplevel()
    console.log(envLines(target, await alloc(dir, target)).join('\n'))
  } else if (cmd === 'env') {
    const target = rest[0] ?? gitToplevel()
    console.log([ENV_NOTE, ...envLines(target, await lookup(dir, targetKey(target)))].join('\n'))
  } else if (cmd === 'release') {
    const { key, base } = await release(dir, rest[0])
    console.log(base === null ? `NOT_FOUND ${key}` : `RELEASED ${key} ${base}`)
  } else if (cmd === 'list') {
    console.log((await list(dir)).join('\n'))
  } else {
    const gone = await prune(dir)
    for (const [p, base] of gone) console.log(`PRUNED ${p} ${base}`)
    console.log(`pruned ${gone.length}`)
  }
}

export { loadRegistry, saveRegistry, withLock } // cho wt-env.test.mjs

// Chỉ chạy CLI khi được gọi trực tiếp (import từ test thì không). realpath.native để so khớp không lệ thuộc hoa/thường khi gõ đường dẫn trên Windows.
const isCli = (() => {
  try {
    return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isCli) {
  main().catch((e) => {
    process.stderr.write(`wt-env: ${e.message}\n`)
    process.exitCode = e.exitCode ?? 2
  })
}
