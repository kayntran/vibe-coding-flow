#!/usr/bin/env node
// khoa: kho khoá chung của máy (~/.claude/kho-khoa.env) dùng chung cho Claude và Codex.
// Như AgentKit (chốt i0ggtaf3): khoá user dán vào chat không bị che hay chặn; hook chỉ nhắc AI không in giá trị ra câu trả lời.
//   prompt                      hook UserPromptSubmit (JSON stdin): tin có khoá hoặc nhắc tới khoá ⇒ thêm lời nhắc (không chặn)
//   luu <TÊN> -                 cất khoá vào kho chung, giá trị qua stdin (không đặt khoá trên dòng lệnh)
//   ds [thư mục dự án]          TÊN khoá trong kho chung và trong .env của dự án (không in giá trị)
//   lay <TÊN> [thư mục dự án] [--as TÊN_ENV]  chép khoá từ kho chung vào .env.local (nếu có) hoặc .env của dự án; trong repo git mà
//                               file đó chưa bị bỏ qua ⇒ thêm vào .gitignore ở gốc repo
//   thay <TÊN> <TÊN_2>          khoá mới đang mang tên TÊN_2 thay cho TÊN trong kho (đổi khoá sau khi lộ)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanLine } from './lib/secrets.mjs'

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const vaultPath = (home = os.homedir()) => path.join(home, '.claude', 'kho-khoa.env')
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const namesOf = (text) => text.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1]).filter(Boolean)
const valueOf = (text, name) => text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1)

