// Test cho lib/host.mjs: node --test ~/.claude/hooks/lib/host.test.mjs
// Payload mẫu: Claude (docs hooks), Codex (research.md §1.4, KIỂM bằng codex exec thật), Devin (notes/research-devin.md §4, TÀI LIỆU + suy luận).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from './host.mjs'

const PATCH_ADD = '*** Begin Patch\n*** Add File: zz-note.txt\n+hi\n*** End Patch'

// ── normalize: Claude ───────────────────────────────────────────────────────

test('normalize Claude: Bash → bash + command', () => {
  const r = normalize({
    session_id: 's1', transcript_path: '/t.jsonl', cwd: '/proj', permission_mode: 'default',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' },
  })
  assert.deepEqual(r, { host: 'claude', event: 'PreToolUse', tool: 'bash', command: 'git status', cwd: '/proj' })
})

test('normalize Claude: PowerShell (Windows) → bash + command (review Grok: nhắc sổ lúc commit qua PowerShell)', () => {
  const r = normalize({
    session_id: 's1', transcript_path: '/t.jsonl', cwd: '/proj', permission_mode: 'default',
    hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'git commit -m x' },
  })
  assert.deepEqual(r, { host: 'claude', event: 'PreToolUse', tool: 'bash', command: 'git commit -m x', cwd: '/proj' })
})

// Claude Code (2026-10) gửi kèm prompt_id ở mọi hook — trùng tên trường của Devin; transcript_path (Devin không gửi) là dấu Claude.
test('normalize Claude: payload thật có prompt_id + transcript_path + scratchpad_dir → vẫn là claude (kể cả env DEVIN_PROJECT_DIR khi Devin làm vỏ)', () => {
  const claude = {
    session_id: 's1', prompt_id: '550e8400-e29b-41d4-a716-446655440000', transcript_path: 'C:/u/.claude/projects/p/s1.jsonl', cwd: '/proj',
    scratchpad_dir: '/tmp/s', permission_mode: 'default', effort: 'high', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'git push origin main' }, tool_use_id: 'toolu_1',
  }
  assert.equal(normalize(claude).host, 'claude')
  assert.equal(normalize(claude, { DEVIN_PROJECT_DIR: '/proj' }).host, 'claude')
  assert.equal(normalize({ ...claude, hook_event_name: 'SessionStart', tool_name: undefined, tool_input: undefined }).host, 'claude')
  assert.equal(normalize({ ...claude, hook_event_name: 'Stop', tool_name: undefined, tool_input: undefined, stop_hook_active: false }).host, 'claude')
})

test('normalize Claude: Edit/Write/NotebookEdit/MultiEdit → edit (không có khoá command)', () => {
  const base = { hook_event_name: 'PreToolUse', cwd: '/proj' }
  assert.deepEqual(
    normalize({ ...base, tool_name: 'Edit', tool_input: { file_path: '/proj/a.js', old_string: 'x', new_string: 'y' } }),
    { host: 'claude', event: 'PreToolUse', tool: 'edit', cwd: '/proj' },
  )
  assert.equal(normalize({ ...base, tool_name: 'Write', tool_input: { file_path: '/proj/b.js', content: 'z' } }).tool, 'edit')
  assert.equal(normalize({ ...base, tool_name: 'NotebookEdit', tool_input: { notebook_path: '/proj/n.ipynb', new_source: 'x' } }).tool, 'edit')
  const me = normalize({ ...base, tool_name: 'MultiEdit', tool_input: { file_path: '/proj/m.js', edits: [] } })
  assert.equal(me.tool, 'edit')
  assert.equal('command' in me, false, 'tool edit không có khoá command')
})

test('normalize Claude: Agent / Task → agent; Read, MCP, tên lạ → other', () => {
  const base = { hook_event_name: 'PreToolUse', cwd: '/proj' }
  const ag = normalize({ ...base, tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt: 'x' } })
  assert.deepEqual(ag, { host: 'claude', event: 'PreToolUse', tool: 'agent', cwd: '/proj' })
  assert.equal(normalize({ ...base, tool_name: 'Task', tool_input: {} }).tool, 'agent')
  assert.equal(normalize({ ...base, tool_name: 'Read', tool_input: { file_path: '/proj/a.js' } }).tool, 'other')
  assert.equal(normalize({ ...base, tool_name: 'mcp__github__create_issue', tool_input: {} }).tool, 'other')
  assert.equal(normalize({ ...base, tool_name: 'Frobnicate', tool_input: {} }).tool, 'other')
})

test('normalize Claude: event không phải tool (SessionStart/Stop) → tool other, event giữ nguyên', () => {
  const r = normalize({ hook_event_name: 'SessionStart', cwd: '/proj', source: 'startup', model: 'claude-sonnet-5-5' })
  assert.deepEqual(r, { host: 'claude', event: 'SessionStart', tool: 'other', cwd: '/proj' })
  assert.equal(normalize({ hook_event_name: 'Stop', cwd: '/proj', stop_hook_active: false }).event, 'Stop')
})

