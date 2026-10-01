// mcp-usage: đo MCP server nào thực sự được dùng. Một script, chế độ chọn bằng argv[2].
//   log    : hook PostToolUse, matcher `mcp__.*` — ghi nối một dòng JSONL {ts, server, tool, cwd}. Không in gì, không chặn.
//   report : CLI `report [--days N]` (mặc định 30) — bảng MCP đang dùng + MCP đã cấu hình mà 0 lần gọi (kèm lệnh gợi ý tắt, CHỈ in).
// Spec: ~/.claude/plans/flow-v3-hooks-spec.md (Làn B). Lỗi nội bộ ở chế độ log luôn CHO QUA (exit 0, không in gì)
// và ghi một dòng vào ~/.claude/logs/mcp-usage.log. Không bao giờ in/log giá trị env/header/token: ~/.claude.json
// và .mcp.json chỉ đọc TÊN key, và lỗi parse chỉ ghi loại lỗi (message của JSON.parse có thể trích nội dung file).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOGS_DIR = path.join(os.homedir(), '.claude', 'logs')
const USAGE_LOG = process.env.MCP_USAGE_LOG || path.join(LOGS_DIR, 'mcp-usage.jsonl')
const STATE_FILE = path.join(LOGS_DIR, 'mcp-usage.state.json')
const ERR_LOG = path.join(LOGS_DIR, 'mcp-usage.log')
const DAY = 86400000

function logErr(msg) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.appendFileSync(ERR_LOG, `${new Date().toISOString()} [${process.argv[2] ?? ''}] ${msg}\n`)
  } catch {}
}

const errTag = (e) => e?.code || e?.name || 'error'

// `mcp__<server>__<tool>`: server = phần giữa `mcp__` đầu và `__` kế tiếp.
function parseTool(name) {
  const m = /^mcp__(.+?)__(.+)$/s.exec(name)
  return m ? { server: m[1], tool: m[2] } : null
}

// ---------- log ----------

function logMode() {
  let input
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch (e) {
    logErr(`stdin không đọc/parse được (${errTag(e)})`)
    return
  }
  const t = typeof input?.tool_name === 'string' ? parseTool(input.tool_name) : null
  if (!t) return
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const line = JSON.stringify({ ts: new Date().toISOString(), server: t.server, tool: t.tool, cwd }) + '\n'
  try {
    fs.appendFileSync(USAGE_LOG, line)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true })
    fs.appendFileSync(USAGE_LOG, line)
  }
}

// ---------- report ----------

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const baseName = (p) => p.split(/[\\/]+/).filter(Boolean).pop() || p
const cell = (s) => String(s).replace(/\|/g, '\\|')
// Claude Code chuẩn hoá tên server trong tool_name: ký tự ngoài [A-Za-z0-9_-] thành `_`.
const normName = (n) => n.replace(/[^A-Za-z0-9_-]/g, '_')
const keysOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : [])

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') logErr(`đọc ${path.basename(file)} lỗi (${errTag(e)})`)
    return null
  }
}

function readUsage() {
  let text
  try { text = fs.readFileSync(USAGE_LOG, 'utf8') } catch { return [] }
  const rows = []
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    try {
      const r = JSON.parse(l)
      const t = Date.parse(r.ts)
      if (typeof r.server === 'string' && Number.isFinite(t)) rows.push({ t, server: r.server, cwd: typeof r.cwd === 'string' ? r.cwd : '' })
    } catch {}
  }
  return rows
}

// Gốc project của một cwd: đi lên tới thư mục có .mcp.json hoặc .git (cwd có thể là thư mục con).
function projectRoot(cwd) {
  let dir = cwd
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.mcp.json'))) return dir
    if (fs.existsSync(path.join(dir, '.git'))) return null
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

// Danh sách MCP đã cấu hình — chỉ lấy tên key.
function configuredServers(cwds) {
  const out = []
  const cfg = readJson(path.join(os.homedir(), '.claude.json'))
  for (const name of keysOf(cfg?.mcpServers)) out.push({ name, scope: 'user', where: '' })
  for (const [p, v] of Object.entries(cfg?.projects && typeof cfg.projects === 'object' ? cfg.projects : {})) {
    for (const name of keysOf(v?.mcpServers)) out.push({ name, scope: 'local', where: p })
  }
  const roots = new Set()
  for (const c of cwds) {
    if (!c) continue
    try { const r = projectRoot(c); if (r) roots.add(r) } catch {}
  }
  for (const root of roots) {
    for (const name of keysOf(readJson(path.join(root, '.mcp.json'))?.mcpServers)) out.push({ name, scope: 'project', where: root })
  }
  return out
}

// Tên key trong ~/.claude.json / .mcp.json là dữ liệu không đáng tin (.mcp.json nằm trong repo): chỉ tên an toàn mới được
// đưa vào lệnh gợi ý; tên lạ chỉ in dạng đã escape Markdown, không dựng lệnh, không dùng code span.
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/
const oneLine = (s) => String(s).replace(/[\x00-\x1f\x7f]+/g, ' ')
const mdEscape = (s) => oneLine(s).replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '\\$&')

