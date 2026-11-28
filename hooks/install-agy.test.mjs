// node --test hooks/install-agy.test.mjs — phần Antigravity (agy) của install.mjs: cài vào ~/.gemini trên HOME giả, KHÔNG bao giờ đụng ~/.gemini hay ~/.claude thật.
// Tách khỏi install.test.mjs (Claude/Codex) để hai nhánh sửa không đụng nhau. Đặt trong hooks/ (không ở gốc) vì /.gitignore ở gốc chỉ cho phép vài file gốc cụ thể. Phủ AC-01, AC-02, AC-08 (và cho Codex: vai không khai models.codex bị bỏ qua êm).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { install, mergeAgyHooks, mergeAgyMcp, spliceAgents } from '../install.mjs'
import { agyHooksJson } from './lib/hostgen.mjs'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') // gốc kit (file test nằm trong hooks/ vì .gitignore chỉ cho phép vài file ở gốc)
const posix = (p) => p.replaceAll('\\', '/')
const dirs = []
const tmp = (prefix = 'vf-agy-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d }
after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* Windows còn giữ khoá: để hệ điều hành dọn */ } }
})
const rd = (...p) => fs.readFileSync(path.join(...p), 'utf8')
const wr = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const json = (...p) => JSON.parse(rd(...p))
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : [])
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex')

// Ảnh chụp cây thư mục: đường dẫn → băm nội dung.
function tree(dir, skip = () => false) {
  const out = {}
  if (!fs.existsSync(dir)) return out
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = posix(path.relative(dir, p))
      if (skip(rel)) continue
      if (e.isDirectory()) walk(p)
      else out[rel] = sha(fs.readFileSync(p))
    }
  }
  walk(dir)
  return out
}

const GENERATED = 'tự sinh bởi vibe-flow'
const START = '<!-- VIBE-FLOW:START -->'
const STAMP = '20261128120000'
const emptyBin = tmp('vf-emptybin-')

// Kit mini: CLAUDE.md + rules + 2 agent + 2 skill thật của kit; extra.skills = { tên: nội dung SKILL.md } thêm vào.
function miniKit({ skills = {}, roles } = {}) {
  const d = tmp('vf-kit-')
  fs.copyFileSync(path.join(HERE, 'CLAUDE.md'), path.join(d, 'CLAUDE.md'))
  wr(path.join(d, 'kit', 'roles.json'), roles ?? rd(HERE, 'kit', 'roles.json'))
  wr(path.join(d, 'rules', 'ui-style.md'), rd(HERE, 'rules', 'ui-style.md'))
  for (const a of ['coder', 'recon']) wr(path.join(d, 'agents', `${a}.md`), rd(HERE, 'agents', `${a}.md`))
  for (const s of ['flow-spec', 'flow-qa']) fs.cpSync(path.join(HERE, 'skills', s), path.join(d, 'skills', s), { recursive: true })
  for (const [name, text] of Object.entries(skills)) wr(path.join(d, 'skills', name, 'SKILL.md'), text)
  return d
}

// PATH trống: không có `agy`/`codex` trên PATH ⇒ chỉ ~/.gemini có sẵn mới bật phần Antigravity.
async function run(home, kitDir, o = {}) {
  const lines = []
  const r = await install({
    home, kitDir,
    env: { PATH: emptyBin, VIBE_FLOW_PATH_ONLY: '1', ...(o.env ?? {}) },
    log: (l) => lines.push(l),
    stamp: o.stamp ?? STAMP,
    models: {},
    checkAll: async () => ({}),
    hasRg: true,
  })
  return { ...r, out: lines.join('\n') }
}
const agyChanged = (r) => r.changed.filter((c) => c.startsWith('agy:'))
const g = (home) => path.join(home, '.gemini')
const rootOf = (home) => posix(path.join(home, '.claude'))
const withGemini = (home) => { fs.mkdirSync(g(home), { recursive: true }); return home }

// ---------- không có agy ----------

test('máy không có agy (không ~/.gemini, không agy trên PATH) ⇒ không tạo gì ở ~/.gemini, Claude vẫn cài', async () => {
  const home = tmp(); const kit = miniKit()
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  assert.equal(fs.existsSync(g(home)), false)
  assert.deepEqual(agyChanged(r), [])
  assert.doesNotMatch(r.out, /Antigravity/)
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')))
})

