#!/usr/bin/env node
// wt-env.mjs - cấp cửa sổ 20 port cho mỗi worktree (theo mẫu Superset allocate_port_base).
//
//   node wt-env.mjs alloc [path]    in `PORT_BASE=<n>`; đã có thì in lại base cũ (path mặc định = git toplevel của cwd)
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

const USAGE = 'cách dùng: wt-env.mjs alloc [path] | release [path] | list | prune'

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const maxArgs = cmd === 'alloc' || cmd === 'release' ? 1 : 0
  if (!['alloc', 'release', 'list', 'prune'].includes(cmd) || rest.length > maxArgs) throw new Error(USAGE)
  const dir = stateDir()
  if (cmd === 'alloc') {
    console.log(`PORT_BASE=${await alloc(dir, rest[0])}`)
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
    process.exitCode = 2
  })
}
