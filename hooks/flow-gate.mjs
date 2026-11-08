// flow-gate: cổng review/qa/test cho flow captain + worker. Một script, chế độ chọn bằng argv[2].
//   hook : bash (PreToolUse Bash: chỉ CHẶN vài việc thật nguy hiểm — commit/push có secret, push ép/xoá nhánh chính, lệnh phá huỷ trên nhánh chính,
//          xoá cả thư mục; mọi thứ còn lại chỉ NHẮC AI (additionalContext): git merge vào nhánh chính thiếu dấu
//          review/qa/test, thư viện mới lạ/có lỗ hổng/không kiểm được, diff quá lớn không quét hết).
//          KHÔNG hộp hỏi (ask) nào [chốt 2026-10-14: user no code luôn bấm Allow]; push thường lên nhánh chính cho qua.
//          Mọi lời chặn có LỐI RA [chốt 2026-11-07: kit không bao giờ làm việc đứng lại]: user gật trong chat ⇒ AI chạy lại đúng lệnh với tiền tố
//          FLOW_OK=1 (PowerShell: $env:FLOW_OK=1;) ⇒ cho qua mọi cổng và ghi một dòng vào flow-approvals.log cạnh flow-gate.log (xem EXIT_LINE, hookBash)) ·
//          stop (Stop: nhắc MỘT lần khi thiếu dấu) · subagent-stop (SubagentStop: receipt + audit phạm vi làn)
//          Sửa file thẳng vào thư mục chính của repo KHÔNG bị chặn [chốt 2026-11-08, sổ chốt 8kxf6ad3: như AgentKit, dùng worktree chỉ là lời dặn trong skill
//          flow-worktree]. Chế độ `edit` của bản cũ vẫn được nhận và không làm gì, để hook chưa gỡ trong settings.json / hooks.json của user không lỗi (installer gỡ khi cài lại).
//   CLI  : stamp review <file.json> · stamp qa <file.md> · stamp test -- <lệnh…> · status      (chạy trong worktree)
// Spec: ~/.claude/plans/flow-v2-hooks-spec.md, flow-v3-hooks-spec.md (Làn A: quét secret), flow-v5-hooks-spec.md (Làn A: dấu test, lệnh phá huỷ, ask, audit);
//       flow v7: docs/specs/2026-10-11-flow-v7-nocode (làn D: AC-09 audit phạm vi làn, AC-24 lời chặn đời thường, AC-38 thư viện mới);
//       [chốt 2026-11-07] thu hẹp cổng: bỏ cổng nới luật/dòng tắt luật/đường khác vào nhánh chính/ghi file qua lệnh/cú pháp push lạ; còn lại nhắc hoặc có lối ra.
//       đợt 3: docs/specs/2026-10-12-flow-v7-dot3 PLAN mục 5 (dấu QA đòi mỗi mã P-nn của SPEC đang mở một dòng "đỏ khi tắt", AC-20).
// Nối các lib: lib/host.mjs (nhận diện app + chuẩn hoá payload) · lib/secrets.mjs (mẫu secret) · lib/models.mjs roleSet (vai từ kit/roles.json)
//   · lib/deps.mjs (thư viện mới khi commit) · lib/so-chot.mjs openProgress (sổ tiến độ của nhánh).
// Docs field input: https://code.claude.com/docs/en/hooks
// Lỗi nội bộ hoặc việc không kiểm được ở chế độ hook luôn CHO QUA (exit 0, không in gì) và ghi một dòng vào flow-gate.log — không có ca chủ ý chặn khi gate hỏng.
// Mọi lời chặn mở đầu bằng MỘT câu đời thường (bị chặn vì gì + AI sẽ tự làm gì) rồi mới tới chi tiết kỹ thuật (AC-24).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefPlan, briefWord } from './lib/brief.mjs'
import { normalize } from './lib/host.mjs'
import { ALLOW_MARK, isSensitiveFile, scanLine, scanPatch } from './lib/secrets.mjs'

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = process.env.FLOW_GATE_LOG || path.join(HOOK_DIR, 'flow-gate.log')
const APPROVAL_LOG = path.join(path.dirname(LOG_FILE), 'flow-approvals.log') // lệnh đã đi qua lối ra FLOW_OK=
const DEFAULT_UI = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/i
const DOC_FILE = /\.(md|mdx|txt)$/i // diff chỉ có file này (hoặc dưới docs/) ⇒ không đòi dấu test
const DEPS_BUDGET_MS = 8000 // tổng thời gian kiểm thư viện mới (hook bash có 15 s); quá hạn ⇒ unknown, không chặn
const RECEIPT_RE = /return=(done_with_concerns|done|needs_context|blocked|green|red)\b/ // green|red là của test-runner
const NA_RE = /^\uFEFF?\s*N\/A/i
// B\u00E1o c\u00E1o QA c\u1EE7a diff c\u00F3 UI ph\u1EA3i ghi user \u0111\u00E3 xem v\u00E0 g\u1EADt giao di\u1EC7n (AI d\u1EEBng h\u1ECFi "\u0111\u00E3 \u1ED5n ch\u01B0a?" tr\u01B0\u1EDBc khi review/g\u1ED9p).
// Sau l\u1EDDi g\u1EADt ch\u1EC9 \u0111\u01B0\u1EE3c h\u1EBFt d\u00F2ng ho\u1EB7c k\u00FD t\u1EF1 kh\u00F4ng ph\u1EA3i ch\u1EEF (vd "c\u00F3 (ng\u00E0y, xem g\u00EC)"); "c\u00F3 th\u1EC3\u2026", "ok kh\u00F4ng" kh\u00F4ng t\u00EDnh. So tr\u00EAn b\u1EA3n NFC.
const UI_OK_RE = /^[ \t>*_-]*User duy\u1EC7t giao di\u1EC7n[ \t*_]*[:\uFF1A][ \t*_]*(c\u00F3|r\u1ED3i|ok|\u0111\u1ED3ng \u00FD)(?![ \t]*[\p{L}\p{N}])/imu
// Sửa rất nhỏ (một nhãn, một màu) không dừng chờ [rofm]: AI ghi đã gửi ảnh trước/sau thay cho lời gật.
const UI_SMALL_RE = /^[ 	>*_-]*Sửa giao diện rất nhỏ[ 	*_]*[:：][ 	*_]*đã gửi ảnh/imu
const uiApproved = (text) => { const t = String(text).normalize('NFC'); return UI_OK_RE.test(t) || UI_SMALL_RE.test(t) }
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