test('agy có trên PATH dù chưa có ~/.gemini ⇒ vẫn cài cho Antigravity', async () => {
  const home = tmp(); const kit = miniKit(); const bin = tmp('vf-agybin-')
  wr(path.join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy'), 'x')
  if (process.platform !== 'win32') fs.chmodSync(path.join(bin, 'agy'), 0o755)
  const r = await run(home, kit, { env: { PATH: bin } })
  assert.equal(r.code, 0, r.out)
  assert.ok(agyChanged(r).length > 0)
  assert.ok(fs.existsSync(path.join(g(home), 'AGENTS.md')))
})

// ---------- máy trống có ~/.gemini ----------

test('máy có ~/.gemini trống ⇒ AGENTS.md (khối VIBE-FLOW), skill flow-*, agent theo vai, hooks.json, mcp_config.json; không cần sao lưu', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Antigravity: đã cập nhật \(luật AGENTS\.md, 2 skill, 2 vai, hook chặn, MCP sổ chốt\)/)
  // luật
  const agents = rd(g(home), 'AGENTS.md')
  assert.ok(agents.startsWith(START))
  assert.ok(agents.includes('## Từ điển công cụ Claude → Antigravity (agy)'))
  assert.ok(Buffer.byteLength(agents, 'utf8') <= 24000)
  assert.ok(agents.includes('Phong cách UI'), 'rules/*.md được nhúng')
  // skill
  assert.deepEqual(ls(path.join(g(home), 'config', 'skills')), ['flow-qa', 'flow-spec'])
  for (const s of ['flow-qa', 'flow-spec']) {
    assert.ok(fs.existsSync(path.join(g(home), 'config', 'skills', s, 'SKILL.md')))
    assert.ok(fs.existsSync(path.join(g(home), 'config', 'skills', s, '.vibe-flow-generated')))
    assert.equal(rd(g(home), 'config', 'skills', s, 'SKILL.md'), rd(kit, 'skills', s, 'SKILL.md'))
  }
  // agent
  assert.deepEqual(ls(path.join(g(home), 'config', 'agents')), ['coder.md', 'recon.md'])
  const coder = rd(g(home), 'config', 'agents', 'coder.md')
  assert.match(coder, /^---\nname: coder\n/)
  assert.match(coder, /\ntools: \[read_file, edit_file, write_file, run_command, manage_task\]\n/)
  assert.match(rd(g(home), 'config', 'agents', 'recon.md'), /\ntools: \[read_file, run_command, manage_task, search_web\]\n/)
  assert.ok(coder.includes(GENERATED))
  // hook + MCP
  assert.deepEqual(json(g(home), 'config', 'hooks.json'), agyHooksJson(rootOf(home)))
  assert.match(json(g(home), 'config', 'hooks.json')['vibe-flow'].PreToolUse[0].hooks[0].command, new RegExp(`^node ${rootOf(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/hooks/agy-hook\\.mjs pre-tool$`))
  assert.deepEqual(json(g(home), 'config', 'mcp_config.json'), { mcpServers: { 'so-chot': { command: 'node', args: [`${rootOf(home)}/hooks/so-chot-mcp.mjs`] } } })
  // không có gì cũ để cất
  assert.equal(ls(g(home)).some((x) => x.startsWith('backup-vibe-flow-')), false)
  for (const c of ['agy: AGENTS.md', 'agy: skill flow-spec', 'agy: skill flow-qa', 'agy: vai coder', 'agy: vai recon', 'agy: hooks.json', 'agy: mcp_config.json']) assert.ok(r.changed.includes(c), c)
})

test('cài lại lần 2 (và 3, đổi stamp): không đổi gì, không nhân đôi, không tạo thêm bản sao; cây ~/.gemini y hệt', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  const first = await run(home, kit)
  assert.equal(first.code, 0, first.out)
  const before = tree(g(home))
  for (const stamp of [STAMP, '20261128130000']) {
    const again = await run(home, kit, { stamp })
    assert.equal(again.code, 0, again.out)
    assert.deepEqual(again.changed, [], again.out)
    assert.match(again.out, /Antigravity: đã đủ, không đổi gì\./)
    assert.deepEqual(tree(g(home)), before)
  }
  const agents = rd(g(home), 'AGENTS.md')
  assert.equal(agents.split(START).length - 1, 1, 'đúng một khối')
  assert.equal(Object.keys(json(g(home), 'config', 'hooks.json')).length, 1)
  assert.equal(Object.keys(json(g(home), 'config', 'mcp_config.json').mcpServers).length, 1)
})

// ---------- giữ cấu hình của user ----------

