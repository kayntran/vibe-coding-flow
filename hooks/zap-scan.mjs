#!/usr/bin/env node
// zap-scan: quét bảo mật THỤ ĐỘNG bản app chạy ở máy bằng OWASP ZAP 2.17 (Automation Framework, KHÔNG Docker) — SPEC AC-22.
// Dùng: node ~/.claude/hooks/zap-scan.mjs -t http://localhost:<cổng> [--report-dir <thư mục>] [--ignore-file <file>]
//   CHỈ nhận localhost | 127.0.0.1 | [::1] (http/https); địa chỉ khác bị từ chối. App phải đang chạy.
//   --report-dir  nơi ZAP ghi zap-report* (mặc định: thư mục tạm, đường dẫn in ở cuối)
//   --ignore-file danh sách miễn báo nhầm (mặc định ./docs/security-ignore.json): [{rule, url?, reason, until:YYYY-MM-DD}], hết hạn ⇒ tính lại
//   Cần ZAP + Java 17+ (macOS: ZAP.app đã kèm Java). ZAP_PATH=<zap.bat|zap.sh hoặc thư mục chứa> để chỉ đúng chỗ cài.
// Exit: 0 sạch · 1 có lỗi mức cao (chặn) hoặc quét không chạy xong · 2 chỉ có lỗi mức vừa (cảnh báo) · 3 thiếu ZAP/Java/app chưa chạy/target bị từ chối/dùng sai (in lệnh cài).
// Logic ở lib/zap.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_IGNORE_FILE, scan } from './lib/zap.mjs'

export const USAGE = `zap-scan -t http://localhost:<cổng> [--report-dir <thư mục>] [--ignore-file <file, mặc định ${DEFAULT_IGNORE_FILE}>]
  quét thụ động bản app chạy ở máy bằng ZAP (không Docker; cần Java 17+). Chỉ nhận localhost|127.0.0.1|[::1].
exit: 0 sạch · 1 lỗi mức cao hoặc quét không xong · 2 lỗi mức vừa · 3 thiếu công cụ/app chưa chạy/target bị từ chối`

const FLAGS = { '-t': 'target', '--target': 'target', '--report-dir': 'reportDir', '--ignore-file': 'ignoreFile' }

function parseArgs(argv) {
  const o = { targets: [], reportDir: undefined, ignoreFile: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') return { help: true }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const flag = FLAGS[eq > 0 ? a.slice(0, eq) : a]
    if (!flag) return { error: `đối số lạ: ${a}` }
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i]
    if (!value) return { error: `${a} cần một giá trị` }
    if (flag === 'target') o.targets.push(value)
    else o[flag] = value
  }
  return o
}

// deps tiêm để test: { scan, stdout, stderr, cwd }. Trả mã thoát.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? process.stdout
  const errOut = deps.stderr ?? process.stderr
  const cwd = deps.cwd ?? process.cwd()
  const o = parseArgs(argv)
  if (o.help) { out.write(`${USAGE}\n`); return 0 }
  if (o.error || o.targets.length !== 1) {
    errOut.write(`zap-scan từ chối: ${o.error ?? (o.targets.length ? 'chỉ nhận một -t' : 'thiếu -t')}\n${USAGE}\n`)
    return 3
  }
  const res = await (deps.scan ?? scan)({
    target: o.targets[0],
    reportDir: o.reportDir ? path.resolve(cwd, o.reportDir) : undefined,
    ignoreFile: path.resolve(cwd, o.ignoreFile ?? DEFAULT_IGNORE_FILE),
    ...deps.scanDeps,
  })
  ;(res.exit === 3 ? errOut : out).write(`${res.lines.join('\n')}\n`)
  return res.exit
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code })
}
