// cli-check: kiểm CLI ngoài trước khi gọi (cài chưa, bản nào, đã đăng nhập chưa, vì sao không dùng được). Chỉ đọc: không login, không cài.
// Dùng: node ~/.claude/hooks/cli-check.mjs [claude codex cursor-agent agy grok devin …] [--json] [--fresh] [--timeout <giây ≤20>]
//   không nêu tên ⇒ kiểm cả 6. Mặc định in mỗi CLI một dòng "tên  phiên-bản  lý do [-> lệnh login hoặc lệnh cài]"; --json in object theo tên CLI.
//   --fresh bỏ qua cache 10 phút (dùng sau khi user vừa login/cài xong).
// Exit: 0 mọi CLI đã nêu sẵn sàng (ready) · 1 có CLI chưa sẵn sàng · 2 dùng sai (tên lạ, cờ lạ).
// Logic ở lib/clis.mjs (hợp đồng + bẫy đã kiểm).
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CLI_NAMES, checkAll } from './lib/clis.mjs'

function usage(msg) {
  return { usage: `cli-check: ${msg} (dùng: cli-check.mjs [${CLI_NAMES.join('|')}…] [--json] [--fresh] [--timeout <giây>])` }
}

function parseArgs(argv) {
  const o = { names: [], json: false, fresh: false, timeoutMs: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--fresh') o.fresh = true
    else if (a === '--timeout') {
      const sec = Number(argv[++i])
      if (!Number.isFinite(sec) || sec <= 0) return usage('--timeout cần số giây > 0')
      o.timeoutMs = sec * 1000
    } else if (a.startsWith('-')) return usage(`cờ lạ ${a}`)
    else if (!CLI_NAMES.includes(a)) return usage(`không có CLI "${a}"`)
    else o.names.push(a)
  }
  return o
}

function line(r) {
  const hint = r.loginCmd ? ` -> ${r.loginCmd}` : r.installHint ? ` -> ${r.installHint}` : ''
  return `${r.name.padEnd(13)} ${(r.version ?? '-').padEnd(19)} ${r.message}${hint}`
}

// deps tiêm để test: { checkAll, stdout, stderr }. Trả mã thoát.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? process.stdout
  const errOut = deps.stderr ?? process.stderr
  const o = parseArgs(argv)
  if (o.usage) {
    errOut.write(`${o.usage}\n`)
    return 2
  }
  try {
    const results = await (deps.checkAll ?? checkAll)(o.names.length ? o.names : undefined, { fresh: o.fresh, timeoutMs: o.timeoutMs })
    const list = Object.values(results)
    out.write(o.json ? `${JSON.stringify(results, null, 2)}\n` : `${list.map(line).join('\n')}\n`)
    return list.every((r) => r.ready) ? 0 : 1
  } catch (e) {
    errOut.write(`cli-check: ${e.message}\n`)
    return 1
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code })
}
