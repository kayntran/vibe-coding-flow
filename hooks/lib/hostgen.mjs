// Bản xuất từ nguồn chung (ADR-0003/0004). Hàm thuần: không đọc/ghi file, không resolve model hay gọi CLI.
// Installer truyền text/registry và kết quả models.resolve('codex', role), rồi tự ghi bản xuất.
// Schema đối chiếu 2026-10-11:
// https://learn.chatgpt.com/docs/agent-configuration/subagents
// https://learn.chatgpt.com/docs/hooks (JSON: commandWindows; command_windows là alias TOML).
// Chưa chắc: research §1.4 chưa thấy PreToolUse khi spawn dù docs hiện liệt kê spawn_agent/Agent.
// Có đăng ký matcher, nhưng KHÔNG coi hook spawn là ranh giới cưỡng chế; cần QA host thật ở làn I.
import { Buffer } from 'node:buffer'
import { agyPreToolMatcher } from './host.mjs'

const GENERATED = 'tự sinh bởi vibe-flow — đừng sửa tay'
const START = '<!-- VIBE-FLOW:START -->'
const END = '<!-- VIBE-FLOW:END -->'
const MAX_AGENTS_BYTES = 24 * 1024
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const TOOL_DICTIONARY = `## Từ điển công cụ Claude → Codex

Tên công cụ trong luật/skill/agent nguồn là tên Claude; trên Codex làm tương đương như sau:
- Agent / Task → spawn_agent (có thể hiện là collaboration.spawn_agent); dùng đúng vai, brief và scope.
- AskUserQuestion → hỏi thẳng trong chat, chờ câu trả lời khi quyết định cần user; không giả định có tool này. Gom các câu vào
  một tin; mỗi câu đánh số, phương án dạng 1a/1b/1c kèm một câu lý do, đúng một phương án ghi "(Khuyên dùng)".
- mcp__so-chot__* → \`node ~/.claude/hooks/lib/so-chot.mjs <ghi|tim|y-tuong|da-xem> <gốc dự án> '<json>'\` (cùng trường với tool).
- mcp__kho-khoa__* → \`node ~/.claude/hooks/khoa.mjs ds | luu <TÊN> - (giá trị qua stdin) | lay <TÊN> [thư mục dự án] [--as TÊN_ENV] | thay <TÊN> <TÊN_2>\`.
  User dán khoá ⇒ cất bằng \`luu\`, báo bằng tên; không in giá trị khoá ra câu trả lời, không đọc hay in giá trị trong .env.
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

/**
 * Khối dành để installer chèn/thay giữa marker; quá cỡ thì lỗi, không cắt bỏ luật.
 * ruleTexts = nội dung rules/*.md của kit: Codex không có luật nạp theo `paths:` nên nhúng luôn, bỏ frontmatter.
 */
export function codexAgentsBlock(claudeMdText, ruleTexts = []) {
  const extra = ruleTexts.map((r, i) => text(r, `ruleTexts[${i}]`).replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').trim()).filter(Boolean)
  const rules = [text(claudeMdText, 'claudeMdText').trim(), ...extra].join('\n\n')
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
 * rolesJson = object kit/roles.json đã parse; resolvedModel = {model:string|null, effort:string|null} của resolve('codex', vai) MẶC ĐỊNH (chọn theo hạng, chỉ trong Codex);
 * kết quả của Factory (host:'droid', do allowFallbackHost) bị từ chối: id đó không chạy được trong TOML của Codex.
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
  if (resolvedModel?.host !== undefined && resolvedModel.host !== 'codex') throw new Error(`resolvedModel của ${resolvedModel.host} không dùng được cho Codex (dùng resolve('codex', vai) không bật allowFallbackHost).`)
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
    ['PreToolUse', codex ? '^Bash$' : '^(Bash|PowerShell|exec)$', cmd('flow-gate.mjs', 'bash', 15)], // PowerShell: tool lệnh của Claude Code trên Windows, cùng cổng như Bash
    ['Stop', undefined, cmd('flow-gate.mjs', 'stop', 15)],
    ['SubagentStop', undefined, cmd('flow-gate.mjs', 'subagent-stop', 15)],
    ['SessionStart', undefined, cmd('session-start.mjs', '', 10)],
    ['PostToolUse', '^mcp__.*', cmd('mcp-usage.mjs', 'log', 5)],
    ['PreToolUse', codex ? '^(Agent|spawn_agent|collaborationspawn_agent)$' : '^(Agent|Task|run_subagent)$', cmd('flow-dispatch.mjs', 'agent', 30)],
    ['PreToolUse', codex ? '^Bash$' : '^(Bash|PowerShell|exec)$', cmd('flow-dispatch.mjs', 'commit', 15)], // git commit mà sổ tiến độ chưa vào commit ⇒ nhắc một dòng (không chặn)
    ['Stop', undefined, cmd('flow-dispatch.mjs', 'stop', 15)],
    // Tin có khoá hoặc nhắc tới khoá ⇒ nhắc AI không in giá trị khoá (chốt i0gg, như AgentKit: không che, không chặn). Claude lẫn Codex.
    ['UserPromptSubmit', undefined, cmd('khoa.mjs', 'prompt', 10)],
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

// ---------- Antigravity (agy) ----------
// Nguồn đối chiếu 2026-11-28: docs đi kèm CLI (agy 1.5.19) ~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/{rules,skills,hooks,mcp_servers}.md,
// skill migrate-agent-settings (tên tool của agent), D:\tmp\agy-host\ket-qua.md. Luật: ~/.gemini/AGENTS.md (CLI + IDE đọc, không frontmatter, ≤ 24.000 byte
// sau khi mở `@[nhãn](đường dẫn)`); agent: ~/.gemini/config/agents/<vai>.md (frontmatter name, description, tools, subagent, mainAgent, model: inherit|flash|pro);
// hook: ~/.gemini/config/hooks.json (khoá cấp một = TÊN hook; PreToolUse có matcher, SessionStart/Stop là danh sách phẳng).
// Chưa chắc (chỉ kiểm được trên máy thật bằng agy -p): tên tool GHI file mà hook PreToolUse nhìn thấy; hooks/lib/host.mjs nhận cả một bộ tên + mẫu tên.

const MAX_AGY_BYTES = 24000 // docs rules.md: mỗi file luật ≤ 24.000 byte (đây chưa tính phần của user trong cùng file)
export const AGY_HOOK_NAME = 'vibe-flow' // khoá của kit trong hooks.json của agy: cài lại thì thay đúng khoá này, khoá khác của user để nguyên
const AGY_BUILTIN_AGENTS = new Set(['self', 'browser', 'research', 'deepagent', 'review-agent'])

const AGY_TOOL_DICTIONARY = `## Từ điển công cụ Claude → Antigravity (agy)

