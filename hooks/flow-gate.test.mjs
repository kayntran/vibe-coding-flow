// Test cho flow-gate.mjs: node --test ~/.claude/hooks/flow-gate.test.mjs
// Mỗi test tạo repo tạm trong os.tmpdir (main + worktree `feat`), gọi script qua spawnSync với JSON stdin, rồi tự dọn.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as K from './lib/kho.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flow-gate.mjs')
// Tắt bảo trì tự động của git (Mac: commit/fetch tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
// Đặt cả vào process.env: K.lay (lib/kho.mjs) chạy trong tiến trình test, clone/fetch với process.env.
const NO_MAINT = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' }
Object.assign(process.env, NO_MAINT)
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
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-gate-')))
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

// Quyết định "ask" (flow-v5): hỏi lại user trước khi push nhánh chính; trả lý do.
function assertAsk(r) {
  assert.equal(r.status, 0)
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'ask', `đáng lẽ hỏi lại, stdout: ${r.stdout}`)
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse')
  return r.json.hookSpecificOutput.permissionDecisionReason
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

// ---------- edit ----------

describe('edit', () => {
  test('sửa file trong thư mục chính bị chặn (cả đường dẫn \\ và /)', () => {
    const fx = fixture()
    const target = path.join(fx.main, 'a.txt')
    for (const p of [target, target.replace(/\\/g, '/')]) {
      const reason = assertDeny(hook(fx, 'edit', { tool_name: 'Edit', cwd: fx.main, tool_input: { file_path: p } }))
      assert.match(reason, /EnterWorktree/)
      assert.match(reason, /allow-direct-edit/)
      assert.ok(reason.toLowerCase().includes(fx.main.toLowerCase().replace(/\\/g, '/')) || reason.toLowerCase().includes(fx.main.toLowerCase()))
    }
  })

  test('NotebookEdit (notebook_path) và file mới trong thư mục chưa tồn tại cũng bị chặn', () => {
    const fx = fixture()
    assertDeny(hook(fx, 'edit', { tool_name: 'NotebookEdit', cwd: fx.main, tool_input: { notebook_path: path.join(fx.main, 'x.ipynb') } }))
    assertDeny(hook(fx, 'edit', { tool_name: 'Write', cwd: fx.main, tool_input: { file_path: path.join(fx.main, 'new', 'deep', 'f.ts') } }))
  })

  test('sửa trong worktree cho qua', () => {
    const fx = fixture()
    assertPass(hook(fx, 'edit', { tool_name: 'Edit', cwd: fx.wt, tool_input: { file_path: path.join(fx.wt, 'a.txt') } }))
    assertPass(hook(fx, 'edit', { tool_name: 'Write', cwd: fx.main, tool_input: { file_path: path.join(fx.wt, 'new', 'f.ts') } }))
  })

  test('có .claude/allow-direct-edit thì cho qua', () => {
    const fx = fixture()
    write(fx.main, '.claude/allow-direct-edit', '')
    assertPass(hook(fx, 'edit', { tool_name: 'Edit', cwd: fx.main, tool_input: { file_path: path.join(fx.main, 'a.txt') } }))
  })

  test('ngoài git repo cho qua; thiếu path cho qua', () => {
    const fx = fixture()
    assertPass(hook(fx, 'edit', { tool_name: 'Write', cwd: fx.root, tool_input: { file_path: path.join(fx.root, 'plain', 'x.txt') } }))
    assertPass(hook(fx, 'edit', { tool_name: 'Write', cwd: fx.main, tool_input: {} }))
  })
})

// ---------- bash (git merge) ----------