// ── normalize: Codex ────────────────────────────────────────────────────────

test('normalize Codex: Bash có turn_id/model gpt-* → host codex', () => {
  const r = normalize({
    session_id: 's2', transcript_path: null, cwd: '/proj', hook_event_name: 'PreToolUse', model: 'gpt-6.1-sol',
    permission_mode: 'default', turn_id: 't-1', tool_name: 'Bash', tool_input: { command: 'echo hello-zz' }, tool_use_id: 'call_1',
  })
  assert.deepEqual(r, { host: 'codex', event: 'PreToolUse', tool: 'bash', command: 'echo hello-zz', cwd: '/proj' })
})

test('normalize Codex: apply_patch (patch nằm ở tool_input.command) → edit, host codex', () => {
  const r = normalize({
    cwd: '/proj', hook_event_name: 'PreToolUse', model: 'gpt-6.1-sol', turn_id: 't-2',
    tool_name: 'apply_patch', tool_input: { command: PATCH_ADD }, tool_use_id: 'call_2',
  })
  assert.deepEqual(r, { host: 'codex', event: 'PreToolUse', tool: 'edit', cwd: '/proj' })
})

test('normalize Codex: spawn_agent → agent; collaborationspawn_agent (PostToolUse thật) → agent', () => {
  const base = { cwd: '/proj', turn_id: 't-3', model: 'gpt-6-luna' }
  assert.deepEqual(
    normalize({ ...base, hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', tool_input: { message: 'x' } }),
    { host: 'codex', event: 'PreToolUse', tool: 'agent', cwd: '/proj' },
  )
  assert.equal(normalize({ ...base, hook_event_name: 'PostToolUse', tool_name: 'collaborationspawn_agent', tool_input: {} }).tool, 'agent')
})

test('normalize Codex: nhận diện bằng một trong ba dấu — turn_id, model gpt-*, tên tool apply_patch/spawn_agent', () => {
  assert.equal(normalize({ hook_event_name: 'Stop', turn_id: 't', cwd: '/p' }).host, 'codex')
  assert.equal(normalize({ hook_event_name: 'Stop', model: 'gpt-6-luna', cwd: '/p' }).host, 'codex')
  assert.equal(normalize({ hook_event_name: 'Stop', model: 'GPT-5.6', cwd: '/p' }).host, 'codex', 'không phân biệt hoa thường')
  assert.equal(normalize({ tool_name: 'apply_patch', tool_input: { command: PATCH_ADD }, cwd: '/p' }).host, 'codex')
  assert.equal(normalize({ tool_name: 'spawn_agent', tool_input: {}, cwd: '/p' }).host, 'codex')
})

test('normalize Codex: SubagentStop/PostToolUse giữ nguyên event', () => {
  const r = normalize({
    hook_event_name: 'SubagentStop', cwd: '/proj', turn_id: 't', model: 'gpt-6-luna',
    agent_id: 'a1', agent_type: 'coder', agent_transcript_path: null, stop_hook_active: false,
  })
  assert.deepEqual(r, { host: 'codex', event: 'SubagentStop', tool: 'other', cwd: '/proj' })
})

// ── normalize: Devin ────────────────────────────────────────────────────────

test('normalize Devin: exec → bash + command', () => {
  const r = normalize({
    hook_event_name: 'PreToolUse', session_id: 'd1', prompt_id: 'p1', cwd: '/proj',
    tool_name: 'exec', tool_input: { command: 'git commit -m x' },
  })
  assert.deepEqual(r, { host: 'devin', event: 'PreToolUse', tool: 'bash', command: 'git commit -m x', cwd: '/proj' })
})

test('normalize Devin: edit / write / notebook_edit → edit, host devin', () => {
  const base = { hook_event_name: 'PreToolUse', cwd: '/proj' }
  const e = normalize({ ...base, tool_name: 'edit', tool_input: { file_path: '/proj/a.js', old_string: 'x', new_string: 'y', replace_all: false } })
  assert.deepEqual(e, { host: 'devin', event: 'PreToolUse', tool: 'edit', cwd: '/proj' })
  const w = normalize({ ...base, tool_name: 'write', tool_input: { file_path: '/proj/b.js', content: 'z' } })
  assert.equal(w.host, 'devin')
  assert.equal(w.tool, 'edit')
  const nb = normalize({ ...base, tool_name: 'notebook_edit', tool_input: { notebook_path: '/proj/n.ipynb' } })
  assert.equal(nb.host, 'devin')
  assert.equal(nb.tool, 'edit')
})

test('normalize Devin: apply_patch (có prompt_id) → host devin, tool edit', () => {
  const r = normalize({
    hook_event_name: 'PreToolUse', cwd: '/proj', prompt_id: 'p1', tool_name: 'apply_patch', tool_input: { command: PATCH_ADD },
  })
  assert.equal(r.host, 'devin')
  assert.equal(r.tool, 'edit')
})

test('normalize Devin: run_subagent → agent', () => {
  const r = normalize({ hook_event_name: 'PreToolUse', cwd: '/proj', tool_name: 'run_subagent', tool_input: { prompt: 'x' } })
  assert.deepEqual(r, { host: 'devin', event: 'PreToolUse', tool: 'agent', cwd: '/proj' })
})

test('normalize Devin: SessionStart nhận ra qua prompt_id / tool_provenance / env DEVIN_PROJECT_DIR', () => {
  assert.equal(normalize({ hook_event_name: 'SessionStart', session_id: 's', prompt_id: 'p', cwd: '/p' }).host, 'devin')
  assert.equal(normalize({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_provenance: { skill: 'x' }, tool_input: { command: 'ls' }, cwd: '/p' }).host, 'devin')
  assert.equal(normalize({ hook_event_name: 'SessionStart', cwd: '/p' }, { DEVIN_PROJECT_DIR: '/p' }).host, 'devin')
  assert.equal(normalize({ hook_event_name: 'SessionStart', cwd: '/p' }, {}).host, 'claude', 'không có dấu nào ⇒ claude')
  assert.equal(normalize({ hook_event_name: 'SessionStart', cwd: '/p' }).host, 'claude', 'không truyền env ⇒ không đọc process.env (kết quả không phụ thuộc máy chạy test)')
})

test('normalize Devin: tên tool Devin kể cả khi payload cũng có dấu hiệu Claude vẫn là devin; có dấu Codex thì codex thắng', () => {
  assert.equal(normalize({ tool_name: 'edit', tool_input: { file_path: 'a' }, cwd: '/p' }).host, 'devin')
  assert.equal(normalize({ tool_name: 'edit', turn_id: 't', tool_input: { file_path: 'a' }, cwd: '/p' }).host, 'codex')
})

// ── normalize: mơ hồ / đầu vào xấu ──────────────────────────────────────────

test('normalize: mơ hồ ⇒ claude; đầu vào xấu không ném lỗi, trả khung an toàn', () => {
  const safe = { host: 'claude', event: '', tool: 'other', cwd: process.cwd() }
  for (const v of [undefined, null, 42, 'Bash', [], {}, true]) {
    assert.deepEqual(normalize(v), safe, `normalize(${JSON.stringify(v)})`)
  }
  assert.equal(normalize({ tool_name: 'Bash', tool_input: { command: 'ls' } }).host, 'claude', 'Bash trần không dấu hiệu ⇒ claude')
})

test('normalize: tool_name/tool_input/command sai kiểu → bỏ qua, không ném lỗi', () => {
  assert.deepEqual(normalize({ tool_name: 7, tool_input: 'x', cwd: '/p' }), { host: 'claude', event: '', tool: 'other', cwd: '/p' })
  const b = normalize({ tool_name: 'Bash', tool_input: null, cwd: '/p' })
  assert.equal(b.tool, 'bash')
  assert.equal('command' in b, false, 'không có command chuỗi ⇒ không có khoá')
  assert.equal('command' in normalize({ tool_name: 'Bash', tool_input: { command: 5 }, cwd: '/p' }), false)
  assert.equal(normalize({ hook_event_name: 5, cwd: '/p' }).event, '')
})

test('normalize: cwd thiếu/rỗng ⇒ process.cwd(); có thì giữ nguyên chuỗi', () => {
  assert.equal(normalize({ tool_name: 'Bash', tool_input: { command: 'ls' } }).cwd, process.cwd())
  assert.equal(normalize({ cwd: '', tool_name: 'Bash', tool_input: { command: 'ls' } }).cwd, process.cwd())
  assert.equal(normalize({ cwd: 'rel/dir' }).cwd, 'rel/dir')
})

test('normalize: không sửa đối tượng đầu vào', () => {
  const input = { tool_name: 'apply_patch', turn_id: 't', cwd: '/p', tool_input: { command: PATCH_ADD } }
  const copy = structuredClone(input)
  normalize(input)
  assert.deepEqual(input, copy)
})

test('normalize: tên tool phân loại không phân biệt hoa thường (cổng ưu tiên bắt dư hơn sót)', () => {
  assert.equal(normalize({ tool_name: 'bash', tool_input: { command: 'ls' }, cwd: '/p' }).tool, 'bash')
  assert.equal(normalize({ tool_name: 'EXEC', tool_input: { command: 'ls' }, cwd: '/p' }).tool, 'bash')
  assert.equal(normalize({ tool_name: 'WRITE', tool_input: { file_path: 'a' }, cwd: '/p' }).tool, 'edit')
})