Tên công cụ trong luật/skill/agent nguồn là tên Claude Code; trên Antigravity làm tương đương như sau (không có công cụ nào khác ngoài danh sách công cụ bạn đang được cấp):
- Read / Glob / Grep → công cụ đọc file của agy (read_file); tìm trong thư mục dùng rg qua run_command (\`rg -n …\`, \`rg --files\`), thư mục bị git bỏ qua thêm \`-uu\`.
- Edit / MultiEdit / Write / NotebookEdit → công cụ sửa và ghi file của agy (edit_file, write_file); giữ nguyên scope được giao.
- Bash / PowerShell → run_command (shell của Windows: viết đường dẫn đầy đủ, không dựa vào cd rồi dùng ký tự đại diện).
- run_in_background → chạy lệnh dài ở chế độ nền của run_command nếu có; nếu không thì để lệnh chạy xong rồi đọc kết quả, không bỏ dở.
- Agent / Task → invoke_subagent (hoặc \`@<vai>\` trong lời nhắc) với vai ở ~/.gemini/config/agents/<vai>.md; brief theo khuôn outcome/scope/constraints/accept. isolation: worktree → git worktree add rồi làm trong thư mục đó.
- AskUserQuestion → hỏi thẳng trong chat, chờ trả lời khi quyết định cần user; không giả định có công cụ này. Gom các câu vào một tin; mỗi câu đánh số, phương án dạng 1a/1b/1c kèm một câu lý do, đúng một phương án ghi "(Khuyên dùng)".
- TaskCreate / TodoWrite → manage_task.
- WebSearch / WebFetch → search_web (và công cụ đọc URL của agy).
- ExitPlanMode → trình plan rồi chờ user duyệt trước khi làm bước cần duyệt.
- mcp__so-chot__* → máy chủ MCP \`so-chot\` với năm công cụ ghi_chot, tim_chot, ghi_y_tuong, da_xem, ghi_so (cùng trường như bản Claude); luôn điền \`du_an\` = đường dẫn tuyệt đối của thư mục dự án đang làm. Cùng một sổ với Claude: \`node ~/.claude/hooks/lib/so-chot.mjs <ghi|tim|y-tuong|da-xem|ghi-so> <gốc dự án> '<json>'\` cho kết quả như nhau.
- mcp__kho-khoa__* → \`node ~/.claude/hooks/khoa.mjs ds | luu <TÊN> - (giá trị qua stdin) | lay <TÊN> [thư mục dự án] [--as TÊN_ENV] | thay <TÊN> <TÊN_2>\`. User dán khoá ⇒ cất bằng \`luu\`, báo bằng tên; không in giá trị khoá, không đọc hay in giá trị trong .env.
- Hook của Claude (UserPromptSubmit, SubagentStop…) không có ở agy: các phần luật nhắc qua hook đó thì tự giữ kỷ luật theo luật; việc cổng chặn làm (xoá thư mục hệ thống/cá nhân/.git, push ép nhánh chính, xoá database, lộ khoá khi commit/ghi file) vẫn chạy ở agy qua hook PreToolUse của kit: bị chặn (deny) ⇒ đọc lý do, làm cách khác, không lách; user đã gật bằng lời thì chạy lại lệnh với tiền tố FLOW_OK=1 (PowerShell: \`$env:FLOW_OK=1;\`) đúng một lần — ở agy lệnh đó còn hiện hộp hỏi user duyệt (ask), không tự chạy. Riêng cấu hình gác chính bộ chặn (~/.gemini/config/hooks.json, mcp_config.json, agents/, ~/.gemini/antigravity-cli/settings.json, ~/.gemini/settings.json, ~/.gemini/AGENTS.md, ~/.claude/hooks, ~/.claude/kit, ~/.claude/settings.json) AI không được ghi/sửa/xoá/di chuyển, cả bằng công cụ ghi file lẫn lệnh shell, FLOW_OK cũng không mở được: cần đổi thì nhờ user chạy lại bộ cài.

### Giao việc cho worker (bảng chia việc ở skill flow-team; chọn model theo HẠNG của vai, không ghi cứng id)
- Trước khi gọi CLI ngoài: \`node ~/.claude/hooks/cli-check.mjs <tên>\` (codex, claude, agy…); chưa sẵn sàng ⇒ dùng vai ở ~/.gemini/config/agents hoặc tự làm.
- Codex: \`node ~/.claude/hooks/codex-run.mjs exec --sandbox read-only --vai <vai> -C "<thư mục>" -o "<kết quả.md>" - < brief.md\` (vai ghi được code thì bỏ --sandbox read-only và giao trong worktree riêng); đọc kết quả ở file -o.
- Claude: chạy trong thư mục (worktree) của việc: \`claude -p "<brief>" --model <opus|sonnet|haiku>\` (dòng theo vai: \`node ~/.claude/hooks/models.mjs pick claude <vai>\`); đọc câu trả lời ở stdout.
- agy (chính nó): vai trong ~/.gemini/config/agents qua invoke_subagent; cần phiên riêng thì \`agy -p "<brief>" --model "$(node ~/.claude/hooks/models.mjs pick agy <vai>)"\` chạy trong thư mục của việc.
- Mọi worker trả receipt \`return=…; paths=…; checks=…\` ngắn gọn; captain đọc diff rồi mới gộp. Không giao việc ghi file cho vai chỉ đọc.

### Phạm vi của Antigravity
- Skill flow-* của kit nằm ở ~/.gemini/config/skills/ (gõ /<tên-skill> hoặc để agent tự kích hoạt khi mô tả khớp); skill nào vượt 24 KB bị agy cắt/cảnh báo — đọc thêm file trong references/ của skill đó khi cần.
- Luật này ở ~/.gemini/AGENTS.md và cộng dồn với luật của dự án đang mở (GEMINI.md/AGENTS.md trong dự án). Luật dự án vẫn thắng luật của kit.
`

/** Gộp CLAUDE.md + rules/*.md (bỏ frontmatter paths: agy không nạp luật theo loại file ở cấp toàn cục) thành một đoạn luật. */
function joinRules(claudeMdText, ruleTexts) {
  const extra = ruleTexts.map((r, i) => text(r, `ruleTexts[${i}]`).replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').trim()).filter(Boolean)
  return [text(claudeMdText, 'claudeMdText').trim(), ...extra].join('\n\n')
}

/**
 * Khối luật cho ~/.gemini/AGENTS.md (cùng marker VIBE-FLOW như Codex ⇒ spliceAgents của installer dùng lại nguyên): luật kit + từ điển công cụ agy
 * + cách giao worker. Quá 24.000 byte ⇒ lỗi, không cắt luật. Cú pháp include `@[nhãn](đường dẫn)` của agy trong nguồn bị từ chối (agy sẽ nhúng file khác vào luật).
 */
export function agyAgentsBlock(claudeMdText, ruleTexts = []) {
  const rules = joinRules(claudeMdText, ruleTexts)
  if (rules.includes(START) || rules.includes(END)) throw new Error('CLAUDE.md chứa marker VIBE-FLOW lồng nhau.')
  if (/^\s*@\S+/m.test(rules)) throw new Error('Cần mở rộng @import trong nguồn trước khi sinh AGENTS; hostgen không đọc file.')
  if (/@\[[^\]\n]*\]\([^)\n]*\)/.test(rules)) throw new Error('Nguồn luật chứa cú pháp include @[nhãn](đường dẫn) của agy: agy sẽ nhúng file khác vào luật; bỏ hoặc viết lại.')
  const block = `${START}\n<!-- ${GENERATED} -->\n\n${rules}\n\n${AGY_TOOL_DICTIONARY}\n${END}\n`
  if (Buffer.byteLength(block, 'utf8') > MAX_AGY_BYTES) throw new RangeError('Khối AGENTS cho agy vượt 24.000 byte; rút gọn nguồn rồi sinh lại, không cắt luật.')
  return block
}

