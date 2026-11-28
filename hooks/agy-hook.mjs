// agy-hook: bộ nối giữa hook của Antigravity CLI (agy) và các cổng của kit (flow-gate.mjs, session-start.mjs). Chế độ chọn bằng argv[2]:
//   pre-tool      PreToolUse: stdin camelCase {hookEventName, cwd, toolCall:{name,args}} → stdout {"decision":"allow|deny|ask","reason"?}
//   stop          Stop: hookStop của flow-gate → {"decision":"continue","reason"} (giữ agent làm nốt) hoặc {"decision":"stop"}
//   session-start SessionStart: chạy session-start.mjs → {"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]} (rỗng ⇒ {})
//   deny-rules    in JSON mảng luật `permissions.deny` lớp 2 (chặn bằng regex ở quyền agy, độc lập với hook) để dán vào settings.json của agy
// Hợp đồng agy: docs hooks (~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md) và D:\tmp\agy-host\ket-qua.md. Exit code của hook agy KHÔNG có nghĩa ⇒ luôn exit 0, quyết định nằm ở stdout.
//
// PreToolUse là FAIL-CLOSED: mọi lỗi (stdin hỏng, payload lạ, cổng ném lỗi, tiến trình con chết/quá giờ, stdout con không phải JSON hợp lệ) ⇒ {"decision":"deny"}.
//   Tiến trình ngoài (pre-tool) chỉ dùng module có sẵn của Node, rồi chạy CHÍNH file này ở chế độ `--inner` trong tiến trình con có hạn giờ: nhờ vậy
//   cả khi flow-gate.mjs lỗi cú pháp, treo ở lệnh git đồng bộ, hay con bị giết, tiến trình ngoài vẫn in được deny. Adapter KHÔNG chạy flow-gate rồi đọc stdout:
//   bên trong gọi thẳng hookBash(…, {strict:true}) (lỗi trong cổng ném ra thay vì bị nuốt) và các hàm kiểm đường dẫn/secret.
// Việc bị kiểm: lệnh shell (run_command…) qua hookBash — cùng luật chặn như Claude (xoá thư mục hệ thống/cá nhân/.git, push ép nhánh chính, xoá DB, secret khi commit/push…);
//   tool ghi/sửa/xoá/di chuyển file qua đường dẫn đích (thư mục hệ thống, cá nhân, .git) + nội dung (secret, trừ file .env/khoá vốn là chỗ để khoá).
//   Tool khác ⇒ cho qua. Tên tool ghi file thật của agy chưa xác nhận trên máy: xem lib/host.mjs agyToolKind.
// Lỗi/quyết định chặn ghi ~/.claude/logs/agy-hook.log (AGY_HOOK_LOG đổi chỗ): chỉ tên tool, loại lỗi — không ghi lệnh, nội dung hay giá trị khoá. AGY_HOOK_TRACE=1 ghi cả lần cho qua (để xem tên tool thật).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canon, checkForms, configHit, homesOf, shellProtectedWrite } from './lib/agy-guard.mjs'

const SELF = fileURLToPath(import.meta.url)
const HOOK_DIR = path.dirname(SELF)
const INNER_TIMEOUT_MS = Number(process.env.AGY_HOOK_TIMEOUT_MS) > 0 ? Number(process.env.AGY_HOOK_TIMEOUT_MS) : 25000 // hooks.json đặt timeout 30 s; ra quyết định trước hạn đó
const SESSION_TIMEOUT_MS = 20000
const DECISIONS = new Set(['allow', 'deny', 'ask'])
const FAIL_CLOSED_REASON = 'Lớp chặn lỗi nội bộ (fail-closed): kit không kiểm được việc này nên không cho chạy. Báo user một dòng: hook agy-hook.mjs gặp lỗi (chi tiết ở ~/.claude/logs/agy-hook.log).'
const failClosed = (why) => ({ decision: 'deny', reason: why ? `${FAIL_CLOSED_REASON} (${why})` : FAIL_CLOSED_REASON })

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : undefined)
// Thư mục làm việc của phiên: cwd nếu là chuỗi có chữ (cwd rỗng / toàn khoảng trắng / không phải chuỗi ⇒ bỏ), rồi phần tử đầu tiên có chữ của workspacePaths, rồi thư mục của tiến trình hook.
const cwdOf = (p) => (isObj(p) ? [p.cwd, ...(Array.isArray(p.workspacePaths) ? p.workspacePaths : [])].find((v) => typeof v === 'string' && v.trim() !== '') : undefined) ?? process.cwd()

