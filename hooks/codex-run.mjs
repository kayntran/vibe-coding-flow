#!/usr/bin/env node
// codex-run: gọi `codex <đối số…>` cho việc phụ của kit (soát plan, tìm lỗi…), tự thử lần lượt các tài khoản Codex đã đăng nhập
// trên máy, tài khoản hết lượt ⇒ ghi lại, in một dòng ra stderr, sang tài khoản kế (chốt 0ufuusz3; thư viện lib/codex-accounts.mjs).
//   node ~/.claude/hooks/codex-run.mjs exec --sandbox read-only -m <model> -C "<repo>" -o "<out.md>" - < prompt.md
//   node ~/.claude/hooks/codex-run.mjs exec … "Câu lệnh ngắn"       (prompt cuối có dấu cách/xuống dòng ⇒ tự chuyển sang stdin)
// Windows chạy shim codex.cmd qua cmd.exe nên đối số phải "an toàn": -C <thư mục> thành thư mục chạy, -o <file> ghi qua file tạm
// rồi chép sang — đường dẫn có dấu cách vẫn chạy. stdout/stderr của codex in lại nguyên; exit = exit của lượt cuối.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBin } from './lib/clis.mjs'
import { runWithAccounts } from './lib/codex-accounts.mjs'
import { runReviewer } from './review-ext.mjs'

const SAFE_ARG = /^[\w.:=/-]+$/
const OUT_FLAGS = new Set(['-o', '--output-last-message'])
const CD_FLAGS = new Set(['-C', '--cd'])

/**
 * Tách đối số: { args, cwd, outFile, tmpOut, tmpDir, prompt } — prompt ≠ null ⇒ gửi qua stdin và đối số cuối thành "-".
 * File -o tạm nằm trong thư mục tạo độc quyền (mkdtemp ⇒ không ai đặt sẵn symlink vào tên đó). Thư mục Temp của máy có dấu
 * cách/chữ có dấu (C:\Users\Nguyễn\…) thì cmd.exe không nhận ⇒ tạo thư mục tạm ngay trong thư mục chạy và truyền đường dẫn tương đối.
 */
export function plan(argv, { cwd = process.cwd(), tmp = os.tmpdir(), stdinPrompt = null } = {}) {
  const args = []
  let dir = cwd, outFile = null, prompt = stdinPrompt
  for (let i = 0; i < argv.length; i++) if (CD_FLAGS.has(argv[i]) && i + 1 < argv.length) dir = path.resolve(cwd, argv[i + 1])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (CD_FLAGS.has(a) && i + 1 < argv.length) { i++; continue }
    if (OUT_FLAGS.has(a) && i + 1 < argv.length) { outFile = path.resolve(cwd, argv[++i]); args.push('-o', null); continue }
    args.push(a)
  }
  let tmpOut = null, tmpDir = null
  if (outFile) {
    const sys = tmp.replaceAll('\\', '/')
    tmpDir = fs.mkdtempSync(SAFE_ARG.test(sys) ? path.join(tmp, 'codex-run-') : path.join(dir, '.codex-run-'))
    tmpOut = SAFE_ARG.test(sys) ? path.join(tmpDir, 'out.md').replaceAll('\\', '/') : `${path.basename(tmpDir)}/out.md`
    args[args.indexOf(null)] = tmpOut
  }
  const last = args.at(-1)
  if (last !== undefined && last !== '-' && !last.startsWith('-') && !SAFE_ARG.test(last)) {
    prompt = last
    args[args.length - 1] = '-'
  }
  return { args, cwd: dir, outFile, tmpOut, tmpDir, prompt }
}

async function main(argv) {
  const stdinPrompt = argv.at(-1) === '-' && !process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : null
  const p = plan(argv, { stdinPrompt })
  const bin = resolveBin('codex') ?? 'codex'
  const r = await runWithAccounts(
    (env) => runReviewer(bin, p.args, { cwd: p.cwd, env, input: p.prompt, timeoutMs: 40 * 60 * 1000 }),
    { say: (s) => process.stderr.write(`${s}\n`) },
  )
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.error) process.stderr.write(`codex-run: ${r.error.code}: ${r.error.message}\n`)
  if (p.tmpDir) {
    const made = path.join(p.tmpDir, 'out.md')
    if (fs.existsSync(made)) {
      fs.mkdirSync(path.dirname(p.outFile), { recursive: true })
      fs.copyFileSync(made, p.outFile)
    }
    fs.rmSync(p.tmpDir, { recursive: true, force: true })
  }
  return r.timedOut ? 124 : (r.status ?? 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
