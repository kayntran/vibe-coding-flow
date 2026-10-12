// Test cho CLI hooks/updates.mjs: node --test hooks/updates.test.mjs
// run() chạy trong tiến trình với fetch/exec/exists giả (không mạng, không lệnh thật); vài ca chạy `node updates.mjs` thật chỉ với đường không chạm mạng.
import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './updates.mjs'
import { SAFE_CMD, todayOf } from './lib/updates.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'updates.mjs')
const DAY = 86400000
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)

const tmpDirs = []
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'updcli-'))
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }) })

const HOME = 'C:\\Users\\a'
const LAD = `${HOME}\\AppData\\Local`
const APD = `${HOME}\\AppData\\Roaming`
const DEVIN = 'D:\\Program Files\\Devin\\resources\\app\\extensions\\windsurf\\devin\\bin\\devin.exe'
const BASE_FILES = {
  [`${LAD}\\pnpm\\bin\\codex.cmd`]: 'codex-cli 0.153.0',
  [DEVIN]: 'devin 3000.10.48 (fcf7ba39)',
  'C:\\Program Files\\nodejs\\node.exe': 'v25.2.1',
}
const NODE_INDEX = [
  { version: 'v26.11.1', date: '2026-10-01', lts: false },
  { version: 'v24.21.0', date: '2026-09-01', lts: 'Krypton' },
]
const SOURCES = {
  codex: [/dist-tags/, JSON.stringify({ latest: '0.162.1' })],
  devin: [/static\.devin\.ai/, JSON.stringify({ version: '3000.11.3' })],
  node: [/nodejs\.org/, JSON.stringify(NODE_INDEX)],
}

const WINGET_EXE = `${LAD}\\Microsoft\\WindowsApps\\winget.exe`
// winget: { 'OpenJS.NodeJS': ['26.8.1'] } = winget có sẵn trên PATH và `winget show --id … --versions` trả danh sách này; bỏ trống = máy không có winget.
function world({ files = {}, sources = {}, winget = null, ...extra } = {}) {
  const f = { ...BASE_FILES, ...files, ...(winget ? { [WINGET_EXE]: '' } : {}) }
  const calls = []
  const execCalls = []
  const src = { ...SOURCES, ...sources }
  const out = []
  const err = []
  const cacheDir = tmp()
  const opts = {
    platform: 'win32', arch: 'x64', home: HOME, now: NOW, cacheDir, timeoutMs: 1000, log: () => {},
    env: { PATH: [`${LAD}\\pnpm\\bin`, 'C:\\Program Files\\nodejs', ...(winget ? [`${LAD}\\Microsoft\\WindowsApps`] : [])].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD', LOCALAPPDATA: LAD, APPDATA: APD },
    exists: (p) => p in f, realpath: (p) => p,
    exec: async (file, args) => {
      execCalls.push(args)
      if (file === WINGET_EXE && args[0] === 'show') {
        const list = winget?.[args[2]]
        return list ? { code: 0, stdout: `Found X [${args[2]}]\nVersion\n-------\n${list.join('\n')}\n`, stderr: '', timedOut: false, error: null } : { code: 1, stdout: 'No package found', stderr: '', timedOut: false, error: null }
      }
      return f[file] === undefined ? { code: null, stdout: '', stderr: '', timedOut: false, error: { code: 'ENOENT' } } : { code: 0, stdout: `${f[file]}\n`, stderr: '', timedOut: false, error: null }
    },
    fetch: async (url) => {
      calls.push(String(url))
      for (const v of Object.values(src)) {
        if (v && v[0].test(String(url))) return typeof v[1] === 'function' ? v[1]() : { status: 200, text: async () => v[1] }
      }
      return { status: 404, text: async () => '' }
    },
    ...extra,
  }
  return { opts, calls, execCalls, out, err, cacheDir, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } }
}
const go = async (w, ...argv) => run(argv, { io: w.io, opts: w.opts })
const text = (w) => w.out.join('\n')

