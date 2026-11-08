// Test cho flow-gate.mjs: node --test ~/.claude/hooks/flow-gate.test.mjs
// Mỗi test tạo repo tạm trong os.tmpdir (main + worktree `feat`), gọi script qua spawnSync với JSON stdin, rồi tự dọn.
// Ngoại lệ: test "sửa thẳng thư mục chính không bị chặn" dựng repo cạnh file test (fixture({ outsideTmp: true })) để không trùng ngoại lệ thư mục tạm của luật chặn cũ.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HOOKS_DIR, 'flow-gate.mjs')
// Tắt bảo trì tự động của git (Mac: commit/fetch tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
const NO_MAINT = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' }
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), ...NO_MAINT }
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

// Repo chính (nhánh main, a.txt 20 dòng) + worktree `wt` trên nhánh feat (chưa có commit riêng).
// outsideTmp: dựng cạnh file test thay vì os.tmpdir() — luật chặn sửa-thẳng-thư-mục-chính (đã bỏ) từng cho qua mọi file trong thư mục tạm (os.tmpdir(), <ổ>:\tmp, /tmp).
function fixture({ outsideTmp = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(outsideTmp ? path.join(HOOKS_DIR, '.flow-gate-fx-') : path.join(os.tmpdir(), 'flow-gate-')))
  roots.push(root)
  const main = path.join(root, 'main')
  const wt = path.join(root, 'wt')
  fs.mkdirSync(main)
  git(main, 'init', '-b', 'main')
  commit(main, 'a.txt', Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n', 'init')
  git(main, 'worktree', 'add', '-b', 'feat', wt)
  return { root, main, wt, gates: path.join(main, '.git', 'flow-gates'), log: path.join(root, 'flow-gate.log') }
}

function run(fx, args, { input, cwd, env } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd: cwd ?? fx.root, env: { ...ENV, FLOW_GATE_LOG: fx.log, ...env },
  })
  assert.equal(r.error, undefined)
  let json = null
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

const hook = (fx, mode, input, env) => run(fx, [mode], { input, env })
const cli = (fx, cwd, ...args) => run(fx, args, { cwd })

// Mọi lời chặn có lối ra [chốt 2026-11-07]: kể user bằng lời, user gật thì chạy lại với tiền tố FLOW_OK=1; không đẩy lệnh terminal sang user (user no code).
function assertExit(reason) {
  assert.match(reason, /Thật sự cần ⇒ kể user bằng lời đời thường/, reason)
  assert.match(reason, /FLOW_OK=1/, reason)
  assert.match(reason, /\$env:FLOW_OK=1;/, reason)
  assert.match(reason, /Không đưa lệnh cho user chạy/, reason)
}

// Lời nhắc không chặn: có additionalContext, không có permissionDecision. Trả nội dung nhắc.
function assertNudge(r) {
  assert.equal(r.status, 0)
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined, `đáng lẽ chỉ nhắc, stdout: ${r.stdout}`)
  assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'PreToolUse')
  const ctx = r.json?.hookSpecificOutput?.additionalContext
  assert.ok(typeof ctx === 'string' && ctx !== '', `đáng lẽ có lời nhắc, stdout: ${r.stdout}`)
  return ctx
}

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

// Thêm nhánh `name` (worktree riêng, một commit file <name>.go nội dung riêng); trả đường dẫn worktree.
function addBranch(fx, name) {
  const wt = path.join(fx.root, `wt-${name}`)
  git(fx.main, 'worktree', 'add', '-b', name, wt)
  commit(wt, `${name}.go`, `package ${name}\n`, name)
  return wt
}

const pidOf = (fx, cwd = fx.wt) => /^pid: ([0-9a-f]{40,})$/m.exec(cli(fx, cwd, 'status').stdout)?.[1]

// Đóng đủ dấu review + qa + test (flow-v5: cổng gộp đòi thêm dấu test; test:false = chỉ review + qa).
function stampBoth(fx, { qa = 'QA ok\nUser duyệt giao diện: có\n', cwd = fx.wt, test = true } = {}) {
  const review = write(fx.root, 'review.json', JSON.stringify({ findings: [] }))
  const qaFile = write(fx.root, 'qa.md', qa)
  const r1 = cli(fx, cwd, 'stamp', 'review', review)
  const r2 = cli(fx, cwd, 'stamp', 'qa', qaFile)
  assert.equal(r1.status, 0, r1.stderr)
  assert.equal(r2.status, 0, r2.stderr)
  if (test) {
    const r3 = cli(fx, cwd, 'stamp', 'test', '--', 'node', '-e', '0')
    assert.equal(r3.status, 0, r3.stderr)
  }
}

const bashIn = (cwd, command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } })

// ---------- bash (git merge) ----------
// Merge vào nhánh chính thiếu dấu KHÔNG bị chặn [chốt 2026-11-07]: chỉ nhắc MỘT dòng "Gộp khi còn thiếu: …" (additionalContext).

describe('bash merge', () => {
  function featFixture(file = 'feat.go') {
    const fx = fixture()
    commit(fx.wt, file, 'package x\n', 'feat')
    return fx
  }

  test('merge thiếu dấu không bị chặn: nhắc một dòng liệt kê review, qa, test', () => {
    const fx = featFixture()
    const ctx = assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.equal(ctx, 'Gộp khi còn thiếu: review, qa, test. Làm nốt nếu làm được; không được thì báo user một dòng phần chưa kiểm.')
  })

  test('chỉ có review thì nhắc thiếu qa, test (không nhắc review)', () => {
    const fx = featFixture()
    assert.equal(cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'r.json', '{"findings":[{"a":1}]}')).status, 0)
    const ctx = assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.match(ctx, /Gộp khi còn thiếu: qa, test\./)
    assert.doesNotMatch(ctx, /review/)
  })

  test('đủ review + qa thì cho qua', () => {
    const fx = featFixture()
    stampBoth(fx)
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('qa ghi N/A với diff có file .tsx vẫn tính là thiếu qa (chỉ nhắc)', () => {
    const fx = featFixture('Button.tsx')
    cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'r.json', '{"findings":[]}'))
    const pid = pidOf(fx)
    write(fx.gates, `qa-${pid}.md`, 'N/A - không có UI\n') // CLI từ chối ghi N/A cho UI nên ghi thẳng để thử hook
    assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /Gộp khi còn thiếu: qa, test\./)
    assert.match(cli(fx, fx.wt, 'status').stdout, /qa: không \(N\/A nhưng diff có UI\)/)
  })

  test('qa ghi N/A với diff chỉ có file .go cho qua', () => {
    const fx = featFixture('feat.go')
    stampBoth(fx, { qa: 'N/A - backend thuần\n' })
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('flow.json uiPattern thay mẫu UI mặc định', () => {
    const fx = featFixture('feat.go')
    write(fx.main, '.claude/flow.json', JSON.stringify({ uiPattern: '\\.go$' }))
    cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'r.json', '{"findings":[]}'))
    write(fx.gates, `qa-${pidOf(fx)}.md`, 'N/A\n')
    assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /Gộp khi còn thiếu: qa, test\./)
  })

  test('merge-base, merge-tree, merge --abort/--continue cho qua', () => {
    const fx = featFixture()
    for (const c of ['git merge-base main feat', 'git merge-tree main feat', 'git merge --abort', 'git merge --continue']) {
      assertPass(hook(fx, 'bash', bashIn(fx.main, c)))
    }
  })

  test('bắt được merge trong chuỗi && ; , -C, cd, cờ có giá trị', () => {
    const fx = featFixture()
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'echo hi && git merge feat')))
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git status; git merge --no-ff feat; echo done')))
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge -m "gộp feat" feat')))
    assertNudge(hook(fx, 'bash', bashIn(fx.root, `git -C "${fx.main.replace(/\\/g, '/')}" merge feat`)))
    assertNudge(hook(fx, 'bash', bashIn(fx.root, `cd "${fx.main.replace(/\\/g, '/')}" && git merge feat 2>&1`)))
  })

  test('không bắt: nhánh hiện tại không phải main, nhắc trong chuỗi, diff rỗng', () => {
    const fx = featFixture()
    assertPass(hook(fx, 'bash', bashIn(fx.wt, 'git merge main'))) // đang ở feat
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'echo "git merge feat"')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git log --merges')))
    git(fx.main, 'branch', 'empty') // trùng main: diff rỗng
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge empty')))
  })

  test('đổi thụt lề sau khi stamp thì dấu mất hiệu lực (patch-id --verbatim)', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\nfunc f() {\n    return\n}\n', 'feat')
    stampBoth(fx)
    const before = pidOf(fx)
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    commit(fx.wt, 'feat.go', 'package x\nfunc f() {\n\treturn\n}\n', 'đổi thụt lề')
    assert.notEqual(pidOf(fx), before)
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('git merge nhiều nhánh: thiếu dấu ở bất kỳ nhánh nào cũng bị nhắc; đủ dấu cả hai thì im', () => {
    const fx = featFixture()
    stampBoth(fx) // feat đủ dấu
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    const wtB = addBranch(fx, 'featB') // featB chưa có dấu
    for (const c of ['git merge feat featB', 'git merge featB feat', 'git merge --no-ff -m "gộp" featB feat']) {
      assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, c))), /Gộp khi còn thiếu: review, qa, test\./)
    }
    stampBoth(fx, { cwd: wtB })
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat featB')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge featB feat')))
  })

  test('comment # sau lệnh không che nhánh đích; # nằm giữa tên nhánh không phải comment', () => {
    const fx = featFixture()
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat # gộp tính năng')))
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat   #note\n')))
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'echo ok # bước 1\ngit merge feat')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, '# git merge feat')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'echo ok # git merge feat')))
    // nhánh feat#1 không tồn tại ⇒ không so được diff ⇒ không kiểm được ⇒ cho qua (không còn fail closed)
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat#1')))
  })

  test('thân heredoc không phải lệnh; lệnh thật sau/cùng dòng heredoc vẫn bị bắt', () => {
    const fx = featFixture()
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF\ngit merge feat\nEOF')))
    // heredoc đưa vào lệnh khác (ghi heredoc thẳng vào file nay bị chặn riêng: phải dùng công cụ sửa file)
    assertPass(hook(fx, 'bash', bashIn(fx.main, "cat <<'EOF' | wc -l\ngit merge feat\nEOF\necho xong")))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'cat <<-END\n\tgit merge feat\n\tEND\n')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF\ngit merge feat\n'))) // heredoc không đóng: hết lệnh
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF\nxin chào\nEOF\ngit merge feat')))
    assertNudge(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF && git merge feat\nxin chào\nEOF')))
  })

  test('lỗi đọc dấu khác ENOENT thì cho qua + ghi log (ENOENT mới là thiếu)', () => {
    const fx = featFixture()
    stampBoth(fx)
    const qa = path.join(fx.gates, `qa-${pidOf(fx)}.md`)
    fs.rmSync(qa)
    assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /Gộp khi còn thiếu: qa\./) // ENOENT = thiếu
    fs.mkdirSync(qa) // đọc ra EISDIR
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.match(fs.readFileSync(fx.log, 'utf8'), /EISDIR/)
  })
})

// ---------- stop ----------

describe('stop', () => {
  const stopIn = (cwd, extra = {}) => ({ hook_event_name: 'Stop', cwd, stop_hook_active: false, last_assistant_message: 'xong', ...extra })

  test('chặn một lần rồi cho qua lần hai; diff đổi thì nhắc lại', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    const reason = assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
    assert.match(reason, /feat đã commit xong nhưng thiếu: review, qa/)
    assert.match(reason, /flow-qa/)
    assert.ok(fs.existsSync(path.join(fx.gates, `nudged-${pidOf(fx)}`)))
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
    commit(fx.wt, 'feat2.go', 'package y\n', 'feat2') // trạng thái diff mới
    assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
  })

  test('có thay đổi chưa commit thì cho qua', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    write(fx.wt, 'wip.txt', 'dở\n')
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
    assert.ok(!fs.existsSync(fx.gates) || fs.readdirSync(fx.gates).length === 0)
  })

  test('stop_hook_active cho qua', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    assertPass(hook(fx, 'stop', stopIn(fx.wt, { stop_hook_active: true })))
  })

  test('lỗi đọc dấu khác ENOENT thì cho qua, không tạo nudged', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    stampBoth(fx)
    const pid = pidOf(fx)
    const qa = path.join(fx.gates, `qa-${pid}.md`)
    fs.rmSync(qa)
    fs.mkdirSync(qa)
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
    assert.ok(!fs.existsSync(path.join(fx.gates, `nudged-${pid}`)))
    assert.match(fs.readFileSync(fx.log, 'utf8'), /EISDIR/)
  })

  test('đủ dấu, thư mục chính, diff rỗng đều cho qua', () => {
    const fx = fixture()
    assertPass(hook(fx, 'stop', stopIn(fx.wt))) // chưa có commit nào khác main
    assertPass(hook(fx, 'stop', stopIn(fx.main)))
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    stampBoth(fx)
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
    assert.ok(!fs.existsSync(path.join(fx.gates, `nudged-${pidOf(fx)}`)))
  })
})

// Audit 2026-10-13: Stop đòi dấu ngay lúc AI đang chờ `stamp test` chạy nền ⇒ mỗi lần một lượt thức vô ích.
describe('stop khi stamp test đang chạy nền (running-test-<pid>.json)', () => {
  const stopIn = (cwd) => ({ hook_event_name: 'Stop', cwd, stop_hook_active: false, last_assistant_message: 'xong' })
  const featFx = () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    return fx
  }
  const markFile = (fx, pid = pidOf(fx)) => path.join(fx.gates, `running-test-${pid}.json`)
  const putMark = (fx, over = {}, pid = pidOf(fx)) => {
    fs.mkdirSync(fx.gates, { recursive: true })
    fs.writeFileSync(markFile(fx, pid), JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), patchId: pid, ...over }))
  }
  const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid // tiến trình vừa chạy xong ⇒ pid chết
  const nudgedFiles = (fx) => (fs.existsSync(fx.gates) ? fs.readdirSync(fx.gates).filter((n) => n.startsWith('nudged-')) : [])

  test('đánh dấu còn hạn + tiến trình còn sống ⇒ không chặn, không ghi nudged; gỡ đánh dấu thì chặn như cũ', () => {
    const fx = featFx()
    putMark(fx)
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
    assertPass(hook(fx, 'stop', stopIn(fx.wt))) // hỏi lại vẫn qua: lần này không "ăn" mất lượt nhắc
    assert.deepEqual(nudgedFiles(fx), [])
    assert.ok(fs.existsSync(markFile(fx)), 'đánh dấu của tiến trình còn sống phải giữ nguyên')
    fs.rmSync(markFile(fx))
    assert.match(assertBlock(hook(fx, 'stop', stopIn(fx.wt))), /thiếu: review, qa, test/)
  })

  test('tiến trình đã chết ⇒ vẫn chặn như cũ và đánh dấu cũ bị xoá', () => {
    const fx = featFx()
    putMark(fx, { pid: deadPid() })
    assert.match(assertBlock(hook(fx, 'stop', stopIn(fx.wt))), /thiếu: review, qa, test/)
    assert.ok(!fs.existsSync(markFile(fx)))
  })

  test('quá 2 giờ (dù pid còn sống) ⇒ vẫn chặn và xoá đánh dấu', () => {
    const fx = featFx()
    putMark(fx, { ts: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000).toISOString() })
    assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
    assert.ok(!fs.existsSync(markFile(fx)))
  })

  test('đánh dấu hỏng (không phải JSON / thiếu pid) ⇒ vẫn chặn và xoá', () => {
    const fx = featFx()
    fs.mkdirSync(fx.gates, { recursive: true })
    fs.writeFileSync(markFile(fx), '{không json')
    assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
    assert.ok(!fs.existsSync(markFile(fx)))
    putMark(fx, { pid: 'abc' })
    fs.rmSync(path.join(fx.gates, `nudged-${pidOf(fx)}`))
    assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
    assert.ok(!fs.existsSync(markFile(fx)))
  })

  test('đánh dấu của diff khác (patch-id khác) không làm Stop bỏ qua diff này', () => {
    const fx = featFx()
    const other = 'a'.repeat(40)
    putMark(fx, {}, other)
    assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
    assert.ok(fs.existsSync(markFile(fx, other)), 'đánh dấu của diff khác còn sống thì không đụng tới')
  })

  test('chạy thật: stamp test nền đang chạy ⇒ Stop không chặn; xong ⇒ đánh dấu mất, có dấu test, Stop nhắc phần còn thiếu', async () => {
    const fx = featFx()
    const go = path.join(fx.root, 'go.txt')
    const hold = write(fx.root, 'hold.mjs', "import fs from 'node:fs'\nconst t = setInterval(() => { if (fs.existsSync(process.argv[2])) clearInterval(t) }, 50)\nsetTimeout(() => process.exit(9), 30000).unref()\n")
    const child = spawn(process.execPath, [SCRIPT, 'stamp', 'test', '--', 'node', hold, go], {
      cwd: fx.wt, env: { ...ENV, FLOW_GATE_LOG: fx.log }, stdio: 'ignore', windowsHide: true,
    })
    const closed = new Promise((resolve) => child.on('close', resolve))
    try {
      const pid = pidOf(fx)
      const mark = markFile(fx, pid)
      const until = Date.now() + 15000
      while (!fs.existsSync(mark) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      assert.ok(fs.existsSync(mark), 'stamp test phải ghi đánh dấu đang chạy')
      const m = JSON.parse(fs.readFileSync(mark, 'utf8'))
      assert.equal(m.pid, child.pid)
      assert.equal(m.patchId, pid)
      assert.ok(!Number.isNaN(Date.parse(m.ts)))
      assertPass(hook(fx, 'stop', stopIn(fx.wt)))
      fs.writeFileSync(go, 'x')
      assert.equal(await closed, 0)
    } finally {
      child.kill()
    }
    assert.ok(!fs.existsSync(markFile(fx)), 'xong rồi phải gỡ đánh dấu')
    assert.ok(fs.existsSync(path.join(fx.gates, `test-${pidOf(fx)}.json`)))
    assert.match(assertBlock(hook(fx, 'stop', stopIn(fx.wt))), /thiếu: review, qa\./)
  })
})

// ---------- subagent-stop ----------

