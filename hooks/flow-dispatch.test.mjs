// Test cho flow-dispatch.mjs: node --test ~/.claude/hooks/flow-dispatch.test.mjs
// Mỗi test tạo repo tạm trong os.tmpdir, gọi script qua spawnSync với JSON stdin (chạy lane-check.mjs thật), rồi tự dọn.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flow-dispatch.mjs')
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
const roots = []

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ---------- helpers ----------

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')} lỗi: ${r.stderr}`)
  return r.stdout
}

function write(dir, rel, content) {
  const f = path.join(dir, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
  return f
}

function commit(dir, rel, content, msg = 'c') {
  write(dir, rel, content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', msg)
}

function tmpRoot(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  roots.push(root)
  return root
}

const TABLE = (rows) => ['| lane | files | depends_on | accept |', '| --- | --- | --- | --- |', ...rows].join('\n') + '\n'
const CLEAN_PLAN = TABLE(['| A | src/a.txt | - | node a |', '| B | src/b.txt | - | node b |'])

// Repo (nhánh main) với src/a.txt, src/b.txt và PLAN.md (nội dung `plan`) đã commit.
function repoWithPlan(plan = CLEAN_PLAN, planRel = 'PLAN.md') {
  const root = tmpRoot('flow-dispatch-')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  write(repo, 'src/a.txt', 'a\n')
  write(repo, 'src/b.txt', 'b\n')
  commit(repo, planRel, plan, 'init')
  return { root, repo, plan: path.join(repo, planRel), log: path.join(root, 'flow-dispatch.log') }
}

function run(fx, mode, input, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...(mode === undefined ? [] : [mode])], {
    input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd: cwd ?? fx.root, env: { ...ENV, FLOW_DISPATCH_LOG: fx.log },
  })
  assert.equal(r.error, undefined)
  let json = null
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

const agent = (fx, subagent_type, prompt, cwd) => run(fx, 'agent', { cwd: cwd ?? fx.repo, tool_name: 'Agent', tool_input: { subagent_type, prompt } })
const stop = (fx, cwd, extra = {}) => run(fx, 'stop', { cwd, ...extra })

function assertPass(r) {
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '', `đáng lẽ cho qua nhưng in: ${r.stdout}`)
}

function assertDeny(r) {
  assert.equal(r.status, 0)
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'deny', `đáng lẽ chặn, stdout: ${r.stdout}`)
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse')
  return r.json.hookSpecificOutput.permissionDecisionReason
}

function assertBlock(r) {
  assert.equal(r.status, 0)
  assert.equal(r.json?.decision, 'block', `đáng lẽ block, stdout: ${r.stdout}`)
  return r.json.reason
}

// ---------- agent: coder / coder-lite ----------

