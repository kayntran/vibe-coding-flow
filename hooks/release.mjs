// release: CLI mỏng cho phát hành / quay lại / nhật ký sau phát hành. Lõi ở hooks/lib/release.mjs (hàm thuần); trạng thái ở
// <dự án>/.claude/release.json qua hooks/lib/release-state.mjs. Mọi lệnh ngoài chạy bằng spawnSync mảng tham số (không qua shell).
// Spec: docs/specs/2026-10-13-flow-v7-dot4 (AC-22b, 48, 48a, 48c, 48e, 48f).
// Lỗi nội bộ ⇒ một dòng vào ~/.claude/logs/release.log + exit 1.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, dropDueMarks, formatLogs, formatPreflight, parseSince, preflight, readLogs, readWorkerName, releaseCf, releaseVps, rollbackCf } from './lib/release.mjs'
import { readState } from './lib/release-state.mjs'

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url))

const USAGE = `release.mjs — phát hành, quay lại, xem lỗi sau phát hành
  preflight [--dir D] [--zap-exit N] [--has-data] [--first-release]
      Kiểm trước khi phát hành: dấu review/QA/test, khoá trong bản build, kết quả quét bảo mật (--zap-exit = mã thoát của zap-scan),
      đã thử quay lại (chỉ đòi khi đã phát hành từ 2 lần), sao lưu. Còn mục thiếu ⇒ exit 1 kèm từng mục bằng lời.
      Repo cho sửa thẳng nhánh chính (.claude/allow-direct-edit) không có dấu để kiểm ⇒ in cảnh báo (không chặn).
  cf [--dir D] [--url https://…] [--worker tên] [--message m] [--zap-exit N] [--has-data] [--first-release]
      Cloudflare Workers: build (nếu package.json có script build) → tự chạy preflight trên bản vừa build (cùng cờ; chặn ⇒ exit 1, chưa tải gì)
      → tải đúng bản đó lên → gắn bản mới vào deployment ở 0% (bản cũ giữ 100%) → xác nhận địa chỉ thật đang phục vụ đúng bản mới (header
      x-flow-version của Worker == mã bản mới, dò tối đa 10 lần × 2 giây; không xác nhận được ⇒ gỡ bản mới, exit 1) → chạy bài thử nhanh
      (@smoke) nhắm đúng bản mới → đạt mới mở 100%; trượt ⇒ gỡ bản mới, bản cũ giữ 100%. Trước khi mở/gỡ đều đọc lại deployment: có lượt
      phát hành khác chen vào ⇒ không đụng gì. Phát hành đạt ⇒ lưu --url đã thử làm target. --first-release: Worker chưa có trên
      Cloudflare (lần phát hành đầu) ⇒ tạo bằng "wrangler deploy" rồi thử nhanh địa chỉ thật; Worker đã có thì cờ này không đổi đường đi.
  rollback [--dir D] [--url https://…] [--worker tên] [--message m] [--version-id id]
      Cloudflare Workers: quay về bản trước (wrangler rollback), thử nhanh lại. Dữ liệu không quay theo.
      --worker chỉ cần khi wrangler.jsonc không có "name".
  vps --mode symlink|docker --host user@máy --root /đường/dẫn [--dist dist] [--service tên] [--sudo] [--sha mã] [--keep 3]
      [--url https://…] [--rollback] [--run] [--zap-exit N] [--has-data] [--first-release]
      Không có --run: chỉ in lệnh (phát hành, quay lại một lệnh, liệt kê bản cũ). Có --run: tự chạy preflight (cùng cờ; chặn ⇒ exit 1,
      chưa đụng máy chủ) rồi chạy thật qua ssh và thử nhanh. --rollback --run không qua preflight (cứu hộ).
  logs [--since 24h|7d|90m] [--dir D] [--worker tên] [--account id] [--project-ref mã] [--host …] [--root …] [--service …] [--mode …]
      Đọc nhật ký lỗi theo nơi chạy app (logs.source trong .claude/release.json) và kể bằng lời.
--first-release chỉ có nghĩa với cf (cho phép tạo Worker lần đầu); preflight và vps nhận cờ này cho tương thích nhưng không dùng.
exit: 0 đạt · 1 không đạt/chặn/dùng sai · 3 thiếu công cụ hoặc điều kiện (kèm cách xử lý)`

