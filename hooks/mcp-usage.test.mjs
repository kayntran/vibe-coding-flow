// Test cho mcp-usage.mjs: node --test ~/.claude/hooks/mcp-usage.test.mjs
// HOME/USERPROFILE + MCP_USAGE_LOG trỏ vào thư mục tạm: không đọc/ghi ~/.claude.json hay ~/.claude/logs thật.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-usage.mjs')
const DAY = 86400000
const roots = []

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-usage-')))
  roots.push(home)
  const logs = path.join(home, '.claude', 'logs')
  return { home, logs, usage: path.join(home, 'data', 'usage.jsonl'), cfg: path.join(home, '.claude.json') }
}

function run(fx, args, input) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd: fx.home,
    env: { ...process.env, HOME: fx.home, USERPROFILE: fx.home, MCP_USAGE_LOG: fx.usage },
  })
  assert.equal(r.error, undefined)
  return r
}

const lines = (fx) => (fs.existsSync(fx.usage) ? fs.readFileSync(fx.usage, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

// Trưa của N ngày trước (giờ local) — mỗi mốc rơi vào một ngày riêng, không phụ thuộc giờ chạy test.
const noon = (daysAgo) => { const d = new Date(); d.setHours(12, 0, 0, 0); return new Date(d.getTime() - daysAgo * DAY).toISOString() }

function seedUsage(fx, rows) {
  fs.mkdirSync(path.dirname(fx.usage), { recursive: true })
  fs.writeFileSync(fx.usage, rows.map(([daysAgo, server, cwd]) => JSON.stringify({ ts: noon(daysAgo), server, tool: 't', cwd })).join('\n') + '\n')
}

function allFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...allFiles(p))
    else out.push(p)
  }
  return out
}