describe('agent: coder/coder-lite có lane=', () => {
  test('lane + plan sạch ⇒ qua (cả coder và coder-lite)', () => {
    const fx = repoWithPlan()
    assertPass(agent(fx, 'coder', `outcome=x scope=src/a.txt plan=${fx.plan} lane=A base=main`))
    assertPass(agent(fx, 'coder-lite', `plan=${fx.plan} lane=B`))
  })

  test('bảng OVERLAP ⇒ deny kèm dòng OVERLAP', () => {
    const fx = repoWithPlan(TABLE(['| A | src/a.txt | - | node a |', '| B | src/a.txt | - | node b |']))
    const reason = assertDeny(agent(fx, 'coder', `plan=${fx.plan} lane=A`))
    assert.match(reason, /OVERLAP src\/a\.txt lanes: A B/)
  })

  test('lane= thiếu plan= ⇒ deny', () => {
    const fx = repoWithPlan()
    assert.match(assertDeny(agent(fx, 'coder', 'outcome=x lane=A base=main')), /lane= phải kèm plan=/)
    assert.match(assertDeny(agent(fx, 'coder-lite', 'lane=A')), /lane= phải kèm plan=/)
  })

  test('không có lane= ⇒ qua dù có plan= hỏng hay không có plan=', () => {
    const fx = repoWithPlan(TABLE(['| A | src/a.txt | - | node a |', '| B | src/a.txt | - | node b |']))
    assertPass(agent(fx, 'coder', `plan=${fx.plan}`))
    assertPass(agent(fx, 'coder', 'outcome=sửa lỗi nhỏ'))
  })

  test('bảng làn hỏng / plan không đọc được ⇒ deny (exit 2 của lane-check)', () => {
    const fx = repoWithPlan('# không có bảng làn\n')
    assert.match(assertDeny(agent(fx, 'coder', `plan=${fx.plan} lane=A`)), /Không kiểm được bảng làn/)
    assert.match(assertDeny(agent(fx, 'coder', `plan=${path.join(fx.repo, 'KHONG-CO.md')} lane=A`)), /Không kiểm được bảng làn/)
  })

  test('plan= tương đối so với cwd của input; có nháy; có dấu cách; theo sau bởi khoá khác / dấu phẩy', () => {
    const fx = repoWithPlan(CLEAN_PLAN, 'docs/My Plan.md')
    assertPass(agent(fx, 'coder', 'plan="docs/My Plan.md" lane=A')) // tương đối + nháy
    assertPass(agent(fx, 'coder', `plan=${fx.plan} lane=A base=main`)) // đường dẫn có dấu cách, không nháy, khoá kế tiếp
    assertPass(agent(fx, 'coder', `lane=A, plan=${fx.plan}, base=main`)) // dấu phẩy
    assertPass(agent(fx, 'coder', `plan=${fx.plan} (xem thêm ở đó)\nlane=A`)) // chữ thường theo sau
    assertPass(agent(fx, 'coder', `plan=${fx.plan}, xem thêm\nlane=A`)) // dấu phẩy rồi chữ thường
    assertPass(agent(fx, 'coder', `plan=${fx.plan.replace(/\\/g, '/')}\nlane=A`)) // dấu / và xuống dòng
  })

  test('plan= tương đối nhưng sai thư mục ⇒ deny (không tìm thấy)', () => {
    const fx = repoWithPlan(CLEAN_PLAN, 'docs/PLAN.md')
    assertDeny(agent(fx, 'coder', 'plan=PLAN.md lane=A'))
  })
})

// ---------- agent: qa-tester ----------

describe('agent: qa-tester', () => {
  test('thiếu port ⇒ deny', () => {
    const fx = repoWithPlan()
    assert.match(assertDeny(agent(fx, 'qa-tester', 'chạy QA trên worktree wt-x, không có cổng')), /PORT_BASE=<n>/)
    assert.match(assertDeny(agent(fx, 'qa-tester', 'PORT_BASE=')), /PORT_BASE=<n>/)
    assert.match(assertDeny(agent(fx, 'qa-tester', 'port=1')), /PORT_BASE=<n>/) // < 2 chữ số
    assert.match(assertDeny(agent(fx, 'qa-tester', 'support=4120')), /PORT_BASE=<n>/) // "port" phải đứng riêng
  })

  test('PORT_BASE=4120 ⇒ qua', () => {
    const fx = repoWithPlan()
    assertPass(agent(fx, 'qa-tester', 'chạy QA PORT_BASE=4120 trên wt-x'))
    assertPass(agent(fx, 'qa-tester', 'PORT_BASE = 4120'))
  })

  test('port=9245 ⇒ qua', () => {
    const fx = repoWithPlan()
    assertPass(agent(fx, 'qa-tester', 'app đã chạy sẵn, port=9245'))
  })
})

// ---------- agent: còn lại ----------