// Lối ra FLOW_OK=: ghi giờ + 200 ký tự đầu của lệnh. Che secret TRƯỚC rồi mới cắt (secret vắt qua mốc cắt không lọt ra log).
function logApproval(cmd) {
  try {
    const masked = String(cmd).slice(0, 4000).split(/\r?\n/)
      .map((l) => scanLine(l).sort((a, b) => b.index - a.index).reduce((s, h) => `${s.slice(0, h.index)}***${s.slice(h.end)}`, l))
      .join(' | ')
    fs.appendFileSync(APPROVAL_LOG, `${new Date().toISOString()} ${masked.slice(0, 200)}\n`)
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

// g = parseGitSub của `git commit|push`. Trả deny (có secret), nhắc (diff vượt SCAN_LIMIT, không thấy secret nào trong phần đã quét) hoặc null.
// Không bao giờ đưa giá trị secret vào lý do (chỉ 4 ký tự đầu).
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
  if (lines.size === 0) { // chỉ vượt giới hạn quét, phần đã quét sạch ⇒ nhắc thôi, không chặn
    return remind(`Phần ${where} quá lớn (vượt ${SCAN_LIMIT / 1048576} MB) nên chỉ quét được phần đầu, chưa chắc không lộ mật khẩu hay khoá bí mật. Lệnh ${verb} vẫn chạy. ` +
      `Hãy báo user MỘT dòng: phần sau của thay đổi chưa được quét secret; lần sau chia thành các lần ${verb} nhỏ hơn.`)
  }
  const list = [...lines]
  const shown = list.slice(0, 10).join('; ') + (list.length > 10 ? `; …và ${list.length - 10} mục nữa` : '')
  const reason = [
    `Phần ${where} có thứ giống mật khẩu hoặc khoá bí mật nên đã dừng lại; AI sẽ gỡ nó ra khỏi thay đổi rồi thử lại.`,
    `Phát hiện secret trong phần sắp ${verb}: ${shown}. Gỡ secret khỏi thay đổi và dùng biến môi trường. ` +
    `Nếu báo nhầm thì thêm comment "${ALLOW_MARK}" vào dòng đó (file nhạy cảm: vào một dòng của file).`,
  ]
  if (truncated) reason.push(`Diff còn vượt ${SCAN_LIMIT / 1048576} MB nên chỉ quét phần đầu.`)
  return denyWithExit(reason.join(' '))
}

// ---------- lệnh phá huỷ trên nhánh chính / push ép ----------

const isMainName = (n) => n === 'main' || n === 'master'
const permission = (decision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } })
// Chỉ nhắc AI (không chặn): additionalContext.
const remind = (text) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })
// Lối ra của mọi lời chặn: hookBash thấy FLOW_OK= trong lệnh ⇒ cho qua + ghi flow-approvals.log.
const EXIT_LINE = 'Thật sự cần ⇒ kể user bằng lời đời thường (mất gì, lấy lại được không); user gật trong chat thì chạy lại đúng lệnh này với tiền tố FLOW_OK=1 ' +
  '(PowerShell: $env:FLOW_OK=1;), chỉ dùng một lần. Không đưa lệnh cho user chạy, không sửa kit.'