test('MCP / hook / skill / agent / luật riêng của user còn nguyên, có bản sao trước khi ghi; lần 2 không đổi', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  const userMcp = { mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'], env: { K: '${K}' } }, 'so-chot': { command: 'cu', args: ['cu.js'] }, remote: { url: 'https://x.test/mcp' } }, other: { giu: true } }
  const userHooks = { 'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh', timeout: 10 }] }] }, 'vibe-flow': { Stop: [{ type: 'command', command: 'node cu.mjs' }] } }
  const userAgentsMd = '# Luật riêng của tôi\nĐọc CHANGELOG đầu phiên.\n'
  wr(path.join(g(home), 'config', 'mcp_config.json'), JSON.stringify(userMcp, null, 2) + '\n')
  wr(path.join(g(home), 'config', 'hooks.json'), JSON.stringify(userHooks, null, 2) + '\n')
  wr(path.join(g(home), 'AGENTS.md'), userAgentsMd)
  wr(path.join(g(home), 'config', 'skills', 'skill-cua-toi', 'SKILL.md'), '---\nname: skill-cua-toi\ndescription: x\n---\nthân\n')
  wr(path.join(g(home), 'config', 'agents', 'mine.md'), '---\nname: mine\ndescription: x\n---\nthân\n')
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  // MCP
  const mcp = json(g(home), 'config', 'mcp_config.json')
  assert.deepEqual(mcp.mcpServers.github, userMcp.mcpServers.github)
  assert.deepEqual(mcp.mcpServers.remote, userMcp.mcpServers.remote)
  assert.deepEqual(mcp.other, userMcp.other)
  assert.deepEqual(Object.keys(mcp.mcpServers), ['github', 'so-chot', 'remote'], 'thứ tự của user giữ nguyên')
  assert.deepEqual(mcp.mcpServers['so-chot'].args, [`${rootOf(home)}/hooks/so-chot-mcp.mjs`])
  // hook
  const hooks = json(g(home), 'config', 'hooks.json')
  assert.deepEqual(hooks['lint-checker'], userHooks['lint-checker'])
  assert.deepEqual(hooks['vibe-flow'], agyHooksJson(rootOf(home))['vibe-flow'])
  assert.deepEqual(Object.keys(hooks), ['lint-checker', 'vibe-flow'])
  // luật
  const agents = rd(g(home), 'AGENTS.md')
  assert.ok(agents.startsWith(userAgentsMd.trimEnd()))
  assert.ok(agents.includes(START))
  // skill + agent khác
  assert.ok(fs.existsSync(path.join(g(home), 'config', 'skills', 'skill-cua-toi', 'SKILL.md')))
  assert.equal(rd(g(home), 'config', 'agents', 'mine.md'), '---\nname: mine\ndescription: x\n---\nthân\n')
  assert.ok(ls(path.join(g(home), 'config', 'agents')).includes('mine.md'))
  // bản sao nguyên văn của file cũ nằm trong backup-vibe-flow-<stamp>
  const bk = path.join(g(home), `backup-vibe-flow-${STAMP}`, '.gemini')
  assert.equal(rd(bk, 'config', 'mcp_config.json'), JSON.stringify(userMcp, null, 2) + '\n')
  assert.equal(rd(bk, 'config', 'hooks.json'), JSON.stringify(userHooks, null, 2) + '\n')
  assert.equal(rd(bk, 'AGENTS.md'), userAgentsMd)
  assert.match(r.out, /Bản sao file cũ của ~\/\.gemini nằm trong .*backup-vibe-flow-20261128120000/)
  // lần 2: không đổi, không thêm bản sao
  const before = tree(g(home))
  const again = await run(home, kit, { stamp: '20261128140000' })
  assert.deepEqual(again.changed, [], again.out)
  assert.deepEqual(tree(g(home)), before)
})