describe('subagent-stop', () => {
  const subIn = (agent_type, last_assistant_message, extra = {}) => ({
    hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a1', agent_type, last_assistant_message, ...extra,
  })
  const jsonl = (fx, name, entries) => write(fx.root, name, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const asst = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } })
  const text = (t) => ({ type: 'text', text: t })
  const handback = (message) => ({ type: 'tool_use', name: 'SubagentHandback', input: { message } })

  test('thiếu receipt bị chặn', () => {
    const fx = fixture()
    const reason = assertBlock(hook(fx, 'subagent-stop', subIn('coder', 'Đã sửa xong, mọi thứ ổn.')))
    assert.match(reason, /Thiếu receipt/)
    assertBlock(hook(fx, 'subagent-stop', subIn('code-reviewer', 'return=…; paths=…')))
  })

  test('có receipt cho qua (kể cả test-runner trả return=red)', () => {
    const fx = fixture()
    assertPass(hook(fx, 'subagent-stop', subIn('coder', 'ok\nreturn=done; paths=a.ts; checks=pass 3/3; blocker=; stop')))
    assertPass(hook(fx, 'subagent-stop', subIn('coder-lite', 'return=done_with_concerns; stop')))
    assertPass(hook(fx, 'subagent-stop', subIn('test-runner', 'return=red; stop')))
    assertPass(hook(fx, 'subagent-stop', subIn('recon', 'return=needs_context; stop')))
  })

  test('return= giá trị lạ bị chặn; chỉ nhận done|done_with_concerns|needs_context|blocked|green|red', () => {
    const fx = fixture()
    for (const bad of ['return=unknown; stop', 'return=donezo; stop', 'return=; stop', 'return=DONE; stop']) {
      assertBlock(hook(fx, 'subagent-stop', subIn('coder', bad)))
    }
    for (const ok of ['return=done', 'return=done_with_concerns', 'return=needs_context', 'return=blocked', 'return=green', 'return=red']) {
      assertPass(hook(fx, 'subagent-stop', subIn('test-runner', `${ok}; stop`)))
    }
  })

  test('agent ngoài danh sách, agent_type rỗng/thiếu, stop_hook_active đều cho qua', () => {
    const fx = fixture()
    assertPass(hook(fx, 'subagent-stop', subIn('Explore', 'không có receipt')))
    assertPass(hook(fx, 'subagent-stop', subIn('', 'không có receipt')))
    assertPass(hook(fx, 'subagent-stop', { hook_event_name: 'SubagentStop', last_assistant_message: 'x' }))
    assertPass(hook(fx, 'subagent-stop', subIn('coder', 'không có receipt', { stop_hook_active: true })))
  })

  test('báo cáo qua SubagentHandback: đọc tool_input.message trong transcript', () => {
    const fx = fixture()
    const ok = jsonl(fx, 'ok.jsonl', [
      { type: 'user', message: { role: 'user', content: 'làm đi' } },
      asst(text('xong'), handback('return=done; paths=a.ts; checks=ok; blocker=; stop')),
      asst(text('Đã giao báo cáo.')),
    ])
    assertPass(hook(fx, 'subagent-stop', subIn('coder', 'Đã giao báo cáo.', { agent_transcript_path: ok })))
    const bad = jsonl(fx, 'bad.jsonl', [asst(handback('Làm xong rồi nhé')), asst(text('Đã giao báo cáo.'))])
    assertBlock(hook(fx, 'subagent-stop', subIn('coder', 'Đã giao báo cáo.', { agent_transcript_path: bad })))
  })

  test('không có last_assistant_message thì đọc đoạn assistant cuối trong transcript', () => {
    const fx = fixture()
    const ok = jsonl(fx, 'ok.jsonl', [asst(text('một')), asst(text('return=blocked; blocker=thiếu quyền; stop'))])
    const bad = jsonl(fx, 'bad.jsonl', [asst(text('return=done; stop')), asst(text('chỉ nói chuyện'))])
    assertPass(hook(fx, 'subagent-stop', { stop_hook_active: false, agent_type: 'debugger', agent_transcript_path: ok }))
    assertBlock(hook(fx, 'subagent-stop', { stop_hook_active: false, agent_type: 'debugger', agent_transcript_path: bad }))
    assertPass(hook(fx, 'subagent-stop', { stop_hook_active: false, agent_type: 'debugger', agent_transcript_path: path.join(fx.root, 'khong-co.jsonl') }))
  })
})

// ---------- lỗi nội bộ ----------

describe('lỗi nội bộ luôn cho qua', () => {
  test('JSON hỏng / rỗng / không phải object ở mọi chế độ hook, có ghi log', () => {
    const fx = fixture()
    for (const mode of ['edit', 'bash', 'stop', 'subagent-stop']) {
      for (const input of ['{không phải json', '', 'null', '123']) assertPass(hook(fx, mode, input))
    }
    assert.match(fs.readFileSync(fx.log, 'utf8'), /\[edit\]/)
  })

  test('cwd/path không tồn tại hoặc field sai kiểu cho qua', () => {
    const fx = fixture()
    assertPass(hook(fx, 'stop', { cwd: path.join(fx.root, 'khong-co') }))
    assertPass(hook(fx, 'bash', { cwd: fx.main, tool_input: { command: 123 } }))
    assertPass(hook(fx, 'edit', { cwd: fx.main, tool_input: { file_path: 42 } }))
    assertPass(hook(fx, 'bash', bashIn(path.join(fx.root, 'khong-co'), 'git merge feat')))
  })
})

// ---------- stamp / status ----------

describe('stamp & status', () => {
  const FEAT_A = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).map((l) => (l === 'line15' ? 'line15 changed' : l)).join('\n') + '\n'

  test('pid đổi sau khi sửa thêm một dòng', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    const before = pidOf(fx)
    assert.ok(before)
    commit(fx.wt, 'feat.go', 'package x\nvar y = 1\n', 'thêm một dòng')
    const after = pidOf(fx)
    assert.ok(after)
    assert.notEqual(after, before)
  })

  test('pid giữ nguyên sau rebase không đổi nội dung', () => {
    const fx = fixture()
    commit(fx.wt, 'a.txt', FEAT_A, 'feat')
    const before = pidOf(fx)
    commit(fx.main, 'a.txt', 'header\n' + fs.readFileSync(path.join(fx.main, 'a.txt'), 'utf8'), 'main đổi cùng file, lệch số dòng')
    commit(fx.main, 'other.txt', 'x\n', 'main thêm file khác')
    git(fx.wt, 'rebase', 'main')
    assert.equal(pidOf(fx), before)
  })

  test('stamp in pid, chép file vào gatesDir; status phản ánh dấu', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    const pid = pidOf(fx)
    assert.match(cli(fx, fx.wt, 'status').stdout, /review: không\r?\nqa: không/)
    const r = cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'r.json', '{"findings":[]}'))
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim(), pid)
    assert.ok(fs.existsSync(path.join(fx.gates, `review-${pid}.json`)))
    assert.equal(cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'q.md', 'ok\n')).stdout.trim(), pid)
    const st = cli(fx, fx.wt, 'status').stdout
    assert.match(st, /branch: feat/)
    assert.match(st, /uiTouched: false/)
    assert.match(st, /review: có\r?\nqa: có/)
  })

  test('stamp từ chối review không hợp lệ, qa rỗng, qa N/A với diff UI, diff rỗng', () => {
    const fx = fixture()
    const empty = cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'r.json', '{"findings":[]}'))
    assert.equal(empty.status, 1) // chưa có commit nào khác main
    assert.match(empty.stderr, /rỗng/)
    commit(fx.wt, 'Page.vue', '<template/>\n', 'ui')
    assert.equal(cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'bad1.json', '{không json')).status, 1)
    assert.equal(cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'bad2.json', '{"findings":"x"}')).status, 1)
    assert.equal(cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'empty.md', '  \n')).status, 1)
    const na = cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'na.md', 'N/A\n'))
    assert.equal(na.status, 1)
    assert.match(na.stderr, /UI/)
    assert.match(cli(fx, fx.wt, 'status').stdout, /uiTouched: true/)
    assert.ok(!fs.existsSync(fx.gates) || fs.readdirSync(fx.gates).length === 0)
  })

  test('diff có file UI: báo cáo QA phải có dòng "User duyệt giao diện: có" (AI đã dừng cho user xem và user gật); diff không UI thì không đòi', () => {
    const fx = fixture()
    commit(fx.wt, 'Page.vue', '<template/>\n', 'ui')
    const thieu = cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'q1.md', 'QA đạt hết\n'))
    assert.equal(thieu.status, 1)
    assert.match(thieu.stderr, /duyệt giao diện/)
    assert.equal(cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'q2.md', 'QA đạt\nUser duyệt giao diện: chưa\n')).status, 1)
    // câu chưa phải lời gật ⇒ không tính (review Grok)
    for (const [i, line] of ['có thể xem lại sau khi sửa nút', 'ok không', 'rồi nhưng chưa'].entries()) {
      assert.equal(cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, `qn${i}.md`, `QA đạt\nUser duyệt giao diện: ${line}\n`)).status, 1, line)
    }
    // chữ tiếng Việt dạng NFD (macOS) vẫn nhận
    assert.equal(cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'qd.md', 'QA đạt\nUser duyệt giao diện: có\n'.normalize('NFD'))).status, 0)
    assert.equal(cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'q3.md', 'QA đạt\n- **User duyệt giao diện:** có (2026-10-12, ảnh màn chính)\n')).status, 0)
    // sửa rất nhỏ: gửi ảnh trước/sau, không dừng chờ [rofm]
    assert.equal(cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'qs.md', 'QA đạt\nSửa giao diện rất nhỏ: đã gửi ảnh trước/sau\n')).status, 0)
    const fx2 = fixture()
    commit(fx2.wt, 'feat.go', 'package x\n', 'feat')
    assert.equal(cli(fx2, fx2.wt, 'stamp', 'qa', write(fx2.root, 'q.md', 'ok\n')).status, 0)
  })

  test('cổng gộp kiểm lại dấu QA đã lưu: diff có UI mà file dấu thiếu dòng duyệt (vd đóng dấu lúc uiPattern tạm loại UI) ⇒ coi như thiếu qa', () => {
    const fx = fixture()
    commit(fx.wt, 'Page.vue', '<template/>\n', 'ui')
    const pid = pidOf(fx)
    fs.mkdirSync(fx.gates, { recursive: true })
    fs.writeFileSync(path.join(fx.gates, `qa-${pid}.md`), 'QA xong\n') // dấu lưu sẵn, không có dòng duyệt
    assert.match(cli(fx, fx.wt, 'status').stdout, /qa: không/)
    fs.writeFileSync(path.join(fx.gates, `qa-${pid}.md`), 'QA xong\nUser duyệt giao diện: có\n')
    assert.match(cli(fx, fx.wt, 'status').stdout, /qa: có/)
  })

  test('diff chỉ có file nhị phân vẫn có pid', () => {
    const fx = fixture()
    fs.writeFileSync(path.join(fx.wt, 'img.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 9]))
    git(fx.wt, 'add', '-A')
    git(fx.wt, 'commit', '-m', 'bin')
    assert.ok(pidOf(fx))
  })
})

// ---------- bash: quét secret trước git commit / git push (Làn A, flow-v3) ----------
// Token mẫu ghép lúc chạy để chính file test này không chứa secret nguyên văn (tránh tự bị cổng chặn khi commit).