describe('check', () => {
  test('liệt kê công cụ có trên máy: bản đang cài → bản mới, cách cài; công cụ vắng mặt không có dòng', async () => {
    const w = world()
    assert.equal(await go(w, 'check'), 0)
    const t = text(w)
    assert.match(t, /Codex: 0\.153\.0 → 0\.162\.1 \(có bản mới\) · cài bằng pnpm/)
    assert.match(t, /Node: 25\.2\.1 → 26\.11\.1 \(có bản mới\) · cài bằng winget/)
    assert.match(t, /Devin: 3000\.10\.48 → 3000\.11\.3 \(có bản mới\) · đi kèm Devin Desktop/)
    assert.match(t, /dòng 25 đã ngừng hỗ trợ/)
    assert.ok(!/Claude|Grok|Git|pnpm:/.test(t), t)
    assert.equal(w.err.length, 0)
  })

  test('--json: mảng JSON hợp lệ, có updateAvailable; --fresh hỏi mạng, không có --fresh dùng bộ nhớ', async () => {
    const w = world()
    assert.equal(await go(w, 'check', '--json', '--fresh'), 0)
    const arr = JSON.parse(text(w))
    assert.deepEqual(arr.map((e) => e.tool), ['codex', 'devin', 'node'])
    assert.equal(arr[0].updateAvailable, true)
    assert.equal(arr[0].cmd, 'pnpm add -g @openai/codex@latest')
    const n = w.calls.length
    assert.ok(n >= 3)
    w.out.length = 0
    assert.equal(await go(w, 'check', '--json'), 0)
    assert.equal(w.calls.length, n, 'còn hạn 24 giờ ⇒ không hỏi mạng')
    assert.equal(JSON.parse(text(w)).length, 3)
  })

  test('check <công cụ> --fresh: chỉ hỏi nguồn của công cụ đó; nhận tên gọi tắt', async () => {
    const w = world()
    assert.equal(await go(w, 'check', 'Codex', '--fresh'), 0)
    assert.match(text(w), /^Codex: 0\.153\.0 → 0\.162\.1/)
    assert.ok(w.calls.every((u) => u.includes('openai/codex')), w.calls.join(','))
    const w2 = world()
    assert.equal(await go(w2, 'check', 'nodejs', '--fresh'), 0)
    assert.match(text(w2), /^Node:/)
  })

  test('công cụ không có trên máy / nguồn lỗi ⇒ nói thẳng, exit 0; tên lạ ⇒ exit 2 kèm danh sách, không chạm mạng', async () => {
    const w = world()
    assert.equal(await go(w, 'check', 'grok', '--fresh'), 0)
    assert.match(text(w), /Grok: chưa cài/)
    assert.equal(w.calls.length, 0)
    const bad = world()
    assert.equal(await go(bad, 'check', 'vim'), 2)
    assert.match(bad.err.join('\n'), /Công cụ không có trong danh sách: vim/)
    assert.match(bad.err.join('\n'), /codex, claude/)
    assert.equal(bad.calls.length, 0)
    assert.equal(bad.out.length, 0)
  })

  test('mất mạng ⇒ không lỗi, không dòng nào (bỏ qua công cụ)', async () => {
    const w = world({ fetch: async () => { throw new Error('offline') } })
    assert.equal(await go(w, 'check', '--fresh'), 0)
    assert.match(text(w), /Không thấy công cụ nào/)
    assert.equal(w.err.length, 0)
  })

  test('cờ lạ / quá nhiều đối số ⇒ exit 2', async () => {
    assert.equal(await go(world(), 'check', '--force'), 2)
    assert.equal(await go(world(), 'check', 'codex', 'node'), 2)
  })
})