const denyWithExit = (reason) => permission('deny', `${reason} ${EXIT_LINE}`)

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
  return denyWithExit(
    'Không ghi đè lịch sử của nhánh chính trên máy chủ được vì không hoàn tác được; AI sẽ đẩy lên một nhánh riêng rồi gộp sau. ' +
    `Không push ép (--force / --force-with-lease / --mirror / --prune / refspec +) lên nhánh chính ${hit.name}: ghi đè hoặc xoá ref trên remote không hoàn tác được. ` +
    'Push nhánh riêng rồi gộp.')
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
  return denyWithExit(
    'Không xoá nhánh chính trên máy chủ được; AI sẽ bỏ lệnh này và làm cách khác.' + ' ' +
    `Không xoá nhánh chính ${hit} trên remote (git push --delete / refspec :${hit}).`)
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
    `${what} ở ${here} sẽ xoá thay đổi chưa commit. Làm trong worktree.`
  switch (g.sub) {
    case 'reset':
      if (f.long.has('hard') && !info.linked && isMainName(info.branch)) return denyWithExit(wipe('git reset --hard'))
      return null
    case 'branch': {
      const del = f.short.has('D') || (flag('d', 'delete') && flag('f', 'force'))
      const main = f.pos.map((n) => n.replace(/^refs\/heads\//, '')).find(isMainName)
      if (del && main) {
        return denyWithExit(
          'Không xoá nhánh chính được; AI sẽ bỏ lệnh này và làm cách khác.' + ' ' +
          `Không xoá nhánh chính ${main} bằng git branch -D / -d -f.`)
      }
      if (flag('m', 'move') || f.short.has('M')) {
        // `-m <x> <đích>` hoặc `-m <đích>` (đổi tên nhánh hiện tại); đích là nhánh chính khác nguồn ⇒ đè nhánh chính
        const [from, to] = f.pos.length >= 2 ? f.pos : [info.branch, f.pos[0]]
        if (isMainName(to) && from !== to) {
          return denyWithExit(
            'Không đè lên nhánh chính được; AI sẽ đặt tên khác cho nhánh. ' +
            `Không đè nhánh chính ${to} bằng git branch -m / -M.`)
        }
      }
      return null
    }
    case 'checkout':
      return !info.linked && f.pos.some((a) => /^\.\/?$/.test(a)) ? denyWithExit(wipe('git checkout -- .')) : null
    case 'restore': {
      const stagedOnly = flag('S', 'staged') && !flag('W', 'worktree') // chỉ bỏ stage, không đụng file
      return !info.linked && !stagedOnly && f.pos.some((a) => /^\.\/?$/.test(a)) ? denyWithExit(wipe('git restore .')) : null
    }
    case 'clean':
      return !info.linked && flag('f', 'force') && !flag('n', 'dry-run') ? denyWithExit(wipe('git clean -f')) : null
    default:
      return null
  }
}

// ---------- git merge vào nhánh chính: thiếu dấu thì nhắc, không chặn ----------

// m = parseGitMerge. Đang đứng ở nhánh chính mà đích nào thiếu dấu review/qa/test ⇒ nhắc MỘT dòng (additionalContext), không chặn. Đủ dấu ⇒ im.
async function gateMerge(m) {
  const info = repoInfo(m.dir)
  if (!info) return null
  const base = mainBranch(info)
  if (info.branch !== base) return null
  const missing = new Set()
  for (const target of m.targets) for (const k of (await tryGateState(info, base, target))?.missing ?? []) missing.add(k)
  if (missing.size === 0) return null
  return remind(`Gộp khi còn thiếu: ${['review', 'qa', 'test'].filter((k) => missing.has(k)).join(', ')}. ` +
    'Làm nốt nếu làm được; không được thì báo user một dòng phần chưa kiểm.')
}

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
// MỌI kết quả chỉ NHẮC (additionalContext), không chặn: bad (gồm nguồn git/URL chưa được duyệt), unknown (mạng lỗi/quá giờ), và newPackages ném
// (manifest hỏng, mốc git đọc không được). AI báo user một dòng (không im lặng) + log.
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
    return remind(`Chưa kiểm được các thư viện mới trong phần sắp lưu (không đọc được package.json / go.mod để so với bản trước: ${why}). Lệnh commit vẫn chạy. ` +
      'Hãy báo user MỘT dòng: thư viện mới chưa được kiểm tra, bạn xem lại trước khi dùng; kiểm bằng node ~/.claude/hooks/deps-check.mjs --list.')
  }
  if (pkgs.length === 0) return null
  const results = await vetBudgeted(deps, pkgs, trustedDepSources(info, tree))
  for (const r of results) {
    if (r.status === 'unknown') log(`deps unknown ${r.eco}:${r.name} — ${r.unknown.join('; ')}`)
  }
  const bad = results.filter((r) => r.status === 'bad')
  const unknown = results.filter((r) => r.status === 'unknown')
  if (bad.length === 0 && unknown.length === 0) return null
  const parts = []
  if (bad.length > 0) {
    const shown = bad.slice(0, 8).map((r) => `${pkgLabel(r)} — ${r.problems.join('; ')}`).join(' | ') + (bad.length > 8 ? ` | …và ${bad.length - 8} thư viện nữa` : '')
    parts.push(`Thư viện mới trong phần sắp commit có dấu hiệu không an toàn: ${shown}. Kiểm lại tên có đúng không (AI hay bịa hoặc gõ nhầm tên), chọn bản đủ tuổi và không có lỗ hổng ` +
      '(kiểm lại bằng node ~/.claude/hooks/deps-check.mjs --vet npm:<tên>).' +
      (bad.some((r) => r.source)
        ? ' Thư viện nguồn git/URL mà user đã duyệt thì ghi từng mục "tên@nguồn" (nguồn y hệt trong package.json) vào "trustedDepSources" trong .claude/flow.json, ' +
          `rồi git add .claude/flow.json bằng một lệnh riêng trước lệnh commit — chỉ bản sắp commit mới được tính (diff hiện ra khi review). Mục cần ghi: ${
            bad.filter((r) => r.source).slice(0, 3).map((r) => JSON.stringify(`${r.name}@${r.version}`)).join(', ')}.`
        : ''))
  }
  if (unknown.length > 0) {
    const names = unknown.slice(0, 8).map(pkgLabel).join(', ') + (unknown.length > 8 ? `, …và ${unknown.length - 8} thư viện nữa` : '')
    parts.push(`Chưa kiểm được độ an toàn của thư viện mới (mạng lỗi hoặc quá giờ): ${names}.`)
  }
  return remind(`${parts.join(' ')} Lệnh commit vẫn chạy. Hãy báo user MỘT dòng: các thư viện này chưa được kiểm tra hoặc có vấn đề, bạn xem lại trước khi dùng; ` +
    'kiểm lại bằng node ~/.claude/hooks/deps-check.mjs --vet npm:<tên>.')
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