// Frontmatter phẳng của agent nguồn; trả undefined khi không có khoá (khác field(): không ném).
function optField(frontmatter, key) {
  return frontmatter.split('\n').some((l) => l.startsWith(`${key}:`)) ? field(frontmatter, key) : undefined
}

// Tên tool Claude → tên tool trong `tools` của agent agy (skill migrate-agent-settings của agy). Tool không có tương đương bị bỏ.
const AGY_TOOL_OF = {
  read: ['read_file'], glob: ['read_file'], grep: ['read_file'], ls: ['read_file'],
  edit: ['edit_file'], multiedit: ['edit_file'], notebookedit: ['edit_file'], write: ['write_file'],
  bash: ['run_command', 'manage_task'], powershell: ['run_command', 'manage_task'],
  websearch: ['search_web'], webfetch: ['search_web'],
  agent: ['invoke_subagent'], task: ['invoke_subagent'],
}
const AGY_TOOL_ORDER = ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web', 'invoke_subagent']
const AGY_WRITE_TOOLS = new Set(['edit_file', 'write_file'])
const AGY_ALL_TOOLS = ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web'] // agent Claude không khai tools = mọi tool

// Hạng của vai → model thô của agent agy (inherit | flash | pro): mạnh = model của phiên (người dùng chọn), vừa = pro, nhanh = flash.
// Hạng lấy ở models.agy nếu có, rồi codex, rồi droid (cùng một hạng vai [vmdk]); không có ⇒ inherit.
const AGY_MODEL_OF_TIER = { manh: 'inherit', vua: 'pro', nhanh: 'flash' }
function agyModelOf(role) {
  const tier = role.models?.agy?.tier ?? role.models?.codex?.tier ?? role.models?.droid?.tier
  return AGY_MODEL_OF_TIER[tier] ?? 'inherit'
}

