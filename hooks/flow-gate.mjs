// flow-gate: cổng worktree/review/qa/test cho flow captain + worker. Một script, chế độ chọn bằng argv[2].
//   hook : edit (PreToolUse Edit|Write|NotebookEdit) · bash (PreToolUse Bash: chặn git merge thiếu dấu, git commit/push có secret,
//          lệnh phá huỷ trên nhánh chính; hỏi lại khi push nhánh chính) · stop (Stop) · subagent-stop (SubagentStop: receipt + audit phạm vi làn)
//   CLI  : stamp review <file.json> · stamp qa <file.md> · stamp test -- <lệnh…> · status      (chạy trong worktree)
// Spec: ~/.claude/plans/flow-v2-hooks-spec.md, flow-v3-hooks-spec.md (Làn A: quét secret), flow-v5-hooks-spec.md (Làn A: dấu test, lệnh phá huỷ, ask, audit).
// Docs field input: https://code.claude.com/docs/en/hooks
// Lỗi nội bộ ở chế độ hook luôn CHO QUA (exit 0, không in gì) và ghi một dòng vào flow-gate.log.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefPlan, briefWord } from './lib/brief.mjs'

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = process.env.FLOW_GATE_LOG || path.join(HOOK_DIR, 'flow-gate.log')
const DEFAULT_UI = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/i
const DOC_FILE = /\.(md|mdx|txt)$/i // diff chỉ có file này (hoặc dưới docs/) ⇒ không đòi dấu test
const RECEIPT_AGENTS = new Set(['coder', 'coder-lite', 'recon', 'researcher', 'test-runner', 'qa-tester', 'debugger', 'code-reviewer'])
const RECEIPT_RE = /return=(done_with_concerns|done|needs_context|blocked|green|red)\b/ // green|red là của test-runner
const NA_RE = /^\uFEFF?\s*N\/A/i
const AUDIT_AGENTS = new Set(['coder', 'coder-lite']) // worker vi\u1EBFt code: n\u1ED9p b\u00E0i th\u00EC audit ph\u1EA1m vi l\u00E0n

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.argv[2] ?? ''}] ${String(msg).replace(/\r?\n/g, ' | ')}\n`)
  } catch {}
}

// ---------- git helpers ----------

// Trả stdout (có thể là chuỗi rỗng) hoặc null khi git lỗi.
function git(dir, args, { raw = false } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: raw ? 'buffer' : 'utf8', maxBuffer: 1 << 29, timeout: 20000, windowsHide: true,
  })
  if (r.error) { log(`git ${args[0]}: ${r.error.message}`); return null }
  return r.status === 0 ? r.stdout : null
}

// Như git() nhưng chỉ nhận tối đa `limit` byte stdout: trả { text, truncated } hoặc null khi git lỗi. Vượt giới hạn ⇒ truncated.
function gitCapped(dir, args, limit) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: limit, timeout: 20000, windowsHide: true })
  if (r.error) {
    if (r.error.code === 'ENOBUFS' && typeof r.stdout === 'string') return { text: r.stdout, truncated: true }
    log(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]}: ${r.error.message}`)
    return null
  }
  return r.status === 0 ? { text: r.stdout, truncated: false } : null
}

const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))

// Git bash đưa đường dẫn kiểu /c/Users/... — đổi sang C:/Users/... để Node hiểu.
function toNative(p) {
  return process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p
}

// Thư mục tồn tại gần nhất của path (path là file/thư mục chưa tồn tại cũng được).
function existingDir(p) {
  let d = path.resolve(p)
  for (;;) {
    try { if (fs.statSync(d).isDirectory()) return d } catch {}
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

function repoInfo(p) {
  const dir = existingDir(p)
  if (!dir) return null
  const out = git(dir, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'])
  if (!out) return null
  const [top, gd, cd] = out.split(/\r?\n/)
  if (!top || !gd || !cd) return null
  const gitDir = path.resolve(dir, gd)
  const commonDir = path.resolve(dir, cd)
  const branch = (git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '').trim() || null
  return {
    dir, toplevel: path.resolve(top), gitDir, commonDir, branch,
    linked: norm(gitDir) !== norm(commonDir),
    gatesDir: path.join(commonDir, 'flow-gates'),
  }
}

function mainBranch(info) {
  return git(info.dir, ['show-ref', '--verify', '--quiet', 'refs/heads/main']) !== null ? 'main' : 'master'
}

function patchId(dir, base, head) {
  const diff = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--binary', `${base}...${head}`, '--'], { raw: true })
  if (!diff || diff.length === 0) return null
  // --verbatim (không phải --stable): đổi khoảng trắng/thụt lề cũng đổi id, dấu cũ mất hiệu lực.
  const r = spawnSync('git', ['patch-id', '--verbatim'], { input: diff, encoding: 'utf8', timeout: 20000, windowsHide: true })
  if (r.error || r.status !== 0) return null
  const tok = r.stdout.trim().split(/\s+/)[0]
  return /^[0-9a-f]{40,64}$/.test(tok) ? tok : null
}

function uiTouched(info, base, head) {
  const out = git(info.dir, ['diff', '--name-only', '-z', `${base}...${head}`, '--'])
  if (!out) return false
  let re = DEFAULT_UI
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(info.toplevel, '.claude', 'flow.json'), 'utf8'))
    if (typeof cfg?.uiPattern === 'string' && cfg.uiPattern) re = new RegExp(cfg.uiPattern)
  } catch (e) {
    if (e?.code !== 'ENOENT') log(`flow.json: ${e.message}`)
  }
  return out.split('\0').some((f) => f && re.test(f))
}

