// Test cho lib/skills-check.mjs + kit/official.json + skills-check.mjs: node --test hooks/lib/skills-check.test.mjs
// Mọi thứ chạy trên HOME giả + dự án tạm (opts.home / opts.env), không đọc ~/.claude.json hay ~/.codex thật.
// Khoá giả ghép lúc chạy (nối chuỗi) để chính file này không chứa token nguyên văn — tránh tự bị cổng quét secret chặn khi commit.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, parseToml, loadOfficial } from './skills-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'skills-check.mjs')
const OFFICIAL_FILE = path.join(HERE, '..', '..', 'kit', 'official.json')

const STRIPE_LIVE = 'sk_' + 'live_' + 'Ab3dEf6hIj9lMn2pQr5tUv8x'
const STRIPE_TEST = 'sk_' + 'test_' + 'Ab3dEf6hIj9lMn2pQr5tUv8x'
const SBP = 'sbp' + '_' + '0123456789abcdef0123456789abcdef01234567'
const PLAIN = 'Zq8' + 'Lm2Xv9Rt4Wn7Yp1Hc5' // không khớp mẫu nào: chỉ bắt được nhờ tên khoá (token/key…)
const REF_DEV = 'devrefdevrefdevref00'
const REF_PROD = 'prodrefprodrefprod00'
const REF_NEW = 'newrefnewrefnewref00'

const LIBS = ['cloudflare', 'supabase', 'shadcn', 'stripe', 'playwright', 'vercel', 'neon', 'sentry', 'go', 'wails']
const STATUS = ['installed', 'missing', 'community-only', 'none']
const USABLE = ['ok', 'needs-login', 'misconfigured', 'unknown']

const roots = []
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-check-')))
  roots.push(root)
  const sb = { root, home: path.join(root, 'home'), proj: path.join(root, 'proj'), bin: path.join(root, 'bin') }
  fs.mkdirSync(path.join(sb.proj, '.git'), { recursive: true })
  fs.mkdirSync(sb.home, { recursive: true })
  fs.mkdirSync(sb.bin, { recursive: true })
  sb.put = (abs, content) => {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
    return abs
  }
  sb.skill = (base, dir, name, { md = true } = {}) => {
    const d = path.join(base, dir, 'skills', name)
    fs.mkdirSync(d, { recursive: true })
    if (md) fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
  }
  sb.claudeJson = (obj) => sb.put(path.join(sb.home, '.claude.json'), obj)
  sb.mcpJson = (obj, dir = sb.proj) => sb.put(path.join(dir, '.mcp.json'), obj)
  sb.codexToml = (text) => sb.put(path.join(sb.home, '.codex', 'config.toml'), text)
  sb.flowJson = (obj) => sb.put(path.join(sb.proj, '.claude', 'flow.json'), obj)
  sb.cmd = (name) => {
    const f = path.join(sb.bin, process.platform === 'win32' ? `${name}.cmd` : name)
    fs.writeFileSync(f, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 })
  }
  sb.opts = (envExtra = {}, extra = {}) => ({ home: sb.home, env: { PATH: sb.bin, ...envExtra }, ...extra })
  sb.rows = (host = 'claude', envExtra = {}, extra = {}) => check(sb.proj, host, sb.opts(envExtra, extra))
  sb.by = (host, envExtra, extra) => Object.fromEntries(sb.rows(host, envExtra, extra).map((r) => [r.lib, r]))
  return sb
}

// ---------------------------------------------------------------- kit/official.json (file THẬT)

