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