// Nội dung file dấu; ENOENT = chưa có dấu (null). Lỗi đọc khác thì ném ra, không được coi là "thiếu".
function readMark(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

// Lý do KHÔNG đòi dấu test cho diff base...head (null = vẫn đòi): repo có .claude/flow.json {"tests":"none"} (thiếu/hỏng ⇒ vẫn đòi),
// hoặc diff chỉ gồm tài liệu (.md/.mdx/.txt, hoặc dưới docs/ ở gốc repo). --no-renames: đổi tên code → tài liệu vẫn lộ đường dẫn cũ.
function testExemption(info, base, head) {
  try {
    if (JSON.parse(fs.readFileSync(path.join(info.toplevel, '.claude', 'flow.json'), 'utf8'))?.tests === 'none') return 'flow.json tests=none'
  } catch (e) {
    if (e?.code !== 'ENOENT') log(`flow.json: ${e.message}`)
  }
  const files = (git(info.dir, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--']) ?? '').split('\0').filter(Boolean)
  return files.length > 0 && files.every((f) => DOC_FILE.test(f) || f.startsWith('docs/')) ? 'diff chỉ có tài liệu' : null
}

// Trạng thái dấu của diff base...head. null = không có diff (không gate). Ném lỗi nếu không đọc nổi dấu.
function gateState(info, base, head) {
  const pid = patchId(info.dir, base, head)
  if (!pid) return null
  const ui = uiTouched(info, base, head)
  const hasReview = readMark(path.join(info.gatesDir, `review-${pid}.json`)) !== null
  const qa = readMark(path.join(info.gatesDir, `qa-${pid}.md`))
  const naOnUi = qa !== null && ui && NA_RE.test(qa)
  const hasQa = qa !== null && !naOnUi
  const testExempt = testExemption(info, base, head)
  const hasTest = readMark(path.join(info.gatesDir, `test-${pid}.json`)) !== null
  const missing = []
  if (!hasReview) missing.push('review')
  if (!hasQa) missing.push('qa')
  if (testExempt === null && !hasTest) missing.push('test')
  return { pid, ui, hasReview, hasQa, naOnUi, testExempt, hasTest, missing }
}

// ---------- hook handlers: trả object để in, hoặc null = cho qua ----------

function hookEdit(input) {
  const ti = input.tool_input
  const p = ti?.file_path ?? ti?.notebook_path
  if (typeof p !== 'string' || !p) return null
  const info = repoInfo(path.resolve(input.cwd || process.cwd(), toNative(p)))
  if (!info || info.linked) return null
  if (fs.existsSync(path.join(info.toplevel, '.claude', 'allow-direct-edit'))) return null
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Đang sửa thẳng thư mục chính của ${info.toplevel} (nhánh ${info.branch ?? '?'}). ` +
        'Gọi EnterWorktree để tạo worktree trước khi sửa file. ' +
        'Muốn sửa thẳng thì user tạo file .claude/allow-direct-edit trong repo.',
    },
  }
}

// Đọc dấu hiệu heredoc `<<[-] WORD` tại cmd[i] ('<' đầu tiên). Trả { word, dash, end } (end = chỉ số sau WORD) hoặc null.
function heredocMarker(cmd, i) {
  if (cmd[i + 1] !== '<' || cmd[i + 2] === '<') return null // `<<<` là here-string, không phải heredoc
  let j = i + 2
  const dash = cmd[j] === '-'
  if (dash) j++
  while (cmd[j] === ' ' || cmd[j] === '\t') j++
  let word = ''
  for (; j < cmd.length; j++) {
    const d = cmd[j]
    if (d === '"' || d === "'") {
      const close = cmd.indexOf(d, j + 1)
      const end = close < 0 ? cmd.length : close
      word += cmd.slice(j + 1, end)
      j = end
    } else if (d === '\\') continue
    else if (/[\s;&|()<>]/.test(d)) break
    else word += d
  }
  return word ? { word, dash, end: j } : null
}

// Tách lệnh shell thành các đoạn (ngắt ở && || ; | & ( ) xuống dòng > <) gồm các token đã bỏ nháy.
// Bỏ comment # (ngoài nháy, đầu từ) và thân heredoc để chữ trong đó không bị đọc thành lệnh.
function tokenize(cmd) {
  const segs = []
  let cur = []
  let tok = ''
  let has = false
  let quote = null
  const heredocs = []
  const flush = () => { if (has) cur.push(tok); tok = ''; has = false }
  const cut = () => { flush(); if (cur.length) segs.push(cur); cur = [] }
  // Bỏ thân các heredoc đang chờ, bắt đầu từ dòng sau nl; trả chỉ số ký tự cuối của dòng đóng heredoc.
  const skipHeredocBodies = (nl) => {
    let pos = nl + 1
    for (const { word, dash } of heredocs) {
      while (pos < cmd.length) {
        let eol = cmd.indexOf('\n', pos)
        if (eol < 0) eol = cmd.length
        const line = cmd.slice(pos, eol).replace(/\r$/, '')
        pos = eol + 1
        if ((dash ? line.replace(/^\t+/, '') : line) === word) break
      }
    }
    heredocs.length = 0
    return pos - 1
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && c === '\\' && /["\\$`]/.test(cmd[i + 1] ?? '')) tok += cmd[++i]
      else tok += c
    } else if (c === '"' || c === "'") { quote = c; has = true }
    else if (c === '\\' && (cmd[i + 1] === '\n' || (cmd[i + 1] === '\r' && cmd[i + 2] === '\n'))) { flush(); i += cmd[i + 1] === '\r' ? 2 : 1 }
    else if (/\s/.test(c) && c !== '\n') flush()
    else if (c === '#' && !has) { while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++ }
    else if (c === '<' && heredocMarker(cmd, i)) {
      const { word, dash, end } = heredocMarker(cmd, i)
      heredocs.push({ word, dash })
      cut()
      i = end - 1
    }
    else if (c === '\n') { cut(); if (heredocs.length) i = skipHeredocBodies(i) }
    else if (c === '>' || c === '<') { if (has && /^\d+$/.test(tok)) { tok = ''; has = false } cut() }
    else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') cut()
    else { tok += c; has = true }
  }
  cut()
  return segs
}

const MERGE_VALUE_FLAGS = new Set(['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name'])

// tokens = một đoạn lệnh. Trả { dir, sub, rest } nếu là `git [-C p] <sub> ...`, ngược lại null.
function parseGitSub(tokens, cwd) {
  let i = 0
  while (/^[A-Za-z_]\w*=/.test(tokens[i] ?? '')) i++
  if (!/(^|[\\/])git(\.exe)?$/i.test(tokens[i] ?? '')) return null
  i++
  let dir = cwd
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C') { dir = path.resolve(dir, toNative(tokens[i + 1] ?? '.')); i += 2 }
    else if (tokens[i] === '-c') i += 2
    else i++
  }
  return tokens[i] ? { dir, sub: tokens[i], rest: tokens.slice(i + 1) } : null
}

