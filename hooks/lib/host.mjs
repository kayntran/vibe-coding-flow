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

// Đường dẫn file mà tiêu đề patch Codex nhắc tới: `*** Add/Update/Delete File: <path>` và `*** Move to: <path>`.
// Cho phép thụt lề đầu dòng (bộ đọc patch của Codex tự cắt khoảng trắng; hiếm khi dòng ngữ cảnh trùng mẫu ⇒ dư một file, không sót).
// Dòng nội dung bắt đầu bằng `+`/`-` thì không khớp. Giữ nguyên văn đường dẫn (tương đối so với cwd), bỏ trùng, giữ thứ tự xuất hiện.
const PATCH_HEADER = /^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): *(.*?)\s*$/

export function patchFiles(patchText) {
  if (typeof patchText !== 'string') return []
  const out = []
  for (const line of patchText.split(/\r?\n/)) {
    const m = PATCH_HEADER.exec(line)
    if (m?.[1]) out.push(m[1])
  }
  return [...new Set(out)]
}

// Dấu hiệu theo thứ tự mạnh → yếu; không có dấu nào ⇒ claude.
//   codex : `turn_id`, `model` gpt-*  (research.md §1.4, đã kiểm bằng codex exec thật)
//   devin : tên tool Devin viết thường; `prompt_id`/`tool_provenance` (tài liệu hooks Devin), env DEVIN_PROJECT_DIR — ba dấu này chỉ tính khi KHÔNG có
//           `transcript_path`: Claude Code cũng gửi `prompt_id` (từ 2026-10) và luôn có transcript_path; Devin không gửi trường này; Devin Desktop
//           làm vỏ chạy Claude thì env DEVIN_* có thể lọt vào hook của Claude
//   codex : tên tool chỉ Codex có (apply_patch/spawn_agent) khi chưa có dấu Devin
function detectHost(input, toolName, env) {
  if (nonEmpty(input.turn_id) || (typeof input.model === 'string' && /^gpt-/i.test(input.model))) return 'codex'
  if (DEVIN_TOOLS.has(toolName)) return 'devin'
  if (!nonEmpty(input.transcript_path) && (nonEmpty(input.prompt_id) || input.tool_provenance != null || nonEmpty(env?.DEVIN_PROJECT_DIR))) return 'devin'
  if (CODEX_TOOLS.has(toolName)) return 'codex'
  return 'claude'
}

// File mà tool loại `edit` sẽ ghi: file_path (Edit/Write/MultiEdit) · notebook_path (NotebookEdit) · patch trong tool_input.command (Codex apply_patch).
// `path` là dự phòng cho Devin (tên field thật của edit/write chưa kiểm — research-devin §4): thà đọc thêm một tên còn hơn cổng mù.
function editFiles(toolName, ti) {
  if (toolName === 'apply_patch') return patchFiles([ti.command, ti.patch, ti.input].find((v) => typeof v === 'string'))
  const paths = [ti.file_path, ti.notebook_path].filter(nonEmpty)
  if (!paths.length && nonEmpty(ti.path)) paths.push(ti.path)
  return [...new Set(paths)]
}

// input: payload JSON stdin của hook. env (tuỳ chọn, mặc định rỗng): người gọi truyền process.env nếu muốn dùng DEVIN_PROJECT_DIR
// (không tự đọc process.env để kết quả không phụ thuộc máy chạy). Đầu vào không phải object ⇒ khung an toàn {host:'claude', tool:'other', files:[]}.
// → {host:'claude'|'codex'|'devin', event, tool:'bash'|'edit'|'agent'|'other', command?, files, cwd}
//   command chỉ có khi tool='bash' và command là chuỗi; files chỉ khác rỗng khi tool='edit' (đường dẫn nguyên văn, chưa resolve với cwd).
//   Muốn xem patch trong lệnh Bash (apply_patch <<EOF …): gọi patchFiles(command).
export function normalize(input, env = {}) {
  const inp = isObj(input) ? input : {}
  const ti = isObj(inp.tool_input) ? inp.tool_input : {}
  const rawName = typeof inp.tool_name === 'string' ? inp.tool_name : ''
  const lower = rawName.toLowerCase()
  const tool = TOOL_KIND.get(lower) ?? 'other'
  const out = {
    host: detectHost(inp, rawName, env),
    event: typeof inp.hook_event_name === 'string' ? inp.hook_event_name : '',
    tool,
    files: tool === 'edit' ? editFiles(lower, ti) : [],
    cwd: nonEmpty(inp.cwd) ? inp.cwd : process.cwd(),
  }
  if (tool === 'bash' && typeof ti.command === 'string') out.command = ti.command
  return out
}
