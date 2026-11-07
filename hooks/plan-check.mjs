#!/usr/bin/env node
// plan-check.mjs — kiểm PLAN.md khớp SPEC và code: mọi mã yêu cầu có task phủ, file có thật, ô tick khớp thay đổi trên nhánh [m2is].
// Công cụ CLI, chỉ nhắc: không phải hook, không chặn gộp. Chỉ đọc; không chạy lệnh Verify trong plan vì đó là dữ liệu repo.
//
//   node plan-check.mjs <PLAN.md> [--spec <SPEC.md>] [--repo <dir>] [--base <nhánh>] [--done] [--json]
//     --spec mặc định SPEC.md cạnh PLAN · --repo mặc định gốc git của PLAN · --done đòi mọi ô đã tick
//
// Exit: 0 sạch · 1 có phát hiện · 2 không chạy được.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = 'dùng: plan-check.mjs <PLAN.md> [--spec <SPEC.md>] [--repo <dir>] [--base <nhánh>] [--done] [--json]'
const CODE_RE = /\b(?:AC|S|P)-\d{2,}\b/g
const SKIP_HEAD_RE = /để sau|ngoài phạm vi/iu

// Mã yêu cầu của SPEC, bỏ khối code và mục "Để sau", "Ngoài phạm vi".
export function specCodes(text) {
  const codes = new Set()
  let fenced = false
  let skipLevel = 0
  for (const line of String(text).normalize('NFC').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      if (skipLevel && h[1].length <= skipLevel) skipLevel = 0
      if (!skipLevel && SKIP_HEAD_RE.test(h[2])) skipLevel = h[1].length
    }
    if (!skipLevel) for (const m of line.matchAll(CODE_RE)) codes.add(m[0])
  }
  return codes
}

