// Test cho zap-scan.mjs và strix-scan.mjs (hai lệnh quét bảo mật chỉ-localhost): node --test hooks/zap-scan.test.mjs
// Không quét thật: lib/zap dùng `run`/`probe` giả; strix dùng `spawn` giả (Docker + strix). Vài ca chạy tiến trình thật chỉ để kiểm exit code
// của lệnh bị TỪ CHỐI (không cần ZAP/Docker/mạng).
import { test, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main as zapMain, USAGE } from './zap-scan.mjs'
import { main as strixMain, SCAN_MODES } from './strix-scan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ZAP_SCRIPT = path.join(HERE, 'zap-scan.mjs')
const STRIX_SCRIPT = path.join(HERE, 'strix-scan.mjs')

const tmpDirs = []
function tmp(prefix = 'zap-scan-test ') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}Việt `))
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const sink = () => { const s = { text: '', write(x) { s.text += x } }; return s }
const files = (...list) => { const s = new Set(list); return (p) => s.has(p) }

// ============================== zap-scan ==============================

describe('zap-scan', () => {
  test('--help ⇒ 0 và in cách dùng', async () => {
    const out = sink()
    assert.equal(await zapMain(['--help'], { stdout: out, stderr: sink() }), 0)
    assert.equal(out.text, `${USAGE}\n`)
  })

  test('dùng sai (thiếu -t, cờ lạ, thiếu giá trị, hai -t) ⇒ exit 3, không quét', async () => {
    for (const argv of [[], ['--lạ'], ['-t'], ['-t', 'http://localhost:3000', '--report-dir'], ['-t', 'http://localhost:3000', '-t', 'http://localhost:3001'], ['http://localhost:3000']]) {
      const err = sink()
      let scanned = 0
      const code = await zapMain(argv, { stdout: sink(), stderr: err, scan: async () => { scanned++ } })
      assert.equal(code, 3, argv.join(' '))
      assert.match(err.text, /^zap-scan từ chối: /)
      assert.equal(scanned, 0)
    }
  })

  test('target không phải localhost ⇒ exit 3 từ lib thật (không gọi java/ZAP/mạng)', async () => {
    for (const t of ['https://example.com', 'http://localhost.evil.com', 'http://localhost@evil.com', 'http://10.0.0.5:3000', 'file:///etc/passwd']) {
      const err = sink()
      const code = await zapMain(['-t', t], { stdout: sink(), stderr: err })
      assert.equal(code, 3, t)
      assert.match(err.text, /zap-scan từ chối: .*Chỉ quét bản chạy ở máy này/)
    }
  })

  test('chuyển cờ cho lib: target, --report-dir/--ignore-file (cả dạng =) tính theo cwd; mặc định docs/security-ignore.json', async () => {
    const calls = []
    const deps = (res) => ({ stdout: sink(), stderr: sink(), cwd: path.resolve('/proj'), scan: async (o) => { calls.push(o); return res } })
    await zapMain(['-t', 'http://localhost:3000', '--report-dir', 'out', '--ignore-file=cfg/ig.json'], deps({ exit: 0, lines: ['x'] }))
    await zapMain(['--target=http://127.0.0.1:4140'], deps({ exit: 0, lines: ['x'] }))
    assert.deepEqual(calls[0], { target: 'http://localhost:3000', reportDir: path.resolve('/proj', 'out'), ignoreFile: path.resolve('/proj', 'cfg/ig.json') })
    assert.deepEqual(calls[1], { target: 'http://127.0.0.1:4140', reportDir: undefined, ignoreFile: path.resolve('/proj', 'docs/security-ignore.json') })
  })

  test('in kết quả: exit 0/1/2 ra stdout, exit 3 ra stderr; trả đúng mã', async () => {
    for (const [exit, where] of [[0, 'out'], [1, 'out'], [2, 'out'], [3, 'err']]) {
      const out = sink()
      const err = sink()
      const code = await zapMain(['-t', 'http://localhost:3000'], { stdout: out, stderr: err, scan: async () => ({ exit, lines: ['dòng 1', 'dòng 2'] }) })
      assert.equal(code, exit)
      assert.equal((where === 'out' ? out : err).text, 'dòng 1\ndòng 2\n')
      assert.equal((where === 'out' ? err : out).text, '')
    }
  })

  test('chạy trọn đường với run giả + báo cáo JSON mẫu: High ⇒ 1, chỉ Medium ⇒ 2, sạch ⇒ 0', async () => {
    const ZAP = '/opt/zaproxy/zap.sh'
    const dir = tmp()
    const mk = (alerts) => JSON.stringify({ site: [{ '@name': 'http://localhost:3000', alerts }] })
    const al = (riskcode, name) => ({ pluginid: String(riskcode), alertRef: String(riskcode), name, riskcode: String(riskcode), riskdesc: '', instances: [{ uri: 'http://localhost:3000/' }], solution: '<p>sửa đi</p>' })
    for (const [alerts, want] of [[[al(3, 'XSS'), al(2, 'CSP')], 1], [[al(2, 'CSP'), al(1, 'Cookie')], 2], [[al(1, 'Cookie')], 0]]) {
      const reportDir = path.join(dir, `r${want}`)
      const run = (file, args) => {
        if (file !== ZAP) return { status: 0, stdout: '', stderr: 'openjdk version "17.0.9"', error: null }
        fs.writeFileSync(path.join(reportDir, 'zap-report.json'), mk(alerts))
        return { status: 0, stdout: '', stderr: '', error: null }
      }
      const out = sink()
      const code = await zapMain(['-t', 'http://localhost:3000', '--report-dir', reportDir, '--ignore-file', path.join(dir, 'khong-co.json')], {
        stdout: out, stderr: sink(), scanDeps: { platform: 'linux', env: { ZAP_PATH: ZAP }, isFile: files(ZAP), run, probe: async () => ({ ok: true }), tmpdir: dir, now: new Date(2026, 9, 13) },
      })
      assert.equal(code, want)
      assert.match(out.text, want === 1 ? /^CHẶN phát hành: 1 lỗi mức cao/ : want === 2 ? /^Cảnh báo \(không chặn\): 1 lỗi mức vừa/ : /^Sạch:/)
    }
  })

  test('tiến trình thật: target ngoài máy ⇒ exit 3; localhost nhưng ZAP_PATH sai ⇒ exit 3 + nói thiếu ZAP; --help ⇒ 0', () => {
    const cwd = tmp()
    const env = { ...process.env, ZAP_PATH: path.join(cwd, 'khong-co', 'zap.bat') }
    const a = spawnSync(process.execPath, [ZAP_SCRIPT, '-t', 'https://example.com'], { cwd, env, encoding: 'utf8' })
    assert.equal(a.status, 3)
    assert.match(a.stderr, /zap-scan từ chối/)
    const b = spawnSync(process.execPath, [ZAP_SCRIPT, '-t', 'http://localhost:9'], { cwd, env, encoding: 'utf8' })
    assert.equal(b.status, 3)
    assert.match(b.stderr, /Chưa quét được: thiếu .*ZAP/)
    const c = spawnSync(process.execPath, [ZAP_SCRIPT, '--help'], { cwd, env, encoding: 'utf8' })
    assert.equal(c.status, 0)
    assert.match(c.stdout, /^zap-scan -t http:\/\/localhost/)
  })
})

// ============================== strix-scan ==============================

// spawn giả: gọi `docker …` ⇒ theo o.docker ({status}|{error}); gọi strix ⇒ ghi lại. `log` giữ thứ tự: docker, "in:<dòng>", strix.
function strixWorld(o = {}) {
  const log = []
  const calls = { docker: [], strix: [] }
  const spawn = (file, args, opts) => {
    if (file === 'docker') {
      log.push('docker'); calls.docker.push({ args, opts })
      return o.docker ?? { status: 0, stdout: '27.3.1\n' }
    }
    log.push('strix'); calls.strix.push({ file, args, opts })
    return o.strix ?? { status: 0 }
  }
  const lines = []
  const err = (s) => { lines.push(s); log.push(`in:${s}`) }
  const home = tmp()
  return { calls, log, lines, deps: { spawn, err, home, env: o.env ?? {}, platform: o.platform ?? 'linux' } }
}

describe('strix-scan', () => {
  test('target không phải máy này ⇒ exit 3, không đụng Docker/strix (giữ guard sẵn có)', () => {
    const dir = tmp()
    for (const args of [
      ['-t', 'https://example.com', '--max-budget', '5'], ['--target=http://10.0.0.5:3000', '--max-budget', '5'], ['-t', '\\\\server\\share', '--max-budget', '5'],
      ['-t', path.join(dir, 'khong-co'), '--max-budget', '5'], ['--target-list', 'ds.txt', '--max-budget', '5'], ['--max-budget', '5'], [],
      ['-t', 'http://localhost:3000', '-t', 'https://example.com', '--max-budget', '5'],
    ]) {
      const w = strixWorld()
      assert.equal(strixMain(args, w.deps), 3, args.join(' '))
      assert.match(w.lines[0], /^strix-scan từ chối: chỉ quét thư mục trên máy hoặc http\(s\):\/\/localhost\|127\.0\.0\.1/)
      assert.deepEqual(w.log.filter((x) => !x.startsWith('in:')), [])
    }
  })

  test('thiếu hoặc sai --max-budget ⇒ exit 3 trước khi hỏi Docker', () => {
    const missing = strixWorld()
    assert.equal(strixMain(['-t', 'http://localhost:3000'], missing.deps), 3)
    assert.equal(missing.lines[0], 'strix-scan từ chối: thiếu --max-budget <USD> (trần chi phí bắt buộc, vd --max-budget 5).')
    for (const v of ['0', '0.0', '-1', 'abc', '5e3', '', 'Infinity', '--scan-mode']) {
      const w = strixWorld()
      const args = ['-t', 'http://localhost:3000', '--max-budget', v]
      assert.equal(strixMain(args, w.deps), 3, `"${v}"`)
      assert.match(w.lines[0], /--max-budget phải là số USD > 0/)
      assert.deepEqual(w.log.filter((x) => !x.startsWith('in:')), [])
    }
    const noValue = strixWorld()
    assert.equal(strixMain(['-t', 'http://localhost:3000', '--max-budget'], noValue.deps), 3)
  })

  test('Docker không chạy được (chưa cài hoặc chưa bật) ⇒ exit 3 "chưa quét sâu được — cần Docker" + lệnh cài theo máy; strix không chạy', () => {
    const base = ['-t', 'http://localhost:3000', '--max-budget', '5']
    for (const [docker, platform, hint] of [
      [{ status: null, error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) }, 'win32', 'winget install -e --id Docker.DockerDesktop'],
      [{ status: 1, stderr: 'Cannot connect to the Docker daemon' }, 'darwin', 'brew install --cask docker'],
      [{ status: 1 }, 'linux', 'https://docs.docker.com/engine/install/'],
    ]) {
      const w = strixWorld({ docker, platform })
      assert.equal(strixMain(base, w.deps), 3)
      assert.match(w.lines[0], /^chưa quét sâu được — cần Docker/)
      assert.ok(w.lines[0].includes(hint), hint)
      assert.match(w.lines[0], /ghi "chưa quét sâu" vào báo cáo phát hành/)
      assert.equal(w.calls.strix.length, 0)
      assert.deepEqual(w.calls.docker[0].args, ['info', '--format', '{{.ServerVersion}}'])
    }
  })

  test('đủ điều kiện: in ước tính chi phí + trần TRƯỚC khi chạy strix; truyền nguyên cờ + -n; tắt telemetry; trả mã của strix', () => {
    const w = strixWorld({ strix: { status: 2 } })
    const args = ['-t', 'http://127.0.0.1:3000', '--max-budget', '5', '--scan-mode', 'quick', '--fail-on', 'high']
    assert.equal(strixMain(args, w.deps), 2)
    assert.deepEqual(w.log.filter((x) => !x.startsWith('in:')), ['docker', 'strix']) // Docker rồi mới strix
    const iStrix = w.log.indexOf('strix')
    assert.ok(w.log.slice(0, iStrix).filter((x) => x.startsWith('in:')).length >= 2) // ước tính + trần đã in trước khi strix chạy
    assert.equal(w.lines[0], `Ước tính chi phí Strix (mode quick): ~${SCAN_MODES.quick[0]} · thời gian ${SCAN_MODES.quick[1]}. Tài liệu Strix không công bố giá; số lấy từ báo cáo cộng đồng.`)
    assert.equal(w.lines.some((l) => /Chưa nêu --scan-mode/.test(l)), false)
    assert.match(w.lines.at(-1), /^Trần đã đặt: \$5 \(--max-budget; Strix có thể vượt nhẹ\)\. Gói ChatGPT không tính theo token nhưng tốn hạn mức\.$/)
    const [s] = w.calls.strix
    assert.equal(s.file, 'strix')
    assert.deepEqual(s.args, ['-n', ...args])
    assert.equal(s.opts.stdio, 'inherit')
    assert.equal(s.opts.env.STRIX_TELEMETRY, '0')
    assert.equal(s.opts.env.STRIX_LLM, 'chatgpt/gpt-6.1-sol')
    assert.equal(s.opts.env.PYTHONUTF8, '1')
    assert.equal(s.opts.env.PYTHONIOENCODING, 'utf-8')
  })

  test('không nêu --scan-mode ⇒ nhắc Strix mặc định deep; mode lạ ⇒ nói không rõ; --max-budget=7.5 và STRIX_LLM khác chatgpt', () => {
    const w = strixWorld({ env: { STRIX_LLM: 'anthropic/claude-x' } })
    assert.equal(strixMain(['--target=http://localhost:3000', '--max-budget=7.5'], w.deps), 0)
    assert.match(w.lines[0], /mode deep\): ~\$5–20\+ · thời gian 1–4 giờ/)
    assert.match(w.lines[1], /Chưa nêu --scan-mode ⇒ Strix mặc định deep \(1–4 giờ\)/)
    assert.equal(w.lines[2], 'Trần đã đặt: $7.5 (--max-budget; Strix có thể vượt nhẹ).')
    assert.equal(w.calls.strix[0].opts.env.STRIX_LLM, 'anthropic/claude-x')

    const odd = strixWorld()
    assert.equal(strixMain(['-t', 'http://localhost:3000', '--max-budget', '3', '--scan-mode=wild'], odd.deps), 0)
    assert.match(odd.lines[0], /không rõ cho mode "wild"/)
  })

  test('thư mục trên máy vẫn quét được; strix không trả mã (status null) ⇒ 1; dùng strix.exe trong ~/.local/bin nếu có', () => {
    const w = strixWorld({ strix: { status: null } })
    const dir = tmp()
    assert.equal(strixMain(['-t', dir, '--max-budget', '2', '--scan-mode', 'standard'], w.deps), 1)
    assert.match(w.lines[0], /mode standard\): ~\$2–8 · thời gian 30–60 phút/)

    const exe = path.join(w.deps.home, '.local', 'bin', 'strix.exe')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, '')
    const w2 = strixWorld()
    w2.deps.home = w.deps.home
    strixMain(['-t', 'http://localhost:3000', '--max-budget', '2'], w2.deps)
    assert.equal(w2.calls.strix[0].file, exe)
  })

  test('tiến trình thật: target ngoài ⇒ 3; thiếu --max-budget ⇒ 3; PATH rỗng (không có docker) ⇒ 3 "chưa quét sâu"', () => {
    const cwd = tmp()
    const emptyBin = tmp('khong-co-docker ')
    const noDockerEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)))
    noDockerEnv.PATH = emptyBin
    const run = (args, env = process.env) => spawnSync(process.execPath, [STRIX_SCRIPT, ...args], { cwd, env, encoding: 'utf8' })

    const a = run(['-t', 'https://example.com', '--max-budget', '5'])
    assert.equal(a.status, 3)
    assert.match(a.stderr, /strix-scan từ chối: chỉ quét thư mục/)
    const b = run(['-t', 'http://localhost:3000'])
    assert.equal(b.status, 3)
    assert.match(b.stderr, /thiếu --max-budget/)
    const c = run(['-t', 'http://localhost:3000', '--max-budget', '5'], noDockerEnv)
    assert.equal(c.status, 3)
    assert.match(c.stderr, /^chưa quét sâu được — cần Docker/)
  })
})
