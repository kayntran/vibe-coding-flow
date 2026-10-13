#!/usr/bin/env node
// mac-check: chạy bộ kiểm của kit trên Mac bằng MỘT lệnh (cùng bộ `node --test` đang chạy trên Windows). Spec: docs/specs/2026-10-13-flow-v7-dot4 (AC-26).
// Tên KHÔNG được khớp mẫu file test mặc định của `node --test` (*-test.mjs …) — nếu khớp, chạy toàn bộ test sẽ tự gọi sang Mac.
//   node hooks/mac-check.mjs [--host macmini] [--only <glob test>]…     ví dụ: --only hooks/lib/luu.test.mjs   (--only lặp được; gạch chéo ngược tự đổi thành /)
// Cách làm: git bundle của HEAD (chỉ phần ĐÃ commit; có file chưa commit thì in lưu ý) -> ssh `mktemp -d /tmp/flowtest-XXXXXX` tạo thư mục RIÊNG trên Mac
//   (0700, tên ngẫu nhiên; không dùng tên đoán trước được như sha/giờ — user khác trên Mac đặt sẵn symlink thì scp đã ghi đè đích) -> scp bundle VÀO thư mục đó
//   -> ssh chạy `node --test --test-reporter=tap` -> in tổng kết (tests/pass/fail + tên bài hỏng). Mọi giá trị đi sang Mac nằm TRONG script gửi qua stdin của `ssh host bash -s`
//   (đã trích dẫn; đường thư mục do mktemp trả về chỉ được nhận khi đúng /tmp/flowtest-<chữ+số>); dòng lệnh ssh/scp chỉ có mảng tham số cố định. Việc dọn nằm TRONG script đó
//   (trap EXIT/HUP/INT/TERM, chỉ xoá đúng thư mục riêng khớp /tmp/flowtest-*, bundle nằm trong đó nên đi theo): không có dòng lệnh nào của người dùng hay AI chứa thao tác xoá thư mục.
//   Bài hỏng vì Mac thiếu công cụ (spawn x ENOENT, "x: command not found") được tách khỏi lỗi kit.
// Exit: 0 xanh (kể cả khi chỉ có bài không chạy được vì Mac thiếu công cụ) · 1 có bài hỏng / Mac không dựng được bản sao / không đọc được kết quả · 2 dùng sai · 3 không ssh được hoặc Mac chưa có node/git.
// Lõi (buildCommands, remoteCommands, remoteScript, parseTap, summarize, macTest) là hàm thuần/tiêm `run`: test không cần Mac thật.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_HOST = 'macmini'
export const MAC_PATH = '/opt/homebrew/bin:/usr/local/bin'
export const MARK = '@@FLOWTEST@@'
const BUNDLE_NAME = 'flowtest.bundle'
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
// Thư mục riêng do mktemp trên Mac trả về: /tmp/flowtest- + 6..32 chữ/số (mktemp thật cho 6 ký tự). Dùng cả để nhận đường dẫn lẫn để chặn giá trị lạ vào script.
const DIR_PATTERN = '/tmp/flowtest-[A-Za-z0-9]{6,32}'
const DIR_RE = new RegExp(`^${DIR_PATTERN}$`)
const SHA_RE = /^[0-9a-f]{40}$/
const HOST_RE = /^([\w.][\w.-]*@)?[A-Za-z0-9][\w.-]*$/
const GLOB_RE = /^[\w.\/*?[\]{},@+=-]+$/
const TIMEOUT = { probe: 20_000, bundle: 120_000, copy: 180_000, run: 20 * 60_000, clean: 30_000 }
const MAX_LIST = 20

const USAGE = `dùng: mac-check.mjs [--host macmini] [--only <glob test>]…
  chạy bộ kiểm của kit trên Mac (bản đã commit của nhánh hiện tại), in tổng kết, tự dọn thư mục tạm trên Mac
  --only hooks/lib/luu.test.mjs   chỉ chạy test khớp (lặp được)
exit: 0 xanh · 1 có bài hỏng · 2 dùng sai · 3 không ssh được / Mac chưa có node hoặc git`

export class UsageError extends Error {}

const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function parseArgs(argv) {
  const o = { host: DEFAULT_HOST, only: [], help: false }
  const value = (a, flag, i) => (a === flag ? argv[i + 1] : a.slice(flag.length + 1))
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') o.help = true
    else if (a === '--host' || a.startsWith('--host=')) {
      const v = value(a, '--host', i)
      if (a === '--host') i++
      if (!HOST_RE.test(v ?? '')) throw new UsageError(`--host cần tên máy hợp lệ (vd macmini hoặc user@10.0.0.5), nhận "${clean(v, 60)}"`)
      o.host = v
    } else if (a === '--only' || a.startsWith('--only=')) {
      const raw = value(a, '--only', i)
      if (a === '--only') i++
      const v = String(raw ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
      if (!GLOB_RE.test(v) || v.startsWith('-') || v.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(v)) {
        throw new UsageError(`--only cần đường dẫn/glob test trong kit (không dấu cách, không .., không bắt đầu bằng / hoặc -), nhận "${clean(raw, 60)}"`)
      }
      o.only.push(v)
    } else throw new UsageError(`không hiểu "${clean(a, 60)}"`)
  }
  return o
}

// Script tạo thư mục riêng trên Mac: mktemp -d (0700, tên ngẫu nhiên) rồi in đường dẫn sau MARK. Chưa chép gì sang nên chưa có gì để dọn nếu lỗi.
const MKDIR_SCRIPT = [`export PATH=${shq(MAC_PATH)}":$PATH"`, 'd=$(mktemp -d /tmp/flowtest-XXXXXX </dev/null) || exit 98', `echo "${MARK} dir $d"`, ''].join('\n')

// Script bash gửi qua stdin của `ssh host bash -s` (bash 3.2 của macOS chạy được; chỉ ASCII). dir = thư mục riêng mktemp đã tạo (bundle nằm trong đó).
// mode: 'run' = dựng bản sao + chạy test, 'clean' = chỉ dọn thư mục riêng (gọi lại được nhiều lần).
export function remoteScript({ dir, sha, only = [], mode = 'run' }) {
  if (!DIR_RE.test(dir ?? '')) throw new Error(`thư mục tạm lạ: ${dir}`)
  if (!SHA_RE.test(sha)) throw new Error(`mã commit lạ: ${sha}`)
  const lines = [
    `export PATH=${shq(MAC_PATH)}":$PATH"`,
    `DIR=${dir}`,
    'BUNDLE="$DIR/flowtest.bundle"',
    'cleanup() {',
    '  case "$DIR" in /tmp/flowtest-*) rm -rf -- "$DIR" ;; esac',
    `  if [ ! -e "$DIR" ]; then echo '${MARK} cleaned'; else echo '${MARK} not-cleaned'; fi`,
    '}',
  ]
  if (mode === 'clean') return [...lines, 'cleanup', 'exit 0', ''].join('\n')
  return [
    ...lines,
    'trap cleanup EXIT',
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    'for t in node git; do',
    `  command -v "$t" >/dev/null 2>&1 || { echo "${MARK} missing $t"; exit 97; }`,
    'done',
    `echo "${MARK} node $(node -v </dev/null)"`,
    '[ -d "$DIR" ] && [ ! -L "$DIR" ] || exit 98',
    'git -c advice.detachedHead=false clone -q "$BUNDLE" "$DIR/kit" </dev/null || exit 98',
    `cd "$DIR/kit" && git checkout -q --detach ${sha} </dev/null || exit 98`,
    `node --test --test-reporter=tap${only.map((g) => ` ${shq(g)}`).join('')} </dev/null`,
    'rc=$?',
    'exit "$rc"',
    '',
  ].join('\n')
}

// Dựng các lệnh dưới dạng { cmd, args, cwd?, input?, timeout }. Đường dẫn máy này chỉ xuất hiện làm phần tử mảng (git cwd / đích bundle); scp dùng tên tương đối + cwd.
const sshScript = (host, script, timeout) => ({ cmd: 'ssh', args: ['-T', ...SSH_OPTS, '--', host, 'bash -s'], input: script, timeout })
// Các lệnh chưa cần biết thư mục riêng trên Mac: thử ssh, đóng gói bản local, tạo thư mục riêng (mktemp).
export function buildCommands({ host, repo, bundleDir }) {
  return {
    probe: { cmd: 'ssh', args: ['-T', ...SSH_OPTS, '--', host, 'true'], timeout: TIMEOUT.probe },
    bundle: { cmd: 'git', args: ['bundle', 'create', path.join(bundleDir, BUNDLE_NAME), 'HEAD'], cwd: repo, timeout: TIMEOUT.bundle },
    mkdir: sshScript(host, MKDIR_SCRIPT, TIMEOUT.probe),
  }
}
// Các lệnh sau khi mktemp trả thư mục riêng `dir`: chép bundle VÀO thư mục đó, chạy bộ kiểm, dọn đúng thư mục đó.
export function remoteCommands({ host, dir, sha, only = [], bundleDir }) {
  return {
    copy: { cmd: 'scp', args: ['-q', ...SSH_OPTS, '--', BUNDLE_NAME, `${host}:${dir}/${BUNDLE_NAME}`], cwd: bundleDir, timeout: TIMEOUT.copy },
    run: sshScript(host, remoteScript({ dir, sha, only, mode: 'run' }), TIMEOUT.run),
    clean: sshScript(host, remoteScript({ dir, sha, only, mode: 'clean' }), TIMEOUT.clean),
  }
}

// TAP của node:test -> { tests, pass, fail, failures:[{ name, file, error, block }] } (failures = bài hỏng LÁ: cha chỉ hỏng vì con hỏng thì không tính).
export function parseTap(text) {
  const entries = []
  const sum = {}
  let cur = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    let m = /^(\s*)(not ok|ok) \d+ - (.*)$/.exec(line)
    if (m) {
      cur = { indent: m[1].length, ok: m[2] === 'ok', name: m[3], block: [] }
      entries.push(cur)
    } else if ((m = /^# (tests|pass|fail) (\d+)\s*$/.exec(line))) {
      sum[m[1]] = Number(m[2])
      cur = null
    } else if (/^\s*# Subtest:/.test(line)) cur = null
    else if (cur && /^\s/.test(line)) cur.block.push(line)
  }
  const failures = []
  entries.forEach((e, i) => {
    if (e.ok) return
    for (let j = i - 1; j >= 0 && entries[j].indent > e.indent; j--) if (!entries[j].ok) return
    const block = e.block.join('\n')
    const loc = /location:\s*['"]?(.+?)(?::\d+:\d+)?['"]?\s*$/m.exec(block)
    failures.push({ name: relFile(e.name), file: loc ? relFile(loc[1]) : '', error: errorLine(e.block), block })
  })
  return { tests: sum.tests, pass: sum.pass, fail: sum.fail, hasSummary: sum.tests !== undefined, failures }
}
const relFile = (p) => String(p).replace(/^.*\/flowtest-[^/]+\/kit\//, '')
// `error: 'một dòng'` hoặc `error: |-` rồi dòng thụt vào: lấy dòng đầu có chữ.
function errorLine(lines) {
  const i = lines.findIndex((l) => /^\s*error:/.test(l))
  if (i < 0) return ''
  const v = lines[i].replace(/^\s*error:\s*/, '')
  const first = /^[|>][-+]?$/.test(v) ? (lines.slice(i + 1).map((l) => l.trim()).find(Boolean) ?? '') : v
  return first.replace(/^'(.*)'$/, '$1')
}