describe('bash merge', () => {
  function featFixture(file = 'feat.go') {
    const fx = fixture()
    commit(fx.wt, file, 'package x\n', 'feat')
    return fx
  }

  test('merge thiếu dấu bị chặn, lý do có pid + lệnh stamp', () => {
    const fx = featFixture()
    const reason = assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.ok(reason.includes(pidOf(fx)))
    assert.match(reason, /review, qa/)
    assert.match(reason, /flow-gate\.mjs stamp/)
  })

  test('chỉ có review thì vẫn chặn vì thiếu qa', () => {
    const fx = featFixture()
    assert.equal(cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'r.json', '{"findings":[{"a":1}]}')).status, 0)
    const reason = assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.match(reason, /thiếu qa/)
    assert.doesNotMatch(reason, /thiếu review/)
  })

  test('đủ review + qa thì cho qua', () => {
    const fx = featFixture()
    stampBoth(fx)
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('qa ghi N/A với diff có file .tsx bị chặn', () => {
    const fx = featFixture('Button.tsx')
    cli(fx, fx.wt, 'stamp', 'review', write(fx.root, 'r.json', '{"findings":[]}'))
    const pid = pidOf(fx)
    write(fx.gates, `qa-${pid}.md`, 'N/A - không có UI\n') // CLI từ chối ghi N/A cho UI nên ghi thẳng để thử hook
    const reason = assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.match(reason, /N\/A/)
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
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('merge-base, merge-tree, merge --abort/--continue cho qua', () => {
    const fx = featFixture()
    for (const c of ['git merge-base main feat', 'git merge-tree main feat', 'git merge --abort', 'git merge --continue']) {
      assertPass(hook(fx, 'bash', bashIn(fx.main, c)))
    }
  })

  test('bắt được merge trong chuỗi && ; , -C, cd, cờ có giá trị', () => {
    const fx = featFixture()
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'echo hi && git merge feat')))
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git status; git merge --no-ff feat; echo done')))
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge -m "gộp feat" feat')))
    assertDeny(hook(fx, 'bash', bashIn(fx.root, `git -C "${fx.main.replace(/\\/g, '/')}" merge feat`)))
    assertDeny(hook(fx, 'bash', bashIn(fx.root, `cd "${fx.main.replace(/\\/g, '/')}" && git merge feat 2>&1`)))
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
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('git merge nhiều nhánh: thiếu dấu ở bất kỳ nhánh nào cũng bị chặn', () => {
    const fx = featFixture()
    stampBoth(fx) // feat đủ dấu
    const wtB = addBranch(fx, 'featB') // featB chưa có dấu
    for (const c of ['git merge feat featB', 'git merge featB feat', 'git merge --no-ff -m "gộp" featB feat']) {
      assert.match(assertDeny(hook(fx, 'bash', bashIn(fx.main, c))), /featB/)
    }
    stampBoth(fx, { cwd: wtB })
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat featB')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge featB feat')))
  })

  test('comment # sau lệnh không che nhánh đích; # nằm giữa tên nhánh không phải comment', () => {
    const fx = featFixture()
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat # gộp tính năng')))
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat   #note\n')))
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'echo ok # bước 1\ngit merge feat')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, '# git merge feat')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'echo ok # git merge feat')))
    // nhánh feat#1 không tồn tại ⇒ không so được diff để kiểm luật ⇒ chặn (fail closed); lý do nêu đúng "feat#1" nên # giữa tên không bị đọc là comment
    assert.match(assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat#1'))), /feat#1/)
  })

  test('thân heredoc không phải lệnh; lệnh thật sau/cùng dòng heredoc vẫn bị bắt', () => {
    const fx = featFixture()
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF\ngit merge feat\nEOF')))
    // heredoc đưa vào lệnh khác (ghi heredoc thẳng vào file nay bị chặn riêng: phải dùng công cụ sửa file)
    assertPass(hook(fx, 'bash', bashIn(fx.main, "cat <<'EOF' | wc -l\ngit merge feat\nEOF\necho xong")))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'cat <<-END\n\tgit merge feat\n\tEND\n')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF\ngit merge feat\n'))) // heredoc không đóng: hết lệnh
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF\nxin chào\nEOF\ngit merge feat')))
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF && git merge feat\nxin chào\nEOF')))
  })

  test('lỗi đọc dấu khác ENOENT thì cho qua + ghi log (ENOENT mới là thiếu)', () => {
    const fx = featFixture()
    stampBoth(fx)
    const qa = path.join(fx.gates, `qa-${pidOf(fx)}.md`)
    fs.rmSync(qa)
    assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))) // ENOENT = thiếu
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
    // secret cũ đã nằm trên upstream ⇒ quét sạch; flow-v5: push nhánh chính sạch giờ bị hỏi lại (ask) thay vì cho qua
    assertAsk(sh(fx, fx.main, 'git push'))
    assertAsk(sh(fx, fx.main, 'git push origin main'))
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

  test('diff vượt 20 MB bị cắt ⇒ deny "quá lớn" (không coi là sạch); secret trong phần đã quét vẫn được liệt kê', () => {
    const fx = fixture()
    const pad = 'x'.repeat(99) + '\n'
    stage(fx.main, 'big.txt', pad.repeat(215000)) // ~21,5 MB, sạch
    const r1 = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assert.match(r1, /quá lớn/)
    assert.doesNotMatch(r1, /github/)
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'big2.txt', `t = "${GHP}"\n` + pad.repeat(215000))
    const r2 = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assert.match(r2, /big2\.txt:1 — github/)
    assert.match(r2, /quá lớn/)
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
    // HEAD (main) sạch nên quét secret không chặn (flow-v5: gửi main/HEAD ⇒ ask); src sạch dù dst trùng tên nhánh bẩn ⇒ qua
    for (const c of ['git push', 'git push origin main', 'git push origin HEAD']) assertAsk(sh(fx, fx.main, c))
    for (const c of ['git push origin main:feat', 'git push origin :feat', 'git push origin khong-ton-tai']) {
      assertPass(sh(fx, fx.main, c))
    }
    // HEAD (feat) bẩn: gửi main thì không bị chặn vì secret (flow-v5: ask); không refspec / HEAD / feat:main thì chặn
    assertAsk(sh(fx, fx.wt, 'git push origin main'))
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
    assertAsk(sh(fx, fx.main, 'git push --repo=origin main')) // gửi main sạch (flow-v5: ask)
    assertAsk(sh(fx, fx.main, 'git push --repo origin')) // không refspec ⇒ HEAD (main) sạch (flow-v5: ask)
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

  test('push --mirror quét mọi ref (cả tag và ref lạ trỏ commit không thuộc nhánh nào); --all không quét tag; mirror sạch thì qua', () => {
    const fx = fixture()
    addRemote(fx)
    git(fx.main, 'tag', 'v0')
    assertAsk(sh(fx, fx.main, 'git push --mirror origin')) // mirror sạch: quét secret qua, flow-v5 hỏi lại vì gửi cả nhánh chính
    git(fx.wt, 'checkout', '-q', '--detach')
    commit(fx.wt, 'tagged.js', withSecret, 'secret chỉ có ở tag')
    git(fx.wt, 'tag', 'v9')
    git(fx.wt, 'checkout', '-q', 'feat')
    for (const c of ['git push --mirror origin', 'git push origin --mirror']) assert.match(assertDeny(sh(fx, fx.main, c)), /tagged\.js:2 — github/, c)
    assertAsk(sh(fx, fx.main, 'git push --all origin')) // --all chỉ gửi nhánh, các nhánh đều sạch (flow-v5: ask vì có main)
    git(fx.wt, 'tag', '-d', 'v9')
    assertAsk(sh(fx, fx.main, 'git push --mirror origin'))
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

  test('merge vẫn được gác song song với quét secret', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    stage(fx.main, 'cfg.js', withSecret)
    assertDeny(sh(fx, fx.main, 'git merge feat'))
    assert.match(assertDeny(sh(fx, fx.main, 'git merge feat && git commit -m x')), /Chưa đủ dấu/)
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

  test('merge: thiếu dấu test bị chặn, lý do liệt kê "test" + lệnh mẫu; có dấu test thì qua', () => {
    const fx = featFx()
    stampBoth(fx, { test: false })
    const reason = assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.match(reason, /feat: thiếu test \(/)
    assert.doesNotMatch(reason, /thiếu review|thiếu .*qa/)
    assert.ok(reason.includes('node ~/.claude/hooks/flow-gate.mjs stamp test -- <lệnh test đủ bộ>'), reason)
    assert.equal(stampTest(fx, 'node', '-e', '0').status, 0)
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('thiếu cả ba dấu: lý do liệt kê review, qa, test', () => {
    const fx = featFx()
    assert.match(assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /thiếu review, qa, test/)
  })

  test('dấu test của diff cũ không còn hiệu lực sau khi diff đổi (patch-id đổi)', () => {
    const fx = featFx()
    stampBoth(fx)
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    commit(fx.wt, 'feat2.go', 'package y\n', 'feat2')
    assert.match(assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /thiếu review, qa, test/)
  })

  test('flow.json {"tests":"none"} ⇒ merge không đòi dấu test; vẫn đòi review + qa', () => {
    const fx = featFx()
    write(fx.main, '.claude/flow.json', JSON.stringify({ tests: 'none' }))
    const reason = assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assert.match(reason, /thiếu review, qa \(/)
    stampBoth(fx, { test: false })
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
  })

  test('flow.json hỏng hoặc tests khác "none" ⇒ vẫn đòi dấu test', () => {
    const fx = featFx()
    stampBoth(fx, { test: false })
    write(fx.main, '.claude/flow.json', '{không json')
    assert.match(assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /thiếu test/)
    write(fx.main, '.claude/flow.json', JSON.stringify({ tests: 'all' }))
    assert.match(assertDeny(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /thiếu test/)
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

  test('diff chỉ có .md thiếu dấu test ⇒ cho gộp; diff có .ts thiếu dấu test ⇒ chặn', () => {
    const fx = fixture()
    commit(fx.wt, 'README.md', '# doc\n', 'docs')
    stampBoth(fx, { test: false })
    assertPass(merge(fx))
    const fx2 = fixture()
    commit(fx2.wt, 'src/app.ts', 'export {}\n', 'code')
    stampBoth(fx2, { test: false })
    assert.match(assertDeny(merge(fx2)), /feat: thiếu test \(/)
  })

  test('tài liệu: .md .mdx .txt (không phân biệt hoa thường) và mọi file dưới docs/; diff chỉ tài liệu vẫn đòi review + qa', () => {
    const fx = fixture()
    commit(fx.wt, 'README.MD', '# a\n', 'a')
    commit(fx.wt, 'guide/intro.mdx', '# b\n', 'b')
    commit(fx.wt, 'notes/todo.txt', 'c\n', 'c')
    commit(fx.wt, 'docs/diagram.png', 'png\n', 'd')
    commit(fx.wt, 'docs/api/schema.json', '{}\n', 'e')
    const reason = assertDeny(merge(fx))
    assert.match(reason, /feat: thiếu review, qa \(/) // không có "test"
    stampBoth(fx, { test: false })
    assertPass(merge(fx))
  })

  test('diff lẫn tài liệu và code ⇒ vẫn đòi test; docs nằm sâu (src/docs/…) hoặc đuôi .md.ts không phải tài liệu', () => {
    const fx = fixture()
    commit(fx.wt, 'README.md', '# doc\n', 'docs')
    commit(fx.wt, 'src/app.ts', 'export {}\n', 'code')
    stampBoth(fx, { test: false })
    assert.match(assertDeny(merge(fx)), /thiếu test/)
    const fx2 = fixture()
    commit(fx2.wt, 'src/docs/Viewer.ts', 'export {}\n', 'x')
    stampBoth(fx2, { test: false })
    assert.match(assertDeny(merge(fx2)), /thiếu test/)
    const fx3 = fixture()
    commit(fx3.wt, 'notes.md.ts', 'export {}\n', 'x')
    stampBoth(fx3, { test: false })
    assert.match(assertDeny(merge(fx3)), /thiếu test/)
  })

  test('đổi tên file code thành tài liệu vẫn tính là đổi code (cả hai đầu đường dẫn)', () => {
    const fx = fixture()
    commit(fx.main, 'src/old.ts', 'export {}\n', 'thêm old.ts')
    git(fx.wt, 'rebase', 'main')
    fs.mkdirSync(path.join(fx.wt, 'docs'), { recursive: true })
    git(fx.wt, 'mv', 'src/old.ts', 'docs/old.md')
    git(fx.wt, 'commit', '-m', 'đổi tên')
    stampBoth(fx, { test: false })
    assert.match(assertDeny(merge(fx)), /thiếu test/)
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

  test('deny thắng ask khi nhiều lệnh trong một chuỗi (ask đến trước hay sau đều vậy)', () => {
    const fx = fixture()
    assertAsk(sh(fx, fx.main, 'git push origin main')) // đơn lẻ chỉ hỏi
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
})

// ---------- Làn A (flow-v5): hỏi lại khi push nhánh chính ----------

describe('bash: push nhánh chính ⇒ ask', () => {
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

  test('main trước remote 2 commit ⇒ ask, lý do "Sắp push 2 commit lên origin/main" + log --oneline', () => {
    const fx = remoteFx()
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    commit(fx.main, 'x2.txt', 'x\n', 'thêm x2')
    for (const c of ['git push', 'git push origin main', 'git push origin HEAD', 'git -C . push origin main', 'git push -u origin main', 'git push origin refs/heads/main:refs/heads/main']) {
      const reason = assertAsk(sh(fx, fx.main, c))
      assert.match(reason, /^Sắp push 2 commit lên origin\/main:\n[0-9a-f]+ thêm x2\n[0-9a-f]+ thêm x1$/, c)
    }
  })

  test('commit nhiều hơn 15 ⇒ n là tổng, nhưng chỉ liệt kê tối đa 15 dòng', () => {
    const fx = remoteFx()
    for (let i = 1; i <= 20; i++) git(fx.main, 'commit', '--allow-empty', '-m', `c${i}`)
    const reason = assertAsk(sh(fx, fx.main, 'git push'))
    assert.match(reason, /^Sắp push 20 commit lên origin\/main:\n/)
    const lines = reason.split('\n').slice(1)
    assert.equal(lines.length, 15)
    assert.match(lines[0], / c20$/)
    assert.match(lines[14], / c6$/)
  })

  test('không có remote-tracking ⇒ đếm toàn bộ lịch sử; remote lấy từ tham số hoặc cấu hình nhánh', () => {
    const fx = fixture() // chưa có remote nào
    assert.match(assertAsk(sh(fx, fx.main, 'git push origin main')), /^Sắp push 1 commit lên origin\/main:\n[0-9a-f]+ init$/)
    assert.match(assertAsk(sh(fx, fx.main, 'git push upstream main')), /^Sắp push 1 commit lên upstream\/main:/)
    git(fx.main, 'config', 'branch.main.remote', 'gitlab')
    assert.match(assertAsk(sh(fx, fx.main, 'git push')), /^Sắp push 1 commit lên gitlab\/main:/)
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

  test('gửi nhánh khác vào main (feat:main) ⇒ ask với commit của feat; --all / --mirror cũng hỏi', () => {
    const fx = remoteFx()
    commit(fx.wt, 'f.go', 'package f\n', 'feat commit')
    const reason = assertAsk(sh(fx, fx.wt, 'git push origin feat:main'))
    assert.match(reason, /^Sắp push \d+ commit lên origin\/main:\n[0-9a-f]+ feat commit/)
    assertPass(sh(fx, fx.main, 'git push --all origin')) // main chưa có gì mới ⇒ không gửi gì lên main
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    assert.match(assertAsk(sh(fx, fx.main, 'git push --all origin')), /^Sắp push 1 commit lên origin\/main:\n[0-9a-f]+ thêm x1$/)
    assert.match(assertAsk(sh(fx, fx.main, 'git push --mirror origin')), /^Sắp push 1 commit lên origin\/main:/)
  })

  test('có secret trong phần sắp push ⇒ deny (không phải ask)', () => {
    const fx = remoteFx()
    commit(fx.main, 'cfg.js', `const t = "${GHP}"\n`, 'secret')
    for (const c of ['git push', 'git push origin main']) {
      assert.match(assertDeny(sh(fx, fx.main, c)), /cfg\.js:1 — github/, c)
    }
  })

  test('đầu ra đúng khuôn hookSpecificOutput với permissionDecision "ask"', () => {
    const fx = remoteFx()
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    const r = sh(fx, fx.main, 'git push')
    assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput'])
    assert.deepEqual(Object.keys(r.json.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'])
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask')
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

    test('không có ở cả worktree lẫn thư mục chính ⇒ vẫn block như AC-09 (không kiểm được phạm vi), có log', () => {
      const { fx } = auditFx()
      commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
      const reason = assertBlock(go(fx, tx(fx, briefOf(path.join(fx.wt, REL)))))
      assert.match(reason, /không kiểm được phạm vi làn A vì/)
      assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check audit lane A/)
    })

    test('đường dẫn nằm ngoài worktree (không có đường dẫn tương đối) và không tồn tại ⇒ không đoán, vẫn block', () => {
      const { fx } = auditFx()
      write(fx.main, 'PLAN-ngoai.md', TABLE('feat.go'))
      const reason = assertBlock(go(fx, tx(fx, briefOf(path.join(fx.root, 'khong-co', 'PLAN.md')))))
      assert.match(reason, /không kiểm được phạm vi làn A vì/)
    })

    test('chạy ngay ở thư mục chính (không phải worktree) mà PLAN không có ⇒ không tìm đâu khác, block như cũ', () => {
      const { fx } = auditFx()
      const reason = assertBlock(go(fx, tx(fx, briefOf(path.join(fx.main, REL))), 'coder', { cwd: fx.main }))
      assert.match(reason, /không kiểm được phạm vi làn A vì/)
    })
  })

  test('làn khác trong cùng plan: file của làn A là ngoài scope của làn B', () => {
    const { fx, plan } = auditFx()
    const reason = assertBlock(go(fx, tx(fx, briefOf(plan, 'lane=B'))))
    assert.match(reason, /OUTSIDE feat\.go/)
  })

  test('base= được chuyển cho lane-check (base không tồn tại ⇒ lane-check exit 2 ⇒ block, AC-09 không cho qua âm thầm)', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    assertBlock(go(fx, tx(fx, briefOf(plan, 'lane=A base=main'))))
    assert.match(assertBlock(go(fx, tx(fx, briefOf(plan, 'lane=A base=khong-co-nhanh-nay')))), /không kiểm được phạm vi làn A/)
    assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check/)
  })

  test('lane-check lỗi (không có plan, lane lạ, bảng hỏng) ⇒ block kèm lý do + cách xử lý (AC-09), vẫn ghi log', () => {
    const { fx, plan } = auditFx()
    commit(fx.wt, 'extra.js', 'x\n', 'ngoài scope')
    for (const [brief, lane] of [
      [briefOf(path.join(fx.root, 'khong-co.md')), 'A'],
      [briefOf(plan, 'lane=Z'), 'Z'],
      [briefOf(write(fx.root, 'hong.md', '# không có bảng\n')), 'A'],
    ]) {
      const reason = assertBlock(go(fx, tx(fx, brief)))
      assert.match(reason, new RegExp(`không kiểm được phạm vi làn ${lane} vì`))
      assert.match(reason, /--repo đúng hoặc báo captain/)
    }
    assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check/)
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

  test('`:` không ép ⇒ ask như push nhánh chính (nếu main có commit chưa lên remote); đã đồng bộ thì qua', () => {
    const fx = remoteFx()
    assertPass(sh(fx, fx.wt, 'git push origin :')) // main = origin/main
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    for (const c of ['git push origin :', 'git push --repo=origin :']) {
      assert.match(assertAsk(sh(fx, fx.wt, c)), /^Sắp push 1 commit lên origin\/main:\n[0-9a-f]+ thêm x1$/, c)
    }
  })

  test('remote chưa có main/master (không có nhánh theo dõi) ⇒ `+:` không chạm nhánh chính ⇒ qua; refspec khác `:` không bị coi là matching', () => {
    const fx = fixture() // không có remote nào
    assertPass(sh(fx, fx.wt, 'git push origin +:'))
    assertPass(sh(fx, fx.wt, 'git push --force origin :'))
    const fx2 = remoteFx()
    assertPass(sh(fx2, fx2.wt, 'git push origin +:feat')) // `:feat` = xoá feat trên remote, không phải matching
    assertPass(sh(fx2, fx2.wt, 'git push --force --dry-run origin :'))
  })

  test('push.default=matching và không refspec ⇒ gửi mọi nhánh trùng tên: cờ ép ⇒ deny, không ép ⇒ ask; cấu hình khác thì như cũ', () => {
    const fx = remoteFx()
    assertPass(sh(fx, fx.wt, 'git push --force origin')) // mặc định: chỉ HEAD (feat)
    git(fx.main, 'config', 'push.default', 'simple')
    assertPass(sh(fx, fx.wt, 'git push --force'))
    git(fx.main, 'config', 'push.default', 'matching')
    for (const c of ['git push --force', 'git push -f origin', 'git push --force-with-lease']) assertDeny(sh(fx, fx.wt, c))
    assertPass(sh(fx, fx.wt, 'git push')) // main đã đồng bộ
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    assert.match(assertAsk(sh(fx, fx.wt, 'git push')), /^Sắp push 1 commit lên origin\/main:/)
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
// Làn D (flow v7): host.normalize, secrets.mjs, roles.json, cổng thư viện mới, ask theo host, AC-09, AC-24, Stop theo sổ
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

describe('v7 host: sửa file qua Codex apply_patch / tên tool Devin', () => {
  test('Codex apply_patch vào file của thư mục chính bị chặn (đường dẫn tương đối theo cwd, và tuyệt đối)', () => {
    const fx = fixture()
    const rel = assertDeny(hook(fx, 'edit', codexIn(fx.main, 'apply_patch', { command: patchOf('a.txt') })))
    assert.match(rel, /a\.txt/)
    assertDeny(hook(fx, 'edit', codexIn(fx.wt, 'apply_patch', { command: patchOf(path.join(fx.main, 'a.txt')) })))
    assertDeny(hook(fx, 'edit', codexIn(fx.wt, 'apply_patch', { command: patchOf('../main/a.txt') })))
  })

  test('Codex apply_patch trong worktree cho qua; có allow-direct-edit cho qua', () => {
    const fx = fixture()
    assertPass(hook(fx, 'edit', codexIn(fx.wt, 'apply_patch', { command: patchOf('a.txt') })))
    assertPass(hook(fx, 'edit', codexIn(fx.main, 'apply_patch', { command: patchOf(path.join(fx.wt, 'a.txt')) })))
    write(fx.main, '.claude/allow-direct-edit', '')
    assertPass(hook(fx, 'edit', codexIn(fx.main, 'apply_patch', { command: patchOf('a.txt') })))
  })

  test('patch nhiều file: một file trong thư mục chính là đủ để chặn; Add File ở thư mục mới, Move to, Delete File cũng bị kiểm', () => {
    const fx = fixture()
    const mixed = patchOf(path.join(fx.wt, 'a.txt'), path.join(fx.main, 'a.txt'))
    assert.match(assertDeny(hook(fx, 'edit', codexIn(fx.wt, 'apply_patch', { command: mixed }))), /a\.txt/)
    const add = `*** Begin Patch\n*** Add File: ${path.join(fx.main, 'new', 'deep', 'f.ts')}\n+x\n*** End Patch`
    assertDeny(hook(fx, 'edit', codexIn(fx.wt, 'apply_patch', { command: add })))
    const move = `*** Begin Patch\n*** Update File: ${path.join(fx.wt, 'a.txt')}\n*** Move to: ${path.join(fx.main, 'moved.txt')}\n@@\n-line1\n+line1\n*** End Patch`
    assertDeny(hook(fx, 'edit', codexIn(fx.wt, 'apply_patch', { command: move })))
    const del = `*** Begin Patch\n*** Delete File: ${path.join(fx.main, 'a.txt')}\n*** End Patch`
    assertDeny(hook(fx, 'edit', codexIn(fx.wt, 'apply_patch', { command: del })))
  })

  test('patch không đọc được file nào / ngoài git repo ⇒ cho qua', () => {
    const fx = fixture()
    assertPass(hook(fx, 'edit', codexIn(fx.main, 'apply_patch', { command: 'không phải patch' })))
    assertPass(hook(fx, 'edit', codexIn(fx.main, 'apply_patch', {})))
    assertPass(hook(fx, 'edit', codexIn(fx.root, 'apply_patch', { command: patchOf(path.join(fx.root, 'plain', 'x.txt')) })))
  })

  test('lời chặn cho Codex chỉ cách tạo worktree bằng git (không có EnterWorktree); Claude vẫn nhắc EnterWorktree', () => {
    const fx = fixture()
    const codex = assertDeny(hook(fx, 'edit', codexIn(fx.main, 'apply_patch', { command: patchOf('a.txt') })))
    assert.match(codex, /git worktree add/)
    assert.doesNotMatch(codex, /EnterWorktree/)
    assert.match(codex, /allow-direct-edit/)
    const claude = assertDeny(hook(fx, 'edit', { tool_name: 'Edit', cwd: fx.main, tool_input: { file_path: path.join(fx.main, 'a.txt') } }))
    assert.match(claude, /EnterWorktree/)
  })

  test('tên tool Devin: write/edit (file_path hoặc path), notebook_edit, apply_patch', () => {
    const fx = fixture()
    const target = path.join(fx.main, 'a.txt')
    assertDeny(hook(fx, 'edit', devinIn(fx.main, 'write', { file_path: target })))
    assertDeny(hook(fx, 'edit', devinIn(fx.main, 'edit', { path: target })))
    assertDeny(hook(fx, 'edit', devinIn(fx.main, 'notebook_edit', { notebook_path: path.join(fx.main, 'n.ipynb') })))
    assertDeny(hook(fx, 'edit', devinIn(fx.main, 'apply_patch', { command: patchOf('a.txt') })))
    assertPass(hook(fx, 'edit', devinIn(fx.wt, 'write', { file_path: path.join(fx.wt, 'a.txt') })))
  })

  test('Bash chứa `apply_patch <<` ⇒ kiểm từng file trong patch (Codex/Devin gọi apply_patch qua shell)', () => {
    const fx = fixture()
    const cmd = (patch) => `apply_patch <<'EOF'\n${patch}\nEOF`
    assert.match(assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: cmd(patchOf('a.txt')) }))), /a\.txt/)
    assertDeny(hook(fx, 'bash', devinIn(fx.main, 'exec', { command: cmd(patchOf('a.txt')) })))
    assertDeny(hook(fx, 'bash', bashIn(fx.wt, `cd ${fx.main.replace(/\\/g, '/')} && apply_patch <<'PATCH'\n${patchOf(path.join(fx.main, 'a.txt'))}\nPATCH`)))
    assertPass(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: cmd(patchOf('a.txt')) })))
    assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: 'echo apply_patch and *** Update File: a.txt' }))) // không có heredoc
    assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: 'ls' })))
  })

  test('apply_patch đi sau tiền tố (command / env / exec / sudo / đường dẫn tuyệt đối / bash -c) vẫn bị kiểm file trong patch', () => {
    const fx = fixture()
    const body = `\n${patchOf('a.txt')}\nEOF`
    const heads = [
      "command apply_patch <<'EOF'", "env FOO=1 apply_patch <<'EOF'", '/usr/local/bin/apply_patch <<EOF', "exec apply_patch <<'EOF'",
      "sudo -n apply_patch <<'EOF'", "FOO=1 command -- apply_patch <<'EOF'", "time apply_patch <<'EOF'",
    ]
    for (const head of heads) {
      assert.match(assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: head + body }))), /a\.txt/, head)
      assertDeny(hook(fx, 'bash', devinIn(fx.main, 'exec', { command: head + body })))
      assertPass(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: head + body })))
    }
    assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: `bash -c "apply_patch <<'EOF'${body}"` })))
    assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `cd ${fx.main.replace(/\\/g, '/')} && env X=1 apply_patch <<'EOF'${body}` })))
    assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: `cd ${fx.wt.replace(/\\/g, '/')} && command apply_patch <<'EOF'${body}` })))
  })

  test('apply_patch không xác định được thư mục đích (cd $VAR, cd ~, cd -, cd trần, cd $(…)) ⇒ deny với đường dẫn tương đối; đường dẫn tuyệt đối vẫn xét như thường', () => {
    const fx = fixture()
    const rel = `\n${patchOf('a.txt')}\nEOF`
    for (const cd of ['cd "$TARGET"', 'cd ~/proj', 'cd -', 'cd', 'cd $(git rev-parse --show-toplevel)', 'cd `pwd`/x', 'pushd "$TARGET"', 'popd']) {
      const reason = assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `${cd} && apply_patch <<'EOF'${rel}` })))
      assertPlainOpening(reason, cd)
    }
    const abs = (f) => `\n${patchOf(f)}\nEOF`
    assertPass(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `cd "$TARGET" && apply_patch <<'EOF'${abs(path.join(fx.wt, 'a.txt'))}` })))
    assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `cd "$TARGET" && apply_patch <<'EOF'${abs(path.join(fx.main, 'a.txt'))}` })))
    // cd sau đó về chỗ biết rõ thì lại xét bình thường
    assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: `cd "$TARGET"; cd ${fx.wt.replace(/\\/g, '/')} && apply_patch <<'EOF'${rel}` })))
  })

  test('apply_patch nhận patch qua pipe (cat <<EOF | apply_patch) ⇒ vẫn kiểm file trong patch như heredoc trực tiếp', () => {
    const fx = fixture()
    const piped = `cat <<'EOF' | apply_patch\n${patchOf('a.txt')}\nEOF`
    assert.match(assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: piped }))), /a\.txt/)
    assertPass(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: piped })))
    assertDeny(hook(fx, 'bash', devinIn(fx.main, 'exec', { command: `cat <<EOF | command apply_patch\n${patchOf('a.txt')}\nEOF` })))
    assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `cd ${fx.main.replace(/\\/g, '/')} && cat <<'EOF' | sudo -n apply_patch\n${patchOf('a.txt')}\nEOF` })))
    assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: `bash -c "cat <<'EOF' | apply_patch\n${patchOf('a.txt')}\nEOF"` })))
  })

  // Review lượt 2 (BLOCKER): gọi apply_patch qua biến/alias/find -exec thì cổng không nhận ra "cách gọi" nên bỏ qua kiểm file dù patch nằm ngay trong lệnh.
  test('lệnh CHỨA nội dung patch (*** Update File: …) thì luôn kiểm file, dù cách gọi apply_patch không nhận ra được (biến, alias, $(…), ghép tên, find -exec, eval)', () => {
    const fx = fixture()
    const main = fx.main.replace(/\\/g, '/')
    const body = (f) => `\n${patchOf(f)}\nEOF`
    const heads = [
      "p=apply_patch; $p <<'EOF'", "p=apply_patch; \"$p\" <<'EOF'", "p=apply_patch\ncommand $p <<'EOF'", "alias ap=apply_patch; ap <<'EOF'",
      "$(command -v apply_patch) <<'EOF'", "a=apply_; b=patch; $a$b <<'EOF'", "eval \"$CMD\" <<'EOF'", "find . -maxdepth 0 -exec apply_patch {} \\; <<'EOF'",
      "env \"$P\" <<'EOF'", "cat <<'EOF' | xargs -I{} sh -c \"$APPLY\"",
    ]
    for (const head of heads) {
      const reason = assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: head + body('a.txt') })))
      assert.match(reason, /a\.txt/, head)
      assertDeny(hook(fx, 'bash', devinIn(fx.main, 'exec', { command: head + body('a.txt') })))
      assertPass(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: head + body('a.txt') }))) // trong worktree thì đường dẫn tương đối là của worktree
      assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: head + body(`${main}/a.txt`) }))) // đường dẫn tuyệt đối vào thư mục chính
    }
  })

  test('nội dung patch nằm sau cd tới thư mục chính / chỗ không biết, cách gọi không nhận ra ⇒ vẫn deny; cd về worktree rồi gọi thì xét theo chỗ cd', () => {
    const fx = fixture()
    const main = fx.main.replace(/\\/g, '/')
    const wt = fx.wt.replace(/\\/g, '/')
    const rel = `\n${patchOf('a.txt')}\nEOF`
    assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `cd ${main} && p=apply_patch && $p <<'EOF'${rel}` })))
    const unknown = assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `cd "$X" && p=apply_patch && $p <<'EOF'${rel}` })))
    assertPlainOpening(unknown)
    // có lời gọi nhận ra được thì vẫn xét theo chỗ gọi (không bị coi là không nhận ra)
    assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: `cd ${wt} && apply_patch <<'EOF'${rel}` })))
    assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `cd ${main} && apply_patch <<'EOF'${rel}` })))
  })

  test('gọi apply_patch không nhận ra được (biến, alias, find -exec, xargs) với patch từ FILE (không có nội dung trong lệnh) ⇒ deny, ở cả worktree', () => {
    const fx = fixture()
    const cmds = [
      'p=apply_patch; $p < x.patch', 'p=apply_patch; "$p" < x.patch', 'p=apply_patch && cat x.patch | $p', 'p=apply_patch; `echo $p` < x.patch',
      'alias ap=apply_patch; ap < x.patch', 'find . -name x.patch -exec apply_patch {} \\;', 'ls *.patch | xargs apply_patch',
    ]
    for (const command of cmds) {
      assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command })), command)
      assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command })), command)
    }
    for (const command of ['p=apply_patch; echo $p', 'command -v apply_patch', 'rg -n apply_patch hooks', 'git log --grep apply_patch', 'which apply_patch']) {
      assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command })), command)
    }
  })

  test('lệnh không chứa nội dung patch (chỉ nhắc *** trong chuỗi một dòng, echo, commit message) vẫn qua', () => {
    const fx = fixture()
    for (const command of ['echo "*** Update File: a.txt"', 'git commit -m "*** Update File: a.txt"', 'p=apply_patch; echo $p', 'ls *** ']) {
      assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command })))
    }
  })

  // Review lượt 2 (MAJOR): shell con tự cd rồi apply_patch với đường dẫn tương đối — cổng chỉ biết cwd của shell ngoài.
  test('bash/sh -c, eval, sudo bash -c có cd/pushd BÊN TRONG + patch đường dẫn tương đối ⇒ deny như cd không xác định; đường dẫn tuyệt đối vẫn xét như thường', () => {
    const fx = fixture()
    const main = fx.main.replace(/\\/g, '/')
    const wt = fx.wt.replace(/\\/g, '/')
    const rel = `\n${patchOf('a.txt')}\nEOF`
    const inner = (cd) => `${cd} && apply_patch <<'EOF'${rel}`
    const cmds = [
      `bash -c "${inner(`cd ${main}`)}"`, `sh -c "${inner(`cd ${main}`)}"`, `bash -lc "${inner(`pushd ${main}`)}"`, `eval "${inner(`cd ${main}`)}"`,
      `sudo -n bash -c "${inner(`cd ${main}`)}"`, `bash -c 'bash -c "cd ${main} && apply_patch <<EOF${rel}"'`, `bash -c "cd ${main}; apply_patch <<'EOF'${rel}"`,
      `bash -c "cd ${wt} && cd ${main} && apply_patch <<'EOF'${rel}"`, `env X=1 bash -c "${inner('builtin cd ' + main)}"`,
    ]
    for (const command of cmds) {
      const reason = assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command })))
      assert.match(reason, /a\.txt/, command)
      assert.match(reason, /cd/, command)
      assertDeny(hook(fx, 'bash', devinIn(fx.wt, 'exec', { command })))
    }
    // đường dẫn tuyệt đối: trong worktree qua, vào thư mục chính bị chặn — dù có cd bên trong
    const abs = (f) => `\n${patchOf(f)}\nEOF`
    assertPass(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `bash -c "cd ${main} && apply_patch <<'EOF'${abs(`${wt}/a.txt`)}"` })))
    assertDeny(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `bash -c "cd ${wt} && apply_patch <<'EOF'${abs(`${main}/a.txt`)}"` })))
  })

  test('bash -c KHÔNG có cd bên trong: đường dẫn tương đối vẫn xét theo cwd ngoài (worktree qua, thư mục chính chặn)', () => {
    const fx = fixture()
    const rel = `\n${patchOf('a.txt')}\nEOF`
    assertPass(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `bash -c "apply_patch <<'EOF'${rel}"` })))
    assertPass(hook(fx, 'bash', codexIn(fx.wt, 'Bash', { command: `sudo -n sh -c "echo cd-not-a-command; apply_patch <<'EOF'${rel}"` })))
    assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: `bash -c "apply_patch <<'EOF'${rel}"` })))
  })

  test('có gọi apply_patch mà không đọc được file nào từ lệnh (patch từ file / biến / printf / $(…)) ⇒ deny "không xác định được file sẽ bị sửa", ở cả thư mục chính lẫn worktree', () => {
    const fx = fixture()
    const cmds = [
      'apply_patch < /tmp/p.diff', 'cat /tmp/p.diff | apply_patch', 'echo "$PATCH" | apply_patch', 'apply_patch "$(cat /tmp/p.diff)"',
      "printf '*** Begin Patch\\n*** Update File: a.txt\\n*** End Patch\\n' | apply_patch", 'command apply_patch < p.diff', 'env X=1 apply_patch < p.diff',
      'bash -c "apply_patch < /tmp/p.diff"', 'sudo -n bash -c "apply_patch < /tmp/p.diff"', 'cat p.diff | xargs apply_patch', '/usr/bin/apply_patch --help',
      `apply_patch <<'EOF'\nnội dung không phải patch\nEOF`,
    ]
    for (const command of cmds) {
      for (const cwd of [fx.main, fx.wt]) {
        const reason = assertDeny(hook(fx, 'bash', codexIn(cwd, 'Bash', { command })))
        assertPlainOpening(reason, command)
        assert.match(reason, /không xác định được file sẽ bị sửa/i, command)
      }
    }
  })

  test('chỉ NHẮC TÊN apply_patch (echo, grep, rg, command -v, which, commit message) không phải là gọi ⇒ qua', () => {
    const fx = fixture()
    for (const command of ['echo apply_patch', 'echo "dùng apply_patch <<EOF để sửa"', 'grep apply_patch notes.txt', 'rg apply_patch .', 'command -v apply_patch',
      'which apply_patch', 'git commit -m "fix apply_patch"', 'ls apply_patch.md', 'printf "%s" apply_patch']) {
      assertPass(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command })))
    }
  })

  test('ca cũ giữ nguyên: payload thiếu tool_name vẫn kiểm file_path, MultiEdit; tool Bash gửi vào chế độ edit thì qua', () => {
    const fx = fixture()
    assertDeny(hook(fx, 'edit', { cwd: fx.main, tool_input: { file_path: path.join(fx.main, 'a.txt') } }))
    assertDeny(hook(fx, 'edit', { tool_name: 'MultiEdit', cwd: fx.main, tool_input: { file_path: path.join(fx.main, 'a.txt') } }))
    assertPass(hook(fx, 'edit', codexIn(fx.main, 'Bash', { command: 'ls' })))
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

describe('v7 push nhánh chính theo host: ask chỉ cho Claude, Codex/Devin ⇒ deny, user tự chạy lệnh (không có tiền tố tự duyệt)', () => {
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

  test('Claude vẫn nhận ask như cũ', () => {
    const fx = remoteFx()
    assert.match(assertAsk(claudeSh(fx, fx.main, 'git push origin main')), /^Sắp push 2 commit lên origin\/main:\n/)
  })

  test('Codex: deny, mở đầu đời thường nói user tự chạy lệnh, kèm danh sách commit và đúng lệnh push để chép', () => {
    const fx = remoteFx()
    for (const c of ['git push', 'git push origin main', 'git push origin HEAD', 'git push --all origin', 'git push --mirror origin']) {
      const reason = assertDeny(codexSh(fx, fx.main, c))
      assertPlainOpening(reason, c)
      assert.match(reason.split(/\.\s|\n/)[0], /chính bạn chạy lệnh/, c)
      assert.match(reason, /Sắp push 2 commit lên origin\/main:\n[0-9a-f]+ thêm x2\n[0-9a-f]+ thêm x1/, c)
      assert.match(reason, /\ngit push origin main\s*$/, `${c}: phải in đúng lệnh push ở dòng cuối để user chép`)
      assert.doesNotMatch(reason, /FLOW_OK/, c)
    }
  })

  test('Devin (exec) cũng deny như Codex', () => {
    const fx = remoteFx()
    const reason = assertDeny(devinSh(fx, fx.main, 'git push origin main'))
    assertPlainOpening(reason)
    assert.match(reason, /\ngit push origin main\s*$/)
    assert.doesNotMatch(reason, /FLOW_OK/)
  })

  test('tiền tố FLOW_OK=push-main (agent tự viết được) KHÔNG còn tự duyệt: mọi cách viết đều vẫn deny; tiền tố không lách quét secret, push ép, xoá nhánh chính', () => {
    const fx = remoteFx()
    for (const c of ['FLOW_OK=push-main git push origin main', 'FLOW_OK=push-main git push', 'A=1 FLOW_OK=push-main git -C . push origin main', 'echo ok && FLOW_OK=push-main git push origin main',
      'FLOW_OK=other git push origin main', 'FLOW_OK=push-mainx git push origin main', 'FLOW_OK=push-main true && git push origin main', 'echo FLOW_OK=push-main; git push origin main']) {
      assert.doesNotMatch(assertDeny(codexSh(fx, fx.main, c)), /FLOW_OK/, c)
      assertDeny(devinSh(fx, fx.main, c))
    }
    assertDeny(codexSh(fx, fx.main, 'FLOW_OK=push-main git push --force origin main'))
    assertDeny(codexSh(fx, fx.main, 'FLOW_OK=push-main git push origin --delete main'))
    commit(fx.main, 'cfg.js', `const t = "${GHP}"\n`, 'secret')
    assert.match(assertDeny(codexSh(fx, fx.main, 'FLOW_OK=push-main git push origin main')), /cfg\.js:1 — github/)
  })

  // Review lượt 2 (BLOCKER): tên remote lấy nguyên văn từ lệnh/cấu hình của AI; in vào dòng "chép rồi dán" thì `origin; calc` chạy thêm lệnh khi user dán vào terminal.
  test('remote có ký tự shell (; | $( ) ` & > xuống dòng, bắt đầu bằng -, dấu cách) ⇒ deny nhưng KHÔNG in dòng lệnh push; dặn user tự kiểm tên remote trong terminal', () => {
    const fx = remoteFx()
    for (const remote of ['origin; calc', 'o|sh', '$(x)', 'a\nb', 'x`id`', 'o&c', '-bad', 'o r', 'o>f', 'o"q', "o'q"]) {
      const quoted = `"${remote.replace(/"/g, '\\"')}"`
      for (const sh of [codexSh, devinSh]) {
        const reason = assertDeny(sh(fx, fx.main, `git push --repo=${remote.includes('"') ? `'${remote}'` : quoted} main`))
        assertPlainOpening(reason, remote)
        assert.doesNotMatch(reason, /(^|\n)\s*git push\b/, `${JSON.stringify(remote)}: không được in dòng lệnh push`)
        assert.ok(!reason.includes(remote), `${JSON.stringify(remote)}: không được in lại tên remote lạ`)
        assert.match(reason, /remote/i)
        assert.match(reason, /terminal/i)
        assert.match(reason, /Sắp push \d+ commit/, 'vẫn liệt kê commit để user biết')
      }
    }
  })

  test('remote lấy từ cấu hình nhánh (branch.main.remote) có ký tự shell ⇒ cũng không in lệnh; remote sạch có . _ - / vẫn in đúng', () => {
    const fx = remoteFx()
    git(fx.main, 'config', 'branch.main.remote', 'origin; calc')
    const reason = assertDeny(codexSh(fx, fx.main, 'git push'))
    assert.doesNotMatch(reason, /(^|\n)\s*git push\b/)
    assert.ok(!reason.includes('calc'))
    git(fx.main, 'config', '--unset', 'branch.main.remote')
    git(fx.main, 'remote', 'add', 'up-stream_1.x', path.join(fx.root, 'remote.git'))
    assert.match(assertDeny(codexSh(fx, fx.main, 'git push up-stream_1.x main')), /\ngit push up-stream_1\.x main\s*$/)
  })

  test('Claude (ask) không bị đổi: vẫn hỏi, lý do vẫn nêu remote/nhánh', () => {
    const fx = remoteFx()
    assert.match(assertAsk(claudeSh(fx, fx.main, 'git push --repo="o|sh" main')), /^Sắp push \d+ commit lên /)
  })

  test('Claude có tiền tố vẫn bị ask (ask là chốt của user, AI không tự duyệt); đã đồng bộ / nhánh khác main ⇒ qua ở mọi host', () => {
    const fx = remoteFx()
    assertAsk(claudeSh(fx, fx.main, 'FLOW_OK=push-main git push origin main'))
    git(fx.main, 'push', 'origin', 'main')
    assertPass(codexSh(fx, fx.main, 'git push')) // đã đồng bộ
    commit(fx.wt, 'f.go', 'package f\n', 'feat commit')
    assertPass(codexSh(fx, fx.wt, 'git push origin feat'))
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

  test('commit thêm package có vấn đề ⇒ deny: mở đầu đời thường, nêu tên + lý do', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', pkg(BAD))
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m "thêm thư viện"'))
    assertPlainOpening(reason)
    assert.match(reason, /Bad Name!/)
    assert.match(reason, /không phải tên package hợp lệ/)
  })

  test('không có package mới (đổi phiên bản, file khác) ⇒ qua', () => {
    const fx = depsFx({ react: '^19.0.0', zod: '^3.0.0' })
    stage(fx.main, 'package.json', pkg({ react: '^19.1.0' }))
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    git(fx.main, 'reset', '-q')
    stage(fx.main, 'other.txt', 'x\n')
    assertPass(sh(fx, fx.main, 'git commit -m x'))
  })

  test('package nguồn git/URL chưa được duyệt ⇒ deny: mở đầu đời thường, nêu tên + "nguồn ngoài kho chính thức, chưa kiểm chứng" + cách duyệt', () => {
    const fx = depsFx()
    for (const spec of ['git+https://example.invalid/zq.git', 'https://example.invalid/zq.tgz', 'o/r']) {
      stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-internal-lib': spec }))
      const reason = assertDeny(sh(fx, fx.main, 'git commit -m x'))
      assertPlainOpening(reason, spec)
      assert.match(reason, /zq-internal-lib — nguồn ngoài kho chính thức, chưa kiểm chứng/, spec)
      assert.match(reason, /trustedDepSources/, spec)
    }
  })

  // Review lượt 2 (MAJOR): allowlist phải đọc từ bản SẮP COMMIT (index / index tạm), mỗi mục ghim "tên@nguồn" — không đọc đĩa, không chỉ tên.
  const SRC = 'git+https://example.invalid/zq.git'
  const trust = (...entries) => JSON.stringify({ trustedDepSources: entries })

  test('"tên@nguồn" có trong .claude/flow.json ĐÃ STAGE ⇒ nguồn git qua; tên khác trong cùng commit vẫn bị chặn; flow.json hỏng / sai kiểu ⇒ không tin ai', () => {
    const fx = depsFx()
    stage(fx.main, '.claude/flow.json', trust(`zq-internal-lib@${SRC}`))
    stage(fx.main, 'package.json', pkg(GIT_DEP))
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    stage(fx.main, 'package.json', pkg({ ...GIT_DEP, 'zq-other-lib': 'github:o/other' }))
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /zq-other-lib — nguồn ngoài/)
    stage(fx.main, '.claude/flow.json', '{ hỏng')
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /zq-internal-lib — nguồn ngoài/)
    stage(fx.main, '.claude/flow.json', JSON.stringify({ trustedDepSources: `zq-internal-lib@${SRC}` }))
    assertDeny(sh(fx, fx.main, 'git commit -m x'))
  })

  test('flow.json chỉ nằm trên đĩa (chưa git add) KHÔNG có hiệu lực: AI tự ghi allowlist rồi commit package.json vẫn bị chặn; lời chặn chỉ cách ghi đúng "tên@nguồn" + git add', () => {
    const fx = depsFx()
    write(fx.main, '.claude/flow.json', trust(`zq-internal-lib@${SRC}`)) // file mới, chưa stage
    stage(fx.main, 'package.json', pkg(GIT_DEP))
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assert.match(reason, /zq-internal-lib — nguồn ngoài/)
    assert.match(reason, /tên@nguồn/)
    assert.match(reason, /zq-internal-lib@git\+https:\/\/example\.invalid\/zq\.git/, 'ví dụ đúng mục cần ghi cho thư viện đang bị chặn')
    assert.match(reason, /git add/)
  })

  test('mục chỉ có tên (cách cũ) hoặc cùng tên khác nguồn ⇒ vẫn bị chặn; nguồn trong package.json phải y hệt mục đã ghim', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', pkg(GIT_DEP))
    for (const entry of ['zq-internal-lib', `zq-internal-lib@git+https://other.invalid/zq.git`, `zq-internal-lib@${SRC}#abc`, `other-lib@${SRC}`, SRC]) {
      stage(fx.main, '.claude/flow.json', trust(entry))
      assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /zq-internal-lib — nguồn ngoài/, entry)
    }
    const sha = 'a'.repeat(40)
    stage(fx.main, '.claude/flow.json', trust(`zq-internal-lib@${SRC}#${sha}`))
    stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-internal-lib': `${SRC}#${sha}` }))
    assertPass(sh(fx, fx.main, 'git commit -m x'))
    stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-internal-lib': `${SRC}#${'b'.repeat(40)}` })) // đổi sha ⇒ nguồn khác ⇒ phải duyệt lại
    assertDeny(sh(fx, fx.main, 'git commit -m x'))
  })

  test('commit -a / commit <path>: flow.json tính theo bản SẼ nằm trong commit (index tạm), không phải đĩa; git add trong cùng lệnh thì flow.json phải stage từ trước', () => {
    const fx = depsFx()
    commit(fx.main, '.claude/flow.json', JSON.stringify({ tests: 'none' }), 'flow.json')
    write(fx.main, '.claude/flow.json', JSON.stringify({ tests: 'none', trustedDepSources: [`zq-internal-lib@${SRC}`] })) // sửa chưa stage
    stage(fx.main, 'package.json', pkg(GIT_DEP))
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x')), /zq-internal-lib — nguồn ngoài/, 'commit thường: flow.json chưa stage')
    assertDeny(sh(fx, fx.main, 'git commit -m x package.json'))
    assertPass(sh(fx, fx.main, 'git commit -am x'))
    assertPass(sh(fx, fx.main, 'git commit -m x package.json .claude/flow.json'))
    assert.equal(git(fx.main, 'diff', '--cached', '--name-only').trim(), 'package.json', 'cổng không được đụng index thật')
    // `git add …` đứng trước: không đoán được nó add gì ⇒ không tin bản flow.json chưa stage (chọn thừa chặt còn hơn để AI tự duyệt)
    assertDeny(sh(fx, fx.main, 'git add -A && git commit -m x'))
    git(fx.main, 'add', '.claude/flow.json')
    assertPass(sh(fx, fx.main, 'git add package.json && git commit -m x'))
    // flow.json mới (chưa theo dõi, chưa stage): git add -A cùng lệnh cũng không đủ; stage trước thì qua
    const fx2 = depsFx()
    write(fx2.main, '.claude/flow.json', trust(`zq-internal-lib@${SRC}`))
    write(fx2.main, 'package.json', pkg(GIT_DEP))
    assertDeny(sh(fx2, fx2.main, 'git add -A && git commit -m x'))
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

  // Review lượt 2 (MAJOR): ask (push nhánh chính) cùng lệnh với commit thư viện chưa kiểm được — lời nhắc unknown không được rơi mất.
  test('commit thư viện chưa kiểm được + push nhánh chính trong MỘT lệnh ⇒ Claude nhận ask KÈM additionalContext về thư viện chưa kiểm, và hộp hỏi nói rõ có thư viện chưa kiểm; Codex ⇒ deny', () => {
    const fx = depsFx()
    const bare = path.join(fx.root, 'remote.git')
    git(fx.root, 'init', '--bare', '-b', 'main', bare)
    git(fx.main, 'remote', 'add', 'origin', bare)
    git(fx.main, 'push', '-u', 'origin', 'main')
    commit(fx.main, 'x1.txt', 'x\n', 'thêm x1')
    stage(fx.main, 'package.json', pkg({ react: '^19.0.0', 'zq-unique-pkg-9': '1.0.0' }))
    const r = sh(fx, fx.main, 'git commit -m x && git push origin main', { FLOW_GATE_DEPS_MS: '1' })
    const reason = assertAsk(r)
    assert.match(reason, /^Sắp push 1 commit lên origin\/main:/)
    assert.match(reason, /thư viện mới chưa kiểm được/i, 'user thấy trong hộp hỏi')
    const ctx = r.json.hookSpecificOutput.additionalContext
    assert.match(ctx, /chưa kiểm được/i)
    assert.match(ctx, /npm zq-unique-pkg-9/)
    assert.match(ctx, /báo user/i)
    const codex = hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: 'git commit -m x && git push origin main' }), { FLOW_GATE_DEPS_MS: '1' })
    assertDeny(codex)
    // không có thư viện chưa kiểm ⇒ ask như cũ, không thêm gì
    git(fx.main, 'reset', '-q')
    const plain = sh(fx, fx.main, 'git commit -m x && git push origin main')
    assert.equal(assertAsk(plain).includes('chưa kiểm được'), false)
    assert.equal(plain.json.hookSpecificOutput.additionalContext, undefined)
  })

  test('package.json mới hỏng ⇒ newPackages ném ⇒ deny kèm lý do (không cho qua)', () => {
    const fx = depsFx()
    stage(fx.main, 'package.json', '{ không phải json')
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assertPlainOpening(reason)
    assert.match(reason, /package\.json/)
  })

  test('go.mod: module mới có vấn đề ⇒ deny', () => {
    const fx = fixture()
    commit(fx.main, 'go.mod', 'module example.com/x\n\ngo 1.22\n', 'go.mod')
    stage(fx.main, 'go.mod', 'module example.com/x\n\ngo 1.22\n\nrequire example.com/Bad%20Name v1.0.0\n')
    const reason = assertDeny(sh(fx, fx.main, 'git commit -m x'))
    assert.match(reason, /Bad%20Name/)
  })

  test('commit -a, commit <path>, git add … && git commit: tính cả package.json chưa stage (nội dung thật của commit)', () => {
    const fx = depsFx()
    write(fx.main, 'package.json', pkg(BAD)) // sửa chưa stage
    write(fx.main, 'other.txt', 'x\n')
    assertPass(sh(fx, fx.main, 'git commit -m x')) // không có gì staged
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -am x')), /Bad Name!/)
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -a -m x')), /Bad Name!/)
    assert.match(assertDeny(sh(fx, fx.main, 'git commit -m x package.json')), /Bad Name!/)
    assert.match(assertDeny(sh(fx, fx.main, 'git add -A && git commit -m x')), /Bad Name!/)
    assert.match(assertDeny(sh(fx, fx.main, 'git add package.json; git commit -m x')), /Bad Name!/)
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
    assert.match(assertDeny(hook(fx, 'bash', bashIn(root, 'git commit -m first'))), /Bad Name!/)
  })
})