describe('bash secret scan', () => {
  const GHP = 'ghp_' + 'a'.repeat(36)
  const SAMPLES = [
    ['private-key', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['aws', 'AKIA' + 'Q3EGRDLMZ7XK2PWN'],
    ['github', GHP],
    ['github', 'github_pat_' + 'b'.repeat(60)],
    ['anthropic', 'sk-ant-' + 'c'.repeat(24)],
    ['openai', 'sk-proj-' + 'd'.repeat(40)],
    ['xai', 'xai-' + 'e'.repeat(40)],
    ['google', 'AIza' + 'f'.repeat(35)],
    ['slack', 'xoxb-' + '1234567890-abcdef'],
    ['jwt', 'eyJ' + 'hbGciOiJIUzI1' + '.eyJ' + 'zdWIiOiIxMjM0' + '.' + 'SflKxwRJSMeKKF2QT4'],
    ['url-credential', 'postgres://' + 'admin:hunter22pass@db.example.com/app'],
  ]
  const sh = (fx, cwd, command) => hook(fx, 'bash', bashIn(cwd, command))
  const stage = (dir, rel, content) => { write(dir, rel, content); git(dir, 'add', '--', rel) }
  const withSecret = `ok\nconst t = "${GHP}"\n`

  function addRemote(fx) {
    const bare = path.join(fx.root, 'remote.git')
    git(fx.root, 'init', '--bare', '-b', 'main', bare)
    git(fx.main, 'remote', 'add', 'origin', bare)
  }

  test('commit có token github bị chặn; lý do có file:dòng + tên mẫu, không chứa token', () => {
    const fx = fixture()
    stage(fx.main, 'cfg.js', withSecret)
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m "thêm cấu hình"'))
    assert.match(reason, /cfg\.js:2 — github \(ghp_…\)/)
    assert.ok(!reason.includes(GHP.slice(0, 8)), 'lý do để lộ quá 4 ký tự đầu của token')
    assert.match(reason, /flow-gate: allow-secret/)
  })

  test('commit sạch / không có gì staged cho qua; secret chỉ ở commit cũ không bị quét lại', () => {
    const fx = fixture()
    assertPass(sh(fx, fx.main, 'git commit -m x')) // không có gì staged
    stage(fx.main, 'clean.js', 'const a = 1\nconst b = process.env.API_KEY\n')
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    commit(fx.main, 'old.js', withSecret, 'secret cũ')
    stage(fx.main, 'clean2.js', 'const c = 2\n')
    assertPass(sh(fx, fx.main, 'git commit -m x')) // chỉ quét dòng THÊM của phần staged
  })

  test('mọi mẫu secret được nhận đúng tên + số dòng', () => {
    const fx = fixture()
    stage(fx.main, 'p1.txt', SAMPLES.slice(0, 6).map(([, s]) => `x = ${s}`).join('\n') + '\n')
    const r1 = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    SAMPLES.slice(0, 6).forEach(([name], i) => assert.ok(r1.includes(`p1.txt:${i + 1} — ${name}`), `thiếu p1.txt:${i + 1} — ${name}: ${r1}`))
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'p2.txt', SAMPLES.slice(6).map(([, s]) => `x = ${s}`).join('\n') + '\n')
    const r2 = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    SAMPLES.slice(6).forEach(([name], i) => assert.ok(r2.includes(`p2.txt:${i + 1} — ${name}`), `thiếu p2.txt:${i + 1} — ${name}: ${r2}`))
    for (const [, s] of SAMPLES) assert.ok(!r1.includes(s) && !r2.includes(s))
  })

  test('sk-ant chỉ báo anthropic, không báo trùng openai; nhiều hơn 10 mục thì rút gọn', () => {
    const fx = fixture()
    stage(fx.main, 'k.txt', 'k = ' + 'sk-ant-' + 'c'.repeat(40) + '\n')
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assert.match(reason, /k\.txt:1 — anthropic/)
    assert.doesNotMatch(reason, /openai/)
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'many.txt', Array.from({ length: 12 }, () => `t = ${GHP}`).join('\n') + '\n')
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /…và 2 mục nữa/)
  })

  test('-a / --all / -am quét cả thay đổi tracked chưa stage; không có cờ thì không quét', () => {
    const fx = fixture()
    write(fx.main, 'a.txt', fs.readFileSync(path.join(fx.main, 'a.txt'), 'utf8') + `const t = "${GHP}"\n`) // unstaged
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    for (const c of ['git commit -am x', 'git commit -a -m x', 'git commit --all -m x', 'git commit -m x -a', 'git commit -sam x']) {
      assert.match(assertDeny(sh(fx, fx.main, c)), /a\.txt:21 — github/, c)
    }
    assertPass(sh(fx, fx.main, 'git commit -m "-a ghi chú"')) // -a nằm trong giá trị của -m
    assertPass(sh(fx, fx.main, 'git commit -m -a'))
  })

  test('--dry-run bỏ qua; unborn HEAD (commit đầu tiên) vẫn quét', () => {
    const fx = fixture()
    stage(fx.main, 'cfg.js', withSecret)
    assertPass(sh(fx, fx.main, 'git commit --dry-run -m x'))
    const fresh = path.join(fx.root, 'fresh')
    fs.mkdirSync(fresh)
    git(fresh, 'init', '-b', 'main')
    stage(fresh, 'cfg.js', withSecret)
    assert.match(assertDeny(sh(fx, fresh, 'git commit -m first')), /cfg\.js:2 — github/)
  })

  test('.env bị chặn, .env.example/.sample/.template và khoá công khai cho qua', () => {
    const fx = fixture()
    for (const f of ['.env.example', '.env.sample', '.env.template', 'keys/id_rsa.pub', 'README.md']) stage(fx.main, f, 'FOO=bar\n')
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    const flagged = ['.env', 'app/.env.production', 'keys/id_rsa', 'keys/id_ed25519', 'tls/server.pem', '.dev.vars', 'credentials.json']
    for (const f of flagged) stage(fx.main, f, 'FOO=bar\n')
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    for (const f of flagged) assert.ok(reason.includes(`${f} — file nhạy cảm`), `thiếu ${f}: ${reason}`)
    for (const f of ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'README.md']) assert.ok(!reason.includes(f), `không được báo ${f}: ${reason}`)
  })

  test('dòng flow-gate: allow-secret bỏ qua đúng dòng đó; file .env có dòng allow cho qua', () => {
    const fx = fixture()
    stage(fx.main, 'cfg.js', `a = "${GHP}" // flow-gate: allow-secret\nb = "${GHP}"\n`)
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assert.match(reason, /cfg\.js:2 — github/)
    assert.doesNotMatch(reason, /cfg\.js:1 /)
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'ok.js', `a = "${GHP}" // flow-gate: allow-secret\n`)
    stage(fx.main, '.env', '# flow-gate: allow-secret\nFOO=bar\n')
    assertPass(sh(fx, fx.main, 'git commit -m x'))
  })

  test('url-credential bị chặn; mật khẩu placeholder hoặc ngắn cho qua', () => {
    const fx = fixture()
    stage(fx.main, 'ok.yml', ['postgres://', 'user:${DB_PASS}@db/app'].join('') + '\n' + 'a://' + 'u:pw@h\n' + 'https://example.com/a:b@c\n')
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    stage(fx.main, 'bad.yml', 'url: ' + 'https://' + 'deploy:Xk9mP2qLr8@git.example.com/r.git\n')
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /bad\.yml:1 — url-credential/)
  })

  test('mẫu báo nhầm đã biết cho qua: khoá ví dụ AWS, URL mẫu user:password; khoá AWS khác vẫn chặn', () => {
    const fx = fixture()
    stage(fx.main, 'ok.json', '{"p": "' + 'http://' + 'user:password@host:port"}\n' + 'k = "AKIA' + 'IOSFODNN7EXAMPLE"\n')
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    stage(fx.main, 'bad.go', 'k = "AKIA' + 'IOSFODNN7EXAMPLF"\n' + 'u = "' + 'http://' + 'user:passwordX1@h"\n')
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assert.match(reason, /bad\.go:1 — aws/)
    assert.match(reason, /bad\.go:2 — url-credential/)
  })

  test('nhận lệnh trong chuỗi: cd, -C, ; ; bỏ qua nhắc trong chuỗi/comment', () => {
    const fx = fixture()
    stage(fx.main, 'cfg.js', withSecret)
    const main = fx.main.replace(/\\/g, '/')
    assertDeny(sh(fx, fx.root, `cd "${main}" && git commit -m x`))
    assertDeny(sh(fx, fx.root, `git -C "${main}" commit -m x`))
    assertDeny(sh(fx, fx.main, 'echo ok; git commit -m "gộp" # ghi chú'))
    assertPass(sh(fx, fx.main, 'echo "git commit -m x"'))
    assertPass(sh(fx, fx.main, '# git commit -m x'))
    assertPass(sh(fx, fx.main, 'git log --grep commit'))
    assertPass(sh(fx, fx.main, "cat <<'EOF'\ngit commit -m x\nEOF"))
  })

  test('push chỉ quét commit chưa có trên upstream', () => {
    const fx = fixture()
    addRemote(fx)
    commit(fx.main, 'old.js', withSecret, 'secret cũ')
    git(fx.main, 'push', '-u', 'origin', 'main')
    commit(fx.main, 'clean.js', 'ok\n', 'sạch')
    // secret cũ đã nằm trên upstream ⇒ quét sạch; push thường lên nhánh chính không còn hỏi ⇒ qua
    assertPass(sh(fx, fx.main, 'git push'))
    assertPass(sh(fx, fx.main, 'git push origin main'))
    commit(fx.main, 'new.js', withSecret, 'secret mới')
    for (const c of ['git push', 'git push origin main', 'git -C . push --force-with-lease']) {
      const reason = assertDeny(sh(fx, fx.main, c))
      assert.match(reason, /sắp push/)
      assert.match(reason, /new\.js:2 — github/)
      assert.doesNotMatch(reason, /old\.js/)
    }
    assertPass(sh(fx, fx.main, 'git push --dry-run'))
    assertPass(sh(fx, fx.main, 'git push origin --delete topic'))
  })

  test('push repo không upstream/remote: quét toàn bộ HEAD', () => {
    const fx = fixture()
    commit(fx.main, 'old.js', withSecret, 'secret cũ')
    commit(fx.main, 'clean.js', 'ok\n', 'sạch')
    assert.match(assertDeny(sh(fx, fx.main, 'git push origin main')), /old\.js:2 — github/)
  })

  test('push nhánh không upstream: base = origin/<nhánh chính>', () => {
    const fx = fixture()
    addRemote(fx)
    commit(fx.main, 'old.js', withSecret, 'secret cũ')
    git(fx.main, 'push', 'origin', 'main') // không -u: có origin/main nhưng feat không có upstream
    git(fx.wt, 'rebase', 'main')
    commit(fx.wt, 'new.js', withSecret, 'secret mới')
    const reason = assertDeny(sh(fx, fx.wt, 'git push origin feat'))
    assert.match(reason, /new\.js:2 — github/)
    assert.doesNotMatch(reason, /old\.js/)
  })

  test('lỗi git (không phải repo, repo chưa có commit, .git hỏng) ⇒ cho qua', () => {
    const fx = fixture()
    const empty = path.join(fx.root, 'empty')
    const broken = path.join(fx.root, 'broken')
    fs.mkdirSync(empty)
    git(empty, 'init', '-b', 'main')
    fs.mkdirSync(path.join(broken, '.git'), { recursive: true })
    for (const cwd of [fx.root, empty, broken, path.join(fx.root, 'khong-co')]) {
      assertPass(sh(fx, cwd, 'git commit -m x'))
      assertPass(sh(fx, cwd, 'git push'))
    }
  })

  test('diff vượt 20 MB bị cắt mà phần đã quét sạch ⇒ chỉ nhắc "quá lớn" (không chặn); có secret trong phần đã quét thì vẫn deny và liệt kê', () => {
    const fx = fixture()
    const pad = 'x'.repeat(99) + '\n'
    stage(fx.main, 'big.txt', pad.repeat(215000)) // ~21,5 MB, sạch
    const r1 = assertNudge(sh(fx, fx.main, 'git commit -m x'))
    assert.match(r1, /quá lớn/)
    assert.match(r1, /vẫn chạy/)
    assert.doesNotMatch(r1, /github/)
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'big2.txt', `t = "${GHP}"\n` + pad.repeat(215000))
    const r2 = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assert.match(r2, /big2\.txt:1 — github/)
    assert.match(r2, /vượt 20 MB/)
    assertExit(r2)
  })

  test('diff dưới giới hạn (vài MB) vẫn quét hết, secret ở cuối file được thấy', () => {
    const fx = fixture()
    stage(fx.main, 'mid.txt', ('x'.repeat(99) + '\n').repeat(55000) + `t = "${GHP}"\n`) // ~5,5 MB, secret ở cuối
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /mid\.txt:55001 — github/)
  })

  // ----- review Codex: commit -a / pathspec -----

  test('commit -a quét bản sẽ commit (diff HEAD): token đã stage rồi xoá khỏi working tree ⇒ qua; không -a thì index vẫn bị quét', () => {
    const fx = fixture()
    stage(fx.main, 'cfg.js', withSecret)
    write(fx.main, 'cfg.js', 'ok\n') // xoá token ở working tree, chưa stage
    assertPass(sh(fx, fx.main, 'git commit -am x'))
    assertPass(sh(fx, fx.main, 'git commit -a -m x'))
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /cfg\.js:2 — github/)
  })

  test('commit kèm pathspec/--only chỉ quét bản working tree của path đó; --include cộng thêm index', () => {
    const fx = fixture()
    stage(fx.main, 'b.js', withSecret) // token đã stage ở file khác
    assertPass(sh(fx, fx.main, 'git commit -m x a.txt')) // a.txt không đổi; index của b.js bị bỏ qua khi commit theo path
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -i -m x a.txt')), /b\.js:2 — github/)
    write(fx.main, 'a.txt', fs.readFileSync(path.join(fx.main, 'a.txt'), 'utf8') + `const t = "${GHP}"\n`) // token chưa stage ở file tracked
    for (const c of ['git commit -m x a.txt', 'git commit -m x -- a.txt', 'git commit --only -m x a.txt', 'git commit -om x a.txt', 'git commit a.txt -m x']) {
      const reason = assertDeny(sh(fx, fx.main, c))
      assert.match(reason, /a\.txt:21 — github/, c)
      assert.doesNotMatch(reason, /b\.js/, c)
    }
    assertDeny(sh(fx, fx.main, 'git commit -i -m x a.txt'))
  })

  test('-uall / --untracked-files=all không phải -a', () => {
    const fx = fixture()
    write(fx.main, 'a.txt', fs.readFileSync(path.join(fx.main, 'a.txt'), 'utf8') + `const t = "${GHP}"\n`)
    assertPass(sh(fx, fx.main, 'git commit -uall -m x'))
    assertPass(sh(fx, fx.main, 'git commit --untracked-files=all -m x'))
  })

  test('HEAD chưa có + -a: so với cây rỗng, vẫn quét', () => {
    const fx = fixture()
    const fresh = path.join(fx.root, 'fresh')
    fs.mkdirSync(fresh)
    git(fresh, 'init', '-b', 'main')
    stage(fresh, 'cfg.js', withSecret)
    assert.match(assertDeny(sh(fx, fresh, 'git commit -am first')), /cfg\.js:2 — github/)
  })

  // ----- review Codex: push quét từng commit + đúng ref được gửi -----

  test('push quét TỪNG commit: A thêm token, B xoá token ⇒ vẫn chặn (kể cả file nhạy cảm bị xoá sau)', () => {
    const fx = fixture()
    addRemote(fx)
    git(fx.main, 'push', '-u', 'origin', 'main')
    commit(fx.main, 'tmp.js', withSecret, 'A thêm token')
    commit(fx.main, 'tmp.js', 'ok\n', 'B xoá token') // diff cuối sạch
    assert.match(assertDeny(sh(fx, fx.main, 'git push')), /tmp\.js:2 — github/)
    git(fx.main, 'reset', '-q', '--hard', 'origin/main')
    commit(fx.main, '.env', 'FOO=bar\n', 'A thêm .env')
    git(fx.main, 'rm', '-q', '.env')
    git(fx.main, 'commit', '-m', 'B xoá .env')
    assert.match(assertDeny(sh(fx, fx.main, 'git push')), /\.env — file nhạy cảm/)
  })

  test('push không remote: quét lịch sử từng commit kể cả commit gốc', () => {
    const fx = fixture()
    const fresh = path.join(fx.root, 'fresh')
    fs.mkdirSync(fresh)
    git(fresh, 'init', '-b', 'main')
    commit(fresh, 'root.js', withSecret, 'commit gốc có token')
    commit(fresh, 'root.js', 'ok\n', 'xoá')
    assert.match(assertDeny(sh(fx, fresh, 'git push origin main')), /root\.js:2 — github/)
  })

  test('push theo refspec: quét nhánh được gửi, không phải HEAD', () => {
    const fx = fixture()
    commit(fx.wt, 'new.js', withSecret, 'secret trên feat') // feat bẩn; main sạch
    // đang ở main sạch nhưng gửi feat ⇒ chặn
    for (const c of ['git push origin feat', 'git push origin +feat:refs/heads/x', 'git push origin main feat', 'git push -o ci.skip origin feat', 'git push --force origin refs/heads/feat']) {
      assert.match(assertDeny(sh(fx, fx.main, c)), /new\.js:2 — github/, c)
    }
    // HEAD (main) sạch nên quét secret không chặn (gửi main/HEAD thường ⇒ qua); src sạch dù dst trùng tên nhánh bẩn ⇒ qua
    for (const c of ['git push', 'git push origin main', 'git push origin HEAD']) assertPass(sh(fx, fx.main, c))
    for (const c of ['git push origin main:feat', 'git push origin :feat', 'git push origin khong-ton-tai']) {
      assertPass(sh(fx, fx.main, c))
    }
    // HEAD (feat) bẩn: gửi main thì không bị chặn vì secret (qua); không refspec / HEAD / feat:main thì chặn
    assertPass(sh(fx, fx.wt, 'git push origin main'))
    for (const c of ['git push', 'git push origin HEAD', 'git push origin feat:main', 'git push origin HEAD:refs/heads/y']) {
      assert.match(assertDeny(sh(fx, fx.wt, c)), /new\.js:2 — github/, c)
    }
  })

  test('push --all / --mirror quét mọi nhánh local; --tags không quét HEAD (chỉ tag)', () => {
    const fx = fixture()
    commit(fx.wt, 'new.js', withSecret, 'secret trên feat')
    for (const c of ['git push --all origin', 'git push origin --mirror']) assert.match(assertDeny(sh(fx, fx.main, c)), /new\.js:2 — github/, c)
    assertPass(sh(fx, fx.wt, 'git push --tags')) // HEAD bẩn nhưng chỉ gửi tag, chưa có tag nào
    assertPass(sh(fx, fx.wt, 'git push origin --tags'))
    assert.match(assertDeny(sh(fx, fx.wt, 'git push origin feat --tags')), /new\.js:2/) // refspec + --tags: vẫn quét refspec
  })

  // ----- review Codex vòng 2: --repo, --tags, --mirror -----

  test('push --repo: mọi positional là refspec, remote = --repo', () => {
    const fx = fixture()
    commit(fx.wt, 'new.js', withSecret, 'secret trên feat') // feat bẩn; main sạch
    for (const c of ['git push --repo=origin feat', 'git push --repo origin feat', 'git push --repo origin main feat']) {
      assert.match(assertDeny(sh(fx, fx.main, c)), /new\.js:2 — github/, c)
    }
    assertPass(sh(fx, fx.main, 'git push --repo=origin main')) // gửi main sạch ⇒ qua
    assertPass(sh(fx, fx.main, 'git push --repo origin')) // không refspec ⇒ HEAD (main) sạch ⇒ qua
    assert.match(assertDeny(sh(fx, fx.wt, 'git push --repo origin')), /new\.js:2/) // HEAD = feat bẩn
  })

  test('push --repo: base theo refs/remotes/<--repo>/<nhánh>', () => {
    const fx = fixture()
    addRemote(fx)
    commit(fx.wt, 'new.js', withSecret, 'secret trên feat')
    git(fx.wt, 'push', 'origin', 'feat') // origin/feat đã có new.js
    commit(fx.wt, 'clean.js', 'ok\n', 'sạch')
    assertPass(sh(fx, fx.wt, 'git push --repo=origin feat'))
    assertPass(sh(fx, fx.wt, 'git push --repo origin feat'))
    commit(fx.wt, 'new2.js', withSecret, 'secret mới')
    const reason = assertDeny(sh(fx, fx.wt, 'git push --repo origin feat'))
    assert.match(reason, /new2\.js:2/)
    assert.doesNotMatch(reason, /new\.js:2/)
  })

  test('push --tags quét commit của mọi tag (nhẹ lẫn có chú thích); tag trỏ commit đã có trên remote thì qua', () => {
    const fx = fixture()
    addRemote(fx)
    git(fx.main, 'tag', 'v0') // trỏ commit sạch
    assertPass(sh(fx, fx.main, 'git push origin --tags'))
    commit(fx.main, 'old.js', withSecret, 'secret cũ')
    git(fx.main, 'tag', '-a', 'v1', '-m', 'x')
    git(fx.main, 'push', 'origin', 'main', 'v1') // commit có token đã nằm trên origin/main
    assertPass(sh(fx, fx.main, 'git push origin --tags'))
    commit(fx.wt, 'new.js', withSecret, 'secret trên feat') // HEAD main vẫn sạch
    git(fx.main, 'tag', 'v2', 'feat') // tag nhẹ
    git(fx.main, 'tag', '-a', 'v3', '-m', 'x', 'feat') // tag có chú thích
    for (const c of ['git push origin --tags', 'git push --tags', 'git push --tags origin', 'git push --repo=origin --tags']) {
      const reason = assertDeny(sh(fx, fx.main, c))
      assert.match(reason, /new\.js:2 — github/, c)
      assert.doesNotMatch(reason, /old\.js/, c)
    }
  })

  test('push --mirror quét mọi ref (cả tag và ref lạ trỏ commit không thuộc nhánh nào); --all không quét tag; mirror sạch vẫn bị chặn như push ép', () => {
    const fx = fixture()
    addRemote(fx)
    git(fx.main, 'tag', 'v0')
    assert.match(assertDeny(sh(fx, fx.main, 'git push --mirror origin')), /--mirror \/ --prune/) // mirror sạch: quét secret qua, nhưng --mirror ghi đè cả nhánh chính ⇒ chặn như push ép
    git(fx.wt, 'checkout', '-q', '--detach')
    commit(fx.wt, 'tagged.js', withSecret, 'secret chỉ có ở tag')
    git(fx.wt, 'tag', 'v9')
    git(fx.wt, 'checkout', '-q', 'feat')
    for (const c of ['git push --mirror origin', 'git push origin --mirror']) assert.match(assertDeny(sh(fx, fx.main, c)), /tagged\.js:2 — github/, c)
    assertPass(sh(fx, fx.main, 'git push --all origin')) // --all chỉ gửi nhánh, các nhánh đều sạch, không ép ⇒ qua
    git(fx.wt, 'tag', '-d', 'v9')
    assert.match(assertDeny(sh(fx, fx.main, 'git push --mirror origin')), /--mirror \/ --prune/)
    git(fx.wt, 'checkout', '-q', '--detach')
    commit(fx.wt, 'other.js', withSecret, 'secret ở ref lạ')
    git(fx.wt, 'update-ref', 'refs/other/x', 'HEAD')
    git(fx.wt, 'checkout', '-q', 'feat')
    assert.match(assertDeny(sh(fx, fx.main, 'git push --mirror origin')), /other\.js:2 — github/)
  })

  test('push: base riêng cho từng nhánh = refs/remotes/<remote>/<nhánh>', () => {
    const fx = fixture()
    addRemote(fx)
    commit(fx.main, 'old.js', withSecret, 'secret cũ')
    git(fx.main, 'push', 'origin', 'main')
    git(fx.wt, 'rebase', 'main')
    commit(fx.wt, 'new.js', withSecret, 'secret mới trên feat')
    git(fx.wt, 'push', 'origin', 'feat') // origin/feat có new.js
    commit(fx.wt, 'clean.js', 'ok\n', 'sạch')
    assertPass(sh(fx, fx.wt, 'git push origin feat')) // chỉ commit sạch chưa gửi
    assertPass(sh(fx, fx.main, 'git push origin feat')) // gửi từ thư mục khác: vẫn theo origin/feat
    commit(fx.wt, 'new2.js', withSecret, 'secret mới nữa')
    const reason = assertDeny(sh(fx, fx.wt, 'git push origin feat'))
    assert.match(reason, /new2\.js:2 — github/)
    assert.doesNotMatch(reason, /new\.js:2|old\.js/)
  })

  test('merge thiếu dấu chỉ nhắc; cùng lệnh có commit chứa secret thì secret vẫn bị chặn', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    stage(fx.main, 'cfg.js', withSecret)
    assert.match(assertNudge(sh(fx, fx.main, 'git merge feat')), /Gộp khi còn thiếu/)
    assert.match(assertDeny(sh(fx, fx.main, 'git merge feat && git commit -m x')), /cfg\.js:2 — github/)
  })

  test('lời chặn secret có lối ra FLOW_OK=1; lệnh chạy lại với tiền tố FLOW_OK=1 (kể cả PowerShell $env:FLOW_OK=1;) cho qua dù vẫn có secret', () => {
    const fx = fixture()
    stage(fx.main, 'cfg.js', withSecret)
    assertExit(assertDeny(sh(fx, fx.main, 'git commit -m x')))
    assertPass(sh(fx, fx.main, 'FLOW_OK=1 git commit -m x'))
    assertPass(sh(fx, fx.main, '$env:FLOW_OK=1; git commit -m x'))
  })
})

// ---------- Làn A (flow-v5): dấu test xanh ----------

