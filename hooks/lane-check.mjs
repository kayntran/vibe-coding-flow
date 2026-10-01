#!/usr/bin/env node
// lane-check.mjs — kiểm bảng làn trong PLAN.md trước/sau khi chạy worker song song.
// Công cụ CLI (không phải hook): lỗi nội bộ/đầu vào không phân tích được ⇒ stderr + exit 2, không fail-open.
//
//   node lane-check.mjs plan <PLAN.md> [--repo <dir>]
//   node lane-check.mjs audit <PLAN.md> <lane> [--branch <b>] [--base main] [--worktree <path>] [--repo <dir>]
//     (so commit `base...branch` + thay đổi chưa commit ở worktree đang checkout nhánh đó)
//   node lane-check.mjs conflicts [--base <b>] [--repo <dir>] <branch1> <branch2> [...]
//
// Exit: 0 sạch · 1 có phát hiện (OVERLAP/HOT/BAD_DEP/CYCLE/OUTSIDE/CONFLICT) · 2 không chạy được (đầu vào/git hỏng).
// Bảng làn: header đúng tên cột `lane`, `files`, `depends_on` (bắt buộc); `worker`, `ops`, `accept` tuỳ chọn; cột khác bỏ qua.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg) }

const MAX_WAVE = 4
const REQUIRED_COLS = ['lane', 'files', 'depends_on']
const DEFAULT_HOT = [
  ...['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock*', 'go.sum', 'Cargo.lock', 'poetry.lock', 'uv.lock'].map((f) => `**/${f}`),
  'supabase/migrations/**', '**/migrations/**',
  'package.json', 'pnpm-workspace.yaml', 'tsconfig*.json', 'go.mod', 'wrangler.toml',
]

// ---------- git ----------

const GIT_ENV = (() => {
  const e = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete e[k]
  return e
})()

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, maxBuffer: 1 << 28 })
  if (r.error) fail(`không chạy được git: ${r.error.message}`)
  return r
}

function gitOk(cwd, args) {
  const r = git(cwd, args)
  if (r.status !== 0) fail(`git ${args.join(' ')} lỗi (exit ${r.status}): ${(r.stderr || '').trim()}`)
  return r.stdout
}

function repoRoot(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel'])
  if (r.status !== 0) fail(`"${dir}" không nằm trong git repo (truyền --repo <dir>): ${(r.stderr || '').trim()}`)
  return r.stdout.trim()
}

// ---------- tham số ----------

function parseArgs(argv, valueOpts) {
  const pos = []
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (!valueOpts.includes(name)) fail(`tuỳ chọn lạ: ${a}`)
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i]
    if (v === undefined || v === '') fail(`--${name} thiếu giá trị`)
    opts[name] = v
  }
  return { pos, opts }
}

// ---------- glob ----------

// `**/` = 0+ thư mục, `**` = mọi thứ kể cả `/`, `*` = trong một đoạn đường dẫn, `?` = một ký tự trong đoạn.
function globToRegex(g) {
  let re = ''
  for (let i = 0; i < g.length;) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3 } else { re += '.*'; i += 2 }
      } else { re += '[^/]*'; i++ }
    } else if (c === '?') { re += '[^/]'; i++ } else { re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i++ }
  }
  return new RegExp(`^${re}$`)
}

// prefix = phần tĩnh của glob tính tới thư mục chứa ký tự đại diện đầu tiên (glob không có ký tự đại diện: cả đường dẫn).
// probe = đường dẫn đại diện để thử khớp glob khác (chỉ dùng cho glob chưa khớp file nào).
function makeGlob(raw) {
  let src = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (src.endsWith('/')) src += '**'
  const w = src.search(/[*?]/)
  const wild = w >= 0
  const prefix = wild ? src.slice(0, w).slice(0, src.slice(0, w).lastIndexOf('/') + 1) : src
  return { src, re: globToRegex(src), wild, prefix, probe: wild ? `${prefix}x` : src }
}

