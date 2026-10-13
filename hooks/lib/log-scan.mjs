// log-scan: quét LOG BÀI THỬ tìm thứ giống bí mật (AC-30: app ghi nhật ký không được lộ mật khẩu, token, khoá). Dùng cho checker `log-secrets` của hooks/flow-check.mjs.
// Spec: docs/specs/2026-10-13-flow-v7-dot4 (AC-30, PLAN làn D). Chỉ import lib/secrets.mjs (MỘT nơi biết "cái gì là secret"), không in giá trị khoá (value đã che 4 ký tự đầu).
//
//   LOG_DIRS                       ['test-results', 'playwright-report'] — thư mục Playwright ghi kết quả bài thử; quét MỌI file bên trong
//   findLogs(dir, opts)            → { files: [rel…], sources: [mô tả…], truncated }   file log tìm được dưới dir (đường dẫn tương đối, dấu /)
//   scanLogs(dir, opts)            → { files: số file đã duyệt, sources, findings: [{ file, line, name, value }] }
//
// Tìm ở đâu: (1) thư mục test-results/ và playwright-report/ ở bất kỳ chỗ nào dưới dir (độ sâu ≤ maxDepth; Wails để Playwright trong frontend/), (2) mọi file *.log
// (vd .wrangler/logs/*.log do `wrangler dev` tự ghi, hay `node server.js > e2e/server.log` của bài thử) — bỏ node_modules, .git và thư mục build/vendor.
// File zip/ảnh/video (trace.zip, screenshot, video) là nhị phân: không quét được ruột, bỏ qua như scanDir.
// File quá lớn / không đọc được ⇒ nằm trong findings (không coi là sạch), như scanDir.
import fs from 'node:fs'
import path from 'node:path'
import { scanFiles } from './secrets.mjs'

export const LOG_DIRS = ['test-results', 'playwright-report']
const LOG_FILE = /\.log$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'target', '.venv', 'dist', 'build', '.next', 'out', '.output'])
const DEFAULT_DEPTH = 4
const DEFAULT_MAX_FILES = 5000
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // báo cáo html của Playwright nhúng cả dữ liệu bài thử, có thể vài chục MB

// → { files, sources, truncated }. files sắp theo tên (kết quả ổn định). truncated = vượt maxFiles nên chưa liệt kê hết.
export function findLogs(dir, { maxDepth = DEFAULT_DEPTH, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const files = new Set()
  const dirs = new Set()
  let loose = 0
  let truncated = false
  const add = (rel) => {
    if (files.size >= maxFiles) { truncated = true; return false }
    files.add(rel)
    return true
  }
  const readDir = (abs) => { try { return fs.readdirSync(abs, { withFileTypes: true }) } catch { return [] } }
  const all = (abs, rel) => { // mọi file thường dưới một thư mục kết quả bài thử
    for (const e of readDir(abs)) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) all(path.join(abs, e.name), r)
      else if (e.isFile() && !add(r)) return
    }
  }
  const rec = (abs, rel, depth) => {
    for (const e of readDir(abs)) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (LOG_DIRS.includes(e.name)) { dirs.add(r); all(path.join(abs, e.name), r) } else if (!SKIP_DIRS.has(e.name) && depth < maxDepth) rec(path.join(abs, e.name), r, depth + 1)
      } else if (e.isFile() && LOG_FILE.test(e.name) && add(r)) loose++
    }
  }
  rec(path.resolve(dir), '', 0)
  const sources = [...[...dirs].sort().map((d) => `${d}/`), ...(loose ? [`${loose} file *.log`] : [])]
  return { files: [...files].sort(), sources, truncated }
}

export function scanLogs(dir, { maxDepth, maxFiles = DEFAULT_MAX_FILES, maxFileBytes = DEFAULT_MAX_BYTES } = {}) {
  const found = findLogs(dir, { maxDepth, maxFiles })
  const findings = scanFiles(path.resolve(dir), found.files, { maxFileBytes })
  if (found.truncated) findings.push({ file: '.', line: null, name: `quá ${maxFiles} file log, chưa quét hết`, value: null })
  return { files: found.files.length, sources: found.sources, findings }
}
