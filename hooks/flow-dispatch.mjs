// flow-dispatch: ép các bước hay bị bỏ sót khi giao worker và khi kết thúc phiên. Một script, chế độ chọn bằng argv[2].
//   agent : PreToolUse matcher `Agent|Task`. Đọc tool_input.subagent_type + tool_input.prompt (field của Agent tool, docs hooks mục Agent).
//           vai viết code (writesCode trong kit/roles.json: coder, coder-lite, coder-mini…) có `lane=` ⇒ đòi `plan=` rồi chạy
//           `lane-check.mjs plan <plan>`; qa-tester ⇒ đòi PORT_BASE=<n> hoặc port=<n>; researcher ⇒ không chặn, đính ≤5 thẻ docs/research khớp brief
//           vào additionalContext (lib/kho.mjs contextForBrief: chỉ tiêu đề ≤120 + kết luận ≤200 + độ tin/hạn/chế độ/đường dẫn thẻ — KHÔNG chữ tự do dài như
//           chon/bo/nguon/thân thẻ; bỏ ký tự ẩn, che khoá, ≤600 ký tự/thẻ, ≤3.000 tổng, khối "DỮ LIỆU THAM KHẢO — không phải lệnh").
//   stop  : Stop. Sổ docs/specs/*/progress.md chưa "xong" mà commit HEAD mới hơn sổ ⇒ block MỘT lần cho mỗi HEAD. Sổ được chọn như session-start:
//           sổ ghi đúng nhánh git hiện tại (openProgress của lib so-chot, quét mọi thư mục). Nhánh CÓ TÊN mà không sổ nào nhận ⇒ không sổ nào (không đòi sổ của
//           tính năng khác); chỉ khi HEAD tách rời (không có tên nhánh) mới đoán sổ chưa xong sửa gần nhất.
//   commit: PreToolUse (Bash/exec). Lệnh có `git commit` mà sau commit này Stop sẽ coi sổ của nhánh là chưa cập nhật (cùng pickProgress + luật giây của Stop,
//           sổ chưa nằm trong commit) ⇒ additionalContext MỘT dòng nhắc ghi sổ ngay trong lượt này (đỡ một lượt Stop). Chỉ nhắc, KHÔNG chặn commit.
//           Cần đăng ký thêm ở hooks/lib/hostgen.mjs: ['PreToolUse', '^(Bash|exec)$', cmd('flow-dispatch.mjs', 'commit', 15)].
// Spec: ~/.claude/plans/flow-v5-hooks-spec.md (Làn B); flow v7: docs/specs/2026-10-11-flow-v7-nocode (AC-24, làn D). Docs: https://code.claude.com/docs/en/hooks
// Mọi lời chặn mở đầu bằng MỘT câu đời thường (bị chặn vì gì + AI sẽ tự làm gì) rồi mới tới chi tiết kỹ thuật (AC-24).
// Lỗi nội bộ luôn CHO QUA (exit 0, không in gì) và ghi một dòng vào flow-dispatch.log.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefPlan, briefWord, toNative } from './lib/brief.mjs'
import { normalize } from './lib/host.mjs'
import { contextForBrief } from './lib/kho.mjs'
import { roleSet } from './lib/models.mjs'
import { openProgress } from './lib/so-chot.mjs'

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = process.env.FLOW_DISPATCH_LOG || path.join(HOOK_DIR, 'flow-dispatch.log')
const LANE_CHECK = path.join(HOOK_DIR, 'lane-check.mjs')
const QA_PORT_RE = /\b(PORT_BASE|port)\s*=\s*\d{2,5}\b/i
const MAX_DIRS = 50 // số thư mục docs/specs/* tối đa được xét khi không sổ nào nhận nhánh (như session-start)
const MAX_READ = 64 * 1024 // chỉ đọc từng này byte đầu mỗi progress.md
const MAX_REASON = 3000
// Dòng `Trạng thái: xong` (chấp nhận markdown bao quanh như `- **Trạng thái:** xong`), không phân biệt hoa thường. Giống session-start.
const DONE_RE = /^[ \t>*_#-]*Trạng thái[ \t]*[:：]?[ \t*_]*[:：]?[ \t*_]*xong[ \t*_.!]*$/imu

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.argv[2] ?? ''}] ${String(msg).replace(/\r?\n/g, ' | ')}\n`)
  } catch {}
}

const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
const inside = (root, p) => lower(p).startsWith(lower(root) + path.sep)

// Trả stdout hoặc null khi git lỗi (không phải repo, không có commit…).
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 5000, windowsHide: true })
  if (r.error) { log(`git ${args[0]}: ${r.error.message}`); return null }
  return r.status === 0 ? r.stdout : null
}

const deny = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

// ---------- chế độ agent ----------

function gateLane(prompt, cwd) {
  if (briefWord(prompt, 'lane') === null) return null
  const plan = briefPlan(prompt, cwd)
  if (plan === null) {
    return deny('Chưa giao việc được vì phần mô tả công việc thiếu đường dẫn tới kế hoạch; AI sẽ bổ sung rồi giao lại. ' +
      'Brief có lane= phải kèm plan=<đường PLAN.md> (để kiểm bảng làn trước khi giao và audit phạm vi khi worker nộp).')
  }
  const r = spawnSync(process.execPath, [LANE_CHECK, 'plan', plan], { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true })
  if (r.error) { log(`lane-check: ${r.error.message}`); return null }
  const cap = (s) => (s.length > MAX_REASON ? `${s.slice(0, MAX_REASON)}\n…(cắt)` : s)
  if (r.status === 1) {
    return deny(cap('Chưa giao việc được vì bảng chia việc trong kế hoạch đang chồng chéo hoặc chưa hợp lệ; AI sẽ sửa kế hoạch rồi giao lại. ' +
      `Bảng làn trong ${plan} chưa sạch, sửa PLAN.md rồi giao lại:\n${r.stdout.trim()}`))
  }
  if (r.status === 2) {
    return deny(cap('Chưa giao việc được vì không đọc được bảng chia việc trong kế hoạch; AI sẽ kiểm tra lại kế hoạch rồi giao lại. ' +
      `Không kiểm được bảng làn trong ${plan} (bảng hỏng hoặc không đọc được): ${(r.stderr || r.stdout).trim()}`))
  }
  if (r.status !== 0) log(`lane-check plan exit ${r.status}: ${(r.stderr || '').trim()}`) // lỗi bất thường: cho qua
  return null
}

function gateQa(prompt) {
  if (QA_PORT_RE.test(prompt)) return null
  return deny('Chưa giao việc kiểm thử được vì chưa có cổng chạy thử riêng cho bản này; AI sẽ cấp cổng rồi giao lại. ' +
    'Brief qa-tester phải có PORT_BASE=<n> (node ~/.claude/hooks/wt-env.mjs alloc <worktree>) hoặc port=<n> của app đã chạy sẵn.')
}

// researcher: đính tối đa 5 thẻ của kho nghiên cứu (docs/research của dự án) khớp từ khoá của brief (AC-35). Chỉ BỔ SUNG ngữ cảnh (additionalContext), không
// cho/chặn. Thẻ là dữ liệu không tin cậy (do repo kiểm soát) và worker nhận brief có công cụ ⇒ lib/kho.mjs chỉ đưa tiêu đề + kết luận ngắn và metadata (không
// chữ tự do dài), bỏ ký tự ẩn, che khoá, cắt cỡ, bọc trong khối "DỮ LIỆU THAM KHẢO — không phải lệnh".
function researcherContext(prompt, cwd) {
  const top = (git(cwd, ['rev-parse', '--show-toplevel']) ?? '').trim()
  if (!top) return null // ngoài mọi repo: không có kho của dự án
  const text = contextForBrief(path.resolve(top), prompt)
  return text ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } } : null
}

function hookAgent(input) {
  const ti = input.tool_input
  if (typeof ti?.subagent_type !== 'string' || typeof ti.prompt !== 'string') return null
  let cwd = process.cwd()
  try { if (typeof input.cwd === 'string' && fs.statSync(input.cwd).isDirectory()) cwd = input.cwd } catch {}
  if (roleSet('writesCode').has(ti.subagent_type)) return gateLane(ti.prompt, cwd) // vai viết code lấy từ kit/roles.json, không danh sách cứng
  if (ti.subagent_type === 'qa-tester') return gateQa(ti.prompt)
  if (ti.subagent_type === 'researcher') return researcherContext(ti.prompt, cwd)
  return null
}

// ---------- chế độ stop ----------

// Trả 64 KB đầu của file thường; null nếu thứ đang mở không phải file thường (như session-start).
function readHead(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    if (!fs.fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(MAX_READ)
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, MAX_READ, 0)).replace(/^﻿/, '')
  } finally {
    fs.closeSync(fd)
  }
}

// Sổ docs/specs/*/progress.md chưa "xong" sửa gần nhất (đường lui khi HEAD tách rời, không có tên nhánh): { rel, mtimeMs } hoặc null. Cùng luật an toàn như session-start:
// chỉ nhận file thường (lstat) có realpath nằm trong <toplevel>/docs/specs, tối đa MAX_DIRS thư mục, đọc MAX_READ byte đầu.
function newestOpenProgress(top) {
  const specs = path.join(top, 'docs', 'specs')
  let entries
  try {
    entries = fs.readdirSync(specs, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  }
  const realSpecs = path.join(fs.realpathSync.native(top), 'docs', 'specs')
  const cands = []
  for (const name of entries.filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse().slice(0, MAX_DIRS)) {
    const file = path.join(specs, name, 'progress.md')
    try {
      const st = fs.lstatSync(file)
      if (!st.isFile()) { log('bỏ qua progress.md không phải file thường'); continue }
      if (!inside(realSpecs, fs.realpathSync.native(file))) { log('bỏ qua progress.md có realpath ngoài docs/specs'); continue }
      cands.push({ rel: `docs/specs/${name}/progress.md`, file, mtimeMs: st.mtimeMs })
    } catch (e) {
      if (e.code !== 'ENOENT') log(`stat progress.md lỗi (${e.code ?? e.name})`)
    }
  }
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const c of cands) {
    try {
      const text = readHead(c.file)
      if (text === null) { log('bỏ qua progress.md không phải file thường (fstat lúc mở)'); continue }
      if (!DONE_RE.test(text.normalize('NFC'))) return { rel: c.rel, mtimeMs: c.mtimeMs }
    } catch (e) {
      log(`đọc progress.md lỗi (${e.code ?? e.name})`)
    }
  }
  return null
}

// Sổ để nhắc: sổ chưa xong ghi đúng nhánh hiện tại (openProgress của lib, quét MỌI thư mục, cùng cách chọn với session-start).
// Nhánh CÓ TÊN mà không sổ nào nhận (kể cả main/master, nhánh chore/fix không có sổ riêng) ⇒ null: sổ sửa gần nhất là của tính năng KHÁC, đòi ghi
// vào đó là nhắc sai chỗ (audit 2026-10-13: commit nâng thư viện bị đòi ghi sổ "social-dot2"). Chỉ khi HEAD tách rời (không có tên nhánh để đối chiếu)
// mới đoán bằng newestOpenProgress, y như session-start rơi về sổ sửa gần nhất.
function pickProgress(dir, top) {
  const branch = (git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']) ?? '').trim()
  if (!branch) return newestOpenProgress(top)
  try {
    const hit = openProgress(top, branch)
    if (hit) return { rel: hit.rel, mtimeMs: hit.mtimeMs }
  } catch (e) {
    log(`openProgress lỗi (${e.code ?? e.name})`)
  }
  return null
}

// Sổ đã mới hơn commit (ct = giây commit)? So theo giây: sổ chỉ coi là mới hơn khi mtime ở giây SAU giây commit. ct hỏng ⇒ coi như mới (không nhắc).
// Dùng chung cho Stop (ct = giây của commit HEAD) và chế độ commit (ct = giây hiện tại = giây của commit sắp tạo).
const sheetNewer = (prog, ct) => !Number.isFinite(ct) || ct <= 0 || Math.floor(prog.mtimeMs / 1000) > ct

function hookStop(input) {
  if (input.stop_hook_active) return null
  const dir = input.cwd || process.cwd()
  const out = git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir'])
  if (!out) return null
  const [top, common] = out.split(/\r?\n/)
  if (!top || !common) return null
  const head = (git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) ?? '').trim()
  if (!/^[0-9a-f]{40,64}$/.test(head)) return null
  const marker = path.join(path.resolve(dir, common), 'flow-gates', `progress-nudged-${head}`)
  if (fs.existsSync(marker)) return null // đã nhắc cho HEAD này: khỏi quét sổ (pickProgress đọc nhiều file, mà Stop chạy ở mọi lượt)
  const prog = pickProgress(dir, path.resolve(top))
  if (!prog) return null
  const ct = Number((git(dir, ['log', '-1', '--format=%ct', head]) ?? '').trim())
  // Cùng giây mà commit không sửa sổ ⇒ coi như sổ cũ (xem sheetNewer).
  if (sheetNewer(prog, ct)) return null
  // Commit HEAD tự sửa sổ (commit ngay sau khi ghi sổ nên mtime vẫn cũ hơn commit) ⇒ coi như đã cập nhật.
  const touched = git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '-m', '--root', head])
  if (touched === null) return null
  if (touched.split('\0').includes(prog.rel)) return null
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx' }) // ghi trước khi in; phiên song song tranh nhau thì chỉ một bên nhắc
  } catch (e) {
    if (e.code !== 'EEXIST') log(`ghi marker lỗi (${e.code ?? e.name})`)
    return null
  }
  return {
    decision: 'block',
    reason: 'Tiến độ chưa được ghi lại nên AI sẽ cập nhật sổ tiến độ rồi mới kết thúc. ' +
      `Có commit mới mà sổ ${prog.rel} chưa cập nhật: ghi pha/làn/bước tiếp theo rồi mới kết thúc.`,
  }
}

// ---------- chế độ commit ----------

// Cờ của `git commit` nhận giá trị ở đối số kế tiếp (cùng bộ với flow-gate).
const COMMIT_VALUE_FLAGS = new Set([
  '-m', '-F', '-C', '-c', '-t', '--message', '--file', '--reuse-message', '--reedit-message', '--template',
  '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer',
])

// Tách lệnh shell thành các đoạn token đã bỏ nháy (ngắt ở ; & | ( ) > < xuống dòng). Nháy giữ nguyên mọi ký tự bên trong nên `-m "a && b"` và
// `-m "$(cat <<'EOF' … EOF)"` là MỘT token. Chỉ đủ để nhận ra `git commit` (cùng cách tách với flow-gate.tokenize, không bóc thân heredoc ngoài nháy).
function shellSegments(cmd) {
  const segs = []
  let cur = []
  let tok = ''
  let has = false
  let quote = null
  const flush = () => { if (has) cur.push(tok); tok = ''; has = false }
  const cut = () => { flush(); if (cur.length) segs.push(cur); cur = [] }
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
    else if (c === '>' || c === '<') { if (has && /^\d+$/.test(tok)) { tok = ''; has = false } cut() } // `2>&1`: số đứng trước là fd, không phải đối số
    else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') cut()
    else { tok += c; has = true }
  }
  cut()
  return segs
}

// rest = đối số sau `git commit` → { dryRun, all, paths }: all = -a/--all/-am (hoặc --pathspec-from-file: không biết path nào); paths = pathspec (kể cả sau `--`).
function commitFlags(rest) {
  const c = { dryRun: false, all: false, paths: [] }
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]
    if (t === '--') { c.paths.push(...rest.slice(j + 1)); break }
    if (t === '--dry-run') c.dryRun = true
    else if (t === '--all') c.all = true
    else if (t.startsWith('--pathspec-from-file')) { c.all = true; if (t === '--pathspec-from-file') j++ }
    else if (COMMIT_VALUE_FLAGS.has(t)) j++
    else if (/^-[A-Za-z]/.test(t)) { // cụm cờ ngắn như -am; từ cờ nhận giá trị trở đi là giá trị
      const cluster = t.slice(1)
      for (let k = 0; k < cluster.length; k++) {
        if (cluster[k] === 'a') c.all = true
        if ('mFCct'.includes(cluster[k])) { if (k === cluster.length - 1) j++; break }
        if ('uS'.includes(cluster[k])) break // -uall, -S<keyid>: phần còn lại là giá trị đính kèm
      }
    } else if (!t.startsWith('-')) c.paths.push(t)
  }
  return c
}

// Các `git commit` thật (không --dry-run) trong lệnh Bash: [{ dir, all, paths, sawAdd }]. dir theo `cd <dir>` và `git -C <dir>`;
// sawAdd = có `git add` đứng trước trong cùng lệnh (index lúc này chưa phản ánh commit sắp tạo).
function commitsIn(cmd, cwd) {
  const out = []
  let dir = cwd
  let sawAdd = false
  for (const toks of shellSegments(cmd)) {
    if (toks[0] === 'cd') {
      if (toks[1] && !/^[-~$]|[$`]/.test(toks[1])) dir = path.resolve(dir, toNative(toks[1]))
      continue
    }
    let i = 0
    while (/^[A-Za-z_]\w*=/.test(toks[i] ?? '')) i++
    if (!/(^|[\\/])git(\.exe)?$/i.test(toks[i] ?? '')) continue
    i++
    let gdir = dir
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '-C') { gdir = path.resolve(gdir, toNative(toks[i + 1] ?? '.')); i += 2 }
      else if (toks[i] === '-c') i += 2
      else i++
    }
    if (toks[i] === 'add') sawAdd = true
    else if (toks[i] === 'commit') {
      const c = commitFlags(toks.slice(i + 1))
      if (!c.dryRun) out.push({ dir: gdir, all: c.all, paths: c.paths, sawAdd })
    }
  }
  return out
}