describe('stamp test (dấu test xanh)', () => {
  function featFx() {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    return fx
  }
  const stampTest = (fx, ...cmd) => cli(fx, fx.wt, 'stamp', 'test', '--', ...cmd)
  const stampFile = (fx, ext) => path.join(fx.gates, `test-${pidOf(fx)}.${ext}`)

  test('lệnh xanh: ghi test-<pid>.json {cmd, ts, durationMs} + test-<pid>.log, in output ra màn hình, in pid cuối cùng', () => {
    const fx = featFx()
    const r = stampTest(fx, 'node', '-e', "console.log('hello-stamp'); console.error('err-line')")
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /hello-stamp/)
    assert.match(r.stderr, /err-line/)
    const pid = pidOf(fx)
    assert.equal(r.stdout.trim().split(/\r?\n/).at(-1), pid)
    const stamp = JSON.parse(fs.readFileSync(stampFile(fx, 'json'), 'utf8'))
    assert.match(stamp.cmd, /hello-stamp/)
    assert.ok(!Number.isNaN(Date.parse(stamp.ts)), `ts không phải ngày: ${stamp.ts}`)
    assert.ok(Number.isInteger(stamp.durationMs) && stamp.durationMs >= 0, `durationMs: ${stamp.durationMs}`)
    const logText = fs.readFileSync(stampFile(fx, 'log'), 'utf8')
    assert.match(logText, /hello-stamp/)
    assert.match(logText, /err-line/)
  })

  test('lệnh đỏ: thoát cùng mã, không ghi dấu json nhưng vẫn giữ log', () => {
    const fx = featFx()
    const r = stampTest(fx, 'node', '-e', "console.log('truoc-khi-do'); process.exit(3)")
    assert.equal(r.status, 3)
    assert.match(r.stdout, /truoc-khi-do/)
    assert.ok(!fs.existsSync(stampFile(fx, 'json')))
    assert.match(fs.readFileSync(stampFile(fx, 'log'), 'utf8'), /truoc-khi-do/)
  })

  test('lệnh không tồn tại ⇒ thoát ≠ 0, không ghi dấu', () => {
    const fx = featFx()
    const r = stampTest(fx, 'lenh-khong-ton-tai-flow-gate')
    assert.notEqual(r.status, 0)
    assert.ok(!fs.existsSync(stampFile(fx, 'json')))
  })

  test('đánh dấu đang chạy có mặt suốt lúc lệnh chạy, gỡ sạch khi xong (đạt, hỏng, lệnh không tồn tại)', () => {
    const fx = featFx()
    const dir = fx.gates.replace(/\\/g, '/')
    const leftovers = () => (fs.existsSync(fx.gates) ? fs.readdirSync(fx.gates).filter((f) => f.startsWith('running-test-')) : [])
    // Lệnh tự kiểm: có running-test-*.json trong gatesDir lúc nó chạy thì thoát theo mã `ok`, không thì 7.
    const probe = (ok) => `process.exit(require('fs').readdirSync('${dir}').some(function (f) { return f.startsWith('running-test-') }) ? ${ok} : 7)`
    assert.equal(stampTest(fx, 'node', '-e', probe(0)).status, 0, 'lúc lệnh đạt chạy phải có đánh dấu')
    assert.deepEqual(leftovers(), [])
    assert.equal(stampTest(fx, 'node', '-e', probe(3)).status, 3, 'lúc lệnh hỏng chạy phải có đánh dấu')
    assert.deepEqual(leftovers(), [])
    assert.notEqual(stampTest(fx, 'lenh-khong-ton-tai-flow-gate').status, 0)
    assert.deepEqual(leftovers(), [])
  })

  test('đã có dấu xanh mà chạy lại ra đỏ ⇒ dấu cũ bị gỡ (lần chạy cuối quyết định)', () => {
    const fx = featFx()
    assert.equal(stampTest(fx, 'node', '-e', '0').status, 0)
    assert.ok(fs.existsSync(stampFile(fx, 'json')))
    assert.equal(stampTest(fx, 'node', '-e', 'process.exit(1)').status, 1)
    assert.ok(!fs.existsSync(stampFile(fx, 'json')))
  })

  test('chạy trong cwd của worktree; một token duy nhất được chạy nguyên văn như dòng lệnh (có &&)', () => {
    const fx = featFx()
    // Dòng lệnh đi qua shell của máy (cmd.exe trên Windows, /bin/sh trên macOS/Linux) ⇒ chỉ dùng cú pháp cả hai hiểu:
    // JS phải nằm trong nháy kép, nếu không sh báo lỗi cú pháp ở dấu "(".
    const line = `node -e 0 && node -e "require('fs').writeFileSync('ran.txt','x')"`
    const r = stampTest(fx, line)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(fs.existsSync(path.join(fx.wt, 'ran.txt')), 'lệnh phải chạy với cwd = worktree')
    assert.equal(JSON.parse(fs.readFileSync(stampFile(fx, 'json'), 'utf8')).cmd, line)
  })

  test('diff rỗng hoặc thiếu lệnh ⇒ lỗi, không chạy lệnh, không tạo dấu', () => {
    const fx = fixture() // chưa có commit nào khác main
    const r = stampTest(fx, 'node', '-e', "require('fs').writeFileSync('ran.txt','x')")
    assert.equal(r.status, 1)
    assert.match(r.stderr, /rỗng/)
    assert.ok(!fs.existsSync(path.join(fx.wt, 'ran.txt')))
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    assert.equal(cli(fx, fx.wt, 'stamp', 'test', '--').status, 1)
    assert.equal(cli(fx, fx.wt, 'stamp', 'test').status, 1)
    assert.ok(!fs.existsSync(fx.gates) || fs.readdirSync(fx.gates).every((f) => !f.endsWith('.json')))
  })

  test('merge: thiếu dấu test chỉ bị nhắc "test"; có dấu test thì im', () => {
    const fx = featFx()
    stampBoth(fx, { test: false })
    const ctx = assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.match(ctx, /Gộp khi còn thiếu: test\./)
    assert.doesNotMatch(ctx, /review|qa/)
    assert.equal(stampTest(fx, 'node', '-e', '0').status, 0)
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('thiếu cả ba dấu: nhắc review, qa, test', () => {
    const fx = featFx()
    assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /Gộp khi còn thiếu: review, qa, test\./)
  })

  test('dấu test của diff cũ không còn hiệu lực sau khi diff đổi (patch-id đổi)', () => {
    const fx = featFx()
    stampBoth(fx)
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    commit(fx.wt, 'feat2.go', 'package y\n', 'feat2')
    assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /Gộp khi còn thiếu: review, qa, test\./)
  })

  test('flow.json {"tests":"none"} ⇒ merge không nhắc test; vẫn nhắc review + qa', () => {
    const fx = featFx()
    write(fx.main, '.claude/flow.json', JSON.stringify({ tests: 'none' }))
    assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /Gộp khi còn thiếu: review, qa\./)
    stampBoth(fx, { test: false })
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('flow.json hỏng hoặc tests khác "none" ⇒ vẫn nhắc dấu test', () => {
    const fx = featFx()
    stampBoth(fx, { test: false })
    write(fx.main, '.claude/flow.json', '{không json')
    assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /Gộp khi còn thiếu: test\./)
    write(fx.main, '.claude/flow.json', JSON.stringify({ tests: 'all' }))
    assert.match(assertNudge(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /Gộp khi còn thiếu: test\./)
  })

  test('stop nudge tính cả test: thiếu test thì nhắc kèm lệnh mẫu; đủ ba dấu thì thôi', () => {
    const fx = featFx()
    stampBoth(fx, { test: false })
    const reason = assertBlock(hook(fx, 'stop', { cwd: fx.wt, stop_hook_active: false }))
    assert.match(reason, /thiếu: test\./)
    assert.match(reason, /stamp test -- <lệnh test đủ bộ>/)
    const fx2 = featFx()
    stampBoth(fx2)
    assertPass(hook(fx2, 'stop', { cwd: fx2.wt, stop_hook_active: false }))
  })

  test('status in dòng test: không → có; "không đòi" khi flow.json tests=none', () => {
    const fx = featFx()
    stampBoth(fx, { test: false })
    assert.match(cli(fx, fx.wt, 'status').stdout, /review: có\r?\nqa: có\r?\ntest: không\r?\n?$/)
    assert.equal(stampTest(fx, 'node', '-e', '0').status, 0)
    assert.match(cli(fx, fx.wt, 'status').stdout, /qa: có\r?\ntest: có/)
    const fx2 = featFx()
    commit(fx2.wt, '.claude/flow.json', JSON.stringify({ tests: 'none' }), 'flow.json') // status đọc flow.json của checkout hiện tại
    assert.match(cli(fx2, fx2.wt, 'status').stdout, /test: không đòi/)
  })

  // ----- diff chỉ có tài liệu (.md/.mdx/.txt hoặc dưới docs/) ⇒ không đòi dấu test; review + qa vẫn đòi -----

  const merge = (fx) => hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))

  test('diff chỉ có .md thiếu dấu test ⇒ không nhắc gì; diff có .ts thiếu dấu test ⇒ nhắc test', () => {
    const fx = fixture()
    commit(fx.wt, 'README.md', '# doc\n', 'docs')
    stampBoth(fx, { test: false })
    assertPass(merge(fx))
    const fx2 = fixture()
    commit(fx2.wt, 'src/app.ts', 'export {}\n', 'code')
    stampBoth(fx2, { test: false })
    assert.match(assertNudge(merge(fx2)), /Gộp khi còn thiếu: test\./)
  })

  test('tài liệu: .md .mdx .txt (không phân biệt hoa thường) và mọi file dưới docs/; diff chỉ tài liệu vẫn nhắc review + qa', () => {
    const fx = fixture()
    commit(fx.wt, 'README.MD', '# a\n', 'a')
    commit(fx.wt, 'guide/intro.mdx', '# b\n', 'b')
    commit(fx.wt, 'notes/todo.txt', 'c\n', 'c')
    commit(fx.wt, 'docs/diagram.png', 'png\n', 'd')
    commit(fx.wt, 'docs/api/schema.json', '{}\n', 'e')
    assert.match(assertNudge(merge(fx)), /Gộp khi còn thiếu: review, qa\./) // không có "test"
    stampBoth(fx, { test: false })
    assertPass(merge(fx))
  })

  test('diff lẫn tài liệu và code ⇒ vẫn nhắc test; docs nằm sâu (src/docs/…) hoặc đuôi .md.ts không phải tài liệu', () => {
    const fx = fixture()
    commit(fx.wt, 'README.md', '# doc\n', 'docs')
    commit(fx.wt, 'src/app.ts', 'export {}\n', 'code')
    stampBoth(fx, { test: false })
    assert.match(assertNudge(merge(fx)), /Gộp khi còn thiếu: test\./)
    const fx2 = fixture()
    commit(fx2.wt, 'src/docs/Viewer.ts', 'export {}\n', 'x')
    stampBoth(fx2, { test: false })
    assert.match(assertNudge(merge(fx2)), /Gộp khi còn thiếu: test\./)
    const fx3 = fixture()
    commit(fx3.wt, 'notes.md.ts', 'export {}\n', 'x')
    stampBoth(fx3, { test: false })
    assert.match(assertNudge(merge(fx3)), /Gộp khi còn thiếu: test\./)
  })

  test('đổi tên file code thành tài liệu vẫn tính là đổi code (cả hai đầu đường dẫn)', () => {
    const fx = fixture()
    commit(fx.main, 'src/old.ts', 'export {}\n', 'thêm old.ts')
    git(fx.wt, 'rebase', 'main')
    fs.mkdirSync(path.join(fx.wt, 'docs'), { recursive: true })
    git(fx.wt, 'mv', 'src/old.ts', 'docs/old.md')
    git(fx.wt, 'commit', '-m', 'đổi tên')
    stampBoth(fx, { test: false })
    assert.match(assertNudge(merge(fx)), /Gộp khi còn thiếu: test\./)
  })

  test('diff chỉ tài liệu: stop nudge không đòi test; status ghi lý do không đòi', () => {
    const fx = fixture()
    commit(fx.wt, 'README.md', '# doc\n', 'docs')
    stampBoth(fx, { test: false })
    assertPass(hook(fx, 'stop', { cwd: fx.wt, stop_hook_active: false }))
    assert.match(cli(fx, fx.wt, 'status').stdout, /test: không đòi \(diff chỉ có tài liệu\)/)
  })
})

// ---------- Làn A (flow-v5): chặn lệnh phá huỷ trên nhánh chính ----------

describe('bash: lệnh phá huỷ trên nhánh chính', () => {
  const sh = (fx, cwd, command) => hook(fx, 'bash', bashIn(cwd, command))

  test('git push ép lên nhánh chính bị chặn (cờ ép, refspec +, HEAD khi đang ở main, --all/--mirror)', () => {
    const fx = fixture()
    for (const c of [
      'git push --force origin main', 'git push -f origin main', 'git push origin main --force', 'git push --force-with-lease origin main',
      'git push --force-with-lease=main:abc123 origin main', 'git push --force-if-includes origin main', 'git push -fu origin main',
      'git push -uf origin master', 'git push origin +main', 'git push origin +HEAD:main', 'git push origin +feat:master',
      'git push origin +refs/heads/feat:refs/heads/main', 'git push --force', 'git push -f origin', 'git push --force origin HEAD',
      'git push --force --all origin', 'git push -f --mirror origin', 'git -C . push --force origin main', 'echo ok && git push -f origin main',
    ]) assert.match(assertDeny(sh(fx, fx.main, c)), /nhánh chính/, c)
  })

  test('push ép không phải nhánh chính, dry-run, chỉ tag ⇒ không chặn', () => {
    const fx = fixture()
    for (const c of [
      'git push --force origin feat', 'git push -f origin feat:other', 'git push origin +feat', 'git push --force origin main:feat',
      'git push --force --dry-run origin main', 'git push --force --tags origin', 'git push -o ci.skip --force origin feat',
    ]) assertPass(sh(fx, fx.main, c))
    assertPass(sh(fx, fx.wt, 'git push --force')) // HEAD = feat
    assertPass(sh(fx, fx.wt, 'git push --force-with-lease origin HEAD'))
  })

  test('git reset --hard chỉ bị chặn ở thư mục chính khi đang ở nhánh chính', () => {
    const fx = fixture()
    for (const c of ['git reset --hard', 'git reset --hard HEAD~1', 'git reset -q --hard origin/main', 'echo x && git reset --hard']) {
      assert.match(assertDeny(sh(fx, fx.main, c)), /reset --hard/, c)
    }
    assertDeny(sh(fx, fx.root, `git -C "${fx.main.replace(/\\/g, '/')}" reset --hard`))
    for (const c of ['git reset --soft HEAD~1', 'git reset', 'git reset HEAD a.txt', 'git reset --mixed', 'echo "git reset --hard"']) assertPass(sh(fx, fx.main, c))
    assertPass(sh(fx, fx.wt, 'git reset --hard')) // linked worktree
    git(fx.main, 'checkout', '-q', '-b', 'topic') // thư mục chính nhưng không ở nhánh chính
    assertPass(sh(fx, fx.main, 'git reset --hard'))
  })

  test('git branch -D / -d -f xoá nhánh chính bị chặn; xoá nhánh khác, -d thường, di chuyển/đổi tên cho qua', () => {
    const fx = fixture()
    for (const cwd of [fx.main, fx.wt]) {
      for (const c of [
        'git branch -D main', 'git branch -D master', 'git branch -d -f main', 'git branch -df main', 'git branch -fd main',
        'git branch --delete --force main', 'git branch -D feat main',
      ]) assert.match(assertDeny(sh(fx, cwd, c)), /nhánh chính/, c)
    }
    for (const c of ['git branch -D feat', 'git branch -d main', 'git branch', 'git branch -f feat main', 'git branch -m main trunk', 'git branch topic']) {
      assertPass(sh(fx, fx.main, c))
    }
  })

  test('xoá nhánh chính trên remote (--delete/-d main|master, refspec rỗng nguồn :main) bị chặn; xoá nhánh khác thì qua', () => {
    const fx = fixture()
    for (const cwd of [fx.main, fx.wt]) {
      for (const c of [
        'git push origin --delete main', 'git push origin -d main', 'git push --delete origin master', 'git push origin --delete refs/heads/main',
        'git push origin --delete feat main', 'git push --repo origin --delete main', 'git push --repo=origin --delete master',
        'git push origin :main', 'git push origin :master', 'git push origin :refs/heads/main', 'git push origin +:main',
        'git push origin feat :main', 'git push --repo=origin :main', 'echo ok && git push origin --delete main',
      ]) assert.match(assertDeny(sh(fx, cwd, c)), /nhánh chính/, c)
    }
    for (const c of [
      'git push origin --delete feat', 'git push origin -d topic', 'git push --delete origin tag-x', 'git push origin :feat', 'git push origin :refs/heads/feat',
      'git push --dry-run origin --delete main', 'git push -n origin :main', 'git push origin main:feat', 'git push --repo origin --delete feat',
    ]) assertPass(sh(fx, fx.main, c))
  })

  test('git branch -m/-M/--move đè nhánh chính (đích là main|master) bị chặn; đổi tên sang tên khác hoặc đổi tên đi thì qua', () => {
    const fx = fixture()
    for (const [cwd, c] of [
      [fx.main, 'git branch -M feat main'], [fx.main, 'git branch -m feat main'], [fx.main, 'git branch -M feat master'],
      [fx.main, 'git branch --move feat main'], [fx.main, 'git branch -M -f feat main'], [fx.main, 'git branch -M master'],
      [fx.wt, 'git branch -m main'], [fx.wt, 'git branch -M master'], [fx.wt, 'echo ok && git branch -M feat main'],
    ]) assert.match(assertDeny(sh(fx, cwd, c)), /nhánh chính/, c)
    for (const [cwd, c] of [
      [fx.main, 'git branch -m main trunk'], [fx.main, 'git branch -m feat feat2'], [fx.main, 'git branch -M feat topic'],
      [fx.main, 'git branch -m topic'], [fx.main, 'git branch -m main'], // đang ở main: đổi tên main thành main = không làm gì
      [fx.wt, 'git branch -M x'], [fx.wt, 'git branch -m'],
    ]) assertPass(sh(fx, cwd, c))
  })

  test('git checkout -- . / restore . / clean -f* ở thư mục chính bị chặn; ở worktree thì qua', () => {
    const fx = fixture()
    const bad = [
      'git checkout -- .', 'git checkout .', 'git checkout HEAD -- .', 'git restore .', 'git restore --source=HEAD~1 .', 'git restore -W .',
      'git restore --staged --worktree .', 'git clean -f', 'git clean -fd', 'git clean -fdx', 'git clean -df', 'git clean --force -d', 'git clean -d -f -x',
    ]
    for (const c of bad) assertDeny(sh(fx, fx.main, c))
    for (const c of bad) assertPass(sh(fx, fx.wt, c))
    for (const c of [
      'git checkout feat', 'git checkout -b x', 'git checkout -- a.txt', 'git restore a.txt', 'git restore --staged .', 'git restore -S .',
      'git clean -n', 'git clean -nfd', 'git clean --dry-run -f', 'git clean', 'echo "git clean -fd"',
    ]) assertPass(sh(fx, fx.main, c))
    git(fx.main, 'checkout', '-q', '-b', 'topic') // thư mục chính, nhánh khác: vẫn chặn (luật theo thư mục, không theo nhánh)
    assertDeny(sh(fx, fx.main, 'git clean -fd'))
    assertDeny(sh(fx, fx.main, 'git restore .'))
  })

  test('nhiều lệnh trong một chuỗi: deny vẫn thắng (push thường không sinh gì, đến trước hay sau đều vậy)', () => {
    const fx = fixture()
    assertPass(sh(fx, fx.main, 'git push origin main')) // đơn lẻ: qua
    assertDeny(sh(fx, fx.main, 'git push origin main && git push --force origin main'))
    assertDeny(sh(fx, fx.main, 'git push --force origin main; git push origin main'))
    assertDeny(sh(fx, fx.main, 'git push origin main && git reset --hard'))
  })

  test('lỗi nội bộ (không phải repo, cwd không tồn tại) ⇒ cho qua', () => {
    const fx = fixture()
    for (const cwd of [fx.root, path.join(fx.root, 'khong-co')]) {
      for (const c of ['git push --force origin main', 'git reset --hard', 'git clean -fd', 'git restore .', 'git branch -D main']) assertPass(sh(fx, cwd, c))
    }
  })

  // ----- lối ra FLOW_OK= -----

  test('mọi lời chặn có lối ra; chạy lại với tiền tố FLOW_OK=1 (bash) hoặc $env:FLOW_OK=1; (PowerShell) cho qua', () => {
    const fx = fixture()
    for (const c of [
      'git push --force origin main', 'git push origin --delete main', 'git reset --hard', 'git branch -D main', 'git branch -M feat main',
      'git clean -fd', 'git restore .', 'git checkout -- .', 'rm -rf build',
    ]) {
      assertExit(assertDeny(sh(fx, fx.main, c)))
      assertPass(sh(fx, fx.main, `FLOW_OK=1 ${c}`))
      assertPass(sh(fx, fx.main, `$env:FLOW_OK=1; ${c}`))
    }
  })

  test('FLOW_OK= cho qua và ghi một dòng vào flow-approvals.log (giờ + tối đa 200 ký tự đầu của lệnh, che secret, gộp xuống dòng); lệnh bị chặn thường không ghi', () => {
    const fx = fixture()
    const approvals = path.join(fx.root, 'flow-approvals.log') // cạnh flow-gate.log
    assertDeny(sh(fx, fx.main, 'git reset --hard'))
    assert.ok(!fs.existsSync(approvals), 'chưa dùng lối ra thì chưa có log')
    assertPass(sh(fx, fx.main, 'FLOW_OK=1 git reset --hard'))
    const secret = 'ghp_' + 'a'.repeat(36)
    assertPass(sh(fx, fx.main, `FLOW_OK=1 git reset --hard # ${secret}\n${'x'.repeat(300)}`))
    const lines = fs.readFileSync(approvals, 'utf8').trim().split(/\r?\n/)
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z FLOW_OK=1 git reset --hard$/)
    const [stamp, ...rest] = lines[1].split(' ')
    assert.ok(!Number.isNaN(Date.parse(stamp)))
    const shown = rest.join(' ')
    assert.ok(shown.length <= 200, `dòng log dài ${shown.length}`)
    assert.ok(!shown.includes('ghp_'), 'secret không được vào log')
    assert.match(shown, /^FLOW_OK=1 git reset --hard # \*\*\* \| x+$/)
  })

  test('FLOW_OK= cho qua cả khi cổng khác sẽ chặn (secret trong commit) và không phụ thuộc vị trí trong lệnh', () => {
    const fx = fixture()
    write(fx.main, 'cfg.js', `const t = "ghp_${'a'.repeat(36)}"\n`)
    git(fx.main, 'add', '--', 'cfg.js')
    assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assertPass(sh(fx, fx.main, 'git commit -m x && FLOW_OK=1 true'))
    assertPass(sh(fx, fx.main, 'env FLOW_OK=1 git commit -m x'))
  })
})