const SPEC = {
  preflight: { value: ['dir', 'zap-exit'], bool: ['has-data', 'first-release'] },
  cf: { value: ['dir', 'url', 'worker', 'message', 'zap-exit'], bool: ['has-data', 'first-release'] },
  rollback: { value: ['dir', 'url', 'worker', 'message', 'version-id'], bool: [] },
  vps: { value: ['dir', 'url', 'mode', 'host', 'root', 'dist', 'service', 'sha', 'keep', 'zap-exit'], bool: ['sudo', 'rollback', 'run', 'has-data', 'first-release'] },
  logs: { value: ['dir', 'since', 'worker', 'account', 'project-ref', 'host', 'root', 'service', 'mode'], bool: [] },
}

// Trình quản lý gói trên Windows là file .cmd/.ps1, spawnSync không shell không chạy được (ENOENT/EINVAL) ⇒ đi qua cmd.exe, nhưng chỉ
// với đối số "an toàn" (chữ, số, . : = / @ -) để không có chuyện chèn lệnh. K7 chỉ cần `<pm> run build`.
const WIN_SHIMS = new Set(['npm', 'pnpm', 'yarn'])
const SAFE_ARG = /^[\w.:=/@-]+$/

// Chạy lệnh ngoài: mảng tham số, không shell, stdin đóng ngay (lệnh đòi gõ gì đó sẽ nhận EOF thay vì treo).
// opts.env: giá trị undefined ⇒ gỡ biến khỏi môi trường con.
export function realRun(cmd, args, opts = {}) {
  const env = { ...process.env }
  for (const [k, v] of Object.entries(opts.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v }
  let exe = cmd
  let argv = args
  const extra = {}
  if (process.platform === 'win32' && WIN_SHIMS.has(cmd)) {
    if (!args.every((a) => SAFE_ARG.test(a))) return { status: null, stdout: '', stderr: '', error: 'EUNSAFE' }
    exe = env.ComSpec || env.COMSPEC || 'cmd.exe'
    argv = ['/d', '/s', '/c', `"${[cmd, ...args].join(' ')}"`]
    extra.windowsVerbatimArguments = true
  }
  const r = spawnSync(exe, argv, { cwd: opts.cwd, env, encoding: 'utf8', input: opts.input ?? '', timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 << 20, windowsHide: true, ...extra })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? (r.error.code || r.error.message) : null }
}

function parseFlags(cmd, argv) {
  const spec = SPEC[cmd]
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) return { usage: `đối số thừa "${a}"` }
    const eq = a.indexOf('=')
    const name = (eq < 0 ? a : a.slice(0, eq)).slice(2)
    if (spec.bool.includes(name)) {
      if (eq >= 0) return { usage: `--${name} không nhận giá trị` }
      o[name] = true
    } else if (spec.value.includes(name)) {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i]
      if (v === undefined || (eq < 0 && v.startsWith('--'))) return { usage: `--${name} cần một giá trị` }
      o[name] = v
    } else return { usage: `cờ lạ --${name}` }
  }
  return { o }
}

function logInternal(e, logDir) {
  try {
    const d = logDir ?? path.join(os.homedir(), '.claude', 'logs')
    fs.mkdirSync(d, { recursive: true })
    fs.appendFileSync(path.join(d, 'release.log'), `${new Date().toISOString()} ${String(e?.stack ?? e).replace(/\r?\n/g, ' | ').slice(0, 500)}\n`)
  } catch { /* bỏ qua */ }
}