// Sổ rel có nằm trong commit sắp tạo không? Stop coi sổ là đã cập nhật khi commit sửa sổ. Đọc trạng thái riêng của sổ (XY của status):
// đã staged ⇒ có; sửa chưa staged ⇒ có nếu commit -a / pathspec / có `git add` trước trong lệnh; chưa theo dõi ⇒ chỉ khi có `git add`.
// Không đọc được trạng thái ⇒ true (không biết thì không nhắc).
function sheetInCommit(top, rel, c) {
  const st = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel])
  if (st === null) return true
  const xy = st.slice(0, 2)
  if (!xy.trim()) return false
  if (/[MADRCT]/.test(xy[0])) return true
  if (xy === '??') return c.sawAdd
  return c.sawAdd || c.all || c.paths.length > 0
}

function hookCommit(input) {
  const n = normalize(input, process.env)
  if (n.tool !== 'bash' || typeof n.command !== 'string' || !/\bgit(?:\.exe)?\b[\s\S]*\bcommit\b/.test(n.command)) return null // chưa phải commit: khỏi gọi git
  const now = Math.floor(Date.now() / 1000) // giây của commit sắp tạo
  for (const c of commitsIn(n.command, path.resolve(toNative(n.cwd)))) {
    const top = (git(c.dir, ['rev-parse', '--show-toplevel']) ?? '').trim()
    if (!top) continue
    const prog = pickProgress(c.dir, path.resolve(top))
    if (!prog || sheetNewer(prog, now) || sheetInCommit(path.resolve(top), prog.rel, c)) continue
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `Sổ ${prog.rel} chưa cập nhật cho commit này — ghi bước tiếp theo vào sổ (sổ trong git thì git add vào chính commit này) để khỏi tốn thêm một lượt.`,
      },
    }
  }
  return null
}

// ---------- main ----------

const HOOKS = { agent: hookAgent, stop: hookStop, commit: hookCommit }
const mode = process.argv[2]

if (HOOKS[mode]) {
  try {
    const out = HOOKS[mode](JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch (e) {
    log(e?.stack ?? e)
  }
} else {
  console.error('Dùng: flow-dispatch.mjs agent|stop|commit (hook)')
  process.exitCode = 1
}