// g = kết quả parseGitSub. Trả { dir, targets } nếu là `git [-C p] merge ... <branch>...`, ngược lại null.
function parseGitMerge(g) {
  if (g.sub !== 'merge') return null
  const { dir, rest } = g
  if (rest.some((t) => /^--(abort|continue|quit)$/.test(t))) return null
  const targets = []
  let onlyPositional = false
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]
    if (!onlyPositional && t === '--') onlyPositional = true
    else if (!onlyPositional && t.startsWith('-')) { if (MERGE_VALUE_FLAGS.has(t)) j++ }
    else targets.push(t)
  }
  return targets.length ? { dir, targets } : null
}

// gateState cho hook: không đọc nổi dấu (lỗi khác ENOENT) thì ghi log và coi như không gate (cho qua).
function tryGateState(info, base, head) {
  try {
    return gateState(info, base, head)
  } catch (e) {
    log(`gateState ${head}: ${e?.stack ?? e}`)
    return null
  }
}

// ---------- quét secret trước git commit / git push ----------

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const SCAN_LIMIT = 20 * 1024 * 1024
const ALLOW_MARK = 'flow-gate: allow-secret'
// Tên mẫu ↔ regex (mỗi dòng chỉ lấy khớp đầu tiên của từng mẫu). url-credential: bỏ mật khẩu dạng placeholder ($VAR, {{x}}, <pw>);
// lookbehind để chỉ thử từ đầu mỗi cụm scheme (tránh O(n^2) với dòng dài toàn [a-z0-9]).
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws', /AKIA[0-9A-Z]{16}/],
  ['github', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['github', /github_pat_[A-Za-z0-9_]{60,}/],
  ['anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai', /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['xai', /xai-[A-Za-z0-9]{40,}/],
  ['google', /AIza[0-9A-Za-z_-]{35}/],
  ['slack', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['url-credential', /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/$<{][^@\s/]{7,}@/i],
]

function isSensitiveFile(file) {
  const n = path.posix.basename(file).toLowerCase()
  if (n === '.env') return true
  if (n.startsWith('.env.')) return !/\.(example|sample|template)$/.test(n)
  if (/^id_(rsa|ed25519)/.test(n)) return !n.endsWith('.pub') // khoá công khai không phải secret
  return n.endsWith('.pem') || n === '.dev.vars' || n === 'credentials.json'
}

// Các khớp secret trong một dòng: [{ name, value }] với value đã che (4 ký tự đầu + …).
function scanLine(text) {
  const hits = []
  for (const [name, re] of SECRET_PATTERNS) {
    const m = re.exec(text)
    if (!m) continue
    const end = m.index + m[0].length
    if (hits.some((h) => m.index < h.end && h.index < end)) continue // cùng một token đã được mẫu khác báo (sk-ant-… vs openai)
    hits.push({ name, index: m.index, end, value: `${m[0].slice(0, 4)}…` })
  }
  return hits
}

// Duyệt `git diff -U0` (đã --no-prefix): trả { findings: [{file, line, name, value}], allowed: Set<file có dòng allow> }.
function scanPatch(patch) {
  const findings = []
  const allowed = new Set()
  let file = null
  let line = 0
  let inHunk = false
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; file = null; continue }
    if (l.startsWith('@@ ')) { line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0); inHunk = true; continue }
    if (!inHunk) {
      if (l.startsWith('+++ ')) { const f = l.slice(4).replace(/\t$/, ''); file = f === '/dev/null' ? null : f }
      continue
    }
    if (l[0] !== '+' || file === null) continue
    const text = l.slice(1)
    const lineNo = line++
    if (text.includes(ALLOW_MARK)) { allowed.add(file); continue }
    for (const h of scanLine(text)) findings.push({ file, line: lineNo, name: h.name, value: h.value })
  }
  return { findings, allowed }
}

// scan = { cmd: 'diff' | 'log', args, paths? }. diff: so sánh theo args (['--cached'], ['HEAD']…). log: từng commit không-merge
// trong phạm vi args (['<base>..<sha>'] hoặc ['<sha>']), nên token thêm ở commit A rồi xoá ở commit B vẫn bị thấy.
// Trả { findings, truncated } (lỗi git ⇒ rỗng; truncated = output vượt SCAN_LIMIT, phần sau không được quét).
function runScan(dir, { cmd, args, paths = [] }) {
  const common = ['-c', 'core.quotepath=off', cmd, '--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix']
  const logOnly = cmd === 'log' ? ['--no-merges', '--no-show-signature', '--format='] : []
  const tail = [...args, '--', ...paths]
  const patch = gitCapped(dir, [...common, ...logOnly, ...(cmd === 'log' ? ['-p'] : []), '-U0', ...tail], SCAN_LIMIT)
  if (patch === null) return { findings: [], truncated: false }
  const { findings, allowed } = scanPatch(patch.text)
  const names = gitCapped(dir, [...common, ...logOnly, '--name-only', '-z', '--diff-filter=ACMR', ...tail], SCAN_LIMIT)
  for (const f of (names?.text ?? '').split('\0')) {
    // dòng allow trong chính file đó là lối thoát cho file nhạy cảm bị báo nhầm
    if (f && isSensitiveFile(f) && !allowed.has(f)) findings.push({ file: f, line: null, name: 'file nhạy cảm', value: null })
  }
  return { findings, truncated: patch.truncated || (names?.truncated ?? false) }
}

const revOf = (info, ref) => (git(info.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) ?? '').trim()

const COMMIT_VALUE_FLAGS = new Set([
  '-m', '-F', '-C', '-c', '-t', '--message', '--file', '--reuse-message', '--reedit-message', '--template',
  '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer',
])

// rest = đối số sau `git commit`. Trả { dryRun, all, include, fromFile, paths }:
// all = -a/--all/-am; include = -i/--include; paths = pathspec (kể cả sau `--`); fromFile = --pathspec-from-file (không biết path).
function parseCommitFlags(rest) {
  const c = { dryRun: false, all: false, include: false, fromFile: false, paths: [] }
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]
    if (t === '--') { c.paths.push(...rest.slice(j + 1)); break }
    if (t === '--dry-run') c.dryRun = true
    else if (t === '--all') c.all = true
    else if (t === '--include') c.include = true
    else if (t.startsWith('--pathspec-from-file')) { c.fromFile = true; if (t === '--pathspec-from-file') j++ }
    else if (COMMIT_VALUE_FLAGS.has(t)) j++
    else if (/^-[A-Za-z]/.test(t)) { // cụm cờ ngắn như -am; từ cờ nhận giá trị trở đi là giá trị
      const cluster = t.slice(1)
      for (let k = 0; k < cluster.length; k++) {
        if (cluster[k] === 'a') c.all = true
        if (cluster[k] === 'i') c.include = true
        if ('mFCct'.includes(cluster[k])) { if (k === cluster.length - 1) j++; break }
        if ('uS'.includes(cluster[k])) break // -uall, -S<keyid>: phần còn lại là giá trị đính kèm
      }
    } else if (!t.startsWith('-')) c.paths.push(t)
  }
  return c
}

