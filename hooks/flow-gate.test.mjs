// Test cho flow-gate.mjs: node --test ~/.claude/hooks/flow-gate.test.mjs
// Mỗi test tạo repo tạm trong os.tmpdir (main + worktree `feat`), gọi script qua spawnSync với JSON stdin, rồi tự dọn.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flow-gate.mjs')
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

function run(fx, args, { input, cwd } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd: cwd ?? fx.root, env: { ...ENV, FLOW_GATE_LOG: fx.log },
  })
  assert.equal(r.error, undefined)
  let json = null
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

const hook = (fx, mode, input) => run(fx, [mode], { input })
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

// Thêm nhánh `name` (worktree riêng, một commit file <name>.go nội dung riêng); trả đường dẫn worktree.
function addBranch(fx, name) {
  const wt = path.join(fx.root, `wt-${name}`)
  git(fx.main, 'worktree', 'add', '-b', name, wt)
  commit(wt, `${name}.go`, `package ${name}\n`, name)
  return wt
}

const pidOf = (fx, cwd = fx.wt) => /^pid: ([0-9a-f]{40,})$/m.exec(cli(fx, cwd, 'status').stdout)?.[1]

function stampBoth(fx, { qa = 'QA ok\n', cwd = fx.wt } = {}) {
  const review = write(fx.root, 'review.json', JSON.stringify({ findings: [] }))
  const qaFile = write(fx.root, 'qa.md', qa)
  const r1 = cli(fx, cwd, 'stamp', 'review', review)
  const r2 = cli(fx, cwd, 'stamp', 'qa', qaFile)
  assert.equal(r1.status, 0, r1.stderr)
  assert.equal(r2.status, 0, r2.stderr)
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
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'git merge feat#1'))) // nhánh feat#1 không tồn tại
  })

  test('thân heredoc không phải lệnh; lệnh thật sau/cùng dòng heredoc vẫn bị bắt', () => {
    const fx = featFixture()
    assertPass(hook(fx, 'bash', bashIn(fx.main, 'cat <<EOF\ngit merge feat\nEOF')))
    assertPass(hook(fx, 'bash', bashIn(fx.main, "cat <<'EOF' > note.txt\ngit merge feat\nEOF\necho xong")))
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
    ['aws', 'AKIA' + 'IOSFODNN7EXAMPLE'],
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
    assertPass(sh(fx, fx.main, 'git push')) // secret cũ đã nằm trên upstream
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
    // HEAD (main) sạch nên các lệnh gửi main/HEAD cho qua; src sạch dù dst trùng tên nhánh bẩn
    for (const c of ['git push', 'git push origin main', 'git push origin HEAD', 'git push origin main:feat', 'git push origin :feat', 'git push origin khong-ton-tai']) {
      assertPass(sh(fx, fx.main, c))
    }
    // HEAD (feat) bẩn: gửi main thì qua; không refspec / HEAD / feat:main thì chặn
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
    assertPass(sh(fx, fx.main, 'git push --repo=origin main')) // gửi main sạch
    assertPass(sh(fx, fx.main, 'git push --repo origin')) // không refspec ⇒ HEAD (main) sạch
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
    assertPass(sh(fx, fx.main, 'git push --mirror origin'))
    git(fx.wt, 'checkout', '-q', '--detach')
    commit(fx.wt, 'tagged.js', withSecret, 'secret chỉ có ở tag')
    git(fx.wt, 'tag', 'v9')
    git(fx.wt, 'checkout', '-q', 'feat')
    for (const c of ['git push --mirror origin', 'git push origin --mirror']) assert.match(assertDeny(sh(fx, fx.main, c)), /tagged\.js:2 — github/, c)
    assertPass(sh(fx, fx.main, 'git push --all origin')) // --all chỉ gửi nhánh, các nhánh đều sạch
    git(fx.wt, 'tag', '-d', 'v9')
    assertPass(sh(fx, fx.main, 'git push --mirror origin'))
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