/**
 * agentMdText = agents/<vai>.md nguồn (Claude); rolesJson = kit/roles.json đã parse (hoặc loadRoles()). Trả file Markdown cho ~/.gemini/config/agents/<vai>.md:
 * giữ name, description, thân; bỏ model/effort/color/maxTurns của Claude; `tools` ghi tường minh bằng tên tool agy (agent không khai tools ⇒ bộ đầy đủ);
 * vai writesCode:false không có edit_file/write_file và được dặn chỉ đọc (như sandbox read-only của Codex); `model` thô theo hạng của vai.
 */
export function agyAgentMd(agentMdText, rolesJson) {
  const source = text(agentMdText, 'agentMdText')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source)
  if (!match) throw new Error('Agent thiếu frontmatter --- hợp lệ.')
  const name = field(match[1], 'name')
  const description = field(match[1], 'description').trim()
  const body = match[2].trim()
  if (!name || !description || !body) throw new Error('Agent cần name, description và thân chỉ dẫn không rỗng.')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Tên vai ${name} không hợp lệ cho agent agy (chữ thường, số, gạch ngang).`)
  if (AGY_BUILTIN_AGENTS.has(name)) throw new Error(`Tên vai ${name} trùng agent dựng sẵn của agy.`)
  const role = Object.hasOwn(rolesJson?.roles ?? {}, name) ? rolesJson.roles[name] : null
  if (!role) throw new Error(`Không tìm thấy vai ${name} trong kit/roles.json.`)
  if (typeof role.writesCode !== 'boolean') throw new Error(`Vai ${name} thiếu writesCode boolean.`)
  const claudeTools = optField(match[1], 'tools')
  const mapped = claudeTools === undefined
    ? AGY_ALL_TOOLS
    : claudeTools.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).flatMap((t) => AGY_TOOL_OF[t] ?? [])
  let tools = AGY_TOOL_ORDER.filter((t) => mapped.includes(t))
  if (!role.writesCode) tools = tools.filter((t) => !AGY_WRITE_TOOLS.has(t))
  if (tools.length === 0) tools = ['read_file']
  const readOnly = role.writesCode ? '' : '\n\nTrên Antigravity, vai này chỉ đọc (không có edit_file / write_file): không sửa file, không chạy lệnh ghi; cần ghi báo cáo thì trả nội dung cho captain.'
  const note = `\n\n## Công cụ trên Antigravity\nRead/Glob/Grep = read_file (tìm bằng rg qua run_command) · Edit/Write = edit_file/write_file · Bash = run_command. Hỏi user ⇒ trả câu hỏi cho captain, không giả định có AskUserQuestion.`
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    'subagent: true',
    'mainAgent: false',
    `model: ${agyModelOf(role)}`,
    `tools: [${tools.join(', ')}]`,
    '---',
    `<!-- ${GENERATED} -->`,
    '',
    body + readOnly + note,
    '',
  ].join('\n')
}