describe('v7 AC-24: lời chặn mở đầu bằng một câu đời thường', () => {
  const sh = (fx, cwd, command) => hook(fx, 'bash', bashIn(cwd, command))
  const stage = (dir, rel, content) => { write(dir, rel, content); git(dir, 'add', '--', rel) }

  test('sửa thẳng thư mục chính / gộp thiếu dấu / push ép / xoá nhánh chính / lệnh phá huỷ / secret', () => {
    const fx = fixture()
    assertPlainOpening(assertDeny(hook(fx, 'edit', { tool_name: 'Edit', cwd: fx.main, tool_input: { file_path: path.join(fx.main, 'a.txt') } })), 'edit')
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    assertPlainOpening(assertDeny(sh(fx, fx.main, 'git merge feat')), 'merge')
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

  test('Stop nhắc thiếu dấu / thiếu receipt / audit phạm vi làn / lane-check lỗi', () => {
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
    assertPlainOpening(assertBlock(hook(fx, 'subagent-stop', sub({ last_assistant_message: receipt, agent_transcript_path: mk('t2.jsonl', `plan=${plan} lane=Z`) }))), 'audit lỗi')
  })
})

describe('v7 AC-09: lane-check không chạy được ⇒ block, không cho qua âm thầm', () => {
  const jsonl = (fx, name, entries) => write(fx.root, name, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const sub = (fx, transcript, extra = {}) => ({
    hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a1', agent_type: 'coder', cwd: fx.wt,
    last_assistant_message: 'return=done; paths=feat.go; checks=ok; blocker=; stop', agent_transcript_path: transcript, ...extra,
  })

  test('lời chặn nêu lý do thật của lane-check + cách xử lý; stop_hook_active ⇒ vẫn cho qua (không lặp vô hạn)', () => {
    const fx = fixture()
    commit(fx.wt, 'feat.go', 'package x\n', 'feat')
    const t = jsonl(fx, 'tx.jsonl', [{ type: 'user', message: { role: 'user', content: `outcome=x\nplan=${path.join(fx.root, 'khong-co.md')} lane=A` } }])
    const reason = assertBlock(hook(fx, 'subagent-stop', sub(fx, t)))
    assertPlainOpening(reason)
    assert.match(reason, /không kiểm được phạm vi làn A vì /)
    assert.match(reason, /chạy lại với --repo đúng hoặc báo captain/)
    assert.match(fs.readFileSync(fx.log, 'utf8'), /lane-check audit lane A/)
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

describe('ghi nội dung file qua lệnh shell ⇒ chặn, dặn dùng Write/Edit (bộ lọc an toàn của app bật hộp hỏi user)', () => {
  const HD = '<' + '<'
  const mustDeny = [
    `cat > notes.md ${HD}'EOF'\nxin chào\nEOF`,
    `cat ${HD}'EOF' > notes.md\nxin chào\nEOF`,
    `cd x && cat >> a.txt ${HD}EOF\nnội dung\nEOF`,
    `tee out.md ${HD}EOF\nnội dung\nEOF`,
    'echo "- [ghi nhớ](x.md)" >> MEMORY.md',
    "printf 'a\\nb\\n' > file.txt",
    "sed -i 's|^dòng$|dòng\\nthêm dòng|' agents/coder.md",
    'node -e "require(\'fs\').writeFileSync(\'a.txt\', \'x\')"',
    `node - ${HD}'EOF'\nconst fs=require('fs');fs.writeFileSync('a','b')\nEOF`,
    'python -c "open(\'a.txt\',\'w\').write(\'x\')"',
  ]
  const mustPass = [
    'node --test hooks/x.test.mjs > /tmp/out.txt 2>&1',
    `git commit -q -F - ${HD}'EOF'\nthông điệp\nEOF`,
    `cat ${HD}'EOF' | wc -l\nabc\nEOF`,
    'echo EXIT=$?',
    'echo hi > /dev/null',
    'echo lỗi >&2',
    "sed -i 's/a/b/' file.txt",
    "printf '%s\\0' a b | xargs -0 ls",
    'node -e "console.log(1)"',
    'ls > list.txt',
  ]
  for (const command of mustDeny) {
    test(`chặn: ${command.split('\n')[0]}`, () => {
      const fx = fixture()
      const reason = assertDeny(hook(fx, 'bash', bashIn(fx.root, command)))
      assert.match(reason, /Write\/Edit/)
      assertPlainOpening(reason, command)
    })
  }
  for (const command of mustPass) {
    test(`không chặn: ${command.split('\n')[0]}`, () => {
      const fx = fixture()
      const r = hook(fx, 'bash', bashIn(fx.root, command))
      assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined, r.stdout)
    })
  }
  test('Codex ⇒ dặn dùng apply_patch', () => {
    const fx = fixture()
    const reason = assertDeny(hook(fx, 'bash', codexIn(fx.root, 'Bash', { command: 'echo x > a.txt' })))
    assert.match(reason, /apply_patch/)
  })
})

describe('xoá cả thư mục qua lệnh shell ⇒ chặn, dặn tạo thư mục mới; thật sự cần xoá thì hỏi user', () => {
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
      assertPlainOpening(reason, command)
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

// ======================================================================================================
// Đợt 2 (làn C): cổng gộp chống lách — file luật, dòng tắt luật, chép repo "chỉ học" ([j21n], AC-45, AC-37)
// ======================================================================================================

describe('đợt 2: cổng gộp chống lách (file luật, dòng tắt luật, chép repo chỉ-học)', () => {
  const claudeSh = (fx, cwd, command, env) => hook(fx, 'bash', bashIn(cwd, command), env)
  const codexSh = (fx, cwd, command, env) => hook(fx, 'bash', codexIn(cwd, 'Bash', { command }), env)
  const devinSh = (fx, cwd, command, env) => hook(fx, 'bash', devinIn(cwd, 'exec', { command }), env)
  const MERGE = 'git merge feat'

  // Nhánh feat (worktree wt) có một commit chạm các file trong `feat` ({ đường dẫn: nội dung | null = xoá }); `main` = file đã có ở nhánh chính
  // trước khi feat tách ra. Đóng đủ review + qa + test, nên chỉ còn cổng chống lách quyết định.
  function ruleFx({ main = {}, feat = {} } = {}) {
    const fx = fixture()
    if (Object.keys(main).length > 0) {
      for (const [rel, text] of Object.entries(main)) write(fx.main, rel, text)
      git(fx.main, 'add', '-A')
      git(fx.main, 'commit', '-m', 'file có sẵn')
      git(fx.wt, 'merge', '--ff-only', 'main')
    }
    for (const [rel, text] of Object.entries(feat)) {
      if (text === null) git(fx.wt, 'rm', '-q', '--', rel)
      else write(fx.wt, rel, text)
    }
    git(fx.wt, 'add', '-A')
    git(fx.wt, 'commit', '-m', 'feat')
    stampBoth(fx)
    return fx
  }

  const RULE_SETS = [
    ['docs/arch.json', 'docs/arch-baseline.json', '.dependency-cruiser.cjs', '.dependency-cruiser-known-violations.json', '.go-arch-lint.yml', '.golangci.yml', '.golangci.yaml', 'kit/rules/no-foo.yml'],
    ['eslint.config.js', 'eslint.config.mjs', '.eslintrc.json', '.eslintrc', 'biome.json', 'biome.jsonc', 'sgconfig.yml', 'web/eslint.config.ts'],
  ]
  for (const files of RULE_SETS) {
    test(`thêm file luật (${files[0]}, ${files[4]}…) ⇒ Claude: ask liệt kê từng file; Codex/Devin: deny, user tự chạy lệnh gộp`, () => {
      const fx = ruleFx({ feat: Object.fromEntries(files.map((f) => [f, '{}\n'])) })
      const ask = assertAsk(claudeSh(fx, fx.main, MERGE))
      assertPlainOpening(ask)
      for (const f of files) assert.ok(ask.includes(f), `${f} phải có trong lời hỏi: ${ask}`)
      for (const sh of [codexSh, devinSh]) {
        const reason = assertDeny(sh(fx, fx.main, MERGE))
        assertPlainOpening(reason)
        assert.match(reason.split(/\.\s|\n/)[0], /chính bạn chạy lệnh/)
        for (const f of files) assert.ok(reason.includes(f), `${f} phải có trong lý do: ${reason}`)
        assert.match(reason, /\ngit merge feat\s*$/, 'in đúng lệnh gộp ở dòng cuối để user chép')
      }
    })
  }

  // Review đợt 2 (Codex :790, Grok :679): cấu hình điều khiển cổng/checker cũng là file luật; @ts-nocheck / squawk-ignore / # type: ignore cũng tắt luật.
  test('thêm .claude/flow.json (miễn test, uiPattern, trustedDepSources, prodRefs) và kit/checkers.json ⇒ Claude: ask liệt kê từng file; Codex/Devin: deny', () => {
    const files = ['.claude/flow.json', 'kit/checkers.json']
    const fx = ruleFx({ feat: Object.fromEntries(files.map((f) => [f, '{}\n'])) })
    const ask = assertAsk(claudeSh(fx, fx.main, MERGE))
    assertPlainOpening(ask)
    for (const f of files) assert.ok(ask.includes(f), `${f} phải có trong lời hỏi: ${ask}`)
    for (const sh of [codexSh, devinSh]) {
      const reason = assertDeny(sh(fx, fx.main, MERGE))
      assertPlainOpening(reason)
      assert.match(reason.split(/\.\s|\n/)[0], /chính bạn chạy lệnh/)
      for (const f of files) assert.ok(reason.includes(f), `${f} phải có trong lý do: ${reason}`)
      assert.match(reason, /\ngit merge feat\s*$/)
    }
  })

  for (const [file, before, after] of [
    ['.claude/flow.json', '{"tests":"auto"}\n', '{"tests":"none"}\n'],
    ['kit/checkers.json', '{"checkers":[{"id":"sast-ast-grep"}]}\n', '{"checkers":[]}\n'],
  ]) {
    test(`sửa ${file} có sẵn / xoá nó ⇒ ask`, () => {
      const main = { [file]: before, 'x.js': 'a\n' }
      const edit = ruleFx({ main, feat: { [file]: after } })
      assert.match(assertAsk(claudeSh(edit, edit.main, MERGE)), new RegExp(`sửa.*${file.replace(/[.]/g, '\\.')}`))
      const del = ruleFx({ main, feat: { [file]: null } })
      assert.match(assertAsk(claudeSh(del, del.main, MERGE)), new RegExp(`xoá.*${file.replace(/[.]/g, '\\.')}`))
      assertDeny(codexSh(edit, edit.main, MERGE))
    })
  }

  test('thêm @ts-nocheck / squawk-ignore / # type: ignore ⇒ Claude: ask kèm file:dòng; Codex/Devin: deny', () => {
    const fx = ruleFx({ feat: {
      'src/n.ts': '// @ts-nocheck\nconst n: number = "x"\n',
      'src/n.js': 'let ok = 1\n/* @ts-nocheck */\n',
      'db/001.sql': 'select 1;\n-- squawk-ignore ban-drop-column\nalter table t drop column c;\n',
      'db/002.sql': '-- squawk-ignore-file\nalter table t add column d int;\n',
      'app/p.py': 'x: int = "s"  # type: ignore\n',
      'app/q.py': 'import foo  # type: ignore[import]\n',
    } })
    const ask = assertAsk(claudeSh(fx, fx.main, MERGE))
    assertPlainOpening(ask)
    for (const at of ['src/n.ts:1', 'src/n.js:2', 'db/001.sql:2', 'db/002.sql:1', 'app/p.py:1', 'app/q.py:1']) assert.ok(ask.includes(at), `${at} phải có trong lời hỏi: ${ask}`)
    for (const what of ['@ts-nocheck', 'squawk-ignore', '# type: ignore']) assert.ok(ask.includes(`(${what})`), `${what} phải được gọi tên: ${ask}`)
    for (const sh of [codexSh, devinSh]) {
      const reason = assertDeny(sh(fx, fx.main, MERGE))
      assertPlainOpening(reason)
      assert.ok(reason.includes('src/n.ts:1') && reason.includes('app/q.py:1'))
    }
  })

  test('nhắc @ts-nocheck / squawk-ignore / # type: ignore trong tài liệu .md, hoặc XOÁ chúng ⇒ qua, không hỏi', () => {
    const fx = ruleFx({ feat: { 'docs/note.md': 'Đừng dùng @ts-nocheck, -- squawk-ignore hay # type: ignore.\n' } })
    assertPass(claudeSh(fx, fx.main, MERGE))
    const del = ruleFx({ main: { 'src/old.ts': '// @ts-nocheck\nlet a = 1\n', 'app/o.py': 'a = 1  # type: ignore\n' }, feat: { 'src/old.ts': 'let a = 1\n', 'app/o.py': 'a = 1\n' } })
    assertPass(claudeSh(del, del.main, MERGE))
    assertPass(codexSh(del, del.main, MERGE))
  })

  test('sửa / xoá / đổi tên đi file luật có sẵn ⇒ ask', () => {
    const main = { 'eslint.config.js': 'export default []\n', 'biome.json': '{}\n', 'x.js': 'a\n' }
    const edit = ruleFx({ main, feat: { 'eslint.config.js': 'export default [{ rules: {} }]\n' } })
    assert.match(assertAsk(claudeSh(edit, edit.main, MERGE)), /sửa.*eslint\.config\.js/)
    const del = ruleFx({ main, feat: { 'biome.json': null } })
    assert.match(assertAsk(claudeSh(del, del.main, MERGE)), /xoá.*biome\.json/)
    const mv = ruleFx({ main, feat: { 'eslint.config.js': null, 'eslint.old.js': 'export default []\n' } })
    assert.match(assertAsk(claudeSh(mv, mv.main, MERGE)), /xoá.*eslint\.config\.js/)
  })

  test('nới trần cỡ file trong docs/arch.json ⇒ lời hỏi nêu trần cũ và mới; siết thì nói siết (vẫn hỏi)', () => {
    const arch = (n) => JSON.stringify({ version: 1, parts: [{ name: 'web', stack: 'web', root: 'src', limits: { fileLines: n, fnLines: 60 } }] }, null, 2) + '\n'
    const loose = ruleFx({ main: { 'docs/arch.json': arch(400) }, feat: { 'docs/arch.json': arch(600) } })
    assert.match(assertAsk(claudeSh(loose, loose.main, MERGE)), /nới trần cỡ file.*400.*600/)
    const tight = ruleFx({ main: { 'docs/arch.json': arch(400) }, feat: { 'docs/arch.json': arch(300) } })
    assert.match(assertAsk(claudeSh(tight, tight.main, MERGE)), /siết trần cỡ file.*400.*300/)
  })

  test('thêm dòng tắt luật ⇒ ask kèm file:dòng; mọi loại tắt luật đều bị bắt; Codex/Devin deny', () => {
    const fx = ruleFx({ feat: {
      'src/a.ts': '// eslint-disable-next-line no-console\nconsole.log(1)\n',
      'src/b.ts': 'const b = 1\n// @ts-ignore\nconst c: number = "x"\n',
      'src/c.ts': '/* @ts-expect-error */\nconst c: number = "x"\n',
      'src/d.go': 'package d\n\n//nolint:errcheck\nfunc d() {}\n',
      'src/e.ts': '// biome-ignore lint/suspicious/noExplicitAny: cần any\nlet e: any\n',
      'src/f.py': 'import os  # noqa: F401\n',
      'src/g.ts': 'let g = 1\n// ast-grep-ignore\n',
    } })
    const ask = assertAsk(claudeSh(fx, fx.main, MERGE))
    assertPlainOpening(ask)
    for (const at of ['src/a.ts:1', 'src/b.ts:2', 'src/c.ts:1', 'src/d.go:3', 'src/e.ts:1', 'src/f.py:1', 'src/g.ts:2']) assert.ok(ask.includes(at), `${at} phải có trong lời hỏi: ${ask}`)
    assert.match(ask, /tắt luật/)
    for (const sh of [codexSh, devinSh]) {
      const reason = assertDeny(sh(fx, fx.main, MERGE))
      assertPlainOpening(reason)
      assert.ok(reason.includes('src/a.ts:1') && reason.includes('src/g.ts:2'))
    }
  })

  test('tắt luật có kèm lý do, nhắc trong tài liệu .md, hoặc XOÁ dòng tắt luật ⇒ qua như cũ, không hỏi', () => {
    const fx = ruleFx({ feat: {
      'src/ok.ts': '// @ts-expect-error: mock thiếu trường id\nconst x: number = "x"\n',
      'docs/note.md': 'Đừng dùng // eslint-disable hay @ts-ignore.\n',
    } })
    assertPass(claudeSh(fx, fx.main, MERGE))
    assertPass(codexSh(fx, fx.main, MERGE))
    const del = ruleFx({ main: { 'src/old.ts': '// eslint-disable-next-line\nlet a = 1\n// @ts-ignore\nlet b = 2\n' }, feat: { 'src/old.ts': 'let a = 1\nlet b = 2\n' } })
    assertPass(claudeSh(del, del.main, MERGE))
    assertPass(codexSh(del, del.main, MERGE))
  })

  test('không lách được: dòng thêm bắt đầu bằng "++ " không làm đọc nhầm tên file; .gitattributes -diff không giấu được diff', () => {
    const fx = ruleFx({ feat: { 'src/h.ts': 'let h = 1\n++ eslint-disable\n' } })
    assert.match(assertAsk(claudeSh(fx, fx.main, MERGE)), /src\/h\.ts:2/)
    const attr = ruleFx({ main: { '.gitattributes': '*.ts -diff\n' }, feat: { 'src/i.ts': '// eslint-disable\nlet i = 1\n' } })
    assert.match(assertAsk(claudeSh(attr, attr.main, MERGE)), /src\/i\.ts:1/)
  })

  // QA B3: mọi đường đưa commit của nhánh khác vào nhánh chính (không chỉ `git merge`) đều qua đúng cổng gộp: dấu review/qa/test, nới luật, chép chỉ-học.
  const ENTRY_COMMANDS = [
    'git pull . TARGET', 'git pull --no-rebase . TARGET', 'git pull --rebase . TARGET', 'git pull --ff-only --no-edit . refs/heads/TARGET',
    'git cherry-pick TARGET', 'git cherry-pick -x TARGET', 'git cherry-pick main..TARGET',
    'git rebase TARGET', 'git rebase --onto TARGET main',
    'git fetch . TARGET:main', 'git fetch --update-head-ok . +TARGET:refs/heads/main',
    'git push . TARGET:main', 'git push . TARGET:refs/heads/main',
    'git branch -f main TARGET', 'git branch --force main TARGET', 'git branch -C TARGET main',
    'git update-ref refs/heads/main TARGET', 'git update-ref -m dua-vao refs/heads/main TARGET',
    'git checkout -B main TARGET', 'git switch -C main TARGET', 'git switch --force-create main TARGET',
  ]
  // mỗi lệnh một đại diện (Codex/Devin chạy nhánh xử lý giống nhau nên không cần đủ biến thể: mỗi hook chạy ~0,8 s)
  const ENTRY_FORMS = [
    'git pull --rebase . TARGET', 'git cherry-pick -x TARGET', 'git rebase --onto TARGET main', 'git fetch --update-head-ok . +TARGET:refs/heads/main', 'git push . TARGET:refs/heads/main',
    'git branch -C TARGET main', 'git update-ref -m dua-vao refs/heads/main TARGET', 'git checkout -B main TARGET', 'git switch --force-create main TARGET',
  ]
  const entry = (cmd, target) => cmd.replaceAll('TARGET', target)

  test('B3: nhánh chưa đóng dấu đưa vào main bằng pull/cherry-pick/rebase/fetch/push/branch -f/update-ref/checkout -B/switch -C ⇒ deny thiếu dấu (mọi host)', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    addBranch(fx, 'bare') // không có dấu nào
    for (const c of ENTRY_COMMANDS) {
      const cmd = entry(c, 'bare')
      for (const sh of ENTRY_FORMS.includes(c) ? [claudeSh, codexSh, devinSh] : [claudeSh]) {
        const reason = assertDeny(sh(fx, fx.main, cmd))
        assertPlainOpening(reason, cmd)
        assert.match(reason, /bare: thiếu review, qa, test/, cmd)
      }
    }
  })

  test('B3: đủ dấu nhưng nhánh nới luật ⇒ Claude: ask kèm file; Codex/Devin: deny và in đúng lệnh user tự chạy ở dòng cuối', () => {
    const fx = ruleFx({ feat: { 'eslint.config.js': 'export default []\n' } })
    for (const c of ENTRY_COMMANDS) {
      const cmd = entry(c, 'feat')
      const ask = assertAsk(claudeSh(fx, fx.main, cmd))
      assertPlainOpening(ask, cmd)
      assert.match(ask, /eslint\.config\.js/, cmd)
      for (const sh of ENTRY_FORMS.includes(c) ? [codexSh] : []) {
        const reason = assertDeny(sh(fx, fx.main, cmd))
        assertPlainOpening(reason, cmd)
        assert.ok(reason.trimEnd().endsWith(`\n${cmd}`), `${cmd}: dòng cuối phải là lệnh gốc, nhận: ${reason.slice(-80)}`)
      }
    }
    const reason = assertDeny(devinSh(fx, fx.main, 'git cherry-pick feat'))
    assert.ok(reason.trimEnd().endsWith('\ngit cherry-pick feat'), reason.slice(-80))
  })

  test('B3: đủ dấu và sạch ⇒ qua như cũ, kể cả khi lệnh chạy từ worktree của nhánh khác (đích vẫn là main)', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    for (const c of ENTRY_COMMANDS) assertPass(claudeSh(fx, fx.main, entry(c, 'feat')))
    // cổng theo ĐÍCH: nhánh đang đứng là feat nhưng ref bị đổi là main ⇒ vẫn kiểm
    addBranch(fx, 'bare')
    for (const c of ['git fetch . TARGET:main', 'git push . TARGET:main', 'git branch -f main TARGET', 'git update-ref refs/heads/main TARGET', 'git checkout -B main TARGET', 'git switch -C main TARGET']) {
      assertPass(claudeSh(fx, fx.wt, entry(c, 'feat')))
      assert.match(assertDeny(claudeSh(fx, fx.wt, entry(c, 'bare'))), /bare: thiếu/, c)
    }
  })

  test('B3: pull/cherry-pick/rebase chỉ gác khi đang đứng ở main; ở nhánh khác ⇒ qua', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    addBranch(fx, 'bare')
    for (const c of ['git pull . bare', 'git cherry-pick bare', 'git rebase bare', 'git rebase --onto bare main']) assertPass(claudeSh(fx, fx.wt, c))
  })

  test('B3: lệnh bình thường không vướng — pull/fetch từ remote nhánh chính, đổi ref nhánh khác, tiếp tục/huỷ cherry-pick/rebase', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    addBranch(fx, 'bare')
    for (const c of [
      'git pull', 'git pull origin', 'git pull origin main', 'git pull --rebase origin master', 'git pull --ff-only origin refs/heads/main', 'git pull . main',
      'git fetch', 'git fetch origin', 'git fetch --all --prune', 'git fetch origin main:main', 'git fetch . bare', 'git fetch . bare:other',
      'git push . bare:other', 'git push origin bare', 'git update-ref refs/heads/other bare', 'git update-ref -d refs/heads/other',
      'git branch other bare', 'git branch -f other bare', 'git branch -C bare other', 'git checkout -b fresh bare', 'git checkout -B other bare', 'git switch -c fresh bare', 'git switch -C other bare',
      'git cherry-pick --continue', 'git cherry-pick --abort', 'git cherry-pick --quit', 'git rebase --abort', 'git rebase --continue', 'git rebase', 'git rebase bare other',
    ]) assertPass(claudeSh(fx, fx.main, c))
  })

  test('B3: pull/fetch từ remote một nhánh KHÁC main (nội dung chưa biết khi chưa fetch) ⇒ deny, dặn fetch rồi merge', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    for (const c of ['git pull origin feat', 'git pull origin refs/heads/feat', 'git pull --rebase origin feat', 'git pull https://example.com/x.git feat', 'git fetch origin feat:main', 'git fetch origin +feat:refs/heads/main']) {
      for (const sh of [claudeSh, codexSh, devinSh]) {
        const reason = assertDeny(sh(fx, fx.main, c))
        assertPlainOpening(reason, c)
        assert.match(reason, /git fetch/, c)
        assert.match(reason, /git merge/, c)
      }
    }
  })

  test('B3: không xác định được nhánh/commit sắp đưa vào ⇒ deny (fail closed)', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    for (const [c, shown] of [
      ['git pull . ghost', 'ghost'], ['git cherry-pick ghost', 'ghost'], ['git rebase ghost', 'ghost'], ['git fetch . ghost:main', 'ghost'],
      ['git branch -f main ghost', 'ghost'], ['git update-ref refs/heads/main ghost', 'ghost'], ['git checkout -B main ghost', 'ghost'], ['git cherry-pick $SHA', 'SHA'],
    ]) {
      for (const sh of [claudeSh, codexSh]) {
        const reason = assertDeny(sh(fx, fx.main, c))
        assertPlainOpening(reason, c)
        assert.match(reason, new RegExp(shown), c)
      }
    }
    assert.match(assertDeny(claudeSh(fx, fx.main, 'git update-ref --stdin')), /stdin/)
    assertPass(claudeSh(fx, fx.main, 'git update-ref -d refs/heads/other'))
  })

  test('B3: đổi ref bằng HEAD hoặc không chỉ nguồn — `update-ref HEAD x` đứng ở main, `checkout -B main` / `branch -f main` mặc định lấy HEAD', () => {
    const fx = ruleFx({ feat: { 'eslint.config.js': 'export default []\n' } })
    addBranch(fx, 'bare')
    assert.match(assertDeny(claudeSh(fx, fx.main, 'git update-ref HEAD bare')), /bare: thiếu/)
    assertPass(claudeSh(fx, fx.wt, 'git update-ref HEAD bare')) // HEAD ở đây là feat, không phải main
    assert.match(assertAsk(claudeSh(fx, fx.wt, 'git checkout -B main')), /eslint\.config\.js/) // main sẽ thành feat (HEAD của worktree)
    assert.match(assertAsk(claudeSh(fx, fx.wt, 'git branch -f main')), /eslint\.config\.js/)
    assertPass(claudeSh(fx, fx.main, 'git checkout -B main')) // HEAD = main: không đổi gì
  })

  // Review lượt 2 (Grok, review-delta.json): cùng một cổng cho mọi cách viết — từ worktree khác, cụm cờ ngắn, refspec nguồn rỗng, remote là chính repo này.
  test('B3b: pull/fetch có refspec ĐÍCH main chạy từ worktree khác (không đứng ở main) vẫn qua cổng gộp', () => {
    const fx = ruleFx({ feat: { 'eslint.config.js': 'export default []\n' } })
    addBranch(fx, 'bare')
    for (const c of ['git pull . bare:main', 'git pull --no-rebase . +bare:refs/heads/main', 'git pull --rebase . bare:refs/heads/main']) {
      assert.match(assertDeny(claudeSh(fx, fx.wt, c)), /bare: thiếu review, qa, test/, c)
    }
    const c = 'git pull . feat:main'
    assert.match(assertAsk(claudeSh(fx, fx.wt, c)), /eslint\.config\.js/)
    assert.ok(assertDeny(codexSh(fx, fx.wt, c)).trimEnd().endsWith(`\n${c}`))
    assert.match(assertDeny(claudeSh(fx, fx.wt, 'git pull origin feat:main')), /git fetch/) // remote khác: nội dung chưa biết
    assertPass(claudeSh(fx, fx.wt, 'git pull origin main:main')) // đồng bộ main với main của remote
    assertPass(claudeSh(fx, fx.wt, 'git pull . bare:other')) // đích không phải main, đang không ở main: main không đổi
    const clean = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    assertPass(claudeSh(clean, clean.wt, 'git pull . feat:main'))
  })

  test('B3b: rebase <upstream> main chạy từ nơi khác main cũng qua cổng (rebase nhánh khác thì không)', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    addBranch(fx, 'bare')
    for (const [cwd, c] of [[fx.wt, 'git rebase bare main'], [fx.main, 'git rebase bare main'], [fx.wt, 'git rebase --onto bare feat main'], [fx.wt, 'git rebase -f bare main']]) {
      assert.match(assertDeny(claudeSh(fx, cwd, c)), /bare: thiếu/, c)
    }
    assertPass(claudeSh(fx, fx.wt, 'git rebase feat main')) // đích đủ dấu, sạch
    assertPass(claudeSh(fx, fx.wt, 'git rebase bare feat')) // dời nhánh feat, không phải main
  })

  test('B3b: cụm cờ ngắn -fB / -fBmain / -qC / -qCmain vẫn nhận ra là đặt lại nhánh main', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    addBranch(fx, 'bare')
    for (const c of ['git checkout -fB main bare', 'git checkout -fBmain bare', 'git checkout -Bmain bare', 'git checkout -qfB main bare', 'git switch -qC main bare', 'git switch -qCmain bare', 'git switch -fC main bare']) {
      assert.match(assertDeny(claudeSh(fx, fx.main, c)), /bare: thiếu/, c)
    }
    for (const c of ['git checkout -fb fresh bare', 'git checkout -fB other bare', 'git checkout -f feat', 'git switch -qc fresh bare', 'git switch -qCother bare', 'git switch -d bare']) {
      assertPass(claudeSh(fx, fx.main, c))
    }
  })

  test('B3b: pull/fetch refspec nguồn rỗng đích main (`:main`, `:refs/heads/main`) ⇒ deny, như push :main', () => {
    const fx = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    for (const c of ['git pull . :main', 'git pull . :refs/heads/main', 'git pull . +:main', 'git fetch . :main', 'git fetch origin :refs/heads/main']) {
      for (const sh of [claudeSh, codexSh]) {
        const reason = assertDeny(sh(fx, fx.main, c))
        assertPlainOpening(reason, c)
        assert.match(reason, /nhánh chính/, c)
      }
    }
    assert.match(assertDeny(claudeSh(fx, fx.wt, 'git pull . :main')), /nhánh chính/) // chạy từ worktree khác cũng vậy
    for (const c of ['git pull . :other', 'git fetch . :other', 'git fetch origin']) assertPass(claudeSh(fx, fx.main, c))
  })

  test('B3b: push/pull/fetch vào CHÍNH repo này viết bằng ./, .\\, đường dẫn, .git, worktree khác, file://, tên remote trỏ vào repo ⇒ luôn qua cổng gộp', () => {
    const fx = ruleFx({ feat: { 'eslint.config.js': 'export default []\n' } })
    addBranch(fx, 'bare')
    git(fx.main, 'remote', 'add', 'self', fx.main)
    const fwd = (p) => p.replace(/\\/g, '/')
    for (const r of ['./', '.\\', fwd(fx.main), fwd(path.join(fx.main, '.git')), fwd(fx.wt), pathToFileURL(fx.main).href, 'self']) {
      const c = `git push ${r} TARGET:main`
      assert.match(assertDeny(claudeSh(fx, fx.main, entry(c, 'bare'))), /bare: thiếu review/, c)
      assert.match(assertAsk(claudeSh(fx, fx.main, entry(c, 'feat'))), /eslint\.config\.js/, c)
    }
    assert.match(assertDeny(claudeSh(fx, fx.main, 'git pull ./ bare')), /bare: thiếu/)
    assert.match(assertDeny(claudeSh(fx, fx.wt, `git fetch ${fwd(fx.main)} bare:main`)), /bare: thiếu/)
    // repo KHÁC (đường dẫn không phải repo này) vẫn là push thường lên nhánh chính: hộp hỏi push
    assert.match(assertAsk(claudeSh(fx, fx.main, `git push ${fwd(fx.root)} bare:main`)), /Sắp push/)
    const clean = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    assertPass(claudeSh(clean, clean.main, 'git push ./ feat:main'))
  })

  test('Q4: đứng ở main (HEAD = main), thay đổi chỉ có trên nhánh sắp gộp vẫn bị thấy, kể cả khi main đã đi tiếp', () => {
    const fx = ruleFx({ feat: { 'eslint.config.js': 'export default []\n' } })
    commit(fx.main, 'main-only.txt', 'x\n', 'main đi tiếp')
    assert.equal(git(fx.main, 'diff', '--name-only', 'main...HEAD').trim(), '', 'diff base...HEAD khi HEAD = main là rỗng — cách kiểm cũ không thấy gì')
    assert.match(assertAsk(claudeSh(fx, fx.main, MERGE)), /eslint\.config\.js/)
  })

  test('không có gì đáng hỏi ⇒ như cũ (qua); thiếu dấu vẫn deny trước, kể cả khi nhánh cũng nới luật', () => {
    const clean = ruleFx({ feat: { 'src/ok.go': 'package ok\n' } })
    assertPass(claudeSh(clean, clean.main, MERGE))
    assertPass(codexSh(clean, clean.main, MERGE))
    const fx = fixture()
    commit(fx.wt, 'eslint.config.js', 'export default []\n', 'feat') // chưa đóng dấu
    const reason = assertDeny(claudeSh(fx, fx.main, MERGE))
    assert.match(reason, /thiếu review, qa/)
    assert.doesNotMatch(reason, /eslint/)
  })

  test('nhiều nhánh: ask nêu đúng nhánh có nới luật; thiếu dấu ở nhánh khác ⇒ deny thắng ask', () => {
    const fx = ruleFx({ feat: { 'eslint.config.js': 'export default []\n' } })
    const wtB = addBranch(fx, 'featB')
    stampBoth(fx, { cwd: wtB })
    const ask = assertAsk(claudeSh(fx, fx.main, 'git merge featB feat'))
    assert.match(ask, /\(nhánh feat\)/)
    assert.doesNotMatch(ask, /\(nhánh featB\)/)
    addBranch(fx, 'featC') // chưa có dấu
    assert.match(assertDeny(claudeSh(fx, fx.main, 'git merge feat featC')), /featC: thiếu/)
  })

  test('nhánh đích không tìm được / không chung lịch sử với nhánh chính ⇒ deny (fail closed), mở đầu đời thường, mọi host', () => {
    const fx = ruleFx({ feat: { 'a.go': 'package a\n' } })
    git(fx.main, 'branch', 'orphan', git(fx.main, 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'orphan').trim())
    for (const c of ['git merge nope', 'git merge feat nope', 'git merge $BRANCH', 'git merge -m "gộp" ghost', 'git merge orphan', 'git merge --cleanup strip ghost']) {
      for (const sh of [claudeSh, codexSh, devinSh]) {
        const reason = assertDeny(sh(fx, fx.main, c))
        assertPlainOpening(reason, c)
        assert.match(reason, /nope|BRANCH|ghost|orphan/, c)
      }
    }
    assertPass(claudeSh(fx, fx.main, MERGE)) // nhánh đủ dấu và sạch vẫn qua
  })

  test('tên nhánh có ký tự shell ⇒ Codex deny nhưng KHÔNG in dòng lệnh gộp và không in lại tên lạ', () => {
    const fx = ruleFx({ feat: { 'eslint.config.js': 'export default []\n' } })
    git(fx.main, 'branch', 'a;b', 'feat')
    const reason = assertDeny(codexSh(fx, fx.main, "git merge 'a;b'"))
    assertPlainOpening(reason)
    assert.doesNotMatch(reason, /(^|\n)\s*git merge\b/)
    assert.ok(!reason.includes('a;b'), reason)
    assert.match(reason, /terminal/i)
    assert.match(assertAsk(claudeSh(fx, fx.main, "git merge 'a;b'")), /eslint\.config\.js/)
    // B3: cùng quy tắc cho các đường khác — lệnh có token lạ thì không in lại để user chép
    const other = assertDeny(codexSh(fx, fx.main, "git cherry-pick 'a;b'"))
    assertPlainOpening(other)
    assert.doesNotMatch(other, /(^|\n)\s*git cherry-pick\b/)
    assert.ok(!other.includes('a;b'), other)
  })

  // ---------- chép repo "chỉ học" (chiHocMatches của lib/kho.mjs) ----------

  const ENGINE = `export function planRoute(graph, start, goal) {
  const open = new Map()
  const closed = new Set()
  open.set(start, { cost: 0, parent: null })
  while (open.size > 0) {
    let best = null
    for (const [node, info] of open) {
      if (best === null || info.cost < open.get(best).cost) best = node
    }
    const current = open.get(best)
    open.delete(best)
    closed.add(best)
    if (best === goal) return buildPath(closed, best)
    for (const next of graph.neighbours(best)) {
      if (closed.has(next)) continue
      const cost = current.cost + graph.weight(best, next)
      const known = open.get(next)
      if (!known || cost < known.cost) open.set(next, { cost, parent: best })
    }
  }
  return null
}
`
  // ENGINE nhưng đổi hết tên, đổi khoảng trắng/thụt lề, thêm comment.
  const DISGUISED = `// helper tự viết
export function findPath(g, a, b) {
\tconst frontier = new Map();   /* tập mở */
\tconst seen = new Set();
\tfrontier.set(a, {cost: 0, parent: null});
\twhile (frontier.size > 0) {
\t\tlet pick = null;
\t\tfor (const [n, meta] of frontier) {
\t\t\tif (pick === null || meta.cost < frontier.get(pick).cost) pick = n;
\t\t}
\t\tconst cur = frontier.get(pick);
\t\tfrontier.delete(pick);
\t\tseen.add(pick);
\t\tif (pick === b) return makePath(seen, pick);
\t\tfor (const nx of g.neighbours(pick)) {
\t\t\tif (seen.has(nx)) continue;
\t\t\tconst c2 = cur.cost + g.weight(pick, nx);
\t\t\tconst old = frontier.get(nx);
\t\t\tif (!old || c2 < old.cost) frontier.set(nx, {cost: c2, parent: pick});
\t\t}
\t}
\treturn null;
}
`
  const UNRELATED = `export function formatReceipt(order, locale) {
  const lines = []
  let total = 0
  for (const item of order.items) {
    const price = item.qty * item.unit
    total += price
    lines.push(item.name.padEnd(20) + String(price).padStart(8))
  }
  lines.push('TOTAL'.padEnd(20) + new Intl.NumberFormat(locale).format(total))
  return lines.join('\\n')
}
`

  // Dự án có thẻ repo chỉ-học (licence GPL ⇒ ép chi-hoc) trỏ vào repo cục bộ; lay=true ⇒ đã tải bản sao vào cache. feat thêm `adds`, đủ dấu.
  function hocFx(adds, { lay = true, licence = 'GPL-3.0' } = {}) {
    const fx = fixture()
    const cache = path.join(fx.root, 'cache-chi-hoc')
    const remote = path.join(fx.root, 'remote')
    fs.mkdirSync(cache)
    fs.mkdirSync(remote)
    git(remote, 'init', '-b', 'main')
    commit(remote, 'src/engine.js', ENGINE, 'engine')
    const opts = { cacheDir: cache, choPhepLocal: true }
    const card = K.moi(fx.main, { loai: 'repo', repo: remote, licence, commit: git(remote, 'rev-parse', 'HEAD').trim(), ket_luan: 'Tìm đường A*' }, opts)
    if (lay) K.lay(fx.main, card.slug, opts)
    git(fx.main, 'add', '-A')
    git(fx.main, 'commit', '-m', 'thẻ repo')
    for (const [rel, text] of Object.entries(adds)) write(fx.wt, rel, text)
    git(fx.wt, 'add', '-A')
    git(fx.wt, 'commit', '-m', 'feat')
    stampBoth(fx)
    return { fx, slug: card.slug, env: { FLOW_CHI_HOC_DIR: cache } }
  }

  test('đoạn chép (đã đổi tên biến, khoảng trắng) từ repo chỉ-học ⇒ deny kèm file:dòng + thẻ, mọi host', () => {
    const { fx, slug, env } = hocFx({ 'src/route.js': DISGUISED })
    for (const sh of [claudeSh, codexSh, devinSh]) {
      const reason = assertDeny(sh(fx, fx.main, MERGE, env))
      assertPlainOpening(reason)
      assert.match(reason, /src\/route\.js:\d+/)
      assert.ok(reason.includes(slug), reason)
    }
  })

  test('FAIL CLOSED: có thẻ chỉ-học mà chưa có bản sao ⇒ deny kèm lệnh khôi phục kho.mjs lay', () => {
    const { fx, slug, env } = hocFx({ 'src/ok.js': UNRELATED }, { lay: false })
    for (const sh of [claudeSh, codexSh]) {
      const reason = assertDeny(sh(fx, fx.main, MERGE, env))
      assertPlainOpening(reason)
      assert.match(reason, /kho\.mjs lay /)
      assert.ok(reason.includes(slug), reason)
      assert.match(reason, /chưa có bản sao/)
    }
  })

  test('có bản sao nhưng nhánh chỉ thêm code khác hẳn ⇒ qua; thẻ lay-dung (MIT) hoặc không có thẻ ⇒ bỏ qua như cũ', () => {
    const ok = hocFx({ 'src/ok.js': UNRELATED })
    assertPass(claudeSh(ok.fx, ok.fx.main, MERGE, ok.env))
    const mit = hocFx({ 'src/route.js': DISGUISED }, { licence: 'MIT', lay: false })
    assertPass(claudeSh(mit.fx, mit.fx.main, MERGE, mit.env))
    const none = ruleFx({ feat: { 'src/route.js': DISGUISED } })
    assertPass(claudeSh(none, none.main, MERGE))
  })

  test('chép chỉ-học (deny) thắng việc nới luật (ask): cùng lúc có cả hai ⇒ deny', () => {
    const { fx, env } = hocFx({ 'src/route.js': DISGUISED, 'eslint.config.js': 'export default []\n' })
    const reason = assertDeny(claudeSh(fx, fx.main, MERGE, env))
    assert.match(reason, /src\/route\.js:\d+/)
  })
})