// File chứa khoá chỉ chủ máy đọc/ghi (0600; Windows bỏ qua mode, thư mục user đã giới hạn quyền); file có sẵn cũng được siết lại.
function upsert(file, name, value) {
  const lines = read(file).split(/\r?\n/).filter((l) => l !== '')
  const at = lines.findIndex((l) => l.startsWith(`${name}=`))
  if (at >= 0) lines[at] = `${name}=${value}`
  else lines.push(`${name}=${value}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch {}
}

const envFileOf = (dir) => (fs.existsSync(path.join(dir, '.env.local')) ? path.join(dir, '.env.local') : path.join(dir, '.env'))

// Gốc repo git chứa dir (đi ngược lên thư mục cha: dự án con trong monorepo vẫn được bảo vệ), không có ⇒ null.
function gitRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    if (path.dirname(d) === d) return null
  }
}

// File .env vừa ghi khoá phải bị git bỏ qua; chưa ⇒ thêm vào .gitignore ở gốc repo (đường dẫn tương đối, dạng /).
function guardGit(dir, envFile) {
  const root = gitRoot(dir)
  if (!root) return ''
  const rel = path.relative(root, envFile).replaceAll('\\', '/')
  // Đã nằm trong git (commit hoặc add trước đó) ⇒ .gitignore không cứu được: báo để bỏ theo dõi trước khi commit tiếp.
  const tracked = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], { encoding: 'utf8' }).status === 0
  if (tracked) return ` ⚠ ${rel} đang nằm trong git: phải bỏ nó khỏi git (giữ file trên máy) trước lần commit sau, kẻo khoá lên GitHub.`
  const chk = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', rel], { encoding: 'utf8' })
  if (chk.status === 0) return ''
  const ignoreFile = path.join(root, '.gitignore')
  const ignore = read(ignoreFile)
  const base = path.basename(envFile)
  const covered = !rel.includes('/') && ignore.split(/\r?\n/).map((l) => l.trim())
    .some((l) => l === base || l === '.env*' || l === '*.env' || (base !== '.env' && l === '.env.*'))
  if (covered) return ''
  const line = rel.includes('/') ? `/${rel}` : rel
  fs.writeFileSync(ignoreFile, `${ignore}${ignore === '' || ignore.endsWith('\n') ? '' : '\n'}${line}\n`)
  return ` Đã thêm ${line} vào .gitignore.`
}

// Tin có khoá hoặc nhắc tới khoá ⇒ nhắc AI không in giá trị ra câu trả lời (chốt i0ggtaf3, như AgentKit: không che, không chặn tin).
// Không bao giờ chép chữ trong tin hay giá trị khoá vào lời nhắc.
// Chỉ nhắc khi có khoá thật hoặc dấu hiệu đưa khoá: mẫu khoá đã biết (scanLine); "TÊN_KEY=giá trị dài" (cả DEEPSEEK_API_KEY=, CLIENT_SECRET=,
// "key: abc…"); cụm rõ nghĩa như "API key", "mật khẩu", "khoá bí mật". Chữ thường gặp ("khoá nút Lưu", "giới hạn token", "đọc .env") không tính.
const KEY_ASSIGN = /(?<![A-Za-z])(?:[A-Za-z0-9]+_)*(?:api_?key|key|secret|token|password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}/i
const KEY_PHRASE = /\bapi[ _-]?key\b|\bprivate key\b|\bsecret key\b|\baccess token\b|mật khẩu|khoá bí mật|khóa bí mật|khoá api|khóa api/i
const hasKey = (text) => {
  const t = text.normalize('NFC')
  return KEY_ASSIGN.test(t) || KEY_PHRASE.test(t) || t.split(/\r?\n/).some((l) => scanLine(l).length > 0)
}
export const REMINDER = 'Nhắc bảo mật: không viết giá trị khoá, token, mật khẩu, JWT hay private key ra câu trả lời, kể cả khi user vừa dán. ' +
  'Nói bằng tên (vd "đã lưu OPENAI_API_KEY") hoặc [đã che]. Cần dùng khoá cho lệnh thì đưa qua kho khoá ' +
  '(`node ~/.claude/hooks/khoa.mjs luu <TÊN> -` với giá trị qua stdin, rồi `lay <TÊN>`), chỉ báo thành công/thất bại.'

export function promptHook(payload) {
  const text = typeof payload?.prompt === 'string' ? payload.prompt : ''
  if (!text || !hasKey(text)) return null
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: REMINDER } }
}

/** Cất khoá `value` vào kho chung dưới tên `name` (ghi đè nếu đã có). Không in giá trị. */
export function luu(name, value, { vault = vaultPath() } = {}) {
  if (!NAME_RE.test(name ?? '')) throw new Error(`tên "${name}" không hợp lệ: chỉ chữ, số và _`)
  const v = String(value ?? '').trim()
  if (!v || /[\r\n]/.test(v)) throw new Error('giá trị khoá rỗng hoặc nhiều dòng (đưa đúng một dòng qua stdin)')
  upsert(vault, name, v)
  return `Đã cất ${name} vào kho chung. Chép vào dự án: "khoa.mjs lay ${name}".`
}

export function ds(dir, { vault = vaultPath() } = {}) {
  const env = envFileOf(dir)
  return `Kho chung: ${namesOf(read(vault)).join(', ') || '(trống)'}\n${env}: ${namesOf(read(env)).join(', ') || '(trống)'}`
}

/** Chép khoá `name` của kho vào .env dự án dưới tên `as` (mặc định cùng tên). */
export function lay(name, dir, { vault = vaultPath(), as = name } = {}) {
  for (const n of [name, as]) if (!NAME_RE.test(n ?? '')) throw new Error(`tên "${n}" không hợp lệ: chỉ chữ, số và _`)
  const value = valueOf(read(vault), name)
  if (value === undefined) throw new Error(`kho chung chưa có ${name}; chạy "khoa.mjs ds" để xem các tên đang có`)
  const env = envFileOf(dir)
  upsert(env, as, value)
  return `Đã chép ${name} từ kho chung vào ${env}${as !== name ? ` (tên ${as})` : ''}.${guardGit(dir, env)} Code đọc qua biến môi trường ${as}.`
}

/** Thay khoá trong kho: khoá đang ở tên `from` (vd TÊN_2) chuyển sang tên `to`, bỏ tên `from`. */
export function thay(to, from, { vault = vaultPath() } = {}) {
  for (const n of [to, from]) if (!NAME_RE.test(n ?? '')) throw new Error(`tên "${n}" không hợp lệ: chỉ chữ, số và _`)
  const text = read(vault)
  const value = valueOf(text, from)
  if (value === undefined) throw new Error(`kho chung chưa có ${from}`)
  fs.writeFileSync(vault, `${text.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith(`${from}=`)).join('\n')}\n`, { mode: 0o600 })
  upsert(vault, to, value)
  return `Đã thay ${to} trong kho chung bằng khoá của ${from}. Dự án đang dùng ${to}: chạy "khoa.mjs lay ${to}" để chép bản mới.`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2)
  try {
    if (cmd === 'prompt') {
      let payload = {}
      try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch {}
      const out = promptHook(payload)
      if (out) process.stdout.write(JSON.stringify(out))
    } else if (cmd === 'ds') console.log(ds(path.resolve(a ?? process.cwd())))
    else if (cmd === 'lay') {
      const rest = process.argv.slice(4)
      const i = rest.indexOf('--as')
      const as = i >= 0 ? rest[i + 1] : a
      const dir = rest.filter((x, j) => j !== i && j !== i + 1 || i < 0)[0]
      console.log(lay(a, path.resolve(dir ?? process.cwd()), { as }))
    } else if (cmd === 'thay') console.log(thay(a, b))
    else if (cmd === 'luu') {
      if (b !== '-') throw new Error('giá trị khoá đưa qua stdin: khoa.mjs luu <TÊN> - (không đặt khoá trên dòng lệnh)')
      console.log(luu(a, fs.readFileSync(0, 'utf8')))
    } else throw new Error('dùng: khoa.mjs prompt | ds [thư mục dự án] | luu <TÊN> - | lay <TÊN> [thư mục dự án] [--as TÊN_ENV] | thay <TÊN> <TÊN_MỚI_TRONG_KHO>')
  } catch (e) {
    process.stderr.write(`lỗi: ${e.message}\n`)
    process.exitCode = 1
  }
}
