#!/usr/bin/env node
// spec-check: CLI máy kiểm SPEC có phần "Bạn duyệt" + mã S-nn/P-nn (ADR-0006). Thư viện: lib/spec-codes.mjs. Skill: skills/flow-spec.
//   spec <SPEC.md>                         SPEC có đủ 6 mục Bạn duyệt, mỗi màn có bảng trạng thái đủ, mục ai thấy/sửa có P-nn hoặc "Không áp dụng", mã không trùng
//                                          (trong SPEC; và khi SPEC nằm ở <dự án>/docs/specs/<tên>/SPEC.md: không trùng mã của SPEC khác trong docs/specs, kể cả tính năng đã xong)
//   codes [--dir D] [--spec SPEC.md …]     mã S-nn có trong code app VÀ test, mã P-nn có trong test, mã không trùng SPEC khác của dự án (mặc định: mọi docs/specs/*/SPEC.md chưa `Trạng thái: xong`)
//   --json                                 in kết quả dạng JSON (cùng mã thoát)
// Đường dẫn SPEC tương đối tính từ thư mục đang đứng. exit 0 = đạt · 1 = có chỗ cần sửa · 2 = dùng sai lệnh. Không có SPEC đang làm ⇒ đạt, báo một dòng.
import fs from 'node:fs'
import path from 'node:path'
import { dupeCodes, openSpecs, parseSpec, specProblems, traceCodes } from './lib/spec-codes.mjs'

const USAGE = 'dùng: spec-check.mjs spec <SPEC.md> [--json] | codes [--dir <thư mục dự án>] [--spec <SPEC.md>…] [--json]'
const MAX_SHOWN = 20
const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const slash = (p) => String(p).replace(/\\/g, '/')
const usage = (why) => Object.assign(new Error(why ? `${why}. ${USAGE}` : USAGE), { usage: true })

function parseArgs(argv) {
  const o = { cmd: argv[0], pos: [], dir: undefined, specs: [], json: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--dir' || a === '--spec') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw usage(`${a} cần một giá trị`)
      if (a === '--dir') o.dir = v
      else o.specs.push(v)
    } else if (a.startsWith('--')) throw usage(`không có cờ ${a}`)
    else o.pos.push(a)
  }
  return o
}

// Lời dặn giống hệt nhau (vd nhiều màn thiếu cùng một thứ) chỉ in một lần.
function problemLines(list) {
  const said = new Set()
  const fixLine = (p) => { if (!p.fix || said.has(p.fix)) return []; said.add(p.fix); return [`  Sửa: ${p.fix}`] }
  const out = list.slice(0, MAX_SHOWN).flatMap((p) => [`- ${p.msg}`, ...fixLine(p)])
  if (list.length > MAX_SHOWN) out.push(`… còn ${list.length - MAX_SHOWN} chỗ nữa`)
  return out
}

function showPath(abs) {
  const r = slash(path.relative(process.cwd(), abs))
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : slash(abs)
}

function runSpec(o) {
  if (o.pos.length !== 1 || o.dir !== undefined || o.specs.length) throw usage('spec cần đúng một đường dẫn SPEC.md')
  const file = path.resolve(o.pos[0])
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { throw usage(`không đọc được ${showPath(file)} (${e.code ?? 'lỗi'})`) }
  const problems = specProblems(text)
  // SPEC nằm ở <dự án>/docs/specs/<tên>/SPEC.md ⇒ mã S-nn/P-nn còn phải khác mọi SPEC khác của dự án (kể cả đã xong)
  const up = (p, n) => (n ? up(path.dirname(p), n - 1) : p)
  if (path.basename(file) === 'SPEC.md' && path.basename(up(file, 2)) === 'specs' && path.basename(up(file, 3)) === 'docs') {
    problems.push(...dupeCodes(up(file, 4), [file]).map(({ msg, fix }) => ({ msg, fix })))
  }
  const s = parseSpec(text)
  const counts = { screens: s.screens.length, s: s.sCodes.length, p: s.pCodes.length }
  const ok = problems.length === 0
  const out = ok
    ? [`SPEC đạt: ${showPath(file)} — ${counts.screens} màn, ${counts.s} mã trạng thái S-nn, ${counts.p} mã quyền P-nn${s.pNotApplicable ? ' (quyền: không áp dụng)' : ''}.`]
    : [`SPEC ${showPath(file)} cần sửa ${problems.length} chỗ:`, ...problemLines(problems)]
  return { out, json: { ok, file: showPath(file), problems, counts }, code: ok ? 0 : 1 }
}

function runCodes(o) {
  if (o.pos.length) throw usage('codes không nhận đường dẫn rời, dùng --spec <SPEC.md>')
  const dir = path.resolve(o.dir ?? process.cwd())
  const specs = o.specs.length ? o.specs.map((p) => path.resolve(p)) : openSpecs(dir)
  if (!specs.length) {
    const note = 'không có SPEC đang làm — bỏ qua đối chiếu mã S-nn/P-nn.'
    return { out: [`Mã SPEC: ${note}`], json: { ok: true, specs: [], problems: [], counts: { s: 0, p: 0 }, note }, code: 0 }
  }
  let r
  try { r = traceCodes(dir, specs) } catch (e) { throw usage(oneLine(e.message)) }
  const files = specs.map(showPath)
  const out = r.ok
    ? [`Mã SPEC khớp (${files.join(', ')}): ${r.counts.s} mã S-nn có trong app và test, ${r.counts.p} mã P-nn có trong test.`]
    : [`Mã SPEC chưa khớp ở ${r.problems.length} chỗ:`, ...problemLines(r.problems)]
  return { out, json: { ok: r.ok, specs: files, problems: r.problems, counts: r.counts }, code: r.ok ? 0 : 1 }
}

function run(argv) {
  const o = parseArgs(argv)
  const r = o.cmd === 'spec' ? runSpec(o) : o.cmd === 'codes' ? runCodes(o) : null
  if (!r) throw usage()
  return { text: o.json ? JSON.stringify(r.json, null, 2) : r.out.join('\n'), code: r.code }
}

try {
  const { text, code } = run(process.argv.slice(2))
  process.stdout.write(`${text}\n`)
  process.exitCode = code
} catch (e) {
  process.stderr.write(`lỗi: ${oneLine(e?.message ?? e, 800)}\n`)
  process.exitCode = e?.usage ? 2 : 1
}
