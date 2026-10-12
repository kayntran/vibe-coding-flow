// Máy kiểm bản cập nhật công cụ (codex, claude, agy, cursor-agent, grok, devin, node, pnpm, git). Logic ở hooks/lib/updates.mjs.
//   node ~/.claude/hooks/updates.mjs check [<công cụ>] [--fresh] [--json]   so bản đang cài với bản mới nhất chính hãng (bộ nhớ 24 giờ; --fresh = hỏi mạng ngay)
//   node ~/.claude/hooks/updates.mjs cmd <công cụ>|hết [--json]            lệnh cập nhật ĐÚNG cách đã cài trên máy (luôn kiểm tươi); CHỈ in lệnh, không chạy
//   node ~/.claude/hooks/updates.mjs note                                   dòng nhắc từ bộ nhớ (như SessionStart sẽ in), không ghi gì
// Hợp đồng: không bao giờ tự cập nhật. AI chạy lệnh sau khi user gật; công cụ ảnh hưởng mọi dự án (node, git) thì đưa lệnh cho user tự chạy.
// Exit: 0 xong (kể cả công cụ chưa cài / không kiểm được — chỉ nói thẳng) · 2 gõ sai.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL_NAMES, checkAll, checkOne, compareVersions, labelOf, noteLine, readCache } from './lib/updates.mjs'

const USAGE = `Dùng: node updates.mjs check [<công cụ>] [--fresh] [--json]
      node updates.mjs cmd <công cụ>|hết [--json]
      node updates.mjs note
Công cụ: ${TOOL_NAMES.join(', ')}`

const ALIASES = { 'claude-code': 'claude', claudecode: 'claude', antigravity: 'agy', cursor: 'cursor-agent', cursoragent: 'cursor-agent', nodejs: 'node' }
const ALL = new Set(['hết', 'het', 'all', 'tat-ca', 'tatca'])
const METHOD_VI = {
  pnpm: 'cài bằng pnpm', npm: 'cài bằng npm', brew: 'cài bằng Homebrew', self: 'bộ cài riêng của hãng', native: 'bản cài riêng của hãng', winget: 'cài bằng winget',
  corepack: 'cài qua corepack', fnm: 'cài qua fnm', nvm: 'cài qua nvm', volta: 'cài qua volta', desktop: 'đi kèm Devin Desktop', apple: 'bản của Apple', unknown: 'chưa rõ cách cài',
}

function toolOf(name) {
  const k = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-')
  const t = Object.hasOwn(ALIASES, k) ? ALIASES[k] : k
  return TOOL_NAMES.includes(t) ? t : null
}

const newer = (e) => Boolean(e.latest) && compareVersions(e.installed, e.latest) < 0
const summary = (e) => (!e.latest ? `${e.installed} (chưa có nguồn để so bản mới)` : newer(e) ? `${e.installed} → ${e.latest} (có bản mới)` : `${e.installed} (đã mới nhất)`)
const view = (e) => ({ tool: e.tool, label: e.label, installed: e.installed, latest: e.latest, updateAvailable: newer(e), method: e.method, cmd: e.cmd, userRuns: e.userRuns, affectsAll: e.affectsAll, note: e.note, eol: e.eol })

function checkText(list) {
  return list.flatMap((e) => [`${e.label}: ${summary(e)} · ${METHOD_VI[e.method]}`, ...(e.note ? [`  ! ${e.note}`] : [])])
}