// Commit sẽ chứa gì: mặc định = index (--cached); -a = working tree so với HEAD (không cộng index cũ);
// pathspec/--only = bản working tree của các path đó so với HEAD; --include = index + bản working tree của path. HEAD chưa có ⇒ cây rỗng.
function commitScans(info, c) {
  if (!c.all && !c.fromFile && c.paths.length === 0) return [{ cmd: 'diff', args: ['--cached'] }]
  const head = revOf(info, 'HEAD') ? 'HEAD' : EMPTY_TREE
  if (c.all || c.fromFile) return [{ cmd: 'diff', args: [head] }]
  const work = { cmd: 'diff', args: [head], paths: c.paths }
  return c.include ? [{ cmd: 'diff', args: ['--cached'] }, work] : [work]
}

const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--recurse-submodules'])

// Cờ ép của git push: --force, --force-with-lease[=…], --force-if-includes, hoặc cụm cờ ngắn có f (-f, -fu, -uf; từ `o` trở đi là giá trị của -o).
const isForceFlag = (t) => t === '--force' || t === '--force-if-includes' || t.startsWith('--force-with-lease') ||
  (/^-[A-Za-z]+$/.test(t) && /^[^o]*f/.test(t.slice(1)))

// rest = đối số sau `git push`. Trả { skip, dryRun, del, force, all, mirror, tags, repo, positional }
// (skip = dry-run hoặc xoá ref: không gửi commit nào; del = --delete/-d: positional sau remote là tên nhánh bị xoá).
function parsePushArgs(rest) {
  const p = { skip: false, dryRun: false, del: false, force: false, all: false, mirror: false, tags: false, repo: null, positional: [] }
  let onlyPositional = false
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]
    if (!onlyPositional && t === '--') onlyPositional = true
    else if (onlyPositional || !t.startsWith('-')) p.positional.push(t)
    else if (t === '--dry-run' || t === '-n') p.skip = p.dryRun = true
    else if (t === '--delete' || t === '-d') p.skip = p.del = true
    else if (t === '--all' || t === '--branches') p.all = true
    else if (t === '--mirror') p.mirror = true
    else if (t === '--tags') p.tags = true
    else if (isForceFlag(t)) p.force = true
    else if (t === '--repo') p.repo = rest[++j] ?? null
    else if (t.startsWith('--repo=')) p.repo = t.slice(7)
    else if (PUSH_VALUE_FLAGS.has(t)) j++
  }
  return p
}