/**
 * Object cho installer ghép vào ~/.gemini/config/hooks.json: MỘT khoá cấp một `vibe-flow` (thay đúng khoá này khi cài lại, khoá khác của user để nguyên).
 * PreToolUse: matcher = lệnh shell + tool ghi/sửa/xoá file (hooks/lib/host.mjs agyPreToolMatcher) → agy-hook.mjs pre-tool (timeout 30 s = mặc định của agy;
 * tiến trình ngoài của adapter tự ra quyết định deny sau 25 s). SessionStart nạp sổ tiến độ + sổ chốt; Stop giữ agent làm nốt khi còn thiếu dấu review/qa/test.
 */
export function agyHooksJson(kitRoot) {
  const root = kitPath(kitRoot)
  // Bỏ nháy khi đường dẫn an toàn (agy 1.5.19+ chuyển nguyên văn cho cmd.exe nên nháy kép cũng chạy; bản cũ nuốt lặng lẽ hook có dấu nháy kép ⇒ tránh khi không cần).
  const file = `${root}/hooks/agy-hook.mjs`
  const target = /^[A-Za-z0-9_\/.:~@+-]+$/.test(file) ? file : shellQuote(file)
  const handler = (mode, timeout) => ({ type: 'command', command: `node ${target} ${mode}`, timeout })
  return {
    [AGY_HOOK_NAME]: {
      SessionStart: [handler('session-start', 25)],
      PreToolUse: [{ matcher: agyPreToolMatcher(), hooks: [handler('pre-tool', 30)] }],
      Stop: [handler('stop', 20)],
    },
  }
}

/**
 * Lớp 2 độc lập với hook: luật `permissions.deny` (cú pháp `command(regex:…)` của agy) chặn các lệnh nguy hiểm nhất kể cả khi hook không chạy được
 * (đường dẫn hook sai, hook bị bỏ qua lặng lẽ). Chỉ dùng cú pháp chung của Go RE2 và JS; `(?is)` đầu mỗi mẫu = không phân biệt hoa thường + `.` khớp xuống dòng
 * (thử bằng JS thì bỏ `(?is)` và đặt cờ `is`). Mẫu bao hai đầu bằng `.*` để đúng cả khi agy so khớp toàn chuỗi lẫn tìm một phần. Chặt hơn lớp 1 có chủ ý (vd C:\\Windows\\Temp cũng bị chặn).
 * Không đụng gì ở máy: chỉ trả danh sách; captain dán vào settings.json lúc mở quyền (T8).
 */