// deps (để test): { run, fetch, env, now, sleep, stdout, stderr, logDir, hooksDir }. Trả mã thoát.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? process.stdout
  const err = deps.stderr ?? process.stderr
  const print = (lines) => out.write(`${lines.join('\n')}\n`)
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { out.write(`${USAGE}\n`); return cmd ? EXIT.OK : EXIT.FAIL }
  if (!SPEC[cmd]) { err.write(`release: lệnh lạ "${cmd}"\n${USAGE}\n`); return EXIT.FAIL }
  const parsed = parseFlags(cmd, rest)
  if (parsed.usage) { err.write(`release ${cmd}: ${parsed.usage}\n${USAGE}\n`); return EXIT.FAIL }
  const o = parsed.o
  const dir = path.resolve(o.dir ?? process.cwd())
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a dir')
  } catch { err.write(`release: không thấy thư mục dự án: ${dir}\n`); return EXIT.FAIL }

  const run = deps.run ?? realRun
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now()
  // Giờ ghi mốc phát hành = lúc bản mới được mở 100% (không phải lúc lệnh bắt đầu); test tiêm `now` thì giữ giờ cố định.
  const clock = deps.now === undefined ? Date.now : undefined
  const so = deps.logDir ? { logDir: deps.logDir } : undefined
  let zapExit
  if (o['zap-exit'] !== undefined) {
    if (!/^\d+$/.test(o['zap-exit'])) { err.write(`release ${cmd}: --zap-exit phải là số (mã thoát của zap-scan)\n`); return EXIT.FAIL }
    zapExit = Number(o['zap-exit'])
  }
  // Cờ của preflight; cf và vps --run tự chạy preflight với đúng các cờ này trước khi đụng Cloudflare/máy chủ.
  const gate = { hooksDir: deps.hooksDir ?? HOOKS_DIR, zapExit, hasData: !!o['has-data'], firstRelease: !!o['first-release'] }
  try {
    if (cmd === 'preflight') {
      const r = preflight({ dir, state: readState(dir, so), now, run, ...gate })
      print(formatPreflight(r))
      return r.ok ? EXIT.OK : EXIT.FAIL
    }
    if (cmd === 'cf') {
      const r = releaseCf({ dir, url: o.url, worker: o.worker, message: o.message, run, now, clock, sleep: deps.sleep, say: (s) => err.write(`${s}\n`), stateOpts: so, ...gate })
      print(r.lines)
      return r.code
    }
    if (cmd === 'rollback') {
      const r = rollbackCf({ dir, url: o.url, worker: o.worker, message: o.message, versionId: o['version-id'], run, stateOpts: so })
      print(r.lines)
      return r.code
    }
    if (cmd === 'vps') {
      const saved = readState(dir, so)?.vps ?? {}
      const r = releaseVps({
        dir, run, now, clock, stateOpts: so, url: o.url, rollback: !!o.rollback, doRun: !!o.run, sha: o.sha, keep: o.keep,
        mode: o.mode ?? saved.mode, host: o.host ?? saved.host, root: o.root ?? saved.root, dist: o.dist ?? saved.dist,
        service: o.service ?? saved.service, sudo: o.sudo || saved.sudo === true, ...gate,
      })
      print(r.lines)
      return r.code
    }
    // logs
    const since = parseSince(o.since ?? '24h')
    if (since === null) { err.write('release logs: --since dạng 90m, 24h hoặc 7d\n'); return EXIT.FAIL }
    const state = readState(dir, so)
    const saved = state?.vps ?? {}
    const result = await readLogs({
      state, since, now, env, fetch: deps.fetch, run,
      opts: {
        worker: o.worker ?? readWorkerName(dir) ?? undefined, account: o.account, projectRef: o['project-ref'],
        host: o.host ?? saved.host, root: o.root ?? saved.root, service: o.service ?? saved.service, mode: o.mode ?? saved.mode,
      },
    })
    print(formatLogs(result))
    if (result.status === 'unreachable') return EXIT.MISSING
    dropDueMarks(dir, now, so) // đã xem nhật ký ⇒ bỏ các mốc nhắc đã tới hạn (không đọc được thì giữ lại để còn nhắc)
    return EXIT.OK
  } catch (e) {
    logInternal(e, deps.logDir)
    err.write('release gặp lỗi nội bộ (đã ghi vào ~/.claude/logs/release.log); chạy lại, nếu lặp lại thì báo kit.\n')
    return EXIT.FAIL
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code })
}