// Hai tiền tố có lồng nhau không (a/ ⊂ a/b/, a/b ⊂ a/b/c.ts; a/b KHÔNG lồng a/bc/).
function nest(p, q) {
  const [s, l] = p.length <= q.length ? [p, q] : [q, p]
  if (s === '' || l === s) return true
  return l.startsWith(s.endsWith('/') ? s : `${s}/`)
}

const longer = (p, q) => (p.length >= q.length ? p : q)

// ---------- bảng làn ----------

function splitRow(line) {
  let s = line.trim().replace(/\\\|/g, '\u0000')
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.replace(/\u0000/g, '|').trim())
}

const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
const normHeader = (h) => h.replace(/`/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_')
const stripTicks = (s) => s.replace(/^`+|`+$/g, '').trim()

function splitList(cell) {
  return cell.split(',').map(stripTicks).filter((s) => s && s !== '-')
}

function parsePlan(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { fail(`không đọc được ${file}: ${e.message}`) }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  let firstMissing = null
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !lines[i + 1].trim().startsWith('|')) continue
    const header = splitRow(lines[i]).map(normHeader)
    if (!header.includes('lane') || !isSeparator(splitRow(lines[i + 1]))) continue
    const missing = REQUIRED_COLS.filter((c) => !header.includes(c))
    if (missing.length) { firstMissing ??= { missing, header }; continue }
    return readLanes(lines, i, header, file)
  }
  if (firstMissing) {
    fail(`bảng làn trong ${file} thiếu cột: ${firstMissing.missing.join(', ')} (header có: ${firstMissing.header.join(', ')}; bắt buộc: ${REQUIRED_COLS.join(', ')})`)
  }
  fail(`không thấy bảng làn trong ${file} (cần bảng Markdown có cột ${REQUIRED_COLS.join(', ')})`)
}

function readLanes(lines, headerIdx, header, file) {
  const lanes = []
  const seen = new Set()
  for (let j = headerIdx + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
    const cells = splitRow(lines[j])
    if (cells.every((c) => c === '')) continue
    if (cells.length > header.length) {
      fail(`${file}:${j + 1}: dòng có ${cells.length} cột nhưng header có ${header.length} (ký tự | trong ô phải viết \\|)`)
    }
    const rec = {}
    header.forEach((h, k) => { if (!(h in rec)) rec[h] = cells[k] ?? '' })
    const name = stripTicks(rec.lane)
    if (!name) fail(`${file}:${j + 1}: ô lane trống`)
    if (seen.has(name)) fail(`${file}:${j + 1}: làn "${name}" khai báo hai lần`)
    seen.add(name)
    const accept = stripTicks(rec.accept ?? '')
    lanes.push({
      name,
      worker: stripTicks(rec.worker ?? ''),
      ops: rec.ops ?? '',
      files: splitList(rec.files),
      deps: [...new Set(splitList(rec.depends_on))],
      accept: accept === '-' ? '' : accept,
    })
  }
  if (!lanes.length) fail(`bảng làn trong ${file} không có dòng dữ liệu`)
  return lanes
}

// ---------- plan ----------

function loadHot(repo) {
  const f = path.join(repo, '.claude', 'flow.json')
  if (!fs.existsSync(f)) return DEFAULT_HOT
  let j
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { fail(`${f} không phải JSON hợp lệ: ${e.message}`) }
  if (j.hot === undefined) return DEFAULT_HOT
  if (!Array.isArray(j.hot) || j.hot.some((x) => typeof x !== 'string')) fail(`${f}: "hot" phải là mảng chuỗi glob`)
  return [...DEFAULT_HOT, ...j.hot]
}

function findCycles(lanes, byName) {
  const state = new Map()
  const stack = []
  const cycles = new Map()
  const dfs = (n) => {
    state.set(n, 1)
    stack.push(n)
    for (const d of byName.get(n).deps) {
      if (!byName.has(d)) continue
      if (state.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d))
        cycles.set([...cyc].sort().join(','), [...cyc, d])
      } else if (!state.has(d)) dfs(d)
    }
    stack.pop()
    state.set(n, 2)
  }
  for (const l of lanes) if (!state.has(l.name)) dfs(l.name)
  return [...cycles.values()]
}

function cmdPlan(argv) {
  const { pos, opts } = parseArgs(argv, ['repo'])
  if (pos.length !== 1) fail('cú pháp: plan <PLAN.md> [--repo <dir>]')
  const planFile = path.resolve(pos[0])
  const lanes = parsePlan(planFile)
  const repo = repoRoot(opts.repo ? path.resolve(opts.repo) : path.dirname(planFile))
  const tracked = gitOk(repo, ['ls-files', '-z']).split('\0').filter(Boolean)
  const hot = loadHot(repo).map(makeGlob)

  const order = new Map(lanes.map((l, i) => [l.name, i]))
  const byName = new Map(lanes.map((l) => [l.name, l]))
  const byOrder = (set) => [...set].sort((a, b) => order.get(a) - order.get(b))

  for (const l of lanes) {
    l.globs = l.files.map(makeGlob)
    l.existing = new Set()
    l.fresh = []
    for (const g of l.globs) {
      const hits = tracked.filter((f) => g.re.test(f))
      if (hits.length) hits.forEach((f) => l.existing.add(f))
      else l.fresh.push(g)
    }
  }

  const errors = []
  const warns = []

  // OVERLAP: file có sẵn thuộc >=2 làn; glob chưa khớp file nào so tiền tố tĩnh với mọi glob của làn khác.
  const overlaps = new Map()
  const addOverlap = (p, ...ls) => {
    if (!overlaps.has(p)) overlaps.set(p, new Set())
    ls.forEach((x) => overlaps.get(p).add(x))
  }
  const fileLanes = new Map()
  for (const l of lanes) for (const f of l.existing) {
    if (!fileLanes.has(f)) fileLanes.set(f, new Set())
    fileLanes.get(f).add(l.name)
  }
  for (const [f, ls] of fileLanes) if (ls.size > 1) addOverlap(f, ...ls)
  for (const x of lanes) for (const y of lanes) {
    if (x === y) continue
    for (const u of x.fresh) for (const g of y.globs) {
      if (nest(u.prefix, g.prefix)) addOverlap(longer(u.prefix, g.prefix) || '(toàn repo)', x.name, y.name)
    }
  }
  for (const p of [...overlaps.keys()].sort()) errors.push(`OVERLAP ${p} lanes: ${byOrder(overlaps.get(p)).join(' ')}`)

  // HOT: mỗi file ghi nhận vào MỌI mẫu nóng khớp; mẫu có >=2 làn chạm vào ⇒ lỗi.
  // Hai mẫu cho cùng tập làn + cùng tập file (vd supabase/migrations/** và **/migrations/**) chỉ in một dòng, mẫu đứng trước thắng.
  const hotHits = new Map()
  const touch = (h, lane, ex) => {
    if (!hotHits.has(h.src)) hotHits.set(h.src, new Map())
    const m = hotHits.get(h.src)
    if (!m.has(lane)) m.set(lane, new Set())
    m.get(lane).add(ex)
  }
  for (const l of lanes) {
    for (const f of l.existing) for (const h of hot) if (h.re.test(f)) touch(h, l.name, f)
    for (const u of l.fresh) for (const h of hot) if (h.re.test(u.probe)) touch(h, l.name, u.src)
  }
  const hotSeen = new Set()
  for (const h of hot) {
    const m = hotHits.get(h.src)
    if (!m || m.size < 2) continue
    const ls = byOrder(m.keys()).join(' ')
    const ex = [...new Set([...m.values()].flatMap((s) => [...s]))].sort()
    const key = `${ls}|${ex.join('\n')}`
    if (hotSeen.has(key)) continue
    hotSeen.add(key)
    errors.push(`HOT ${h.src} lanes: ${ls} (file nóng; vd: ${ex.slice(0, 4).join(', ')}${ex.length > 4 ? ', …' : ''})`)
  }

  // depends_on: làn không tồn tại, vòng.
  let depsOk = true
  for (const l of lanes) for (const d of l.deps) {
    if (!byName.has(d)) { errors.push(`BAD_DEP ${l.name} depends_on unknown lane ${d}`); depsOk = false }
  }
  const cycles = findCycles(lanes, byName)
  for (const c of cycles) errors.push(`CYCLE ${c.join(' -> ')}`)

  // Wave = 1 + wave lớn nhất của các làn nó phụ thuộc.
  const out = []
  let waveCount = 0
  if (depsOk && !cycles.length) {
    const memo = new Map()
    const waveOf = (n) => {
      if (!memo.has(n)) memo.set(n, 1 + Math.max(0, ...byName.get(n).deps.map(waveOf)))
      return memo.get(n)
    }
    const waves = new Map()
    for (const l of lanes) {
      const w = waveOf(l.name)
      if (!waves.has(w)) waves.set(w, [])
      waves.get(w).push(l)
    }
    waveCount = waves.size
    for (const w of [...waves.keys()].sort((a, b) => a - b)) {
      const ls = waves.get(w)
      out.push(`wave ${w}: ${ls.map((l) => l.name).join(', ')}`)
      for (const l of ls) {
        const worker = l.worker ? ` [${l.worker}]` : ''
        out.push(`  ${l.name}${worker} ops: ${l.ops || '-'} (${l.existing.size} file có sẵn, ${l.fresh.length} glob mới)`)
      }
      if (ls.length > MAX_WAVE) warns.push(`WARN wave ${w} có ${ls.length} làn (> ${MAX_WAVE}): ${ls.map((l) => l.name).join(', ')}`)
    }
  }
  for (const l of lanes) if (!l.accept) warns.push(`WARN lane ${l.name} thiếu accept`)

  out.push(...errors, ...warns)
  out.push(errors.length
    ? `FAIL: ${errors.length} lỗi, ${warns.length} cảnh báo`
    : `OK: ${lanes.length} làn, ${waveCount} wave, ${warns.length} cảnh báo`)
  return { lines: out, code: errors.length ? 1 : 0 }
}

// ---------- audit ----------

// Worktree đang checkout `branch` (HEAD = chính repo); không có thì null.
function worktreeOf(repo, branch) {
  if (branch === 'HEAD') return repo
  const want = branch.replace(/^refs\/heads\//, '')
  for (const block of gitOk(repo, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)) {
    let wt = null
    let br = null
    let prunable = false
    for (const ln of block.split(/\r?\n/)) {
      if (ln.startsWith('worktree ')) wt = ln.slice('worktree '.length)
      else if (ln.startsWith('branch ')) br = ln.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (ln.startsWith('prunable')) prunable = true
    }
    if (wt && br === want && !prunable && fs.existsSync(wt)) return wt
  }
  return null
}

// Đường dẫn đổi chưa commit: staged + unstaged + untracked (từng file). --no-renames để đổi tên lộ cả hai đầu.
function uncommittedPaths(wt, excludeAbs) {
  const root = repoRoot(wt)
  const rel = path.relative(root, excludeAbs).replace(/\\/g, '/')
  const skip = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
  return gitOk(root, ['status', '--porcelain', '--untracked-files=all', '--no-renames', '-z'])
    .split('\0').filter(Boolean).map((e) => e.slice(3)).filter((f) => f !== skip)
}

function cmdAudit(argv) {
  const { pos, opts } = parseArgs(argv, ['repo', 'branch', 'base', 'worktree'])
  if (pos.length !== 2) fail('cú pháp: audit <PLAN.md> <lane> [--branch <b>] [--base main] [--worktree <path>] [--repo <dir>]')
  const planFile = path.resolve(pos[0])
  const lanes = parsePlan(planFile)
  const lane = lanes.find((l) => l.name === pos[1])
  if (!lane) fail(`không có làn "${pos[1]}" trong ${planFile} (có: ${lanes.map((l) => l.name).join(', ')})`)
  const repo = repoRoot(opts.repo ? path.resolve(opts.repo) : path.dirname(planFile))
  const base = opts.base ?? 'main'
  const branch = opts.branch ?? 'HEAD'
  // --no-renames: đổi tên ra ngoài scope vẫn lộ đường dẫn mới (và đường dẫn cũ bị xoá).
  const committed = gitOk(repo, ['diff', '--name-only', '--no-renames', '-z', `${base}...${branch}`]).split('\0').filter(Boolean)
  // Thay đổi chưa commit nằm ở worktree đang checkout nhánh (--worktree ghi đè); PLAN.md không tính là sản phẩm của worker.
  const wt = opts.worktree ? path.resolve(opts.worktree) : worktreeOf(repo, branch)
  const dirty = wt ? uncommittedPaths(wt, planFile) : []
  const changed = [...new Set([...committed, ...dirty])]
  const globs = lane.files.map(makeGlob)
  const outside = changed.filter((f) => !globs.some((g) => g.re.test(f)))
  const lines = outside.map((f) => `OUTSIDE ${f}`)
  if (!wt) lines.push(`WARN không tìm thấy worktree của nhánh ${branch}: chỉ so commit, bỏ qua thay đổi chưa commit (truyền --worktree <path>)`)
  const scope = `${base}...${branch}${wt ? ' + chưa commit' : ''}`
  lines.push(outside.length
    ? `FAIL audit lane ${lane.name}: ${outside.length}/${changed.length} file ngoài scope (${scope})`
    : `OK audit lane ${lane.name}: ${changed.length} file đổi, đều trong scope (${scope})`)
  return { lines, code: outside.length ? 1 : 0 }
}

// ---------- conflicts ----------

function cmdConflicts(argv) {
  const { pos: branches, opts } = parseArgs(argv, ['repo', 'base'])
  const repo = repoRoot(opts.repo ? path.resolve(opts.repo) : process.cwd())
  const nodes = opts.base ? [opts.base, ...branches] : [...branches]
  if (nodes.length < 2) fail('cú pháp: conflicts [--base <b>] [--repo <dir>] <branch1> <branch2> [...] (cần ít nhất 2 nhánh, hoặc 1 nhánh + --base)')
  if (new Set(nodes).size !== nodes.length) fail('tên nhánh bị lặp')
  for (const n of nodes) {
    const r = git(repo, ['rev-parse', '--verify', '--quiet', `${n}^{commit}`])
    if (r.status !== 0) fail(`nhánh/ref không tồn tại: ${n}`)
  }

  const lines = []
  const degree = new Map(branches.map((b) => [b, 0]))
  let conflicts = 0
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const [x, y] = [nodes[i], nodes[j]]
    const r = git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', x, y])
    if (r.status === 0) continue
    const [tree, ...files] = r.stdout.split('\0')
    if (r.status !== 1 || !/^[0-9a-f]{40,64}$/.test(tree)) {
      fail(`git merge-tree ${x} ${y} lỗi (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`)
    }
    conflicts++
    lines.push(`CONFLICT ${x} ${y}: ${[...new Set(files.filter(Boolean))].join(', ')}`)
    for (const n of [x, y]) if (degree.has(n)) degree.set(n, degree.get(n) + 1)
  }
  // Nhánh không xung đột trước (sort ổn định: giữ thứ tự nhập khi bằng nhau).
  const ordered = [...branches].sort((a, b) => degree.get(a) - degree.get(b))
  lines.push(`merge order: ${ordered.join(', ')}`)
  lines.push(conflicts ? `FAIL: ${conflicts} cặp xung đột` : `OK: không xung đột (${nodes.length} nhánh)`)
  return { lines, code: conflicts ? 1 : 0 }
}

// ---------- main ----------

const USAGE = `lane-check.mjs — kiểm làn song song
  plan <PLAN.md> [--repo <dir>]
  audit <PLAN.md> <lane> [--branch <b>] [--base main] [--worktree <path>] [--repo <dir>]
  conflicts [--base <b>] [--repo <dir>] <branch1> <branch2> [...]`

function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return { lines: [USAGE], code: 0 }
  if (cmd === 'plan') return cmdPlan(rest)
  if (cmd === 'audit') return cmdAudit(rest)
  if (cmd === 'conflicts') return cmdConflicts(rest)
  return fail(`lệnh không hợp lệ: ${cmd ?? '(trống)'}\n${USAGE}`)
}

try {
  const { lines, code } = main(process.argv.slice(2))
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exitCode = code
} catch (e) {
  process.stderr.write(`lane-check: ${e instanceof Fail ? e.message : e.stack || e}\n`)
  process.exitCode = 2
}
