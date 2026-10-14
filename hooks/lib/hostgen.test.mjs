// node --test hooks/lib/hostgen.test.mjs — fixtures lấy từ nguồn thật, không cài package.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { codexAgentsBlock, codexAgentToml, codexHooksJson, claudeHooks } from './hostgen.mjs'

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const rules = read('CLAUDE.md')
const registry = JSON.parse(read('kit/roles.json'))
const agentFiles = readdirSync(new URL('../../agents/', import.meta.url)).filter((f) => f.endsWith('.md'))
const agent = (name) => read(`agents/${name}.md`)
const resolved = { model: 'catalog-selected-model', effort: 'low', source: 'catalog' }
const banner = 'tự sinh bởi vibe-flow — đừng sửa tay'
const normalized = (s) => s.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
const body = (s) => normalized(s).split('\n---\n').slice(1).join('\n---\n').trim()
// Đọc subset TOML basic-string để kiểm giá trị. Test tomllib độc lập bên dưới kiểm cú pháp TOML thật.
function values(toml) {
  return Object.fromEntries(toml.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
    const m = /^(\w+) = (".*")$/.exec(l)
    assert.ok(m, `Khoá TOML không đúng định dạng: ${l}`)
    return [m[1], JSON.parse(m[2])]
  }))
}
const generated = (root, script, windows = false) => {
  const file = `${root.replaceAll('\\', '/').replace(/\/+$/, '')}/hooks/${script}`
  if (!windows) return `node "${file}"`
  return `$ErrorActionPreference = 'Stop'; & node '${file.replaceAll("'", "''")}'; exit $LASTEXITCODE`
}
const commandParts = (command) => {
  const m = /^node "([^"]+)\/hooks\/([^"]+)"(?: (\S+))?$/.exec(command)
  assert.ok(m, command)
  return `${m[2]}${m[3] ? ` ${m[3]}` : ''}`
}

test('AGENTS: giữ đủ luật CLAUDE.md thật và một cặp marker đúng', () => {
  const block = codexAgentsBlock(rules)
  assert.ok(block.startsWith('<!-- VIBE-FLOW:START -->\n'))
  assert.ok(block.endsWith('<!-- VIBE-FLOW:END -->\n'))
  assert.equal(block.match(/<!-- VIBE-FLOW:START -->/g).length, 1)
  assert.equal(block.match(/<!-- VIBE-FLOW:END -->/g).length, 1)
  assert.ok(block.includes(normalized(rules).trim()))
  assert.ok(block.includes(banner))
  assert.ok(Buffer.byteLength(block, 'utf8') <= 24 * 1024)
})

test('AGENTS: từ điển công cụ theo brief J, không hứa có tool Claude trong Codex', () => {
  const block = codexAgentsBlock(rules)
  for (const term of ['Agent', 'Task', 'spawn_agent', 'AskUserQuestion', 'hỏi thẳng trong chat',
    'EnterWorktree', 'git worktree add', 'ExitPlanMode', 'trình plan rồi chờ',
    'run_in_background', 'yield_time_ms', 'write_stdin', 'apply_patch', 'exec_command']) {
    assert.ok(block.includes(term), term)
  }
  assert.match(block, /không.*@import/i)
})

test('AGENTS: trần đo bằng byte UTF-8; quá cỡ ném lỗi, không cắt mất luật', () => {
  const overhead = Buffer.byteLength(codexAgentsBlock(''), 'utf8')
  const exact = 'a'.repeat(24 * 1024 - overhead)
  assert.equal(Buffer.byteLength(codexAgentsBlock(exact), 'utf8'), 24 * 1024)
  assert.throws(() => codexAgentsBlock(exact + 'a'), /24.*KiB|24.*KB/)
  assert.throws(() => codexAgentsBlock('ệ'.repeat(9000)), /24.*KiB|24.*KB/)
})

test('AGENTS: BOM/CRLF chuẩn hoá; marker lồng hoặc @import chưa mở rộng phải báo lỗi', () => {
  assert.ok(codexAgentsBlock('\uFEFF# Luật\r\nNói tiếng Việt.\r\n').includes('# Luật\nNói tiếng Việt.'))
  for (const marker of ['<!-- VIBE-FLOW:START -->', '<!-- VIBE-FLOW:END -->']) {
    assert.throws(() => codexAgentsBlock(marker), /marker/i)
  }
  assert.throws(() => codexAgentsBlock('# Luật\n@core.md\n'), /@import|mở rộng/)
  assert.throws(() => codexAgentsBlock(null), TypeError)
})

for (const file of agentFiles) {
  test(`TOML: agent thật ${file}, quyền và effort từ registry/resolver Codex`, () => {
    const md = read(`agents/${file}`)
    const name = /^name: (.+)$/m.exec(md)[1].trim()
    const role = registry.roles[name]
    assert.ok(role, `${name} thiếu trong kit/roles.json`)
    const toml = codexAgentToml(md, registry, resolved)
    const out = values(toml)
    assert.equal(out.name, name)
    assert.equal(out.description, /^description: (.+)$/m.exec(md)[1].trim())
    assert.ok(out.developer_instructions.includes(body(md)))
    assert.equal(out.model, resolved.model)
    assert.equal(out.model_reasoning_effort, resolved.effort)
    assert.ok(toml.includes(banner))
    const allowed = ['name', 'description', 'developer_instructions', 'model', 'model_reasoning_effort']
    if (role.writesCode) assert.ok(!Object.hasOwn(out, 'sandbox_mode'))
    else {
      assert.equal(out.sandbox_mode, 'read-only')
      assert.match(out.developer_instructions, /chỉ đọc/i)
      allowed.push('sandbox_mode')
    }
    assert.deepEqual(Object.keys(out).sort(), allowed.sort())
  })
}

test('TOML: model:null bỏ model, không dùng model/effort Claude', () => {
  const out = values(codexAgentToml(agent('coder'), registry, { model: null, effort: 'medium', source: 'fallback' }))
  assert.ok(!Object.hasOwn(out, 'model'))
  assert.equal(out.model_reasoning_effort, 'medium')
})

test('TOML: thiếu resolver dùng effort Codex của registry và không đoán slug', () => {
  for (const file of agentFiles) {
    const md = read(`agents/${file}`)
    const out = values(codexAgentToml(md, registry))
    assert.equal(out.model_reasoning_effort, registry.roles[out.name].models.codex.effort)
    assert.ok(!Object.hasOwn(out, 'model'))
  }
})

test('TOML: resolver effort:null bỏ khoá effort để kế thừa, không phục hồi effort khác', () => {
  const out = values(codexAgentToml(agent('coder'), registry, { model: null, effort: null }))
  assert.ok(!Object.hasOwn(out, 'model_reasoning_effort'))
})

test('TOML: vai coder-mini trong registry dù chưa có agents/coder-mini.md', () => {
  const md = '---\nname: coder-mini\ndescription: Việc nhỏ\nmodel: haiku\n---\n\nViết một thay đổi nhỏ.\n'
  const out = values(codexAgentToml(md, registry))
  assert.equal(out.model_reasoning_effort, registry.roles['coder-mini'].models.codex.effort)
  assert.ok(!Object.hasOwn(out, 'sandbox_mode'))
})

const trickyBody = 'Tiếng Việt 🧭; """; C:\\work\\file; \t tab\nmodel = "inject"\n\b\f\u0000\u001b\u007f'
const trickyMd = '\uFEFF---\r\nname: "coder"\r\ndescription: \'Có "quote": và \'\'nháy\'\'\'\r\n---\r\n\r\n' + trickyBody

test('TOML: quote, backslash, newline, Unicode và control không chèn thêm khoá', () => {
  const out = values(codexAgentToml(trickyMd, registry, resolved))
  assert.equal(out.description, 'Có "quote": và \'nháy\'')
  assert.equal(out.developer_instructions, trickyBody)
  assert.equal(out.model, resolved.model)
})

test('TOML: description YAML folded/literal được đọc dù không cài YAML package', () => {
  for (const [style, expected] of [['>-', 'Dòng một: ý "A" Dòng hai.'], ['|-', 'Dòng một: ý "A"\nDòng hai.']]) {
    const md = `---\nname: coder\ndescription: ${style}\n  Dòng một: ý "A"\n  Dòng hai.\nmodel: sonnet\n---\nLàm việc.\n`
    assert.equal(values(codexAgentToml(md, registry)).description, expected)
  }
})

test('TOML: nguồn sai/vai lạ/quyền chưa rõ không sinh agent thiếu rào chắn', () => {
  for (const md of ['Nội dung không frontmatter', '---\nname: coder\n---\nThân',
    '---\nname: unknown\ndescription: X\n---\nThân', '---\nname: coder\ndescription: X\n---\n']) {
    assert.throws(() => codexAgentToml(md, registry), /frontmatter|description|vai|thân/i)
  }
  const bad = structuredClone(registry)
  delete bad.roles.coder.writesCode
  assert.throws(() => codexAgentToml(agent('coder'), bad), /writesCode/)
  assert.throws(() => codexAgentToml(agent('coder'), registry, { model: 'x', effort: 'nonsense' }), /effort/i)
})

test('TOML: parser độc lập Python stdlib tomllib đọc toàn bộ bản xuất thật và chuỗi biên', (t) => {
  const candidates = [['python3', []], ['python', []], ['py', ['-3']]]
  const python = candidates.find(([cmd, args]) => spawnSync(cmd, [...args, '-c', 'import tomllib'], { timeout: 5000 }).status === 0)
  if (!python) return t.skip('Không có Python 3.11+ tomllib; không cài ngầm. Test giá trị TOML vẫn chạy.')
  const docs = [...agentFiles.map((f) => codexAgentToml(read(`agents/${f}`), registry, resolved)),
    codexAgentToml(trickyMd, registry, resolved), codexAgentToml(agent('coder'), registry, { model: null, effort: null })]
  const result = spawnSync(python[0], [...python[1], '-c',
    'import sys,json,tomllib; docs=json.loads(sys.stdin.buffer.read().decode("utf-8")); print(json.dumps([tomllib.loads(s) for s in docs],ensure_ascii=True))'],
  { input: JSON.stringify(docs), encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.length, agentFiles.length + 2)
  assert.equal(parsed.at(-2).developer_instructions, trickyBody)
  assert.ok(!Object.hasOwn(parsed.at(-1), 'model'))
})

test('Claude hooks: đủ 10 command/event/timeout (9 của bộ hook trước v7 + nhắc sổ lúc commit)', () => {
  // Bộ hook của install.mjs bản v6 (đã chạy thật). Installer v7 lấy hook từ chính claudeHooks (một nguồn, ADR-0003),
  // nên mốc đối chiếu ghi thẳng ở đây; đổi hook thì sửa cả hai có chủ đích.
  const baseline = [
    ['UserPromptSubmit', 'undefined', 'reply-vietnamese.mjs', 5],
    ['PreToolUse', '"Edit|Write|NotebookEdit"', 'flow-gate.mjs edit', 15],
    ['PreToolUse', '"Bash"', 'flow-gate.mjs bash', 15],
    ['Stop', 'undefined', 'flow-gate.mjs stop', 15],
    ['SubagentStop', 'undefined', 'flow-gate.mjs subagent-stop', 15],
    ['SessionStart', 'undefined', 'session-start.mjs', 10],
    ['PostToolUse', '"mcp__.*"', 'mcp-usage.mjs log', 5],
    ['PreToolUse', '"Agent|Task"', 'flow-dispatch.mjs agent', 30],
    ['PreToolUse', '"Bash"', 'flow-dispatch.mjs commit', 15], // sau audit 2026-10-13: nhắc sổ tiến độ lúc git commit
    ['Stop', 'undefined', 'flow-dispatch.mjs stop', 15],
  ].map(([e, m, s, t]) => [null, e, m, s, String(t)])
  const entries = claudeHooks('/tmp/kit with spaces')
  assert.equal(entries.length, baseline.length)
  for (let i = 0; i < entries.length; i++) {
    const [event, matcher, hook] = entries[i]
    const [, expectedEvent, oldMatcher, script, timeout] = baseline[i]
    assert.equal(event, expectedEvent)
    assert.equal(commandParts(hook.command), script)
    assert.equal(hook.type, 'command')
    assert.equal(hook.timeout, Number(timeout))
    if (oldMatcher === 'undefined') assert.equal(matcher, undefined)
    else for (const alias of JSON.parse(oldMatcher).split('|')) assert.ok(matcher.includes(alias), alias)
  }
})

test('Claude hooks: MỌI tên tool sửa file của Claude (Edit, Write, MultiEdit, NotebookEdit) vào cổng edit — matcher neo ^$ không được bỏ sót MultiEdit', () => {
  const edit = claudeHooks('/tmp/kit').find(([ev, , h]) => ev === 'PreToolUse' && commandParts(h.command) === 'flow-gate.mjs edit')
  assert.ok(edit)
  for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(new RegExp(edit[1]).test(name), name)
  for (const name of ['MultiEditX', 'XMultiEdit', 'Multi', 'EditNotebook']) assert.ok(!new RegExp(edit[1]).test(name), name)
})

test('Claude hooks: mọi bí danh Devin vào đúng cổng; tên tool khác không khớp', () => {
  const entries = claudeHooks('/tmp/kit')
  const match = (tool) => entries.filter(([ev, matcher]) => ev === 'PreToolUse' && new RegExp(matcher).test(tool)).map(([, , h]) => commandParts(h.command))
  for (const name of ['Edit', 'Write', 'NotebookEdit', 'edit', 'write', 'apply_patch', 'notebook_edit']) assert.deepEqual(match(name), ['flow-gate.mjs edit'])
  for (const name of ['Bash', 'exec']) assert.deepEqual(match(name), ['flow-gate.mjs bash', 'flow-dispatch.mjs commit'])
  for (const name of ['Agent', 'Task', 'run_subagent']) assert.deepEqual(match(name), ['flow-dispatch.mjs agent'])
  for (const name of ['Read', 'execute_query', 'rewrite', 'mcp__server__edit']) assert.deepEqual(match(name), [])
})

test('Codex hooks: hooks.json đúng nhóm event/handler và giữ các hook dùng chung', () => {
  const out = codexHooksJson('/tmp/kit')
  assert.ok(out.description.includes(banner))
  assert.deepEqual(Object.keys(out.hooks).sort(), ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionStart'].sort())
  assert.equal(Object.values(out.hooks).flat().length, 10)
  for (const [event, groups] of Object.entries(out.hooks)) for (const group of groups) {
    assert.equal(group.hooks.length, 1)
    if (['Stop', 'SubagentStop', 'SessionStart', 'UserPromptSubmit'].includes(event)) assert.ok(!Object.hasOwn(group, 'matcher'))
    assert.equal(group.hooks[0].type, 'command')
    assert.ok(group.hooks[0].timeout > 0)
    assert.equal(typeof group.hooks[0].commandWindows, 'string')
    assert.ok(!Object.hasOwn(group.hooks[0], 'command_windows'))
  }
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out)
})

test('Codex hooks: apply_patch/Bash/spawn_agent đúng cổng, Stop có cả gate và dispatch', () => {
  const { hooks } = codexHooksJson('/tmp/kit')
  const match = (tool) => hooks.PreToolUse.filter((g) => new RegExp(g.matcher).test(tool)).map((g) => commandParts(g.hooks[0].command))
  for (const tool of ['apply_patch', 'Edit', 'Write']) assert.deepEqual(match(tool), ['flow-gate.mjs edit'])
  assert.deepEqual(match('Bash'), ['flow-gate.mjs bash', 'flow-dispatch.mjs commit'])
  for (const tool of ['Agent', 'spawn_agent', 'collaborationspawn_agent']) assert.deepEqual(match(tool), ['flow-dispatch.mjs agent'])
  assert.deepEqual(match('mcp__server__spawn_agent'), [])
  assert.deepEqual(hooks.Stop.map((g) => commandParts(g.hooks[0].command)), ['flow-gate.mjs stop', 'flow-dispatch.mjs stop'])
  assert.equal(commandParts(hooks.SessionStart[0].hooks[0].command), 'session-start.mjs')
  assert.equal(commandParts(hooks.SubagentStop[0].hooks[0].command), 'flow-gate.mjs subagent-stop')
})

test('Hooks: root Windows/POSIX có khoảng trắng, nháy và shell metachar là đối số nguyên văn', () => {
  for (const root of ['/Users/a/kit with spaces/', "D:\\A B\\O'Brien & (kit)\\"]) {
    const { hooks } = codexHooksJson(root)
    const h = hooks.SessionStart[0].hooks[0]
    assert.equal(h.command, generated(root, 'session-start.mjs'))
    // Windows dùng PowerShell encoded literal để không phụ thuộc shell của host (cmd/PowerShell).
    assert.match(h.commandWindows, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    const decoded = Buffer.from(h.commandWindows.split(' ').at(-1), 'base64').toString('utf16le')
    assert.equal(decoded, generated(root, 'session-start.mjs', true))
    assert.equal(claudeHooks(root)[5][2].command, generated(root, 'session-start.mjs'))
  }
})

test('Hooks: root rỗng/không tuyệt đối/NUL/newline từ chối thay vì sinh command sai', () => {
  // Ký tự còn nghĩa bên trong nháy kép (" $ ` %) bị từ chối: lệnh Claude bọc nháy kép để chạy được cả bash lẫn cmd.
  for (const root of ['', 'relative/kit', null, '/tmp/kit\nother', '/tmp/kit\0', '/tmp/k"it', '/tmp/$kit', '/tmp/k`it', 'D:\\%kit%']) {
    assert.throws(() => codexHooksJson(root), /kitRoot|tuyệt đối|đường dẫn/)
    assert.throws(() => claudeHooks(root), /kitRoot|tuyệt đối|đường dẫn/)
  }
})

test('Hooks Windows: shell cmd → PowerShell giữ nguyên đối số metachar và exit 2 của node', { skip: process.platform !== 'win32' }, () => {
  const root = "D:\\A B\\O'Brien & (kit)"
  const hook = codexHooksJson(root).hooks.PreToolUse[0].hooks[0]
  const ps = Buffer.from(hook.commandWindows.split(' ').at(-1), 'base64').toString('utf16le')
  // Thay node bằng function trả đối số và exit code; không chạy hook thật hay ghi file.
  const mock = 'function node { ConvertTo-Json -InputObject @($args) -Compress; $global:LASTEXITCODE = 2 }; '
  const cmd = hook.commandWindows.replace(/\S+$/, Buffer.from(mock + ps, 'utf16le').toString('base64'))
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 2, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), [root.replaceAll('\\', '/') + '/hooks/flow-gate.mjs', 'edit'])
})

test('Hàm thuần: lặp cho cùng kết quả, không chia sẻ hook object hoặc sửa registry/resolver', () => {
  const snapshot = JSON.stringify(registry)
  const modelSnapshot = JSON.stringify(resolved)
  assert.equal(codexAgentsBlock(rules), codexAgentsBlock(rules))
  assert.equal(codexAgentToml(agent('coder'), registry, resolved), codexAgentToml(agent('coder'), registry, resolved))
  const first = codexHooksJson('/tmp/kit')
  const second = codexHooksJson('/tmp/kit')
  assert.deepEqual(first, second)
  first.hooks.Stop[0].hooks[0].command = 'mutated'
  assert.notEqual(first.hooks.Stop[0].hooks[0].command, second.hooks.Stop[0].hooks[0].command)
  const claude = claudeHooks('/tmp/kit')
  claude[0][2].timeout = 1000
  assert.equal(claudeHooks('/tmp/kit')[0][2].timeout, 5)
  assert.equal(JSON.stringify(registry), snapshot)
  assert.equal(JSON.stringify(resolved), modelSnapshot)
})
