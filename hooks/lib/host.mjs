// host: nhận diện app gọi hook (claude / codex / devin) và chuẩn hoá payload về MỘT dạng cho flow-gate, flow-dispatch, session-start.
// Chỉ phân tích dữ liệu đã có trong payload; không đọc file, không ghi log, không ném lỗi với đầu vào bất kỳ.

// Tên tool (viết thường) → loại. Claude: Bash/Edit/Write/MultiEdit/NotebookEdit/Agent/Task · Codex: Bash, apply_patch, spawn_agent
// (PostToolUse thật thấy `collaborationspawn_agent`) · Devin: exec, edit, write, apply_patch, notebook_edit, run_subagent.
// So khớp không phân biệt hoa thường: cổng thà bắt dư hơn để lọt.
const TOOL_KIND = new Map([
  ['bash', 'bash'], ['exec', 'bash'], ['powershell', 'bash'], // PowerShell: tool lệnh của Claude Code trên Windows
  ['edit', 'edit'], ['write', 'edit'], ['multiedit', 'edit'], ['notebookedit', 'edit'], ['notebook_edit', 'edit'], ['apply_patch', 'edit'],
  ['agent', 'agent'], ['task', 'agent'], ['spawn_agent', 'agent'], ['collaborationspawn_agent', 'agent'], ['run_subagent', 'agent'],
])