// Khối "lệnh cập nhật" của một công cụ. Lệnh luôn cài ĐÚNG bản `latest` đã chọn; không ghim được (winget chưa có bản đó, chưa có bản đủ 7 ngày…) ⇒ không có lệnh, chỉ ghi chú.
// Lệnh nhiều bước (fnm/nvm) in thành nhiều dòng "Lệnh 1/2/…", chạy lần lượt.
function cmdText(e) {
  if (e.latest && !newer(e)) return [`${e.label} đã ở bản mới nhất (${e.installed}), không cần cập nhật.`]
  const head = e.latest ? `${e.label} ${e.installed} → ${e.latest} (${METHOD_VI[e.method]})` : `${e.label} ${e.installed} (${METHOD_VI[e.method]}; chưa có bản mới để khuyên)`
  const steps = e.cmd ? e.cmd.split('\n') : []
  const cmdLines = !steps.length ? ['Lệnh: (không có lệnh để chạy)'] : steps.length === 1 ? [`Lệnh: ${steps[0]}`] : steps.map((s, i) => `Lệnh ${i + 1}: ${s}`)
  const who = !e.cmd
    ? 'Ai chạy: user tự làm theo ghi chú — không có lệnh để AI chạy.'
    : e.userRuns
      ? `Ai chạy: user tự chạy — đưa ${steps.length > 1 ? 'các lệnh' : 'lệnh'} này cho user, AI không tự chạy.${steps.length > 1 ? ' Chạy lần lượt từ trên xuống.' : ''}`
      : `Ai chạy: AI chạy sau khi user gật${steps.length > 1 ? ' (lần lượt từ trên xuống)' : ''}; chạy xong kiểm lại bằng \`updates.mjs check <công cụ> --fresh\`.`
  return [head, ...cmdLines, who, ...(e.note ? [`Ghi chú: ${e.note}`] : [])]
}

// deps (tuỳ chọn, cho test): io {out, err} · opts (truyền thẳng cho lib: fetch, exec, now, cacheDir, platform, env, exists, …)
export async function run(argv, deps = {}) {
  const io = deps.io ?? { out: (s) => console.log(s), err: (s) => console.error(s) }
  const opts = deps.opts ?? {}
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const pos = argv.filter((a) => !a.startsWith('--'))
  const bad = [...flags].filter((f) => !['--fresh', '--json'].includes(f))
  const [verb, ...rest] = pos
  const usage = (msg) => { io.err(msg ? `${msg}\n${USAGE}` : USAGE); return 2 }
  if (bad.length) return usage(`Cờ lạ: ${bad.join(' ')}`)
  const json = flags.has('--json')
  const emit = (value, lines) => io.out(json ? JSON.stringify(value, null, 2) : lines.join('\n'))
  try {
    if (verb === 'check') {
      if (rest.length > 1) return usage()
      if (rest.length === 1) {
        const tool = toolOf(rest[0])
        if (!tool) return usage(`Công cụ không có trong danh sách: ${String(rest[0]).slice(0, 40)}`)
        const e = await checkOne(tool, { ...opts, fresh: flags.has('--fresh') })
        emit(e ? [view(e)] : [], e ? checkText([e]) : [`${labelOf(tool)}: chưa cài trên máy này hoặc chưa kiểm được (mất mạng?).`])
        return 0
      }
      const list = await checkAll({ ...opts, fresh: flags.has('--fresh') })
      emit(list.map(view), list.length ? checkText(list) : ['Không thấy công cụ nào để kiểm (hoặc chưa kiểm được: mất mạng?).'])
      return 0
    }
    if (verb === 'cmd') {
      if (rest.length !== 1 || flags.has('--fresh')) return usage()
      if (ALL.has(String(rest[0]).toLowerCase())) {
        const list = (await checkAll({ ...opts, fresh: true })).filter(newer)
        emit(list.map(view), list.length ? list.flatMap((e, i) => [...(i ? [''] : []), ...cmdText(e)]) : ['Mọi công cụ đã ở bản mới nhất (hoặc chưa kiểm được).'])
        return 0
      }
      const tool = toolOf(rest[0])
      if (!tool) return usage(`Công cụ không có trong danh sách: ${String(rest[0]).slice(0, 40)}`)
      const e = await checkOne(tool, { ...opts, fresh: true })
      emit(e ? [view(e)] : [], e ? cmdText(e) : [`${labelOf(tool)} chưa cài trên máy này (kit không tự cài) hoặc chưa kiểm được (mất mạng?).`])
      return 0
    }
    if (verb === 'note') {
      if (rest.length || flags.size) return usage()
      const line = noteLine(readCache(opts), null, { now: typeof opts.now === 'function' ? opts.now() : (opts.now ?? Date.now()) })
      if (line) io.out(line)
      return 0
    }
    return usage()
  } catch (e) {
    io.err(`updates: lỗi không mong đợi: ${e?.message ?? e}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2))
}