// ---------- log (không bao giờ ném) ----------

function logFile() {
  return process.env.AGY_HOOK_LOG || path.join(os.homedir(), '.claude', 'logs', 'agy-hook.log')
}
function log(mode, msg) {
  try {
    const file = logFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} [${mode}] ${String(msg).replace(/\s+/g, ' ').slice(0, 300)}\n`)
  } catch {}
}
// Chỉ loại lỗi: message của JSON.parse/spawn có thể trích nguyên nội dung đầu vào (lệnh, khoá).
const errTag = (e) => `${e?.name ?? 'Error'}${e?.code ? `/${e.code}` : ''}`

// ---------- PreToolUse: phép kiểm bên trong ----------

const CWD_KEYS = ['Cwd', 'cwd', 'WorkingDirectory', 'WorkingDir', 'workingDirectory']
const GIT_DIR = /(^|\/)\.git(\/|$)/
const MAX_DEPTH = 8
const nonBlank = (v) => typeof v === 'string' && v.trim() !== ''

// Khoá đường dẫn RÕ RÀNG của công cụ ghi file agy (đối chiếu sidecar swarm_board của agy: args.Path || args.AbsolutePath || args.TargetFile; binary: FilePath, file_path, DirectoryPath…).
// So khớp sau khi bỏ hoa thường, gạch dưới và gạch ngang. `Target`, `TargetContent`, `Replacement`, `Source`… của edit_file là CHỮ cần thay, không phải đường dẫn.
const PATH_KEYS = new Set(['path', 'abspath', 'absolutepath', 'targetfile', 'targetpath', 'filepath', 'file', 'filename', 'directorypath', 'directory', 'dirpath', 'dir', 'folder', 'folderpath',
  'sourcepath', 'sourcefile', 'destinationpath', 'destinationfile', 'destpath', 'destfile', 'uri', 'notebookpath', 'outputpath', 'outputfile', 'searchpath'])
// Riêng tool di chuyển / đổi tên / sao chép / xoá: nhận thêm các khoá trần (cặp nguồn–đích, đối tượng bị xoá).
const MOVE_EXTRA_KEYS = new Set(['source', 'destination', 'src', 'dst', 'dest', 'from', 'to', 'newpath', 'oldpath', 'target'])
const MOVE_TOOL = /move|rename|copy|delete|remove/i
const keyOf = (k) => String(k).toLowerCase().replace(/[_-]/g, '')

// Duyệt mọi chuỗi trong args: chuỗi ngắn một dòng dưới KHOÁ ĐƯỜNG DẪN RÕ RÀNG là ứng viên đường dẫn; MỌI chuỗi đều được quét secret.
function collectStrings(value, key, out, extra, depth = 0) {
  if (depth > MAX_DEPTH) return
  if (typeof value === 'string') {
    out.texts.push(value)
    const k = keyOf(key)
    // Không loại theo độ dài / xuống dòng: đường dẫn dài mà bị bỏ qua = cho qua lặng lẽ. Dài quá thì checkEdit chuẩn hoá trước (bỏ ./ thừa) rồi mới so với PATH_LIMIT.
    if ((PATH_KEYS.has(k) || (extra && MOVE_EXTRA_KEYS.has(k))) && value.trim() !== '' && !/^https?:\/\//i.test(value)) out.paths.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, key, out, extra, depth + 1)
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) collectStrings(v, k, out, extra, depth + 1)
  }
}

const PATH_LIMIT = 4096 // sau khi chuẩn hoá (bỏ ./, .., //); dài hơn PATH_MAX của Linux thì không phải đường dẫn thật ⇒ không kiểm được ⇒ deny
const short = (s, n = 80) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s))
const CONFIG_DENY = (rel, raw) => 'Việc này sửa chính cấu hình gác bộ chặn của kit (hook, quyền, MCP, agent, mã bộ chặn) nên kit không cho AI làm; AI sẽ dừng lại và báo bạn, không lách. ' +
  `Đích: ${short(raw)} (~/${rel}). Muốn đổi: bạn tự sửa file đó hoặc chạy lại bộ cài (node ~/.claude/install.mjs); lối thoát FLOW_OK không áp dụng cho việc này.`
const TOO_LONG = (raw) => `Đường dẫn đích quá dài (hơn ${PATH_LIMIT} ký tự sau khi chuẩn hoá) nên kit không kiểm được và không cho ghi; AI sẽ dùng đường dẫn ngắn hơn. Đích: ${short(raw)}`

// → null (cho qua) hoặc lý do chặn (một câu đời thường + chi tiết). g = { systemTarget, normPath }, sec = lib/secrets.mjs, toolName = tên tool agy.
// Mỗi đường dẫn: chuẩn hoá (~, $HOME, .., ổ đĩa) rồi kiểm cả tên đã chuẩn hoá lẫn ĐÍCH THẬT (realpath của file hoặc thư mục cha gần nhất đang tồn tại) với:
// cấu hình tự bảo vệ (lib/agy-guard.mjs), thư mục hệ thống/cá nhân, .git.
function checkEdit(args, cwd, g, sec, home, toolName = '') {
  const found = { paths: [], texts: [] }
  collectStrings(args, '', found, MOVE_TOOL.test(toolName))
  const destructive = /delete|remove|move|rename/i.test(toolName)
  const homes = homesOf(home)
  for (const raw of found.paths) {
    const c = canon(raw, cwd, home)
    const abs = c?.abs ?? path.resolve(cwd, raw) // biến chưa rõ ($X): công cụ ghi không nở biến ⇒ coi như tên thật
    if (abs.length > PATH_LIMIT) return TOO_LONG(raw)
    const forms = checkForms(abs, c?.rawAbs ?? null)
    const rel = configHit(forms, homes, { destructive, glob: c?.glob === true })
    if (rel) return CONFIG_DENY(rel, raw)
    for (const f of forms) {
      if (g.systemTarget(f, home) || GIT_DIR.test(g.normPath(f, home))) {
        return 'Ghi, sửa hoặc xoá trong thư mục hệ thống, thư mục cá nhân hoặc lịch sử .git thì không lấy lại được nên kit không cho làm; AI sẽ dừng việc này và chọn chỗ khác trong dự án. ' +
          `Đích: ${short(raw)}${f === abs ? '' : ` (thực chất là ${short(f)}, đi qua liên kết)`} (ổ gốc, Windows/Program Files, thư mục nhà, khoá SSH/AWS, .git). Thật sự cần ⇒ kể user sẽ mất gì và nhờ user tự làm.`
      }
    }
  }
  // Đích là file .env/khoá (isSensitiveFile) vốn là chỗ để khoá ⇒ không soát nội dung; chỗ khác có secret ⇒ chặn.
  if (found.paths.length > 0 && found.paths.every((p) => sec.isSensitiveFile(p))) return null
  const hits = []
  for (const text of found.texts) {
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length && hits.length < 10; i++) {
      if (lines[i].includes(sec.ALLOW_MARK)) continue
      for (const h of sec.scanLine(lines[i])) hits.push(`dòng ${i + 1} — ${h.name} (${h.value})`)
    }
  }
  if (hits.length === 0) return null
  return 'Nội dung sắp ghi có thứ giống mật khẩu hoặc khoá bí mật nên đã dừng lại; AI sẽ bỏ nó ra và dùng biến môi trường. ' +
    `Phát hiện: ${hits.join('; ')}. Khoá thật chỉ nằm trong file .env (đã được gitignore); báo nhầm thì thêm comment "${sec.ALLOW_MARK}" vào dòng đó.`
}

function mapGate(out) {
  if (out === null || out === undefined) return { decision: 'allow' }
  const h = out.hookSpecificOutput
  if (!isObj(h)) return failClosed('cổng trả kết quả lạ')
  if (h.permissionDecision === undefined) return typeof h.additionalContext === 'string' && h.additionalContext ? { decision: 'allow', reason: h.additionalContext } : { decision: 'allow' }
  if (!DECISIONS.has(h.permissionDecision)) return failClosed('cổng trả quyết định lạ')
  return { decision: h.permissionDecision, ...(h.permissionDecisionReason ? { reason: h.permissionDecisionReason } : {}) }
}

/**
 * Quyết định cho một payload PreToolUse đã parse. KHÔNG bao giờ ném: lỗi ⇒ deny. deps (cho test): { gate: { hookBash, systemTarget, normPath }, home }.
 * @returns {Promise<{decision:'allow'|'deny'|'ask', reason?:string}>}
 */
export async function decidePreTool(raw, deps = {}) {
  let tool = '?'
  try {
    if (!isObj(raw) || !isObj(raw.toolCall) || typeof raw.toolCall.name !== 'string' || raw.toolCall.name === '') return failClosed('payload PreToolUse không đúng dạng')
    tool = raw.toolCall.name
    const { normalize } = await import('./lib/host.mjs')
    const n = normalize(raw)
    const args = isObj(raw.toolCall.args) ? raw.toolCall.args : {}
    const home = deps.home ?? os.homedir()
    const base = path.resolve(n.cwd)
    let result
    if (n.tool === 'bash') {
      if (typeof n.command !== 'string') {
        result = failClosed('không thấy CommandLine để kiểm')
      } else {
        const g = deps.gate ?? await import('./flow-gate.mjs')
        const given = CWD_KEYS.map((k) => str(args[k])).find(nonBlank)
        const cwd = given ? path.resolve(base, given) : base
        // 1) Cấu hình gác chính bộ chặn (hooks.json, quyền, MCP, agent, mã bộ chặn): chặn cứng, FLOW_OK không vượt được.
        const guard = shellProtectedWrite(n.command, { cwd, home })
        if (guard) {
          result = { decision: 'deny', reason: CONFIG_DENY(guard.rel, guard.target) }
        } else {
          // 2) Cổng của kit. FLOW_OK= trong lệnh KHÔNG được làm cổng bỏ qua mọi kiểm tra (nội dung không đáng tin có thể dụ AI gõ nó): vô hiệu dấu ấy trước khi hỏi cổng,
          //    rồi vì lệnh tự xưng "user đã gật" nên KHÔNG cho qua lặng lẽ mà trả ask để user duyệt ngay trong agy (kèm việc cổng sẽ chặn).
          const hasOk = /FLOW_OK=/i.test(n.command)
          const command = hasOk ? n.command.replace(/FLOW_OK=/gi, 'FLOW_OK_X=') : n.command
          result = mapGate(await g.hookBash({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }, { strict: true }))
          if (hasOk && result.decision !== 'ask') {
            const why = result.decision === 'deny' ? ` Cổng của kit sẽ chặn vì: ${String(result.reason ?? '').split(/(?<=\.)\s/)[0]}` : ''
            result = { decision: 'ask', reason: `Lệnh có FLOW_OK= (lối thoát của kit khi bạn đã đồng ý) nên cần bạn duyệt ngay trong agy trước khi chạy.${why}` }
          }
        }
      }
    } else if (n.tool === 'edit') {
      const g = deps.gate ?? await import('./flow-gate.mjs')
      const sec = await import('./lib/secrets.mjs')
      const reason = checkEdit(args, base, g, sec, home, tool)
      result = reason ? { decision: 'deny', reason } : { decision: 'allow' }
    } else {
      result = { decision: 'allow' }
    }
    if (result.decision !== 'allow') log('pre-tool', `${result.decision} tool=${tool} kind=${n.tool}`)
    else if (process.env.AGY_HOOK_TRACE) log('pre-tool', `allow tool=${tool} kind=${n.tool}`)
    return result
  } catch (e) {
    log('pre-tool', `lỗi nội bộ tool=${tool}: ${errTag(e)}`)
    return failClosed()
  }
}

// ---------- PreToolUse: tiến trình ngoài ----------

function readStdin() {
  try { return fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '') } catch { return '' }
}

/** Tiến trình ngoài của pre-tool: chạy chế độ `--inner` trong tiến trình con có hạn giờ, chỉ chấp nhận stdout là JSON {decision: allow|deny|ask}. */
export function preToolOuter(text, { script = process.env.AGY_HOOK_INNER_SCRIPT || SELF, timeoutMs = INNER_TIMEOUT_MS } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    log('pre-tool', 'stdin rỗng')
    return failClosed('không nhận được dữ liệu từ agy')
  }
  const r = spawnSync(process.execPath, [script, 'pre-tool', '--inner'], { input: text, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 24 })
  if (r.error) {
    log('pre-tool', `tiến trình con: ${errTag(r.error)}`)
    return failClosed(r.error.code === 'ETIMEDOUT' ? 'quá giờ' : 'không chạy được phép kiểm')
  }
  if (r.status !== 0) {
    log('pre-tool', `tiến trình con thoát mã ${r.status}${r.signal ? ` tín hiệu ${r.signal}` : ''}`)
    return failClosed('phép kiểm thoát bất thường')
  }
  try {
    const out = JSON.parse(r.stdout)
    if (isObj(out) && DECISIONS.has(out.decision) && (out.reason === undefined || typeof out.reason === 'string')) return out
  } catch {}
  log('pre-tool', 'stdout của tiến trình con không phải quyết định hợp lệ')
  return failClosed('kết quả phép kiểm không hợp lệ')
}

async function preToolInner(text) {
  let raw
  try { raw = JSON.parse(text) } catch {
    log('pre-tool', 'stdin không phải JSON')
    return failClosed('dữ liệu từ agy không đọc được')
  }
  return decidePreTool(raw)
}

// ---------- Stop ----------

/** Stop của agy → hookStop của flow-gate. Chỉ nhắc khi agent kết thúc bình thường (NO_TOOL_CALL); lỗi ⇒ để agent dừng (không giữ phiên lại vì lỗi của hook). */
export async function decideStop(raw, deps = {}) {
  try {
    if (!isObj(raw)) return { decision: 'stop' }
    if (typeof raw.terminationReason === 'string' && raw.terminationReason !== 'NO_TOOL_CALL') return { decision: 'stop' }
    const g = deps.gate ?? await import('./flow-gate.mjs')
    const cwd = cwdOf(raw)
    const out = await g.hookStop({ hook_event_name: 'Stop', cwd, stop_hook_active: raw.continuationActive === true })
    if (out?.decision === 'block' && typeof out.reason === 'string') return { decision: 'continue', reason: out.reason }
    return { decision: 'stop' }
  } catch (e) {
    log('stop', `lỗi: ${errTag(e)}`)
    return { decision: 'stop' }
  }
}

// ---------- SessionStart ----------

/** Chạy session-start.mjs (cùng nguồn nạp sổ tiến độ + sổ chốt như Claude) và đổi kết quả sang injectSteps của agy. Lỗi ⇒ {} (không chặn phiên). */
export function buildSessionStart(raw, { script = path.join(HOOK_DIR, 'session-start.mjs'), timeoutMs = SESSION_TIMEOUT_MS, env = process.env } = {}) {
  try {
    const inp = isObj(raw) ? raw : {}
    const cwd = cwdOf(inp)
    const payload = { hook_event_name: 'SessionStart', source: 'startup', cwd, ...(str(inp.conversationId) ? { session_id: inp.conversationId } : {}) }
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 24, env })
    if (r.error || r.status !== 0) { log('session-start', `con: ${r.error ? errTag(r.error) : `mã ${r.status}`}`); return {} }
    if (!r.stdout.trim()) return {}
    const ctx = JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext
    return typeof ctx === 'string' && ctx ? { injectSteps: [{ systemMessage: { systemMessage: ctx } }] } : {}
  } catch (e) {
    log('session-start', `lỗi: ${errTag(e)}`)
    return {}
  }
}

// ---------- main ----------

const emit = (obj) => process.stdout.write(JSON.stringify(obj))

async function main(argv) {
  const [mode, flag] = argv
  if (mode === 'pre-tool') {
    emit(flag === '--inner' ? await preToolInner(readStdin()) : preToolOuter(readStdin()))
  } else if (mode === 'stop') {
    let raw = null
    try { raw = JSON.parse(readStdin()) } catch {}
    emit(await decideStop(raw))
  } else if (mode === 'session-start') {
    let raw = null
    try { raw = JSON.parse(readStdin()) } catch {}
    emit(buildSessionStart(raw))
  } else if (mode === 'deny-rules') {
    const { agyLayer2Deny } = await import('./lib/hostgen.mjs')
    process.stdout.write(JSON.stringify(agyLayer2Deny(), null, 2) + '\n')
  } else {
    console.error('Dùng: agy-hook.mjs pre-tool | stop | session-start | deny-rules')
    process.exitCode = 2
  }
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(SELF) } catch { return false }
})()

if (isMain) {
  try {
    await main(process.argv.slice(2))
  } catch (e) {
    // Lỗi ngoài dự kiến: pre-tool phải chặn; các chế độ khác im lặng (không giữ phiên lại vì lỗi của hook).
    log(process.argv[2] ?? '', `lỗi ngoài dự kiến: ${errTag(e)}`)
    if (process.argv[2] === 'pre-tool') emit(failClosed())
  }
}