// ---------- push nhánh chính: không còn hộp hỏi; chỉ chặn push ép / xoá / secret ----------

describe('bash: push nhánh chính', () => {
  const sh = (fx, cwd, command) => hook(fx, 'bash', bashIn(cwd, command))
  const GHP = 'ghp_' + 'a'.repeat(36)

  // Repo + remote bare `origin`, main đã push (origin/main = HEAD của main).
  function remoteFx() {
    const fx = fixture()
    const bare = path.join(fx.root, 'remote.git')
    git(fx.root, 'init', '--bare', '-b', 'main', bare)
    git(fx.main, 'remote', 'add', 'origin', bare)
    git(fx.main, 'push', '-u', 'origin', 'main')
    return fx
  }

  test('push thường lên nhánh chính (nhiều commit, không remote-tracking, remote lạ, -u, refspec đầy đủ) ⇒ qua, không hộp hỏi', () => {
    const fx = remoteFx()
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    commit(fx.main, 'x2.txt', 'x\n', 'thêm x2')
    for (const c of ['git push', 'git push origin main', 'git push origin HEAD', 'git -C . push origin main', 'git push -u origin main', 'git push origin refs/heads/main:refs/heads/main']) {
      assertPass(sh(fx, fx.main, c))
    }
    const bare = fixture() // chưa có remote nào
    for (const c of ['git push origin main', 'git push upstream main']) assertPass(sh(bare, bare.main, c))
    git(bare.main, 'config', 'branch.main.remote', 'gitlab')
    assertPass(sh(bare, bare.main, 'git push'))
  })

  test('đã đồng bộ (0 commit), nhánh khác main, dry-run, xoá ref, chỉ tag ⇒ cho qua', () => {
    const fx = remoteFx()
    assertPass(sh(fx, fx.main, 'git push')) // origin/main = main
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    commit(fx.wt, 'f.go', 'package f\n', 'feat commit')
    assertPass(sh(fx, fx.wt, 'git push origin feat'))
    assertPass(sh(fx, fx.wt, 'git push'))
    assertPass(sh(fx, fx.main, 'git push --dry-run origin main'))
    assertPass(sh(fx, fx.main, 'git push origin --delete topic'))
    assertPass(sh(fx, fx.main, 'git push origin --tags'))
    assertPass(sh(fx, fx.main, 'git push origin main:feat'))
  })

  test('gửi nhánh khác vào main của remote khác (feat:main) và --all ⇒ qua', () => {
    const fx = remoteFx()
    commit(fx.wt, 'f.go', 'package f\n', 'feat commit')
    assertPass(sh(fx, fx.wt, 'git push origin feat:main'))
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    assertPass(sh(fx, fx.main, 'git push --all origin'))
  })

  test('--mirror / --prune mà đích gồm nhánh chính ⇒ deny như push ép; --prune lên nhánh khác thì không bị chặn vì lý do này', () => {
    const fx = remoteFx()
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    for (const c of ['git push --mirror origin', 'git push origin --mirror', 'git push --prune origin main', 'git push --prune origin', 'git push origin --prune main:main']) {
      assert.match(assertDeny(sh(fx, fx.main, c)), /--mirror \/ --prune/, c)
    }
    commit(fx.wt, 'f.go', 'package f\n', 'feat commit')
    assertPass(sh(fx, fx.wt, 'git push --prune origin feat')) // đích là nhánh feat, không đụng nhánh chính
    assertPass(sh(fx, fx.main, 'git push --dry-run --mirror origin')) // dry-run không ghi đè gì
  })

  test('cụm cờ ngắn (-dv, -4f) và --prune với refspec đại diện vẫn bị bắt; cú pháp lạ (cờ viết tắt, bọc shell, gán biến, -c, cấu hình remote) không còn bị chặn chỉ vì khó đọc', () => {
    const fx = remoteFx()
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    assert.match(assertDeny(sh(fx, fx.main, 'git push -dv origin main')), /Không xoá nhánh chính/) // cụm -dv vẫn là xoá
    assert.match(assertDeny(sh(fx, fx.main, 'git push -4f origin main')), /push ép/)
    assert.match(assertDeny(sh(fx, fx.main, "git push --prune origin 'refs/heads/*:refs/heads/*'")), /--mirror \/ --prune/)
    for (const c of [
      'git push --force-with origin main', 'git push --mirro origin', 'git push -x origin main', 'git -c push.default=matching push',
      'git -c remote.origin.mirror=true push origin', 'command git push origin main', 'env git push origin main', 'bash -c "git push origin main"',
      'HOME=/tmp/x git push origin main', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push origin',
      'git config remote.origin.mirror true && git push origin', "git -c alias.ship='push' ship origin main", 'f=origin; git push $f main',
    ]) assertPass(sh(fx, fx.main, c))
    git(fx.main, 'config', 'remote.origin.mirror', 'true') // cấu hình remote mirror không còn được soi: cổng chỉ đọc lệnh gõ ra
    assertPass(sh(fx, fx.main, 'git push origin'))
  })

  test('có secret trong phần sắp push ⇒ deny', () => {
    const fx = remoteFx()
    commit(fx.main, 'cfg.js', `const t = "${GHP}"\n`, 'secret')
    for (const c of ['git push', 'git push origin main']) {
      assert.match(assertDeny(sh(fx, fx.main, c)), /cfg\.js:1 — github/, c)
    }
  })
})

// ---------- Làn A (flow-v5): audit phạm vi khi worker nộp ----------

describe('subagent-stop: audit phạm vi làn', () => {
  const RECEIPT = 'return=done; paths=feat.go; checks=ok; blocker=; stop'
  const jsonl = (fx, name, entries) => write(fx.root, name, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const userMsg = (content) => ({ type: 'user', message: { role: 'user', content } })
  const asst = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } })
  const briefOf = (plan, rest = 'lane=A') => `outcome=x\nscope=feat.go\nconstraints=-\naccept=-\nplan=${plan} ${rest}`

  // wt (nhánh feat) có commit feat.go; PLAN.md nằm ngoài repo (như plan trong ~/.claude/plans), làn A = feat.go, làn B = other.go.
  function auditFx() {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    const plan = write(fx.root, 'PLAN.md', '| lane | files | depends_on |\n|---|---|---|\n| A | feat.go | - |\n| B | other.go | - |\n')
    return { fx, plan }
  }
  const stopIn = (fx, transcript, agent_type = 'coder', extra = {}) => ({
    hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a1', agent_type, cwd: fx.wt,
    last_assistant_message: RECEIPT, agent_transcript_path: transcript, ...extra,
  })
  const tx = (fx, brief, name = 'tx.jsonl') => jsonl(fx, name, [userMsg(brief), asst({ type: 'text', text: 'làm' })])
  const go = (fx, transcript, agent_type, extra) => hook(fx, 'subagent-stop', stopIn(fx, transcript, agent_type, extra))

  test('mọi file đổi nằm trong scope của làn ⇒ cho qua', () => {
    const { fx, plan } = auditFx()
    assertPass(go(fx, tx(fx, briefOf(plan))))
  })

  test('commit file ngoài scope ⇒ block, lý do có dòng OUTSIDE + hướng dẫn gỡ hoặc needs_context', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    const reason = assertBlock(go(fx, tx(fx, briefOf(plan))))
    assert.match(reason, /OUTSIDE extra\.js/)
    assert.doesNotMatch(reason, /OUTSIDE feat\.go/)
    assert.match(reason, /gỡ thay đổi ngoài scope, hoặc trả return=needs_context kèm tên file/)
  })

  test('file chưa commit (sửa dở + untracked) ngoài scope cũng bị bắt', () => {
    const { fx, plan } = auditFx()
    write(fx.wt, 'junk.txt', 'rác\n')
    write(fx.wt, 'a.txt', 'đổi\n')
    const reason = assertBlock(go(fx, tx(fx, briefOf(plan))))
    assert.match(reason, /OUTSIDE junk\.txt/)
    assert.match(reason, /OUTSIDE a\.txt/)
  })

  test('receipt needs_context / blocked ⇒ không audit (cho qua dù có file ngoài scope)', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    const t = tx(fx, briefOf(plan))
    assertPass(go(fx, t, 'coder', { last_assistant_message: 'return=needs_context; paths=extra.js; stop' }))
    assertPass(go(fx, t, 'coder', { last_assistant_message: 'return=blocked; blocker=x; stop' }))
    assertBlock(go(fx, t, 'coder', { last_assistant_message: 'return=done_with_concerns; stop' }))
  })

  test('coder-lite cũng bị audit; agent khác (recon, test-runner, debugger) thì không', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    const t = tx(fx, briefOf(plan))
    assertBlock(go(fx, t, 'coder-lite'))
    for (const agent of ['recon', 'test-runner', 'debugger', 'qa-tester']) assertPass(go(fx, t, agent))
  })

  test('stop_hook_active ⇒ cho qua', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    assertPass(go(fx, tx(fx, briefOf(plan)), 'coder', { stop_hook_active: true }))
  })

  test('brief thiếu plan= hoặc lane=, transcript không đọc được hoặc không có ⇒ cho qua', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    assertPass(go(fx, tx(fx, 'outcome=x\nscope=feat.go\naccept=-')))
    assertPass(go(fx, tx(fx, `outcome=x\nplan=${plan}`)))
    assertPass(go(fx, tx(fx, 'outcome=x\nlane=A')))
    assertPass(go(fx, path.join(fx.root, 'khong-co.jsonl')))
    assertPass(go(fx, undefined))
    assertPass(go(fx, write(fx.root, 'rong.jsonl', '')))
  })

  test('brief là tin nhắn user ĐẦU TIÊN (các tin sau không tính); content dạng mảng text block cũng đọc được', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    const later = jsonl(fx, 'later.jsonl', [userMsg('làm đi'), asst({ type: 'text', text: 'ok' }), userMsg(briefOf(plan))])
    assertPass(go(fx, later))
    const blocks = jsonl(fx, 'blocks.jsonl', [userMsg([{ type: 'text', text: briefOf(plan) }]), asst({ type: 'text', text: 'ok' })])
    assertBlock(go(fx, blocks))
  })

  test('plan= có nháy (đường dẫn có dấu cách) và lane đứng riêng dòng', () => {
    const { fx } = auditFx()
    const plan = write(fx.root, 'my plans/PLAN.md', '| lane | files | depends_on |\n|---|---|---|\n| A | feat.go | - |\n')
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    assertBlock(go(fx, tx(fx, `outcome=x\nplan="${plan}"\nlane=A\n`)))
    assertBlock(go(fx, tx(fx, `outcome=x plan='${plan}' lane=A`)))
  })

  test('plan= KHÔNG nháy, đường dẫn có dấu cách, lane= đứng ngay sau ⇒ audit chạy đúng file và chặn file ngoài scope (bộ đọc chung lib/brief.mjs)', () => {
    const { fx } = auditFx()
    // như `plan=D:\AI\Vibe Coding\x\PLAN.md lane=A`: không nháy, có dấu cách, không có file nào khác để lane-check nhặt nhầm
    const plan = write(fx.root, 'Vibe Coding/x/PLAN.md', '| lane | files | depends_on |\n|---|---|---|\n| A | feat.go | - |\n')
    assertPass(go(fx, tx(fx, `outcome=x\nplan=${plan} lane=A`))) // trong scope ⇒ qua (tìm đúng file nên không exit 2)
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    for (const brief of [
      `outcome=x\nplan=${plan} lane=A`,
      `outcome=x\nplan=${plan} lane=A base=main`,
      `outcome=x\nlane=A, plan=${plan}, base=main`,
      `outcome=x\nplan=${plan} (xem thêm ở đó)\nlane=A`, // chữ thường theo sau: thử tiền tố ngắn dần
      `outcome=x\nplan=${plan.replace(/\\/g, '/')}\nlane=A`,
    ]) assert.match(assertBlock(go(fx, tx(fx, brief))), /OUTSIDE extra\.js/, brief)
    if (process.platform === 'win32') { // đường dẫn git bash /c/Users/...
      const gitBash = plan.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
      assert.match(assertBlock(go(fx, tx(fx, `outcome=x\nplan=${gitBash} lane=A`))), /OUTSIDE extra\.js/)
    }
  })

  // Tài liệu (docs/specs/…/PLAN.md) nằm ngoài git [o3e4]: worktree mới tạo không có bản này, bản thật ở thư mục chính.
  describe('PLAN.md không có trong worktree ⇒ tìm cùng đường dẫn tương đối ở thư mục chính', () => {
    const REL = 'docs/specs/x/PLAN.md'
    const TABLE = (files) => `| lane | files | depends_on |\n|---|---|---|\n| A | ${files} | - |\n`

    test('đường dẫn tuyệt đối trong worktree / tương đối theo cwd ⇒ dùng bản ở thư mục chính: trong scope qua, ngoài scope bị bắt', () => {
      const { fx } = auditFx()
      write(fx.main, REL, TABLE('feat.go'))
      assert.equal(fs.existsSync(path.join(fx.wt, REL)), false, 'điều kiện: worktree không có PLAN')
      for (const planRef of [path.join(fx.wt, REL), REL, path.join(fx.wt, REL).replace(/\\/g, '/')]) {
        assertPass(go(fx, tx(fx, briefOf(planRef)), 'coder'))
      }
      commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
      for (const planRef of [path.join(fx.wt, REL), REL]) {
        assert.match(assertBlock(go(fx, tx(fx, briefOf(planRef)))), /OUTSIDE extra\.js/, planRef)
      }
    })

    test('đường dẫn có dấu cách và tiếng Việt vẫn tìm được ở thư mục chính', () => {
      const { fx } = auditFx()
      const rel = 'docs/specs/2026-10-12 trang dự án/PLAN.md'
      write(fx.main, rel, TABLE('feat.go'))
      commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
      assert.match(assertBlock(go(fx, tx(fx, `outcome=x\nplan="${path.join(fx.wt, rel)}"\nlane=A\n`))), /OUTSIDE extra\.js/)
    })

    test('worktree CÓ bản riêng ⇒ dùng bản trong worktree, không nhìn sang thư mục chính', () => {
      const { fx } = auditFx()
      write(fx.main, REL, TABLE('khong-co-gi.go')) // bản chính: feat.go ngoài scope
      write(fx.wt, REL, TABLE('feat.go'))
      assertPass(go(fx, tx(fx, briefOf(path.join(fx.wt, REL)))))
    })

    test('không có ở cả worktree lẫn thư mục chính ⇒ không kiểm được phạm vi ⇒ cho qua + log', () => {
      const { fx } = auditFx()
      commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
      assertPass(go(fx, tx(fx, briefOf(path.join(fx.wt, REL)))))
      assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check audit lane A: không kiểm được phạm vi, cho qua/)
    })

    test('đường dẫn nằm ngoài worktree (không có đường dẫn tương đối) và không tồn tại ⇒ không đoán, cho qua + log', () => {
      const { fx } = auditFx()
      write(fx.main, 'PLAN-ngoai.md', TABLE('feat.go'))
      assertPass(go(fx, tx(fx, briefOf(path.join(fx.root, 'khong-co', 'PLAN.md')))))
      assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check audit lane A/)
    })

    test('chạy ngay ở thư mục chính (không phải worktree) mà PLAN không có ⇒ không tìm đâu khác, cho qua + log', () => {
      const { fx } = auditFx()
      assertPass(go(fx, tx(fx, briefOf(path.join(fx.main, REL))), 'coder', { cwd: fx.main }))
      assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check audit lane A/)
    })
  })

  test('làn khác trong cùng plan: file của làn A là ngoài scope của làn B', () => {
    const { fx, plan } = auditFx()
    const reason = assertBlock(go(fx, tx(fx, briefOf(plan, 'lane=B'))))
    assert.match(reason, /OUTSIDE feat\.go/)
  })

  test('base= được chuyển cho lane-check (base không tồn tại ⇒ lane-check exit 2 ⇒ không kiểm được ⇒ cho qua + log)', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    assertBlock(go(fx, tx(fx, briefOf(plan, 'lane=A base=main'))))
    assertPass(go(fx, tx(fx, briefOf(plan, 'lane=A base=khong-co-nhanh-nay'))))
    assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check audit lane A: không kiểm được phạm vi, cho qua/)
  })

  test('lane-check lỗi (không có plan, lane lạ, bảng hỏng) ⇒ không kiểm được phạm vi ⇒ cho qua, vẫn ghi log mỗi ca', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    for (const [brief, lane] of [
      [briefOf(path.join(fx.root, 'khong-co.md')), 'A'],
      [briefOf(plan, 'lane=Z'), 'Z'],
      [briefOf(write(fx.root, 'hong.md', '# không có bảng\n')), 'A'],
    ]) {
      assertPass(go(fx, tx(fx, brief)))
      assert.match(fs.readFileSync(fx.log, 'utf8'), new RegExp(`lane-check audit lane ${lane}: không kiểm được phạm vi, cho qua`))
    }
  })

  test('báo cáo qua SubagentHandback: receipt trong tool_input.message vẫn quyết định audit', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    const hb = (message) => ({ type: 'tool_use', name: 'SubagentHandback', input: { message } })
    const mk = (name, message) => jsonl(fx, name, [userMsg(briefOf(plan)), asst({ type: 'text', text: 'xong' }, hb(message)), asst({ type: 'text', text: 'Đã giao báo cáo.' })])
    assertBlock(hook(fx, 'subagent-stop', stopIn(fx, mk('done.jsonl', RECEIPT), 'coder', { last_assistant_message: 'Đã giao báo cáo.' })))
    assertPass(hook(fx, 'subagent-stop', stopIn(fx, mk('blocked.jsonl', 'return=blocked; blocker=x; stop'), 'coder', { last_assistant_message: 'Đã giao báo cáo.' })))
  })

  test('thiếu receipt vẫn bị chặn như cũ (không phụ thuộc audit)', () => {
    const { fx, plan } = auditFx()
    assert.match(assertBlock(go(fx, tx(fx, briefOf(plan)), 'coder', { last_assistant_message: 'Xong rồi.' })), /Thiếu receipt/)
  })
})

