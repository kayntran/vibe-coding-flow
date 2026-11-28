// node --test hooks/lib/hostgen.agy.test.mjs — phần Antigravity (agy) của hostgen.mjs: khối luật AGENTS, agent theo vai, hooks.json, luật chặn lớp 2.
// Tách khỏi hostgen.test.mjs (phần Codex) để hai nhánh sửa không đụng nhau. Fixture lấy từ nguồn thật của kit; danh sách vai/agent đọc từ kit/roles.json qua loadRoles()
// và agents/*.md, KHÔNG giả định danh sách cố định.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGY_HOOK_NAME, agyAgentMd, agyAgentsBlock, agyHooksJson, agyLayer2Deny } from './hostgen.mjs'
import { agyPreToolMatcher } from './host.mjs'
import { loadRoles } from './models.mjs'

const KIT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '')
const read = (p) => readFileSync(path.join(KIT, p), 'utf8')
const rules = read('CLAUDE.md')
const ruleTexts = readdirSync(path.join(KIT, 'rules')).filter((f) => f.endsWith('.md')).sort().map((f) => read(`rules/${f}`))
const roles = loadRoles()
const agentFiles = readdirSync(path.join(KIT, 'agents')).filter((f) => f.endsWith('.md')).sort()
const banner = 'tự sinh bởi vibe-flow — đừng sửa tay'
const START = '<!-- VIBE-FLOW:START -->'
const END = '<!-- VIBE-FLOW:END -->'
const DICT = '## Từ điển công cụ Claude → Antigravity (agy)'
const AGY_TOOLS = ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web', 'invoke_subagent']

// Đọc frontmatter phẳng của agent agy sinh ra: { name, description (đã giải JSON), subagent, mainAgent, model, tools[] } + phần thân.
function parseAgy(md) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md)
  assert.ok(m, 'phải có frontmatter ở đầu file')
  const fm = {}
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+): (.*)$/.exec(line)
    assert.ok(kv, `dòng frontmatter lạ: ${line}`)
    fm[kv[1]] = kv[2]
  }
  return {
    fm, body: m[2],
    name: fm.name, description: JSON.parse(fm.description), model: fm.model,
    tools: /^\[(.*)\]$/.exec(fm.tools)[1].split(', ').filter(Boolean),
  }
}

// ---------- AGENTS.md ----------