describe('cmd', () => {
  test('codex: in đúng lệnh theo cách cài và nói AI chạy sau khi user gật', async () => {
    const w = world()
    assert.equal(await go(w, 'cmd', 'codex'), 0)
    const t = text(w)
    assert.match(t, /Codex 0\.153\.0 → 0\.162\.1 \(cài bằng pnpm\)/)
    assert.match(t, /^Lệnh: pnpm add -g @openai\/codex@latest$/m)
    assert.match(t, /AI chạy sau khi user gật/)
  })

  test('luôn kiểm tươi: bộ nhớ nói "mới nhất" nhưng mạng nói có bản mới ⇒ theo mạng', async () => {
    const w = world()
    await go(w, 'check', '--fresh')
    w.out.length = 0
    const w2 = world({ cacheDir: w.cacheDir, sources: { codex: [/dist-tags/, JSON.stringify({ latest: '0.170.0' })] } })
    w2.opts.cacheDir = w.cacheDir
    assert.equal(await go(w2, 'cmd', 'codex'), 0)
    assert.match(text(w2), /0\.153\.0 → 0\.170\.0/)
  })

  test('node (ảnh hưởng mọi dự án): lệnh GHIM đúng bản đã chọn, nói user tự chạy, AI không tự chạy', async () => {
    const w = world({ winget: { 'OpenJS.NodeJS': ['26.11.1', '26.8.1'] } })
    assert.equal(await go(w, 'cmd', 'node'), 0)
    const t = text(w)
    assert.match(t, /^Lệnh: winget upgrade --id OpenJS\.NodeJS --version 26\.11\.1$/m)
    assert.match(t, /user tự chạy/)
    assert.ok(!/AI chạy sau khi user gật/.test(t), t)
    assert.match(t, /dòng 25 đã ngừng hỗ trợ/)
  })

  test('node qua winget mà winget chưa có bản đã chọn ⇒ không có lệnh, ghi chú chờ hoặc tải từ nodejs.org', async () => {
    const w = world({ winget: { 'OpenJS.NodeJS': ['26.8.1'] } })
    assert.equal(await go(w, 'cmd', 'node'), 0)
    const t = text(w)
    assert.ok(!/Lệnh: winget/.test(t), t)
    assert.match(t, /Lệnh: \(không có lệnh để chạy\)/)
    assert.match(t, /winget chưa có 26\.11\.1/)
    assert.match(t, /nodejs\.org/)
    assert.match(t, /user tự làm theo ghi chú/)
  })

  test('winget chưa có bản đã chọn nhưng có bản cũ hơn đủ tuổi cùng dòng ⇒ lệnh ghim bản đó + ghi chú "cài <bản đó> trước"', async () => {
    const index = [{ version: 'v26.11.1', date: '2026-10-01', lts: false }, { version: 'v26.8.1', date: '2026-09-09', lts: false }]
    const w = world({ sources: { node: [/nodejs\.org/, JSON.stringify(index)] }, winget: { 'OpenJS.NodeJS': ['26.8.1', '25.2.1'] } })
    assert.equal(await go(w, 'cmd', 'node'), 0)
    const t = text(w)
    assert.match(t, /^Lệnh: winget upgrade --id OpenJS\.NodeJS --version 26\.8\.1$/m)
    assert.match(t, /Node 25\.2\.1 → 26\.11\.1/)
    assert.match(t, /Bản 26\.11\.1 winget chưa có; cài 26\.8\.1 trước/)
    assert.match(t, /user tự chạy/)
  })

  test('chưa có bản nào đủ 7 ngày ⇒ cmd nói "chưa có bản đủ 7 ngày", không lệnh; cmd hết bỏ qua công cụ đó', async () => {
    const young = { node: [/nodejs\.org/, JSON.stringify([{ version: 'v26.12.0', date: '2026-10-11', lts: false }])] }
    const w = world({ sources: young })
    assert.equal(await go(w, 'cmd', 'node'), 0)
    const t = text(w)
    assert.match(t, /chưa có bản mới để khuyên/)
    assert.match(t, /chưa có bản đủ 7 ngày/i)
    assert.ok(!/Lệnh: [a-z]/.test(t), t)
    const w2 = world({ sources: young })
    await go(w2, 'cmd', 'hết')
    assert.ok(!text(w2).includes('Node'), text(w2))
    const w3 = world({ sources: young })
    await go(w3, 'check', '--json', '--fresh')
    assert.equal(JSON.parse(text(w3)).find((e) => e.tool === 'node').updateAvailable, false)
    const w4 = world({ sources: young })
    await go(w4, 'check', '--fresh')
    await go(w4, 'note')
    assert.ok(!text(w4).includes('Node 25'), 'không nhắc khi chưa có bản đủ tuổi')
  })

  test('node qua fnm: hai dòng lệnh (cài rồi đặt mặc định), mỗi dòng chỉ ký tự an toàn', async () => {
    const FNM = `${LAD}\\fnm_multishells\\1\\node.exe`
    const w = world({ files: { [FNM]: 'v25.2.1' }, env: { PATH: [`${LAD}\\pnpm\\bin`, `${LAD}\\fnm_multishells\\1`].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD', LOCALAPPDATA: LAD, APPDATA: APD } })
    assert.equal(await go(w, 'cmd', 'node'), 0)
    const t = text(w)
    assert.match(t, /^Lệnh 1: fnm install 26\.11\.1$/m)
    assert.match(t, /^Lệnh 2: fnm default 26\.11\.1$/m)
    assert.match(t, /lần lượt từ trên xuống/)
    for (const l of t.split('\n').filter((x) => /^Lệnh \d+: /.test(x))) assert.match(l.replace(/^Lệnh \d+: /, ''), SAFE_CMD)
  })

  test('devin đi kèm Devin Desktop: không có lệnh, dặn cập nhật Devin Desktop', async () => {
    const w = world()
    assert.equal(await go(w, 'cmd', 'devin'), 0)
    const t = text(w)
    assert.match(t, /không có lệnh để chạy/)
    assert.match(t, /Devin Desktop/)
    assert.match(t, /user tự làm theo ghi chú/)
    assert.ok(!/AI chạy sau khi user gật/.test(t), t)
  })

  test('đã mới nhất ⇒ không in lệnh', async () => {
    const w = world({ files: { [`${LAD}\\pnpm\\bin\\codex.cmd`]: 'codex-cli 0.162.1' } })
    assert.equal(await go(w, 'cmd', 'codex'), 0)
    assert.equal(text(w), 'Codex đã ở bản mới nhất (0.162.1), không cần cập nhật.')
  })

  test('mất mạng (nguồn lỗi) ⇒ công cụ bị bỏ ⇒ nói chưa kiểm được, không bịa lệnh', async () => {
    const w = world({ fetch: async () => { throw new Error('offline') } })
    assert.equal(await go(w, 'cmd', 'codex'), 0)
    assert.match(text(w), /chưa cài trên máy này .* hoặc chưa kiểm được/)
    assert.ok(!text(w).includes('Lệnh:'))
  })

  test('đã cài nhưng không có nguồn để so bản mới (Apple Git) ⇒ vẫn đưa ghi chú cách cập nhật', async () => {
    const files = { '/usr/bin/git': 'git version 2.50.1 (Apple Git-155)' }
    const w = world({ platform: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/t', exists: (p) => p in files })
    w.opts.exec = async (file) => ({ code: 0, stdout: `${files[file]}\n`, stderr: '', timedOut: false, error: null })
    assert.equal(await go(w, 'cmd', 'git'), 0)
    const t = text(w)
    assert.match(t, /chưa có bản mới để khuyên/)
    assert.match(t, /Command Line Tools/)
    assert.match(t, /user tự làm theo ghi chú/)
  })

  test('cmd hết: chỉ các công cụ có bản mới, ngăn cách bằng dòng trống; không còn gì ⇒ nói mọi thứ đã mới nhất', async () => {
    const w = world()
    assert.equal(await go(w, 'cmd', 'hết'), 0)
    const t = text(w)
    assert.match(t, /Codex 0\.153\.0/)
    assert.match(t, /Node 25\.2\.1/)
    assert.match(t, /Devin 3000\.10\.48/)
    assert.ok(t.includes('\n\n'))
    const current = world({ files: { [`${LAD}\\pnpm\\bin\\codex.cmd`]: 'codex-cli 0.162.1', [DEVIN]: 'devin 3000.11.3 (x)', 'C:\\Program Files\\nodejs\\node.exe': 'v26.11.1' } })
    assert.equal(await go(current, 'cmd', 'all'), 0)
    assert.match(text(current), /Mọi công cụ đã ở bản mới nhất/)
  })

  test('--json: mảng có cmd/userRuns; mọi "Lệnh:" in ra chỉ chứa ký tự an toàn', async () => {
    const w = world()
    assert.equal(await go(w, 'cmd', 'hết', '--json'), 0)
    const arr = JSON.parse(text(w))
    assert.equal(arr.find((e) => e.tool === 'node').userRuns, true)
    assert.equal(arr.find((e) => e.tool === 'codex').userRuns, false)
    const w2 = world()
    await go(w2, 'cmd', 'hết')
    const shown = text(w2).split('\n').filter((l) => /^Lệnh(?: \d+)?: /.test(l) && !l.includes('không có lệnh'))
    assert.equal(shown.length, 2, shown.join('\n')) // codex + node (Devin Desktop không có lệnh)
    for (const line of shown) assert.match(line.replace(/^Lệnh(?: \d+)?: /, ''), SAFE_CMD, line)
  })

  test('thiếu tên / tên lạ / cờ --fresh ⇒ exit 2', async () => {
    assert.equal(await go(world(), 'cmd'), 2)
    assert.equal(await go(world(), 'cmd', 'vim'), 2)
    assert.equal(await go(world(), 'cmd', 'codex', '--fresh'), 2)
  })

  test('KHÔNG BAO GIỜ chạy lệnh cập nhật: mọi lệnh con chỉ gọi exec với --version hoặc câu hỏi chỉ đọc `winget show … --versions`', async () => {
    const w = world({ winget: { 'OpenJS.NodeJS': ['26.11.1'] } })
    for (const argv of [['check'], ['check', 'codex', '--fresh'], ['cmd', 'codex'], ['cmd', 'node'], ['cmd', 'hết'], ['note']]) await go(w, ...argv)
    assert.ok(w.execCalls.length >= 6)
    for (const args of w.execCalls) {
      const ok = args.join(' ') === '--version' || (args.length === 5 && args[0] === 'show' && args[1] === '--id' && args[3] === '--versions' && args[4] === '--accept-source-agreements')
      assert.ok(ok, args.join(' '))
    }
    assert.ok(w.execCalls.some((a) => a[0] === 'show'), 'có hỏi winget')
    assert.equal(w.err.length, 0, w.err.join('\n'))
  })
})

describe('note', () => {
  test('in dòng nhắc từ bộ nhớ, kể cả khi hôm nay đã nhắc; không có gì mới ⇒ không in', async () => {
    const w = world()
    assert.equal(await go(w, 'note'), 0)
    assert.equal(text(w), '', 'chưa có bộ nhớ ⇒ im')
    await go(w, 'check', '--fresh')
    w.out.length = 0
    const file = path.join(w.cacheDir, 'updates.json')
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), notified: todayOf(NOW) }))
    assert.equal(await go(w, 'note'), 0)
    assert.match(text(w), /^Có bản mới: Codex 0\.153 → 0\.162, Devin 3000\.10 → 3000\.11, Node 25 → 26 \(dòng 25 đã ngừng hỗ trợ\)\. Nói "cập nhật Codex" để AI cập nhật\.$/)
    assert.equal(w.calls.length, 3, 'note không hỏi mạng')
  })
})

describe('chạy thật `node updates.mjs` (chỉ đường không chạm mạng)', () => {
  const env = (extra = {}) => ({ ...process.env, UPDATES_CACHE_DIR: tmp(), UPDATES_LOG: path.join(tmp(), 'u.log'), ...extra })
  test('không đối số ⇒ exit 2 + cách dùng; tên lạ ⇒ exit 2', () => {
    const a = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: env() })
    assert.equal(a.status, 2)
    assert.match(a.stderr, /Dùng: node updates\.mjs check/)
    const b = spawnSync(process.execPath, [SCRIPT, 'cmd', 'vim'], { encoding: 'utf8', env: env() })
    assert.equal(b.status, 2)
  })
  test('note với bộ nhớ trống ⇒ exit 0, không in gì; bộ nhớ có bản mới ⇒ in một dòng', () => {
    const e = env()
    const a = spawnSync(process.execPath, [SCRIPT, 'note'], { encoding: 'utf8', env: e })
    assert.equal(a.status, 0)
    assert.equal(a.stdout, '')
    fs.writeFileSync(path.join(e.UPDATES_CACHE_DIR, 'updates.json'), JSON.stringify({
      at: Date.now(),
      tools: { codex: { tool: 'codex', installed: '0.153.0', latest: '0.162.1', method: 'pnpm', cmd: 'pnpm add -g @openai/codex@latest' } },
    }))
    const b = spawnSync(process.execPath, [SCRIPT, 'note'], { encoding: 'utf8', env: e })
    assert.equal(b.status, 0)
    assert.equal(b.stdout.trim(), 'Có bản mới: Codex 0.153 → 0.162. Nói "cập nhật Codex" để AI cập nhật.')
  })
})