// ---------- Làn A (flow-v5, finding Codex): refspec matching `:` / `+:` và push.default=matching ----------

describe('bash: push refspec matching (`:`, `+:`, push.default=matching)', () => {
  const sh = (fx, cwd, command) => hook(fx, 'bash', bashIn(cwd, command))
  const GHP = 'ghp_' + 'a'.repeat(36)

  // Remote bare `origin` đã có main (origin/main = main) và feat (origin/feat = feat); wt đang ở feat.
  function remoteFx() {
    const fx = fixture()
    const bare = path.join(fx.root, 'remote.git')
    git(fx.root, 'init', '--bare', '-b', 'main', bare)
    git(fx.main, 'remote', 'add', 'origin', bare)
    git(fx.main, 'push', '-u', 'origin', 'main')
    git(fx.wt, 'push', 'origin', 'feat')
    return fx
  }

  test('đang ở feature, `+:` hoặc `:` kèm cờ ép = ép mọi nhánh trùng tên, trong đó có main ⇒ deny', () => {
    const fx = remoteFx()
    for (const c of [
      'git push origin +:', 'git push --repo origin +:', 'git push --force origin :', 'git push -f origin :', 'git push origin : --force-with-lease',
      'git push --force-with-lease=main:abc origin :', 'echo ok && git push origin +:',
    ]) assert.match(assertDeny(sh(fx, fx.wt, c)), /nhánh chính/, c)
    assertDeny(sh(fx, fx.main, 'git push origin +:')) // từ thư mục chính cũng vậy
  })

  test('`:` không ép ⇒ qua như push thường lên nhánh chính (đã đồng bộ hay main có commit chưa lên remote)', () => {
    const fx = remoteFx()
    assertPass(sh(fx, fx.wt, 'git push origin :')) // main = origin/main
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    for (const c of ['git push origin :', 'git push --repo=origin :']) assertPass(sh(fx, fx.wt, c))
  })

  test('remote chưa có main/master (không có nhánh theo dõi) ⇒ `+:` không chạm nhánh chính ⇒ qua; refspec khác `:` không bị coi là matching', () => {
    const fx = fixture() // không có remote nào
    assertPass(sh(fx, fx.wt, 'git push origin +:'))
    assertPass(sh(fx, fx.wt, 'git push --force origin :'))
    const fx2 = remoteFx()
    assertPass(sh(fx2, fx2.wt, 'git push origin +:feat')) // `:feat` = xoá feat trên remote, không phải matching
    assertPass(sh(fx2, fx2.wt, 'git push --force --dry-run origin :'))
  })

  test('push.default=matching và không refspec ⇒ gửi mọi nhánh trùng tên: cờ ép ⇒ deny, không ép ⇒ qua; cấu hình khác thì như cũ', () => {
    const fx = remoteFx()
    assertPass(sh(fx, fx.wt, 'git push --force origin')) // mặc định: chỉ HEAD (feat)
    git(fx.main, 'config', 'push.default', 'simple')
    assertPass(sh(fx, fx.wt, 'git push --force'))
    git(fx.main, 'config', 'push.default', 'matching')
    for (const c of ['git push --force', 'git push -f origin', 'git push --force-with-lease']) assertDeny(sh(fx, fx.wt, c))
    assertPass(sh(fx, fx.wt, 'git push')) // main đã đồng bộ
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    assertPass(sh(fx, fx.wt, 'git push')) // main có commit chưa lên remote nhưng push thường không còn hỏi
    assertPass(sh(fx, fx.wt, 'git push origin feat')) // có refspec rõ ràng ⇒ không phải matching
    assertPass(sh(fx, fx.wt, 'git push --force origin feat'))
  })

  test('matching cũng được quét secret theo từng nhánh trùng tên', () => {
    const fx = remoteFx()
    commit(fx.wt, 'cfg.js', `const t = "${GHP}"\n`, 'secret trên feat') // origin/feat chưa có commit này
    for (const c of ['git push origin :', 'git push origin +:']) assert.match(assertDeny(sh(fx, fx.main, c)), /cfg\.js:1 — github/, c)
  })
})

// ======================================================================================================
// Làn D (flow v7): host.normalize, secrets.mjs, roles.json, cổng thư viện mới, push theo host, AC-09, AC-24, Stop theo sổ
// ======================================================================================================

const codexIn = (cwd, tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', cwd, turn_id: 't-1', model: 'gpt-6.1-sol', tool_name, tool_input })
const devinIn = (cwd, tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', cwd, prompt_id: 'p-1', tool_name, tool_input })
const patchOf = (...files) => ['*** Begin Patch', ...files.flatMap((f) => [`*** Update File: ${f}`, '@@', '-line1', '+line1x']), '*** End Patch'].join('\n')

// AC-24: lời chặn mở đầu bằng MỘT câu đời thường (bị chặn vì gì + AI sẽ tự làm gì), chi tiết kỹ thuật để sau.
function assertPlainOpening(reason, label = '') {
  const first = reason.split(/\.\s|\n/)[0]
  assert.match(first, /\bAI\b/, `${label} câu đầu phải nói AI sẽ làm gì: ${first}`)
  assert.doesNotMatch(first, /[`<>=\\/]|--|\.mjs|FLOW_OK|EnterWorktree|patch-id|return=/, `${label} câu đầu còn ký hiệu kỹ thuật: ${first}`)
  assert.doesNotMatch(first, /\b(?:git|commit|push|merge|secret|worktree|receipt|scope|lane|hook|diff|patch|stamp|token)\b/i, `${label} câu đầu còn thuật ngữ: ${first}`)
  assert.ok(first.length >= 20 && first.length <= 240, `${label} câu đầu dài ${first.length} ký tự: ${first}`)
}

// Sửa thẳng thư mục chính của repo KHÔNG còn bị chặn [chốt 2026-11-08, sổ chốt 8kxf6ad3: như AgentKit, dùng worktree chỉ là lời dặn trong skill].
// Repo dựng ngoài thư mục tạm (outsideTmp) để các ca này đỏ nếu luật chặn cũ (từng cho qua mọi file trong thư mục tạm) bị đặt lại.
describe('sửa thẳng thư mục chính không bị chặn (luật cũ đã bỏ); các cổng khác vẫn chạy', () => {
  test('hook edit cũ còn trong settings của user: Edit/Write/NotebookEdit/MultiEdit/apply_patch vào thư mục chính ⇒ qua, không in gì', () => {
    const fx = fixture({ outsideTmp: true })
    const target = path.join(fx.main, 'a.txt')
    assertPass(hook(fx, 'edit', { tool_name: 'Edit', cwd: fx.main, tool_input: { file_path: target } }))
    assertPass(hook(fx, 'edit', { tool_name: 'Edit', cwd: fx.main, tool_input: { file_path: target.replace(/\\/g, '/') } }))
    assertPass(hook(fx, 'edit', { tool_name: 'Write', cwd: fx.main, tool_input: { file_path: path.join(fx.main, 'new', 'deep', 'f.ts') } }))
    assertPass(hook(fx, 'edit', { tool_name: 'Write', cwd: fx.main, tool_input: { file_path: 'a.txt' } }))
    assertPass(hook(fx, 'edit', { tool_name: 'NotebookEdit', cwd: fx.main, tool_input: { notebook_path: path.join(fx.main, 'x.ipynb') } }))
    assertPass(hook(fx, 'edit', { tool_name: 'MultiEdit', cwd: fx.main, tool_input: { file_path: target } }))
    assertPass(hook(fx, 'edit', codexIn(fx.main, 'apply_patch', { command: patchOf('a.txt') })))
    assertPass(hook(fx, 'edit', devinIn(fx.main, 'write', { file_path: target })))
    assertPass(hook(fx, 'edit', devinIn(fx.main, 'apply_patch', { command: patchOf(target) })))
  })

  test('lệnh bash có apply_patch vào thư mục chính ⇒ không chặn (heredoc, pipe, bash -c, cd sang thư mục chính, gọi bằng biến)', () => {
    const fx = fixture({ outsideTmp: true })
    const main = fx.main.replace(/\\/g, '/')
    const body = (f) => `\n${patchOf(f)}\nEOF`
    for (const command of [
      `apply_patch <<'EOF'${body('a.txt')}`,
      `cat <<'EOF' | apply_patch\n${patchOf('a.txt')}\nEOF`,
      `cd ${main} && apply_patch <<'EOF'${body('a.txt')}`,
      `bash -c "apply_patch <<'EOF'${body('a.txt')}"`,
      `sudo -n apply_patch <<'EOF'${body(`${main}/a.txt`)}`,
      `p=apply_patch; $p <<'EOF'${body(`${main}/a.txt`)}`,
    ]) {
      assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command })))
      assertPass(hook(fx, 'bash', devinIn(fx.main, 'exec', { command })))
      assertPass(hook(fx, 'bash', bashIn(fx.wt, command)))
    }
  })

  test('cổng khác vẫn chạy cạnh apply_patch: xoá thư mục, git reset --hard, push ép nhánh chính vẫn bị chặn; có FLOW_OK=1 thì qua', () => {
    const fx = fixture({ outsideTmp: true })
    const patch = `apply_patch <<'EOF'\n${patchOf('a.txt')}\nEOF`
    assertExit(assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: `rm -rf build && ${patch}` }))))
    assertExit(assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git reset --hard'))))
    assertExit(assertDeny(hook(fx, 'bash', bashIn(fx.main, `${patch}\ngit push --force origin main`))))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'FLOW_OK=1 rm -rf build')))
  })
})
describe('v7 secret: mẫu lấy từ lib/secrets.mjs', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const sh = (fx, cwd, command) => hook(fx, 'bash', bashIn(cwd, command))
  const stage = (dir, rel, content) => { write(dir, rel, content); git(dir, 'add', '--', rel) }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwtOf = (role) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role })}.${'s'.repeat(24)}`

  test('flow-gate không còn bản sao mẫu secret / danh sách vai cứng; import host, secrets, models', () => {
    assert.doesNotMatch(src, /SECRET_PATTERNS\s*=|KNOWN_FALSE_POSITIVES\s*=|AKIA\[|function scanLine|function isSensitiveFile|function scanPatch/)
    assert.doesNotMatch(src, /RECEIPT_AGENTS|AUDIT_AGENTS/)
    assert.match(src, /from '\.\/lib\/secrets\.mjs'/)
    assert.match(src, /from '\.\/lib\/host\.mjs'/)
    assert.match(src, /lib\/models\.mjs/)
  })

  test('mẫu mới của secrets.mjs có hiệu lực ở cổng commit: Stripe live, JWT service_role; JWT anon thì qua', () => {
    const fx = fixture()
    stage(fx.main, 'pay.js', `const k = "${'sk_live_' + 'aB3dE5gH7jK9mN1pQ3sT5vX7'}"\n`)
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /pay\.js:1 — stripe/)
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'sb.js', `const k = "${jwtOf('service_role')}"\n`)
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /sb\.js:1 — jwt-service-role/)
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'anon.js', `const k = "${jwtOf('anon')}"\n`)
    assertPass(sh(fx, fx.main, 'git commit -m x'))
  })

  test('hành vi cũ giữ nguyên: dòng allow, file nhạy cảm', () => {
    const fx = fixture()
    const GHP = 'ghp_' + 'a'.repeat(36)
    stage(fx.main, 'cfg.js', `x\nconst t = "${GHP}" // flow-gate: allow-secret\n`)
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    git(fx.main, 'reset', '-q')
    stage(fx.main, '.env.production', 'A=1\n')
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /\.env\.production — file nhạy cảm/)
  })
})

describe('v7 vai: lấy từ kit/roles.json (coder-mini đi qua đủ cổng như coder)', () => {
  const RECEIPT = 'return=done; paths=feat.go; checks=ok; blocker=; stop'
  const jsonl = (fx, name, entries) => write(fx.root, name, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const userMsg = (content) => ({ type: 'user', message: { role: 'user', content } })
  const asst = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } })
  function auditFx() {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    const plan = write(fx.root, 'PLAN.md', '| lane | files | depends_on |\n|---|---|---|\n| A | feat.go | - |\n')
    const brief = `outcome=x\nscope=feat.go\nplan=${plan} lane=A`
    const transcript = jsonl(fx, 'tx.jsonl', [userMsg(brief), asst({ type: 'text', text: 'làm' })])
    return { fx, transcript }
  }
  const subIn = (fx, agent_type, extra = {}) => ({
    hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a1', agent_type, cwd: fx.wt, last_assistant_message: RECEIPT, ...extra,
  })

  test('coder-mini thiếu receipt bị chặn; vai không đòi receipt (plan-reviewer, security-reviewer) thì qua', () => {
    const fx = fixture()
    assert.match(assertBlock(hook(fx, 'subagent-stop', subIn(fx, 'coder-mini', { last_assistant_message: 'Xong rồi.' }))), /Thiếu receipt/)
    assertPass(hook(fx, 'subagent-stop', subIn(fx, 'coder-mini')))
    for (const role of ['plan-reviewer', 'security-reviewer', 'sensitive-reviewer', 'Explore']) {
      assertPass(hook(fx, 'subagent-stop', subIn(fx, role, { last_assistant_message: 'không có receipt' })))
    }
  })

  test('coder-mini nộp bài ⇒ bị audit phạm vi làn như coder (file ngoài scope ⇒ block)', () => {
    const { fx, transcript } = auditFx()
    assertPass(hook(fx, 'subagent-stop', subIn(fx, 'coder-mini', { agent_transcript_path: transcript })))
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    for (const agent of ['coder', 'coder-lite', 'coder-mini']) {
      assert.match(assertBlock(hook(fx, 'subagent-stop', subIn(fx, agent, { agent_transcript_path: transcript }))), /OUTSIDE extra\.js/, agent)
    }
    assertPass(hook(fx, 'subagent-stop', subIn(fx, 'debugger', { agent_transcript_path: transcript })))
  })
})

describe('v7 push nhánh chính theo host: push thường qua ở mọi host (không hộp hỏi, không tiền tố tự duyệt)', () => {
  const GHP = 'ghp_' + 'a'.repeat(36)
  function remoteFx() {
    const fx = fixture()
    const bare = path.join(fx.root, 'remote.git')
    git(fx.root, 'init', '--bare', '-b', 'main', bare)
    git(fx.main, 'remote', 'add', 'origin', bare)
    git(fx.main, 'push', '-u', 'origin', 'main')
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    commit(fx.main, 'x2.txt', 'x\n', 'thêm x2')
    return fx
  }
  const claudeSh = (fx, cwd, command) => hook(fx, 'bash', bashIn(cwd, command))
  const codexSh = (fx, cwd, command) => hook(fx, 'bash', codexIn(cwd, 'Bash', { command }))
  const devinSh = (fx, cwd, command) => hook(fx, 'bash', devinIn(cwd, 'exec', { command }))

  test('push thường lên nhánh chính ở claude/codex/devin ⇒ qua, remote lạ, đã đồng bộ, nhánh khác; gán biến ngay trước git push cũng qua', () => {
    const fx = remoteFx()
    for (const sh of [claudeSh, codexSh, devinSh]) {
      for (const c of ['git push', 'git push origin main', 'git push origin HEAD', 'git push --all origin', 'git push --repo="o|sh" main',
        'FLOW_OK=push-main true && git push origin main', 'echo FLOW_OK=push-main; git push origin main',
        'FLOW_OK=push-main git push origin main', 'A=1 FLOW_OK=push-main git -C . push origin main', 'echo ok && FLOW_OK=push-main git push origin main',
        'A=1 git push origin main']) {
        assertPass(sh(fx, fx.main, c))
      }
    }
    git(fx.main, 'config', 'branch.main.remote', 'origin; calc')
    for (const sh of [claudeSh, codexSh, devinSh]) assertPass(sh(fx, fx.main, 'git push')) // remote từ cấu hình có ký tự lạ: vẫn qua
    git(fx.main, 'config', '--unset', 'branch.main.remote')
    git(fx.main, 'push', 'origin', 'main')
    assertPass(codexSh(fx, fx.main, 'git push')) // đã đồng bộ
    commit(fx.wt, 'f.go', 'package f\n', 'feat commit')
    assertPass(codexSh(fx, fx.wt, 'git push origin feat'))
  })

  test('push ép (kể cả --mirror / --prune), xoá nhánh chính, secret vẫn deny ở mọi host (lời chặn có lối ra); chạy lại với tiền tố FLOW_OK= thì qua', () => {
    const fx = remoteFx()
    for (const sh of [claudeSh, codexSh, devinSh]) {
      for (const c of ['git push --force origin main', 'git push --mirror origin', 'git push --prune origin main', 'git push origin --delete main']) {
        assertExit(assertDeny(sh(fx, fx.main, c)))
        assertPass(sh(fx, fx.main, `FLOW_OK=1 ${c}`))
        assertPass(sh(fx, fx.main, `FLOW_OK=push-main ${c}`))
      }
    }
    commit(fx.main, 'cfg.js', `const t = "${GHP}"\n`, 'secret')
    for (const sh of [claudeSh, codexSh, devinSh]) {
      const reason = assertDeny(sh(fx, fx.main, 'git push origin main'))
      assert.match(reason, /cfg\.js:1 — github/)
      assertExit(reason)
      assertPass(sh(fx, fx.main, 'FLOW_OK=1 git push origin main'))
    }
  })
})