const GIT_WORDS = /merge|commit|push|reset|branch|checkout|restore|clean/
const SHELL_RUNNERS = /^(?:(?:ba|z|da|k|c|fi)?sh|eval|pwsh|powershell|cmd)$/i
const baseCmd = (t) => path.posix.basename(t.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '').replace(/^`+/, '')

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

// Xoá cả thư mục (rm -r/-rf, Remove-Item -Recurse, rmdir|rd /s), kể cả trong bash -c / eval / powershell -c / cmd /c ⇒ chặn: bộ lọc an toàn của app bật
// hộp hỏi user cho mỗi lệnh như vậy. Dọn chỗ chạy test thì tạo thư mục mới; thật sự cần xoá thì có lối ra (EXIT_LINE).
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
const DIR_DELETE_DENY = denyWithExit(
  'Xoá hẳn cả một thư mục thì không lấy lại được nên AI không chạy lệnh này; AI sẽ dọn bằng cách an toàn thay thế. ' +
  'Lệnh xoá đệ quy (rm -r/-rf, Remove-Item -Recurse, rmdir /s) bị chặn. Dọn thư mục tạm, thư mục build (dist, build, .next, node_modules…) hoặc worktree đã gộp sạch ⇒ ' +
  '`node ~/.claude/hooks/don.mjs "<đường dẫn>"` (tự kiểm rồi mới xoá, từ chối thì nêu lý do). Cần chỗ trống để chạy test/build mà don.mjs từ chối ⇒ tạo thư mục ' +
  'mới (tên khác, vd thêm hậu tố thời gian) trong scratchpad hoặc thư mục tạm. Thật sự phải bỏ thư mục khác ⇒ chuyển vào Thùng rác (lấy lại được) bằng PowerShell ' +
  '`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory("<đường dẫn>", "OnlyErrorDialogs", "SendToRecycleBin")`.')

async function hookBash(input) {
  const n = normalize(input, process.env)
  const cmd = n.command ?? input.tool_input?.command
  if (typeof cmd !== 'string') return null
  // Lối ra của mọi lời chặn: user đã gật trong chat ⇒ AI chạy lại lệnh với tiền tố FLOW_OK=1 ⇒ cho qua mọi cổng, chỉ ghi dấu vết.
  if (/\bFLOW_OK=/.test(cmd)) { logApproval(cmd); return null }
  if (safely('dirDelete', () => tokenize(cmd).some((t) => deletesDir(t)))) return DIR_DELETE_DENY
  const nudge = SLOW_SEARCH.test(cmd) ? SEARCH_NUDGE : null
  if (!GIT_WORDS.test(cmd)) return nudge
  let cwd = path.resolve(toNative(n.cwd))
  const notes = [] // lời nhắc không chặn (vd thư viện mới chưa kiểm được, merge thiếu dấu); trả khi không có deny
  let sawAdd = false // đã có `git add` đứng trước trong cùng lệnh: index lúc này chưa phản ánh commit sắp tạo
  for (const toks of tokenize(cmd)) {
    if (/^(cd|pushd|popd)$/.test(toks[0] ?? '')) {
      const to = toks[0] === 'popd' ? null : toks[1]
      if (to && !/^[-~$]/.test(to)) cwd = path.resolve(cwd, toNative(to)) // cd tới chỗ không tính ra được (biến, ~, -, cd trần) ⇒ giữ thư mục cũ
      continue
    }
    const g = parseGitSub(toks, cwd)
    if (!g) continue
    const gates = [] // cổng của lệnh này, chạy lần lượt; deny đầu tiên dừng cả lệnh, lời nhắc thì dồn lại (không cắt ngang các cổng sau)
    if (g.sub === 'add') {
      sawAdd = true
    } else if (g.sub === 'merge') {
      const m = parseGitMerge(g)
      if (m) gates.push(() => safelyAsync('gateMerge', () => gateMerge(m)))
    } else if (g.sub === 'commit') {
      gates.push(() => safely(`gateSecrets ${g.sub}`, () => gateSecrets(g)), () => safelyAsync('gateDeps', () => gateDeps(g, sawAdd)))
    } else if (g.sub === 'push') {
      // push thường lên nhánh chính: cho qua, không hỏi [chốt 2026-10-14]; chỉ chặn secret, push ép, xoá nhánh chính
      gates.push(() => safely(`gateSecrets ${g.sub}`, () => gateSecrets(g)), () => safely('gateForcePush', () => gateForcePush(g)),
        () => safely('gateDeleteMainPush', () => gateDeleteMainPush(g)))
    } else if (DESTRUCTIVE_SUBS.has(g.sub)) {
      gates.push(() => safely(`gateDestructive ${g.sub}`, () => gateDestructive(g)))
    }
    for (const gate of gates) {
      const out = await gate()
      if (out?.hookSpecificOutput?.permissionDecision) return out
      if (out) notes.push(out.hookSpecificOutput.additionalContext)
    }
  }
  if (nudge) notes.push(nudge.hookSpecificOutput.additionalContext)
  return notes.length > 0 ? remind(notes.join('\n')) : null
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
// thấy ⇒ giữ nguyên plan (lane-check báo lỗi ⇒ không kiểm được phạm vi ⇒ cho qua + log).
function planFromMain(plan, info) {
  if (!info?.linked || fs.existsSync(plan) || path.basename(info.commonDir) !== '.git') return plan
  const rel = path.relative(realish(info.toplevel), realish(plan))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return plan
  const alt = path.join(path.dirname(info.commonDir), rel)
  return fs.existsSync(alt) ? alt : plan
}

// Worker coder nộp bài: brief (tin nhắn user đầu trong transcript) có plan= và lane= ⇒ chạy lane-check audit trong cwd của worker.
// Phát hiện file ngoài scope (exit 1) ⇒ block (lặp vô hạn không xảy ra vì lượt sau stop_hook_active=true ⇒ cho qua). lane-check không chạy được
// (exit 2/lỗi) ⇒ không kiểm được phạm vi ⇒ cho qua + log. Brief không có plan=/lane= ⇒ không có gì để audit ⇒ cho qua.
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
    log(`lane-check audit lane ${lane}: không kiểm được phạm vi, cho qua — ${r.error?.message ?? `exit ${r.status}: ${(r.stderr || r.stdout || '').trim()}`}`)
    return null
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
      return fail(`${file} thiếu dòng "User duyệt giao diện: có" (sửa rất nhỏ: "Sửa giao diện rất nhỏ: đã gửi ảnh"). Diff có file UI ⇒ trước khi đóng dấu QA, mở app/ảnh chụp cho user xem và hỏi ` +
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

const HOOKS = { edit: () => null, bash: hookBash, stop: hookStop, 'subagent-stop': hookSubagentStop } // edit: hook cũ còn trong settings.json của user — nhận và bỏ qua
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
  fail('Dùng: flow-gate.mjs bash|stop|subagent-stop (hook) · stamp review <file.json> · stamp qa <file.md> · stamp test -- <lệnh> · status')
}