describe('agent: khác / đầu vào hỏng', () => {
  test('agent khác ⇒ qua (kể cả prompt có lane= không plan=)', () => {
    const fx = repoWithPlan()
    for (const t of ['recon', 'Explore', 'test-runner', 'general-purpose', 'code-reviewer']) assertPass(agent(fx, t, 'lane=A'))
  })

  test('input hỏng ⇒ qua + log', () => {
    const fx = repoWithPlan()
    assertPass(run(fx, 'agent', 'không phải json'))
    assertPass(run(fx, 'agent', ''))
    assertPass(run(fx, 'agent', 'null'))
    assertPass(run(fx, 'agent', { cwd: fx.repo }))
    assertPass(run(fx, 'agent', { cwd: fx.repo, tool_input: { subagent_type: 'coder' } }))
    assertPass(run(fx, 'agent', { cwd: fx.repo, tool_input: { subagent_type: 123, prompt: 'lane=A' } }))
    assert.match(fs.readFileSync(fx.log, 'utf8'), /\[agent\]/)
  })

  test('cwd của input không tồn tại ⇒ không vỡ (plan tuyệt đối vẫn kiểm được)', () => {
    const fx = repoWithPlan()
    assertPass(run(fx, 'agent', { cwd: path.join(fx.root, 'khong-co'), tool_input: { subagent_type: 'coder', prompt: `plan=${fx.plan} lane=A` } }))
  })

  test('chế độ lạ ⇒ exit 1 kèm cách dùng, không in stdout', () => {
    const fx = repoWithPlan()
    const r = run(fx, 'bogus', {})
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /agent\|stop/)
  })
})

// ---------- stop ----------

const OPEN_NOTE = '# Tiến độ\nTrạng thái: đang làm\nPha 2\n'
const PROGRESS = 'docs/specs/feat/progress.md'

// Repo có sổ tiến độ đã commit, mtime lùi về quá khứ (sổ cũ hơn mọi commit sau).
function repoWithProgress(note = OPEN_NOTE) {
  const fx = repoWithPlan()
  commit(fx.repo, PROGRESS, note, 'sổ')
  return { ...fx, progress: path.join(fx.repo, PROGRESS), gates: path.join(fx.repo, '.git', 'flow-gates') }
}

const ago = (file, sec) => {
  const t = new Date(Date.now() - sec * 1000)
  fs.utimesSync(file, t, t)
}