describe('v7 cổng thư viện mới khi commit (deps.mjs newPackages + vetAll)', () => {
  const sh = (fx, cwd, command, env) => hook(fx, 'bash', bashIn(cwd, command), env)
  const pkg = (deps) => JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps }, null, 2) + '\n'
  const stage = (dir, rel, content) => { write(dir, rel, content); git(dir, 'add', '--', rel) }
  const BAD = { react: '^19.0.0', 'Bad Name!': '1.0.0' } // tên không hợp lệ: vet ra 'bad' không cần mạng
  const GIT_DEP = { react: '^19.0.0', 'zq-internal-lib': 'git+https://example.invalid/zq.git' } // nguồn git: vet ra 'bad' không cần mạng

  function depsFx(initial = { react: '^19.0.0' }) {
    const fx = fixture()
    commit(fx.main, 'package.json', pkg(initial), 'package.json')
    return fx
  }

  test('commit thêm package có vấn đề ⇒ chỉ nhắc (additionalContext, không chặn): nêu tên + lý do, dặn báo user một dòng', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', pkg(BAD))
    const ctx = assertNudge(sh(fx, fx.main, 'git commit -m "thêm thư viện"'))
    assert.match(ctx, /Bad Name!/)
    assert.match(ctx, /không phải tên package hợp lệ/)
    assert.match(ctx, /Lệnh commit vẫn chạy/)
    assert.match(ctx, /báo user MỘT dòng/)
  })

  test('không có package mới (đổi phiên bản, file khác) ⇒ qua', () => {
    const fx = depsFx({ react: '^19.0.0', zod: '^3.0.0' })
    stage(fx.main, 'package.json', pkg({ react: '^19.1.0' }))
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'other.txt', 'x\n')
    assertPass(sh(fx, fx.main, 'git commit -m x'))
  })

  test('package nguồn git/URL chưa được duyệt ⇒ chỉ nhắc: nêu tên + "nguồn ngoài kho chính thức, chưa kiểm chứng" + cách duyệt', () => {
    const fx = depsFx()
    for (const spec of ['git+https://example.invalid/zq.git', 'https://example.invalid/zq.tgz', 'o/r']) {
      stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-internal-lib': spec }))
      const ctx = assertNudge(sh(fx, fx.main, 'git commit -m x'))
      assert.match(ctx, /zq-internal-lib — nguồn ngoài kho chính thức, chưa kiểm chứng/, spec)
      assert.match(ctx, /trustedDepSources/, spec)
    }
  })

  // Review lượt 2 (MAJOR): allowlist phải đọc từ bản SẮP COMMIT (index / index tạm), mỗi mục ghim "tên@nguồn" — không đọc đĩa, không chỉ tên.
  const SRC = 'git+https://example.invalid/zq.git'
  const trust = (...entries) => JSON.stringify({ trustedDepSources: entries })

  test('"tên@nguồn" có trong .claude/flow.json ĐÃ STAGE ⇒ nguồn git qua im lặng; tên khác trong cùng commit vẫn bị nhắc; flow.json hỏng / sai kiểu ⇒ không tin ai', () => {
    const fx = depsFx()
    stage(fx.main, '.claude/flow.json', trust(`zq-internal-lib@${SRC}`))
    stage(fx.main, 'package.json', pkg(GIT_DEP))
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    stage(fx.main, 'package.json', pkg({ ...GIT_DEP, 'zq-other-lib': 'github:o/other' }))
    assert.match(assertNudge(sh(fx, fx.main, 'git commit -m x')), /zq-other-lib — nguồn ngoài/)
    stage(fx.main, '.claude/flow.json', '{ hỏng')
    assert.match(assertNudge(sh(fx, fx.main, 'git commit -m x')), /zq-internal-lib — nguồn ngoài/)
    stage(fx.main, '.claude/flow.json', JSON.stringify({ trustedDepSources: `zq-internal-lib@${SRC}` }))
    assertNudge(sh(fx, fx.main, 'git commit -m x'))
  })

  test('flow.json chỉ nằm trên đĩa (chưa git add) KHÔNG có hiệu lực: AI tự ghi allowlist rồi commit package.json vẫn bị nhắc; lời nhắc chỉ cách ghi đúng "tên@nguồn" + git add', () => {
    const fx = depsFx()
    write(fx.main, '.claude/flow.json', trust(`zq-internal-lib@${SRC}`)) // file mới, chưa stage
    stage(fx.main, 'package.json', pkg(GIT_DEP))
    const ctx = assertNudge(sh(fx, fx.main, 'git commit -m x'))
    assert.match(ctx, /zq-internal-lib — nguồn ngoài/)
    assert.match(ctx, /tên@nguồn/)
    assert.match(ctx, /zq-internal-lib@git\+https:\/\/example\.invalid\/zq\.git/, 'ví dụ đúng mục cần ghi cho thư viện đang bị nhắc')
    assert.match(ctx, /git add/)
  })

  test('mục chỉ có tên (cách cũ) hoặc cùng tên khác nguồn ⇒ vẫn bị nhắc; nguồn trong package.json phải y hệt mục đã ghim', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', pkg(GIT_DEP))
    for (const entry of ['zq-internal-lib', `zq-internal-lib@git+https://other.invalid/zq.git`, `zq-internal-lib@${SRC}#abc`, `other-lib@${SRC}`, SRC]) {
      stage(fx.main, '.claude/flow.json', trust(entry))
      assert.match(assertNudge(sh(fx, fx.main, 'git commit -m x')), /zq-internal-lib — nguồn ngoài/, entry)
    }
    const sha = 'a'.repeat(40)
    stage(fx.main, '.claude/flow.json', trust(`zq-internal-lib@${SRC}#${sha}`))
    stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-internal-lib': `${SRC}#${sha}` }))
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-internal-lib': `${SRC}#${'b'.repeat(40)}` })) // đổi sha ⇒ nguồn khác ⇒ phải duyệt lại
    assertNudge(sh(fx, fx.main, 'git commit -m x'))
  })

  test('commit -a / commit <path>: flow.json tính theo bản SẼ nằm trong commit (index tạm), không phải đĩa; git add trong cùng lệnh thì flow.json phải stage từ trước', () => {
    const fx = depsFx()
    commit(fx.main, '.claude/flow.json', JSON.stringify({ tests: 'none' }), 'flow.json')
    write(fx.main, '.claude/flow.json', JSON.stringify({ tests: 'none', trustedDepSources: [`zq-internal-lib@${SRC}`] })) // sửa chưa stage
    stage(fx.main, 'package.json', pkg(GIT_DEP))
    assert.match(assertNudge(sh(fx, fx.main, 'git commit -m x')), /zq-internal-lib — nguồn ngoài/, 'commit thường: flow.json chưa stage')
    assertNudge(sh(fx, fx.main, 'git commit -m x package.json'))
    assertPass(sh(fx, fx.main, 'git commit -am x'))
    assertPass(sh(fx, fx.main, 'git commit -m x package.json .claude/flow.json'))
    assert.equal(git(fx.main, 'diff', '--cached', '--name-only').trim(), 'package.json', 'cổng không được đụng index thật')
    // `git add …` đứng trước: không đoán được nó add gì ⇒ không tin bản flow.json chưa stage (chọn thừa chặt còn hơn để AI tự duyệt)
    assertNudge(sh(fx, fx.main, 'git add -A && git commit -m x'))
    git(fx.main, 'add', '.claude/flow.json')
    assertPass(sh(fx, fx.main, 'git add package.json && git commit -m x'))
    // flow.json mới (chưa theo dõi, chưa stage): git add -A cùng lệnh cũng không đủ; stage trước thì qua
    const fx2 = depsFx()
    write(fx2.main, '.claude/flow.json', trust(`zq-internal-lib@${SRC}`))
    write(fx2.main, 'package.json', pkg(GIT_DEP))
    assertNudge(sh(fx2, fx2.main, 'git add -A && git commit -m x'))
    git(fx2.main, 'add', '.claude/flow.json')
    assertPass(sh(fx2, fx2.main, 'git add package.json && git commit -m x'))
  })

  // unknown = mạng lỗi/quá giờ: KHÔNG chặn nhưng cũng không im lặng — trả additionalContext liệt kê gói chưa kiểm được và dặn AI báo user một dòng.
  const contextOf = (r) => {
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout).hookSpecificOutput
    assert.equal(out.permissionDecision, undefined, 'chỉ nhắc, không có quyết định cho/chặn')
    assert.equal(out.hookEventName, 'PreToolUse')
    return out.additionalContext
  }

  test('hết giờ kiểm (mạng chậm) ⇒ unknown ⇒ không chặn nhưng báo AI (additionalContext) + log, không treo hook', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-unique-pkg-9': '1.0.0' }))
    const t = Date.now()
    const ctx = contextOf(sh(fx, fx.main, 'git commit -m x', { FLOW_GATE_DEPS_MS: '1' }))
    assert.ok(Date.now() - t < 15000)
    assert.match(ctx, /chưa kiểm được/i)
    assert.match(ctx, /npm zq-unique-pkg-9/)
    assert.match(ctx, /báo user/i)
    assert.match(fs.readFileSync(fx.log, 'utf8'), /deps.*zq-unique-pkg-9/)
  })

  test('unknown không nuốt các đoạn lệnh sau: `git commit && git push --force origin main` vẫn bị chặn push ép', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-unique-pkg-9': '1.0.0' }))
    assertDeny(sh(fx, fx.main, 'git commit -m x && git push --force origin main', { FLOW_GATE_DEPS_MS: '1' }))
  })

  // Review lượt 2 (MAJOR): push nhánh chính cùng lệnh với commit thư viện chưa kiểm được — lời nhắc unknown không được rơi mất.
  test('commit thư viện chưa kiểm được + push nhánh chính trong MỘT lệnh ⇒ chỉ còn lời nhắc additionalContext về thư viện chưa kiểm (không hỏi, không chặn) ở cả Claude và Codex', () => {
    const fx = depsFx()
    const bare = path.join(fx.root, 'remote.git')
    git(fx.root, 'init', '--bare', '-b', 'main', bare)
    git(fx.main, 'remote', 'add', 'origin', bare)
    git(fx.main, 'push', '-u', 'origin', 'main')
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-unique-pkg-9': '1.0.0' }))
    const r = sh(fx, fx.main, 'git commit -m x && git push origin main', { FLOW_GATE_DEPS_MS: '1' })
    const ctx = contextOf(r)
    assert.match(ctx, /chưa kiểm được/i)
    assert.match(ctx, /npm zq-unique-pkg-9/)
    assert.match(ctx, /báo user/i)
    const codex = hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: 'git commit -m x && git push origin main' }), { FLOW_GATE_DEPS_MS: '1' })
    assert.match(contextOf(codex), /npm zq-unique-pkg-9/)
    // không có thư viện chưa kiểm ⇒ qua im lặng, không thêm gì
    git(fx.main, 'reset', '-q')
    assertPass(sh(fx, fx.main, 'git commit -m x && git push origin main'))
  })

  test('package.json mới hỏng ⇒ newPackages ném ⇒ chỉ nhắc kèm lý do (không chặn), có log', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', '{ không phải json')
    const ctx = assertNudge(sh(fx, fx.main, 'git commit -m x'))
    assert.match(ctx, /package\.json/)
    assert.match(ctx, /Lệnh commit vẫn chạy/)
    assert.match(fs.readFileSync(fx.log, 'utf8'), /newPackages:/)
  })

  test('go.mod: module mới có vấn đề ⇒ chỉ nhắc', () => {
    const fx = fixture()
    commit(fx.main, 'go.mod', 'module example.com/x\n\ngo 1.22\n', 'go.mod')
    stage(fx.main, 'go.mod', 'module example.com/x\n\ngo 1.22\n\nrequire example.com/Bad%20Name v1.0.0\n')
    const ctx = assertNudge(sh(fx, fx.main, 'git commit -m x'))
    assert.match(ctx, /Bad%20Name/)
  })

  test('commit -a, commit <path>, git add … && git commit: tính cả package.json chưa stage (nội dung thật của commit)', () => {
    const fx = depsFx()
    write(fx.main, 'package.json', pkg(BAD)) // sửa chưa stage
    write(fx.main, 'other.txt', 'x\n')
    assertPass(sh(fx, fx.main, 'git commit -m x')) // không có gì staged
    assert.match(assertNudge(sh(fx, fx.main, 'git commit -am x')), /Bad Name!/)
    assert.match(assertNudge(sh(fx, fx.main, 'git commit -a -m x')), /Bad Name!/)
    assert.match(assertNudge(sh(fx, fx.main, 'git commit -m x package.json')), /Bad Name!/)
    assert.match(assertNudge(sh(fx, fx.main, 'git add -A && git commit -m x')), /Bad Name!/)
    assert.match(assertNudge(sh(fx, fx.main, 'git add package.json; git commit -m x')), /Bad Name!/)
    assertPass(sh(fx, fx.main, 'git commit -m x other.txt')) // commit path khác: package.json không nằm trong commit
    assert.equal(git(fx.main, 'diff', '--cached', '--name-only').trim(), '', 'cổng không được đụng index thật')
  })

  test('--dry-run không kiểm; secret bị chặn trước (lý do secret, không phải deps)', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', pkg(BAD))
    assertPass(sh(fx, fx.main, 'git commit --dry-run -m x'))
    stage(fx.main, 'cfg.js', `const t = "${'ghp_' + 'a'.repeat(36)}"\n`)
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /cfg\.js:1 — github/)
  })

  test('repo chưa có commit: package.json đầu tiên cũng được kiểm', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-gate-')))
    roots.push(root)
    git(root, 'init', '-b', 'main')
    stage(root, 'package.json', pkg(BAD))
    const fx = { log: path.join(root, 'flow-gate.log'), root }
    assert.match(assertNudge(hook(fx, 'bash', bashIn(root, 'git commit -m first'))), /Bad Name!/)
  })
})

describe('v7 AC-24: lời chặn mở đầu bằng một câu đời thường', () => {
  const sh = (fx, cwd, command) => hook(fx, 'bash', bashIn(cwd, command))
  const stage = (dir, rel, content) => { write(dir, rel, content); git(dir, 'add', '--', rel) }

  test('push ép / xoá nhánh chính / lệnh phá huỷ / secret', () => {
    const fx = fixture()
    for (const c of ['git push --force origin main', 'git push origin --delete main', 'git branch -D main', 'git branch -M feat main', 'git reset --hard', 'git clean -fd', 'git restore .', 'git checkout -- .']) {
      assertPlainOpening(assertDeny(sh(fx, fx.main, c)), c)
    }
    stage(fx.main, 'cfg.js', `const t = "${'ghp_' + 'a'.repeat(36)}"\n`)
    const secret = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assertPlainOpening(secret, 'secret commit')
    assert.match(secret, /Phát hiện secret trong phần sắp commit/)
    assert.match(secret, /cfg\.js:1 — github/)
    assert.match(secret, /flow-gate: allow-secret/)
    git(fx.main, 'commit', '-q', '-m', 'secret')
    assertPlainOpening(assertDeny(sh(fx, fx.main, 'git push origin main')), 'secret push')
  })

  test('Stop nhắc thiếu dấu / thiếu receipt / audit phạm vi làn', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    assertPlainOpening(assertBlock(hook(fx, 'stop', { hook_event_name: 'Stop', cwd: fx.wt, stop_hook_active: false })), 'stop')
    const sub = (extra) => ({ hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a1', agent_type: 'coder', cwd: fx.wt, ...extra })
    assertPlainOpening(assertBlock(hook(fx, 'subagent-stop', sub({ last_assistant_message: 'Xong rồi.' }))), 'receipt')
    const plan = write(fx.root, 'PLAN.md', '| lane | files | depends_on |\n|---|---|---|\n| A | feat.go | - |\n')
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    const mk = (name, brief) => write(fx.root, name, JSON.stringify({ type: 'user', message: { role: 'user', content: brief } }) + '\n')
    const receipt = 'return=done; paths=feat.go; checks=ok; blocker=; stop'
    assertPlainOpening(assertBlock(hook(fx, 'subagent-stop', sub({ last_assistant_message: receipt, agent_transcript_path: mk('t1.jsonl', `plan=${plan} lane=A`) }))), 'audit')
  })
})

describe('v7 AC-09: lane-check không chạy được ⇒ không kiểm được phạm vi ⇒ cho qua + log (không còn block)', () => {
  const jsonl = (fx, name, entries) => write(fx.root, name, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const sub = (fx, transcript, extra = {}) => ({
    hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a1', agent_type: 'coder', cwd: fx.wt,
    last_assistant_message: 'return=done; paths=feat.go; checks=ok; blocker=; stop', agent_transcript_path: transcript, ...extra,
  })

  test('lane-check không chạy được (plan không tồn tại) ⇒ cho qua, log nêu lý do thật; stop_hook_active ⇒ vẫn cho qua', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    const t = jsonl(fx, 'tx.jsonl', [{ type: 'user', message: { role: 'user', content: `outcome=x\nplan=${path.join(fx.root, 'khong-co.md')} lane=A` } }])
    assertPass(hook(fx, 'subagent-stop', sub(fx, t)))
    assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check audit lane A: không kiểm được phạm vi, cho qua — exit 2/)
    assertPass(hook(fx, 'subagent-stop', sub(fx, t, { stop_hook_active: true })))
  })

  test('coder trả needs_context/blocked thì không audit nên không bị chặn; brief không có plan=/lane= vẫn qua', () => {
    const fx = fixture()
    const t = jsonl(fx, 'tx.jsonl', [{ type: 'user', message: { role: 'user', content: `plan=${path.join(fx.root, 'khong-co.md')} lane=A` } }])
    assertPass(hook(fx, 'subagent-stop', sub(fx, t, { last_assistant_message: 'return=needs_context; blocker=x; stop' })))
    const none = jsonl(fx, 'none.jsonl', [{ type: 'user', message: { role: 'user', content: 'outcome=x' } }])
    assertPass(hook(fx, 'subagent-stop', sub(fx, none)))
  })
})

describe('v7 Stop: nhánh có sổ tiến độ chưa xong mà mục Làn: còn "- [ ]" ⇒ không nhắc thiếu dấu', () => {
  const stopIn = (cwd) => ({ hook_event_name: 'Stop', cwd, stop_hook_active: false, last_assistant_message: 'xong' })
  const SHEET = 'docs/specs/x/progress.md'
  const sheet = ({ state = 'đang làm', branch = 'feat, C:/wt', body = 'Làn:\n- [x] A đã gộp\n- [ ] B đang làm\nGhi chú: đang thi công\n' } = {}) =>
    `# Tiến độ: x\nTrạng thái: ${state}\nPha: 4 — thi công\nNhánh / worktree: ${branch}\n${body}`
  function sheetFx(opts) {
    const fx = fixture()
    commit(fx.wt, SHEET, sheet(opts), 'sổ')
    commit(fx.wt, 'feat.go', 'package x\n', 'feat') // có code ⇒ cổng Stop đòi review/qa/test
    return fx
  }

  test('còn làn "- [ ]" ⇒ không nhắc, không ghi marker nudged; hết "- [ ]" ⇒ nhắc như thường', () => {
    const fx = sheetFx()
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
    assert.ok(!fs.existsSync(fx.gates) || !fs.readdirSync(fx.gates).some((n) => n.startsWith('nudged-')))
    commit(fx.wt, SHEET, sheet({ body: 'Làn:\n- [x] A đã gộp\n- [x] B đã gộp\nGhi chú: xong hết làn\n' }), 'sổ: xong làn')
    assert.match(assertBlock(hook(fx, 'stop', stopIn(fx.wt))), /feat đã commit xong nhưng thiếu: review, qa/)
  })

  test('sổ đã "xong", sổ của nhánh khác, không có mục Làn:, "- [ ]" nằm ngoài mục Làn: ⇒ vẫn nhắc', () => {
    for (const [name, opts] of [
      ['xong', { state: 'xong' }],
      ['nhánh khác', { branch: 'khac, C:/wt' }],
      ['không có Làn', { body: 'Bước tiếp theo: - [ ] làm gì đó\n' }],
      ['ngoài Làn', { body: 'Làn:\n- [x] A đã gộp\nCòn lại:\n- [ ] việc khác\n' }],
      ['Làn rỗng', { body: 'Làn:\n\nGhi chú: chưa có làn\n- [ ] ngoài mục\n' }],
    ]) {
      const fx = sheetFx(opts)
      assert.match(assertBlock(hook(fx, 'stop', stopIn(fx.wt))), /thiếu: review, qa/, name)
    }
  })

  test('mục Làn: có dòng phụ thụt lề / dòng trống giữa các làn vẫn được đọc; "* [ ]" cũng tính', () => {
    const fx = sheetFx({ body: 'Làn:\n- [x] A đã gộp\n\n  ghi chú thụt lề\n* [ ] B đang làm\n' })
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
  })

  test('tiêu đề "Làn (ghi chú):" vẫn là mục Làn — còn "- [ ]" thì không nhắc', () => {
    const fx = sheetFx({ body: 'Làn (PLAN.md §Làn; soát plan 5 mục đã sửa):\n- [x] A đã gộp\n- [ ] B đang làm\n' })
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
  })

  test('sổ nằm ngoài git ở THƯ MỤC CHÍNH (kit để docs ngoài git), worktree không có ⇒ vẫn đọc được: còn "- [ ]" thì không nhắc', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    fs.mkdirSync(path.join(fx.main, 'docs', 'specs', 'x'), { recursive: true })
    fs.writeFileSync(path.join(fx.main, SHEET), sheet()) // không commit: chỉ nằm trên đĩa ở thư mục chính
    assertPass(hook(fx, 'stop', stopIn(fx.wt)))
    fs.writeFileSync(path.join(fx.main, SHEET), sheet({ body: 'Làn:\n- [x] A đã gộp\n' }))
    assert.match(assertBlock(hook(fx, 'stop', stopIn(fx.wt))), /thiếu: review, qa/)
  })

  test('không có sổ nào ⇒ nhắc như cũ (không ảnh hưởng nhánh bình thường)', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
  })
})

