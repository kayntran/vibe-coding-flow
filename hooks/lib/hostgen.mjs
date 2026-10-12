// Bản xuất từ nguồn chung (ADR-0003/0004). Hàm thuần: không đọc/ghi file, không resolve model hay gọi CLI.
// Installer truyền text/registry và kết quả models.resolve('codex', role), rồi tự ghi bản xuất.
// Schema đối chiếu 2026-10-11:
// https://learn.chatgpt.com/docs/agent-configuration/subagents
// https://learn.chatgpt.com/docs/hooks (JSON: commandWindows; command_windows là alias TOML).
// Chưa chắc: research §1.4 chưa thấy PreToolUse khi spawn dù docs hiện liệt kê spawn_agent/Agent.
// Có đăng ký matcher, nhưng KHÔNG coi hook spawn là ranh giới cưỡng chế; cần QA host thật ở làn I.
import { Buffer } from 'node:buffer'

const GENERATED = 'tự sinh bởi vibe-flow — đừng sửa tay'
const START = '<!-- VIBE-FLOW:START -->'
const END = '<!-- VIBE-FLOW:END -->'
const MAX_AGENTS_BYTES = 24 * 1024
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const TOOL_DICTIONARY = `## Từ điển công cụ Claude → Codex

Tên công cụ trong luật/skill/agent nguồn là tên Claude; trên Codex làm tương đương như sau:
- Agent / Task → spawn_agent (có thể hiện là collaboration.spawn_agent); dùng đúng vai, brief và scope.
- AskUserQuestion → hỏi thẳng trong chat, chờ câu trả lời khi quyết định cần user; không giả định có tool này.
- EnterWorktree / isolation: worktree → git worktree add rồi làm trong đó; không có cô lập worktree tự động theo agent.
- ExitPlanMode → trình plan rồi chờ user duyệt trước khi làm bước cần duyệt.
- Bash → exec_command; Read / Glob / Grep → lệnh đọc và rg / rg --files.
- Edit / Write / NotebookEdit → apply_patch hoặc công cụ sửa được host cung cấp, giữ nguyên scope và cổng hook.
- run_in_background → chạy nền của Codex: exec_command với yield_time_ms, giữ session_id rồi dùng write_stdin;
  với code mode, giữ cell_id và dùng wait của host. Không truyền run_in_background như tham số Codex.

Codex không hỗ trợ @import: luật đã được nhúng trong khối này. Skill chung ở ~/.agents/skills;
agent Codex ở ~/.codex/agents/*.toml. Luật dự án vẫn thắng luật của kit.
Hook không do admin quản cần user trust qua /hooks. Không coi hook spawn là ranh giới cưỡng chế:
research chưa xác nhận PreToolUse bắt spawn trên mọi bản; vai chỉ đọc dùng sandbox read-only và lời dặn.
`

