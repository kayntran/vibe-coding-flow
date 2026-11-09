// Kiểm cấu trúc bộ skill flow: khai báo đúng, không vượt ngưỡng tài liệu, không trỏ tới skill không tồn tại.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'skills')
const names = fs.readdirSync(DIR).filter((n) => n.startsWith('flow-') && fs.existsSync(path.join(DIR, n, 'SKILL.md')))
const read = (n) => fs.readFileSync(path.join(DIR, n, 'SKILL.md'), 'utf8')
const FLOWS = ['flow-feature', 'flow-bugfix', 'flow-release', 'flow-health']
const INTERNAL = ['flow-team', 'flow-sessions', 'flow-devin', 'flow-paseo']

test('đủ bộ skill đã chốt, flow-production đã tách', () => {
  for (const n of [...FLOWS, 'flow-new-app', 'flow-spec', 'flow-ux', 'flow-ui-demo', 'flow-ui-design', 'flow-system-design', 'flow-plan', 'flow-build', 'flow-fix', 'flow-qa', 'flow-review', 'flow-security', 'flow-merge', 'flow-worktree', 'flow-impact', 'flow-architecture', 'flow-explain', 'flow-status', 'flow-publish', 'flow-rollback', 'flow-backup', 'flow-key-leak', 'flow-maintain', 'flow-scale', ...INTERNAL]) {
    assert.ok(names.includes(n), `thiếu ${n}`)
  }
  assert.ok(!names.includes('flow-production'))
})