describe('log', () => {
  test('tách tên server từ tool_name', () => {
    const cases = [
      ['mcp__github-glossvn__get_me', 'github-glossvn', 'get_me'],
      ['mcp__plugin_x_y__tool', 'plugin_x_y', 'tool'],
      ['mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch', '1a59c906-04da-521d-bda7-7f71b9f9e01c', 'batch'],
      ['mcp__srv__a__b', 'srv', 'a__b'],
    ]
    const fx = fixture()
    for (const [name] of cases) {
      const r = run(fx, ['log'], { tool_name: name, cwd: 'D:\\p\\app' })
      assert.equal(r.status, 0)
      assert.equal(r.stdout, '')
    }
    const got = lines(fx)
    assert.equal(got.length, cases.length)
    cases.forEach(([, server, tool], i) => {
      assert.equal(got[i].server, server)
      assert.equal(got[i].tool, tool)
    })
  })

  test('ghi nối đúng một dòng {ts, server, tool, cwd}, tự tạo thư mục', () => {
    const fx = fixture()
    assert.equal(fs.existsSync(path.dirname(fx.usage)), false)
    const before = Date.now()
    run(fx, ['log'], { tool_name: 'mcp__a__x', cwd: '/w/one', tool_input: { secret: 'ghp_SHOULDNOTBELOGGED' } })
    run(fx, ['log'], { tool_name: 'mcp__b__y', cwd: '/w/two' })
    const got = lines(fx)
    assert.equal(got.length, 2)
    assert.deepEqual(Object.keys(got[0]), ['ts', 'server', 'tool', 'cwd'])
    assert.deepEqual([got[0].server, got[0].tool, got[0].cwd], ['a', 'x', '/w/one'])
    assert.deepEqual([got[1].server, got[1].tool, got[1].cwd], ['b', 'y', '/w/two'])
    assert.ok(Date.parse(got[0].ts) >= before - 1000 && Date.parse(got[0].ts) <= Date.now() + 1000)
    assert.ok(!fs.readFileSync(fx.usage, 'utf8').includes('SHOULDNOTBELOGGED'))
  })

  test('input hỏng/không phải mcp không crash, không in, không ghi dòng', () => {
    const fx = fixture()
    const bad = ['', 'không phải json', '[]', '{}', { tool_name: 'Bash' }, { tool_name: 42 }, { tool_name: 'mcp__' }, { tool_name: 'mcp__srv' }, { tool_name: 'mcp__srv__' }]
    for (const input of bad) {
      const r = run(fx, ['log'], input)
      assert.equal(r.status, 0, `input ${JSON.stringify(input)}`)
      assert.equal(r.stdout, '')
    }
    assert.equal(lines(fx).length, 0)
  })

  test('không ghi được file log (đường dẫn là thư mục) ⇒ exit 0, không in gì', () => {
    const fx = fixture()
    fs.mkdirSync(fx.usage, { recursive: true })
    const r = run(fx, ['log'], { tool_name: 'mcp__a__x', cwd: '/w' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.match(fs.readFileSync(path.join(fx.logs, 'mcp-usage.log'), 'utf8'), /log lỗi/)
  })
})

describe('report', () => {
  const TOKENS = ['sk-' + 'ant-FAKESECRETVALUE1234567890', 'Bearer-FAKEHEADERVALUE987', 'FAKEENVVALUE-abcdef', 'FAKELOCALTOKEN-zzz', 'FAKEPROJTOKEN-qqq']

  function seedAll(fx) {
    const proj = path.join(fx.home, 'work', 'app')
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: {
      projunused: { command: 'node', env: { TOKEN: TOKENS[4] } },
      'used-one': { command: 'node' },
    } }))
    fs.writeFileSync(fx.cfg, JSON.stringify({
      mcpServers: {
        'used-one': { type: 'http', url: 'https://x.test', headers: { Authorization: TOKENS[1] } },
        useronly: { command: 'npx', args: ['--key', TOKENS[0]], env: { API_KEY: TOKENS[2] } },
        'my.dotted': { command: 'x' },
      },
      projects: { [path.join(fx.home, 'work', 'other')]: { mcpServers: { localunused: { env: { T: TOKENS[3] } } } } },
    }))
    seedUsage(fx, [
      [1, 'used-one', path.join(proj, 'src')], // cwd là thư mục con ⇒ .mcp.json ở gốc project vẫn được tìm
      [1, 'used-one', path.join(proj, 'src')],
      [2, 'used-one', path.join(fx.home, 'work', 'other')],
      [3, 'plugin_foo_bar', path.join(proj, 'src')],
      [3, 'my_dotted', path.join(proj, 'src')], // `my.dotted` được chuẩn hoá thành `my_dotted` trong tool_name
      [45, 'oldserver', path.join(proj, 'src')], // ngoài cửa sổ 30 ngày
    ])
    return proj
  }

  test('đếm đúng, liệt kê server cấu hình 0 lần gọi kèm lệnh gợi ý', () => {
    const fx = fixture()
    seedAll(fx)
    const r = run(fx, ['report'])
    assert.equal(r.status, 0, r.stderr)
    const out = r.stdout
    // used-one: 3 lần gọi, 2 ngày, project = basename(cwd) (src, other); sắp xếp theo số lần gọi nên đứng đầu bảng
    const rows = out.split('\n').filter((l) => /^\| (used-one|plugin_foo_bar|my_dotted|oldserver) /.test(l))
    assert.equal(rows.length, 3)
    assert.match(rows[0], /^\| used-one \| user\/project \| 3 \| 2 \| \d{4}-\d\d-\d\d \d\d:\d\d \| other, src \|$/)
    assert.match(rows[1] + rows[2], /plugin_foo_bar \| — \| 1 \| 1 \|/)
    assert.match(rows[1] + rows[2], /my_dotted \| user \| 1 \| 1 \|/)
    assert.ok(!out.includes('oldserver'), 'dòng cũ hơn 30 ngày phải bị loại')
    // cấu hình mà 0 lần gọi
    assert.match(out, /- `useronly` — user — `claude mcp remove "useronly" -s user`/)
    assert.match(out, /- `localunused` — local, .*other — `claude mcp remove "localunused" -s local`/)
    assert.match(out, /- `projunused` — project, .*app — .*claude mcp remove "projunused" -s project/)
    assert.ok(!/- `used-one`/.test(out) && !/- `my\.dotted`/.test(out))
    assert.match(out, /Connector claude\.ai/)
  })

  test('tên server lạ (từ ~/.claude.json hoặc .mcp.json) ⇒ không dựng lệnh gợi ý, chỉ in tên đã escape', () => {
    const fx = fixture()
    const proj = path.join(fx.home, 'repo')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'evil`name`': {}, 'line\n## Injected': {} } }))
    fs.writeFileSync(fx.cfg, JSON.stringify({ mcpServers: { 'x; echo AUDIT #': {}, 'ok-name.1': {} } }))
    seedUsage(fx, [[1, 'other', proj]])
    const out = run(fx, ['report']).stdout
    // tên hợp lệ ⇒ lệnh với tên trong nháy kép
    assert.match(out, /- `ok-name\.1` — user — `claude mcp remove "ok-name\.1" -s user`/)
    // tên lạ ⇒ chỉ tên escape + "tự gỡ thủ công"
    assert.ok(out.includes('- x\\; echo AUDIT \\# — user — tên có ký tự đặc biệt, không in lệnh: tự gỡ thủ công'), out)
    assert.ok(out.includes('- evil\\`name\\` — project'))
    assert.ok(!/claude mcp remove[^\n]*(AUDIT|evil|Injected)/.test(out), 'không được dựng lệnh từ tên lạ')
    // tên có xuống dòng không được tách thành dòng/heading mới: mọi dòng của mục này đều là một gạch đầu dòng
    const section = out.split('## Đã cấu hình, 0 lần gọi')[1].split('## Ghi chú')[0].split('\n').filter(Boolean)
    assert.equal(section.length, 4)
    assert.ok(section.every((l) => l.startsWith('- ')), section.join(' | '))
    assert.ok(!/^## Injected/m.test(out))
    assert.equal((out.match(/tự gỡ thủ công/g) ?? []).length, 3)
  })

  test('không in giá trị env/headers/token ở stdout, file report, state hay log', () => {
    const fx = fixture()
    seedAll(fx)
    const r = run(fx, ['report'])
    const everything = r.stdout + r.stderr + allFiles(fx.logs).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    for (const t of TOKENS) assert.ok(!everything.includes(t), `lộ ${t.slice(0, 8)}…`)
  })

  test('~/.claude.json hỏng ⇒ vẫn báo cáo, không lộ nội dung file trong log', () => {
    const fx = fixture()
    seedUsage(fx, [[1, 'a', '/w/p']])
    fs.writeFileSync(fx.cfg, '{"mcpServers": {"x": {"env": {"K": "sk-ant-LEAKCHECK123456789"}}, oops')
    const r = run(fx, ['report'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^\| a \| — \| 1 \| 1 \|/m)
    const everything = r.stdout + r.stderr + allFiles(fx.logs).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    assert.ok(!everything.includes('LEAKCHECK'))
  })

  test('--days giới hạn cửa sổ', () => {
    const fx = fixture()
    seedUsage(fx, [[1, 'recent', '/w/p'], [10, 'mid', '/w/p'], [45, 'old', '/w/p']])
    const d7 = run(fx, ['report', '--days', '7']).stdout
    assert.match(d7, /^\| recent /m)
    assert.ok(!/^\| mid /m.test(d7) && !/^\| old /m.test(d7))
    const d30 = run(fx, ['report', '--days=30']).stdout
    assert.match(d30, /^\| mid /m)
    assert.ok(!/^\| old /m.test(d30))
    const dflt = run(fx, ['report']).stdout
    assert.match(dflt, /30 ngày/)
    assert.match(run(fx, ['report', '--days', 'abc']).stdout, /30 ngày/)
  })

  test('ghi file report theo ngày và cập nhật state.lastReport', () => {
    const fx = fixture()
    seedUsage(fx, [[1, 'a', '/w/p']])
    fs.mkdirSync(fx.logs, { recursive: true })
    fs.writeFileSync(path.join(fx.logs, 'mcp-usage.state.json'), JSON.stringify({ keep: 1, lastReport: '2020-01-01T00:00:00.000Z' }))
    const before = Date.now()
    const r = run(fx, ['report'])
    const reports = fs.readdirSync(fx.logs).filter((f) => /^mcp-report-\d{4}-\d\d-\d\d\.md$/.test(f))
    assert.equal(reports.length, 1)
    assert.equal(fs.readFileSync(path.join(fx.logs, reports[0]), 'utf8'), r.stdout)
    const state = JSON.parse(fs.readFileSync(path.join(fx.logs, 'mcp-usage.state.json'), 'utf8'))
    assert.equal(state.keep, 1)
    assert.ok(Date.parse(state.lastReport) >= before - 1000)
  })

  test('chưa có log và chưa cấu hình gì ⇒ báo cáo rỗng, exit 0', () => {
    const fx = fixture()
    const r = run(fx, ['report'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /chưa có dòng nào/)
    assert.match(r.stdout, /chưa có lần gọi nào/)
  })
})
