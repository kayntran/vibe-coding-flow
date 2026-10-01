// flow-gate: cổng worktree/review/qa cho flow captain + worker. Một script, chế độ chọn bằng argv[2].
//   hook : edit (PreToolUse Edit|Write|NotebookEdit) · bash (PreToolUse Bash) · stop (Stop) · subagent-stop (SubagentStop)
//   CLI  : stamp review <file.json> · stamp qa <file.md> · status      (chạy trong worktree)
// Spec: ~/.claude/plans/flow-v2-hooks-spec.md. Docs field input: https://code.claude.com/docs/en/hooks
// Lỗi nội bộ ở chế độ hook luôn CHO QUA (exit 0, không in gì) và ghi một dòng vào flow-gate.log.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG_FILE = process.env.FLOW_GATE_LOG || path.join(path.dirname(fileURLToPath(import.meta.url)), 'flow-gate.log')
const DEFAULT_UI = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/i
const RECEIPT_AGENTS = new Set(['coder', 'coder-lite', 'recon', 'researcher', 'test-runner', 'qa-tester', 'debugger', 'code-reviewer'])
const RECEIPT_RE = /return=(done_with_concerns|done|needs_context|blocked|green|red)\b/ // green|red là của test-runner
const NA_RE = /^\uFEFF?\s*N\/A/i

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

// Trạng thái dấu của diff base...head. null = không có diff (không gate). Ném lỗi nếu không đọc nổi dấu.
function gateState(info, base, head) {
  const pid = patchId(info.dir, base, head)
  if (!pid) return null
  const ui = uiTouched(info, base, head)
  const hasReview = readMark(path.join(info.gatesDir, `review-${pid}.json`)) !== null
  const qa = readMark(path.join(info.gatesDir, `qa-${pid}.md`))
  const naOnUi = qa !== null && ui && NA_RE.test(qa)
  const hasQa = qa !== null && !naOnUi
  const missing = []
  if (!hasReview) missing.push('review')
  if (!hasQa) missing.push('qa')
  return { pid, ui, hasReview, hasQa, naOnUi, missing }
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

// tokens = một đoạn lệnh. Trả { dir, targets } nếu là `git [-C p] merge ... <branch>...`, ngược lại null.
function parseGitMerge(tokens, cwd) {
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
  if (tokens[i] !== 'merge') return null
  const rest = tokens.slice(i + 1)
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

function hookBash(input) {
  const cmd = input.tool_input?.command
  if (typeof cmd !== 'string' || !cmd.includes('merge')) return null
  let cwd = path.resolve(toNative(input.cwd || process.cwd()))
  for (const toks of tokenize(cmd)) {
    if (toks[0] === 'cd' && toks[1] && !/^[-~$]/.test(toks[1])) { cwd = path.resolve(cwd, toNative(toks[1])); continue }
    const m = parseGitMerge(toks, cwd)
    if (!m) continue
    const info = repoInfo(m.dir)
    if (!info) continue
    const base = mainBranch(info)
    if (info.branch !== base) continue
    const lacking = m.targets
      .map((target) => ({ target, st: tryGateState(info, base, target) }))
      .filter(({ st }) => st && st.missing.length > 0)
    if (lacking.length === 0) continue
    const detail = lacking
      .map(({ target, st }) => `${target}: thiếu ${st.missing.join(', ')}` + (st.naOnUi ? ' (diff có file UI nhưng qa ghi N/A)' : '') + ` (patch-id=${st.pid})`)
      .join('; ')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Chưa đủ dấu để gộp vào ${base} — ${detail}. ` +
          'Chạy trong worktree của nhánh: node ~/.claude/hooks/flow-gate.mjs stamp review <review.json> ' +
          'và node ~/.claude/hooks/flow-gate.mjs stamp qa <qa.md> (skill flow-review / flow-qa tạo hai file này).',
      },
    }
  }
  return null
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
    reason: `${info.branch} đã commit xong nhưng thiếu: ${st.missing.join(', ')}. Chạy skill flow-qa / flow-review trước khi báo user.`,
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

function hookSubagentStop(input) {
  if (input.stop_hook_active) return null
  if (!RECEIPT_AGENTS.has(input.agent_type)) return null
  const last = input.last_assistant_message
  if (typeof last === 'string' && RECEIPT_RE.test(last)) return null
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
  if (report === null || RECEIPT_RE.test(report)) return null
  return {
    decision: 'block',
    reason: 'Thiếu receipt: kết thúc bằng đúng một dòng return=…; paths=…; checks=…; blocker=…; stop',
  }
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

function cliStamp(kind, file) {
  if ((kind !== 'review' && kind !== 'qa') || !file) return fail('Dùng: stamp review <file.json> | stamp qa <file.md>')
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
} else if (mode === 'stamp') {
  cliStamp(arg1, arg2)
} else if (mode === 'status') {
  cliStatus()
} else {
  fail('Dùng: flow-gate.mjs edit|bash|stop|subagent-stop (hook) · stamp review <file.json> · stamp qa <file.md> · status')
}