describe('stop: nhắc cập nhật sổ tiến độ', () => {
  test('commit mới hơn sổ ⇒ block một lần rồi thôi; commit mới ⇒ nhắc lại', () => {
    const fx = repoWithProgress()
    ago(fx.progress, 3600)
    commit(fx.repo, 'src/a.txt', 'a2\n', 'đổi a')
    const head = git(fx.repo, 'rev-parse', 'HEAD').trim()
    const reason = assertBlock(stop(fx, fx.repo))
    assert.ok(reason.startsWith('Có commit mới mà sổ docs/specs/feat/progress.md chưa cập nhật:'), reason)
    assert.ok(fs.existsSync(path.join(fx.gates, `progress-nudged-${head}`)), 'marker phải được ghi')
    assertPass(stop(fx, fx.repo)) // cùng HEAD: không nhắc nữa
    commit(fx.repo, 'src/b.txt', 'b2\n', 'đổi b') // HEAD mới
    assertBlock(stop(fx, fx.repo))
  })

  test('chạy từ thư mục con của repo cũng nhắc, marker nằm ở git-common-dir', () => {
    const fx = repoWithProgress()
    ago(fx.progress, 3600)
    commit(fx.repo, 'src/a.txt', 'a2\n', 'đổi a')
    assertBlock(stop(fx, path.join(fx.repo, 'src')))
    assert.equal(fs.readdirSync(fx.gates).filter((n) => n.startsWith('progress-nudged-')).length, 1)
  })

  test('stop_hook_active ⇒ không nhắc, không ghi marker', () => {
    const fx = repoWithProgress()
    ago(fx.progress, 3600)
    commit(fx.repo, 'src/a.txt', 'a2\n', 'đổi a')
    assertPass(stop(fx, fx.repo, { stop_hook_active: true }))
    assert.ok(!fs.existsSync(fx.gates))
  })

  test('sổ "xong" ⇒ không nhắc', () => {
    for (const note of ['# T\nTrạng thái: xong\n', '# T\n- **Trạng thái:** xong\n']) {
      const fx = repoWithProgress(note)
      ago(fx.progress, 3600)
      commit(fx.repo, 'src/a.txt', 'a2\n', 'đổi a')
      assertPass(stop(fx, fx.repo))
    }
  })

  test('sổ mới hơn commit HEAD (đã cập nhật sau commit) ⇒ không nhắc', () => {
    const fx = repoWithProgress()
    commit(fx.repo, 'src/a.txt', 'a2\n', 'đổi a')
    const t = new Date(Date.now() + 60000)
    fs.utimesSync(fx.progress, t, t)
    assertPass(stop(fx, fx.repo))
  })

  test('mtime sổ và commit HEAD cùng giây (so theo giây) mà commit không sửa sổ ⇒ coi như sổ cũ ⇒ nhắc một lần', () => {
    const fx = repoWithProgress()
    commit(fx.repo, 'src/a.txt', 'a2\n', 'đổi a')
    const ct = Number(git(fx.repo, 'log', '-1', '--format=%ct').trim())
    for (const ms of [ct * 1000, ct * 1000 + 900]) { // đúng giây commit, và cuối giây (muộn hơn commit theo mili giây)
      fs.rmSync(fx.gates, { recursive: true, force: true })
      const t = new Date(ms)
      fs.utimesSync(fx.progress, t, t)
      assertBlock(stop(fx, fx.repo))
      assertPass(stop(fx, fx.repo)) // chỉ một lần cho mỗi HEAD
    }
  })

  test('sổ sửa ở giây SAU giây commit ⇒ không nhắc; cùng giây nhưng commit có sửa sổ ⇒ không nhắc', () => {
    const fx = repoWithProgress()
    commit(fx.repo, 'src/a.txt', 'a2\n', 'đổi a')
    const ct = Number(git(fx.repo, 'log', '-1', '--format=%ct').trim())
    const later = new Date((ct + 1) * 1000)
    fs.utimesSync(fx.progress, later, later)
    assertPass(stop(fx, fx.repo))
    const fx2 = repoWithProgress()
    write(fx2.repo, PROGRESS, `${OPEN_NOTE}Pha 3\n`)
    git(fx2.repo, 'add', '-A')
    git(fx2.repo, 'commit', '-m', 'sổ')
    const ct2 = Number(git(fx2.repo, 'log', '-1', '--format=%ct').trim())
    const same = new Date(ct2 * 1000 + 500)
    fs.utimesSync(fx2.progress, same, same)
    assertPass(stop(fx2, fx2.repo))
  })

  test('commit HEAD tự sửa sổ (mtime vẫn cũ hơn commit) ⇒ không nhắc', () => {
    const fx = repoWithProgress()
    write(fx.repo, 'src/a.txt', 'a2\n')
    write(fx.repo, PROGRESS, `${OPEN_NOTE}Pha 3\n`)
    git(fx.repo, 'add', '-A')
    git(fx.repo, 'commit', '-m', 'đổi a + sổ')
    ago(fx.progress, 3600)
    assertPass(stop(fx, fx.repo))
  })

  test('nhiều sổ: chỉ xét sổ chưa xong sửa gần nhất (sổ cũ bỏ quên không gây nhắc nếu sổ đang làm đã mới)', () => {
    const fx = repoWithProgress()
    ago(fx.progress, 7200) // sổ cũ, chưa xong, bỏ quên
    commit(fx.repo, 'src/a.txt', 'a2\n', 'đổi a')
    const fresh = write(fx.repo, 'docs/specs/zzz/progress.md', OPEN_NOTE) // sổ đang làm, vừa ghi
    const t = new Date(Date.now() + 60000)
    fs.utimesSync(fresh, t, t)
    assertPass(stop(fx, fx.repo))
  })

  test('không có docs/specs, hoặc repo chưa có commit ⇒ không in', () => {
    const fx = repoWithPlan()
    assertPass(stop(fx, fx.repo))
    const empty = path.join(fx.root, 'empty')
    fs.mkdirSync(empty)
    git(empty, 'init', '-b', 'main')
    write(empty, PROGRESS, OPEN_NOTE)
    assertPass(stop(fx, empty))
  })

  test('ngoài repo / cwd không tồn tại / input hỏng ⇒ không in', () => {
    const fx = repoWithProgress()
    const outside = tmpRoot('flow-dispatch-out-')
    write(outside, PROGRESS, OPEN_NOTE)
    assertPass(stop(fx, outside))
    assertPass(stop(fx, path.join(fx.root, 'khong-co')))
    assertPass(run(fx, 'stop', 'không phải json'))
    assertPass(run(fx, 'stop', ''))
  })
})