function text(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} phải là chuỗi.`)
  return value.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
}

/** Khối dành để installer chèn/thay giữa marker; quá cỡ thì lỗi, không cắt bỏ luật. */
export function codexAgentsBlock(claudeMdText) {
  const rules = text(claudeMdText, 'claudeMdText').trim()
  if (rules.includes(START) || rules.includes(END)) throw new Error('CLAUDE.md chứa marker VIBE-FLOW lồng nhau.')
  if (/^\s*@\S+/m.test(rules)) throw new Error('Cần mở rộng @import trong nguồn trước khi sinh AGENTS; hostgen không đọc file.')
  const block = `${START}\n<!-- ${GENERATED} -->\n\n${rules}\n\n${TOOL_DICTIONARY}\n${END}\n`
  if (Buffer.byteLength(block, 'utf8') > MAX_AGENTS_BYTES) throw new RangeError('Khối AGENTS vượt 24 KiB; rút gọn nguồn rồi sinh lại, không cắt luật.')
  return block
}

// Chỉ đọc subset frontmatter nguồn kit: scalar plain/quoted và description folded/literal.
// Không phải YAML parser tổng quát: cấu trúc/anchor/tag YAML cho name/description báo lỗi để không đoán.
function field(frontmatter, key) {
  const lines = frontmatter.split('\n')
  const indexes = lines.flatMap((line, i) => line.startsWith(`${key}:`) ? [i] : [])
  if (indexes.length !== 1) throw new Error(`Frontmatter cần đúng một ${key}.`)
  const i = indexes[0]
  const raw = lines[i].slice(key.length + 1).trim()
  if (/^[|>][-+]?$/.test(raw)) {
    const rest = []
    for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || !lines[j]); j++) rest.push(lines[j])
    const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length))
    const content = rest.map((l) => l.slice(indent)).join('\n').trimEnd()
    const result = raw[0] === '>' ? content.replace(/([^\n])\n(?=[^\n])/g, '$1 ') : content
    return result + (raw.endsWith('-') ? '' : '\n')
  }
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw) } catch { throw new Error(`Frontmatter ${key}: chuỗi nháy kép không hợp lệ (chỉ hỗ trợ escape JSON).`) }
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) throw new Error(`Frontmatter ${key}: chuỗi nháy đơn không hợp lệ.`)
    return raw.slice(1, -1).replaceAll("''", "'")
  }
  if (/^[\[\]{},&*!|>]/.test(raw)) throw new Error(`Frontmatter ${key}: cần scalar, không hỗ trợ cấu trúc YAML.`)
  return raw
}

// TOML basic string cùng escape JSON cho dữ liệu nguồn; DEL bị TOML cấm phải escape riêng.
// Không dùng triple quotes: thân có """, \ hay dòng model=… không thể đóng chuỗi/chèn khoá.
function tomlString(value) {
  if (typeof value !== 'string') throw new TypeError('Giá trị TOML phải là chuỗi.')
  if (value.isWellFormed && !value.isWellFormed()) throw new Error('Giá trị TOML chứa Unicode surrogate không hợp lệ.')
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f')
}

/**
 * rolesJson = object kit/roles.json đã parse; resolvedModel = {model:string|null, effort:string|null}.
 * Không truyền resolver ⇒ bỏ model và dùng effort Codex từ registry, KHÔNG lấy model/effort Claude.
 * Resolver effort:null ⇒ bỏ khoá effort để host kế thừa. Vai writesCode:true kế thừa sandbox cha.
 */
export function codexAgentToml(agentMdText, rolesJson, resolvedModel) {
  const source = text(agentMdText, 'agentMdText')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source)
  if (!match) throw new Error('Agent thiếu frontmatter --- hợp lệ.')
  const name = field(match[1], 'name')
  const description = field(match[1], 'description')
  const body = match[2].trim()
  if (!name || !description.trim() || !body) throw new Error('Agent cần name, description và thân chỉ dẫn không rỗng.')
  const role = Object.hasOwn(rolesJson?.roles ?? {}, name) ? rolesJson.roles[name] : null
  if (!role) throw new Error(`Không tìm thấy vai ${name} trong kit/roles.json.`)
  if (typeof role.writesCode !== 'boolean') throw new Error(`Vai ${name} thiếu writesCode boolean.`)
  if (resolvedModel != null && (typeof resolvedModel !== 'object' || Array.isArray(resolvedModel))) {
    throw new TypeError('resolvedModel phải là kết quả resolve: {model, effort}.')
  }
  const model = resolvedModel?.model ?? null
  const effort = resolvedModel?.effort === undefined ? role.models?.codex?.effort : resolvedModel.effort
  if (model !== null && (typeof model !== 'string' || !model.trim())) throw new Error('resolvedModel.model cần slug không rỗng hoặc null.')
  if (effort != null && !EFFORTS.has(effort)) throw new Error(`Codex effort không hợp lệ: ${effort}.`)
  if (effort === undefined) throw new Error(`Vai ${name} thiếu effort Codex; cần truyền kết quả resolver.`)
  const instructions = body + (role.writesCode ? '' : '\n\nTrên Codex, vai này chỉ đọc (sandbox read-only): không sửa file, không chạy lệnh ghi; cần ghi báo cáo thì trả nội dung cho captain.')
  const rows = [
    `# ${GENERATED}`,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlString(instructions)}`,
  ]
  if (model !== null) rows.push(`model = ${tomlString(model)}`)
  if (effort !== null) rows.push(`model_reasoning_effort = ${tomlString(effort)}`)
  if (!role.writesCode) rows.push('sandbox_mode = "read-only"')
  return rows.join('\n') + '\n'
}