export function agyLayer2Deny() {
  const END_ARG = `["']?(?:\\s|;|&|\\||$)`
  const RM = '(?:rm|rmdir|rd|remove-item|ri|del|erase)'
  const patterns = [
    // xoá đệ quy gốc ổ đĩa / thư mục nhà
    `(?is).*\\brm\\s+[^;&|\\n]*(?:-[a-z]*r[a-z]*|--recursive)\\b[^;&|\\n]*\\s["']?(?:/|~|\\$home|\\$\\{home\\}|[a-z]:)[\\\\/]*\\*?${END_ARG}.*`,
    `(?is).*\\b(?:remove-item|ri|rmdir|rd|del|erase)\\b[^;&|\\n]*\\s["']?(?:[a-z]:|~|\\$env:userprofile|%userprofile%)[\\\\/]*\\*?${END_ARG}.*`,
    // xoá thư mục hệ thống
    `(?is).*\\b${RM}\\b[^;&|\\n]*\\s["']?(?:[a-z]:[\\\\/](?:windows|program files|programdata)|/(?:usr|bin|sbin|etc|boot|lib|lib64|system|library|applications|opt))(?:[\\\\/\\s"';&|*]|$).*`,
    // xoá lịch sử .git
    `(?is).*\\b${RM}\\b[^;&|\\n]*[\\\\/\\s"']\\.git[\\\\/]*${END_ARG}.*`,
    // git push ép lên nhánh chính (cờ ép trước hoặc sau tên nhánh; refspec +nhánh). main/master phải là NGUYÊN tên nhánh: đứng đầu một từ (sau khoảng trắng, "X:" của refspec
    // hay refs/heads/) và kết thúc bằng khoảng trắng / nháy / ; & | / hết lệnh — nên feat/main-menu, main-v2, release/main không bị chặn nhầm. RE2 không có lookahead ⇒ ký tự kết thúc nằm trong mẫu.
    `(?is).*\\bgit\\b[^;&|\\n]*\\bpush\\b[^;&|\\n]*\\s(?:--force[a-z-]*(?:=\\S*)?|-[a-z]*f[a-z]*)(?:\\s[^;&|\\n]*)?\\s(?:\\S*:)?["']?(?:refs/heads/)?(?:main|master)(?:["';&|\\s]|$).*`,
    `(?is).*\\bgit\\b[^;&|\\n]*\\bpush\\b[^;&|\\n]*\\s(?:\\S*:)?["']?(?:refs/heads/)?(?:main|master)["']?\\s(?:[^;&|\\n]*\\s)?(?:--force[a-z-]*(?:=\\S*)?|-[a-z]*f[a-z]*)(?:\\s|;|&|\\||$).*`,
    `(?is).*\\bgit\\b[^;&|\\n]*\\bpush\\b[^;&|\\n]*\\s["']?\\+(?:\\S*:)?["']?(?:refs/heads/)?(?:main|master)(?:["';&|\\s]|$).*`,
    // xoá nhánh chính trên remote
    `(?is).*\\bgit\\b[^;&|\\n]*\\bpush\\b[^;&|\\n]*(?:\\s(?:--delete|-d)\\s(?:[^;&|\\n]*\\s)?["']?(?:refs/heads/)?(?:main|master)(?:["';&|\\s]|$)|\\s["']?:["']?(?:refs/heads/)?(?:main|master)(?:["';&|\\s]|$)).*`,
    // xoá database / định dạng ổ đĩa
    `(?is).*\\bdrop\\s+(?:database|schema)\\b.*`,
    `(?is).*\\b(?:supabase\\s+db\\s+reset|prisma\\s+migrate\\s+reset)\\b.*`,
    `(?is).*\\b(?:format\\s+[a-z]:|mkfs(?:\\.\\w+)?\\s|dd\\s+[^;&|\\n]*of=/dev/(?:sd|nvme|disk|hd))\\w*.*`,
  ]
  return patterns.map((p) => `command(regex:${p})`)
}