// Các ref sẽ được gửi: [{ src, name, plus }]. name = tên nhánh phía remote (dùng tra refs/remotes/<remote>/<name>), có thể null; plus = refspec bắt đầu `+` (ép).
// Không refspec ⇒ HEAD (push.default=matching ⇒ nhánh trùng tên); --all ⇒ mọi nhánh local; --tags/--mirror không có nguồn riêng
// (pushScans quét theo ref); `:dst` (xoá) bỏ qua; `:` / `+:` (matching) ⇒ nhánh trùng tên: mọi nhánh local có nhánh theo dõi cùng tên
// của remote (offline chỉ biết qua refs/remotes/<remote>/*), nên chỉ thấy main/master khi remote đã từng có chúng.
// Có --repo thì mọi positional là refspec (remote = --repo); không thì positional đầu là remote.
function pushSources(info, p) {
  const branchName = (ref) => ref.replace(/^refs\/heads\//, '')
  const forEachRef = (pattern) => (git(info.dir, ['for-each-ref', '--format=%(refname)', pattern]) ?? '').split(/\r?\n/).filter(Boolean)
  const cur = info.branch && info.branch !== 'HEAD' ? info.branch : null
  const specs = p.repo !== null ? p.positional : p.positional.slice(1)
  const out = []
  if (p.mirror) return out
  const matching = (plus) => {
    const remote = p.repo ?? p.positional[0] ?? ((cur ? (git(info.dir, ['config', '--get', `branch.${cur}.remote`]) ?? '').trim() : '') || 'origin')
    return forEachRef('refs/heads').map(branchName).filter((n) => revOf(info, `refs/remotes/${remote}/${n}`))
      .map((n) => ({ src: `refs/heads/${n}`, name: n, plus }))
  }
  if (specs.length === 0) {
    if (p.all) for (const ref of forEachRef('refs/heads')) out.push({ src: ref, name: branchName(ref), plus: false })
    else if (!p.tags) {
      const byConfig = (git(info.dir, ['config', '--get', 'push.default']) ?? '').trim().toLowerCase() === 'matching'
      out.push(...(byConfig ? matching(false) : [{ src: 'HEAD', name: cur, plus: false }]))
    }
    return out
  }
  for (let i = 0; i < specs.length; i++) {
    let s = specs[i]
    if (s === 'tag' && i + 1 < specs.length) s = `refs/tags/${specs[++i]}`
    const plus = s.startsWith('+')
    s = s.replace(/^\+/, '')
    if (s === ':') { out.push(...matching(plus)); continue }
    const colon = s.indexOf(':')
    const src = colon < 0 ? s : s.slice(0, colon)
    const dst = colon < 0 ? '' : s.slice(colon + 1)
    if (!src) continue
    if (/[*?[]/.test(src)) { for (const ref of forEachRef(src)) out.push({ src: ref, name: branchName(ref), plus }); continue }
    out.push({ src, name: dst ? branchName(dst) : src === 'HEAD' ? cur : branchName(src), plus })
  }
  return out
}

// Mỗi ref gửi đi ⇒ một lần quét `git log -p` các commit chưa có ở remote: base = refs/remotes/<remote>/<tên nhánh> nếu có,
// không thì merge-base với origin/<nhánh chính>, không thì toàn bộ lịch sử của ref (cây rỗng).
// --tags ⇒ thêm một lần quét mọi refs/tags/*; --mirror ⇒ mọi ref (--all: heads, tags, ref khác): cả hai chỉ lấy commit
// không thuộc remote-tracking nào của remote (`--not --remotes=<remote>`).
function pushScans(info, p) {
  const remoteArg = p.repo ?? p.positional[0]
  const mainRef = `refs/remotes/origin/${mainBranch(info)}`
  const cfgRemote = (name) => (name ? (git(info.dir, ['config', '--get', `branch.${name}.remote`]) ?? '').trim() : '')
  const scans = new Map()
  if (p.tags || p.mirror) {
    const cur = info.branch && info.branch !== 'HEAD' ? info.branch : null
    const args = [p.mirror ? '--all' : '--tags', '--not', `--remotes=${remoteArg ?? (cfgRemote(cur) || 'origin')}`]
    scans.set(args.join(' '), { cmd: 'log', args })
  }
  for (const { src, name } of pushSources(info, p)) {
    const sha = revOf(info, src)
    if (!sha) continue
    const remote = remoteArg ?? cfgRemote(name)
    const base = (name && revOf(info, `refs/remotes/${remote || 'origin'}/${name}`)) ||
      (git(info.dir, ['merge-base', sha, mainRef]) ?? '').trim()
    const range = base ? `${base}..${sha}` : sha
    scans.set(range, { cmd: 'log', args: [range] })
  }
  return [...scans.values()]
}

// g = parseGitSub của `git commit|push`. Trả deny hoặc null. Không bao giờ đưa giá trị secret vào lý do (chỉ 4 ký tự đầu).
// Diff bị cắt ở SCAN_LIMIT ⇒ cũng deny (không coi phần chưa quét là sạch).
function gateSecrets(g) {
  const info = repoInfo(g.dir)
  if (!info) return null
  const verb = g.sub
  let scans
  if (verb === 'commit') {
    const c = parseCommitFlags(g.rest)
    if (c.dryRun) return null
    scans = commitScans(info, c)
  } else {
    const p = parsePushArgs(g.rest)
    if (p.skip) return null // không gửi commit nào
    scans = pushScans(info, p)
  }
  const lines = new Set()
  let truncated = false
  for (const scan of scans) {
    const r = runScan(info.dir, scan)
    truncated ||= r.truncated
    for (const f of r.findings) lines.add(f.line === null ? `${f.file} — ${f.name}` : `${f.file}:${f.line} — ${f.name} (${f.value})`)
  }
  if (lines.size === 0 && !truncated) return null
  const reason = []
  if (lines.size > 0) {
    const list = [...lines]
    const shown = list.slice(0, 10).join('; ') + (list.length > 10 ? `; …và ${list.length - 10} mục nữa` : '')
    reason.push(
      `Phát hiện secret trong phần sắp ${verb}: ${shown}. Gỡ secret khỏi thay đổi và dùng biến môi trường. ` +
      `Nếu báo nhầm thì thêm comment "${ALLOW_MARK}" vào dòng đó (file nhạy cảm: vào một dòng của file).`,
    )
  }
  if (truncated) {
    reason.push(
      `Diff quá lớn để quét hết (vượt ${SCAN_LIMIT / 1048576} MB, chỉ quét phần đầu) nên không coi là sạch. ` +
      `User tự chạy lệnh ${verb} nếu chắc không có secret.`,
    )
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.join(' ') } }
}

// ---------- lệnh phá huỷ trên nhánh chính / hỏi lại khi push nhánh chính ----------

const isMainName = (n) => n === 'main' || n === 'master'
const permission = (decision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } })

// Các ref gửi đi mà đích là nhánh chính: [{ src, name, plus }]. --mirror gửi mọi ref ⇒ coi như gửi nhánh chính.
function mainPushTargets(info, p) {
  if (p.mirror) {
    const name = mainBranch(info)
    return [{ src: `refs/heads/${name}`, name, plus: false }]
  }
  return pushSources(info, p).filter((s) => isMainName(s.name))
}

// g = parseGitSub của `git push`. Deny khi push ép (cờ ép hoặc refspec +) mà đích là nhánh chính.
function gateForcePush(g) {
  const info = repoInfo(g.dir)
  if (!info) return null
  const p = parsePushArgs(g.rest)
  if (p.skip) return null // dry-run/xoá ref: không ghi đè gì
  const hit = mainPushTargets(info, p).find((t) => p.force || t.plus)
  if (!hit) return null
  return permission('deny',
    `Không push ép (--force / --force-with-lease / refspec +) lên nhánh chính ${hit.name}: ghi đè lịch sử trên remote không hoàn tác được. ` +
    'Push nhánh riêng rồi gộp, hoặc để user tự chạy lệnh này.')
}