function removeHint(c) {
  const cmd = `\`claude mcp remove "${c.name}" -s ${c.scope}\``
  if (c.scope === 'user') return cmd
  if (c.scope === 'local') return `${cmd} (chạy trong thư mục project đó)`
  return `xoá key khỏi \`.mcp.json\` hoặc ${cmd} (chạy trong thư mục project đó)`
}

function unusedLine(c) {
  const where = c.where ? `, ${oneLine(c.where)}` : ''
  if (!SAFE_NAME.test(c.name)) return `- ${mdEscape(c.name)} — ${c.scope}${where} — tên có ký tự đặc biệt, không in lệnh: tự gỡ thủ công`
  return `- \`${c.name}\` — ${c.scope}${where} — ${removeHint(c)}`
}

function reportMode(args) {
  let days = 30
  const i = args.findIndex((a) => a === '--days' || a.startsWith('--days='))
  if (i >= 0) {
    const n = Number(args[i].includes('=') ? args[i].split('=')[1] : args[i + 1])
    if (Number.isFinite(n) && n > 0) days = n
  }
  const now = new Date()
  const all = readUsage()
  const rows = all.filter((r) => r.t >= now.getTime() - days * DAY)

  const by = new Map()
  for (const r of rows) {
    let s = by.get(r.server)
    if (!s) by.set(r.server, (s = { calls: 0, days: new Set(), last: 0, projects: new Set() }))
    s.calls++
    s.days.add(ymd(new Date(r.t)))
    s.last = Math.max(s.last, r.t)
    if (r.cwd) s.projects.add(baseName(r.cwd))
  }

  const configured = configuredServers(new Set(all.map((r) => r.cwd)))
  const scopesOf = new Map()
  for (const c of configured) {
    const k = normName(c.name)
    scopesOf.set(k, [...new Set([...(scopesOf.get(k) ?? []), c.scope])])
  }

  const md = [`# Báo cáo dùng MCP — ${days} ngày gần nhất (${ymd(now)})`, '']
  md.push(all.length
    ? `Log: ${rows.length} lần gọi trong cửa sổ này; log bắt đầu từ ${ymd(new Date(all.reduce((m, r) => Math.min(m, r.t), Infinity)))}.`
    : 'Log: chưa có dòng nào.', '')

  md.push('## Đang dùng', '')
  if (by.size) {
    md.push('| Server | Cấu hình | Số lần gọi | Số ngày dùng | Lần cuối | Project |', '|---|---|---:|---:|---|---|')
    for (const [server, s] of [...by].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))) {
      const ps = [...s.projects].sort()
      const proj = ps.length > 8 ? `${ps.slice(0, 8).join(', ')} (+${ps.length - 8})` : ps.join(', ')
      const last = new Date(s.last)
      md.push(`| ${cell(server)} | ${(scopesOf.get(server) ?? ['—']).join('/')} | ${s.calls} | ${s.days.size} | ${ymd(last)} ${hm(last)} | ${cell(proj)} |`)
    }
  } else {
    md.push('(chưa có lần gọi nào trong cửa sổ này)')
  }

  md.push('', '## Đã cấu hình, 0 lần gọi', '')
  const unused = configured.filter((c) => !by.has(normName(c.name)))
  if (unused.length) {
    for (const c of unused) md.push(unusedLine(c))
  } else {
    md.push('(không có)')
  }

  md.push('', '## Ghi chú', '',
    '- Lệnh ở trên chỉ là gợi ý, script không tự chạy; user quyết định tắt cái nào.',
    '- Connector claude.ai chỉ hiện trong bảng "Đang dùng" khi có gọi; tắt ở cài đặt connector của claude.ai.')
  const text = md.join('\n') + '\n'

  process.stdout.write(text)
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOGS_DIR, `mcp-report-${ymd(now)}.md`), text)
    const prev = readJson(STATE_FILE)
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...(prev && typeof prev === 'object' ? prev : {}), lastReport: now.toISOString() }))
  } catch (e) {
    logErr(`ghi report/state lỗi (${errTag(e)})`)
  }
}

// ---------- main ----------

const mode = process.argv[2]
if (mode === 'log') {
  try { logMode() } catch (e) { logErr(`log lỗi (${errTag(e)})`) }
} else if (mode === 'report') {
  try {
    reportMode(process.argv.slice(3))
  } catch (e) {
    logErr(`report lỗi (${errTag(e)})`)
    process.stderr.write('mcp-usage report lỗi, xem ~/.claude/logs/mcp-usage.log\n')
    process.exitCode = 1
  }
} else {
  process.stderr.write('Cách dùng: node mcp-usage.mjs log (hook PostToolUse) | report [--days N]\n')
}