test('agyAgentsBlock: giữ đủ CLAUDE.md + rules thật, một cặp marker VIBE-FLOW, ≤ 24.000 byte', () => {
  const block = agyAgentsBlock(rules, ruleTexts)
  assert.ok(block.startsWith(`${START}\n`) && block.endsWith(`${END}\n`))
  assert.equal(block.match(new RegExp(START, 'g')).length, 1)
  assert.equal(block.match(new RegExp(END, 'g')).length, 1)
  assert.ok(block.includes(rules.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').trim()))
  assert.ok(block.includes(banner))
  assert.ok(Buffer.byteLength(block, 'utf8') <= 24000, `${Buffer.byteLength(block, 'utf8')} byte`)
  for (const r of ruleTexts) assert.ok(block.includes(r.replace(/^---\n[\s\S]*?\n---\n/, '').trim().split('\n')[0]), 'luật rules/*.md được nhúng')
  assert.ok(!/^paths:/m.test(block), 'bỏ frontmatter paths của rules/*.md')
})

test('agyAgentsBlock: từ điển công cụ nói đúng tên công cụ agy, không hứa có công cụ Claude / Codex ở phía agy', () => {
  const block = agyAgentsBlock(rules, ruleTexts)
  const dict = block.slice(block.indexOf(DICT))
  assert.ok(dict.startsWith(DICT))
  for (const term of ['read_file', 'edit_file', 'write_file', 'run_command', 'invoke_subagent', 'manage_task', 'search_web', 'hỏi thẳng trong chat', 'git worktree add',
    'ghi_chot', 'tim_chot', 'ghi_y_tuong', 'da_xem', 'ghi_so', 'du_an', 'rg -n', 'FLOW_OK=1', 'skills/', '~/.gemini/config/agents']) {
    assert.ok(dict.includes(term), `thiếu "${term}" trong từ điển`)
  }
  // Mọi dòng "A → B": vế phải (cách làm trên agy) không được nêu tên công cụ chỉ Claude có hay chỉ Codex có.
  const claudeOnly = /\b(Read|Glob|Grep|Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell|Agent|Task|AskUserQuestion|TaskCreate|TodoWrite|WebSearch|WebFetch|ExitPlanMode|EnterWorktree)\b/
  const codexOnly = /spawn_agent|exec_command|apply_patch|write_stdin|yield_time_ms|cell_id|collaboration/
  const arrows = dict.split('\n').filter((l) => l.startsWith('- ') && l.includes('→'))
  assert.ok(arrows.length >= 10, `chỉ có ${arrows.length} dòng ánh xạ`)
  for (const line of arrows) {
    const right = line.slice(line.indexOf('→') + 1)
    assert.doesNotMatch(right, claudeOnly, line)
    assert.doesNotMatch(right, codexOnly, line)
  }
  assert.doesNotMatch(dict, codexOnly, 'từ điển agy không chứa tên công cụ Codex')
})

test('agyAgentsBlock: nêu cách gọi ba loại worker theo bảng chia việc (Codex qua codex-run, Claude qua claude -p, agy chính nó)', () => {
  const block = agyAgentsBlock(rules, ruleTexts)
  assert.match(block, /node ~\/\.claude\/hooks\/codex-run\.mjs exec --sandbox read-only --vai <vai>/)
  assert.match(block, /claude -p "<brief>" --model <opus\|sonnet\|haiku>/)
  assert.match(block, /agy -p "<brief>" --model "\$\(node ~\/\.claude\/hooks\/models\.mjs pick agy <vai>\)"/)
  assert.match(block, /invoke_subagent/)
  assert.match(block, /cli-check\.mjs/)
})

test('agyAgentsBlock: trần đo bằng byte UTF-8; quá cỡ ném lỗi, không cắt mất luật', () => {
  const overhead = Buffer.byteLength(agyAgentsBlock(''), 'utf8')
  const exact = 'a'.repeat(24000 - overhead)
  assert.equal(Buffer.byteLength(agyAgentsBlock(exact), 'utf8'), 24000)
  assert.throws(() => agyAgentsBlock(exact + 'a'), /24\.000 byte/)
  assert.throws(() => agyAgentsBlock('ệ'.repeat(9000)), /24\.000 byte/)
})

test('agyAgentsBlock: BOM/CRLF chuẩn hoá; marker lồng, @import, include @[nhãn](đường dẫn) của agy, nguồn không phải chuỗi ⇒ lỗi', () => {
  assert.ok(agyAgentsBlock('\uFEFF# Luật\r\nNói tiếng Việt.\r\n').includes('# Luật\nNói tiếng Việt.'))
  for (const marker of [START, END]) assert.throws(() => agyAgentsBlock(marker), /marker/i)
  assert.throws(() => agyAgentsBlock('# Luật\n@core.md\n'), /@import|mở rộng/)
  assert.throws(() => agyAgentsBlock('# Luật\nXem @[luật khác](~/.claude/CLAUDE.md) nhé\n'), /include/)
  assert.throws(() => agyAgentsBlock(null), TypeError)
  assert.throws(() => agyAgentsBlock('# Luật', [`---\npaths:\n  - "x"\n---\n${END}`]), /marker/i)
})

test('agyAgentsBlock: khối thay được bằng spliceAgents của installer (cùng marker VIBE-FLOW) mà giữ nội dung riêng của user', async () => {
  const { spliceAgents } = await import('../../install.mjs')
  const block = agyAgentsBlock('# Luật kit')
  const user = '# Luật riêng của tôi\nĐọc CHANGELOG đầu phiên.\n'
  const first = spliceAgents(user, block)
  assert.ok(first.text.startsWith(user.trimEnd()))
  assert.ok(first.text.includes(START))
  const again = spliceAgents(first.text, agyAgentsBlock('# Luật kit v2'))
  assert.ok(again.text.includes('# Luật kit v2') && !again.text.includes('# Luật kit\n'))
  assert.ok(again.text.startsWith(user.trimEnd()))
  assert.equal(again.text.match(new RegExp(START, 'g')).length, 1)
})

// ---------- agent theo vai ----------

for (const file of agentFiles) {
  test(`agyAgentMd: agent thật ${file} — tool agy, quyền theo writesCode của vai, không còn khoá riêng của Claude`, () => {
    const md = read(`agents/${file}`)
    const name = /^name: (.+)$/m.exec(md)[1].trim()
    const role = roles.roles[name]
    assert.ok(role, `${name} thiếu trong kit/roles.json`)
    const out = agyAgentMd(md, roles)
    const a = parseAgy(out)
    assert.equal(a.name, name)
    assert.equal(a.description, /^description: (.+)$/m.exec(md)[1].trim())
    assert.equal(a.fm.subagent, 'true')
    assert.equal(a.fm.mainAgent, 'false')
    assert.deepEqual(Object.keys(a.fm).sort(), ['description', 'mainAgent', 'model', 'name', 'subagent', 'tools'])
    assert.ok(['inherit', 'flash', 'pro'].includes(a.model), a.model)
    const tier = role.models?.agy?.tier ?? role.models?.codex?.tier ?? role.models?.droid?.tier
    assert.equal(a.model, { manh: 'inherit', vua: 'pro', nhanh: 'flash' }[tier] ?? 'inherit', `${name}: hạng ${tier}`)
    assert.ok(a.tools.length > 0 && a.tools.every((t) => AGY_TOOLS.includes(t)), a.tools.join())
    assert.ok(a.tools.includes('read_file'))
    assert.equal(new Set(a.tools).size, a.tools.length, 'không trùng tool')
    const claudeTools = /^tools: (.+)$/m.exec(md)?.[1] ?? ''
    if (/\bBash\b/.test(claudeTools)) assert.ok(a.tools.includes('run_command'))
    if (/\bWeb(Search|Fetch)\b/.test(claudeTools)) assert.ok(a.tools.includes('search_web'))
    const body = md.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
    assert.ok(a.body.includes(body), 'thân chỉ dẫn nguyên văn')
    assert.ok(a.body.includes(banner))
    assert.match(a.body, /## Công cụ trên Antigravity/)
    if (role.writesCode) {
      assert.ok(!/vai này chỉ đọc/.test(a.body))
      if (/\bEdit\b/.test(claudeTools)) assert.ok(a.tools.includes('edit_file'))
      if (/\bWrite\b/.test(claudeTools)) assert.ok(a.tools.includes('write_file'))
    } else {
      assert.ok(!a.tools.includes('edit_file') && !a.tools.includes('write_file'), `${name} chỉ đọc nhưng có tool ghi: ${a.tools}`)
      assert.match(a.body, /vai này chỉ đọc/)
    }
    for (const key of ['effort', 'color', 'maxTurns']) assert.ok(!(key in a.fm), key)
    assert.doesNotMatch(out.split('\n---\n')[0], /sonnet|opus|haiku/)
  })
}

test('agyAgentMd: mọi agent của kit đều sinh được, tên không trùng nhau và không trùng agent dựng sẵn của agy', () => {
  const names = agentFiles.map((f) => parseAgy(agyAgentMd(read(`agents/${f}`), roles)).name)
  assert.equal(new Set(names).size, names.length)
  for (const n of ['self', 'browser', 'research', 'deepagent', 'review-agent']) assert.ok(!names.includes(n), n)
})

test('agyAgentMd: description có dấu hai chấm, nháy, xuống dòng vẫn là YAML hợp lệ (chuỗi JSON một dòng) và đọc lại đúng', () => {
  const reg = { roles: { 'vai-thu': { writesCode: true, models: { codex: { tier: 'vua' } } } } }
  const desc = 'Làm "việc A": bước 1 — xong; ghi chú #2'
  const md = `---\nname: vai-thu\ndescription: >-\n  ${desc}\n  dòng hai\ntools: Read, Edit\n---\n\nThân.\n`
  const a = parseAgy(agyAgentMd(md, reg))
  assert.equal(a.description, `${desc} dòng hai`)
  assert.equal(a.model, 'pro')
  assert.deepEqual(a.tools, ['read_file', 'edit_file'])
})

test('agyAgentMd: tools — thiếu khoá = bộ đầy đủ; tool lạ bị bỏ; toàn lạ ⇒ chỉ read_file; vai chỉ đọc mất tool ghi; không có hạng ⇒ model inherit', () => {
  const reg = { roles: { rw: { writesCode: true }, ro: { writesCode: false } } }
  const mk = (name, tools) => `---\nname: ${name}\ndescription: d\n${tools === undefined ? '' : `tools: ${tools}\n`}---\n\nThân.\n`
  assert.deepEqual(parseAgy(agyAgentMd(mk('rw'), reg)).tools, ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web'])
  assert.deepEqual(parseAgy(agyAgentMd(mk('ro'), reg)).tools, ['read_file', 'run_command', 'manage_task', 'search_web'])
  assert.deepEqual(parseAgy(agyAgentMd(mk('rw', 'Read, TodoWrite, Skill, Agent, Write'), reg)).tools, ['read_file', 'write_file', 'invoke_subagent'])
  assert.deepEqual(parseAgy(agyAgentMd(mk('rw', 'TodoWrite, Skill'), reg)).tools, ['read_file'])
  assert.deepEqual(parseAgy(agyAgentMd(mk('ro', 'Edit, Write'), reg)).tools, ['read_file'])
  assert.equal(parseAgy(agyAgentMd(mk('rw', 'Read'), reg)).model, 'inherit')
})

test('agyAgentMd: lỗi rõ khi thiếu frontmatter / vai / writesCode / tên không hợp lệ hoặc trùng agent dựng sẵn / thân rỗng', () => {
  const reg = { roles: { coder: { writesCode: true }, self: { writesCode: true }, 'Tên Lạ': { writesCode: true }, bad: {} } }
  const md = (name, body = 'Thân.') => `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`
  assert.throws(() => agyAgentMd('không frontmatter', reg), /frontmatter/)
  assert.throws(() => agyAgentMd(md('khong-co'), reg), /Không tìm thấy vai khong-co/)
  assert.throws(() => agyAgentMd(md('bad'), reg), /writesCode/)
  assert.throws(() => agyAgentMd(md('self'), reg), /trùng agent dựng sẵn/)
  assert.throws(() => agyAgentMd(md('Tên Lạ'), reg), /không hợp lệ/)
  assert.throws(() => agyAgentMd(md('coder', ''), reg), /thân chỉ dẫn/)
  assert.throws(() => agyAgentMd(md('coder'), null), /Không tìm thấy vai/)
  assert.throws(() => agyAgentMd(null, reg), TypeError)
})

// ---------- hooks.json ----------

test('agyHooksJson: một khoá vibe-flow; SessionStart/Stop phẳng, PreToolUse có matcher + hooks; timeout ≤ 30 s', () => {
  const j = agyHooksJson('C:\\Users\\Admin\\.claude')
  assert.deepEqual(Object.keys(j), [AGY_HOOK_NAME])
  assert.equal(AGY_HOOK_NAME, 'vibe-flow')
  const h = j[AGY_HOOK_NAME]
  assert.deepEqual(Object.keys(h).sort(), ['PreToolUse', 'SessionStart', 'Stop'])
  for (const ev of ['SessionStart', 'Stop']) {
    assert.equal(h[ev].length, 1)
    assert.equal(h[ev][0].type, 'command')
    assert.ok(!('hooks' in h[ev][0]) && !('matcher' in h[ev][0]), `${ev} là danh sách phẳng`)
  }
  assert.equal(h.PreToolUse.length, 1)
  assert.equal(h.PreToolUse[0].matcher, agyPreToolMatcher())
  assert.equal(h.PreToolUse[0].hooks.length, 1)
  const all = [h.SessionStart[0], h.Stop[0], h.PreToolUse[0].hooks[0]]
  for (const x of all) assert.ok(Number.isInteger(x.timeout) && x.timeout > 0 && x.timeout <= 30, JSON.stringify(x))
  assert.deepEqual(all.map((x) => x.command), [
    'node C:/Users/Admin/.claude/hooks/agy-hook.mjs session-start',
    'node C:/Users/Admin/.claude/hooks/agy-hook.mjs stop',
    'node C:/Users/Admin/.claude/hooks/agy-hook.mjs pre-tool',
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(j)), j)
})

test('agyHooksJson: matcher compile được; khớp lệnh shell + tool ghi file, không khớp tool đọc', () => {
  const re = new RegExp(agyHooksJson('/tmp/kit')[AGY_HOOK_NAME].PreToolUse[0].matcher)
  for (const n of ['run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'write_file', 'edit_file', 'delete_directory']) assert.match(n, re, n)
  for (const n of ['view_file', 'list_dir', 'grep_search', 'read_url_content', 'command_status']) assert.doesNotMatch(n, re, n)
})

test('agyHooksJson: đường dẫn có khoảng trắng được bọc nháy kép; đường dẫn lạ / tương đối bị từ chối', () => {
  const j = agyHooksJson('D:\\A B\\kit')
  assert.equal(j[AGY_HOOK_NAME].Stop[0].command, 'node "D:/A B/kit/hooks/agy-hook.mjs" stop')
  for (const root of ['', 'relative/kit', null, '/tmp/k"it', '/tmp/$kit', '/tmp/kit\nx']) assert.throws(() => agyHooksJson(root), /kitRoot|tuyệt đối|đường dẫn/)
})

test('agyHooksJson: gọi lại cho cùng kết quả và không chia sẻ object', () => {
  const a = agyHooksJson('/tmp/kit')
  const b = agyHooksJson('/tmp/kit')
  assert.deepEqual(a, b)
  a[AGY_HOOK_NAME].Stop[0].command = 'mutated'
  assert.notEqual(a[AGY_HOOK_NAME].Stop[0].command, b[AGY_HOOK_NAME].Stop[0].command)
})

test('agyHooksJson: lệnh sinh ra chạy được thật qua shell và trỏ đúng agy-hook.mjs (lệnh xoá thư mục hệ thống giả ⇒ deny; JSON hỏng ⇒ deny)', () => {
  const j = agyHooksJson(KIT)
  const env = { ...process.env, AGY_HOOK_LOG: path.join(os.tmpdir(), `agy-hook-hostgen-${process.pid}.log`) }
  const pre = j[AGY_HOOK_NAME].PreToolUse[0].hooks[0].command
  const rm = JSON.stringify({ hookEventName: 'PreToolUse', cwd: os.tmpdir(), toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf C:\\Windows\\khong-ton-tai' } } })
  const r = spawnSync(pre, { shell: true, input: rm, encoding: 'utf8', env, timeout: 60000 })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).decision, 'deny')
  const broken = spawnSync(pre, { shell: true, input: '{hỏng', encoding: 'utf8', env, timeout: 60000 })
  assert.equal(JSON.parse(broken.stdout).decision, 'deny')
  const stop = spawnSync(j[AGY_HOOK_NAME].Stop[0].command, { shell: true, input: JSON.stringify({ hookEventName: 'Stop', cwd: os.tmpdir(), terminationReason: 'NO_TOOL_CALL' }), encoding: 'utf8', env, timeout: 60000 })
  assert.deepEqual(JSON.parse(stop.stdout), { decision: 'stop' })
})

// ---------- lớp 2: luật chặn trong quyền agy ----------

const asRegExp = (rule) => {
  const m = /^command\(regex:\(\?is\)(.*)\)$/s.exec(rule)
  assert.ok(m, rule)
  return new RegExp(m[1], 'is')
}

test('agyLayer2Deny: mọi luật là command(regex:(?is)…), chỉ dùng cú pháp chung của RE2 và JS (không lookaround / tham chiếu ngược / nhóm đặt tên)', () => {
  const list = agyLayer2Deny()
  assert.ok(list.length >= 8)
  assert.equal(new Set(list).size, list.length)
  for (const rule of list) {
    asRegExp(rule)
    assert.doesNotMatch(rule, /\(\?[=!<]|\\[1-9]|\(\?P?</, rule)
    assert.ok(rule.startsWith('command(regex:(?is).*') && rule.endsWith('.*)'), 'bao hai đầu bằng .*')
  }
})

test('agyLayer2Deny: chặn các lệnh nguy hiểm nhất (xoá ổ/hệ thống/nhà/.git, push ép + xoá nhánh chính, xoá DB), kể cả viết kiểu Windows', () => {
  const res = agyLayer2Deny().map(asRegExp)
  const blocked = (c) => res.some((re) => re.test(c))
  for (const c of [
    'rm -rf /', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf ${HOME}', 'rm -rf /*', 'sudo rm -rf /', 'rm -r -f /', 'rm -Rf C:/', 'rm -rf "C:\\"', 'cd x && rm -rf ~; echo ok',
    'Remove-Item -Recurse -Force C:\\', 'rd /s /q C:\\', 'del /s /q C:\\*', 'rmdir /s /q %USERPROFILE%',
    'rm -rf C:\\Windows\\khong-ton-tai', 'rm -rf "C:\\Program Files\\x"', 'rmdir /s /q C:\\Windows\\khong-ton-tai-vibe', 'rm -rf /usr/lib/x', 'rm -rf /etc', 'Remove-Item -Recurse C:\\ProgramData\\x',
    'rm -rf .git', 'rm -rf ./.git', 'rm -rf /home/u/proj/.git/', 'Remove-Item -Recurse -Force .git', 'rd /s /q .git',
    'git push --force origin main', 'git push -f origin master', 'git push origin main --force', 'git push --force-with-lease origin main', 'git push origin +main',
    'git push -fu origin main', 'git push origin HEAD:main -f', 'git -C x push --force origin HEAD:main', 'git push origin --delete main', 'git push origin :main', 'git push -d origin master',
    'psql -c "DROP DATABASE app"', 'drop schema public cascade', 'mysql -e "drop database x"', 'supabase db reset', 'npx prisma migrate reset --force',
    'format C:', 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sda1',
  ]) assert.ok(blocked(c), `đáng lẽ bị lớp 2 chặn: ${c}`)
})

test('agyLayer2Deny: lệnh vô hại (thư mục tạm, push thường, nhánh khác) KHÔNG bị chặn', () => {
  const res = agyLayer2Deny().map(asRegExp)
  const blocked = (c) => res.find((re) => re.test(c))
  for (const c of [
    'rm -rf /tmp/vibe-test-xyz', 'rm -rf ./node_modules', 'rm -rf build', 'rm -rf ~/tmp/x', 'rm -rf $TMPDIR/x', 'rm -rf /var/folders/ab/cd/T/x', 'rm file.txt', 'rm -rf .github', 'rm -rf .gitignore',
    'rm -rf C:\\Users\\Admin\\AppData\\Local\\Temp\\vibe-xyz', 'rd /s /q C:\\Users\\Admin\\AppData\\Local\\Temp\\x', 'Remove-Item -Recurse -Force "$env:TEMP\\vibe-xyz"', 'rm -rf /home/u/proj/.gitlab',
    'git push origin feat', 'git push --force origin feat', 'git push -f origin feat:other', 'git push -u origin main', 'git push origin main', 'git push', 'git push origin main --follow-tags',
    'git push --force-with-lease origin feat/main-menu', 'git commit -m "đừng force push main"', 'git status', 'git log --oneline -5', 'git branch -d feat', 'git push origin --delete feat',
    'npm test', 'echo hello', 'ls /', 'cat README.md', 'node -e "console.log(1)"', 'psql -c "select 1"', 'echo format c', 'dd if=a of=b.img',
  ]) assert.equal(blocked(c), undefined, `không được chặn: ${c} (khớp ${blocked(c)})`)
})

test('agyLayer2Deny: main/master phải là NGUYÊN tên nhánh — không chặn nhầm feat/main-menu, main-v2, release/main…; nhánh đứng trước hay sau cờ đều đúng', () => {
  const res = agyLayer2Deny().map(asRegExp)
  const hit = (c) => res.some((re) => re.test(c))
  for (const c of [
    'git push origin feat/main-menu --force', 'git push -f origin main-v2', 'git push origin --delete feat/main-menu', 'git push --force origin feat/master-plan', 'git push origin main-v2 --force',
    'git push origin mainline -f', 'git push origin feat/main -f', 'git push --force origin release/main', 'git push -f origin refs/heads/feat/main', 'git push origin --delete release/master',
    'git push origin +feat/main-menu', 'git push origin :feat/main-menu', 'git push --force-with-lease origin hotfix-main', 'git push origin domain -f', 'git push -f origin mastery',
  ]) assert.equal(hit(c), false, `không được chặn: ${c}`)
  for (const c of [
    'git push -f origin refs/heads/main', 'git push origin main -f', 'git push origin feat main --force', 'git push origin --delete refs/heads/main', 'git push origin HEAD:refs/heads/main -f',
    'git push --force origin main;', 'git push --force origin main && echo ok', 'git push --force origin "main"', 'git push origin main --force-with-lease', 'git push origin +HEAD:master',
    'git push origin :refs/heads/master', 'git push -d origin master', 'git push origin feat/x:main --force', 'git push origin --delete main feat',
  ]) assert.equal(hit(c), true, `phải bị chặn: ${c}`)
})

test('agyLayer2Deny: refspec đặt trong dấu nháy (đơn/kép) vẫn bị bắt; nhánh hợp lệ trong nháy thì không', () => {
  const res = agyLayer2Deny().map(asRegExp)
  const hit = (c) => res.some((re) => re.test(c))
  for (const c of [
    "git push origin '+HEAD:main'", 'git push origin "+HEAD:main"', "git push origin '+main'", 'git push origin "+main"', "git push origin '+master'", "git push origin '+refs/heads/feat:refs/heads/main'",
    "git push origin ':main'", 'git push origin ":main"', "git push origin ':refs/heads/main'", 'git push origin ":refs/heads/main"', "git push origin ':master'", 'git push origin ":refs/heads/master"',
    "git push --force origin 'main'", 'git push -f origin "HEAD:main"', "git push -f origin 'refs/heads/main'", "git push origin 'main' --force", 'git push origin "HEAD:refs/heads/main" -f',
    "git push origin '+HEAD:main' && echo ok", 'git push origin "+main";', "git push origin 'x' '+HEAD:main'", "git push --delete origin 'main'",
  ]) assert.equal(hit(c), true, `phải bị chặn: ${c}`)
  for (const c of [
    "git push origin '+feat/main-menu'", 'git push origin "+main-v2"', "git push origin ':feat/main-menu'", 'git push origin ":refs/heads/release/main"', "git push origin '+HEAD:release/main'", 'git push origin "+HEAD:main-v2"',
    "git push -f origin 'feat/main'", 'git push --force origin "release/master"', "git push origin 'feat'", 'git push origin "+feat"', "git push origin ':feat'", 'git commit -m "+HEAD:main"', "echo ':main'",
  ]) assert.equal(hit(c), false, `không được chặn: ${c}`)
})

test('agyLayer2Deny: chạy nhanh trên lệnh dài vài KB (agy dùng Go RE2 nên tuyến tính; JS quay lùi nên thử cỡ vừa); hàm trả mảng mới mỗi lần', () => {
  const res = agyLayer2Deny().map(asRegExp)
  for (const cmd of [`git ${'push '.repeat(150)}`, `rm ${'-r '.repeat(300)}x`, `git push ${'a '.repeat(400)}`, `${'x'.repeat(4000)}`, `rm -rf ${'/a'.repeat(400)}`]) {
    const t0 = Date.now()
    for (const re of res) re.test(cmd)
    assert.ok(Date.now() - t0 < 3000, `quá chậm (${Date.now() - t0} ms)`)
  }
  const a = agyLayer2Deny()
  a.push('x')
  assert.notEqual(agyLayer2Deny().length, a.length)
})