// ---------- đợt 3 (làn E): dấu QA đòi bằng chứng P-nn; file luật một nguồn lib/rule-files.mjs ----------

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

  test('cổng gộp kiểm lại dấu QA đã lưu: dấu thiếu dòng của P-02, P-03 ⇒ coi như thiếu qa (status + chặn gộp nêu mã, cả khi gộp bằng mã commit); đủ dòng ⇒ qua', () => {
    const fx = pFx()
    const pid = stampAllButQa(fx)
    putQa(fx, pid, P(1))
    assert.match(cli(fx, fx.wt, 'status').stdout, /qa: không \(thiếu dòng "P-nn: đỏ khi tắt: có — <file test>" cho P-02, P-03\)/)
    const sha = git(fx.wt, 'rev-parse', 'HEAD').trim()
    for (const target of ['feat', sha]) {
      const reason = assertDeny(merge(fx, target))
      assertPlainOpening(reason, target)
      assert.match(reason, /: thiếu qa/)
      assert.match(reason, /cho P-02, P-03:/)
      assert.ok(!/cho P-01/.test(reason), reason)
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

  test('cổng gộp + Stop + status: dấu QA có sẵn nhưng SPEC đang mở không đọc được ⇒ coi như chưa có qa (chặn gộp, nhắc), không để cổng mở; SPEC đọc lại được ⇒ qua', () => {
    for (const how of ['quá 2 MB', 'lỗi đọc']) {
      const fx = pFx()
      const pid = stampAllButQa(fx)
      putQa(fx, pid, P(1), P(2), P(3))
      assertPass(merge(fx))
      breakSpec(fx, how)
      const reason = assertDeny(merge(fx))
      assertPlainOpening(reason, how)
      assert.match(reason, /: thiếu qa/)
      assert.match(reason, UNREADABLE)
      assert.match(cli(fx, fx.wt, 'status').stdout, /qa: không \(không đọc được SPEC để kiểm mã quyền/)
      const stop = assertBlock(hook(fx, 'stop', stopIn(fx.wt)))
      assert.match(stop, /thiếu: qa/)
      assert.match(stop, UNREADABLE)
      mended(fx)
      assertPass(merge(fx))
    }
  })
})

describe('đợt 3: cổng gộp dùng danh sách file luật MỘT nguồn (lib/rule-files.mjs) — thêm .claude/ui.json, docs/ui-baseline.json, .claude/luu.json', () => {
  const FILES = ['.claude/ui.json', 'docs/ui-baseline.json', '.claude/luu.json']

  function ruleFx(files) {
    const fx = fixture()
    for (const f of files) write(fx.wt, f, '{}\n')
    git(fx.wt, 'add', '-A')
    git(fx.wt, 'commit', '-m', 'feat')
    stampBoth(fx)
    return fx
  }

  test('thêm ba file luật mới ⇒ Claude: ask liệt kê từng file bằng nhãn đời thường; Codex: deny, user tự chạy lệnh gộp', () => {
    const fx = ruleFx(FILES)
    const ask = assertAsk(hook(fx, 'bash', bashIn(fx.main, 'git merge feat')))
    assertPlainOpening(ask)
    for (const f of FILES) assert.ok(ask.includes(f), `${f} phải có trong lời hỏi: ${ask}`)
    assert.match(ask, /luật kiểm giao diện/)
    assert.match(ask, /lỗi giao diện cũ được bỏ qua/)
    assert.match(ask, /điểm lưu/)
    const reason = assertDeny(hook(fx, 'bash', codexIn(fx.main, 'Bash', { command: 'git merge feat' })))
    assert.match(reason.split(/\.\s|\n/)[0], /chính bạn chạy lệnh/)
    for (const f of FILES) assert.ok(reason.includes(f), reason)
  })

  test('sửa mốc giao diện có sẵn ⇒ ask "sửa"; file cùng tên ở chỗ khác (web/.claude/ui.json) không phải file luật ⇒ qua', () => {
    const fx = fixture()
    write(fx.main, 'docs/ui-baseline.json', '{"counts":{"a":1}}\n')
    git(fx.main, 'add', '-A')
    git(fx.main, 'commit', '-m', 'mốc')
    git(fx.wt, 'merge', '--ff-only', 'main')
    write(fx.wt, 'docs/ui-baseline.json', '{"counts":{"a":9}}\n')
    git(fx.wt, 'add', '-A')
    git(fx.wt, 'commit', '-m', 'nới mốc')
    stampBoth(fx)
    assert.match(assertAsk(hook(fx, 'bash', bashIn(fx.main, 'git merge feat'))), /sửa file danh sách lỗi giao diện cũ được bỏ qua \(docs\/ui-baseline\.json\)/)
    const other = ruleFx(['web/.claude/ui.json', 'web/docs/ui-baseline.json'])
    assertPass(hook(other, 'bash', bashIn(other.main, 'git merge feat')))
  })
})