describe('kit/official.json', () => {
  const off = JSON.parse(fs.readFileSync(OFFICIAL_FILE, 'utf8'))
  const libs = Object.keys(off).filter((k) => !k.startsWith('_'))

  test('đủ thư viện của brief, mỗi cái có sourceOrg + note', () => {
    for (const l of LIBS) assert.ok(libs.includes(l), `thiếu ${l}`)
    for (const l of libs) {
      assert.equal(typeof off[l].sourceOrg, 'string', `${l}.sourceOrg`)
      assert.ok(off[l].sourceOrg.length > 0)
      assert.ok(typeof off[l].note === 'string' && off[l].note.length > 0, `${l}.note`)
    }
  })

  test('Go và Wails: không có skill, không có MCP, note nói rõ "không có"', () => {
    for (const l of ['go', 'wails']) {
      assert.equal(off[l].skill ?? null, null)
      assert.equal(off[l].mcp ?? null, null)
      assert.match(off[l].note, /không có/i)
    }
  })

  test('lib có skill thì có repo + installCmd; lib có mcp thì có installCmd cho cả claude lẫn codex', () => {
    for (const l of libs) {
      if (off[l].skill) {
        assert.match(off[l].skill.repo, /^[\w.-]+\/[\w.-]+$/, `${l}.skill.repo`)
        assert.ok(Array.isArray(off[l].skill.names))
        assert.ok(off[l].skill.installCmd.length > 0)
      }
      if (off[l].mcp) {
        assert.ok(off[l].mcp.hosts?.length || off[l].mcp.packages?.length, `${l}.mcp thiếu cách nhận ra`)
        assert.ok(off[l].mcp.installCmd.claude && off[l].mcp.installCmd.codex, `${l}.mcp.installCmd`)
      }
    }
  })

  test('URL trong lệnh cài MCP phải thuộc tên miền đã khai (chống gõ nhầm / giả mạo)', () => {
    for (const l of libs) {
      const mcp = off[l].mcp
      if (!mcp) continue
      for (const cmd of Object.values(mcp.installCmd)) {
        for (const u of cmd.match(/https?:\/\/[^\s"']+/g) ?? []) {
          const host = new URL(u).hostname
          assert.ok((mcp.hosts ?? []).some((h) => host === h || host.endsWith(`.${h}`)), `${l}: ${host} không nằm trong hosts`)
        }
      }
    }
  })

  test('Supabase chỉ cài với read_only=true và project_ref; guard bật cho supabase + stripe', () => {
    for (const cmd of Object.values(off.supabase.mcp.installCmd)) {
      assert.match(cmd, /read_only=true/)
      assert.match(cmd, /project_ref=/)
    }
    assert.equal(off.supabase.mcp.guard, 'supabase')
    assert.equal(off.stripe.mcp.guard, 'stripe')
  })

  test('loadOfficial() đọc đúng file này, bỏ khoá _doc', () => {
    const l = loadOfficial()
    assert.deepEqual(Object.keys(l).sort(), libs.sort())
  })
})

// ---------------------------------------------------------------- parseToml

describe('parseToml (tối thiểu, đủ cho [mcp_servers.*])', () => {
  test('bảng, bảng con, chuỗi basic/literal, mảng nhiều dòng, inline table, bool, số, chú thích', () => {
    const { data, errors } = parseToml(String.raw`# chú thích đầu file
model = "gpt-5"   # chú thích cuối dòng
approval = 'on-request'
[mcp_servers.supa]
command = "npx"
args = [
  "-y",   # trong mảng
  "@supabase/mcp-server-supabase@latest",
  '--read-only',
]
startup_timeout_sec = 30
enabled = true
[mcp_servers.supa.env]
SUPABASE_ACCESS_TOKEN = "${"$"}{X}"
[mcp_servers."quoted.name"]
url = "https://example.test/mcp"
http_headers = { "X-One" = "1", Two = "b c" }
[projects.'C:\Users\x\proj']
trust_level = "trusted"
`)
    assert.deepEqual(errors, [])
    assert.equal(data.model, 'gpt-5')
    assert.equal(data.approval, 'on-request')
    assert.deepEqual(data.mcp_servers.supa.args, ['-y', '@supabase/mcp-server-supabase@latest', '--read-only'])
    assert.equal(data.mcp_servers.supa.startup_timeout_sec, 30)
    assert.equal(data.mcp_servers.supa.enabled, true)
    assert.equal(data.mcp_servers.supa.env.SUPABASE_ACCESS_TOKEN, '${X}')
    assert.equal(data.mcp_servers['quoted.name'].url, 'https://example.test/mcp')
    assert.deepEqual({ ...data.mcp_servers['quoted.name'].http_headers }, { 'X-One': '1', Two: 'b c' })
    assert.equal(data.projects['C:\\Users\\x\\proj'].trust_level, 'trusted')
  })

  test('khoá chấm trong dòng, escape trong chuỗi, chuỗi nhiều dòng, mảng bảng [[...]]', () => {
    const { data, errors } = parseToml('mcp_servers.a.command = "node"\ns = "tab\\there \\"q\\" \\u0041"\nm = """\nline1\nline2"""\n[[hooks]]\nname = "h1"\n[[hooks]]\nname = "h2"\n')
    assert.deepEqual(errors, [])
    assert.equal(data.mcp_servers.a.command, 'node')
    assert.equal(data.s, 'tab\there "q" A')
    assert.equal(data.m, 'line1\nline2')
    assert.deepEqual(data.hooks.map((h) => h.name), ['h1', 'h2'])
  })

  test('dòng hỏng: ghi lỗi (có số dòng), phần còn lại vẫn đọc được', () => {
    const { data, errors } = parseToml('a = 1\nthis is not toml\n[mcp_servers.ok]\ncommand = "node"\nb = = 2\nc = "z"\n')
    assert.equal(data.a, 1)
    assert.equal(data.mcp_servers.ok.command, 'node')
    assert.equal(data.mcp_servers.ok.c, 'z')
    assert.deepEqual(errors.map((e) => e.line), [2, 5])
  })

  test('khoá __proto__ không làm ô nhiễm Object.prototype', () => {
    parseToml('[__proto__]\npolluted = true\n[mcp_servers.__proto__]\nx = 1\n')
    assert.equal({}.polluted, undefined)
    assert.equal({}.x, undefined)
  })

  test('file rỗng / chỉ chú thích / có BOM', () => {
    assert.deepEqual(parseToml('').errors, [])
    assert.deepEqual(parseToml('\uFEFF# x\n').errors, [])
    assert.equal(parseToml('\uFEFFa = 1\n').data.a, 1)
  })
})

// ---------------------------------------------------------------- check: hình dạng đầu ra

describe('check: hợp đồng đầu ra', () => {
  test('máy trống: một dòng cho mỗi thư viện, đủ trường, giá trị nằm trong tập cho phép', () => {
    const sb = sandbox()
    const rows = sb.rows('claude')
    assert.deepEqual(rows.map((r) => r.lib).sort(), [...LIBS].sort())
    for (const r of rows) {
      assert.ok(STATUS.includes(r.status), `${r.lib} status ${r.status}`)
      assert.ok(USABLE.includes(r.usable), `${r.lib} usable ${r.usable}`)
      assert.ok(['dev', 'prod', 'unknown'].includes(r.scope.env))
      assert.ok(Array.isArray(r.problems) && Array.isArray(r.warnings))
      assert.ok('installCmd' in r)
    }
  })

  test('máy trống: thư viện có bản chính hãng ⇒ missing + lệnh cài; Go/Wails ⇒ none, không lệnh cài', () => {
    const by = sandbox().by('claude')
    for (const l of ['cloudflare', 'supabase', 'shadcn', 'stripe', 'playwright', 'vercel', 'neon', 'sentry']) {
      assert.equal(by[l].status, 'missing', l)
      assert.equal(typeof by[l].installCmd, 'string')
      assert.ok(by[l].installCmd.length > 0)
    }
    for (const l of ['go', 'wails']) {
      assert.equal(by[l].status, 'none')
      assert.equal(by[l].installCmd, null)
    }
    assert.equal(by.shadcn.installCmd, loadOfficial().shadcn.skill.installCmd, 'có cả skill lẫn MCP ⇒ ưu tiên lệnh cài skill (AC-32)')
    assert.match(by.shadcn.installAlt, /mcp/)
  })

  test('lệnh cài MCP theo app: claude khác codex', () => {
    const sb = sandbox()
    const off = { onlymcp: { sourceOrg: 'x', note: 'n', skill: null, mcp: { hosts: ['mcp.example.test'], installCmd: { claude: 'claude mcp add x', codex: 'codex mcp add x' } } } }
    assert.equal(sb.rows('claude', {}, { official: off })[0].installCmd, 'claude mcp add x')
    assert.equal(sb.rows('codex', {}, { official: off })[0].installCmd, 'codex mcp add x')
  })

  test('libs: chỉ trả các thư viện được hỏi', () => {
    const rows = sandbox().rows('claude', {}, { libs: ['go', 'neon'] })
    assert.deepEqual(rows.map((r) => r.lib), ['go', 'neon'])
  })

  test('host / thư viện không hỗ trợ ⇒ ném lỗi rõ (kể cả tên trùng khoá của Object)', () => {
    assert.throws(() => sandbox().rows('vim'), /host/)
    assert.throws(() => sandbox().rows('constructor'), /host/)
    assert.throws(() => sandbox().rows('claude', {}, { libs: ['nonexistent'] }), /thư viện/)
    assert.throws(() => sandbox().rows('claude', {}, { libs: ['__proto__'] }), /thư viện/)
  })
})

// ---------------------------------------------------------------- check: skill

describe('check: skill', () => {
  test('Claude: ~/.claude/skills và <dự án>/.claude/skills; cần SKILL.md', () => {
    const sb = sandbox()
    sb.skill(sb.home, '.claude', 'supabase')
    sb.skill(sb.proj, '.claude', 'shadcn')
    sb.skill(sb.proj, '.claude', 'stripe-docs', { md: false }) // thư mục rỗng không tính
    const by = sb.by('claude')
    assert.equal(by.supabase.status, 'installed')
    assert.deepEqual(by.supabase.found.skills, ['supabase'])
    assert.equal(by.supabase.usable, 'ok')
    assert.deepEqual(by.supabase.parts, { skill: 'ok' })
    assert.equal(by.supabase.installCmd, null)
    assert.equal(by.shadcn.status, 'installed')
    assert.equal(by.stripe.status, 'missing')
  })

  test('Codex đọc ~/.agents/skills và <dự án>/.agents/skills, KHÔNG đọc .claude/skills (và ngược lại)', () => {
    const sb = sandbox()
    sb.skill(sb.home, '.agents', 'cloudflare')
    sb.skill(sb.proj, '.claude', 'supabase')
    const codex = sb.by('codex')
    const claude = sb.by('claude')
    assert.equal(codex.cloudflare.status, 'installed')
    assert.equal(codex.supabase.status, 'missing')
    assert.equal(claude.supabase.status, 'installed')
    assert.equal(claude.cloudflare.status, 'missing')
    assert.deepEqual(claude.cloudflare.found.skills, [])
  })

  test('Devin đọc cả bốn thư mục skill', () => {
    const sb = sandbox()
    sb.skill(sb.home, '.agents', 'cloudflare')
    sb.skill(sb.proj, '.claude', 'supabase')
    const by = sb.by('devin')
    assert.equal(by.cloudflare.status, 'installed')
    assert.equal(by.supabase.status, 'installed')
  })

  test('chạy từ thư mục con: đi lên tới gốc repo (có .git) để tìm skill và .mcp.json', () => {
    const sb = sandbox()
    sb.skill(sb.proj, '.claude', 'shadcn')
    sb.cmd('npx')
    sb.mcpJson({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp@latest'] } } })
    const sub = path.join(sb.proj, 'apps', 'web')
    fs.mkdirSync(sub, { recursive: true })
    const by = Object.fromEntries(check(sub, 'claude', sb.opts()).map((r) => [r.lib, r]))
    assert.equal(by.shadcn.status, 'installed')
    assert.equal(by.playwright.status, 'installed')
  })

  test('không đi lên quá gốc repo: skill ở thư mục cha của repo bị bỏ qua', () => {
    const sb = sandbox()
    sb.skill(sb.root, '.claude', 'shadcn') // root là cha của proj (proj có .git)
    assert.equal(sb.by('claude').shadcn.status, 'missing')
  })
})

// ---------------------------------------------------------------- check: MCP Claude

describe('check: MCP của Claude', () => {
  test('stdio chính hãng + lệnh tìm thấy trên PATH ⇒ installed, ok', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } })
    const r = sb.by('claude').playwright
    assert.equal(r.status, 'installed')
    assert.equal(r.usable, 'ok')
    assert.deepEqual(r.found.servers, ['playwright'])
    assert.deepEqual(r.problems, [])
    assert.equal(r.installCmd, null)
  })

  test('stdio nhưng lệnh không có trên máy ⇒ misconfigured (chỉ nêu tên server, không in lệnh)', () => {
    const sb = sandbox() // không tạo npx
    sb.claudeJson({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } })
    const r = sb.by('claude').playwright
    assert.equal(r.status, 'installed')
    assert.equal(r.usable, 'misconfigured')
    assert.ok(r.problems.some((p) => p.includes('"playwright"')))
    assert.ok(!r.problems.join('\n').includes('npx'))
  })

  test('lệnh là đường dẫn: tính từ thư mục dự án; có file ⇒ ok, không có ⇒ misconfigured', () => {
    const sb = sandbox()
    const rel = path.join('tools', 'npx.cmd')
    sb.mcpJson({ mcpServers: { pw: { command: `.${path.sep}${rel}`, args: ['@playwright/mcp'] } } })
    assert.equal(sb.by('claude').playwright.usable, 'misconfigured')
    sb.put(path.join(sb.proj, rel), '#!/bin/sh\n')
    fs.chmodSync(path.join(sb.proj, rel), 0o755)
    assert.equal(sb.by('claude').playwright.usable, 'ok')
  })

  test('server trong projects[<dự án>] (khoá dùng / hoặc \\) được đọc; server của dự án khác bị bỏ qua', () => {
    const sb = sandbox()
    sb.cmd('npx')
    const pw = { command: 'npx', args: ['@playwright/mcp@latest'] }
    sb.claudeJson({
      projects: {
        [sb.proj.replace(/\\/g, '/')]: { mcpServers: { mine: pw } },
        [path.join(sb.root, 'other')]: { mcpServers: { theirs: { command: 'npx', args: ['@sentry/mcp-server'] } } },
      },
    })
    const by = sb.by('claude')
    assert.deepEqual(by.playwright.found.servers, ['mine'])
    assert.equal(by.sentry.status, 'missing')
  })

  test('.mcp.json của dự án được đọc', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.mcpJson({ mcpServers: { shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] } } })
    const r = sb.by('claude').shadcn
    assert.equal(r.status, 'installed')
    assert.deepEqual(r.parts, { mcp: 'ok' })
  })

  test('shadcn CLI thường (không có đối số mcp) KHÔNG phải MCP chính hãng', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.mcpJson({ mcpServers: { shadcn: { command: 'npx', args: ['shadcn@latest', 'add', 'button'] } } })
    assert.notEqual(sb.by('claude').shadcn.status, 'installed')
  })

  test('mcp-remote bọc URL Cloudflare vẫn nhận ra chính hãng (tên miền con)', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { cf: { command: 'npx', args: ['-y', 'mcp-remote', 'https://docs.mcp.cloudflare.com/mcp'] } } })
    assert.equal(sb.by('claude').cloudflare.status, 'installed')
  })

  test('nhận ra theo ĐÍCH THẬT, không theo tên: tên giả "supabase" trỏ nơi khác ⇒ community-only', () => {
    const sb = sandbox()
    sb.claudeJson({
      mcpServers: {
        supabase: { type: 'http', url: 'https://mcp.supabase.com.evil.example/mcp' },
        sentry: { type: 'http', url: 'https://evil.example/mcp.sentry.dev' },
        neon: { type: 'http', url: 'https://mcp.neon.tech@evil.example/mcp' },
        stripe: { command: 'npx', args: ['@evil/mcp'] },
      },
    })
    const by = sb.by('claude')
    for (const l of ['supabase', 'sentry', 'neon', 'stripe']) {
      assert.equal(by[l].status, 'community-only', l)
      assert.ok(by[l].warnings.length > 0)
      assert.ok(by[l].installCmd)
    }
  })

  test('gói npm giả cùng tên gốc không phải chính hãng; gói thật có @version thì nhận', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { a: { command: 'npx', args: ['-y', '@evil/mcp-server-supabase'] }, b: { command: 'npx', args: ['-y', '@sentry/mcp-server@1.2.3'] } } })
    const by = sb.by('claude')
    assert.equal(by.supabase.status, 'community-only')
    assert.equal(by.sentry.status, 'installed')
  })

  test('file cấu hình hỏng: không ném lỗi, báo cảnh báo (tên file), không lộ nội dung', () => {
    const sb = sandbox()
    sb.put(path.join(sb.home, '.claude.json'), `{"mcpServers": {"x": {"env": {"K": "${STRIPE_LIVE}"}}, oops`)
    const rows = sb.rows('claude')
    assert.equal(rows.length, LIBS.length)
    const cf = rows.find((r) => r.lib === 'cloudflare')
    assert.equal(cf.status, 'missing')
    assert.ok(cf.warnings.some((w) => w.includes('.claude.json')))
    assert.ok(!JSON.stringify(rows).includes(STRIPE_LIVE))
  })

  test('Claude không đọc ~/.codex/config.toml', () => {
    const sb = sandbox()
    sb.codexToml('[mcp_servers.pw]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n')
    sb.cmd('npx')
    assert.equal(sb.by('claude').playwright.status, 'missing')
  })

  test('tên server lạ (xuống dòng, ký tự điều khiển, markdown) được làm sạch trong problems', () => {
    const sb = sandbox()
    sb.claudeJson({ mcpServers: { 'evil\n## Injected\u001b[31m': { type: 'http', url: 'https://mcp.vercel.com', headers: { Authorization: 'Bearer ' + PLAIN } } } })
    const r = sb.by('claude').vercel
    assert.equal(r.usable, 'misconfigured')
    const text = [...r.problems, ...r.found.servers].join('|')
    assert.ok(!/[\n\r\u001b]/.test(text))
  })
})