test('GEMINI.md / AGENTS.md cũ — 3 ca × 2 lần cài: file cũ nguyên bản; chỉ luật riêng; cả hai. Kit KHÔNG sửa GEMINI.md, chỉ cảnh báo', async () => {
  const legacy = '# Luật dự án khác\nBẮT BUỘC đọc .agents/workflows/gemini.md và CHANGELOG.md đầu phiên.\n'
  const own = '# Luật riêng của tôi\nLuôn viết commit bằng tiếng Việt.\n'
  const cases = [
    { name: 'GEMINI.md cũ, chưa có AGENTS.md', gemini: legacy, agents: null },
    { name: 'AGENTS.md chỉ có luật riêng, không có GEMINI.md', gemini: null, agents: own },
    { name: 'cả GEMINI.md cũ lẫn AGENTS.md luật riêng', gemini: legacy, agents: own },
  ]
  for (const c of cases) {
    const home = withGemini(tmp()); const kit = miniKit()
    if (c.gemini !== null) wr(path.join(g(home), 'GEMINI.md'), c.gemini)
    if (c.agents !== null) wr(path.join(g(home), 'AGENTS.md'), c.agents)
    for (const [lan, stamp] of [[1, STAMP], [2, '20261128150000']]) {
      const r = await run(home, kit, { stamp })
      assert.equal(r.code, 0, `${c.name} lần ${lan}: ${r.out}`)
      if (c.gemini !== null) {
        assert.equal(rd(g(home), 'GEMINI.md'), c.gemini, `${c.name} lần ${lan}: GEMINI.md phải nguyên bản`)
        assert.match(r.out, /GEMINI\.md có luật không phải của kit/, `${c.name} lần ${lan}: phải cảnh báo`)
      } else {
        assert.equal(fs.existsSync(path.join(g(home), 'GEMINI.md')), false, `${c.name}: không được tạo GEMINI.md`)
        assert.doesNotMatch(r.out, /GEMINI\.md có luật/)
      }
      const agents = rd(g(home), 'AGENTS.md')
      assert.ok(agents.includes(START) && agents.includes('Từ điển công cụ Claude → Antigravity'), `${c.name} lần ${lan}`)
      assert.equal(agents.split(START).length - 1, 1, `${c.name} lần ${lan}: đúng một khối`)
      assert.ok(!agents.includes(legacy.trim()), 'luật cũ của GEMINI.md không được lọt vào AGENTS.md')
      if (c.agents !== null) assert.ok(agents.startsWith(c.agents.trimEnd()), `${c.name} lần ${lan}: luật riêng còn nguyên ở đầu`)
      if (lan === 2) assert.deepEqual(r.changed, [], `${c.name}: lần 2 không đổi gì (${r.out})`)
    }
    if (c.agents !== null) {
      const bk = path.join(g(home), `backup-vibe-flow-${STAMP}`, '.gemini', 'AGENTS.md')
      assert.equal(rd(bk), c.agents, `${c.name}: bản sao AGENTS.md cũ`)
    }
  }
})

test('GEMINI.md rỗng hoặc chỉ khoảng trắng ⇒ không cảnh báo', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  wr(path.join(g(home), 'GEMINI.md'), '  \n')
  const r = await run(home, kit)
  assert.doesNotMatch(r.out, /GEMINI\.md có luật/)
  assert.equal(rd(g(home), 'GEMINI.md'), '  \n')
})

// ---------- skill ----------

test('skill > 24.000 byte ⇒ in cảnh báo (nêu tên + cỡ), vẫn chép nguyên bản, code 0', async () => {
  const home = withGemini(tmp())
  const big = `---\nname: flow-lon\ndescription: skill dài\n---\n${'dòng dài của skill\n'.repeat(1800)}`
  const kit = miniKit({ skills: { 'flow-lon': big } })
  assert.ok(Buffer.byteLength(big, 'utf8') > 24000)
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(`Lưu ý: Antigravity: skill flow-lon dài ${Buffer.byteLength(big, 'utf8')} byte, vượt 24000 byte`))
  assert.equal(rd(g(home), 'config', 'skills', 'flow-lon', 'SKILL.md'), big)
  assert.doesNotMatch(r.out, /skill flow-spec dài/)
  assert.deepEqual(r.problems, [])
})

test('skill trùng tên của user (không có dấu của kit) ⇒ cất vào backup rồi thay; skill đã bỏ khỏi kit ⇒ cất; skill khác của user nguyên', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  const mine = '---\nname: flow-spec\ndescription: của tôi\n---\nbản của tôi\n'
  wr(path.join(g(home), 'config', 'skills', 'flow-spec', 'SKILL.md'), mine)
  wr(path.join(g(home), 'config', 'skills', 'khac', 'SKILL.md'), 'khác\n')
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.changed.some((c) => /^agy: cất skill flow-spec có sẵn vào backup-vibe-flow-/.test(c)))
  assert.equal(rd(g(home), `backup-vibe-flow-${STAMP}`, '.gemini', 'config', 'skills', 'flow-spec', 'SKILL.md'), mine)
  assert.equal(rd(g(home), 'config', 'skills', 'flow-spec', 'SKILL.md'), rd(kit, 'skills', 'flow-spec', 'SKILL.md'))
  assert.equal(rd(g(home), 'config', 'skills', 'khac', 'SKILL.md'), 'khác\n')
  // kit bỏ flow-qa ⇒ bản đã cài được cất, không xoá hẳn
  fs.rmSync(path.join(kit, 'skills', 'flow-qa'), { recursive: true })
  const again = await run(home, kit, { stamp: '20261128160000' })
  assert.ok(again.changed.some((c) => /^agy: cất skill flow-qa \(đã bỏ khỏi kit\)/.test(c)), again.out)
  assert.equal(fs.existsSync(path.join(g(home), 'config', 'skills', 'flow-qa')), false)
  assert.ok(fs.existsSync(path.join(g(home), 'backup-vibe-flow-20261128160000', '.gemini', 'config', 'skills', 'flow-qa', 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(g(home), 'config', 'skills', 'khac', 'SKILL.md')))
})