// g = parseGitSub của `git push`. Deny khi xoá nhánh chính trên remote: --delete/-d main|master, hoặc refspec rỗng nguồn `:main` / `:refs/heads/main`.
function gateDeleteMainPush(g) {
  if (!repoInfo(g.dir)) return null
  const p = parsePushArgs(g.rest)
  if (p.dryRun) return null
  const specs = p.repo !== null ? p.positional : p.positional.slice(1) // positional đầu là remote (trừ khi có --repo)
  const hit = specs
    .map((s) => s.replace(/^\+/, ''))
    .map((s) => (p.del ? s : s.startsWith(':') ? s.slice(1) : null))
    .map((n) => n?.replace(/^refs\/heads\//, ''))
    .find(isMainName)
  if (!hit) return null
  return permission('deny', `Không xoá nhánh chính ${hit} trên remote (git push --delete / refspec :${hit}). User tự chạy lệnh này nếu thật sự cần.`)
}

// g = parseGitSub của `git push` (đã qua quét secret). Ask khi sắp gửi commit lên nhánh chính: liệt kê tối đa 15 commit chưa có trên remote.
function gateAskMainPush(g) {
  const info = repoInfo(g.dir)
  if (!info) return null
  const p = parsePushArgs(g.rest)
  if (p.skip) return null
  const t = mainPushTargets(info, p)[0]
  if (!t) return null
  const sha = revOf(info, t.src)
  if (!sha) return null
  const remote = p.repo ?? p.positional[0] ?? ((git(info.dir, ['config', '--get', `branch.${t.name}.remote`]) ?? '').trim() || 'origin')
  const tracked = revOf(info, `refs/remotes/${remote}/${t.name}`)
  const range = tracked ? `${tracked}..${sha}` : sha
  const n = Number((git(info.dir, ['rev-list', '--count', range]) ?? '').trim())
  if (!(n > 0)) return null // đã đồng bộ (hoặc git lỗi): không có gì để hỏi
  const list = (git(info.dir, ['log', '--oneline', '--no-decorate', '--no-color', '--no-show-signature', '-n', '15', range]) ?? '').trim()
  return permission('ask', `Sắp push ${n} commit lên ${remote}/${t.name}:\n${list}`)
}

// Duyệt cờ của lệnh git đơn giản: { short: Set<ký tự cờ ngắn>, long: Set<tên cờ dài không có =giá trị>, pos: [đối số không phải cờ, gồm cả sau `--`] }.
function simpleFlags(rest) {
  const short = new Set()
  const long = new Set()
  const pos = []
  let onlyPositional = false
  for (const t of rest) {
    if (!onlyPositional && t === '--') onlyPositional = true
    else if (onlyPositional || !t.startsWith('-')) pos.push(t)
    else if (t.startsWith('--')) long.add(t.slice(2).split('=')[0])
    else for (const ch of t.slice(1)) short.add(ch)
  }
  return { short, long, pos }
}

const DESTRUCTIVE_SUBS = new Set(['reset', 'branch', 'checkout', 'restore', 'clean'])

// g = parseGitSub của reset|branch|checkout|restore|clean. Deny lệnh phá huỷ trên nhánh chính / thư mục chính.
function gateDestructive(g) {
  const info = repoInfo(g.dir)
  if (!info) return null
  const f = simpleFlags(g.rest)
  const flag = (shortCh, longName) => f.short.has(shortCh) || f.long.has(longName)
  const here = `thư mục chính của ${info.toplevel} (nhánh ${info.branch ?? '?'})`
  const wipe = (what) => `${what} ở ${here} sẽ xoá thay đổi chưa commit. Làm trong worktree, hoặc để user tự chạy lệnh này.`
  switch (g.sub) {
    case 'reset':
      if (f.long.has('hard') && !info.linked && isMainName(info.branch)) return permission('deny', wipe('git reset --hard'))
      return null
    case 'branch': {
      const del = f.short.has('D') || (flag('d', 'delete') && flag('f', 'force'))
      const main = f.pos.map((n) => n.replace(/^refs\/heads\//, '')).find(isMainName)
      if (del && main) return permission('deny', `Không xoá nhánh chính ${main} bằng git branch -D / -d -f. User tự chạy lệnh này nếu thật sự cần.`)
      if (flag('m', 'move') || f.short.has('M')) {
        // `-m <x> <đích>` hoặc `-m <đích>` (đổi tên nhánh hiện tại); đích là nhánh chính khác nguồn ⇒ đè nhánh chính
        const [from, to] = f.pos.length >= 2 ? f.pos : [info.branch, f.pos[0]]
        if (isMainName(to) && from !== to) return permission('deny', `Không đè nhánh chính ${to} bằng git branch -m / -M. User tự chạy lệnh này nếu thật sự cần.`)
      }
      return null
    }
    case 'checkout':
      return !info.linked && f.pos.some((a) => /^\.\/?$/.test(a)) ? permission('deny', wipe('git checkout -- .')) : null
    case 'restore': {
      const stagedOnly = flag('S', 'staged') && !flag('W', 'worktree') // chỉ bỏ stage, không đụng file
      return !info.linked && !stagedOnly && f.pos.some((a) => /^\.\/?$/.test(a)) ? permission('deny', wipe('git restore .')) : null
    }
    case 'clean':
      return !info.linked && flag('f', 'force') && !flag('n', 'dry-run') ? permission('deny', wipe('git clean -f')) : null
    default:
      return null
  }
}

function gateMerge(m) {
  const info = repoInfo(m.dir)
  if (!info) return null
  const base = mainBranch(info)
  if (info.branch !== base) return null
  const lacking = m.targets
    .map((target) => ({ target, st: tryGateState(info, base, target) }))
    .filter(({ st }) => st && st.missing.length > 0)
  if (lacking.length === 0) return null
  const detail = lacking
    .map(({ target, st }) => `${target}: thiếu ${st.missing.join(', ')}` + (st.naOnUi ? ' (diff có file UI nhưng qa ghi N/A)' : '') + ` (patch-id=${st.pid})`)
    .join('; ')
  const kinds = new Set(lacking.flatMap(({ st }) => st.missing))
  const how = []
  if (kinds.has('review')) how.push('node ~/.claude/hooks/flow-gate.mjs stamp review <review.json>')
  if (kinds.has('qa')) how.push('node ~/.claude/hooks/flow-gate.mjs stamp qa <qa.md>')
  if (kinds.has('test')) how.push('node ~/.claude/hooks/flow-gate.mjs stamp test -- <lệnh test đủ bộ>')
  return permission('deny',
    `Chưa đủ dấu để gộp vào ${base} — ${detail}. Chạy trong worktree của nhánh: ${how.join(' · ')}` +
    (kinds.has('review') || kinds.has('qa') ? ' (skill flow-review / flow-qa tạo file review.json / qa.md)' : '') +
    (kinds.has('test') ? '. Repo không có test: ghi .claude/flow.json {"tests":"none"}' : '') + '.')
}

// Chạy một cổng; lỗi nội bộ ⇒ ghi log và coi như cho qua (vẫn xét các cổng/đoạn lệnh sau).
function safely(name, fn) {
  try {
    return fn()
  } catch (e) {
    log(`${name}: ${e?.stack ?? e}`)
    return null
  }
}

function hookBash(input) {
  const cmd = input.tool_input?.command
  if (typeof cmd !== 'string' || !/merge|commit|push|reset|branch|checkout|restore|clean/.test(cmd)) return null
  let cwd = path.resolve(toNative(input.cwd || process.cwd()))
  let ask = null // ask chỉ được trả khi không đoạn nào khác bị deny (deny thắng ask)
  for (const toks of tokenize(cmd)) {
    if (toks[0] === 'cd' && toks[1] && !/^[-~$]/.test(toks[1])) { cwd = path.resolve(cwd, toNative(toks[1])); continue }
    const g = parseGitSub(toks, cwd)
    if (!g) continue
    let out = null
    if (g.sub === 'merge') {
      const m = parseGitMerge(g)
      if (m) out = gateMerge(m)
    } else if (g.sub === 'commit') {
      out = safely(`gateSecrets ${g.sub}`, () => gateSecrets(g))
    } else if (g.sub === 'push') {
      out = safely(`gateSecrets ${g.sub}`, () => gateSecrets(g)) ??
        safely('gateForcePush', () => gateForcePush(g)) ??
        safely('gateDeleteMainPush', () => gateDeleteMainPush(g)) ??
        safely('gateAskMainPush', () => gateAskMainPush(g))
    } else if (DESTRUCTIVE_SUBS.has(g.sub)) {
      out = safely(`gateDestructive ${g.sub}`, () => gateDestructive(g))
    }
    if (out?.hookSpecificOutput?.permissionDecision === 'ask') ask ??= out
    else if (out) return out
  }
  return ask
}

function hookStop(input) {
  if (input.stop_hook_active) return null
  const info = repoInfo(input.cwd || process.cwd())
  if (!info || !info.linked) return null
  const base = mainBranch(info)
  if (!info.branch || info.branch === base) return null
  const status = git(info.dir, ['status', '--porcelain'])
  if (status === null || status.trim() !== '') return null
  const st = tryGateState(info, base, 'HEAD')
  if (!st || st.missing.length === 0) return null
  const nudged = path.join(info.gatesDir, `nudged-${st.pid}`)
  if (fs.existsSync(nudged)) return null
  fs.mkdirSync(info.gatesDir, { recursive: true })
  fs.writeFileSync(nudged, new Date().toISOString())
  return {
    decision: 'block',
    reason: `${info.branch} đã commit xong nhưng thiếu: ${st.missing.join(', ')}. Chạy skill flow-qa / flow-review trước khi báo user.` +
      (st.missing.includes('test') ? ' Dấu test: node ~/.claude/hooks/flow-gate.mjs stamp test -- <lệnh test đủ bộ>.' : ''),
  }
}

// Đọc transcript jsonl của subagent: lấy lời gọi SubagentHandback cuối và đoạn text assistant cuối.
function readTranscript(file) {
  const p = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
  let handback = null
  let lastText = null
  for (let i = lines.length - 1; i >= 0 && (handback === null || lastText === null); i--) {
    let e
    try { e = JSON.parse(lines[i]) } catch { continue }
    const msg = e?.message
    if (e?.type !== 'assistant' && msg?.role !== 'assistant') continue
    const blocks = typeof msg?.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg?.content) ? msg.content : []
    if (handback === null) {
      const hb = blocks.findLast((b) => b?.type === 'tool_use' && b.name === 'SubagentHandback' && typeof b.input?.message === 'string')
      if (hb) handback = hb.input.message
    }
    if (lastText === null) {
      const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      if (text.trim()) lastText = text
    }
  }
  return { handback, lastText }
}

// Giá trị return= của receipt cuối cùng trong text (done|done_with_concerns|needs_context|blocked|green|red), không có thì null.
function receiptValue(text) {
  if (typeof text !== 'string') return null
  return [...text.matchAll(new RegExp(RECEIPT_RE.source, 'g'))].at(-1)?.[1] ?? null
}

// Tin nhắn user đầu tiên trong transcript jsonl của subagent (= brief giao việc); không có thì null.
function firstUserMessage(file) {
  const p = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    const msg = e?.message
    if ((e?.type !== 'user' && msg?.role !== 'user') || e?.isMeta) continue
    const text = typeof msg?.content === 'string' ? msg.content
      : Array.isArray(msg?.content) ? msg.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
    if (text.trim()) return text
  }
  return null
}

// Worker coder nộp bài: brief (tin nhắn user đầu trong transcript) có plan= và lane= ⇒ chạy lane-check audit trong cwd của worker.
// Phát hiện file ngoài scope (exit 1) ⇒ block; lane-check không chạy được (exit 2/lỗi) hoặc brief không có plan=/lane= ⇒ cho qua.
function auditScope(input) {
  if (typeof input.agent_transcript_path !== 'string' || !input.agent_transcript_path) return null
  const brief = firstUserMessage(input.agent_transcript_path)
  if (!brief) return null
  const cwd = path.resolve(toNative(input.cwd || process.cwd()))
  // Bộ đọc brief dùng chung với flow-dispatch (lib/brief.mjs): nháy, đường dẫn có dấu cách, ~/, /c/…, tiền tố ngắn dần.
  const plan = briefPlan(brief, cwd)
  const lane = briefWord(brief, 'lane')
  if (!plan || !lane) return null
  const info = repoInfo(cwd)
  const base = briefWord(brief, 'base') ?? (info ? mainBranch(info) : 'main')
  // --repo = cwd của worker: plan thường nằm ngoài repo của worker (vd ~/.claude/plans), nên không suy repo từ đường dẫn plan.
  const args = [path.join(HOOK_DIR, 'lane-check.mjs'), 'audit', plan, lane, '--repo', cwd, '--worktree', cwd, '--branch', 'HEAD', '--base', base]
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true })
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    log(`lane-check audit lane ${lane}: ${r.error?.message ?? `exit ${r.status}: ${(r.stderr || r.stdout || '').trim()}`}`)
    return null
  }
  if (r.status === 0) return null
  const lines = r.stdout.split(/\r?\n/).filter(Boolean)
  const shown = lines.slice(0, 30).join('\n') + (lines.length > 30 ? `\n…và ${lines.length - 30} dòng nữa` : '')
  return {
    decision: 'block',
    reason: `Audit phạm vi làn ${lane} không đạt:\n${shown}\nHãy gỡ thay đổi ngoài scope, hoặc trả return=needs_context kèm tên file.`,
  }
}