// Tên tool CHỈ Devin dùng, và PHẢI viết thường đúng như tài liệu (Claude viết hoa: Read/Edit/Write/Bash/…).
const DEVIN_TOOLS = new Set([
  'read', 'write', 'edit', 'notebook_edit', 'grep', 'glob', 'exec', 'get_output', 'webfetch', 'skill', 'run_subagent', 'read_subagent',
])
// Tên tool chỉ Codex có (apply_patch có ở cả Devin nhưng chỉ khi bật codex_tools ⇒ trần, không dấu nào khác ⇒ coi là Codex).
const CODEX_TOOLS = new Set(['apply_patch', 'spawn_agent', 'collaborationspawn_agent'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v !== ''

// agy (Antigravity CLI): payload camelCase {hookEventName, cwd, toolCall:{id,name,args}} (docs hooks của agy 1.5.x; kết quả recon D:\tmp\agy-host\ket-qua.md).
// Tên tool của hook = tên step viết thường, bỏ tiền tố CORTEX_STEP_TYPE_; lệnh shell là `run_command` với args.CommandLine (đã kiểm theo docs).
// Tên tool GHI/SỬA file chưa xác nhận trên máy thật (docs agent nói write_file/edit_file, changelog nói write_to_file, step type là CODE_ACTION/FILE_CHANGE…)
// ⇒ nhận cả một bộ tên + một mẫu tên chứa write|edit|replace|patch|delete|remove|move|rename; tool lạ khớp mẫu vẫn bị soát, tool lạ không khớp thì cho qua.
// Danh sách dùng chung: hostgen.agyHooksJson lấy matcher từ agyPreToolMatcher() để hook đăng ký và bộ phân loại không lệch nhau.
export const AGY_BASH_TOOLS = ['run_command', 'shell_exec']
export const AGY_EDIT_TOOLS = ['write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'code_action', 'file_change', 'propose_code']
export const AGY_EDIT_PATTERN = '[a-z_]*(?:write|edit|replace|patch|delete|remove|move|rename)[a-z_]*|create_file'
const AGY_AGENT_TOOLS = new Set(['invoke_subagent', 'define_subagent', 'browser_subagent', 'run_subagent'])
const AGY_EDIT_RE = new RegExp(`^(?:${AGY_EDIT_PATTERN})$`)

/** Loại tool theo tên của agy: 'bash' | 'edit' | 'agent' | 'other'. */
export function agyToolKind(name) {
  const n = typeof name === 'string' ? name.toLowerCase() : ''
  if (AGY_BASH_TOOLS.includes(n)) return 'bash'
  if (AGY_EDIT_TOOLS.includes(n) || AGY_EDIT_RE.test(n)) return 'edit'
  if (AGY_AGENT_TOOLS.has(n)) return 'agent'
  return 'other'
}

/** Regex (cú pháp chạy được ở Go RE2 lẫn JS) cho matcher PreToolUse trong hooks.json của agy. */
export const agyPreToolMatcher = () => `^(?:${[...AGY_BASH_TOOLS, ...AGY_EDIT_TOOLS, AGY_EDIT_PATTERN].join('|')})$`

// Lệnh nằm ở args.CommandLine (docs); chấp nhận vài tên khoá khác phòng agy đổi tên.
const AGY_COMMAND_KEYS = ['CommandLine', 'commandLine', 'command', 'Command', 'cmd']
function agyCommand(args) {
  for (const k of AGY_COMMAND_KEYS) if (typeof args?.[k] === 'string') return args[k]
  return undefined
}

const isAgyPayload = (inp) => !nonEmpty(inp.hook_event_name) && (nonEmpty(inp.hookEventName) || isObj(inp.toolCall))

// Dấu hiệu theo thứ tự mạnh → yếu; không có dấu nào ⇒ claude.
//   agy   : camelCase `hookEventName` / `toolCall` (không có `hook_event_name` snake_case)
//   codex : `turn_id`, `model` gpt-*  (research.md §1.4, đã kiểm bằng codex exec thật)
//   devin : tên tool Devin viết thường; `prompt_id`/`tool_provenance` (tài liệu hooks Devin), env DEVIN_PROJECT_DIR — ba dấu này chỉ tính khi KHÔNG có
//           `transcript_path`: Claude Code cũng gửi `prompt_id` (từ 2026-10) và luôn có transcript_path; Devin không gửi trường này; Devin Desktop
//           làm vỏ chạy Claude thì env DEVIN_* có thể lọt vào hook của Claude
//   codex : tên tool chỉ Codex có (apply_patch/spawn_agent) khi chưa có dấu Devin
function detectHost(input, toolName, env) {
  if (isAgyPayload(input)) return 'agy'
  if (nonEmpty(input.turn_id) || (typeof input.model === 'string' && /^gpt-/i.test(input.model))) return 'codex'
  if (DEVIN_TOOLS.has(toolName)) return 'devin'
  if (!nonEmpty(input.transcript_path) && (nonEmpty(input.prompt_id) || input.tool_provenance != null || nonEmpty(env?.DEVIN_PROJECT_DIR))) return 'devin'
  if (CODEX_TOOLS.has(toolName)) return 'codex'
  return 'claude'
}

// input: payload JSON stdin của hook. env (tuỳ chọn, mặc định rỗng): người gọi truyền process.env nếu muốn dùng DEVIN_PROJECT_DIR
// (không tự đọc process.env để kết quả không phụ thuộc máy chạy). Đầu vào không phải object ⇒ khung an toàn {host:'claude', tool:'other'}.
// → {host:'claude'|'codex'|'devin'|'agy', event, tool:'bash'|'edit'|'agent'|'other', command?, cwd}
//   command chỉ có khi tool='bash' và command là chuỗi.
export function normalize(input, env = {}) {
  const inp = isObj(input) ? input : {}
  if (isAgyPayload(inp)) {
    const call = isObj(inp.toolCall) ? inp.toolCall : {}
    const tool = agyToolKind(call.name)
    const cwd = [inp.cwd, ...(Array.isArray(inp.workspacePaths) ? inp.workspacePaths : [])].find((v) => typeof v === 'string' && v.trim() !== '') ?? process.cwd() // cwd rỗng/toàn khoảng trắng ⇒ workspacePaths[0]
    const out = { host: 'agy', event: typeof inp.hookEventName === 'string' ? inp.hookEventName : '', tool, cwd }
    const command = tool === 'bash' ? agyCommand(isObj(call.args) ? call.args : {}) : undefined
    if (command !== undefined) out.command = command
    return out
  }
  const ti = isObj(inp.tool_input) ? inp.tool_input : {}
  const rawName = typeof inp.tool_name === 'string' ? inp.tool_name : ''
  const lower = rawName.toLowerCase()
  const tool = TOOL_KIND.get(lower) ?? 'other'
  const out = {
    host: detectHost(inp, rawName, env),
    event: typeof inp.hook_event_name === 'string' ? inp.hook_event_name : '',
    tool,
    cwd: nonEmpty(inp.cwd) ? inp.cwd : process.cwd(),
  }
  if (tool === 'bash' && typeof ti.command === 'string') out.command = ti.command
  return out
}
