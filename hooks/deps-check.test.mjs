// Test cho deps-check.mjs: node --test ~/.claude/hooks/deps-check.test.mjs
// Thư viện nguồn git/URL không cần mạng để ra kết quả (bad, hoặc ok nếu đã duyệt) nên test không gọi mạng.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './deps-check.mjs'

// Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
}
const SRC = 'git+https://example.com/pkg.git#abc123'
const roots = []

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

// Repo tạm: HEAD có package.json rỗng (+ flowJson nếu truyền); sau đó stage package.json thêm "pkg" từ nguồn git.
function repo({ flowJsonInHead, flowJsonOnlyOnDisk } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deps-check-')))
  roots.push(dir)
  git(dir, ['init', '-q'])
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }))
  if (flowJsonInHead !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'))
    fs.writeFileSync(path.join(dir, '.claude', 'flow.json'), typeof flowJsonInHead === 'string' ? flowJsonInHead : JSON.stringify(flowJsonInHead))
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'goc'])
  if (flowJsonOnlyOnDisk !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude', 'flow.json'), JSON.stringify(flowJsonOnlyOnDisk))
    git(dir, ['add', '-A'])
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { pkg: SRC } }))
  git(dir, ['add', 'package.json'])
  return dir
}

const text = (r) => r.lines.join('\n')

describe('trustedDepSources từ flow.json của HEAD', () => {
  test('không có flow.json => như cũ: nguồn git chưa duyệt là bad (exit 1)', async () => {
    const r = await run(['--repo', repo()])
    assert.equal(r.code, 1, text(r))
    assert.match(text(r), /nguồn ngoài kho chính thức/)
  })

  test('"tên@nguồn" có trong flow.json của HEAD => ok (exit 0)', async () => {
    const r = await run(['--repo', repo({ flowJsonInHead: { trustedDepSources: [`pkg@${SRC}`] } })])
    assert.equal(r.code, 0, text(r))
    assert.match(text(r), /1 ổn, 0 có vấn đề/)
    assert.doesNotMatch(text(r), /nguồn ngoài kho chính thức/)
  })

  test('tên khớp mà nguồn khác (đổi commit) => vẫn bad', async () => {
    const r = await run(['--repo', repo({ flowJsonInHead: { trustedDepSources: ['pkg@git+https://example.com/pkg.git#old'] } })])
    assert.equal(r.code, 1, text(r))
  })

  test('flow.json chỉ có ở index/đĩa, không có ở HEAD => không có hiệu lực', async () => {
    const r = await run(['--repo', repo({ flowJsonOnlyOnDisk: { trustedDepSources: [`pkg@${SRC}`] } })])
    assert.equal(r.code, 1, text(r))
  })

  test('flow.json ở HEAD hỏng JSON hoặc sai kiểu => không tin ai, không ném', async () => {
    for (const bad of ['{ not json', JSON.stringify({ trustedDepSources: `pkg@${SRC}` }), JSON.stringify({ trustedDepSources: [42, null] })]) {
      const r = await run(['--repo', repo({ flowJsonInHead: bad })])
      assert.equal(r.code, 1, `${bad}: ${text(r)}`)
    }
  })

  test('--json: gói đã duyệt có status ok, ok=true', async () => {
    const r = await run(['--repo', repo({ flowJsonInHead: { trustedDepSources: [`pkg@${SRC}`] } }), '--json'])
    assert.equal(r.code, 0)
    const out = JSON.parse(r.lines[0])
    assert.equal(out.ok, true)
    assert.equal(out.packages[0].problems.length, 0)
  })
})