test('file trong skill do kit sinh mà kit đã bỏ ⇒ cất; file sửa ở kit ⇒ cập nhật tại chỗ', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  await run(home, kit)
  wr(path.join(kit, 'skills', 'flow-spec', 'references', 'moi.md'), 'mới\n')
  const extra = path.join(g(home), 'config', 'skills', 'flow-spec', 'references', 'cu.md')
  wr(extra, 'cũ\n')
  const r = await run(home, kit, { stamp: '20261128170000' })
  assert.ok(r.changed.includes('agy: skill flow-spec'))
  assert.equal(rd(g(home), 'config', 'skills', 'flow-spec', 'references', 'moi.md'), 'mới\n')
  assert.equal(fs.existsSync(extra), false)
  assert.equal(rd(g(home), 'backup-vibe-flow-20261128170000', '.gemini', 'config', 'skills', 'flow-spec', 'references', 'cu.md'), 'cũ\n')
})

// ---------- agent ----------

test('agent: bản kit sinh được cập nhật tại chỗ không cần sao lưu; file trùng tên của user được cất; vai đã bỏ khỏi kit được cất; vai lỗi chỉ báo, không hỏng cài', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  wr(path.join(g(home), 'config', 'agents', 'recon.md'), '---\nname: recon\ndescription: của tôi\n---\nbản của tôi\n')
  const r1 = await run(home, kit)
  assert.equal(r1.code, 0, r1.out)
  assert.equal(rd(g(home), `backup-vibe-flow-${STAMP}`, '.gemini', 'config', 'agents', 'recon.md'), '---\nname: recon\ndescription: của tôi\n---\nbản của tôi\n')
  assert.ok(rd(g(home), 'config', 'agents', 'recon.md').includes(GENERATED))
  // kit đổi nội dung vai coder ⇒ cập nhật tại chỗ, không tạo bản sao (file cũ do kit sinh)
  fs.appendFileSync(path.join(kit, 'agents', 'coder.md'), '\nThêm một dòng mới cho vai.\n')
  const r2 = await run(home, kit, { stamp: '20261128180000' })
  assert.deepEqual(r2.changed, ['agy: vai coder'])
  assert.ok(rd(g(home), 'config', 'agents', 'coder.md').includes('Thêm một dòng mới cho vai.'))
  assert.equal(fs.existsSync(path.join(g(home), 'backup-vibe-flow-20261128180000')), false, 'file do kit sinh thì không cần bản sao')
  // vai bỏ khỏi kit ⇒ cất; vai không có trong kit/roles.json ⇒ báo, bỏ qua
  fs.rmSync(path.join(kit, 'agents', 'recon.md'))
  wr(path.join(kit, 'agents', 'la.md'), '---\nname: la\ndescription: vai lạ\nmodel: sonnet\ntools: Read\n---\nThân.\n')
  const r3 = await run(home, kit, { stamp: '20261128190000' })
  assert.equal(r3.code, 0, r3.out)
  assert.ok(r3.changed.includes('agy: cất vai recon.md (đã bỏ khỏi kit) vào backup-vibe-flow-20261128190000'), r3.out)
  assert.match(r3.out, /Lưu ý: Bỏ qua vai la cho Antigravity: Không tìm thấy vai la trong kit\/roles\.json/)
  assert.equal(fs.existsSync(path.join(g(home), 'config', 'agents', 'la.md')), false)
  assert.ok(fs.existsSync(path.join(g(home), 'backup-vibe-flow-20261128190000', '.gemini', 'config', 'agents', 'recon.md')))
})

// ---------- lỗi: không ghi nửa chừng ----------

test('hooks.json hoặc mcp_config.json của user hỏng ⇒ báo lỗi rõ, không ghi gì cho Antigravity (kể cả AGENTS.md), file hỏng không bị đụng', async () => {
  for (const [file, text, re] of [
    [['config', 'hooks.json'], '{ không phải json', /hooks\.json không phải JSON hợp lệ/],
    [['config', 'mcp_config.json'], '[1,2]', /mcp_config\.json không phải một object JSON/],
    [['config', 'mcp_config.json'], '{"mcpServers": []}', /"mcpServers" trong mcp_config\.json của agy không phải object/],
  ]) {
    const home = withGemini(tmp()); const kit = miniKit()
    wr(path.join(g(home), ...file), text)
    const r = await run(home, kit)
    assert.equal(r.code, 1, r.out)
    assert.match(r.problems.join('\n'), re)
    assert.equal(fs.existsSync(path.join(g(home), 'AGENTS.md')), false, 'chưa ghi AGENTS.md khi còn lỗi')
    assert.equal(fs.existsSync(path.join(g(home), 'config', 'skills')), false)
    assert.equal(rd(g(home), ...file), text)
    assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')), 'phần Claude vẫn cài')
  }
})