function parseFiles(value) {
  return value.split(',').map((raw) => {
    const isNew = /\((?:mới|new)\)/iu.test(raw)
    const isGone = /\((?:xoá|xóa|đổi tên|delete|rename)\)/iu.test(raw)
    const p = raw.replace(/\([^)]*\)/gu, '').replace(/`/g, '').trim().replace(/:\d+(?:-\d+)?$/, '').replace(/\\/g, '/')
    return { path: p, isNew, isGone }
  }).filter((f) => f.path)
}

// Task đúng mẫu: "- [ ] T3 <việc> (phủ AC-02)", kèm các dòng thụt vào "Files:", "Verify:".
export function parseTasks(text) {
  const tasks = []
  let cur = null
  let fenced = false
  for (const line of String(text).normalize('NFC').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; cur = null; continue }
    if (fenced) continue
    const t = /^\s*[-*] \[([ xX])\]\s+(T\d+\b.*)$/.exec(line)
    if (t) {
      cur = { id: /^T\d+/.exec(t[2])[0], done: t[1] !== ' ', codes: new Set(t[2].match(CODE_RE) ?? []), files: [], verify: '' }
      tasks.push(cur)
      continue
    }
    if (!cur) continue
    if (!line.trim()) continue
    if (/^\S/.test(line)) { cur = null; continue }
    const body = line.trim()
    for (const c of body.match(CODE_RE) ?? []) cur.codes.add(c)
    const files = /^(?:[-*]\s*)?Files\s*:\s*(.*)$/i.exec(body)
    if (files) cur.files.push(...parseFiles(files[1]))
    const verify = /^(?:[-*]\s*)?Verify\s*:\s*(.*)$/i.exec(body)
    if (verify) cur.verify = verify[1]
  }
  return tasks
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1 << 26 })
  return r.status === 0 ? r.stdout.trimEnd() : null
}

// File đã đổi trên nhánh so với base, gồm cả phần chưa commit. Không so được thì trả null kèm lý do.
function changedFiles(repo, base) {
  const head = git(repo, ['rev-parse', 'HEAD'])
  if (!head) return { why: 'không đọc được git' }
  const b = base ?? ['main', 'master'].find((n) => git(repo, ['rev-parse', '--verify', '-q', n]))
  if (!b) return { why: 'không tìm thấy nhánh chính' }
  const fork = git(repo, ['merge-base', b, 'HEAD'])
  if (!fork) return { why: `không so được với ${b}` }
  // So nội dung hiện tại với điểm tách nhánh: sửa rồi hoàn tác thì không tính là đã đổi.
  const diff = git(repo, ['diff', '--name-only', '--no-renames', fork])
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard'])
  if (diff === null || untracked === null) return { why: `không so được với ${b}` }
  const set = new Set(`${diff}\n${untracked}`.split('\n').filter(Boolean))
  if (fork === head && !set.size) return { why: `đang đứng đúng ${b}, chưa có thay đổi để so` }
  return { set, base: b }
}

const isGlob = (p) => /[*?[\]{}]/.test(p)

export function checkPlan({ planText, specText, repo, base, done }) {
  const findings = []
  const notes = []
  const add = (code, text) => findings.push({ code, text })
  const tasks = parseTasks(planText)
  if (!tasks.length) {
    notes.push('Plan chưa có task dạng "- [ ] T1 …" nên chưa kiểm được; plan cũ không cần viết lại.')
    return { findings, notes, tasks: 0, done: 0 }
  }
  const seen = new Set()
  for (const t of tasks) {
    if (seen.has(t.id)) add('task-trung', `${t.id} xuất hiện hơn một lần.`)
    seen.add(t.id)
  }

  const covered = new Set(tasks.flatMap((t) => [...t.codes]))
  if (specText === null) notes.push('Không có SPEC cạnh plan nên chưa kiểm được phần yêu cầu.')
  else {
    const wanted = specCodes(specText)
    if (!wanted.size) notes.push('SPEC chưa đánh mã AC-nn, S-nn, P-nn nên chưa kiểm được phần yêu cầu.')
    for (const c of wanted) if (!covered.has(c)) add('thieu-task', `${c} trong SPEC chưa có task nào phủ.`)
    if (wanted.size) for (const c of covered) if (!wanted.has(c)) add('ma-la', `Task ghi ${c} nhưng SPEC không có mã này (hoặc nó nằm ở mục để sau).`)
  }

  for (const t of tasks) {
    if (!/`[^`]+`\s*(?:→|->)\s*\S/.test(t.verify)) add('thieu-verify', `${t.id} thiếu Verify dạng \`lệnh\` → kết quả mong đợi.`)
    if (!t.files.length) add('thieu-files', `${t.id} thiếu dòng Files.`)
    if (repo) {
      for (const f of t.files) {
        if (isGlob(f.path) || (f.isNew && !t.done)) continue
        if (f.isGone) {
          if (t.done && fs.existsSync(path.resolve(repo, f.path))) add('chua-xoa', `${t.id} đã tick nhưng ${f.path} vẫn còn.`)
          continue
        }
        if (!fs.existsSync(path.resolve(repo, f.path))) add('file-khong-co', `${t.id}: ${f.path} không có thật${f.isNew ? ' dù task đã tick' : ''}. File sắp tạo thì ghi "(mới)".`)
      }
    }
    if (done && !t.done) add('chua-tick', `${t.id} chưa tick.`)
  }

  if (repo && tasks.some((t) => t.done)) {
    const c = changedFiles(repo, base)
    if (!c.set) notes.push(`Chưa đối chiếu được ô tick với code: ${c.why}.`)
    else {
      for (const t of tasks.filter((x) => x.done)) {
        const concrete = t.files.filter((f) => !isGlob(f.path))
        if (concrete.length && t.files.length === concrete.length && !concrete.some((f) => c.set.has(path.posix.normalize(f.path)))) {
          add('tick-chua-doi', `${t.id} đã tick nhưng các file của nó chưa đổi so với ${c.base}.`)
        }
      }
    }
  }
  return { findings, notes, tasks: tasks.length, done: tasks.filter((t) => t.done).length }
}

function main(argv) {
  const o = { pos: [], done: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { if (argv[++i] === undefined) throw new Error(`${a} cần một giá trị. ${USAGE}`); return argv[i] }
    if (a === '--spec') o.spec = val()
    else if (a === '--repo') o.repo = val()
    else if (a === '--base') o.base = val()
    else if (a === '--done') o.done = true
    else if (a === '--json') o.json = true
    else if (a.startsWith('--')) throw new Error(`đối số không hợp lệ: ${a}. ${USAGE}`)
    else o.pos.push(a)
  }
  if (o.pos.length !== 1) throw new Error(USAGE)
  const planPath = path.resolve(o.pos[0])
  const planText = fs.readFileSync(planPath, 'utf8')
  const specPath = path.resolve(o.spec ?? path.join(path.dirname(planPath), 'SPEC.md'))
  if (o.spec && !fs.existsSync(specPath)) throw new Error(`không có SPEC: ${o.spec}`)
  const specText = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : null
  const repo = o.repo ? path.resolve(o.repo) : git(path.dirname(planPath), ['rev-parse', '--show-toplevel'])
  const r = checkPlan({ planText, specText, repo, base: o.base, done: o.done })
  if (!repo) r.notes.push('PLAN không nằm trong git nên chưa kiểm được file và ô tick; thêm --repo <thư mục dự án>.')
  if (o.json) console.log(JSON.stringify(r))
  else {
    console.log(`${r.done}/${r.tasks} task đã tick · ${r.findings.length} phát hiện`)
    for (const f of r.findings) console.log(`- ${f.text}`)
    for (const n of r.notes) console.log(`Lưu ý: ${n}`)
  }
  return r.findings.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(e.code === 'ENOENT' ? `không đọc được file: ${e.path}` : e.message)
    process.exitCode = 2
  }
}
