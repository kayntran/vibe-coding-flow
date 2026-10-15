// flow-gate: cổng worktree/review/qa/test cho flow captain + worker. Một script, chế độ chọn bằng argv[2].
//   hook : edit (PreToolUse Edit|Write|NotebookEdit + apply_patch của Codex/Devin) · bash (PreToolUse Bash: chặn git merge thiếu dấu,
//          git commit/push có secret, commit thêm thư viện lạ, lệnh phá huỷ trên nhánh chính, `apply_patch <<` vào thư mục chính;
//          KHÔNG hộp hỏi (ask) nào [chốt 2026-10-14: user no code luôn bấm Allow]: push thường lên nhánh chính cho qua; git merge mà nhánh đích nới
//          luật — đụng file luật (kể cả .claude/flow.json, kit/checkers.json) hoặc thêm dòng tắt luật ngoài file máy sinh — ⇒ deny nhắn AI tự gỡ
//          (không lối AI tự mở, không đẩy lệnh terminal sang user [chốt 2026-10-15]), chép repo "chỉ học" ⇒ deny, không so được
//          diff base...<đích> ⇒ deny; pull ., cherry-pick, rebase, fetch ., push ., branch -f, update-ref, checkout -B, switch -C đưa nhánh vào main
//          ⇒ qua đúng cổng như git merge) · stop (Stop) ·
//          subagent-stop (SubagentStop: receipt + audit phạm vi làn)
//   CLI  : stamp review <file.json> · stamp qa <file.md> · stamp test -- <lệnh…> · status      (chạy trong worktree)
// Spec: ~/.claude/plans/flow-v2-hooks-spec.md, flow-v3-hooks-spec.md (Làn A: quét secret), flow-v5-hooks-spec.md (Làn A: dấu test, lệnh phá huỷ, ask, audit);
//       flow v7: docs/specs/2026-10-11-flow-v7-nocode (làn D: AC-09 audit không im lặng, AC-24 lời chặn đời thường, AC-38 thư viện mới);
//       đợt 3: docs/specs/2026-10-12-flow-v7-dot3 PLAN mục 5 (dấu QA đòi mỗi mã P-nn của SPEC đang mở một dòng "đỏ khi tắt", AC-20; file luật một nguồn lib/rule-files.mjs).
// Nối các lib: lib/host.mjs (nhận diện app + chuẩn hoá payload) · lib/secrets.mjs (mẫu secret) · lib/models.mjs roleSet (vai từ kit/roles.json)
//   · lib/deps.mjs (thư viện mới khi commit) · lib/so-chot.mjs openProgress (sổ tiến độ của nhánh).
// Docs field input: https://code.claude.com/docs/en/hooks
// Lỗi nội bộ ở chế độ hook luôn CHO QUA (exit 0, không in gì) và ghi một dòng vào flow-gate.log — trừ các ca chủ ý chặn:
//   không kiểm được phạm vi làn (AC-09) và không đọc được package.json/go.mod khi commit (AC-38).
// Mọi lời chặn mở đầu bằng MỘT câu đời thường (bị chặn vì gì + AI sẽ tự làm gì) rồi mới tới chi tiết kỹ thuật (AC-24).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefPlan, briefWord } from './lib/brief.mjs'
import { normalize, patchFiles } from './lib/host.mjs'
import { ALLOW_MARK, isSensitiveFile, scanPatch } from './lib/secrets.mjs'

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = process.env.FLOW_GATE_LOG || path.join(HOOK_DIR, 'flow-gate.log')
const DEFAULT_UI = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/i
const DOC_FILE = /\.(md|mdx|txt)$/i // diff chỉ có file này (hoặc dưới docs/) ⇒ không đòi dấu test
const DEPS_BUDGET_MS = 8000 // tổng thời gian kiểm thư viện mới (hook bash có 15 s); quá hạn ⇒ unknown, không chặn
const RECEIPT_RE = /return=(done_with_concerns|done|needs_context|blocked|green|red)\b/ // green|red là của test-runner
const NA_RE = /^\uFEFF?\s*N\/A/i
// B\u00E1o c\u00E1o QA c\u1EE7a diff c\u00F3 UI ph\u1EA3i ghi user \u0111\u00E3 xem v\u00E0 g\u1EADt giao di\u1EC7n (AI d\u1EEBng h\u1ECFi "\u0111\u00E3 \u1ED5n ch\u01B0a?" tr\u01B0\u1EDBc khi review/g\u1ED9p).
// Sau l\u1EDDi g\u1EADt ch\u1EC9 \u0111\u01B0\u1EE3c h\u1EBFt d\u00F2ng ho\u1EB7c k\u00FD t\u1EF1 kh\u00F4ng ph\u1EA3i ch\u1EEF (vd "c\u00F3 (ng\u00E0y, xem g\u00EC)"); "c\u00F3 th\u1EC3\u2026", "ok kh\u00F4ng" kh\u00F4ng t\u00EDnh. So tr\u00EAn b\u1EA3n NFC.
const UI_OK_RE = /^[ \t>*_-]*User duy\u1EC7t giao di\u1EC7n[ \t*_]*[:\uFF1A][ \t*_]*(c\u00F3|r\u1ED3i|ok|\u0111\u1ED3ng \u00FD)(?![ \t]*[\p{L}\p{N}])/imu
const uiApproved = (text) => UI_OK_RE.test(String(text).normalize('NFC'))
// SPEC đang mở của nhánh có mã quyền P-nn (mục "Ai thấy/sửa được dữ liệu gì") ⇒ báo cáo QA phải có MỖI mã một dòng bằng chứng
// `P-01: đỏ khi tắt: có — <file test>` (test chặn quyền đỏ khi tắt chặn quyền). Như UI_OK_RE: đầu dòng, bỏ dấu markdown bao quanh, "có" không dính chữ
// khác (loại "có thể…"), so trên bản NFC; thêm: sau "có" phải có gạch ngang rồi một chữ (tên file test) — dòng cụt không tính. Mã là P-<số> (từ parseSpec) nên ghép vào regex an toàn.
const pEvidenceRe = (code) => new RegExp(`^[ \\t>*_-]*${code}[ \\t*_]*[:\\uFF1A][ \\t*_]*đỏ[ \\t]+khi[ \\t]+tắt[ \\t*_]*[:\\uFF1A][ \\t*_]*có(?![\\p{L}\\p{N}])[ \\t*_]*[—–-]+[ \\t]*[^\\s—–-]`, 'imu')
const pEvidenceMissing = (text, codes) => { const t = String(text).normalize('NFC'); return codes.filter((c) => !pEvidenceRe(c).test(t)) }
const P_LINE_FORMAT = 'P-nn: đỏ khi tắt: có — <file test>'

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

// Nhánh mà `head` đại diện (để tìm SPEC đang mở của nó): 'HEAD' ⇒ nhánh đang đứng; tên nhánh ⇒ chính nó; commit/biểu thức khác ⇒ các nhánh đang trỏ đúng commit đó.
function branchesOfHead(info, head) {
  if (head === 'HEAD') return info.branch && info.branch !== 'HEAD' ? [info.branch] : []
  if (git(info.dir, ['show-ref', '--verify', '--quiet', `refs/heads/${head}`]) !== null) return [head]
  return (git(info.dir, ['for-each-ref', '--points-at', head, '--format=%(refname:short)', 'refs/heads']) ?? '').split(/\r?\n/).filter(Boolean)
}

// Sổ tiến độ ĐANG MỞ ghi đúng nhánh `branch` (openProgress của lib so-chot). Worktree không có sổ (docs ngoài git [o3e4]) ⇒ tìm ở thư mục chính, như planFromMain.
async function openProgressOf(info, branch) {
  const { openProgress } = await import('./lib/so-chot.mjs')
  return openProgress(info.toplevel, branch) ??
    (info.linked && path.basename(info.commonDir) === '.git' ? openProgress(path.dirname(info.commonDir), branch) : null)
}

const SPEC_MAX_BYTES = 2 * 1024 * 1024 // cùng trần với lib/spec-codes (MAX_FILE)

// Các mã quyền P-nn (đã sắp) trong SPEC.md nằm cạnh sổ tiến độ đang mở của nhánh `head` (parseSpec của lib/spec-codes) → { codes, unreadable }.
// Không có SPEC mở / không có SPEC cạnh sổ / không có P-nn ⇒ codes rỗng. Fail-closed: SPEC đang mở mà quá 2 MB, đọc/phân tích lỗi, hay lỗi khi tìm sổ tiến độ
// ⇒ vào `unreadable` (tên SPEC) để dấu QA không được coi là đủ — không được coi như "không có mã quyền" (cổng mở).
async function requiredPCodes(info, base, head) {
  const out = { codes: [], unreadable: [] }
  const branches = branchesOfHead(info, head).filter((b) => b !== base)
  if (branches.length === 0) return out
  let parseSpec
  try {
    ;({ parseSpec } = await import('./lib/spec-codes.mjs'))
  } catch (e) {
    log(`requiredPCodes ${head}: ${e?.message ?? e}`)
    return { codes: [], unreadable: ['bộ đọc SPEC của kit'] }
  }
  const codes = new Set()
  for (const b of branches) {
    let label = `SPEC của nhánh ${b}`
    try {
      const hit = await openProgressOf(info, b)
      if (!hit) continue
      const spec = path.join(path.dirname(hit.file), 'SPEC.md')
      label = hit.rel ? hit.rel.replace(/progress\.md$/, 'SPEC.md') : spec
      let size
      try { size = fs.statSync(spec).size } catch (e) { if (e?.code === 'ENOENT') continue; throw e } // không có SPEC cạnh sổ (sổ kiểu cũ) ⇒ không đòi
      if (size > SPEC_MAX_BYTES) throw new Error(`SPEC ${size} byte, quá ${SPEC_MAX_BYTES}`)
      for (const p of parseSpec(fs.readFileSync(spec, 'utf8')).pCodes) codes.add(p.code)
    } catch (e) {
      log(`requiredPCodes ${head} (${b}): ${e?.message ?? e}`)
      out.unreadable.push(label)
    }
  }
  out.codes = [...codes].sort()
  return out
}

// Lời đời thường khi SPEC đang mở không đọc được (dùng cho stamp qa, cổng gộp, Stop, status).
const unreadableNote = (list) => `không đọc được SPEC để kiểm mã quyền (${list.join(', ')}): kiểm file SPEC.md còn đó, mở được và nhỏ hơn 2 MB`

// Trạng thái dấu của diff base...head. null = không có diff (không gate). Ném lỗi nếu không đọc nổi dấu.
// pReq = { codes, unreadable } của requiredPCodes: dấu QA thiếu dòng bằng chứng của mã nào ⇒ coi như chưa có qa, pMissing nêu mã đó;
// SPEC đang mở không đọc được ⇒ cũng coi như chưa có qa, pUnreadable nêu SPEC nào.
function gateState(info, base, head, pReq = { codes: [], unreadable: [] }) {
  const pid = patchId(info.dir, base, head)
  if (!pid) return null
  const ui = uiTouched(info, base, head)
  const hasReview = readMark(path.join(info.gatesDir, `review-${pid}.json`)) !== null
  const qa = readMark(path.join(info.gatesDir, `qa-${pid}.md`))
  const naOnUi = qa !== null && ui && NA_RE.test(qa)
  const pMissing = qa === null ? [] : pEvidenceMissing(qa, pReq.codes)
  const pUnreadable = pReq.unreadable
  const hasQa = qa !== null && !naOnUi && (!ui || uiApproved(qa)) && pMissing.length === 0 && pUnreadable.length === 0 // diff có UI ⇒ dấu QA phải ghi user đã duyệt giao diện
  const testExempt = testExemption(info, base, head)
  const hasTest = readMark(path.join(info.gatesDir, `test-${pid}.json`)) !== null
  const missing = []
  if (!hasReview) missing.push('review')
  if (!hasQa) missing.push('qa')
  if (testExempt === null && !hasTest) missing.push('test')
  return { pid, ui, hasReview, hasQa, naOnUi, pMissing, pUnreadable, testExempt, hasTest, missing }
}

const gateStateOf = async (info, base, head) => gateState(info, base, head, await requiredPCodes(info, base, head))

// ---------- hook handlers: trả object để in, hoặc null = cho qua ----------

// files = các file mà tool sắp ghi (đã qua host.normalize / patchFiles; tương đối thì tính từ cwd). Deny nếu có file nằm trong thư mục chính
// của một repo (không phải worktree) mà repo đó chưa bật .claude/allow-direct-edit. Codex/Devin không có EnterWorktree ⇒ chỉ cách dùng git.
function denyDirectEdit(files, cwd, host) {
  for (const p of files) {
    const info = repoInfo(path.resolve(cwd, toNative(p)))
    if (!info || info.linked) continue
    if (fs.existsSync(path.join(info.toplevel, '.claude', 'allow-direct-edit'))) continue
    const how = host === 'claude'
      ? 'Gọi EnterWorktree để tạo worktree trước khi sửa file.'
      : 'Tạo worktree bằng git worktree add ../<tên> -b <nhánh> rồi sửa file trong đó.'
    return permission('deny',
      'Chưa sửa thẳng vào bản chính của dự án được; AI sẽ tạo một bản sao riêng của dự án rồi sửa ở đó. ' +
      `Đang sửa thẳng thư mục chính của ${info.toplevel} (nhánh ${info.branch ?? '?'}), file ${p}. ${how} ` +
      'Muốn sửa thẳng thì user tạo file .claude/allow-direct-edit trong repo.')
  }
  return null
}