// ---------------------------------------------------------------- check: khoá gõ thẳng

describe('check: khoá gõ thẳng ⇒ misconfigured, chỉ in tên server', () => {
  const stripeWith = (sb, server) => {
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { 'my-stripe': { command: 'npx', args: ['-y', '@stripe/mcp'], ...server } } })
    return sb.by('claude').stripe
  }
  const expectLeaked = (r, ...secrets) => {
    assert.equal(r.usable, 'misconfigured')
    assert.ok(r.problems.some((p) => p.includes('"my-stripe"') && /khoá|gõ thẳng/i.test(p)), JSON.stringify(r.problems))
    const dump = JSON.stringify(r)
    for (const s of secrets) {
      assert.ok(!dump.includes(s), 'đã lộ khoá')
      assert.ok(!dump.includes(s.slice(0, 6)), 'đã lộ đầu khoá')
    }
  }

  test('mẫu của secrets.mjs trong env (Stripe live)', () => {
    expectLeaked(stripeWith(sandbox(), { env: { STRIPE_SECRET_KEY: STRIPE_LIVE } }), STRIPE_LIVE)
  })

  test('khoá mẫu trong args, header, query của URL', () => {
    expectLeaked(stripeWith(sandbox(), { args: ['-y', '@stripe/mcp', `--api-key=${STRIPE_LIVE}`] }), STRIPE_LIVE)
    const sb = sandbox()
    sb.claudeJson({ mcpServers: { 'my-stripe': { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: `Bearer ${STRIPE_LIVE}` } } } })
    expectLeaked(sb.by('claude').stripe, STRIPE_LIVE)
    const sb2 = sandbox()
    sb2.claudeJson({ mcpServers: { 'my-stripe': { type: 'http', url: `https://mcp.stripe.com/?key=${STRIPE_LIVE}` } } })
    expectLeaked(sb2.by('claude').stripe, STRIPE_LIVE)
  })

  test('khoá không có mẫu riêng nhưng nằm ở khoá tên token/key/secret (env, --flag=, --flag giá trị, header, query)', () => {
    expectLeaked(stripeWith(sandbox(), { env: { MY_API_TOKEN: PLAIN } }), PLAIN)
    expectLeaked(stripeWith(sandbox(), { args: ['-y', '@stripe/mcp', `--access-token=${PLAIN}`] }), PLAIN)
    expectLeaked(stripeWith(sandbox(), { args: ['-y', '@stripe/mcp', '--api-key', PLAIN] }), PLAIN)
    const sb = sandbox()
    sb.claudeJson({ mcpServers: { 'my-stripe': { type: 'http', url: 'https://mcp.stripe.com', headers: { 'X-Api-Key': PLAIN } } } })
    expectLeaked(sb.by('claude').stripe, PLAIN)
    const sb2 = sandbox()
    sb2.claudeJson({ mcpServers: { 'my-stripe': { type: 'http', url: `https://mcp.stripe.com/mcp?api_key=${PLAIN}` } } })
    expectLeaked(sb2.by('claude').stripe, PLAIN)
  })

  test('khoá Supabase kiểu sbp_ (không có trong secrets.mjs) nằm ở vị trí tuỳ ý trong args', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { 'my-stripe': { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase', '--read-only', SBP] } } })
    const r = sb.by('claude').supabase
    assert.equal(r.usable, 'misconfigured')
    assert.ok(!JSON.stringify(r).includes('sbp_'))
  })

  test('URL có user:mật khẩu@ ⇒ gõ thẳng', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { other: { command: 'npx', args: ['mcp-remote', 'https://admin:' + PLAIN + '@mcp.sentry.dev/mcp'] } } })
    const r = sb.by('claude').sentry
    assert.equal(r.usable, 'misconfigured')
    assert.ok(!JSON.stringify(r).includes(PLAIN))
  })

  test('KHÔNG báo: ${VAR}, placeholder, URL/đường dẫn ở khoá tên token, giá trị ngắn', () => {
    const sb = sandbox()
    const r = stripeWith(sb, {
      env: { STRIPE_SECRET_KEY: '${STRIPE_KEY}', MY_TOKEN: '<your-token-here>', TOKEN_URL: 'https://auth.example.test/token', TOKEN_FILE: '/etc/tok', API_KEY: 'changeme', OTHER_KEY: 'on' },
      args: ['-y', '@stripe/mcp', '--tools=all', '--api-key=${STRIPE_KEY}'],
    })
    assert.ok(!r.problems.some((p) => /gõ thẳng/.test(p)), JSON.stringify(r.problems))
  })
})