test('mỗi skill khai đúng tên, có khi dùng và khi không dùng, không quá dài', () => {
  for (const n of names) {
    const t = read(n)
    assert.match(t, new RegExp(`^name: ${n}$`, 'm'), n)
    const d = t.match(/^description: (.+)$/m)?.[1] ?? ''
    assert.match(d, /Dùng khi/, `${n}: mô tả thiếu "Dùng khi"`)
    assert.match(d, /KHÔNG/, `${n}: mô tả thiếu "KHÔNG"`)
    assert.ok(t.split('\n').length < 500, `${n}: thân quá 500 dòng`)
    if (!/^["']/.test(d)) assert.doesNotMatch(d, /: /, `${n}: mô tả có ": " chưa đặt trong ngoặc, hỏng YAML`)
  }
})

test('skill nội bộ không hiện trong menu', () => {
  for (const n of INTERNAL) assert.match(read(n), /^user-invocable: false$/m, n)
})

test('không skill nào trỏ tới skill flow không tồn tại', () => {
  for (const n of names) {
    for (const [, ref] of read(n).matchAll(/`(flow-[a-z-]+)`/g)) {
      if (['flow-check', 'flow-gate', 'flow-dispatch'].includes(ref)) continue
      assert.ok(names.includes(ref), `${n} trỏ tới ${ref}`)
    }
  }
})

test('skill luồng chỉ ghi thứ tự: ngắn, có cột xử lý', () => {
  for (const n of FLOWS) {
    const t = read(n)
    assert.ok(t.split('\n').length <= 45, `${n} quá dài`)
    assert.match(t, /\| Bước \| Skill \|/, n)
  }
  for (const n of ['flow-feature', 'flow-bugfix', 'flow-release']) assert.match(read(n), /Hỏng thì/, n)
})

// Chuẩn Anthropic (platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): SKILL.md là bản điều phối ngắn
// (quy trình + luật + chỉ file nào đọc khi nào), chi tiết ở file phụ chỉ nạp khi cần, tham chiếu một cấp, file phụ dài có mục lục.
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const subfiles = (n) => walk(path.join(DIR, n)).filter((f) => path.basename(f) !== 'SKILL.md' && !path.basename(f).startsWith('.'))
  .map((f) => path.relative(path.join(DIR, n), f).replaceAll('\\', '/'))
const body = (t) => t.replace(/^---\n[\s\S]*?\n---\n/, '')

test('SKILL.md là bản điều phối gọn: ≤ 110 dòng và ≤ 9.000 byte (chuẩn: dưới 5.000 token) phần thân', () => {
  for (const n of names) {
    const b = body(read(n).replaceAll('\r\n', '\n'))
    assert.ok(b.split('\n').length <= 110, `${n}: thân ${b.split('\n').length} dòng — tách chi tiết ra references/`)
    assert.ok(Buffer.byteLength(b) <= 9000, `${n}: thân ${Buffer.byteLength(b)} byte — tách chi tiết ra references/`)
  }
})

test('mọi file phụ đều được SKILL.md chỉ tới (một cấp), và có mục "Đọc khi cần"', () => {
  for (const n of names) {
    const subs = subfiles(n).filter((f) => f.endsWith('.md'))
    if (!subs.length) continue
    const t = read(n)
    assert.match(t, /^## Đọc khi cần/m, `${n}: có file phụ nhưng thiếu mục "## Đọc khi cần"`)
    for (const f of subs) assert.ok(t.includes(f), `${n}: SKILL.md không chỉ tới ${f} (file thừa hoặc bị quên)`)
  }
})

test('file phụ không trỏ tiếp sang file phụ khác cùng skill (tham chiếu chỉ một cấp)', () => {
  for (const n of names) {
    const subs = subfiles(n).filter((f) => f.endsWith('.md'))
    for (const f of subs) {
      const t = fs.readFileSync(path.join(DIR, n, f), 'utf8')
      for (const other of subs) {
        if (other === f) continue
        assert.ok(!t.includes(other) && !t.includes(`(${path.posix.basename(other)})`), `${n}/${f} trỏ tới ${other}: đưa chỉ dẫn lên SKILL.md`)
      }
    }
  }
})

test('file phụ dài hơn 100 dòng có mục lục ở đầu; không dùng đường dẫn kiểu Windows', () => {
  for (const n of names) {
    for (const f of subfiles(n).filter((x) => x.endsWith('.md'))) {
      const t = fs.readFileSync(path.join(DIR, n, f), 'utf8')
      if (t.split('\n').length > 100) assert.match(t.split('\n').slice(0, 15).join('\n'), /^## Mục lục/m, `${n}/${f}: dài mà thiếu "## Mục lục" ở đầu`)
    }
    assert.doesNotMatch(read(n), /(?:references|assets|scripts)\\/, `${n}: đường dẫn dùng \\`)
  }
})

// Chuẩn mở agentskills.io/specification: thư mục phụ references/ · assets/ · scripts/; name khớp tên thư mục, chữ thường/số/gạch nối,
// không bắt đầu/kết thúc bằng gạch nối, không "--"; description 1-1024 ký tự.
test('đúng đặc tả agentskills.io: thư mục phụ chuẩn, name và description hợp lệ', () => {
  for (const n of names) {
    const dirs = fs.readdirSync(path.join(DIR, n), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    for (const d of dirs) assert.ok(['references', 'assets', 'scripts'].includes(d), `${n}/${d}: chỉ dùng references/, assets/, scripts/`)
    assert.match(n, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${n}: tên sai đặc tả`)
    assert.ok(n.length <= 64)
    const d = read(n).match(/^description: (.+)$/m)?.[1] ?? ''
    assert.ok(d.length >= 1 && d.length <= 1024, `${n}: description ${d.length} ký tự`)
  }
})

test('mẫu bàn giao có đủ phần cốt lõi', () => {
  const t = fs.readFileSync(path.join(DIR, 'flow-sessions/references/handoff.md'), 'utf8')
  for (const must of ['Bước đầu tiên an toàn', 'Đang chờ user gật', 'Chưa kiểm', 'Che mọi khoá', 'không rõ']) assert.ok(t.includes(must), must)
})

test('bài đo chọn skill chỉ nhắm tới skill có thật', () => {
  const { cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit/evals/skill-routing.json'), 'utf8'))
  for (const c of cases) if (c.want !== 'none') assert.ok(names.includes(c.want), c.want)
})

test('bài đo thiết kế hệ thống đủ khuôn: ≥ 5 đề có must, có bẫy làm thừa và đề ngoài phạm vi; bản mẫu theo đúng 6 phần', () => {
  const { criteria, cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit/evals/system-design.json'), 'utf8'))
  assert.ok(criteria.length >= 5)
  assert.ok(cases.length >= 5)
  for (const c of cases) assert.ok(c.id && c.say && Array.isArray(c.must) && c.must.length, c.id)
  for (const id of ['bay-lam-thua', 'ngoai-pham-vi', 'dang-nhap-chong-spam']) assert.ok(cases.some((c) => c.id === id), id)
  const refs = path.join(DIR, 'flow-system-design', 'references')
  for (const f of fs.readdirSync(refs).filter((x) => x.startsWith('ban-mau-'))) {
    const t = fs.readFileSync(path.join(refs, f), 'utf8')
    const types = t.split(/^## /m).slice(1).filter((s) => !s.startsWith('Mục lục'))
    assert.ok(types.length >= 4, `${f}: ít hơn 4 loại`)
    for (const s of types) {
      const name = s.split('\n')[0]
      for (const must of ['Hỏi user', '| Mặt |', 'Làm ngay', 'Chừa chỗ', 'Chưa làm', 'Bài kiểm bắt buộc', 'Nguồn'])
        assert.ok(s.includes(must), `${f} › ${name}: thiếu "${must}"`)
    }
  }
})