function kitPath(kitRoot) {
  if (typeof kitRoot !== 'string' || !kitRoot || /[\u0000\r\n"$`%]/.test(kitRoot)) throw new TypeError('kitRoot cần đường dẫn tuyệt đối không chứa NUL/newline hay " $ ` %.')
  const root = kitRoot.replaceAll('\\', '/')
  if (!root.startsWith('/') && !/^[a-zA-Z]:\//.test(root)) throw new Error('kitRoot cần đường dẫn tuyệt đối.')
  return root.replace(/\/+$/, '')
}

// Nháy kép chạy được ở bash, sh, cmd lẫn PowerShell (hook Claude trên Windows có thể chạy qua cmd — nháy đơn sẽ vỡ).
// kitPath đã từ chối ký tự còn có nghĩa trong nháy kép (" $ ` %), nên không cần escape.
const shellQuote = (s) => `"${s}"`
const powershellQuote = (s) => `'${s.replaceAll("'", "''")}'`

function command(root, script, arg, timeout, codex) {
  const file = `${root}/hooks/${script}`
  const args = arg ? ` ${arg}` : ''
  const hook = { type: 'command', command: `node ${shellQuote(file)}${args}`, timeout }
  if (codex) {
    // Windows host có thể dùng cmd hoặc PowerShell: encoded literal tránh expansion ở cả hai.
    // PowerShell phải trả exit của node, nếu không exit 2 (hook chặn) sẽ biến thành thành công.
    const ps = `$ErrorActionPreference = 'Stop'; & node ${powershellQuote(file)}${args}; exit $LASTEXITCODE`
    hook.commandWindows = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`
  }
  return hook
}

function entries(kitRoot, codex) {
  const root = kitPath(kitRoot)
  const cmd = (script, arg, timeout) => command(root, script, arg, timeout, codex)
  return [
    ['UserPromptSubmit', undefined, cmd('reply-vietnamese.mjs', '', 5)],
    ['PreToolUse', codex ? '^(Edit|Write|apply_patch)$' : '^(Edit|Write|MultiEdit|NotebookEdit|edit|write|apply_patch|notebook_edit)$', cmd('flow-gate.mjs', 'edit', 15)],
    ['PreToolUse', codex ? '^Bash$' : '^(Bash|exec)$', cmd('flow-gate.mjs', 'bash', 15)],
    ['Stop', undefined, cmd('flow-gate.mjs', 'stop', 15)],
    ['SubagentStop', undefined, cmd('flow-gate.mjs', 'subagent-stop', 15)],
    ['SessionStart', undefined, cmd('session-start.mjs', '', 10)],
    ['PostToolUse', '^mcp__.*', cmd('mcp-usage.mjs', 'log', 5)],
    ['PreToolUse', codex ? '^(Agent|spawn_agent|collaborationspawn_agent)$' : '^(Agent|Task|run_subagent)$', cmd('flow-dispatch.mjs', 'agent', 30)],
    ['Stop', undefined, cmd('flow-dispatch.mjs', 'stop', 15)],
  ]
}

/** Tuple [event, matcher|undefined, commandHook][] — cùng wanted trong install.mjs. */
export function claudeHooks(kitRoot) {
  return entries(kitRoot, false)
}

/** Object để installer JSON.stringify vào ~/.codex/hooks.json; trust/config do installer nhắc. */
export function codexHooksJson(kitRoot) {
  const hooks = {}
  for (const [event, matcher, hook] of entries(kitRoot, true)) {
    const group = matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] }
    ;(hooks[event] ??= []).push(group)
  }
  return { description: GENERATED, hooks }
}
