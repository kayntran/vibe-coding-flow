// Test đối chiếu registry vai (kit/roles.json) ↔ agent thật (agents/*.md) — PLAN đợt 1, soát plan mục 2:
// vai mới (vd coder-mini) phải có mặt ở cả hai nơi, nếu không sẽ lọt cổng receipt/audit/gateLane.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const roles = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'roles.json'), 'utf8')).roles
const agents = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(ROOT, 'agents', f), 'utf8'))?.[1] ?? ''
  const get = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1].trim()
  return [get('name'), { file: f, model: get('model'), tools: (get('tools') ?? '').split(/,\s*/) }]
}))

test('mỗi agent có vai trong roles.json và ngược lại (trừ vai agent:false như plan-reviewer)', () => {
  for (const name of Object.keys(agents)) assert.ok(roles[name], `agents/${agents[name].file} chưa có vai "${name}" trong kit/roles.json`)
  for (const [name, r] of Object.entries(roles)) {
    if (r.agent === false) continue
    assert.ok(agents[name], `vai "${name}" trong kit/roles.json chưa có agents/${name}.md`)
  }
})

test('model của agent = dòng Claude trong roles.json, ghi bằng tên dòng (không ghim số phiên bản)', () => {
  for (const [name, a] of Object.entries(agents)) {
    assert.match(a.model ?? '', /^(opus|sonnet|haiku)$/, `${name}: model "${a.model}" phải là tên dòng`)
    assert.equal(a.model, roles[name].models.claude.line, `${name}: agent và roles.json lệch dòng model`)
  }
})

test('writesCode khớp quyền sửa file của agent (vai không viết code thì không có Edit)', () => {
  for (const [name, a] of Object.entries(agents)) {
    assert.equal(a.tools.includes('Edit'), roles[name].writesCode, `${name}: tools có Edit = ${a.tools.includes('Edit')} nhưng writesCode = ${roles[name].writesCode}`)
  }
})