function hookEdit(input) {
  const n = normalize(input, process.env)
  // tool ghi file đã biết (Edit/Write/NotebookEdit, Devin write/edit/notebook_edit, Codex apply_patch): host.mjs đã lấy sẵn danh sách file.
  // Tên tool lạ/thiếu: giữ cách cũ (file_path hoặc notebook_path) — chế độ edit chỉ được gắn cho tool ghi file nên thà đọc dư còn hơn mù.
  let files = n.files
  if (n.tool === 'other') {
    const ti = input.tool_input
    const p = ti?.file_path ?? ti?.notebook_path
    files = typeof p === 'string' && p ? [p] : []
  }
  return denyDirectEdit(files, n.cwd, n.host)
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

const MERGE_VALUE_FLAGS = new Set(['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name', '--cleanup'])

// tokens = một đoạn lệnh. Trả { dir, sub, rest } nếu là `[VAR=giá-trị…] git [-C p] <sub> ...`, ngược lại null.
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
async function tryGateState(info, base, head) {
  try {
    return await gateStateOf(info, base, head)
  } catch (e) {
    log(`gateState ${head}: ${e?.stack ?? e}`)
    return null
  }
}

// ---------- quét secret trước git commit / git push ----------

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const SCAN_LIMIT = 20 * 1024 * 1024
// Mẫu secret, file nhạy cảm và duyệt patch nằm ở lib/secrets.mjs (một nguồn cho cả kit): scanPatch, isSensitiveFile, ALLOW_MARK.

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
  (/^-[A-Za-z0-9]+$/.test(t) && /^[^o]*f/.test(t.slice(1)))

// Push thường được cho qua [fn9k] nên lệnh push phải ĐỌC CHẮC được: cờ viết tắt (git nhận tiền tố duy nhất: --mirro, --force-with), cờ lạ,
// -c/GIT_CONFIG_*, cấu hình remote mirror/push riêng, hay sửa cấu hình remote trong cùng lệnh ⇒ deny, nhắn AI viết lại dạng thường.
const PUSH_LONG_FLAGS = new Set(['--dry-run', '--delete', '--all', '--branches', '--mirror', '--prune', '--no-prune', '--tags', '--no-tags',
  '--follow-tags', '--no-follow-tags', '--force', '--no-force', '--force-if-includes', '--no-force-if-includes', '--force-with-lease',
  '--no-force-with-lease', '--repo', '--set-upstream', '--no-set-upstream', '--quiet', '--verbose', '--progress', '--no-progress', '--porcelain',
  '--verify', '--no-verify', '--atomic', '--no-atomic', '--signed', '--no-signed', '--push-option', '--receive-pack', '--exec',
  '--recurse-submodules', '--no-recurse-submodules', '--thin', '--no-thin', '--ipv4', '--ipv6'])
const PUSH_SHORT = /^-[fuqvnd46]*(o.*)?$/ // cụm cờ ngắn git push hiểu; từ `o` trở đi là giá trị của -o
// Cổng này bắt AI LỠ TAY; AI cố tình nguỵ trang lệnh thì khoá thật là bảo vệ nhánh chính phía máy chủ (GitHub branch protection).
const pushOdd = (why) => permission('deny',
  'Lệnh đẩy code viết theo kiểu kit không đọc chắc được nên chưa chạy; AI sẽ viết lại dạng thường rồi đẩy. ' +
  `Lý do: ${why}. Việc của AI: dùng dạng thường \`git push [-u] <remote> <nhánh>\` gõ thẳng (không biến, không bọc command/env/bash -c, ` +
  'không -c, không gán biến môi trường), cờ viết ĐỦ chữ, không sửa cấu hình remote/alias trong cùng lệnh. Kit vẫn chặn ép/xoá/mirror nhánh chính dù viết kiểu nào.')
const SHELL_WRAP = /^(command|env|exec|sudo|nohup|time|nice|xargs|eval|bash|sh|zsh|dash|pwsh|powershell|cmd)(\.exe)?$/i

// Một đoạn lệnh không phải `git …` trần mà vẫn có thể chạy git push (bọc trong command/env/bash -c…), hoặc `git -c alias.*` ⇒ deny; null nếu không.
function gateWrappedPush(toks) {
  const gitAt = toks.findIndex((t) => /(^|[\\/])git(\.exe)?$/i.test(t))
  if (SHELL_WRAP.test(toks[0] ?? '') && toks.some((t) => /(^|[^\w-])push(?![\w-])/.test(t)) && toks.some((t) => /(^|[\\/\s])git(\.exe)?(\s|$)/i.test(t))) {
    return pushOdd(`git push bọc trong ${showName(toks[0])}`)
  }
  if (gitAt >= 0 && toks.slice(gitAt + 1).some((t, k, a) => (t === '-c' && /^alias\./i.test(a[k + 1] ?? '')) || /^-c\s*alias\./i.test(t))) {
    return pushOdd('git -c alias.* đặt tên tắt cho lệnh git')
  }
  const after = gitAt >= 0 ? toks.slice(gitAt + 1) : []
  if (after.includes('config') && after.some((t) => /^alias\./i.test(t)) && after.some((t) => /(^|[^\w-])push(?![\w-])/.test(t))) {
    return pushOdd('git config alias.* đặt tên tắt cho git push')
  }
  return null
}

// toks = đoạn lệnh gốc (còn tiền tố biến và cờ toàn cục của git), g = parseGitSub của nó, cfgEdit = cùng lệnh có sửa cấu hình remote/push.
function gatePushSyntax(toks, g, cfgEdit) {
  const odd = pushOdd
  if (cfgEdit) return odd('cùng lệnh có sửa cấu hình remote/push/alias/include (git config …, git remote … --mirror)')
  if (toks.some((t) => /[$`]/.test(t))) return odd('lệnh có biến shell ($…) hoặc lệnh lồng — chỉ biết giá trị thật lúc chạy')
  let i = 0
  if (/^[A-Za-z_]\w*=/.test(toks[0] ?? '')) return odd(`gán biến môi trường ${toks[0].split('=')[0]} trước git (đổi được cấu hình git đọc)`)
  for (i++; i < toks.length && toks[i] !== 'push'; i++) {
    if (toks[i] === '-C') { i++; continue }
    return odd(`cờ toàn cục ${showName(toks[i])} của git (chỉ nhận -C)`)
  }
  for (let j = 0; j < g.rest.length; j++) {
    const t = g.rest[j]
    if (t === '--') break
    if (!t.startsWith('-') || t === '-') continue
    if (t.startsWith('--')) {
      const name = t.split('=')[0]
      if (!PUSH_LONG_FLAGS.has(name)) return odd(`cờ ${showName(name)} lạ hoặc viết tắt`)
      if (!t.includes('=') && PUSH_VALUE_FLAGS.has(name)) j++
      if (name === '--repo' && !t.includes('=')) j++
    } else if (!PUSH_SHORT.test(t)) return odd(`cụm cờ ngắn ${showName(t)} lạ`)
    else if (t.endsWith('o')) j++
  }
  const info = repoInfo(g.dir)
  if (!info) return null
  const p = parsePushArgs(g.rest)
  const cur = info.branch && info.branch !== 'HEAD' ? info.branch : null
  const cfg = (k) => (git(info.dir, ['config', '--get', k]) ?? '').trim()
  // không ghi remote ⇒ git đẩy tới branch.<nhánh>.pushRemote → remote.pushDefault → branch.<nhánh>.remote → origin
  const remote = p.repo ?? p.positional[0] ??
    ((cur ? cfg(`branch.${cur}.pushRemote`) : '') || cfg('remote.pushDefault') || (cur ? cfg(`branch.${cur}.remote`) : '') || 'origin')
  if (!/^[\w.-]+$/.test(remote)) return null // URL/đường dẫn: không có cấu hình remote.<tên>.*
  const mirror = cfg(`remote.${remote}.mirror`)
  if (mirror && !/^(false|no|off|0+)$/i.test(mirror)) { // git coi true/yes/on và mọi số khác 0 là bật; giá trị lạ cũng chặn
    return odd(`remote ${remote} cài chế độ mirror (ghi đè và xoá mọi nhánh trên máy chủ)`)
  }
  const specs = p.repo !== null ? p.positional : p.positional.slice(1)
  if (specs.length === 0 && !p.all && !p.mirror && !p.tags && (git(info.dir, ['config', '--get-all', `remote.${remote}.push`]) ?? '').trim()) {
    return odd(`remote ${remote} có cấu hình push riêng (remote.${remote}.push) — ghi rõ nhánh cần đẩy trong lệnh`)
  }
  return null
}

// rest = đối số sau `git push`. Trả { skip, dryRun, del, force, all, mirror, tags, repo, positional }
// (skip = dry-run hoặc xoá ref: không gửi commit nào; del = --delete/-d: positional sau remote là tên nhánh bị xoá).
function parsePushArgs(rest) {
  const p = { skip: false, dryRun: false, del: false, force: false, all: false, mirror: false, prune: false, tags: false, repo: null, positional: [] }
  let onlyPositional = false
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]
    if (!onlyPositional && t === '--') onlyPositional = true
    else if (onlyPositional || !t.startsWith('-')) p.positional.push(t)
    else if (t === '--dry-run' || t === '-n') p.skip = p.dryRun = true
    else if (t === '--delete' || t === '-d') p.skip = p.del = true
    else if (/^-[A-Za-z0-9]{2,}$/.test(t) && /^[^o]*[dn]/.test(t.slice(1))) { // cụm cờ ngắn có d/n (vd -dv, -nf); từ `o` trở đi là giá trị của -o
      const head = t.slice(1).split('o')[0]
      if (head.includes('n')) p.skip = p.dryRun = true
      if (head.includes('d')) p.skip = p.del = true
      if (head.includes('f')) p.force = true
    }
    else if (t === '--all' || t === '--branches') p.all = true
    else if (t === '--mirror') p.mirror = true
    else if (t === '--prune') p.prune = true
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
  const where = verb === 'commit' ? 'sắp được lưu vào lịch sử dự án' : 'sắp được gửi lên máy chủ'
  const reason = []
  if (lines.size > 0) {
    const list = [...lines]
    const shown = list.slice(0, 10).join('; ') + (list.length > 10 ? `; …và ${list.length - 10} mục nữa` : '')
    reason.push(
      `Phần ${where} có thứ giống mật khẩu hoặc khoá bí mật nên đã dừng lại; AI sẽ gỡ nó ra khỏi thay đổi rồi thử lại.`,
      `Phát hiện secret trong phần sắp ${verb}: ${shown}. Gỡ secret khỏi thay đổi và dùng biến môi trường. ` +
      `Nếu báo nhầm thì thêm comment "${ALLOW_MARK}" vào dòng đó (file nhạy cảm: vào một dòng của file).`,
    )
  }
  if (truncated) {
    if (lines.size === 0) {
      reason.push(`Phần ${where} quá lớn nên chưa kiểm hết được có lộ mật khẩu hay khoá bí mật không; AI sẽ chia nhỏ phần thay đổi rồi lưu lại.`)
    }
    reason.push(
      `Diff quá lớn để quét hết (vượt ${SCAN_LIMIT / 1048576} MB, chỉ quét phần đầu) nên không coi là sạch. ` +
      `Chia thành các lần ${verb} nhỏ hơn để quét được hết; không đưa lệnh terminal cho user chạy.`,
    )
  }
  return permission('deny', reason.join(' '))
}

// ---------- lệnh phá huỷ trên nhánh chính / hỏi lại khi push nhánh chính ----------

const isMainName = (n) => n === 'main' || n === 'master'
const SAFE_REF = /^(?!-)[A-Za-z0-9._/-]+$/ // tên remote/nhánh an toàn để in vào dòng lệnh user chép: không dấu cách, nháy, ; | & $ ` ( ) < >, xuống dòng; không bắt đầu bằng -
const permission = (decision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } })

// Các ref gửi đi mà đích là nhánh chính: [{ src, name, plus }]. --mirror gửi mọi ref ⇒ coi như gửi nhánh chính.
function mainPushTargets(info, p) {
  if (p.mirror) {
    const name = mainBranch(info)
    return [{ src: `refs/heads/${name}`, name, plus: false }]
  }
  return pushSources(info, p).filter((s) => isMainName(s.name))
}

// g = parseGitSub của `git push`. Deny khi push ép (cờ ép, refspec +, --mirror ghi đè/xoá mọi ref, --prune xoá nhánh remote) mà đích là nhánh chính.
function gateForcePush(g) {
  const info = repoInfo(g.dir)
  if (!info) return null
  const p = parsePushArgs(g.rest)
  if (p.skip) return null // dry-run/xoá ref: không ghi đè gì
  // --prune kèm refspec đại diện (*) hoặc --all xoá được nhánh chính trên remote kể cả khi máy không có nhánh đó ⇒ coi như đụng nhánh chính
  const wide = p.prune && (p.all || p.positional.some((s) => s.includes('*')))
  const hit = wide ? { name: mainBranch(info) } : mainPushTargets(info, p).find((t) => p.force || p.mirror || p.prune || t.plus)
  if (!hit) return null
  return permission('deny',
    'Không ghi đè lịch sử của nhánh chính trên máy chủ được vì không hoàn tác được; AI sẽ đẩy lên một nhánh riêng rồi gộp sau. ' +
    `Không push ép (--force / --force-with-lease / --mirror / --prune / refspec +) lên nhánh chính ${hit.name}: ghi đè hoặc xoá ref trên remote không hoàn tác được. ` +
    'Push nhánh riêng rồi gộp; không đưa lệnh terminal cho user chạy.')
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
  return permission('deny',
    'Không xoá nhánh chính trên máy chủ được; AI sẽ bỏ lệnh này và làm cách khác.' + ' ' +
    `Không xoá nhánh chính ${hit} trên remote (git push --delete / refspec :${hit}). Thật sự cần ⇒ kể user bằng lời đời thường, không đưa lệnh terminal cho user chạy.`)
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
  const wipe = (what) =>
    'Lệnh này sẽ xoá các thay đổi chưa lưu ở bản chính của dự án nên đã dừng lại; AI sẽ làm việc trong một bản sao riêng thay vào đó. ' +
    `${what} ở ${here} sẽ xoá thay đổi chưa commit. Làm trong worktree; không đưa lệnh terminal cho user chạy.`
  switch (g.sub) {
    case 'reset':
      if (f.long.has('hard') && !info.linked && isMainName(info.branch)) return permission('deny', wipe('git reset --hard'))
      return null
    case 'branch': {
      const del = f.short.has('D') || (flag('d', 'delete') && flag('f', 'force'))
      const main = f.pos.map((n) => n.replace(/^refs\/heads\//, '')).find(isMainName)
      if (del && main) {
        return permission('deny',
          'Không xoá nhánh chính được; AI sẽ bỏ lệnh này và làm cách khác.' + ' ' +
          `Không xoá nhánh chính ${main} bằng git branch -D / -d -f. Thật sự cần ⇒ kể user bằng lời đời thường, không đưa lệnh terminal cho user chạy.`)
      }
      if (flag('m', 'move') || f.short.has('M')) {
        // `-m <x> <đích>` hoặc `-m <đích>` (đổi tên nhánh hiện tại); đích là nhánh chính khác nguồn ⇒ đè nhánh chính
        const [from, to] = f.pos.length >= 2 ? f.pos : [info.branch, f.pos[0]]
        if (isMainName(to) && from !== to) {
          return permission('deny',
            'Không đè lên nhánh chính được; AI sẽ đặt tên khác cho nhánh. ' +
            `Không đè nhánh chính ${to} bằng git branch -m / -M. Thật sự cần ⇒ kể user bằng lời đời thường, không đưa lệnh terminal cho user chạy.`)
        }
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

// ---------- chống lách ở cổng gộp: file luật, dòng tắt luật, chép repo "chỉ học" ([j21n], AC-45, AC-37) ----------

// File luật = isRuleFile của lib/rule-files.mjs (MỘT nguồn, dùng chung với luu.mjs quay): luật kiến trúc/lint của lib/arch.mjs + kit/rules/** + kit/checkers.json (bảng checker của kit)
// + .claude/flow.json (miễn test, uiPattern, trustedDepSources, prodRefs: sửa nó là đổi cổng gộp/thư viện/khoá thật) + .claude/ui.json, docs/ui-baseline.json, .claude/luu.json.
// Nhãn đời thường cho từng loại.
const RULE_LABELS = [
  [/^\.claude\/flow\.json$/, 'cấu hình cổng của dự án'], [/^kit\/checkers\.json$/, 'danh sách checker của kit'],
  [/^\.claude\/ui\.json$/, 'luật kiểm giao diện'], [/^docs\/ui-baseline\.json$/, 'danh sách lỗi giao diện cũ được bỏ qua'], [/^\.claude\/luu\.json$/, 'cấu hình điểm lưu (đường dẫn dữ liệu)'],
  [/^docs\/arch\.json$/, 'luật kiến trúc'], [/^docs\/arch-baseline\.json$/, 'danh sách vi phạm cũ được bỏ qua'],
  [/(^|\/)\.dependency-cruiser/, 'luật import giữa các module'], [/(^|\/)\.go-arch-lint/, 'luật kiến trúc của Go'],
  [/(^|\/)\.golangci\./, 'luật kiểm code Go'], [/(^|\/)(eslint\.config\.|\.eslintrc|eslint-suppressions)/, 'luật ESLint'],
  [/(^|\/)biome\.jsonc?$/, 'luật Biome'], [/(^|\/)sgconfig\.ya?ml$/, 'luật ast-grep'], [/^kit\/rules\//, 'luật của kit'],
]
const CHANGE_VERBS = { A: 'thêm', M: 'sửa', D: 'xoá', T: 'đổi kiểu' }
const LIMIT_WORDS = { fileLines: 'cỡ file', fnLines: 'cỡ hàm', complexity: 'độ phức tạp' }
// Dòng tắt luật. Tài liệu (.md/.mdx/.txt) chỉ nhắc tới chúng, không tắt được gì nên không tính.
const SUPPRESS = [
  [/\beslint-disable/, 'eslint-disable'], [/@ts-ignore\b/, '@ts-ignore'], [/\/\/\s*nolint\b/, '//nolint'],
  [/\bbiome-ignore\b/, 'biome-ignore'], [/#\s*noqa\b/i, '# noqa'], [/\bast-grep-ignore\b/, 'ast-grep-ignore'],
  [/@ts-nocheck\b/, '@ts-nocheck'], [/\bsquawk-ignore\b/, 'squawk-ignore'], [/#\s*type:\s*ignore\b/, '# type: ignore'],
]

// Dòng (đã bỏ dấu +) có tắt luật không? Trả tên loại hoặc null. @ts-expect-error phải kèm lý do (≥ 3 chữ/số sau nó, bỏ `*/`).
function suppressionOf(text) {
  const hit = SUPPRESS.find(([re]) => re.test(text))
  if (hit) return hit[1]
  const m = /@ts-expect-error\b/.exec(text)
  if (!m) return null
  const reason = text.slice(m.index + m[0].length).replace(/\*\/.*$/, '')
  return (reason.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3 ? null : '@ts-expect-error không kèm lý do'
}

// File do công cụ sinh ra (không ai sửa tay): theo đường dẫn quen của bộ sinh code, hoặc đầu file có dấu "tự sinh, đừng sửa".
// Dòng tắt luật trong đó là của bộ sinh, không phải AI lách luật ⇒ không tính. Wails ghi dấu bằng tiếng Wales ("Cynhyrchwyd…").
const GENERATED_PATH = /(^|\/)(wailsjs|__generated__|generated|node_modules|vendor)\/|\.(gen|generated|pb)\.[cm]?[jt]sx?$|(_gen|\.pb|_templ|zz_generated[^/]*)\.go$/i
// Dấu phải là một dòng comment ở 5 dòng đầu, đúng câu của bộ sinh (không bắt "do not edit" lẫn trong câu thường của file viết tay).
// Cả dòng phải đúng câu bộ sinh (neo cuối dòng) — "This file was automatically generated years ago; edit it…" là file tay (review Grok).
const GENERATED_MARK = new RegExp('^\\s*(?:\\/\\/|#|\\/\\*+|\\*|<!--|--)\\s*(?:' + [
  'Code generated\\b[^\\n]{0,80}\\bDO NOT EDIT\\.?', // Go, sqlc, protoc… — sau DO NOT EDIT chỉ còn dấu chấm rồi hết dòng
  '@generated',
  'This file (?:is|was) (?:auto-?generated|automatically generated)(?: by [\\w@/-]+(?: [\\w@/-]+){0,3})?\\.?(?:\\s*DO NOT EDIT\\.?)?',
  'Cynhyrchwyd y ffeil hon yn awtomatig\\. PEIDIWCH Â MODIWL', // Wails
].join('|') + ')\\s*(?:\\*\\/|-->)?\\s*$', 'm')
function isGeneratedFile(info, sha, file) {
  if (GENERATED_PATH.test(file)) return true
  const head = git(info.dir, ['cat-file', '-p', `${sha}:${file}`])
  return head !== null && GENERATED_MARK.test(head.split('\n', 5).join('\n'))
}

// Các dòng THÊM tắt luật trong patch `-U0`: [{ file, line, what }]. Đếm dòng theo số dòng ghi ở đầu mỗi hunk nên dòng thêm bắt đầu
// bằng "++ " (thành "+++ …" trong patch) không bị đọc nhầm là tên file mới.
function addedSuppressions(patch) {
  const out = []
  let file = null
  let oldLeft = 0
  let newLeft = 0
  let line = 0
  for (const l of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (l[0] === '+') {
        newLeft--
        const what = file && !DOC_FILE.test(file) ? suppressionOf(l.slice(1)) : null
        if (what) out.push({ file, line, what })
        line++
        continue
      }
      if (l[0] === '-') { oldLeft--; continue }
      if (l[0] === '\\') continue
      oldLeft = newLeft = 0 // hunk cụt: dòng này là đầu mục mới
    }
    if (l.startsWith('diff --git ')) file = null
    else if (l.startsWith('+++ ')) {
      const f = l.slice(4).replace(/\t$/, '').replace(/^"|"$/g, '')
      file = f === '/dev/null' ? null : f.replace(/^b\//, '')
    } else {
      const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l)
      if (h) { oldLeft = h[1] === undefined ? 1 : Number(h[1]); line = Number(h[2]); newLeft = h[3] === undefined ? 1 : Number(h[3]) }
    }
  }
  return out
}

// Diff base...sha của MỘT merge target (HEAD đang là nhánh chính nên không dùng base...HEAD): { changes: [{ st, file }], patch } hoặc null khi git lỗi
// (không chung lịch sử, quá lớn, quá giờ…). --no-renames: đổi tên lộ cả đường dẫn cũ lẫn mới; --text: .gitattributes `-diff` không giấu được dòng thêm.
function mergeDiff(info, base, sha) {
  const range = `${base}...${sha}`
  const common = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--text']
  const names = git(info.dir, [...common, '--name-status', '-z', range, '--'])
  const patch = names === null ? null : git(info.dir, [...common, '-U0', '--src-prefix=a/', '--dst-prefix=b/', range, '--'])
  if (names === null || patch === null) return null
  const t = names.split('\0')
  const changes = []
  for (let i = 0; i + 1 < t.length; i += 2) changes.push({ st: t[i].charAt(0), file: t[i + 1] })
  return { changes, patch }
}

// Trần (limits.*) từng phần của docs/arch.json ở hai bản (before/after = commit): câu "nới/siết trần …" cho mỗi trần đổi giá trị. Lỗi đọc ⇒ rỗng.
function limitChanges(dir, before, after) {
  const pick = (rev) => {
    const out = new Map()
    try {
      const parts = JSON.parse(git(dir, ['show', `${rev}:docs/arch.json`]) ?? '').parts
      for (const [i, p] of (Array.isArray(parts) ? parts : []).entries()) for (const [k, v] of Object.entries(p?.limits ?? {})) out.set(`${p?.name ?? i}\0${k}`, v)
    } catch {}
    return out
  }
  const was = pick(before)
  const changes = []
  for (const [key, now] of pick(after)) {
    if (!was.has(key) || was.get(key) === now) continue
    const [part, k] = key.split('\0')
    changes.push(`${now > was.get(key) ? 'nới' : 'siết'} trần ${LIMIT_WORDS[k] ?? k} (${k} của phần ${part}: từ ${was.get(key)} thành ${now})`)
  }
  return changes
}

const showName = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80)

// Có thể có thẻ chi-hoc không (docs/research ở thư mục làm việc hoặc trong cây của sha)? git lỗi ⇒ coi như có.
function hasResearchDir(info, sha) {
  return fs.existsSync(path.join(info.toplevel, 'docs', 'research')) || (git(info.dir, ['ls-tree', '-d', '--name-only', sha, 'docs/research']) ?? 'lỗi').trim() !== ''
}

const GUARD_OPENINGS = {
  unknown: 'Chưa kiểm được nhánh sắp gộp có nới luật của dự án hay chép code từ repo chỉ-được-học hay không nên AI dừng lại, chưa gộp; AI sẽ kiểm lại rồi gộp sau.',
  copy: 'Phần mới của nhánh này có đoạn giống code của repo mà dự án chỉ được đọc để học, không được chép, nên AI dừng lại; AI sẽ viết lại đoạn đó bằng cách của mình rồi gộp lại.',
  missing: 'Chưa kiểm được nhánh này có chép code từ repo chỉ-được-học hay không nên AI dừng lại; AI sẽ khôi phục bản sao repo đó (hoặc báo bạn nếu không tự làm được) rồi gộp lại.',
}

// Mọi merge target: so base...<target> (không phải base...HEAD). Trả deny khi không kiểm được (fail closed) hoặc chép repo chỉ-học;
// trả deny (mọi host) nhắn AI gỡ phần nới luật khi nhánh nới luật hoặc thêm dòng tắt luật; null khi sạch.
async function mergeGuards(info, base, targets) {
  const stops = [] // { kind: 'unknown'|'copy'|'missing', msg }
  const loosen = [] // việc nới luật, mỗi mục một câu đời thường
  const multi = targets.length > 1
  const safeName = (t) => (SAFE_REF.test(t) ? t : '(tên có ký tự lạ)')
  const { isRuleFile } = await import('./lib/rule-files.mjs')
  for (const target of targets) {
    const at = multi ? ` (nhánh ${safeName(target)})` : ''
    const sha = revOf(info, target)
    if (!sha) { stops.push({ kind: 'unknown', msg: `không tìm thấy "${showName(target)}" trong repo (nhánh/commit không tồn tại hoặc tên chưa được viết rõ trong lệnh)` }); continue }
    const diff = mergeDiff(info, base, sha)
    if (!diff) { stops.push({ kind: 'unknown', msg: `không tính được thay đổi ${base}...${showName(target)} (git diff lỗi, quá lớn, hoặc nhánh không chung lịch sử với ${base})` }); continue }
    const mergeBase = (git(info.dir, ['merge-base', base, sha]) ?? '').trim()
    for (const { st, file } of diff.changes) {
      if (!isRuleFile(file)) continue
      const label = RULE_LABELS.find(([re]) => re.test(file))?.[1] ?? 'luật'
      const limits = st === 'M' && file === 'docs/arch.json' && mergeBase ? limitChanges(info.dir, mergeBase, sha) : []
      loosen.push(`${CHANGE_VERBS[st] ?? 'đổi'} file ${label} (${file})${limits.length ? `: ${limits.join('; ')}` : ''}${at}`)
    }
    for (const s of addedSuppressions(diff.patch)) {
      if (isGeneratedFile(info, sha, s.file)) continue // máy sinh (Wails bindings, protobuf…): AI không gỡ được, không phải lách luật
      loosen.push(`thêm dòng tắt luật ở ${s.file}:${s.line} (${s.what})${at}`)
    }
    // chép repo chỉ-học: chỉ khi dự án có thẻ chi-hoc (chiHocMatches trả ngay khi không có thẻ); lỗi bất ngờ ⇒ chặn nếu dự án có docs/research
    let hoc
    try {
      hoc = (await import('./lib/kho.mjs')).chiHocMatches(info, base, sha)
    } catch (e) {
      log(`chiHocMatches ${target}: ${e?.stack ?? e}`)
      if (hasResearchDir(info, sha)) stops.push({ kind: 'missing', msg: `phần kiểm chép code từ repo chỉ-học bị lỗi (${showName(e?.message ?? e)}) nên chưa biết nhánh ${showName(target)} có chép hay không` })
      continue
    }
    if (hoc.matches.length > 0) {
      const shown = hoc.matches.slice(0, 8).map((x) => `${x.file}:${x.line}-${x.end_line} (${x.so_dong} dòng, giống ${Math.round(x.ty_le * 100)}% repo chỉ-học "${x.the}")`).join('; ')
      stops.push({ kind: 'copy', msg: `nhánh ${showName(target)} có ${hoc.matches.length} đoạn giống repo chỉ-học: ${shown}${hoc.matches.length > 8 ? `; …và ${hoc.matches.length - 8} đoạn nữa` : ''} ` +
        '— tự viết lại theo cách của dự án (đổi tên biến hay khoảng trắng thì vẫn bị bắt)' })
    }
    for (const x of hoc.missing) {
      stops.push({ kind: 'missing', msg: `repo chỉ-học "${x.the}": ${x.ly_do}${x.lenh ? ` — khôi phục bằng: ${x.lenh}` : ''}` })
    }
    if (hoc.loi) stops.push({ kind: 'missing', msg: `không so được với repo chỉ-học: ${hoc.loi}` })
  }
  if (stops.length > 0) {
    const kind = ['unknown', 'copy', 'missing'].find((k) => stops.some((s) => s.kind === k))
    return permission('deny', `${GUARD_OPENINGS[kind]}\n${stops.map((s) => `- ${s.msg}`).join('\n')}`)
  }
  if (loosen.length === 0) return null
  const list = loosen.slice(0, 10).map((s) => `- ${s}`).join('\n') + (loosen.length > 10 ? `\n- …và ${loosen.length - 10} mục nữa` : '')
  const names = targets.map(safeName).join(' ')
  // Mọi host: deny nhắn AI tự gỡ — không hộp hỏi, không lối AI tự mở [fn9k], và KHÔNG đẩy lệnh terminal sang user (user no code) [chốt 2026-10-15].
  return permission('deny',
    'Nhánh này nới luật kiểm tra của dự án hoặc tắt kiểm tra ở vài chỗ nên AI chưa gộp; AI sẽ gỡ phần nới luật rồi gộp lại. ' +
    `Gộp ${names} vào ${base} sẽ kèm:\n${list}\n` +
    'Việc của AI: gỡ phần nới luật/dòng tắt luật trên nhánh, kiểm lại rồi gộp. Không tự lách, KHÔNG đưa lệnh terminal cho user tự chạy (user không code). ' +
    'File do máy sinh (Wails wailsjs/, có dấu "DO NOT EDIT"…) đã được bỏ qua sẵn; nếu chỗ bị nêu thật sự không gỡ được hoặc user nói rõ muốn đổi luật ' +
    '⇒ kể user một câu đời thường (chỗ nào, vì sao kit chặn) rồi dừng việc gộp, chờ sửa kit.')
}

// Cổng gộp cho một danh sách đích (nhánh/commit) sắp vào nhánh chính `base`: đủ dấu review/qa/test, rồi chống lách (mergeGuards).
// Dùng chung cho `git merge` và mọi đường khác đưa commit vào nhánh chính (entrants).
async function gateTargets(info, base, targets, host) {
  const lacking = (await Promise.all(targets.map(async (target) => ({ target, st: await tryGateState(info, base, target) }))))
    .filter(({ st }) => st && st.missing.length > 0)
  if (lacking.length === 0) {
    // Mọi dấu đủ: xét tiếp chống lách. Lỗi bất ngờ ⇒ chặn (cổng này là chỗ AI có thể lách luật, không cho qua âm thầm).
    try {
      return await mergeGuards(info, base, targets)
    } catch (e) {
      log(`mergeGuards: ${e?.stack ?? e}`)
      return permission('deny',
        'Chưa kiểm được nhánh sắp gộp có nới luật của dự án hay không nên AI dừng lại, chưa gộp; AI sẽ báo bạn lỗi này thay vì tự gộp. ' +
        `Bước kiểm luật bị lỗi: ${showName(e?.message ?? e)}. Xem flow-gate.log, sửa nguyên nhân rồi gộp lại; không đưa lệnh terminal cho user chạy.`)
    }
  }
  const detail = lacking
    .map(({ target, st }) => `${target}: thiếu ${st.missing.join(', ')}` + (st.naOnUi ? ' (diff có file UI nhưng qa ghi N/A)' : '') +
      (st.pMissing.length > 0 ? ` (báo cáo QA chưa có dòng "${P_LINE_FORMAT}" cho ${st.pMissing.join(', ')}: mỗi mã quyền của SPEC cần test chặn quyền đỏ khi tắt chặn quyền)` : '') +
      (st.pUnreadable.length > 0 ? ` (${unreadableNote(st.pUnreadable)})` : '') + ` (patch-id=${st.pid})`)
    .join('; ')
  const kinds = new Set(lacking.flatMap(({ st }) => st.missing))
  const how = []
  if (kinds.has('review')) how.push('node ~/.claude/hooks/flow-gate.mjs stamp review <review.json>')
  if (kinds.has('qa')) how.push('node ~/.claude/hooks/flow-gate.mjs stamp qa <qa.md>')
  if (kinds.has('test')) how.push('node ~/.claude/hooks/flow-gate.mjs stamp test -- <lệnh test đủ bộ>')
  return permission('deny',
    'Chưa gộp vào nhánh chính được vì bản này chưa qua đủ các bước kiểm tra; AI sẽ làm nốt các bước đó rồi gộp lại. ' +
    `Chưa đủ dấu để gộp vào ${base} — ${detail}. Chạy trong worktree của nhánh: ${how.join(' · ')}` +
    (kinds.has('review') || kinds.has('qa') ? ' (skill flow-review / flow-qa tạo file review.json / qa.md)' : '') +
    (kinds.has('test') ? '. Repo không có test: ghi .claude/flow.json {"tests":"none"}' : '') + '.')
}

async function gateMerge(m, host) {
  const info = repoInfo(m.dir)
  if (!info) return null
  const base = mainBranch(info)
  if (info.branch !== base) return null
  return gateTargets(info, base, m.targets, host)
}

// ---------- mọi đường khác đưa commit của nhánh khác vào nhánh chính (QA B3) ----------
// `git merge` không phải cách duy nhất: pull ., cherry-pick, rebase, fetch ., push ., branch -f, update-ref, checkout -B, switch -C cũng làm nhánh chính
// nhận commit chưa qua review. Mỗi lệnh ⇒ quy ra danh sách đích rồi qua đúng gateTargets như `git merge`. Không quy ra được đích ⇒ deny (fail closed).

const PULL_VALUE_FLAGS = new Set(['-s', '-X', '-F', '-j', '-o', '--strategy', '--strategy-option', '--file', '--cleanup', '--into-name', '--depth', '--deepen', '--shallow-since',
  '--shallow-exclude', '--jobs', '--upload-pack', '--server-option', '--negotiation-tip', '--refmap', '--filter'])
const FETCH_VALUE_FLAGS = new Set(['-j', '-o', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--jobs', '--upload-pack', '--server-option', '--negotiation-tip', '--refmap', '--filter'])
const CHERRY_VALUE_FLAGS = new Set(['-m', '-X', '--mainline', '--strategy-option', '--strategy', '--cleanup', '--empty'])
const REBASE_VALUE_FLAGS = new Set(['-s', '-X', '-x', '-C', '--strategy', '--strategy-option', '--exec', '--onto', '--empty'])
const SWITCH_VALUE_FLAGS = new Set(['-b', '-B', '-c', '-C', '--create', '--force-create', '--orphan', '--conflict'])
const ENTRY_SUBS = new Set(['pull', 'cherry-pick', 'rebase', 'fetch', 'branch', 'checkout', 'switch', 'update-ref'])

// rest → { pos: đối số không phải cờ (gồm cả sau `--`), vals: Map cờ → giá trị }. Cờ dài trong valueFlags lấy token kế hoặc dạng --cờ=giá-trị;
// cụm cờ ngắn (-fB, -fBmain, -qC main) duyệt từng ký tự như git: gặp cờ nhận giá trị thì phần dính liền sau nó (hoặc token kế nếu hết cụm) là giá trị.
function splitArgs(rest, valueFlags) {
  const pos = []
  const vals = new Map()
  let only = false
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]
    if (!only && t === '--') only = true
    else if (only || !t.startsWith('-') || t === '-') pos.push(t)
    else if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      if (eq >= 0) vals.set(t.slice(0, eq), t.slice(eq + 1))
      else if (valueFlags.has(t)) vals.set(t, rest[++j] ?? '')
    } else {
      for (let k = 1; k < t.length; k++) {
        if (!valueFlags.has(`-${t[k]}`)) continue
        vals.set(`-${t[k]}`, t.slice(k + 1) || (rest[++j] ?? ''))
        break
      }
    }
  }
  return { pos, vals }
}

const headName = (r) => r.replace(/^\+/, '').replace(/^refs\/heads\//, '')
const refSrc = (spec) => { const s = spec.replace(/^\+/, ''); const c = s.indexOf(':'); return c < 0 ? s : s.slice(0, c) }
const refDst = (spec) => { const s = spec.replace(/^\+/, ''); const c = s.indexOf(':'); return c < 0 ? '' : s.slice(c + 1) }
const rangeTip = (t) => { const m = /^(.*?)\.\.\.?(.*)$/.exec(t); return m ? (m[2] || 'HEAD') : t } // `a..b`, `a...b` ⇒ b

// `repo` của push/pull/fetch có phải CHÍNH repo này không: `.`, `./`, `.\`; đường dẫn hay file:// tới thư mục chính, thư mục .git hoặc bất kỳ worktree nào
// của repo (cùng git-common-dir, so realpath); hoặc tên remote có url/pushurl như vậy. Remote mạng (https, ssh, user@host:…) thì không.
function isThisRepo(info, repo, viaName = true) {
  if (typeof repo !== 'string' || !repo) return false
  if (/^\.[\\/]*$/.test(repo)) return true
  if (viaName && SAFE_REF.test(repo)) {
    const url = (git(info.dir, ['config', '--get', `remote.${repo}.pushurl`]) || git(info.dir, ['config', '--get', `remote.${repo}.url`]) || '').trim()
    if (url) return isThisRepo(info, url, false)
  }
  let p = repo
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p) } catch { return false }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[^/\\]+@[^/\\:]+:/.test(p)) return false
  const dir = path.resolve(info.dir, toNative(p))
  try { if (!fs.statSync(dir).isDirectory()) return false } catch { return false }
  const out = git(dir, ['rev-parse', '--git-common-dir'])
  if (!out) return false
  const real = (x) => { try { return fs.realpathSync.native(x) } catch { return path.resolve(x) } }
  return norm(real(path.resolve(dir, out.trim()))) === norm(real(info.commonDir))
}

// g = parseGitSub. Trả null (lệnh này không đưa commit nhánh khác vào nhánh chính), { unknown: lý do } (không quy ra được đích) hoặc
// { targets }.
function entrants(g, info, base) {
  const onMain = info.branch === base
  const rest = g.rest
  const into = (targets) => (targets.length ? { targets } : null)
  const cfg = (k) => (info.branch ? (git(info.dir, ['config', '--get', `branch.${info.branch}.${k}`]) ?? '').trim() : '')
  // Lấy srcs từ repo: repo `.` ⇒ ref cục bộ, kiểm được ngay. Remote khác ⇒ chỉ nhánh chính của remote là bình thường (đồng bộ); nhánh khác chưa tải về nên chưa biết nội dung.
  const fromRepo = (repo, srcs, verb) => {
    const list = srcs.filter(Boolean)
    if (list.length === 0) return null
    if (isThisRepo(info, repo)) return into(list)
    const odd = list.filter((s) => !isMainName(headName(s)))
    if (odd.length === 0) return null
    const safe = (s) => (SAFE_REF.test(s) ? s : '<tên>')
    return { unknown: `${verb} sẽ lấy ${odd.map((s) => `"${showName(s)}"`).join(', ')} từ "${showName(repo)}" vào nhánh chính ${base} nhưng nội dung chỉ biết sau khi tải về; ` +
      `chạy git fetch ${safe(repo)} trước, rồi git merge ${safe(repo)}/${safe(headName(odd[0]))} để đi qua cổng kiểm` }
  }
  // pull/fetch với refspec `nguồn:đích`: fetch cập nhật THẲNG refs/heads/<đích> từ bất kỳ worktree nào (pull luôn fetch kiểu cho phép đổi nhánh đang checkout),
  // nên đích là nhánh chính ⇒ nguồn phải qua cổng dù đang đứng ở nhánh khác; nguồn bỏ trống mà đích là nhánh chính ⇒ deny. mergesHere = pull đang đứng ở main:
  // mọi nguồn còn được merge vào main.
  const viaRefspecs = (repo, specs, verb, mergesHere) => {
    const toMain = specs.filter((s) => headName(refDst(s)) === base)
    if (toMain.some((s) => !refSrc(s))) {
      return { deny: `Không xoá hay đặt lại nhánh chính bằng lệnh có nguồn bỏ trống được; AI sẽ bỏ lệnh này và làm cách khác. ` +
        `${verb} với đích ${base} mà nguồn để trống (:${base}) xoá hoặc đặt lại nhánh chính theo HEAD. Thật sự cần ⇒ kể user bằng lời đời thường, không đưa lệnh terminal cho user chạy.` }
    }
    return fromRepo(repo, (mergesHere ? specs : toMain).map(refSrc), verb)
  }
  switch (g.sub) {
    case 'pull': {
      const { pos } = splitArgs(rest, PULL_VALUE_FLAGS)
      let specs = pos.slice(1).filter((s) => s !== 'tag')
      if (specs.length === 0 && cfg('merge')) specs = [cfg('merge')]
      return viaRefspecs(pos[0] ?? (cfg('remote') || 'origin'), specs, 'git pull', onMain)
    }
    case 'cherry-pick': {
      if (!onMain || rest.some((t) => /^--(continue|abort|quit|skip)$/.test(t))) return null
      return into(splitArgs(rest, CHERRY_VALUE_FLAGS).pos.filter((t) => !t.startsWith('^')).map(rangeTip))
    }
    case 'rebase': {
      if (rest.some((t) => /^--(continue|abort|quit|skip|edit-todo|show-current-patch)$/.test(t))) return null
      const { pos, vals } = splitArgs(rest, REBASE_VALUE_FLAGS)
      // `rebase <upstream> <nhánh>`: nhánh bị dời là <nhánh> (git tự chuyển sang nó, chạy ở đâu cũng được); không nêu nhánh thì là nhánh đang đứng
      if (!(pos[1] !== undefined ? headName(pos[1]) === base : onMain)) return null
      const t = vals.get('--onto') || pos[0]
      return t ? into([t]) : null
    }
    case 'fetch': {
      const { pos } = splitArgs(rest, FETCH_VALUE_FLAGS)
      return pos[0] === undefined ? null : viaRefspecs(pos[0], pos.slice(1), 'git fetch', false)
    }
    case 'push': {
      const p = parsePushArgs(rest)
      if (p.skip || !isThisRepo(info, p.repo ?? p.positional[0])) return null
      const specs = p.repo !== null ? p.positional : p.positional.slice(1)
      return into(specs.filter((s) => headName(refDst(s)) === base).map(refSrc).filter(Boolean)) // `:main` (xoá) đã bị gateDeleteMainPush chặn trước
    }
    case 'branch': {
      const f = simpleFlags(rest)
      const force = f.short.has('f') || f.long.has('force')
      const copy = f.short.has('C') || (force && (f.short.has('c') || f.long.has('copy')))
      if (copy) { // branch -C [<nguồn>] <đích>: đè nhánh đích bằng bản sao của nguồn
        const dst = f.pos.length >= 2 ? f.pos[1] : f.pos[0]
        return dst !== undefined && headName(dst) === base ? into([f.pos.length >= 2 ? f.pos[0] : (info.branch ?? 'HEAD')]) : null
      }
      const other = ['d', 'D', 'm', 'M', 'c', 'l', 'u'].some((c) => f.short.has(c)) ||
        ['delete', 'move', 'copy', 'list', 'set-upstream-to', 'unset-upstream', 'edit-description', 'contains', 'merged', 'no-merged', 'points-at', 'show-current'].some((l) => f.long.has(l))
      return force && !other && f.pos[0] !== undefined && headName(f.pos[0]) === base ? into([f.pos[1] ?? 'HEAD']) : null
    }
    case 'update-ref': {
      if (rest.includes('--stdin')) return { unknown: 'git update-ref --stdin đổi ref theo danh sách đọc từ đầu vào nên không biết ref nào (có thể là nhánh chính) bị đổi sang đâu' }
      if (rest.some((t) => t === '-d' || t === '--delete')) return null
      const { pos } = splitArgs(rest, new Set(['-m']))
      const dst = pos[0] === 'HEAD' ? (onMain ? base : null) : pos[0] !== undefined ? headName(pos[0]) : null
      return dst === base && pos[1] !== undefined ? into([pos[1]]) : null
    }
    case 'checkout':
    case 'switch': {
      // checkout -B <tên> [<điểm đầu>] / switch -C <tên> [<điểm đầu>]: đặt lại nhánh <tên> về <điểm đầu> (mặc định HEAD)
      const force = g.sub === 'checkout' ? '-B' : '-C'
      const { pos, vals } = splitArgs(rest, SWITCH_VALUE_FLAGS) // splitArgs tách cả cụm cờ ngắn: -fB main, -fBmain, -qCmain
      const name = vals.get(force) ?? vals.get('--force-create')
      return name !== undefined && headName(name) === base ? into([pos[0] ?? 'HEAD']) : null
    }
    default:
      return null
  }
}

// Đích đưa vào nhánh chính qua pull/cherry-pick/rebase/fetch/push/branch/update-ref/checkout/switch ⇒ cùng cổng với `git merge` (dấu + nới luật + chép chỉ-học).
async function gateEntry(g, host) {
  const info = repoInfo(g.dir)
  if (!info) return null
  const base = mainBranch(info)
  const e = entrants(g, info, base)
  if (!e) return null
  if (e.deny) return permission('deny', e.deny)
  if (e.unknown) return permission('deny', `${GUARD_OPENINGS.unknown}\n- ${e.unknown}`)
  return gateTargets(info, base, e.targets, host)
}

// Lỗi bất ngờ ở bước phân tích lệnh (không phải ở bước kiểm dấu, đã tự chặn trong gateTargets) ⇒ ghi log rồi cho qua như các cổng git khác.
const gateEntrySafe = (g, host) => safelyAsync(`gateEntry ${g.sub}`, () => gateEntry(g, host))

// ---------- thư viện mới khi commit (AC-38) ----------

const MANIFEST_NAMES = new Set(['package.json', 'go.mod'])

// git với biến môi trường riêng (index tạm); ném lỗi khi git lỗi/quá giờ.
function gitOrThrow(dir, args, env = process.env) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, maxBuffer: 1 << 26, timeout: 8000, windowsHide: true })
  if (r.error) throw new Error(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]}: ${(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`}`)
  return r.stdout
}

// Cây (tree) mà commit sắp tạo, để newPackages so với HEAD. Commit thường ⇒ ':' (index thật là đủ). `commit -a`, `commit <path>`,
// `--pathspec-from-file`, hoặc một `git add` đứng trước trong cùng lệnh (index lúc này chưa phản ánh commit) ⇒ dựng trên index TẠM:
// chép index thật rồi thêm các package.json/go.mod đã sửa (-a: chỉ file đã theo dõi; add/path: cả file mới). Không bao giờ đụng index thật.
// Chọn thừa còn hơn sót: commit <path> (--only) được tính như index + path.
function commitTreeForDeps(info, c, sawAdd) {
  const byPaths = !sawAdd && !c.all && !c.fromFile && c.paths.length > 0
  if (!sawAdd && !c.all && !c.fromFile && !byPaths) return ':'
  const cwd = byPaths ? info.dir : info.toplevel // pathspec của người dùng tính từ cwd; phần còn lại là cả repo
  const specs = byPaths ? c.paths : [':(glob)**/package.json', ':(glob)**/go.mod']
  const withNew = sawAdd || c.fromFile || byPaths
  const listed = gitOrThrow(cwd, ['ls-files', '-z', '-m', ...(withNew ? ['-o', '--exclude-standard'] : []), '--', ...specs])
  const files = [...new Set(listed.split('\0').filter((f) => f && MANIFEST_NAMES.has(path.posix.basename(f)) && !/(^|\/)(node_modules|vendor)\//.test(f)))]
  // .claude/flow.json (allowlist thư viện nguồn ngoài) chỉ lấy bản trên đĩa khi CHÍNH commit này lấy bản đó: `-a`, hoặc liệt kê path/thư mục chứa nó
  // (file phải đã theo dõi). `git add` đứng trước thì không đoán được nó add gì ⇒ bản chưa stage không được tin: phải `git add` flow.json từ lệnh trước.
  if (c.all || byPaths) {
    const flow = path.join(info.toplevel, '.claude', 'flow.json')
    const l = gitOrThrow(cwd, ['ls-files', '-z', '-m', '--', ...(byPaths ? c.paths : ['.claude/flow.json'])])
    files.push(...l.split('\0').filter((f) => f && norm(path.resolve(cwd, f)) === norm(flow)))
  }
  if (files.length === 0) return ':' // không manifest/flow.json nào đổi ngoài index ⇒ index thật đã đủ
  const idx = path.resolve(info.dir, gitOrThrow(info.dir, ['rev-parse', '--git-path', 'index']).trim())
  const tmp = path.join(os.tmpdir(), `flow-gate-index-${process.pid}-${Date.now().toString(36)}`)
  try {
    if (fs.existsSync(idx)) fs.copyFileSync(idx, tmp)
    const env = { ...process.env, GIT_INDEX_FILE: tmp }
    gitOrThrow(cwd, ['--literal-pathspecs', 'add', '--', ...files], env)
    return gitOrThrow(cwd, ['write-tree'], env).trim()
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// Kiểm các package trong tổng thời gian ngân sách (vet song song, quá hạn ⇒ phần chưa xong là unknown). Ngân sách mặc định DEPS_BUDGET_MS;
// FLOW_GATE_DEPS_MS (ms) đổi được, dùng cho test. vetAll không bao giờ ném.
async function vetBudgeted(deps, pkgs, trustedSources = []) {
  const budget = Number(process.env.FLOW_GATE_DEPS_MS) > 0 ? Number(process.env.FLOW_GATE_DEPS_MS) : DEPS_BUDGET_MS
  const ctl = new AbortController()
  const timers = []
  const later = (ms, fn) => timers.push(setTimeout(fn, ms))
  later(budget, () => ctl.abort())
  const fetchFn = (url, init = {}) => fetch(url, {
    ...init, signal: init.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([init.signal, ctl.signal]) : (init.signal ?? ctl.signal),
  })
  const hardStop = new Promise((resolve) => later(budget + 1500, () => resolve(null)))
  try {
    const res = await Promise.race([deps.vetAll(pkgs, { fetch: fetchFn, concurrency: 8, timeoutMs: 5000, trustedSources }), hardStop])
    if (res) {
      if (ctl.signal.aborted) log(`deps: hết giờ kiểm (${budget} ms), phần chưa xong tính là chưa kiểm được`)
      return res
    }
    log(`deps: hết giờ kiểm (${budget} ms)`)
    // gói nguồn git/URL không cần mạng để biết kết quả (bad, hoặc ok nếu đã duyệt) ⇒ không để một gói chậm làm chúng thành unknown
    return Promise.all(pkgs.map((p) => p.source ? deps.vet(p, { trustedSources }) : { ...p, status: 'unknown', problems: [], unknown: [`hết giờ kiểm (${budget} ms)`] }))
  } finally {
    for (const t of timers) clearTimeout(t)
  }
}

const pkgLabel = (p) => `${p.eco} ${p.name}${p.version && !p.source ? `@${p.version}` : ''}`

// Package nguồn git/URL mà user đã duyệt: .claude/flow.json {"trustedDepSources": ["tên@nguồn", …]} (vd "pkg@git+https://host/pkg.git#<sha>"; diff hiện ra khi review).
// Đọc từ bản SẮP COMMIT, không đọc đĩa (AI tự ghi file trên đĩa mà không git add thì không có hiệu lực): tree = ':' (index) hoặc cây của index tạm
// (commitTreeForDeps, đã cộng flow.json khi `commit -a` / `commit <path>`). Thiếu/hỏng/sai kiểu ⇒ không tin ai.
function trustedDepSources(info, tree) {
  const text = git(info.toplevel, ['cat-file', 'blob', tree === ':' ? ':.claude/flow.json' : `${tree}:.claude/flow.json`])
  if (text === null) return [] // commit này không có flow.json
  try {
    const list = JSON.parse(text.replace(/^﻿/, ''))?.trustedDepSources
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : []
  } catch (e) {
    log(`flow.json (bản sắp commit): ${e.message}`)
    return []
  }
}

// g = parseGitSub của `git commit`. Phần sắp commit có thư viện MỚI (package.json / go.mod) ⇒ kiểm có thật, đủ tuổi, không giả tên, không lỗ hổng.
// bad (gồm nguồn git/URL chưa được duyệt) ⇒ deny. unknown (mạng lỗi/quá giờ) ⇒ KHÔNG chặn nhưng trả additionalContext liệt kê gói chưa kiểm được
// để AI báo user (không im lặng) + log. newPackages ném (manifest hỏng, mốc git đọc không được) ⇒ deny kèm lý do.
async function gateDeps(g, sawAdd) {
  const info = repoInfo(g.dir)
  if (!info) return null
  const c = parseCommitFlags(g.rest)
  if (c.dryRun) return null
  const deps = await import('./lib/deps.mjs')
  let tree = ':'
  try {
    tree = commitTreeForDeps(info, c, sawAdd)
  } catch (e) {
    log(`commitTreeForDeps: ${e?.message ?? e} (kiểm bản đã stage)`)
  }
  let pkgs
  try {
    pkgs = deps.newPackages(revOf(info, 'HEAD') ? 'HEAD' : null, tree, info.dir)
  } catch (e) {
    const why = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300)
    log(`newPackages: ${why}`)
    return permission('deny',
      'Chưa kiểm tra được các thư viện mới trong phần sắp lưu nên dừng lại cho an toàn; AI sẽ sửa lỗi rồi thử lại, hoặc báo bạn nếu không tự sửa được. ' +
      `Không đọc được package.json / go.mod để so với bản trước: ${why}. Kiểm bằng node ~/.claude/hooks/deps-check.mjs --list.`)
  }
  if (pkgs.length === 0) return null
  const results = await vetBudgeted(deps, pkgs, trustedDepSources(info, tree))
  for (const r of results) {
    if (r.status === 'unknown') log(`deps unknown ${r.eco}:${r.name} — ${r.unknown.join('; ')}`)
  }
  const bad = results.filter((r) => r.status === 'bad')
  if (bad.length > 0) {
    const shown = bad.slice(0, 8).map((r) => `${pkgLabel(r)} — ${r.problems.join('; ')}`).join(' | ') + (bad.length > 8 ? ` | …và ${bad.length - 8} thư viện nữa` : '')
    return permission('deny',
      'Thư viện mới vừa thêm có dấu hiệu không an toàn nên chưa lưu; AI sẽ bỏ hoặc thay thư viện đó rồi lưu lại. ' +
      `Thư viện mới trong phần sắp commit có vấn đề: ${shown}. Kiểm lại tên có đúng không (AI hay bịa hoặc gõ nhầm tên), chọn bản đủ tuổi và không có lỗ hổng ` +
      '(kiểm lại bằng node ~/.claude/hooks/deps-check.mjs --vet npm:<tên>); không đưa lệnh terminal cho user chạy.' +
      (bad.some((r) => r.source)
        ? ' Thư viện nguồn git/URL mà user đã duyệt thì ghi từng mục "tên@nguồn" (nguồn y hệt trong package.json) vào "trustedDepSources" trong .claude/flow.json, ' +
          `rồi git add .claude/flow.json bằng một lệnh riêng trước lệnh commit — chỉ bản sắp commit mới được tính (diff hiện ra khi review). Mục cần ghi: ${
            bad.filter((r) => r.source).slice(0, 3).map((r) => JSON.stringify(`${r.name}@${r.version}`)).join(', ')}.`
        : ''))
  }
  const unknown = results.filter((r) => r.status === 'unknown')
  if (unknown.length === 0) return null
  const names = unknown.slice(0, 8).map(pkgLabel).join(', ') + (unknown.length > 8 ? `, …và ${unknown.length - 8} thư viện nữa` : '')
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Chưa kiểm được độ an toàn của thư viện mới (mạng lỗi hoặc quá giờ): ${names}. Lệnh commit vẫn chạy. ` +
        'Hãy báo user MỘT dòng: các thư viện này chưa được kiểm tra, bạn xem lại trước khi dùng; kiểm lại khi có mạng bằng node ~/.claude/hooks/deps-check.mjs --vet npm:<tên>.',
    },
  }
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

async function safelyAsync(name, fn) {
  try {
    return await fn()
  } catch (e) {
    log(`${name}: ${e?.stack ?? e}`)
    return null
  }
}

const GIT_WORDS = /merge|commit|push|pull|fetch|rebase|cherry-pick|update-ref|switch|reset|branch|checkout|restore|clean/
const APPLY_PATCH_WORD = /\bapply_patch\b/ // Codex/Devin sửa file bằng `apply_patch <<'EOF' … EOF`, `cat <<EOF | apply_patch`, bash -c "…" … qua shell
const APPLY_PATCH_TOKEN = /(^|[\\/])apply_patch(\.\w+)?$/
const PATCH_WRAPPERS = new Set(['command', 'env', 'exec', 'sudo', 'doas', 'time', 'nice', 'nohup', 'builtin', 'xargs', 'stdbuf', 'timeout', 'setsid', 'ionice', 'then', 'do', 'else', 'elif'])
const SHELL_RUNNERS = /^(?:(?:ba|z|da|k|c|fi)?sh|eval|pwsh|powershell|cmd)$/i
const baseCmd = (t) => path.posix.basename(t.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '').replace(/^`+/, '')

// Đoạn lệnh (toks, đã bỏ nháy) có GỌI apply_patch không? 'direct' = apply_patch đứng ở vị trí lệnh (sau các phép gán VAR=, và nếu có thì sau từ bọc
// command/env/exec/sudo/time/xargs/… cùng cờ + đối số của chúng); 'nested' = nằm trong chuỗi mà shell con sẽ chạy (bash -c "…", eval "…");
// null = chỉ nhắc tên (echo apply_patch, grep apply_patch f, command -v apply_patch, git commit -m "…apply_patch…").
function patchInvocation(toks) {
  let k = 0
  while (/^[A-Za-z_]\w*=/.test(toks[k] ?? '')) k++
  const first = toks[k]
  if (first === undefined) return null
  if (APPLY_PATCH_TOKEN.test(first.replace(/^`+/, ''))) return 'direct'
  const name = baseCmd(first)
  if (PATCH_WRAPPERS.has(name)) {
    if (name === 'command' && /^-[vV]/.test(toks[k + 1] ?? '')) return null // command -v apply_patch chỉ hỏi có cài không
    const rest = toks.slice(k + 1)
    if (rest.some((t) => APPLY_PATCH_TOKEN.test(t.replace(/^`+/, '')))) return 'direct'
    const sh = rest.findIndex((t) => SHELL_RUNNERS.test(baseCmd(t))) // sudo bash -c "… apply_patch …"
    return sh >= 0 && rest.slice(sh + 1).some((t) => APPLY_PATCH_WORD.test(t)) ? 'nested' : null
  }
  if (SHELL_RUNNERS.test(name) && toks.slice(k + 1).some((t) => APPLY_PATCH_WORD.test(t))) return 'nested'
  return null
}

// Đoạn lệnh có thể chạy apply_patch mà patchInvocation không nhận ra: tên lệnh lấy từ biến/$(…)/`…`, hoặc lệnh khác (alias, find -exec, xargs…) mang
// chữ apply_patch làm đối số. Lệnh chỉ nhắc tên (echo, grep, which, git…) thì không tính.
const MENTION_ONLY = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'which', 'type', 'command', 'git', 'man', 'cat', 'less', 'head', 'tail', 'wc', 'ls'])
function hiddenPatchCall(toks) {
  let k = 0
  while (/^[A-Za-z_]\w*=/.test(toks[k] ?? '')) k++
  const first = toks[k]
  if (first === undefined) return false
  if (/^["'`]*[$`]/.test(first)) return true
  return !MENTION_ONLY.has(baseCmd(first)) && toks.slice(k + 1).some((t) => APPLY_PATCH_WORD.test(t))
}

// Lệnh con (bash -c "…", eval "…", sudo bash -c "…") có tự đổi thư mục (cd/pushd/popd, kể cả sau builtin/command) ở tầng nào không? strs = token của
// lệnh ngoài, mỗi token coi như một đoạn script. Cổng chỉ biết cwd của shell ngoài, nên lệnh con tự cd rồi apply_patch với đường dẫn tương đối là mù.
// Lồng quá sâu thì coi như có (không đọc nổi).
function innerCd(strs, depth = 0) {
  if (depth > 4) return true
  for (const s of strs) {
    for (const seg of tokenize(s)) {
      let k = 0
      while (/^[A-Za-z_]\w*=/.test(seg[k] ?? '')) k++
      if (/^(builtin|command)$/.test(seg[k] ?? '')) k++
      if (/^(cd|pushd|popd)$/.test(seg[k] ?? '')) return true
      for (const t of seg) if (t !== s && /[\s;&|()<>]/.test(t) && innerCd([t], depth + 1)) return true
    }
  }
  return false
}

// Gọi apply_patch: đọc được file từ lệnh (patchFiles) ⇒ kiểm từng file tại các thư mục `states` ([{cwd, known}]); không đọc được file nào
// (patch đến từ file, biến, printf, $(…)) ⇒ không biết file nào sẽ bị sửa ⇒ deny.
function denyPatchUse(patch, states, host) {
  if (patch.length === 0) {
    return permission('deny',
      'Không xác định được file sẽ bị sửa nên chưa chạy; AI sẽ ghi nội dung sửa ngay trong lệnh rồi chạy lại. ' +
      'apply_patch được gọi nhưng lệnh không có dòng *** Add File / Update File / Delete File nào để cổng kiểm (nội dung patch đến từ file, biến hoặc lệnh khác). ' +
      'Dùng apply_patch <<\'EOF\' … EOF với patch viết thẳng trong lệnh.')
  }
  for (const s of states) {
    const out = denyPatchTargets(patch, s.cwd, s.known, host)
    if (out) return out
  }
  return null
}

// Kiểm các file trong heredoc patch như hookEdit, tại thư mục `cwd`. known=false (đứng sau cd tới chỗ không tính ra được) thì đường dẫn
// tương đối không có nghĩa ⇒ deny; đường dẫn tuyệt đối vẫn xét như thường.
function denyPatchTargets(patch, cwd, known, host) {
  const isAbs = (p) => path.isAbsolute(toNative(p))
  const out = denyDirectEdit(known ? patch : patch.filter(isAbs), cwd, host)
  const rel = patch.filter((p) => !isAbs(p))
  if (out || known || rel.length === 0) return out
  return permission('deny',
    'Chưa rõ lệnh này sửa file ở thư mục nào nên chưa chạy; AI sẽ ghi đường dẫn đầy đủ của từng file rồi chạy lại. ' +
    `apply_patch đứng sau lệnh cd tới chỗ không tính ra được (biến, ~, -, $(…)) nên không biết đường dẫn tương đối ${rel.join(', ')} trỏ vào đâu. ` +
    'Dùng đường dẫn tuyệt đối trong patch, hoặc cd tới đường dẫn cụ thể.')
}

// AC-42: quét thư mục bằng `grep -r`/`grep -R`/`--recursive` hoặc `find <dir> … -name` ⇒ nhắc MỘT dòng dùng Grep/rg.
// Chỉ nhắc (additionalContext, không permissionDecision) — có chỗ vẫn cần grep (đọc pipe, một file).
const SLOW_SEARCH = /(?:^|[;&|(]\s*)(?:grep\s+(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)\b|find\s+\S+[^;&|]*\s-i?(?:name|path)\s)/
const SEARCH_NUDGE = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext: 'Tìm trong thư mục nên dùng công cụ Grep có sẵn hoặc `rg` (nhanh hơn nhiều, đỡ CPU khi nhiều worker chạy); ' +
      'thư mục bị git bỏ qua (worktree trong .claude/worktrees, thư mục nội bộ) thì thêm `-uu` kẻo tìm sót.',
  },
}

// Ghi NỘI DUNG file qua lệnh shell (heredoc/echo/printf vào file, sed chèn nhiều dòng, node/python -e ghi file) ⇒ chặn,
// chỉ AI dùng công cụ sửa file. Lý do: bộ lọc an toàn của app đọc cả nội dung trong lệnh — chữ như "push --force" trong
// fixture test làm bật hộp hỏi user dù lệnh chỉ ghi file (dính 3 lần 2026-10-11). Hook chạy TRƯỚC hộp hỏi nên chặn ở đây
// thì user không phải bấm. Không chặn: ghi kết quả lệnh ra file (`cmd > out.txt`), /dev/null, heredoc đưa vào lệnh khác
// (`git commit -F - <<EOF`, `cat <<EOF | apply_patch`).
const FILE_REDIRECT = /(?<![0-9&<>])>>?\s*(?!\s*(?:\/dev\/null|&\d))["']?[^\s;&|"'<>]+/
function contentWriteDeny(cmd, host) {
  const lines = cmd.split(/\r?\n/)
  const heredocToFile = lines.some((l) => /<<-?\s*["']?[A-Za-z_][\w-]*["']?/.test(l) && (FILE_REDIRECT.test(l.replace(/<<-?\s*["']?[A-Za-z_][\w-]*["']?/, '')) || /\btee\s+(?:-a\s+)?["']?[^\s|;&-]/.test(l)))
  const echoToFile = cmd.split(/[;&|]+|\r?\n/).some((seg) => /^\s*(?:echo|printf)\b/.test(seg) && FILE_REDIRECT.test(seg))
  const sedMultiline = /\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b[^\n]*\\n/.test(cmd)
  const scriptWrite = /\b(?:node\s+(?:(?:-e|-p|--eval|--input-type=\S+\s+-e)\b|-(?=\s|$))|python3?\s+-c\b)/.test(cmd) && /\b(?:writeFileSync|appendFileSync|writeFile\(|open\([^)]*['"][wa]['"])/.test(cmd)
  if (!heredocToFile && !echoToFile && !sedMultiline && !scriptWrite) return null
  const tool = host === 'codex' ? 'apply_patch' : 'công cụ Write/Edit'
  return permission('deny',
    'Nội dung file nên ghi bằng công cụ sửa file thay vì gõ qua dòng lệnh, để bạn không phải bấm duyệt; AI sẽ ghi lại đúng cách. ' +
    `Dùng ${tool}. Ghi qua lệnh (heredoc/echo/printf vào file, sed chèn nhiều dòng, node/python -e ghi file) làm bộ lọc an ` +
    'toàn bật hộp hỏi user mỗi khi nội dung có chữ giống lệnh nguy hiểm. Ghi kết quả lệnh ra file (`lệnh > out.txt`) vẫn được.')
}

// Xoá cả thư mục (rm -r/-rf, Remove-Item -Recurse, rmdir|rd /s), kể cả trong bash -c / eval / powershell -c / cmd /c ⇒ chặn: bộ lọc an toàn của app bật
// hộp hỏi user cho mỗi lệnh như vậy. Dọn chỗ chạy test thì tạo thư mục mới; thật sự cần xoá thì hỏi user.
const CMD_WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'env', 'time', 'nice', 'nohup'])
function deletesDir(toks, depth = 0) {
  if (depth > 4) return false
  let k = 0
  while (k < toks.length && (/^[A-Za-z_]\w*=/.test(toks[k]) || CMD_WRAPPERS.has(baseCmd(toks[k])))) k++
  if (k >= toks.length) return false
  const name = baseCmd(toks[k]).toLowerCase()
  const rest = toks.slice(k + 1)
  if (name === 'rm') return rest.some((t) => /^-[a-zA-Z]*[rR]/.test(t) || t === '--recursive')
  if (/^(remove-item|ri|del|erase)$/.test(name)) return rest.some((t) => /^-r(ecurse)?$/i.test(t))
  if (/^(rmdir|rd)$/.test(name)) return rest.some((t) => /^\/s$/i.test(t) || /^-r(ecurse)?$/i.test(t))
  if (SHELL_RUNNERS.test(name)) {
    const inner = rest.filter((t, i) => i >= rest.findIndex((x) => !/^[-/]/.test(x))).join(' ')
    return tokenize(inner).some((t) => deletesDir(t, depth + 1))
  }
  return false
}
const DIR_DELETE_DENY = permission('deny',
  'Xoá hẳn cả một thư mục thì không lấy lại được nên AI không chạy lệnh này; AI sẽ dọn bằng cách an toàn thay thế. ' +
  'Lệnh xoá đệ quy (rm -r/-rf, Remove-Item -Recurse, rmdir /s) bị chặn. Dọn worktree (bản sao trong .claude/worktrees) ⇒ ' +
  '`git -c core.longpaths=true worktree remove --force "<đường dẫn>"` rồi `git worktree prune`. Cần chỗ trống để chạy test/build ⇒ tạo thư mục ' +
  'mới (tên khác, vd thêm hậu tố thời gian) trong scratchpad hoặc thư mục tạm. Thật sự phải bỏ thư mục khác ⇒ chuyển vào Thùng rác (lấy lại được) bằng PowerShell ' +
  '`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory("<đường dẫn>", "OnlyErrorDialogs", "SendToRecycleBin")`. ' +
  'Không bật hộp hỏi, không đưa lệnh terminal cho user chạy.')

async function hookBash(input) {
  const n = normalize(input, process.env)
  const cmd = n.command ?? input.tool_input?.command
  if (typeof cmd !== 'string') return null
  const cw = contentWriteDeny(cmd, n.host)
  if (cw) return cw
  if (safely('dirDelete', () => tokenize(cmd).some((t) => deletesDir(t)))) return DIR_DELETE_DENY
  const nudge = SLOW_SEARCH.test(cmd) ? SEARCH_NUDGE : null
  const mentionsPatch = APPLY_PATCH_WORD.test(cmd)
  // Nội dung patch nằm ngay trong lệnh (dòng *** Add/Update/Delete File:) ⇒ LUÔN kiểm file, không phụ thuộc nhận ra cách gọi apply_patch
  // (`p=apply_patch; $p`, alias, find -exec, ghép tên…).
  const patch = patchFiles(cmd)
  if (!mentionsPatch && patch.length === 0 && !GIT_WORDS.test(cmd)) return nudge
  let cwd = path.resolve(toNative(n.cwd))
  let note = null // lời nhắc không chặn (vd thư viện mới chưa kiểm được); trả khi không có deny
  let sawAdd = false // đã có `git add` đứng trước trong cùng lệnh: index lúc này chưa phản ánh commit sắp tạo
  let cwdKnown = true // false sau một cd/pushd/popd tới chỗ không tính ra được (biến, ~, -, $(…), cd trần)
  const dirs = [{ cwd, known: true }] // các thư mục lệnh đi qua, để kiểm patch khi apply_patch nằm trong chuỗi (bash -c "…") không biết chạy ở đâu
  let patchCalls = 0 // số lời gọi apply_patch nhận ra được (đã kiểm theo chỗ gọi)
  // cùng lệnh có sửa cấu hình remote/push (đổi được cách `git push` phía sau chạy) — xem gatePushSyntax
  const cfgEdit = safely('cfgEdit', () => tokenize(cmd).some((t) => {
    const c = parseGitSub(t, cwd)
    return (c?.sub === 'config' && c.rest.some((x) => /^(remote|push|branch|alias|include|includeif)\./i.test(x))) ||
      (c?.sub === 'remote' && c.rest.some((x) => x.startsWith('--mirror')))
  })) ?? true
  for (const toks of tokenize(cmd)) {
    if (/^(cd|pushd|popd)$/.test(toks[0] ?? '')) {
      const to = toks[0] === 'popd' ? null : toks[1]
      if (to && !/^[-~$]/.test(to)) { cwd = path.resolve(cwd, toNative(to)); cwdKnown = !/[$`]/.test(to) } else cwdKnown = false
      dirs.push({ cwd, known: cwdKnown })
      continue
    }
    // gọi apply_patch dưới BẤT KỲ dạng nào (heredoc, pipe, command/env/exec/sudo …, bash -c "…") ⇒ kiểm file trong patch; không đọc được file nào ⇒ deny
    const use = mentionsPatch ? patchInvocation(toks) : null
    if (use) {
      patchCalls++
      // lệnh con không cho biết nó cd đi đâu: có cd/pushd bên trong ⇒ coi như thư mục không xác định (đường dẫn tương đối ⇒ deny, tuyệt đối xét như thường)
      const states = use !== 'nested' ? [{ cwd, known: cwdKnown }] : innerCd(toks.slice(1)) ? dirs.map((d) => ({ cwd: d.cwd, known: false })) : dirs
      const out = safely('denyDirectEdit', () => denyPatchUse(patch, states, n.host))
      if (out) return out
    }
    const wrapped = safely('gateWrappedPush', () => gateWrappedPush(toks))
    if (wrapped) return wrapped
    const g = parseGitSub(toks, cwd)
    if (!g) continue
    let out = null
    if (g.sub === 'add') {
      sawAdd = true
    } else if (g.sub === 'merge') {
      const m = parseGitMerge(g)
      if (m) out = await gateMerge(m, n.host)
    } else if (g.sub === 'commit') {
      out = safely(`gateSecrets ${g.sub}`, () => gateSecrets(g)) ?? await safelyAsync('gateDeps', () => gateDeps(g, sawAdd))
    } else if (g.sub === 'push') {
      // push thường lên nhánh chính: cho qua, không hỏi [chốt 2026-10-14]; `git push . x:main` (đưa nhánh vào main trong repo này) qua cổng gộp
      out = safely(`gateSecrets ${g.sub}`, () => gateSecrets(g)) ??
        safely('gatePushSyntax', () => gatePushSyntax(toks, g, cfgEdit)) ??
        safely('gateForcePush', () => gateForcePush(g)) ??
        safely('gateDeleteMainPush', () => gateDeleteMainPush(g)) ??
        await gateEntrySafe(g, n.host)
    } else if (DESTRUCTIVE_SUBS.has(g.sub)) {
      out = safely(`gateDestructive ${g.sub}`, () => gateDestructive(g))
    }
    if (!out && ENTRY_SUBS.has(g.sub)) out = await gateEntrySafe(g, n.host)
    if (out && !out.hookSpecificOutput?.permissionDecision) note ??= out // chỉ nhắc (additionalContext): không cắt ngang các cổng sau
    else if (out) return out
  }
  // Có nội dung patch mà số lời gọi nhận ra được ít hơn số khối patch (gồm trường hợp không nhận ra lời gọi nào: biến, alias, find -exec…) ⇒ không biết patch
  // chạy ở đâu ⇒ kiểm file tại MỌI thư mục lệnh đi qua (đường dẫn tương đối tính theo từng chỗ; cd không xác định ⇒ deny như thường).
  // Không có nội dung patch, không nhận ra lời gọi nào, nhưng apply_patch có thể vẫn chạy (`$p < x.patch`, alias, find -exec, xargs) ⇒ không biết file nào sẽ sửa ⇒ deny.
  if (mentionsPatch && patch.length === 0 && patchCalls === 0 && tokenize(cmd).some(hiddenPatchCall)) return denyPatchUse([], [], n.host)
  const patchBlocks = (cmd.match(/^[ \t]*\*\*\* Begin Patch\b/gm) ?? []).length
  if (patch.length > 0 && patchCalls < Math.max(1, patchBlocks)) {
    const out = safely('denyDirectEdit', () => denyPatchUse(patch, dirs, n.host))
    if (out) return out
  }
  if (note && nudge) { // hai lời nhắc: gộp thành một đầu ra
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `${note.hookSpecificOutput.additionalContext}\n${nudge.hookSpecificOutput.additionalContext}` } }
  }
  return note ?? nudge
}

// Sổ tiến độ (docs/specs/*/progress.md) có mục `Làn:` còn dòng "- [ ]" ⇒ vẫn đang thi công dở. Mục Làn: là các dòng danh sách (hoặc thụt lề)
// ngay dưới dòng `Làn:`; gặp dòng không phải danh sách (vd `Ghi chú:`) là hết mục.
function hasOpenLane(text) {
  const lines = String(text).normalize('NFC').split(/\r?\n/)
  const start = lines.findIndex((l) => /^[ \t>*_#-]*Làn(?:[ \t]*\([^)\n]*\))?[ \t*_]*[:：]/u.test(l)) // "Làn:" hoặc "Làn (ghi chú):"
  if (start < 0) return false
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') continue
    if (/^[ \t]*[-*+][ \t]+\[ \]/.test(l)) return true
    if (!/^[ \t]*[-*+][ \t]/.test(l) && !/^[ \t]+\S/.test(l)) break
  }
  return false
}

// Nhánh hiện tại có sổ tiến độ CHƯA xong (openProgress của lib so-chot: sổ ghi đúng nhánh này) mà mục Làn: còn "- [ ]"? Lỗi đọc ⇒ false (nhắc như cũ).
async function lanesStillOpen(info) {
  if (!info.branch || info.branch === 'HEAD') return false
  try {
    const hit = await openProgressOf(info, info.branch)
    if (!hit || fs.statSync(hit.file).size > 1024 * 1024) return false
    return hasOpenLane(fs.readFileSync(hit.file, 'utf8'))
  } catch (e) {
    log(`lanesStillOpen: ${e?.message ?? e}`)
    return false
  }
}

// Đánh dấu "stamp test đang chạy" của diff có patch-id `pid`: gatesDir/running-test-<pid>.json {pid: tiến trình stamp, ts: giờ bắt đầu, patchId}.
// `stamp test` ghi lúc bắt đầu, xoá khi xong (finally); hookStop dựa vào đó để không đòi dấu trong lúc AI đang chờ chính lệnh ấy chạy nền.
const RUNNING_MARK_MAX_MS = 2 * 60 * 60 * 1000 // quá 2 giờ ⇒ coi là bỏ dở (tránh trùng pid tiến trình cũ)
const runningMarkFile = (info, pid) => path.join(info.gatesDir, `running-test-${pid}.json`)

// `stamp test` của diff này còn đang chạy? Đánh dấu cũ (tiến trình chết, quá hạn, hỏng) ⇒ xoá và coi như không chạy.
function stampTestRunning(info, pid) {
  const file = runningMarkFile(info, pid)
  let alive = false
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Number.isInteger(m?.pid) && m.pid > 0 && Date.now() - Date.parse(m.ts) < RUNNING_MARK_MAX_MS) {
      try {
        process.kill(m.pid, 0) // tín hiệu 0 = chỉ hỏi tiến trình còn không
        alive = true
      } catch (e) {
        alive = e?.code === 'EPERM' // còn sống nhưng của user khác; ESRCH = đã chết
      }
    }
  } catch (e) {
    if (e?.code === 'ENOENT') return false
    log(`stampTestRunning: ${e?.message ?? e}`) // đọc hỏng ⇒ coi là đánh dấu cũ
  }
  if (!alive) {
    try { fs.rmSync(file, { force: true }) } catch (e) { log(`stampTestRunning rm: ${e?.message ?? e}`) }
  }
  return alive
}

async function hookStop(input) {
  if (input.stop_hook_active) return null
  const info = repoInfo(input.cwd || process.cwd())
  if (!info || !info.linked) return null
  const base = mainBranch(info)
  if (!info.branch || info.branch === base) return null
  const status = git(info.dir, ['status', '--porcelain'])
  if (status === null || status.trim() !== '') return null
  const st = await tryGateState(info, base, 'HEAD')
  if (!st || st.missing.length === 0) return null
  if (stampTestRunning(info, st.pid)) return null // AI đang chờ `stamp test` chạy nền: chưa tới lúc đòi dấu, khỏi thức một lượt vô ích
  if (await lanesStillOpen(info)) return null // đang thi công dở (còn làn "- [ ]"): chưa tới lúc đòi dấu review/qa/test
  const nudged = path.join(info.gatesDir, `nudged-${st.pid}`)
  if (fs.existsSync(nudged)) return null
  fs.mkdirSync(info.gatesDir, { recursive: true })
  fs.writeFileSync(nudged, new Date().toISOString())
  return {
    decision: 'block',
    reason: 'Việc đã lưu xong nhưng chưa qua các bước kiểm tra cuối nên AI sẽ chạy nốt chúng trước khi báo bạn. ' +
      `${info.branch} đã commit xong nhưng thiếu: ${st.missing.join(', ')}. Chạy skill flow-qa / flow-review trước khi báo user.` +
      (st.pMissing.length > 0 ? ` Báo cáo QA còn thiếu dòng "${P_LINE_FORMAT}" cho ${st.pMissing.join(', ')}.` : '') +
      (st.pUnreadable.length > 0 ? ` Chưa đóng dấu QA được vì ${unreadableNote(st.pUnreadable)}.` : '') +
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

// Đường dẫn thật, kể cả khi chính nó chưa tồn tại: realpath của thư mục tồn tại gần nhất + phần còn lại (so sánh với toplevel của git, vốn là realpath).
function realish(p) {
  const abs = path.resolve(p)
  const d = existingDir(abs)
  if (!d) return abs
  try { return path.join(fs.realpathSync.native(d), path.relative(d, abs)) } catch { return abs }
}

// Tài liệu (docs/specs/…/PLAN.md) nằm ngoài git [o3e4] nên worktree mới tạo không có bản này: plan= trỏ vào worktree mà file không có ở đó
// ⇒ tìm cùng đường dẫn tương đối ở thư mục chính của repo. Có bản trong worktree, plan ngoài worktree, đang ở thư mục chính, hay vẫn không
// thấy ⇒ giữ nguyên plan (lane-check báo lỗi ⇒ block như AC-09).
function planFromMain(plan, info) {
  if (!info?.linked || fs.existsSync(plan) || path.basename(info.commonDir) !== '.git') return plan
  const rel = path.relative(realish(info.toplevel), realish(plan))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return plan
  const alt = path.join(path.dirname(info.commonDir), rel)
  return fs.existsSync(alt) ? alt : plan
}

// Worker coder nộp bài: brief (tin nhắn user đầu trong transcript) có plan= và lane= ⇒ chạy lane-check audit trong cwd của worker.
// Phát hiện file ngoài scope (exit 1) ⇒ block. AC-09: lane-check không chạy được (exit 2/lỗi) ⇒ cũng block (không cho qua âm thầm); lặp vô hạn
// không xảy ra vì lượt sau stop_hook_active=true ⇒ cho qua. Brief không có plan=/lane= ⇒ không có gì để audit ⇒ cho qua.
function auditScope(input) {
  if (typeof input.agent_transcript_path !== 'string' || !input.agent_transcript_path) return null
  const brief = firstUserMessage(input.agent_transcript_path)
  if (!brief) return null
  const cwd = path.resolve(toNative(input.cwd || process.cwd()))
  // Bộ đọc brief dùng chung với flow-dispatch (lib/brief.mjs): nháy, đường dẫn có dấu cách, ~/, /c/…, tiền tố ngắn dần.
  const briefed = briefPlan(brief, cwd)
  const lane = briefWord(brief, 'lane')
  if (!briefed || !lane) return null
  const info = repoInfo(cwd)
  const plan = planFromMain(briefed, info)
  const base = briefWord(brief, 'base') ?? (info ? mainBranch(info) : 'main')
  // --repo = cwd của worker: plan thường nằm ngoài repo của worker (vd ~/.claude/plans), nên không suy repo từ đường dẫn plan.
  const args = [path.join(HOOK_DIR, 'lane-check.mjs'), 'audit', plan, lane, '--repo', cwd, '--worktree', cwd, '--branch', 'HEAD', '--base', base]
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true })
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    const full = r.error?.message ?? `exit ${r.status}: ${(r.stderr || r.stdout || '').trim()}`
    log(`lane-check audit lane ${lane}: ${full}`)
    const why = (r.error?.message ?? `lane-check thoát mã ${r.status}: ${(r.stderr || r.stdout || '').split(/\r?\n/).find((l) => l.trim()) ?? 'không có thông báo'}`).trim().slice(0, 300)
    return {
      decision: 'block',
      reason: 'Chưa kiểm được AI phụ có làm lố phần việc được giao hay không nên chưa nhận bài; AI sẽ chạy lại phần kiểm tra, hoặc báo lại cho người điều phối. ' +
        `Chi tiết: không kiểm được phạm vi làn ${lane} vì ${why}, chạy lại với --repo đúng hoặc báo captain.`,
    }
  }
  if (r.status === 0) return null
  const lines = r.stdout.split(/\r?\n/).filter(Boolean)
  const shown = lines.slice(0, 30).join('\n') + (lines.length > 30 ? `\n…và ${lines.length - 30} dòng nữa` : '')
  return {
    decision: 'block',
    reason: 'AI phụ đã sửa cả những file nằm ngoài phần việc được giao nên chưa nhận bài; AI sẽ gỡ phần ngoài phạm vi rồi nộp lại. ' +
      `Audit phạm vi làn ${lane} không đạt:\n${shown}\nHãy gỡ thay đổi ngoài scope, hoặc trả return=needs_context kèm tên file.`,
  }
}

async function hookSubagentStop(input) {
  if (input.stop_hook_active) return null
  // Vai đòi receipt / audit phạm vi lấy từ kit/roles.json (một nguồn với flow-dispatch, hostgen); registry hỏng ⇒ ném ⇒ cho qua + log.
  const { loadRoles, roleSet } = await import('./lib/models.mjs')
  const reg = loadRoles()
  if (!roleSet('receipt', reg).has(input.agent_type)) return null
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
        reason: 'Bản báo cáo của AI phụ chưa đúng mẫu nên chưa nhận bài; AI sẽ yêu cầu nộp lại cho đúng. ' +
          'Thiếu receipt: kết thúc bằng đúng một dòng return=…; paths=…; checks=…; blocker=…; stop',
      }
    }
  }
  if (!roleSet('audit', reg).has(input.agent_type) || receipt === 'needs_context' || receipt === 'blocked') return null
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
// Suốt lúc chạy có running-test-<pid>.json (xem stampTestRunning) để hook Stop không nhắc.
async function cliStampTest(tokens) {
  if (tokens.length === 0) return fail('Dùng: stamp test -- <lệnh test đủ bộ>')
  const { info, base, pid, err } = cliContext()
  if (err) return fail(err)
  if (!pid) return fail(`Diff ${base}...HEAD rỗng (chưa commit hoặc không khác ${base}) nên không có patch-id để đóng dấu.`)
  const cmd = commandLine(tokens)
  const stamp = path.join(info.gatesDir, `test-${pid}.json`)
  fs.mkdirSync(info.gatesDir, { recursive: true })
  // Đánh dấu "đang chạy" để hook Stop không đòi dấu trong lúc AI chờ lệnh này; xoá trong finally (đạt, hỏng hay lỗi đều xoá).
  // Bị giết cứng thì không kịp xoá ⇒ hookStop tự bỏ đánh dấu của tiến trình đã chết.
  const running = runningMarkFile(info, pid)
  fs.writeFileSync(running, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), patchId: pid }) + '\n')
  try {
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
    fs.writeFileSync(stamp, JSON.stringify({ cmd, ts: new Date().toISOString(), durationMs: Date.now() - started }) + '\n') // dấu xong rồi mới gỡ đánh dấu ⇒ hookStop không có lúc thấy cả hai đều trống
    console.log(pid)
  } finally {
    try {
      // Chỉ gỡ đánh dấu của chính mình (hai lần stamp cùng diff chạy song song thì lần sau đè lên, lần trước xong không được gỡ nhầm).
      if (JSON.parse(fs.readFileSync(running, 'utf8')).pid === process.pid) fs.rmSync(running, { force: true })
    } catch (e) {
      if (e?.code !== 'ENOENT') log(`stamp test: không gỡ được đánh dấu đang chạy: ${e?.message ?? e}`)
    }
  }
}

async function cliStamp(kind, file) {
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
    const ui = uiTouched(info, base, 'HEAD')
    if (NA_RE.test(text) && ui) return fail(`${file} ghi N/A nhưng diff có file UI; cần QA thật.`)
    if (ui && !uiApproved(text)) {
      return fail(`${file} thiếu dòng "User duyệt giao diện: có". Diff có file UI ⇒ trước khi đóng dấu QA, mở app/ảnh chụp cho user xem và hỏi ` +
        '"giao diện đã ổn chưa?" (AskUserQuestion); user gật thì ghi dòng đó vào báo cáo, chưa ưng thì sửa rồi hỏi lại.')
    }
    // SPEC đang mở của nhánh có mã quyền P-nn ⇒ mỗi mã một dòng bằng chứng (PLAN đợt 3 mục 5)
    const { codes: pReq, unreadable } = await requiredPCodes(info, base, 'HEAD')
    if (unreadable.length > 0) {
      return fail('Chưa đóng dấu QA được vì không đọc được SPEC để kiểm mã quyền nên AI sẽ dừng ở bước này và báo bạn, không đóng dấu khi chưa kiểm được. ' +
        `SPEC không đọc được: ${unreadable.join(', ')}. Kiểm file SPEC.md còn đó, mở được và nhỏ hơn 2 MB, sửa xong thì đóng dấu lại.`)
    }
    const pMissing = pEvidenceMissing(text, pReq)
    if (pMissing.length > 0) {
      return fail('Chưa đóng dấu QA được vì báo cáo chưa chứng minh mỗi quy tắc về ai được xem hay sửa dữ liệu nào của SPEC đều có test bắt lỗi; ' +
        'AI sẽ chạy lại các test đó với phần chặn quyền tắt rồi ghi bằng chứng cho từng mã. ' +
        `SPEC đang làm có ${pReq.length} mã quyền (${pReq.join(', ')}), ${file} còn thiếu dòng cho: ${pMissing.join(', ')}. ` +
        `Mỗi mã thiếu: tắt phần chặn quyền của mã đó trong worktree (không commit), chạy test của mã, thấy test ĐỎ, rồi ghi một dòng "${P_LINE_FORMAT}" ` +
        `(vd "${pMissing[0]}: đỏ khi tắt: có — tests/…") vào báo cáo; bật lại chặn quyền rồi đóng dấu lại.`)
    }
  }
  fs.mkdirSync(info.gatesDir, { recursive: true })
  fs.copyFileSync(path.resolve(file), path.join(info.gatesDir, kind === 'review' ? `review-${pid}.json` : `qa-${pid}.md`))
  console.log(pid)
}

async function cliStatus() {
  const { info, base, pid, err } = cliContext()
  if (err) return fail(err)
  let st = null
  try { st = pid ? await gateStateOf(info, base, 'HEAD') : null } catch (e) { return fail(`Không đọc được dấu: ${e.message}`) }
  console.log(`branch: ${info.branch ?? '?'} (base ${base}, ${info.linked ? 'worktree' : 'thư mục chính'})`)
  console.log(`pid: ${pid ?? '(diff rỗng)'}`)
  console.log(`uiTouched: ${st ? st.ui : false}`)
  console.log(`review: ${st?.hasReview ? 'có' : 'không'}`)
  console.log(`qa: ${st?.hasQa ? 'có' : st?.naOnUi ? 'không (N/A nhưng diff có UI)' : st?.pUnreadable?.length ? `không (${unreadableNote(st.pUnreadable)})` : st?.pMissing?.length ? `không (thiếu dòng "${P_LINE_FORMAT}" cho ${st.pMissing.join(', ')})` : 'không'}`)
  console.log(`test: ${st?.testExempt ? `không đòi (${st.testExempt})` : st?.hasTest ? 'có' : 'không'}`)
}

// ---------- main ----------

const HOOKS = { edit: hookEdit, bash: hookBash, stop: hookStop, 'subagent-stop': hookSubagentStop }
const [, , mode, arg1, arg2] = process.argv

if (HOOKS[mode]) {
  try {
    const out = await HOOKS[mode](JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch (e) {
    log(e?.stack ?? e)
  }
} else if (mode === 'stamp' && arg1 === 'test') {
  await cliStampTest(process.argv.slice(process.argv[4] === '--' ? 5 : 4))
} else if (mode === 'stamp') {
  await cliStamp(arg1, arg2)
} else if (mode === 'status') {
  await cliStatus()
} else {
  fail('Dùng: flow-gate.mjs edit|bash|stop|subagent-stop (hook) · stamp review <file.json> · stamp qa <file.md> · stamp test -- <lệnh> · status')
}
