#!/usr/bin/env node
// backup: sao lưu dữ liệu app, thử khôi phục vào chỗ tạm, cài lịch tự chạy. Spec: docs/specs/2026-10-13-flow-v7-dot4 (AC-23, AC-23a).
//   node hooks/backup.mjs chon on|off <thư mục app> [--method d1|pg] [--db <tên D1>] [--url-env <BIẾN>] [--schemas a,b] [--dest <thư mục>] [--every <giờ>] [--supabase-free] [--co-storage] --dong-y
//   node hooks/backup.mjs chay <thư mục app> --dong-y            sao lưu ngay một lần (D1: wrangler d1 export · Postgres: pg_dump) vào <dest>/<ngày>/
//   node hooks/backup.mjs khoi-phuc-thu <thư mục app> --dong-y   khôi phục bản mới nhất vào chỗ tạm, so số dòng từng bảng + truy vấn mẫu, đạt thì ghi docs/BACKUP.md
//   node hooks/backup.mjs lich <thư mục app> --dong-y            cài lịch chạy "chay" trên máy (Windows schtasks / Mac launchd / Linux cron)
//   node hooks/backup.mjs trang-thai <thư mục app>               chỉ đọc: lịch có thật trên máy không, bản gần nhất có quá hạn không
// KHÔNG làm gì khi người dùng chưa gật: mọi lệnh ghi/chạy đòi --dong-y (thiếu ⇒ exit 4 + câu hỏi đời thường để AI hỏi người dùng).
// Exit: 0 xong · 1 không đạt/bị chặn/dùng sai · 3 thiếu công cụ hoặc điều kiện (kèm lệnh cài) · 4 cần người dùng gật.
// Lõi ở hooks/lib/backup.mjs (không in ra, lệnh ngoài qua deps.run).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, choose, logLine, restoreCheck, runBackup, schedule, status } from './lib/backup.mjs'

const USAGE = `dùng: backup.mjs <lệnh> <thư mục app> [cờ]
  chon on|off   ghi lựa chọn sao lưu (on: --method d1|pg, --db, --url-env, --schemas, --dest, --every, --co-storage; Supabase miễn phí: --method pg --supabase-free)
  chay          sao lưu ngay một lần
  khoi-phuc-thu thử khôi phục bản mới nhất vào chỗ tạm
  lich          cài lịch tự chạy trên máy
  trang-thai    xem tình trạng (chỉ đọc)
  --dong-y      người dùng đã đồng ý (bắt buộc với mọi lệnh trừ trang-thai)
exit: 0 xong · 1 không đạt/bị chặn/dùng sai · 3 thiếu công cụ/điều kiện · 4 cần người dùng gật`

export class UsageError extends Error {}

const COMMANDS = ['chon', 'chay', 'khoi-phuc-thu', 'lich', 'trang-thai']
const clean = (s, max = 60) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)

// -> { cmd, mode?, appDir, method?, db?, dest?, every?, urlEnv?, schemas?, supabaseFree, storage, agreed, help }
export function parseArgs(argv) {
  const o = { supabaseFree: false, storage: false, agreed: false, help: false }
  const pos = []
  const value = (a, flag, i) => (a === flag ? argv[i + 1] : a.slice(flag.length + 1))
  const take = (flag, a, i) => {
    const v = value(a, flag, i)
    if (a === flag) i++
    if (v === undefined || v === '' || (a === flag && String(v).startsWith('--'))) throw new UsageError(`${flag} cần một giá trị`)
    return [v, i]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') o.help = true
    else if (a === '--dong-y') o.agreed = true
    else if (a === '--supabase-free') o.supabaseFree = true
    else if (a === '--co-storage') o.storage = true
    else if (/^--(method|db|dest|every|url-env|schemas)(=|$)/.test(a)) {
      const flag = a.split('=')[0]
      let v
      ;[v, i] = take(flag, a, i)
      if (flag === '--method') {
        if (!['d1', 'pg'].includes(v)) throw new UsageError(`--method chỉ nhận d1 hoặc pg, nhận "${clean(v)}"`)
        o.method = v
      } else if (flag === '--every') {
        if (!/^\d+$/.test(v)) throw new UsageError(`--every cần số giờ nguyên, nhận "${clean(v)}"`)
        o.every = Number(v)
      } else if (flag === '--schemas') o.schemas = v.split(',').map((s) => s.trim()).filter(Boolean)
      else if (flag === '--url-env') o.urlEnv = v
      else o[flag.slice(2)] = v
    } else if (a.startsWith('--')) throw new UsageError(`không hiểu cờ "${clean(a)}"`)
    else pos.push(a)
  }
  if (o.help) return o
  const [cmd, ...rest] = pos
  if (!COMMANDS.includes(cmd)) throw new UsageError(cmd ? `không hiểu lệnh "${clean(cmd)}"` : 'thiếu lệnh')
  o.cmd = cmd
  if (cmd === 'chon') {
    const mode = rest.shift()
    if (mode !== 'on' && mode !== 'off') throw new UsageError('chon cần on hoặc off')
    o.mode = mode
  }
  if (rest.length !== 1) throw new UsageError(rest.length ? 'thừa tham số' : 'thiếu thư mục app')
  o.appDir = path.resolve(rest[0])
  if (o.supabaseFree && !o.method) o.method = 'pg'
  return o
}

// deps (tuỳ chọn, để test): { run, now, platform, env, home, nodePath, script, pid, uid, logDir, tmpRoot, stdout, stderr }. Trả mã thoát.
export function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout: out = process.stdout, stderr: errOut = process.stderr, ...coreDeps } = deps
  let o
  try {
    o = parseArgs(argv)
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    errOut.write(`backup: ${e.message}\n${USAGE}\n`)
    return EXIT.FAIL
  }
  if (o.help) {
    out.write(`${USAGE}\n`)
    return EXIT.OK
  }
  if (!fs.existsSync(o.appDir) || !fs.statSync(o.appDir).isDirectory()) {
    errOut.write(`backup: không thấy thư mục app "${clean(o.appDir, 120)}".\n`)
    return EXIT.FAIL
  }
  const d = { script: fileURLToPath(import.meta.url), ...coreDeps }
  let res
  try {
    if (o.cmd === 'chon') res = choose(o, d)
    else if (o.cmd === 'chay') res = runBackup(o, d)
    else if (o.cmd === 'khoi-phuc-thu') res = restoreCheck(o, d)
    else if (o.cmd === 'lich') res = schedule(o, d)
    else res = status(o, d)
  } catch (e) {
    res = { exit: EXIT.FAIL, lines: [`Lỗi nội bộ của backup: ${clean(e?.message, 160)}`] }
    logLine(`lỗi nội bộ: ${e?.stack || e?.message}`, d)
  }
  out.write(`${res.lines.join('\n')}\n`)
  return res.exit
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