describe('AC-42: quét thư mục bằng grep -r / find ⇒ nhắc dùng Grep/rg, không chặn', () => {
  const ctxOf = (r) => {
    assert.equal(r.status, 0, r.stderr)
    if (!r.stdout.trim()) return null
    const out = JSON.parse(r.stdout).hookSpecificOutput
    assert.equal(out.permissionDecision, undefined, 'chỉ nhắc, không có quyết định cho/chặn')
    return out.additionalContext
  }
  for (const command of ['grep -rn "TODO" src', 'grep -R foo .', 'grep --recursive foo .', 'cd x && grep -ril bar .',
    'find . -name "*.ts"', 'find src -type f -iname "*.md"', 'find . -path "*/node_modules" -prune']) {
    test(`nhắc: ${command}`, () => {
      const fx = fixture()
      const ctx = ctxOf(hook(fx, 'bash', bashIn(fx.main, command)))
      assert.ok(ctx && ctx.includes('rg') && ctx.includes('-uu'), ctx)
    })
  }
  for (const command of ['grep foo file.txt', 'git log | grep fix', 'rg -n foo', 'ls -la', 'find . -maxdepth 1 -type d', 'echo grep -r']) {
    test(`không nhắc: ${command}`, () => {
      const fx = fixture()
      assert.equal(ctxOf(hook(fx, 'bash', bashIn(fx.main, command))), null)
    })
  }
  test('lệnh bị chặn vẫn bị chặn (nhắc không che quyết định deny)', () => {
    const fx = fixture()
    write(fx.main, 'k.js', 'const k = "' + 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc"\n')
    git(fx.main, 'add', 'k.js')
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'grep -r foo . ; git commit -m x')))
  })
})

// Ghi nội dung file qua lệnh shell (heredoc/echo/printf, sed, node/python -e) không còn bị chặn [chốt 2026-11-07]: đã bỏ hộp hỏi nên không còn lý do chặn.
describe('ghi nội dung file qua lệnh shell ⇒ không chặn, kể cả nội dung có chữ giống lệnh nguy hiểm', () => {
  const HD = '<' + '<'
  for (const command of [
    `cat > notes.md ${HD}'EOF'\ngit push origin main --force\nEOF`,
    'echo "chạy git clean -fd" >> MEMORY.md',
    "sed -i 's|^dòng$|dòng\\ngit branch -D x|' agents/coder.md",
    'node -e "require(\'fs\').writeFileSync(\'a.txt\', \'truncate table x\')"',
    'echo "rmdir /q /s x" > a.txt',
  ]) {
    test(`không chặn: ${command.split('\n')[0]}`, () => {
      const fx = fixture()
      assertPass(hook(fx, 'bash', bashIn(fx.root, command)))
    })
  }
})

describe('xoá cả thư mục qua lệnh shell ⇒ chặn, dặn dùng don.mjs hoặc tạo thư mục mới; thật sự cần xoá thì có lối ra FLOW_OK=1', () => {
  const mustDeny = [
    'rm -rf /tmp/x', 'rm -r build', 'rm -fr out', 'rm -Rf a b', 'rm --recursive dist', 'cd x && rm -rf node_modules',
    'sudo rm -rf /var/x', '/bin/rm -rf x', 'FOO=1 rm -rf x', 'git status; rm -r -f tmp', 'bash -c "rm -rf x"',
    'powershell -c "Remove-Item -Recurse -Force x"', 'cmd /c rmdir /s /q x',
  ]
  const mustPass = ['rm a.txt', 'rm -f a.txt b.txt', 'rmdir empty', 'git rm -r --cached x', 'echo "rm -rf x"', 'git commit -m "bỏ rm -rf"', 'mkdir -p new-dir']
  for (const command of mustDeny) {
    test(`chặn: ${command}`, () => {
      const fx = fixture()
      const reason = assertDeny(hook(fx, 'bash', bashIn(fx.root, command)))
      assert.match(reason, /thư mục mới/)
      assert.match(reason, /don\.mjs/)
      assertPlainOpening(reason, command)
      assertExit(reason)
    })
  }
  for (const command of mustPass) {
    test(`không chặn: ${command}`, () => {
      const fx = fixture()
      const r = hook(fx, 'bash', bashIn(fx.root, command))
      assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined, r.stdout)
    })
  }
})

describe('tool PowerShell (Claude Code trên Windows) qua cùng cổng như Bash', () => {
  test('xoá thư mục, push ép main ⇒ deny (có lối ra); lệnh thường qua; $env:FLOW_OK=1; cho qua', () => {
    const fx = fixture()
    const ps = (command) => hook(fx, 'bash', { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', cwd: fx.main, tool_input: { command }, transcript_path: path.join(fx.root, 't.jsonl') })
    const dir = assertDeny(ps('cmd /c rd /s /q "\\\\?\\D:\\x\\.claude\\worktrees\\old"'))
    assert.match(dir, /Thùng rác/)
    assertExit(dir)
    assertExit(assertDeny(ps('Remove-Item -Recurse -Force .\\build')))
    assertExit(assertDeny(ps('git push --force origin main')))
    assertPass(ps('git status'))
    assertPass(ps('$env:FLOW_OK=1; Remove-Item -Recurse -Force .\\build'))
  })
})

// ---------- đợt 3 (làn E): dấu QA đòi bằng chứng P-nn ----------

describe('đợt 3: dấu QA đòi MỖI mã quyền P-nn của SPEC đang mở của nhánh một dòng "đỏ khi tắt" (AC-20)', () => {
  const SPEC_DIR = 'docs/specs/don-hang'
  const specText = (rights) => `# SPEC — đơn hàng\n\n## Bạn duyệt\n\n### Ai dùng\n\nChủ cửa hàng.\n\n### Ai thấy/sửa được dữ liệu gì\n\n${rights}\n\n## Kỹ thuật\n\nGhi chú.\n`
  const RIGHTS3 = '- P-01: Chủ đơn thấy đơn của mình\n- P-02: Nhân viên sửa đơn được giao\n- P-03: Khách xoá đơn của mình'
  const progress = ({ state = 'đang làm', branch = 'feat, C:/wt' } = {}) => `# Tiến độ: đơn hàng\nTrạng thái: ${state}\nPha: 4 — thi công\nNhánh / worktree: ${branch}\n`
  const P = (n, rest = 'có — tests/rls.test.ts') => `P-0${n}: đỏ khi tắt: ${rest}`
  const report = (fx, name, ...lines) => write(fx.root, name, `QA đạt\n${lines.join('\n')}\n`)
  const stampQa = (fx, name, ...lines) => cli(fx, fx.wt, 'stamp', 'qa', report(fx, name, ...lines))
  const stopIn = (cwd) => ({ hook_event_name: 'Stop', cwd, stop_hook_active: false, last_assistant_message: 'xong' })

  // SPEC + sổ tiến độ nằm ở THƯ MỤC CHÍNH (docs ngoài git, worktree không có), nhánh feat có một commit code.
  function pFx({ rights = RIGHTS3, ...prog } = {}) {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    write(fx.main, `${SPEC_DIR}/SPEC.md`, specText(rights))
    write(fx.main, `${SPEC_DIR}/progress.md`, progress(prog))
    return fx
  }
  // Đóng dấu review + test như thường; dấu QA ghi thẳng vào gatesDir (đường vòng của AI: không qua `stamp qa`).
  function stampAllButQa(fx) {
    assert.equal(cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'review.json', '{"findings":[]}')).status, 0)
    assert.equal(cli(fx, fx.wt, 'stamp', 'test', '--', 'node', '-e', '0').status, 0)
    return pidOf(fx)
  }
  const putQa = (fx, pid, ...lines) => {
    fs.mkdirSync(fx.gates, { recursive: true })
    fs.writeFileSync(path.join(fx.gates, `qa-${pid}.md`), `QA xong\n${lines.join('\n')}\n`)
  }
  const merge = (fx, target = 'feat') => hook(fx, 'bash', bashIn(fx.main, `git merge ${target}`))

  test('SPEC có 3 mã P, báo cáo QA chỉ 1 dòng ⇒ stamp qa KHÔNG đóng dấu, nêu đúng 2 mã còn thiếu bằng lời đời thường; đủ 3 dòng ⇒ đóng dấu', () => {
    const fx = pFx()
    const r = stampQa(fx, 'q1.md', P(1))
    assert.equal(r.status, 1)
    assertPlainOpening(r.stderr, 'stamp qa')
    assert.match(r.stderr, /thiếu dòng cho: P-02, P-03\./)
    assert.match(r.stderr, /có 3 mã quyền \(P-01, P-02, P-03\)/)
    assert.match(r.stderr, /P-nn: đỏ khi tắt: có — <file test>/)
    assert.ok(!fs.existsSync(fx.gates) || !fs.readdirSync(fx.gates).some((n) => n.startsWith('qa-')), 'không có dấu qa nào được ghi')
    const none = stampQa(fx, 'q0.md', 'chỉ ghi: đã chạy hết test')
    assert.equal(none.status, 1)
    assert.match(none.stderr, /thiếu dòng cho: P-01, P-02, P-03\./)
    const ok = stampQa(fx, 'q3.md', P(1), P(2), P(3, 'có — tests/xoa.test.ts'))
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(cli(fx, fx.wt, 'status').stdout, /qa: có/)
  })

  test('dòng bằng chứng phải đúng dạng: "không", "có thể", cụt (không file), thiếu dấu hai chấm, sai mã, không đầu dòng ⇒ không tính; markdown / NFD / dấu : — kiểu khác ⇒ tính', () => {
    const fx = pFx({ rights: '- P-01: Chủ đơn thấy đơn của mình' })
    for (const [i, line] of [
      'P-01: đỏ khi tắt: không — tests/a.test.ts',
      'P-01: đỏ khi tắt: có thể — tests/a.test.ts',
      'P-01: đỏ khi tắt: có',
      'P-01: đỏ khi tắt: có —',
      'P-01: đỏ khi tắt: có tests/a.test.ts',
      'P-01 đỏ khi tắt có — tests/a.test.ts',
      'P-011: đỏ khi tắt: có — tests/a.test.ts',
      'P-02: đỏ khi tắt: có — tests/a.test.ts',
      'xem P-01: đỏ khi tắt: có — tests/a.test.ts',
    ].entries()) assert.equal(stampQa(fx, `bad${i}.md`, line).status, 1, line)
    for (const [i, line] of [
      '- P-01: đỏ khi tắt: có — tests/a.test.ts',
      '- **P-01**: đỏ khi tắt: **có** — tests/a.test.ts',
      'P-01: Đỏ khi tắt: Có - tests/a.test.ts (3 test)',
      'P-01: đỏ khi tắt: có — tests/a.test.ts'.normalize('NFD'),
      '> P-01：đỏ khi tắt：có – tests/a.test.ts',
    ].entries()) assert.equal(stampQa(fx, `good${i}.md`, line).status, 0, line)
  })

  test('cổng gộp kiểm lại dấu QA đã lưu: dấu thiếu dòng của P-02, P-03 ⇒ coi như thiếu qa (status nêu mã; gộp bị nhắc thiếu qa, cả khi gộp bằng mã commit); đủ dòng ⇒ im', () => {
    const fx = pFx()
    const pid = stampAllButQa(fx)
    putQa(fx, pid, P(1))
    assert.match(cli(fx, fx.wt, 'status').stdout, /qa: không \(thiếu dòng "P-nn: đỏ khi tắt: có — <file test>" cho P-02, P-03\)/)
    const sha = git(fx.wt, 'rev-parse', 'HEAD').trim()
    for (const target of ['feat', sha]) {
      assert.equal(assertNudge(merge(fx, target)), 'Gộp khi còn thiếu: qa. Làm nốt nếu làm được; không được thì báo user một dòng phần chưa kiểm.', target)
    }
    putQa(fx, pid, P(1), P(2), P(3))
    assert.match(cli(fx, fx.wt, 'status').stdout, /qa: có/)
    assertPass(merge(fx))
  })

  test('Stop: dấu QA thiếu bằng chứng P-nn ⇒ nhắc kèm mã còn thiếu', () => {
    const fx = pFx()
    putQa(fx, stampAllButQa(fx), P(2))
    const reason = assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
    assert.match(reason, /thiếu: qa/)
    assert.match(reason, /cho P-01, P-03\./)
  })

  test('SPEC "Không áp dụng", sổ đã xong, sổ của nhánh khác, không có SPEC cạnh sổ ⇒ không đòi dòng P-nn (báo cáo QA như cũ)', () => {
    const cases = {
      'không áp dụng': pFx({ rights: 'Không áp dụng — app một người dùng, không có dữ liệu riêng.' }),
      'sổ đã xong': pFx({ state: 'xong' }),
      'nhánh khác': pFx({ branch: 'khac, C:/wt' }),
    }
    const noSpec = pFx()
    fs.rmSync(path.join(noSpec.main, SPEC_DIR, 'SPEC.md'))
    cases['không có SPEC'] = noSpec
    cases['không có sổ'] = fixture()
    commit(cases['không có sổ'].wt, 'feat.go', 'package x\n', 'feat')
    for (const [name, fx] of Object.entries(cases)) assert.equal(stampQa(fx, 'q.md', 'QA đạt').status, 0, name)
  })

  test('SPEC + sổ nằm trong chính worktree (đã commit) ⇒ cũng đọc được; báo cáo "N/A" không lách được khi SPEC có mã P', () => {
    const fx = fixture()
    commit(fx.wt, `${SPEC_DIR}/SPEC.md`, specText(RIGHTS3), 'spec')
    commit(fx.wt, `${SPEC_DIR}/progress.md`, progress(), 'sổ')
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    assert.equal(stampQa(fx, 'q1.md', P(1), P(3)).status, 1)
    const na = cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'na.md', 'N/A\n'))
    assert.equal(na.status, 1)
    assert.match(na.stderr, /thiếu dòng cho: P-01, P-02, P-03/)
    assert.equal(stampQa(fx, 'q3.md', P(1), P(2), P(3)).status, 0)
  })

  // Fail-closed: SPEC đang mở mà không đọc được thì không được coi là "không có mã quyền" (cổng mở).
  const UNREADABLE = /không đọc được SPEC để kiểm mã quyền/
  const specPath = (fx) => path.join(fx.main, SPEC_DIR, 'SPEC.md')
  const breakSpec = (fx, how) => {
    if (how === 'quá 2 MB') write(fx.main, `${SPEC_DIR}/SPEC.md`, `${specText(RIGHTS3)}\n${'x'.repeat(2 * 1024 * 1024 + 16)}\n`)
    else { fs.rmSync(specPath(fx)); fs.mkdirSync(specPath(fx)) } // SPEC.md là thư mục ⇒ đọc lỗi
  }
  const mended = (fx) => { fs.rmSync(specPath(fx), { recursive: true, force: true }); write(fx.main, `${SPEC_DIR}/SPEC.md`, specText(RIGHTS3)) }

  test('SPEC cỡ 1,5 MB (trước đây bị bỏ qua nên cổng mở) vẫn được đọc: báo cáo thiếu dòng P-nn ⇒ KHÔNG đóng dấu', () => {
    const fx = pFx()
    write(fx.main, `${SPEC_DIR}/SPEC.md`, specText(RIGHTS3).replace('Ghi chú.', 'x'.repeat(1.5 * 1024 * 1024)))
    const r = stampQa(fx, 'q1.md', P(1))
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /thiếu dòng cho: P-02, P-03\./)
    assert.equal(stampQa(fx, 'q3.md', P(1), P(2), P(3)).status, 0)
  })

  test('SPEC đang mở quá 2 MB hoặc không đọc được ⇒ stamp qa KHÔNG đóng dấu, lời đời thường "không đọc được SPEC để kiểm mã quyền" nêu SPEC nào; status nêu lý do', () => {
    for (const how of ['quá 2 MB', 'lỗi đọc']) {
      const fx = pFx()
      breakSpec(fx, how)
      const r = stampQa(fx, 'q.md', P(1), P(2), P(3))
      assert.equal(r.status, 1, `${how}: ${r.stderr}`)
      assertPlainOpening(r.stderr, how)
      assert.match(r.stderr, UNREADABLE)
      assert.match(r.stderr, /docs\/specs\/don-hang\/SPEC\.md/)
      assert.ok(!fs.existsSync(fx.gates) || !fs.readdirSync(fx.gates).some((n) => n.startsWith('qa-')), `${how}: không có dấu qa nào được ghi`)
      const na = cli(fx, fx.wt, 'stamp', 'qa', write(fx.root, 'na.md', 'QA đạt\n'))
      assert.equal(na.status, 1, `${how}: báo cáo không có dòng P cũng không lách được`)
      mended(fx)
      assert.equal(stampQa(fx, 'q2.md', P(1), P(2), P(3)).status, 0, `${how}: SPEC đọc lại được ⇒ đóng dấu`)
    }
  })

  test('cổng gộp + Stop + status: dấu QA có sẵn nhưng SPEC đang mở không đọc được ⇒ coi như chưa có qa (gộp bị nhắc thiếu qa, Stop nhắc), không để cổng mở; SPEC đọc lại được ⇒ im', () => {
    for (const how of ['quá 2 MB', 'lỗi đọc']) {
      const fx = pFx()
      const pid = stampAllButQa(fx)
      putQa(fx, pid, P(1), P(2), P(3))
      assertPass(merge(fx))
      breakSpec(fx, how)
      assert.match(assertNudge(merge(fx)), /Gộp khi còn thiếu: qa\./, how)
      assert.match(cli(fx, fx.wt, 'status').stdout, /qa: không \(không đọc được SPEC để kiểm mã quyền/)
      const stop = assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
      assert.match(stop, /thiếu: qa/)
      assert.match(stop, UNREADABLE)
      mended(fx)
      assertPass(merge(fx))
    }
  })
})