function hookSubagentStop(input) {
  if (input.stop_hook_active) return null
  if (!RECEIPT_AGENTS.has(input.agent_type)) return null
  const last = input.last_assistant_message
  let receipt = receiptValue(last)
  if (receipt === null) {
    // Docs: khi subagent báo cáo bằng SubagentHandback (v2.1.271+), last_assistant_message chỉ là lời đóng,
    // báo cáo thật nằm ở tool_input.message của lời gọi đó trong transcript của subagent.
    let report = typeof last === 'string' && last.trim() ? last : null
    if (typeof input.agent_transcript_path === 'string' && input.agent_transcript_path) {
      try {
        const tx = readTranscript(input.agent_transcript_path)
        report = tx.handback ?? report ?? tx.lastText
      } catch (e) {
        log(`transcript: ${e.message}`)
      }
    }
    receipt = receiptValue(report)
    if (receipt === null) {
      if (report === null) return null
      return {
        decision: 'block',
        reason: 'Thiếu receipt: kết thúc bằng đúng một dòng return=…; paths=…; checks=…; blocker=…; stop',
      }
    }
  }
  if (!AUDIT_AGENTS.has(input.agent_type) || receipt === 'needs_context' || receipt === 'blocked') return null
  return safely('audit', () => auditScope(input))
}