// ---------------------------------------------------------------- check: biến môi trường tham chiếu

describe('check: biến ${VAR} được tham chiếu', () => {
  test('biến tên khoá/token có giá trị ⇒ ok; chưa có ⇒ needs-login + nêu tên biến', () => {
    const sb = sandbox()
    sb.claudeJson({ mcpServers: { s: { type: 'http', url: 'https://mcp.vercel.com', headers: { Authorization: 'Bearer ${VERCEL_TOKEN}' } } } })
    assert.equal(sb.by('claude', { VERCEL_TOKEN: 'v' }).vercel.usable, 'ok')
    const r = sb.by('claude').vercel
    assert.equal(r.usable, 'needs-login')
    assert.ok(r.problems.some((p) => p.includes('VERCEL_TOKEN')))
    assert.equal(sb.by('claude', { VERCEL_TOKEN: '' }).vercel.usable, 'needs-login', 'biến rỗng coi như chưa có')
  })

  test('biến không phải khoá (vd tên project) chưa có ⇒ misconfigured; có giá trị mặc định ${X:-d} ⇒ coi là có', () => {
    const sb = sandbox()
    sb.claudeJson({ mcpServers: { s: { type: 'http', url: 'https://mcp.vercel.com/${VERCEL_PROJECT}' } } })
    assert.equal(sb.by('claude').vercel.usable, 'misconfigured')
    assert.equal(sb.by('claude', { VERCEL_PROJECT: 'p' }).vercel.usable, 'unknown')
    sb.claudeJson({ mcpServers: { s: { type: 'http', url: 'https://mcp.vercel.com/${VERCEL_PROJECT:-demo}' } } })
    assert.equal(sb.by('claude').vercel.usable, 'unknown')
  })

  test('biến trong command/args/env của stdio cũng được kiểm', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.mcpJson({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp', '--output-dir=${OUT_DIR}'], env: { A_SECRET: '${SOME_SECRET}' } } } })
    const r = sb.by('claude').playwright
    assert.equal(r.usable, 'misconfigured')
    assert.ok(r.problems.some((p) => p.includes('OUT_DIR')))
    assert.ok(r.problems.some((p) => p.includes('SOME_SECRET')))
    assert.equal(sb.by('claude', { OUT_DIR: 'o', SOME_SECRET: 's' }).playwright.usable, 'ok')
  })

  test('server từ xa không có khoá/header (OAuth) ⇒ unknown + lời giải thích, không đoán ok', () => {
    const sb = sandbox()
    sb.claudeJson({ mcpServers: { v: { type: 'http', url: 'https://mcp.vercel.com' } } })
    const r = sb.by('claude').vercel
    assert.equal(r.status, 'installed')
    assert.equal(r.usable, 'unknown')
    assert.ok(r.problems.some((p) => p.includes('"v"')))
  })

  test('chỉ ${VAR} (hoặc ${VAR:-d}) mới là tham chiếu: $VAR thường và ${...} sai tên bị bỏ qua', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.mcpJson({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp', '--x=$NOPE', '--y=${not valid}'] } } })
    assert.equal(sb.by('claude').playwright.usable, 'ok')
  })
})

// ---------------------------------------------------------------- check: Supabase

describe('check: Supabase (read_only, project dev)', () => {
  const url = (q) => `https://mcp.supabase.com/mcp${q}`
  const withUrl = (sb, u, name = 'supabase') => {
    sb.claudeJson({ mcpServers: { [name]: { type: 'http', url: u } } })
    return sb.by('claude').supabase
  }

  test('read_only=true + project_ref ⇒ installed, scope.readOnly=true; OAuth nên usable=unknown', () => {
    const r = withUrl(sandbox(), url(`?read_only=true&project_ref=${REF_NEW}&features=database,docs`))
    assert.equal(r.status, 'installed')
    assert.equal(r.usable, 'unknown')
    assert.deepEqual(r.scope, { readOnly: true, env: 'unknown' })
  })

  test('thiếu read_only (hoặc =false) ⇒ misconfigured, scope.readOnly=false', () => {
    for (const q of [`?project_ref=${REF_NEW}`, `?read_only=false&project_ref=${REF_NEW}`, '']) {
      const r = withUrl(sandbox(), url(q))
      assert.equal(r.usable, 'misconfigured', q)
      assert.equal(r.scope.readOnly, false)
      assert.ok(r.problems.some((p) => /read_only/.test(p)))
    }
  })

  test('stdio: --read-only và --project-ref=… ⇒ readOnly=true; thiếu --read-only ⇒ misconfigured', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { s: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only', `--project-ref=${REF_NEW}`], env: { SUPABASE_ACCESS_TOKEN: '${SUPA_PAT}' } } } })
    const ok = sb.by('claude', { SUPA_PAT: 'x' }).supabase
    assert.equal(ok.usable, 'ok')
    assert.equal(ok.scope.readOnly, true)
    sb.claudeJson({ mcpServers: { s: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest', '--project-ref', REF_NEW] } } })
    assert.equal(sb.by('claude').supabase.usable, 'misconfigured')
    sb.claudeJson({ mcpServers: { s: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only=true', '--project-ref', REF_NEW] } } })
    assert.equal(sb.by('claude').supabase.scope.readOnly, true)
  })

  test('project_ref nằm trong danh sách prod của .claude/flow.json ⇒ scope.env=prod + misconfigured', () => {
    const sb = sandbox()
    sb.flowJson({ supabase: { prod: [REF_PROD], dev: [REF_DEV] } })
    const r = withUrl(sb, url(`?read_only=true&project_ref=${REF_PROD}`))
    assert.equal(r.scope.env, 'prod')
    assert.equal(r.usable, 'misconfigured')
    assert.ok(r.problems.some((p) => /production|prod/i.test(p)))
    assert.ok(!JSON.stringify(r).includes(REF_PROD), 'không in project_ref')
  })

  test('project_ref nằm trong danh sách dev ⇒ scope.env=dev, không lỗi', () => {
    const sb = sandbox()
    sb.flowJson({ supabase: { prod: [REF_PROD], dev: [REF_DEV] } })
    const r = withUrl(sb, url(`?read_only=true&project_ref=${REF_DEV}`))
    assert.equal(r.scope.env, 'dev')
    assert.equal(r.problems.filter((p) => /prod/i.test(p)).length, 0)
  })

  test('tên server có chữ prod/production/live ⇒ prod; staging/dev/test ⇒ dev; prod thắng khi có cả hai', () => {
    const q = url(`?read_only=true&project_ref=${REF_NEW}`)
    assert.equal(withUrl(sandbox(), q, 'supabase-prod').scope.env, 'prod')
    assert.equal(withUrl(sandbox(), q, 'supabaseProduction').scope.env, 'prod')
    assert.equal(withUrl(sandbox(), q, 'supabase_dev').scope.env, 'dev')
    assert.equal(withUrl(sandbox(), q, 'supabase-staging').scope.env, 'dev')
    assert.equal(withUrl(sandbox(), q, 'supabase-dev-prod').scope.env, 'prod')
    assert.equal(withUrl(sandbox(), q, 'supabase').scope.env, 'unknown')
  })

  test('thiếu project_ref ⇒ cảnh báo (không đổi usable)', () => {
    const r = withUrl(sandbox(), url('?read_only=true'))
    assert.equal(r.usable, 'unknown')
    assert.ok(r.warnings.some((w) => /project_ref/.test(w)))
  })

  test('flow.json hỏng/không có: bỏ qua, không ném lỗi', () => {
    const sb = sandbox()
    sb.put(path.join(sb.proj, '.claude', 'flow.json'), '{ nope')
    assert.equal(withUrl(sb, url(`?read_only=true&project_ref=${REF_NEW}`)).status, 'installed')
  })
})

// ---------------------------------------------------------------- check: Stripe

describe('check: Stripe (khoá test/restricted, không live)', () => {
  const withEnv = (envBlock, envProc = {}) => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { stripe: { command: 'npx', args: ['-y', '@stripe/mcp'], env: envBlock } } })
    return sb.by('claude', envProc).stripe
  }

  test('biến tham chiếu trỏ tới khoá live ⇒ scope.env=prod + misconfigured; không in khoá', () => {
    const r = withEnv({ STRIPE_SECRET_KEY: '${STRIPE_KEY}' }, { STRIPE_KEY: STRIPE_LIVE })
    assert.equal(r.scope.env, 'prod')
    assert.equal(r.usable, 'misconfigured')
    assert.ok(!JSON.stringify(r).includes('sk_live'))
  })

  test('biến tham chiếu trỏ tới khoá test ⇒ scope.env=dev, ok', () => {
    const r = withEnv({ STRIPE_SECRET_KEY: '${STRIPE_KEY}' }, { STRIPE_KEY: STRIPE_TEST })
    assert.equal(r.scope.env, 'dev')
    assert.equal(r.usable, 'ok')
  })

  test('không biết khoá (OAuth từ xa) ⇒ env unknown', () => {
    const sb = sandbox()
    sb.claudeJson({ mcpServers: { stripe: { type: 'http', url: 'https://mcp.stripe.com' } } })
    assert.equal(sb.by('claude').stripe.scope.env, 'unknown')
  })
})

// ---------------------------------------------------------------- check: Codex

describe('check: Codex (~/.codex/config.toml)', () => {
  const TOML = String.raw`model = "gpt-5"
[projects.'C:\Users\x\proj']
trust_level = "trusted"

[mcp_servers.supabase]
url = "https://mcp.supabase.com/mcp?read_only=true&project_ref=` + REF_NEW + String.raw`"
bearer_token_env_var = "SUPABASE_ACCESS_TOKEN"

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]
[mcp_servers.playwright.env]
FOO = "bar"
`

  test('MCP Codex: bearer_token_env_var chưa đặt ⇒ needs-login; đã đặt ⇒ ok', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.codexToml(TOML)
    let by = sb.by('codex')
    assert.equal(by.playwright.status, 'installed')
    assert.equal(by.playwright.usable, 'ok')
    assert.equal(by.supabase.status, 'installed')
    assert.equal(by.supabase.usable, 'needs-login')
    assert.ok(by.supabase.problems.some((p) => p.includes('SUPABASE_ACCESS_TOKEN')))
    assert.equal(by.supabase.scope.readOnly, true)
    by = sb.by('codex', { SUPABASE_ACCESS_TOKEN: 't' })
    assert.equal(by.supabase.usable, 'ok')
  })

  test('env_http_headers và env_vars cũng đòi biến có giá trị', () => {
    const sb = sandbox()
    sb.codexToml('[mcp_servers.v]\nurl = "https://mcp.vercel.com"\nenv_http_headers = { "X-Api-Key" = "VERCEL_API_KEY" }\n')
    assert.equal(sb.by('codex').vercel.usable, 'needs-login')
    assert.equal(sb.by('codex', { VERCEL_API_KEY: 'k' }).vercel.usable, 'ok')
    sb.cmd('npx')
    sb.codexToml('[mcp_servers.p]\ncommand = "npx"\nargs = ["@playwright/mcp"]\nenv_vars = ["PW_HOME"]\n')
    assert.equal(sb.by('codex').playwright.usable, 'misconfigured')
    assert.equal(sb.by('codex', { PW_HOME: 'x' }).playwright.usable, 'ok')
  })

  test('http_headers gõ thẳng khoá ⇒ misconfigured; enabled=false ⇒ misconfigured (đã tắt)', () => {
    const sb = sandbox()
    sb.codexToml(`[mcp_servers.v]\nurl = "https://mcp.vercel.com"\nhttp_headers = { "Authorization" = "Bearer ${PLAIN}" }\n`)
    const r = sb.by('codex').vercel
    assert.equal(r.usable, 'misconfigured')
    assert.ok(!JSON.stringify(r).includes(PLAIN))
    sb.cmd('npx')
    sb.codexToml('[mcp_servers.p]\ncommand = "npx"\nargs = ["@playwright/mcp"]\nenabled = false\n')
    const p = sb.by('codex').playwright
    assert.equal(p.status, 'installed')
    assert.equal(p.usable, 'misconfigured')
  })

  test('Codex không mở rộng ${VAR} (chuỗi chữ thường): không báo biến thiếu', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.codexToml('[mcp_servers.p]\ncommand = "npx"\nargs = ["@playwright/mcp", "--x=${NOPE}"]\n')
    assert.equal(sb.by('codex').playwright.usable, 'ok')
  })

  test('một dòng TOML hỏng ngoài mcp_servers không làm mất server; lỗi đọc hiện ở cảnh báo của thư viện chưa thấy', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.codexToml('oops oops\n[mcp_servers.p]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n')
    const by = sb.by('codex')
    assert.equal(by.playwright.status, 'installed')
    assert.ok(by.neon.warnings.some((w) => w.includes('config.toml')))
  })

  test('CODEX_HOME trỏ thư mục khác ⇒ đọc config.toml ở đó', () => {
    const sb = sandbox()
    sb.cmd('npx')
    const alt = path.join(sb.root, 'codex-alt')
    sb.put(path.join(alt, 'config.toml'), '[mcp_servers.p]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n')
    assert.equal(sb.by('codex').playwright.status, 'missing')
    assert.equal(sb.by('codex', { CODEX_HOME: alt }).playwright.status, 'installed')
  })

  test('Codex không đọc ~/.claude.json', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp'] } } })
    assert.equal(sb.by('codex').playwright.status, 'missing')
  })
})

// ---------------------------------------------------------------- check: gộp skill + MCP

describe('check: có cả skill lẫn MCP', () => {
  test('skill ok + MCP cần đăng nhập/chưa rõ ⇒ ok (ưu tiên skill)', () => {
    const sb = sandbox()
    sb.skill(sb.home, '.claude', 'supabase')
    sb.claudeJson({ mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp?read_only=true&project_ref=' + REF_NEW } } })
    const r = sb.by('claude').supabase
    assert.equal(r.status, 'installed')
    assert.deepEqual(r.parts, { skill: 'ok', mcp: 'unknown' })
    assert.equal(r.usable, 'ok')
  })

  test('skill ok nhưng MCP cấu hình sai (không read_only) ⇒ misconfigured: nguy cơ vẫn còn trên máy', () => {
    const sb = sandbox()
    sb.skill(sb.home, '.claude', 'supabase')
    sb.claudeJson({ mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } })
    const r = sb.by('claude').supabase
    assert.equal(r.usable, 'misconfigured')
    assert.equal(r.parts.skill, 'ok')
    assert.equal(r.parts.mcp, 'misconfigured')
  })

  test('nhiều server cùng thư viện: có một cái ok và không cái nào sai ⇒ mcp=ok', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { a: { type: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' }, b: { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.cloudflare.com/mcp', '--header', 'Authorization: Bearer ${CF_TOK}'] } } })
    const r = sb.by('claude', { CF_TOK: 'x' }).cloudflare
    assert.deepEqual(r.found.servers.sort(), ['a', 'b'])
    assert.equal(r.parts.mcp, 'ok')
  })

  test('cộng đồng + chính hãng cùng lúc ⇒ installed (không cảnh báo cộng đồng)', () => {
    const sb = sandbox()
    sb.skill(sb.home, '.claude', 'supabase')
    sb.skill(sb.home, '.claude', 'supabase-helper-pro')
    assert.equal(sb.by('claude').supabase.status, 'installed')
  })

  test('chỉ có skill cộng đồng trùng tên thư viện ⇒ community-only, không tính là đã cài', () => {
    const sb = sandbox()
    sb.skill(sb.home, '.claude', 'supabase-helper-pro')
    const r = sb.by('claude').supabase
    assert.equal(r.status, 'community-only')
    assert.ok(r.warnings.some((w) => w.includes('supabase-helper-pro')))
    assert.equal(r.installCmd, loadOfficial().supabase.skill.installCmd)
  })
})

