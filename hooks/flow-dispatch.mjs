// flow-dispatch: ép các bước hay bị bỏ sót khi giao worker và khi kết thúc phiên. Một script, chế độ chọn bằng argv[2].
//   agent : PreToolUse matcher `Agent|Task`. Đọc tool_input.subagent_type + tool_input.prompt (field của Agent tool, docs hooks mục Agent).
//           coder/coder-lite có `lane=` ⇒ đòi `plan=` rồi chạy `lane-check.mjs plan <plan>`; qa-tester ⇒ đòi PORT_BASE=<n> hoặc port=<n>.
//   stop  : Stop. Sổ docs/specs/*/progress.md chưa "xong" mà commit HEAD mới hơn sổ ⇒ block MỘT lần cho mỗi HEAD. Sổ được chọn như session-start:
//           sổ ghi đúng nhánh git hiện tại (openProgress của lib so-chot, quét mọi thư mục); nhánh không xác định / chưa sổ nào nhận ⇒ sổ chưa xong sửa gần nhất.
// Spec: ~/.claude/plans/flow-v5-hooks-spec.md (Làn B). Docs: https://code.claude.com/docs/en/hooks
// Lỗi nội bộ luôn CHO QUA (exit 0, không in gì) và ghi một dòng vào flow-dispatch.log.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefPlan, briefWord } from './lib/brief.mjs'
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
  if (plan === null) return deny('Brief có lane= phải kèm plan=<đường PLAN.md> (để kiểm bảng làn trước khi giao và audit phạm vi khi worker nộp).')
  const r = spawnSync(process.execPath, [LANE_CHECK, 'plan', plan], { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true })
  if (r.error) { log(`lane-check: ${r.error.message}`); return null }
  const cap = (s) => (s.length > MAX_REASON ? `${s.slice(0, MAX_REASON)}\n…(cắt)` : s)
  if (r.status === 1) return deny(cap(`Bảng làn trong ${plan} chưa sạch, sửa PLAN.md rồi giao lại:\n${r.stdout.trim()}`))
  if (r.status === 2) return deny(cap(`Không kiểm được bảng làn trong ${plan} (bảng hỏng hoặc không đọc được): ${(r.stderr || r.stdout).trim()}`))
  if (r.status !== 0) log(`lane-check plan exit ${r.status}: ${(r.stderr || '').trim()}`) // lỗi bất thường: cho qua
  return null
}

function gateQa(prompt) {
  if (QA_PORT_RE.test(prompt)) return null
  return deny('Brief qa-tester phải có PORT_BASE=<n> (node ~/.claude/hooks/wt-env.mjs alloc <worktree>) hoặc port=<n> của app đã chạy sẵn.')
}

function hookAgent(input) {
  const ti = input.tool_input
  if (typeof ti?.subagent_type !== 'string' || typeof ti.prompt !== 'string') return null
  let cwd = process.cwd()
  try { if (typeof input.cwd === 'string' && fs.statSync(input.cwd).isDirectory()) cwd = input.cwd } catch {}
  if (ti.subagent_type === 'coder' || ti.subagent_type === 'coder-lite') return gateLane(ti.prompt, cwd)
  if (ti.subagent_type === 'qa-tester') return gateQa(ti.prompt)
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

// Sổ docs/specs/*/progress.md chưa "xong" sửa gần nhất (đường lui khi không sổ nào nhận nhánh): { rel, mtimeMs } hoặc null. Cùng luật an toàn như session-start:
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

// Sổ để nhắc: sổ chưa xong ghi đúng nhánh hiện tại (openProgress của lib, quét MỌI thư mục, cùng cách chọn với session-start). Nhánh không
// xác định (detached HEAD…) hoặc không sổ nào nhận ⇒ newestOpenProgress, y như session-start rơi về sổ sửa gần nhất.
// Riêng nhánh chính (main/master): commit ở đó là gộp/sửa vặt, không phải việc của sổ sửa gần nhất ⇒ không đoán.
function pickProgress(dir, top) {
  const branch = (git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']) ?? '').trim()
  if (branch) {
    try {
      const hit = openProgress(top, branch)
      if (hit) return { rel: hit.rel, mtimeMs: hit.mtimeMs }
    } catch (e) {
      log(`openProgress lỗi (${e.code ?? e.name})`)
    }
    if (branch === 'main' || branch === 'master') return null
  }
  return newestOpenProgress(top)
}

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
  // So theo giây (%ct không có phần lẻ): sổ chỉ coi là mới hơn commit khi mtime ở giây SAU giây commit. Cùng giây mà commit không sửa sổ ⇒ coi như sổ cũ.
  if (!Number.isFinite(ct) || ct <= 0 || Math.floor(prog.mtimeMs / 1000) > ct) return null
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
    reason: `Có commit mới mà sổ ${prog.rel} chưa cập nhật: ghi pha/làn/bước tiếp theo rồi mới kết thúc.`,
  }
}

// ---------- main ----------

const HOOKS = { agent: hookAgent, stop: hookStop }
const mode = process.argv[2]

if (HOOKS[mode]) {
  try {
    const out = HOOKS[mode](JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch (e) {
    log(e?.stack ?? e)
  }
} else {
  console.error('Dùng: flow-dispatch.mjs agent|stop (hook)')
  process.exitCode = 1
}