// ---------- CLI ----------

function fail(msg) {
  console.error(msg)
  process.exitCode = 1
}

function cliContext() {
  const info = repoInfo(process.cwd())
  if (!info) return { err: 'Không phải git repo.' }
  const base = mainBranch(info)
  return { info, base, pid: patchId(info.dir, base, 'HEAD') }
}

// Một token ⇒ nguyên văn (cả dòng lệnh, vd "pnpm test && pnpm lint"); nhiều token ⇒ nháy token có ký tự đặc biệt rồi nối bằng dấu cách.
function commandLine(tokens) {
  if (tokens.length === 1) return tokens[0]
  const quote = (t) => {
    if (/^[\w@%+=:,./\\~-]+$/.test(t)) return t
    return process.platform === 'win32' ? `"${t.replace(/"/g, '\\"')}"` : `"${t.replace(/(["\\$`])/g, '\\$1')}"`
  }
  return tokens.map(quote).join(' ')
}

// stamp test -- <lệnh…>: chạy lệnh (shell) trong cwd, in output ra màn hình đồng thời ghi test-<pid>.log;
// exit 0 ⇒ ghi test-<pid>.json {cmd, ts, durationMs}; exit ≠ 0 ⇒ không ghi dấu (gỡ dấu cũ của cùng diff) và thoát cùng mã.
async function cliStampTest(tokens) {
  if (tokens.length === 0) return fail('Dùng: stamp test -- <lệnh test đủ bộ>')
  const { info, base, pid, err } = cliContext()
  if (err) return fail(err)
  if (!pid) return fail(`Diff ${base}...HEAD rỗng (chưa commit hoặc không khác ${base}) nên không có patch-id để đóng dấu.`)
  const cmd = commandLine(tokens)
  const stamp = path.join(info.gatesDir, `test-${pid}.json`)
  fs.mkdirSync(info.gatesDir, { recursive: true })
  const logFile = fs.createWriteStream(path.join(info.gatesDir, `test-${pid}.log`))
  const started = Date.now()
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.on('data', (d) => { process.stdout.write(d); logFile.write(d) })
    child.stderr.on('data', (d) => { process.stderr.write(d); logFile.write(d) })
    child.on('error', (e) => { process.stderr.write(`Không chạy được lệnh: ${e.message}\n`); resolve(1) })
    child.on('close', (c) => resolve(c ?? 1)) // c = null khi bị signal giết
  })
  logFile.end()
  if (code !== 0) {
    fs.rmSync(stamp, { force: true })
    process.exitCode = code
    return
  }
  fs.writeFileSync(stamp, JSON.stringify({ cmd, ts: new Date().toISOString(), durationMs: Date.now() - started }) + '\n')
  console.log(pid)
}

function cliStamp(kind, file) {
  if ((kind !== 'review' && kind !== 'qa') || !file) return fail('Dùng: stamp review <file.json> | stamp qa <file.md> | stamp test -- <lệnh>')
  const { info, base, pid, err } = cliContext()
  if (err) return fail(err)
  if (!pid) return fail(`Diff ${base}...HEAD rỗng (chưa commit hoặc không khác ${base}) nên không có patch-id để đóng dấu.`)
  let text
  try { text = fs.readFileSync(path.resolve(file), 'utf8') } catch (e) { return fail(`Không đọc được ${file}: ${e.message}`) }
  if (kind === 'review') {
    let json
    try { json = JSON.parse(text.replace(/^\uFEFF/, '')) } catch (e) { return fail(`${file} không phải JSON hợp lệ: ${e.message}`) }
    if (!json || !Array.isArray(json.findings)) return fail(`${file} thiếu mảng "findings".`)
  } else {
    if (!text.trim()) return fail(`${file} rỗng.`)
    if (NA_RE.test(text) && uiTouched(info, base, 'HEAD')) return fail(`${file} ghi N/A nhưng diff có file UI; cần QA thật.`)
  }
  fs.mkdirSync(info.gatesDir, { recursive: true })
  fs.copyFileSync(path.resolve(file), path.join(info.gatesDir, kind === 'review' ? `review-${pid}.json` : `qa-${pid}.md`))
  console.log(pid)
}

function cliStatus() {
  const { info, base, pid, err } = cliContext()
  if (err) return fail(err)
  let st = null
  try { st = pid ? gateState(info, base, 'HEAD') : null } catch (e) { return fail(`Không đọc được dấu: ${e.message}`) }
  console.log(`branch: ${info.branch ?? '?'} (base ${base}, ${info.linked ? 'worktree' : 'thư mục chính'})`)
  console.log(`pid: ${pid ?? '(diff rỗng)'}`)
  console.log(`uiTouched: ${st ? st.ui : false}`)
  console.log(`review: ${st?.hasReview ? 'có' : 'không'}`)
  console.log(`qa: ${st?.hasQa ? 'có' : st?.naOnUi ? 'không (N/A nhưng diff có UI)' : 'không'}`)
  console.log(`test: ${st?.testExempt ? `không đòi (${st.testExempt})` : st?.hasTest ? 'có' : 'không'}`)
}

// ---------- main ----------

const HOOKS = { edit: hookEdit, bash: hookBash, stop: hookStop, 'subagent-stop': hookSubagentStop }
const [, , mode, arg1, arg2] = process.argv

if (HOOKS[mode]) {
  try {
    const out = HOOKS[mode](JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch (e) {
    log(e?.stack ?? e)
  }
} else if (mode === 'stamp' && arg1 === 'test') {
  await cliStampTest(process.argv.slice(process.argv[4] === '--' ? 5 : 4))
} else if (mode === 'stamp') {
  cliStamp(arg1, arg2)
} else if (mode === 'status') {
  cliStatus()
} else {
  fail('Dùng: flow-gate.mjs edit|bash|stop|subagent-stop (hook) · stamp review <file.json> · stamp qa <file.md> · stamp test -- <lệnh> · status')
}