test('nguồn luật chứa cú pháp include @[…](…) của agy hoặc kit thiếu CLAUDE.md ⇒ lỗi rõ, không ghi nửa chừng', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  fs.appendFileSync(path.join(kit, 'CLAUDE.md'), '\nXem @[luật](~/.claude/x.md)\n')
  const r = await run(home, kit)
  assert.equal(r.code, 1)
  assert.match(r.problems.join('\n'), /Antigravity: .*include/)
  assert.equal(ls(g(home)).length, 0)
  const kit2 = miniKit()
  fs.rmSync(path.join(kit2, 'CLAUDE.md'))
  const r2 = await run(withGemini(tmp()), kit2)
  assert.equal(r2.code, 1)
  assert.match(r2.problems.join('\n'), /Antigravity: kit thiếu CLAUDE\.md/)
})

// ---------- không đụng Claude / Codex; quyền của agy: chỉ THÊM luật chặn đọc file khoá, không bỏ/mở luật nào ----------

const SETTINGS = ['antigravity-cli', 'settings.json']
const DENY_READ = ['read_file(*/.env*)', 'read_file(*/.dev.vars)', 'read_file(*/.mcp.json)', 'read_file(*.pem)', 'read_file(*.key)']

test('thêm Antigravity không đổi settings.json của Claude, không đụng ~/.codex; quyền của agy: GIỮ mọi luật cũ (kể cả chặn command(*)), chỉ thêm luật chặn đọc file khoá còn thiếu, có bản sao trước', async () => {
  const home = tmp(); const kit = miniKit()
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  const first = await run(home, kit) // chưa có ~/.gemini ⇒ chỉ Claude + Codex
  assert.equal(first.code, 0, first.out)
  const claudeBefore = tree(path.join(home, '.claude'), (rel) => rel.startsWith('cache/'))
  const codexBefore = tree(path.join(home, '.codex'))
  const orig = { ui: { theme: 'x' }, permissions: { deny: ['command(*)', 'write_file(*)', 'mcp(*)', 'read_file(*/.env*)', 'read_file(*/Note/*)'], ask: ['command(git push*)'], allow: ['read_file(*)'] } }
  const origText = JSON.stringify(orig, null, 2)
  wr(path.join(g(home), ...SETTINGS), origText)
  const r = await run(home, kit, { stamp: '20261128200000' })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(tree(path.join(home, '.claude'), (rel) => rel.startsWith('cache/')), claudeBefore, 'Claude không đổi')
  assert.deepEqual(tree(path.join(home, '.codex')), codexBefore, 'Codex không đổi')
  assert.ok(r.changed.includes('agy: antigravity-cli/settings.json'), r.out)
  const now = json(g(home), ...SETTINGS)
  assert.deepEqual(now.permissions.deny, [...orig.permissions.deny, 'read_file(*/.dev.vars)', 'read_file(*/.mcp.json)', 'read_file(*.pem)', 'read_file(*.key)'], 'luật cũ đứng nguyên thứ tự, luật thiếu thêm vào cuối')
  assert.deepEqual(now.permissions.allow, orig.permissions.allow)
  assert.deepEqual(now.permissions.ask, orig.permissions.ask)
  assert.deepEqual(now.ui, orig.ui)
  assert.equal(rd(g(home), 'backup-vibe-flow-20261128200000', '.gemini', ...SETTINGS), origText, 'bản sao nguyên văn trước khi sửa')
  assert.match(r.out, /đang chặn command\(\*\), write_file\(\*\), mcp\(\*\) nên agy chưa chạy lệnh\/ghi file\/dùng sổ chốt được\. Kit không tự mở quyền/)
  assert.match(r.out, /Antigravity IDE \(app\) có cấu hình riêng/)
  const before = tree(g(home))
  const again = await run(home, kit, { stamp: '20261128210000' })
  assert.deepEqual(again.changed, [], again.out)
  assert.deepEqual(tree(g(home)), before, 'lần 2 không đổi, không thêm bản sao')
})

