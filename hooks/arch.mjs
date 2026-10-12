#!/usr/bin/env node
// arch: CLI kiến trúc máy đọc (docs/arch.json → cấu hình công cụ có sẵn). Thư viện: lib/arch.mjs. Skill: skills/flow-architecture.
//   init [--stack web|go|extension|wails] [--dir D]   tạo docs/arch.json + docs/ARCHITECTURE.md (có sẵn thì giữ nguyên, báo một dòng; dự án có sẵn thì suy module từ thư mục)
//   gen [--dir D]        sinh .dependency-cruiser.cjs, .go-arch-lint.yml, .golangci.yml (không ghi đè file có sẵn), in khối ESLint/golangci cần ghép
//   baseline [--dir D]   chốt vi phạm cũ làm mốc → docs/arch-baseline.json (+ known-violations của depcruise, eslint-suppressions.json)
//   sync [--dir D]       arch.json ↔ thư mục thật ↔ Codemap trong ARCHITECTURE.md
//   size [--dir D] [--changed a,b]   trần dòng của file (chỉ xét file trong --changed nếu có)
// exit 0 = ổn · 1 = có vấn đề / công cụ THIẾU / arch.json dùng không được · 2 = dùng sai lệnh. Lời báo là tiếng Việt kèm lời dặn sửa.
import path from 'node:path'
import { DEPCRUISE_WHERE, baseline, gen, init, loadArch, sizeCheck, syncCheck } from './lib/arch.mjs'

const USAGE = 'dùng: arch.mjs <init [--stack web|go|extension|wails]|gen|baseline|sync|size [--changed a,b]> [--dir <thư mục dự án>]'
const MAX_SHOWN = 20
const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function opt(args, name) {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) throw Object.assign(new Error(`${name} cần một giá trị. ${USAGE}`), { usage: true })
  return v
}

// Lời dặn giống hệt nhau (vd mọi lỗi của arch.json hỏng cùng một cách sửa) chỉ in một lần.
function problemLines(list) {
  const said = new Set()
  const fixLine = (p) => { if (!p.fix || said.has(p.fix)) return []; said.add(p.fix); return [`  Sửa: ${p.fix}`] }
  const out = list.slice(0, MAX_SHOWN).flatMap((p) => [`- ${p.file}: ${p.msg}`, ...fixLine(p)])
  if (list.length > MAX_SHOWN) out.push(`… còn ${list.length - MAX_SHOWN} chỗ nữa`)
  return out
}

function run(argv) {
  const [cmd, ...args] = argv
  const dir = path.resolve(opt(args, '--dir') ?? process.cwd())
  const out = []
  let code = 0
  if (cmd === 'init') {
    const r = init(dir, { stack: opt(args, '--stack') })
    out.push(...r.written.map((f) => `Đã tạo ${f}`), ...r.kept.map((k) => k.why), ...r.notes)
    if (r.written.length) out.push('Bước tiếp: soát lại docs/arch.json và docs/ARCHITECTURE.md cho đúng dự án, rồi chạy: node ~/.claude/hooks/arch.mjs gen')
  } else if (cmd === 'gen') {
    const r = gen(dir)
    out.push(...r.written.map((f) => `Đã ghi ${f}`), ...r.kept.map((k) => k.why), ...r.notes)
    for (const b of r.blocks) out.push('', `--- ${b.title} ---`, b.text.trimEnd())
    out.push('', 'Bước tiếp: node ~/.claude/hooks/flow-check.mjs --dir <dự án> (dự án có sẵn: chạy arch.mjs baseline trước).')
  } else if (cmd === 'baseline') {
    const r = baseline(dir)
    const d = r.data
    const hasWeb = loadArch(dir).arch.parts.some((p) => p.stack !== 'go')
    out.push(`Đã chốt mốc ${r.file}: commit ${d.base ? d.base.slice(0, 7) : '(chưa có)'}, ${Object.keys(d.size).length} file đã quá trần dòng${hasWeb ? `, ranh giới web ${d.depcruise ? 'đã chốt' : 'chưa chốt'}, ESLint ${d.eslint ? 'đã chốt' : 'không có/chưa chốt'}` : ''}${d.go ? `, Go ${d.go.archLint.length} vi phạm ranh giới cũ` : ''}.`, ...r.notes)
    for (const m of r.missing) out.push(`THIẾU ${m.tool} — ${m.why ? `${m.why} Nâng Node rồi chạy lại arch.mjs baseline.` : `cài: ${m.install}${m.tool === 'depcruise' ? ` (${DEPCRUISE_WHERE})` : ''} (hỏi người dùng trước khi cài), rồi chạy lại arch.mjs baseline.`}`)
    // ranh giới web mà không chốt được (thiếu/hỏng công cụ, chưa gen cấu hình…) thì mốc KHÔNG đủ: mọi vi phạm cũ sẽ bị tính là lỗi mới ⇒ không được báo xong như thể ổn.
    const webOpen = hasWeb && !d.depcruise
    if (webOpen) out.push('CHƯA CHỐT: ranh giới web (dependency-cruiser) — vi phạm cũ của phần web sẽ bị tính là lỗi mới cho tới khi chốt được. Xử lý dòng THIẾU hoặc ghi chú ở trên rồi chạy lại arch.mjs baseline.')
    if (r.missing.length || webOpen) code = 1
  } else if (cmd === 'sync') {
    const r = syncCheck(dir)
    if (r.ok) {
      const n = loadArch(dir).arch.parts.reduce((s, p) => s + p.modules.length, 0)
      out.push(`Kiến trúc khớp: ${n} module, arch.json, thư mục và Codemap đều đủ.`)
    } else out.push(`Kiến trúc lệch ở ${r.problems.length} chỗ:`, ...problemLines(r.problems))
    out.push(...r.notes)
    if (!r.ok) code = 1
  } else if (cmd === 'size') {
    const csv = opt(args, '--changed')
    const r = sizeCheck(dir, csv === undefined ? {} : { changedOnly: csv.split(',').map((s) => s.trim()).filter(Boolean) })
    const head = loadArch(dir).arch ? `${r.problems.length} file quá trần dòng:` : `docs/arch.json chưa dùng được (${r.problems.length} lỗi):`
    out.push(...(r.ok ? ['Cỡ file đạt trần dòng.'] : [head, ...problemLines(r.problems)]))
    if (!r.ok) code = 1
  } else throw Object.assign(new Error(USAGE), { usage: true })
  return { out, code }
}

try {
  const { out, code } = run(process.argv.slice(2))
  process.stdout.write(`${out.join('\n')}\n`)
  process.exitCode = code
} catch (e) {
  process.stderr.write(`lỗi: ${oneLine(e?.message ?? e)}\n`)
  process.exitCode = e?.usage ? 2 : 1
}
