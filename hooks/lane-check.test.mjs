// Test cho lane-check.mjs: node --test ~/.claude/hooks/lane-check.test.mjs
// Repo tạm trong os.tmpdir (nhánh main), gọi CLI qua spawnSync từ cwd bất kỳ, tự dọn khi xong.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lane-check.mjs')
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
const roots = []

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ---------- helpers ----------

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')} lỗi: ${r.stderr}`)
  return r.stdout
}

function write(dir, rel, content) {
  const f = path.join(dir, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
  return f
}

function tmpRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-check-')))
  roots.push(root)
  return root
}

// Repo trên main với các file `files` (nội dung = tên file) đã commit.
function repoWith(files, root = tmpRoot()) {
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  for (const f of files) write(repo, f, `${f}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'init')
  return repo
}

// rows: [lane, worker, files, ops, depends_on, accept] — ghi PLAN.md vào repo (hoặc `dir`).
const COLS = ['lane', 'worker', 'files', 'ops', 'depends_on', 'accept']
function planText(rows, cols = COLS) {
  const line = (cells) => `| ${cells.join(' | ')} |`
  return ['# PLAN', '', 'Mô tả linh tinh | không phải bảng', '', line(cols), line(cols.map(() => '---')), ...rows.map(line), '', 'hết'].join('\n')
}

function commitAll(repo, msg) {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', msg)
}

function writePlan(dir, rows, cols) {
  return write(dir, 'PLAN.md', planText(rows, cols))
}

function run(args, cwd = os.tmpdir()) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: ENV })
  assert.equal(r.error, undefined)
  return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split('\n').filter(Boolean) }
}

// ---------- plan ----------

describe('plan', () => {
  test('overlap glob: file có sẵn thuộc hai làn', () => {
    const repo = repoWith(['web/src/api/a.ts', 'web/src/api/b.ts', 'web/src/i18n/en.ts'])
    writePlan(repo, [
      ['A', 'coder', 'web/src/api/**', 'extend', '-', 'pnpm test'],
      ['B', 'coder-lite', 'web/src/i18n/**', 'new', '-', 'pnpm test'],
      ['C', 'coder', 'web/src/api/a.ts, other/**', 'replace', '-', 'pnpm test'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.includes('OVERLAP web/src/api/a.ts lanes: A C'), r.out)
    assert.ok(!r.out.includes('OVERLAP web/src/api/b.ts'), r.out)
    assert.ok(!r.out.includes('OVERLAP web/src/i18n'), r.out)
  })

  test('overlap tiền tố: glob file mới lồng nhau; thư mục chỉ chung chữ đầu thì không', () => {
    const repo = repoWith(['README.md'])
    writePlan(repo, [
      ['A', 'coder', 'web/src/new/**', 'new', '-', 'x'],
      ['B', 'coder', 'web/src/new/sub/**', 'new', '-', 'x'],
      ['C', 'coder', 'web/src/newer/**', 'new', '-', 'x'],
      ['D', 'coder', 'docs/guide.md', 'new', '-', 'x'],
      ['E', 'coder', 'docs/guide.md', 'new', '-', 'x'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.includes('OVERLAP web/src/new/sub/ lanes: A B'), r.out)
    assert.ok(r.lines.includes('OVERLAP docs/guide.md lanes: D E'), r.out)
    assert.ok(!r.lines.some((l) => l.startsWith('OVERLAP') && l.includes('C')), `newer/ không được coi là nằm trong new/:\n${r.out}`)
  })

  test('file mới nằm dưới glob của làn khác đã khớp file có sẵn', () => {
    const repo = repoWith(['web/src/api/a.ts'])
    writePlan(repo, [
      ['A', 'coder', 'web/src/api/**', 'extend', '-', 'x'],
      ['B', 'coder', 'web/src/api/v2/**', 'new', '-', 'x'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.includes('OVERLAP web/src/api/v2/ lanes: A B'), r.out)
  })

  test('lockfile thuộc hai làn ⇒ HOT (kèm OVERLAP)', () => {
    const repo = repoWith(['pnpm-lock.yaml', 'web/package-lock.json', 'a/x.ts', 'b/y.ts'])
    writePlan(repo, [
      ['A', 'coder', 'a/**, pnpm-lock.yaml', 'extend', '-', 'x'],
      ['B', 'coder', 'b/**, pnpm-lock.yaml', 'extend', '-', 'x'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.some((l) => l.startsWith('HOT **/pnpm-lock.yaml lanes: A B')), r.out)
    assert.ok(r.lines.includes('OVERLAP pnpm-lock.yaml lanes: A B'), r.out)
  })

  test('migrations (file mới) hai làn ⇒ HOT dù hai thư mục con khác nhau; hot: trong flow.json', () => {
    const repo = repoWith(['a/x.ts', 'b/y.ts', 'cfg/shared.cfg'])
    write(repo, '.claude/flow.json', JSON.stringify({ hot: ['cfg/**'] }))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'flow')
    writePlan(repo, [
      ['A', 'coder', 'supabase/migrations/a/**, cfg/shared.cfg', 'new', '-', 'x'],
      ['B', 'coder', 'supabase/migrations/b/**, cfg/shared.cfg', 'new', '-', 'x'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.some((l) => l.startsWith('HOT supabase/migrations/** lanes: A B')), r.out)
    assert.equal(r.lines.filter((l) => l.includes('migrations')).length, 1, `mẫu trùng kết quả chỉ in một dòng:\n${r.out}`)
    assert.ok(r.lines.some((l) => l.startsWith('HOT cfg/** lanes: A B')), r.out)
  })

  test('HOT ghi nhận file vào MỌI mẫu khớp, không chỉ mẫu đầu tiên', () => {
    const repo = repoWith(['src/migrations/a.sql', 'src/app.ts'])
    write(repo, '.claude/flow.json', JSON.stringify({ hot: ['src/**'] }))
    commitAll(repo, 'flow')
    writePlan(repo, [
      ['A', 'coder', 'src/migrations/a.sql', 'extend', '-', 'x'],
      ['B', 'coder', 'src/app.ts', 'extend', '-', 'x'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.some((l) => l.startsWith('HOT src/** lanes: A B')), r.out)
    assert.ok(!r.lines.some((l) => l.startsWith('OVERLAP')), 'hai file khác nhau, không OVERLAP')
  })

  test('file cấu hình gốc repo chỉ ở một làn thì không phải lỗi', () => {
    const repo = repoWith(['package.json', 'a/x.ts', 'b/y.ts'])
    writePlan(repo, [
      ['A', 'coder', 'a/**, package.json', 'extend', '-', 'x'],
      ['B', 'coder', 'b/**', 'extend', '-', 'x'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 0, r.out)
  })

  test('depends_on vòng và trỏ làn không tồn tại', () => {
    const repo = repoWith(['a/x.ts', 'b/y.ts', 'c/z.ts'])
    writePlan(repo, [
      ['A', 'coder', 'a/**', 'extend', 'B', 'x'],
      ['B', 'coder', 'b/**', 'extend', 'A', 'x'],
      ['C', 'coder', 'c/**', 'extend', 'Z', 'x'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.includes('CYCLE A -> B -> A'), r.out)
    assert.ok(r.lines.includes('BAD_DEP C depends_on unknown lane Z'), r.out)
    assert.ok(!r.out.includes('wave 1'), 'plan hỏng không in wave')
  })

  test('làn tự phụ thuộc chính nó là vòng', () => {
    const repo = repoWith(['a/x.ts'])
    writePlan(repo, [['A', 'coder', 'a/**', 'extend', 'A', 'x']])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.includes('CYCLE A -> A'), r.out)
  })

  test('waves xếp tầng topo đúng, in ops từng làn, exit 0', () => {
    const repo = repoWith(['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts'])
    writePlan(repo, [
      ['A', 'coder', 'a/**', 'extend', '-', 'x'],
      ['B', 'coder-lite', 'b/**', 'rename', 'A', 'x'],
      ['C', 'coder', 'c/**', 'delete', '-', 'x'],
      ['D', 'coder', 'd/**', 'replace', 'B, C', 'x'],
    ])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 0, r.out)
    assert.ok(r.lines.includes('wave 1: A, C'), r.out)
    assert.ok(r.lines.includes('wave 2: B'), r.out)
    assert.ok(r.lines.includes('wave 3: D'), r.out)
    assert.ok(r.lines.some((l) => /^\s+B \[coder-lite\] ops: rename/.test(l)), r.out)
    assert.ok(r.lines.some((l) => /^\s+C \[coder\] ops: delete/.test(l)), r.out)
    assert.ok(r.lines.indexOf('wave 1: A, C') < r.lines.indexOf('wave 2: B'), r.out)
    assert.ok(r.lines.at(-1).startsWith('OK: 4 làn, 3 wave'), r.out)
  })

  test('cảnh báo: >4 làn một wave, làn không có accept; vẫn exit 0', () => {
    const repo = repoWith(['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts', 'e/1.ts'])
    writePlan(repo, ['A', 'B', 'C', 'D', 'E'].map((n) => [n, 'coder', `${n.toLowerCase()}/**`, 'extend', '-', n === 'C' ? '-' : 'x']))
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 0, r.out)
    assert.ok(r.lines.some((l) => l.startsWith('WARN wave 1 có 5 làn')), r.out)
    assert.ok(r.lines.includes('WARN lane C thiếu accept'), r.out)
  })

  test('cột đảo thứ tự, cột lạ bỏ qua, glob bọc backtick', () => {
    const repo = repoWith(['a/1.ts', 'b/1.ts'])
    const cols = ['accept', 'note', 'depends_on', 'files', 'lane']
    writePlan(repo, [
      ['pnpm test', 'ghi chú', '-', '`a/**`', 'A'],
      ['pnpm test', 'ghi chú', 'A', '`b/**`, `b/new.ts`', 'B'],
    ], cols)
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 0, r.out)
    assert.ok(r.lines.includes('wave 1: A'), r.out)
    assert.ok(r.lines.includes('wave 2: B'), r.out)
  })

  test('bảng thiếu cột ⇒ exit 2, stderr nêu tên cột thiếu', () => {
    const repo = repoWith(['a/1.ts'])
    writePlan(repo, [['A', 'a/**', '-']], ['lane', 'files', 'accept'])
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 2, r.out + r.err)
    assert.match(r.err, /thiếu cột: depends_on/)
    assert.equal(r.out, '')
  })

  test('không có bảng làn ⇒ exit 2', () => {
    const repo = repoWith(['a/1.ts'])
    write(repo, 'PLAN.md', '# PLAN\n\nchưa có bảng\n')
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 2)
    assert.match(r.err, /không thấy bảng làn/)
  })

  test('dòng bảng nhiều ô hơn header ⇒ exit 2 (tránh lệch cột im lặng)', () => {
    const repo = repoWith(['a/1.ts'])
    write(repo, 'PLAN.md', '| lane | files | depends_on |\n|---|---|---|\n| A | a/** | - | thừa |\n')
    const r = run(['plan', path.join(repo, 'PLAN.md')])
    assert.equal(r.code, 2)
    assert.match(r.err, /4 cột nhưng header có 3/)
  })

  test('PLAN.md ngoài repo: lỗi rõ nếu thiếu --repo, chạy được với --repo', () => {
    const root = tmpRoot()
    const repo = repoWith(['a/1.ts'], root)
    const plan = writePlan(path.join(root, 'plans'), [['A', 'coder', 'a/**', 'extend', '-', 'x']])
    const bad = run(['plan', plan])
    assert.equal(bad.code, 2)
    assert.match(bad.err, /--repo/)
    const ok = run(['plan', plan, '--repo', repo])
    assert.equal(ok.code, 0, ok.out + ok.err)
    assert.ok(ok.lines.includes('wave 1: A'), ok.out)
  })
})

// ---------- audit ----------

describe('audit', () => {
  const rows = [
    ['A', 'coder', 'web/src/api/**, shared/types.ts', 'extend', '-', 'x'],
    ['B', 'coder', 'web/src/i18n/**', 'new', '-', 'x'],
  ]

  test('báo file ngoài scope (kể cả file mới và đổi tên ra ngoài)', () => {
    const repo = repoWith(['web/src/api/a.ts', 'web/src/api/b.ts', 'other/o.ts'])
    writePlan(repo, rows)
    commitAll(repo, 'plan')
    git(repo, 'checkout', '-b', 'lane-a')
    write(repo, 'web/src/api/a.ts', 'đổi\n')
    write(repo, 'shared/types.ts', 'mới\n')
    write(repo, 'other/o.ts', 'lấn sang\n')
    git(repo, 'mv', 'web/src/api/b.ts', 'other/b.ts')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'lane a')
    const r = run(['audit', path.join(repo, 'PLAN.md'), 'A', '--branch', 'lane-a'])
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(r.lines.filter((l) => l.startsWith('OUTSIDE')).sort(), ['OUTSIDE other/b.ts', 'OUTSIDE other/o.ts'])
  })

  test('sạch ⇒ exit 0', () => {
    const repo = repoWith(['web/src/api/a.ts'])
    writePlan(repo, rows)
    commitAll(repo, 'plan')
    git(repo, 'checkout', '-b', 'lane-a')
    write(repo, 'web/src/api/a.ts', 'đổi\n')
    write(repo, 'web/src/api/deep/new.ts', 'mới\n')
    write(repo, 'shared/types.ts', 'mới\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'lane a')
    const r = run(['audit', path.join(repo, 'PLAN.md'), 'A', '--branch', 'lane-a'])
    assert.equal(r.code, 0, r.out)
    assert.ok(!r.out.includes('OUTSIDE'))
    assert.match(r.lines.at(-1), /^OK audit lane A: 3 file đổi/)
  })

  test('mặc định branch = HEAD, --base đổi nhánh gốc; làn lạ ⇒ exit 2', () => {
    const repo = repoWith(['web/src/api/a.ts'])
    writePlan(repo, rows)
    commitAll(repo, 'plan')
    git(repo, 'branch', 'trunk')
    git(repo, 'checkout', '-b', 'lane-b')
    write(repo, 'web/src/api/a.ts', 'đổi\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'sai làn')
    const plan = path.join(repo, 'PLAN.md')
    const r = run(['audit', plan, 'B', '--base', 'trunk'], repo)
    assert.equal(r.code, 1, r.out)
    assert.ok(r.lines.includes('OUTSIDE web/src/api/a.ts'), r.out)
    const bad = run(['audit', plan, 'Z', '--base', 'trunk'], repo)
    assert.equal(bad.code, 2)
    assert.match(bad.err, /không có làn "Z"/)
  })

  // Repo chính (main, đã commit PLAN.md + other.txt) + worktree `wt` trên nhánh lane-a, đã có một commit trong scope.
  function dirtyFixture() {
    const root = tmpRoot()
    const repo = repoWith(['web/src/api/a.ts', 'other.txt'], root)
    writePlan(repo, rows)
    commitAll(repo, 'plan')
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-b', 'lane-a', wt)
    write(wt, 'web/src/api/a.ts', 'đổi\n')
    commitAll(wt, 'trong scope')
    return { repo, wt, plan: path.join(repo, 'PLAN.md') }
  }

  test('thay đổi chưa commit ở worktree của nhánh (unstaged/staged/untracked) ⇒ OUTSIDE', () => {
    const { repo, wt, plan } = dirtyFixture()
    write(wt, 'other.txt', 'sửa chưa commit\n')
    write(wt, 'staged.txt', 'mới, đã add\n')
    git(wt, 'add', 'staged.txt')
    write(wt, 'loose/new.txt', 'chưa add\n')
    write(wt, 'web/src/api/c.ts', 'untracked nhưng trong scope\n')
    const r = run(['audit', plan, 'A', '--branch', 'lane-a'], repo)
    assert.equal(r.code, 1, r.out + r.err)
    assert.deepEqual(r.lines.filter((l) => l.startsWith('OUTSIDE')).sort(), ['OUTSIDE loose/new.txt', 'OUTSIDE other.txt', 'OUTSIDE staged.txt'])
    assert.ok(!r.out.includes('WARN'), r.out)
  })

  test('chưa commit nhưng trong scope ⇒ sạch, đếm cả file chưa commit', () => {
    const { repo, wt, plan } = dirtyFixture()
    write(wt, 'web/src/api/c.ts', 'untracked trong scope\n')
    write(wt, 'shared/types.ts', 'mới\n')
    const r = run(['audit', plan, 'A', '--branch', 'lane-a'], repo)
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.lines.at(-1), /^OK audit lane A: 3 file đổi/)
  })

  test('--worktree <path> chỉ định thẳng worktree', () => {
    const { repo, wt, plan } = dirtyFixture()
    write(wt, 'other.txt', 'sửa chưa commit\n')
    const r = run(['audit', plan, 'A', '--branch', 'lane-a', '--worktree', wt], repo)
    assert.equal(r.code, 1, r.out + r.err)
    assert.ok(r.lines.includes('OUTSIDE other.txt'), r.out)
  })

  test('mặc định branch = HEAD ⇒ kiểm worktree của repo; PLAN.md chưa commit không bị tính', () => {
    const repo = repoWith(['web/src/api/a.ts', 'other.txt'])
    git(repo, 'checkout', '-b', 'lane-a')
    writePlan(repo, rows)
    const plan = path.join(repo, 'PLAN.md')
    const clean = run(['audit', plan, 'A'], repo)
    assert.equal(clean.code, 0, clean.out + clean.err)
    write(repo, 'other.txt', 'sửa chưa commit\n')
    const dirty = run(['audit', plan, 'A'], repo)
    assert.equal(dirty.code, 1, dirty.out + dirty.err)
    assert.deepEqual(dirty.lines.filter((l) => l.startsWith('OUTSIDE')), ['OUTSIDE other.txt'])
  })

  test('nhánh không có worktree ⇒ chỉ so commit, in một dòng WARN', () => {
    const { repo, plan } = dirtyFixture()
    git(repo, 'branch', 'lane-x', 'lane-a')
    const r = run(['audit', plan, 'A', '--branch', 'lane-x'], repo)
    assert.equal(r.code, 0, r.out + r.err)
    assert.equal(r.lines.filter((l) => l.startsWith('WARN')).length, 1, r.out)
    assert.match(r.out, /WARN không tìm thấy worktree của nhánh lane-x/)
  })
})

// ---------- conflicts ----------

describe('conflicts', () => {
  function conflictRepo() {
    const repo = repoWith(['README.md'])
    write(repo, 'f.txt', 'a\nb\nc\n')
    write(repo, 'h.txt', '1\n2\n3\n')
    commitAll(repo, 'base')
    const branch = (name, file, content) => {
      git(repo, 'checkout', '-b', name, 'main')
      write(repo, file, content)
      git(repo, 'add', '-A')
      git(repo, 'commit', '-m', name)
    }
    branch('b1', 'f.txt', 'a\nX\nc\n')
    branch('b2', 'f.txt', 'a\nY\nc\n')
    branch('b3', 'g.txt', 'mới\n')
    branch('b4', 'h.txt', '1\n2\n3\n4\n')
    git(repo, 'checkout', 'main')
    return repo
  }

  test('phát hiện cặp sửa cùng dòng, cho qua cặp sạch, xếp nhánh sạch trước', () => {
    const repo = conflictRepo()
    const r = run(['conflicts', 'b1', 'b2', 'b3'], repo)
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(r.lines.filter((l) => l.startsWith('CONFLICT')), ['CONFLICT b1 b2: f.txt'])
    assert.ok(r.lines.includes('merge order: b3, b1, b2'), r.out)
  })

  test('mọi cặp sạch ⇒ exit 0', () => {
    const repo = conflictRepo()
    const r = run(['conflicts', 'b1', 'b3', 'b4'], repo)
    assert.equal(r.code, 0, r.out)
    assert.ok(!r.out.includes('CONFLICT'))
    assert.ok(r.lines.includes('merge order: b1, b3, b4'), r.out)
  })

  test('--base: kiểm thêm từng nhánh với nhánh gốc đã tiến lên', () => {
    const repo = conflictRepo()
    git(repo, 'checkout', 'main')
    write(repo, 'g.txt', 'main cũng tạo\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'main moves')
    const r = run(['conflicts', '--base', 'main', 'b3', 'b4'], repo)
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(r.lines.filter((l) => l.startsWith('CONFLICT')), ['CONFLICT main b3: g.txt'])
    assert.ok(r.lines.includes('merge order: b4, b3'), r.out)
  })

  test('nhánh không tồn tại / chỉ một nhánh ⇒ exit 2', () => {
    const repo = conflictRepo()
    const missing = run(['conflicts', 'b1', 'nope'], repo)
    assert.equal(missing.code, 2)
    assert.match(missing.err, /không tồn tại: nope/)
    const one = run(['conflicts', 'b1'], repo)
    assert.equal(one.code, 2)
  })
})

// ---------- CLI ----------

describe('cli', () => {
  test('lệnh lạ ⇒ exit 2, --help ⇒ exit 0', () => {
    assert.equal(run(['bogus']).code, 2)
    assert.equal(run([]).code, 2)
    const h = run(['--help'])
    assert.equal(h.code, 0)
    assert.match(h.out, /plan <PLAN\.md>/)
  })
})