test('quyền của agy: chưa có settings.json ⇒ tạo với đủ luật chặn đọc file khoá; đã đủ luật ⇒ KHÔNG ghi lại (nội dung và định dạng nguyên)', async () => {
  const home = withGemini(tmp()); const kit = miniKit()
  const r = await run(home, kit)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(json(g(home), ...SETTINGS), { permissions: { deny: DENY_READ } })
  assert.ok(r.changed.includes('agy: antigravity-cli/settings.json'))
  const full = '{"permissions":{"deny":["read_file(*.key)","read_file(*/.mcp.json)","read_file(*/.env*)","read_file(*/.dev.vars)","read_file(*.pem)","command(*)"]}}'
  const home2 = withGemini(tmp())
  wr(path.join(g(home2), ...SETTINGS), full)
  const r2 = await run(home2, kit)
  assert.equal(r2.code, 0, r2.out)
  assert.equal(rd(g(home2), ...SETTINGS), full, 'đã đủ luật ⇒ giữ nguyên từng byte')
  assert.equal(r2.changed.includes('agy: antigravity-cli/settings.json'), false)
  assert.equal(fs.existsSync(path.join(g(home2), `backup-vibe-flow-${STAMP}`, '.gemini', ...SETTINGS)), false)
})

test('quyền của agy: file là {} hoặc thiếu permissions/deny ⇒ thêm đúng phần thiếu, giữ khoá khác', async () => {
  for (const [text, expected] of [
    ['{}', { permissions: { deny: DENY_READ } }],
    ['{"permissions":{}}', { permissions: { deny: DENY_READ } }],
    ['{"permissions":{"allow":["read_file(*)"]},"x":1}', { permissions: { allow: ['read_file(*)'], deny: DENY_READ }, x: 1 }],
    ['{"permissions":{"deny":[]}}', { permissions: { deny: DENY_READ } }],
  ]) {
    const home = withGemini(tmp()); const kit = miniKit()
    wr(path.join(g(home), ...SETTINGS), text)
    const r = await run(home, kit)
    assert.equal(r.code, 0, `${text}: ${r.out}`)
    assert.deepEqual(json(g(home), ...SETTINGS), expected, text)
  }
})

test('quyền của agy hỏng (JSON lỗi, không phải object, permissions/deny sai kiểu) ⇒ báo lỗi rõ, không ghi gì cho Antigravity, file không bị đụng', async () => {
  for (const [text, re] of [
    ['{hỏng', /settings\.json không phải JSON hợp lệ/], ['[1]', /settings\.json không phải một object JSON/],
    ['{"permissions":[]}', /"permissions" trong settings\.json của agy không phải object/], ['{"permissions":{"deny":"command(*)"}}', /"permissions\.deny" trong settings\.json của agy không phải danh sách/],
  ]) {
    const home = withGemini(tmp()); const kit = miniKit()
    wr(path.join(g(home), ...SETTINGS), text)
    const r = await run(home, kit)
    assert.equal(r.code, 1, `${text}: ${r.out}`)
    assert.match(r.problems.join('\n'), re, text)
    assert.equal(fs.existsSync(path.join(g(home), 'AGENTS.md')), false, 'chưa ghi AGENTS.md khi còn lỗi')
    assert.equal(rd(g(home), ...SETTINGS), text)
  }
})

// ---------- giữ quyền truy cập của file gốc khi ghi đè (posix) ----------

test('ghi đè giữ nguyên quyền file gốc: 0600 / 0640 dưới umask 022 không bị nới thành 0644', { skip: process.platform === 'win32' ? 'Windows không có quyền kiểu posix' : false }, async () => {
  const oldMask = process.umask(0o022)
  try {
    const home = withGemini(tmp()); const kit = miniKit()
    const files = [
      [path.join(g(home), 'config', 'mcp_config.json'), '{"mcpServers":{"x":{"command":"a","env":{"T":"bi-mat"}}}}\n', 0o600],
      [path.join(g(home), 'config', 'hooks.json'), '{}\n', 0o640],
      [path.join(g(home), 'AGENTS.md'), '# luật riêng\n', 0o600],
      [path.join(g(home), ...SETTINGS), '{"permissions":{"deny":["command(*)"]}}\n', 0o600],
      [path.join(home, '.claude', 'settings.json'), '{"env":{"K":"v"}}\n', 0o600],
    ]
    for (const [f, text, mode] of files) { wr(f, text); fs.chmodSync(f, mode) }
    const r = await run(home, kit)
    assert.equal(r.code, 0, r.out)
    for (const [f, , mode] of files) assert.equal(fs.statSync(f).mode & 0o777, mode, `${path.relative(home, f)} phải giữ ${mode.toString(8)}`)
    // lần 2 (không đổi) cũng không đổi quyền; file mới tạo dùng quyền mặc định của umask
    await run(home, kit, { stamp: '20261128220000' })
    for (const [f, , mode] of files) assert.equal(fs.statSync(f).mode & 0o777, mode)
    assert.equal(fs.statSync(path.join(g(home), 'config', 'agents', 'coder.md')).mode & 0o777, 0o644)
  } finally {
    process.umask(oldMask)
  }
})