const MISSING_RES = [/spawn(?:Sync)? (\S+) ENOENT/, /(\S+): command not found/, /env: (\S+): No such file or directory/]
// Bài hỏng vì Mac thiếu công cụ ngoài -> tên công cụ; không phải kiểu đó -> null.
export function missingTool(text) {
  for (const re of MISSING_RES) {
    const m = re.exec(String(text ?? ''))
    if (m) return m[1].replace(/^['"`]|['"`,:;]+$/g, '').split(/[\\/]/).pop() || null
  }
  return null
}

const cap = (arr, render) => [...arr.slice(0, MAX_LIST).map(render), ...(arr.length > MAX_LIST ? [`  … và ${arr.length - MAX_LIST} bài nữa`] : [])]

// Kết quả chạy test trên Mac -> { exit, lines } đời thường. status = mã thoát của script từ xa (0/1 từ node --test).
export function summarize({ host, nodeVer, status, stdout, stderr, only = [] }) {
  const tap = parseTap(stdout)
  const head = `Mac (${host}${nodeVer ? `, node ${nodeVer}` : ''})`
  if (!tap.hasSummary) {
    const tail = clean(String(stderr || stdout).split(/\r?\n/).filter((l) => l.trim() && !l.includes(MARK)).slice(-6).join(' | '), 400)
    return { exit: 1, lines: [`${head}: không đọc được kết quả kiểm (mã ${status}).${tail ? ` Cuối log: ${tail}` : ''}`] }
  }
  if (tap.tests === 0) return { exit: 1, lines: [`${head}: không có bài kiểm nào chạy${only.length ? ` — --only ${only.join(' ')} có khớp file nào trong kit không?` : ''}.`] }
  const kit = []
  const machine = []
  for (const f of tap.failures) {
    const tool = missingTool(f.block)
    if (tool) machine.push({ ...f, tool })
    else kit.push(f)
  }
  const bad = kit.length > 0 || (tap.fail > 0 && tap.failures.length === 0) || (status !== 0 && status !== 1)
  const lines = [`${head}: ${tap.tests} bài · ${tap.pass} đạt · ${tap.fail} hỏng${bad ? '' : ' — xanh'}`]
  if (kit.length) lines.push(`Hỏng do kit (${kit.length}):`, ...cap(kit, (f) => `  - ${clean(`${f.file && f.file !== f.name ? `${f.file} > ` : ''}${f.name}${f.error ? ` — ${f.error}` : ''}`, 220)}`))
  else if (bad) lines.push(`Có bài hỏng nhưng không đọc được tên (mã thoát ${status}) — chạy lại với --only để xem.`)
  if (machine.length) {
    const tools = [...new Set(machine.map((f) => f.tool))].sort()
    lines.push(`Thiếu công cụ trên Mac, KHÔNG phải lỗi kit (${machine.length} bài): ${tools.join(', ')}`)
  }
  return { exit: bad ? 1 : 0, lines }
}

const defaultRun = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', input: o.input, cwd: o.cwd, timeout: o.timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true })
const defaultTmp = {
  make: () => fs.mkdtempSync(path.join(os.tmpdir(), 'flowtest-')),
  remove: (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
}

// Chạy cả quy trình. deps tiêm để test: { run(cmd,args,{cwd,input,timeout}) -> {status,stdout,stderr,error}, tmp:{make,remove}, say(dòng tiến trình), now }.
// Trả { exit, lines } (lines = kết quả cuối). Thư mục tạm trên máy này luôn được gỡ ở finally (Node API, không phải dòng lệnh).
export function macTest({ repo, host = DEFAULT_HOST, only = [], run = defaultRun, tmp = defaultTmp, say = () => {} }) {
  const git = (...args) => run('git', args, { cwd: repo, timeout: 30_000 })
  const head = git('rev-parse', 'HEAD')
  const sha = String(head.stdout ?? '').trim()
  if (head.status !== 0 || !SHA_RE.test(sha)) return { exit: 1, lines: ['Không đọc được git của kit (thư mục này có phải repo git không?).'] }
  const branch = clean(git('rev-parse', '--abbrev-ref', 'HEAD').stdout, 80) || 'HEAD'
  say(`Gửi sang ${host}: nhánh ${branch} (commit ${sha.slice(0, 7)}).`)
  if (String(git('status', '--porcelain').stdout ?? '').trim()) say('Lưu ý: còn thay đổi chưa commit — Mac chỉ nhận phần đã commit.')

  const bundleDir = tmp.make()
  try {
    const cmds = buildCommands({ host, repo, bundleDir })
    const exec = (c) => run(c.cmd, c.args, c)
    const probe = exec(cmds.probe)
    if (probe.error?.code === 'ENOENT') return { exit: 3, lines: ['Máy này chưa có lệnh ssh nên không nối được tới Mac.'] }
    if (probe.status !== 0) {
      return { exit: 3, lines: [`Không nối được tới Mac (${host}). ${clean(probe.stderr || probe.error?.message, 160)}`, `Kiểm tra: Mac đang bật, cùng mạng, và gõ "ssh ${host}" vào được mà không hỏi mật khẩu.`] }
    }
    say('Đóng gói bản hiện tại…')
    const b = exec(cmds.bundle)
    if (b.status !== 0) return { exit: 1, lines: [`Không đóng gói được bản hiện tại: ${clean(b.stderr || b.error?.message, 160)}`] }
    // Thư mục riêng trên Mac tạo TRƯỚC khi chép: tên ngẫu nhiên + 0700 nên user khác trên Mac không đặt sẵn được symlink để scp ghi đè đích.
    const mk = exec(cmds.mkdir)
    const dir = new RegExp(`${MARK} dir (${DIR_PATTERN})\\s*$`, 'm').exec(String(mk.stdout ?? ''))?.[1]
    if (mk.status !== 0 || !dir) {
      return { exit: 3, lines: [`Không tạo được thư mục tạm trên Mac (${host}): ${clean(mk.stderr || mk.error?.message, 160) || 'mktemp không trả đường dẫn thư mục hợp lệ'}`] }
    }
    const remote = remoteCommands({ host, dir, sha, only, bundleDir })
    const dropTemp = () => {
      const c = exec(remote.clean)
      return String(c.stdout ?? '').includes(`${MARK} cleaned`)
    }
    say('Chép sang Mac…')
    const c = exec(remote.copy)
    if (c.status !== 0) {
      dropTemp()
      return { exit: 3, lines: [`Không chép được sang Mac (${host}): ${clean(c.stderr || c.error?.message, 160)}`] }
    }
    say('Chạy bộ kiểm trên Mac…')
    const r = exec(remote.run)
    const out = String(r.stdout ?? '')
    const cleaned = out.includes(`${MARK} cleaned`) || dropTemp()
    const tail = [cleaned ? 'Đã dọn thư mục tạm trên Mac.' : `Chưa dọn được thư mục tạm trên Mac: ${dir} (macOS tự dọn /tmp khi khởi động lại).`]
    const done = (res) => ({ exit: res.exit, lines: [...res.lines, ...tail] })
    if (r.error?.code === 'ETIMEDOUT') return done({ exit: 1, lines: [`Bộ kiểm trên Mac chạy quá ${TIMEOUT.run / 60_000} phút nên đã dừng.`] })
    if (r.status === 255 || (r.status === null && r.error)) return done({ exit: 3, lines: [`Mất kết nối với Mac (${host}) giữa chừng: ${clean(r.stderr || r.error?.message, 160)}`] })
    if (r.status === 97) {
      const tool = /missing (\w+)/.exec(out)?.[1] ?? 'node/git'
      return done({ exit: 3, lines: [`Mac chưa có ${tool} (tìm trong ${MAC_PATH} và PATH mặc định). Cài ${tool} trên Mac rồi chạy lại.`] })
    }
    if (r.status === 98) return done({ exit: 1, lines: [`Mac không dựng được bản sao để chạy: ${clean(r.stderr, 160)}`] })
    const nodeVer = new RegExp(`${MARK} node (\\S+)`).exec(out)?.[1]
    return done(summarize({ host, nodeVer, status: r.status, stdout: out, stderr: r.stderr, only }))
  } finally {
    tmp.remove(bundleDir)
  }
}

// deps tiêm để test: { run, tmp, repo, stdout, stderr }. Trả mã thoát.
export function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? process.stdout
  const errOut = deps.stderr ?? process.stderr
  let o
  try {
    o = parseArgs(argv)
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    errOut.write(`mac-check: ${e.message}\n${USAGE}\n`)
    return 2
  }
  if (o.help) {
    out.write(`${USAGE}\n`)
    return 0
  }
  const repo = deps.repo ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const res = macTest({ repo, host: o.host, only: o.only, run: deps.run, tmp: deps.tmp, say: (s) => out.write(`${s}\n`) })
  out.write(`${res.lines.join('\n')}\n`)
  return res.exit
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