// ---------------------------------------------------------------- CLI

describe('hooks/skills-check.mjs (CLI)', () => {
  const run = (sb, args, env = {}) => {
    // Bỏ CODEX_HOME của máy (Orca đặt sẵn trỏ vào home tài khoản riêng) ⇒ test chỉ đọc HOME giả
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['path', 'codex_home'].includes(k.toLowerCase())))
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: sb.root,
      env: { ...base, HOME: sb.home, USERPROFILE: sb.home, PATH: `${sb.bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`, ...env },
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }

  test('--json: { ok, host, results[] } theo hợp đồng; máy trống ⇒ exit 0', () => {
    const sb = sandbox()
    const r = run(sb, ['--host', 'claude', '--dir', sb.proj, '--json'])
    assert.equal(r.code, 0, r.err)
    const j = JSON.parse(r.out)
    assert.equal(j.ok, true)
    assert.equal(j.host, 'claude')
    assert.deepEqual(j.results.map((x) => x.lib).sort(), [...LIBS].sort())
  })

  test('--lib lọc; chữ thường có lệnh cài cho thư viện thiếu và ghi rõ "không có" cho Go', () => {
    const sb = sandbox()
    const r = run(sb, ['--host', 'claude', '--dir', sb.proj, '--lib', 'neon,go'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /neon/)
    assert.match(r.out, /npx skills add neondatabase\/agent-skills/)
    assert.match(r.out, /go\b.*none/)
    assert.doesNotMatch(r.out, /cloudflare/)
  })

  test('có server misconfigured ⇒ exit 1; không lộ khoá ở stdout/stderr; chỉ in tên server', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.claudeJson({ mcpServers: { 'stripe-live': { command: 'npx', args: ['-y', '@stripe/mcp'], env: { STRIPE_SECRET_KEY: STRIPE_LIVE } } } })
    for (const args of [[], ['--json']]) {
      const r = run(sb, ['--host', 'claude', '--dir', sb.proj, ...args])
      assert.equal(r.code, 1, r.err)
      assert.match(r.out, /stripe-live/)
      assert.ok(!(r.out + r.err).includes(STRIPE_LIVE.slice(0, 8)))
    }
  })

  test('--host codex đọc config.toml của HOME giả', () => {
    const sb = sandbox()
    sb.cmd('npx')
    sb.codexToml('[mcp_servers.p]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n')
    const j = JSON.parse(run(sb, ['--host', 'codex', '--dir', sb.proj, '--lib', 'playwright', '--json']).out)
    assert.equal(j.results[0].status, 'installed')
  })

  test('sai cách dùng (host lạ, thiếu thư mục, lib lạ, cờ lạ) ⇒ exit 2 + lời hướng dẫn trên stderr', () => {
    const sb = sandbox()
    for (const args of [['--host', 'vim'], ['--host', 'constructor'], ['--lib', '__proto__'], ['--dir', path.join(sb.root, 'khong-co')], ['--lib', 'nonexistent-lib'], ['--bogus']]) {
      const r = run(sb, args)
      assert.equal(r.code, 2, args.join(' '))
      assert.ok(r.err.length > 0)
    }
  })

  test('-h in cách dùng, exit 0', () => {
    const r = run(sandbox(), ['-h'])
    assert.equal(r.code, 0)
    assert.match(r.out, /--host/)
  })
})