// ---------- Codex: vai không khai models.codex ----------

test('Codex: vai có trong kit/roles.json nhưng không khai models.codex ⇒ bỏ qua êm (không TOML, không báo); vai khác vẫn có TOML; code 0', async () => {
  const reg = JSON.parse(rd(HERE, 'kit', 'roles.json'))
  delete reg.roles.recon.models.codex
  const home = tmp(); const kit = miniKit({ roles: JSON.stringify(reg) })
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  const lines = []
  const r = await install({
    home, kitDir: kit, env: { PATH: emptyBin, VIBE_FLOW_PATH_ONLY: '1' }, log: (l) => lines.push(l), stamp: STAMP,
    models: { catalog: { codex: { fetched_at: '2026-10-11T11:00:00Z', models: [{ slug: 'gpt-6.1-sol', display_name: 'gpt-6.1-sol', visibility: 'list', priority: 1, default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map((effort) => ({ effort, description: 'x' })), upgrade: null }] } } },
    checkAll: async () => ({}), hasRg: true,
  })
  const out = lines.join('\n')
  assert.equal(r.code, 0, out)
  assert.deepEqual(ls(path.join(home, '.codex', 'agents')), ['coder.toml'])
  assert.doesNotMatch(out, /Bỏ qua vai recon/)
  assert.equal(r.notes.some((n) => /recon/.test(n)), false)
})

// ---------- hàm thuần ----------

test('mergeAgyHooks: thay đúng khoá của kit, giữ khoá khác và thứ tự; không sửa đối tượng vào; null ⇒ chỉ của kit', () => {
  const kit = { 'vibe-flow': { Stop: [{ type: 'command', command: 'node a' }] } }
  const cur = Object.freeze({ a: { x: 1 }, 'vibe-flow': { cu: true }, b: { y: 2 } })
  const out = mergeAgyHooks(cur, kit)
  assert.deepEqual(out, { a: { x: 1 }, 'vibe-flow': kit['vibe-flow'], b: { y: 2 } })
  assert.deepEqual(Object.keys(out), ['a', 'vibe-flow', 'b'])
  assert.deepEqual(mergeAgyHooks(null, kit), kit)
  assert.deepEqual(Object.keys(mergeAgyHooks({ z: {} }, kit)), ['z', 'vibe-flow'])
})

test('mergeAgyMcp: thêm/thay một máy chủ, giữ máy chủ khác và khoá khác; mcpServers không phải object ⇒ lỗi', () => {
  const srv = { command: 'node', args: ['x.mjs'] }
  assert.deepEqual(mergeAgyMcp(null, 'so-chot', srv), { mcpServers: { 'so-chot': srv } })
  assert.deepEqual(mergeAgyMcp({ k: 1 }, 'so-chot', srv), { k: 1, mcpServers: { 'so-chot': srv } })
  const cur = Object.freeze({ mcpServers: Object.freeze({ a: { command: 'a' }, 'so-chot': { command: 'cu' } }), k: 1 })
  const out = mergeAgyMcp(cur, 'so-chot', srv)
  assert.deepEqual(out, { mcpServers: { a: { command: 'a' }, 'so-chot': srv }, k: 1 })
  assert.deepEqual(Object.keys(out.mcpServers), ['a', 'so-chot'])
  assert.throws(() => mergeAgyMcp({ mcpServers: [] }, 'so-chot', srv), /không phải object/)
  assert.throws(() => mergeAgyMcp({ mcpServers: 'x' }, 'so-chot', srv), /không phải object/)
})

test('spliceAgents dùng cho agy: GEMINI-style file có khối VIBE-FLOW cũ ⇒ thay tại chỗ, giữ chữ hai bên', () => {
  const blk = (v) => `${START}\n<!-- ${GENERATED} -->\n${v}\n<!-- VIBE-FLOW:END -->\n`
  const text = `# đầu\n\n${blk('v1')}\n# cuối\n`
  const out = spliceAgents(text, blk('v2'))
  assert.ok(out.text.startsWith('# đầu\n\n') && out.text.includes('v2') && !out.text.includes('v1') && out.text.includes('# cuối'))
})
