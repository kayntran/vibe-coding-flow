#!/usr/bin/env node
// khoa: kho khoá chung của máy (~/.claude/kho-khoa.env) cho host không có mod kho-khoa (Codex CLI, phiên Codex trong Paseo).
// Claude dùng mod kho-khoa (che khoá ngay trong tin nhắn); Codex không sửa được tin nhắn ⇒ hook chặn tin có khoá, tự cất khoá vào kho
// rồi báo tên, AI dùng qua lệnh và không bao giờ thấy giá trị (chốt auitjig3).
//   prompt                      hook UserPromptSubmit (JSON stdin): tin có khoá ⇒ cất vào kho, chặn tin, báo tên khoá
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
// Tên gợi ý theo loại khoá (cùng gợi ý với mod kho-khoa). Không có tên ⇒ không cất (vd private key nhiều dòng, URL có mật khẩu): chỉ chặn.
const GUESS = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', github: 'GITHUB_TOKEN', xai: 'XAI_API_KEY',
  aws: 'AWS_ACCESS_KEY_ID', slack: 'SLACK_TOKEN', jwt: 'JWT_TOKEN', 'jwt-service-role': 'SUPABASE_SERVICE_ROLE_KEY',
  supabase: 'SUPABASE_SECRET_KEY', stripe: 'STRIPE_SECRET_KEY', neon: 'NEON_API_KEY', sentry: 'SENTRY_AUTH_TOKEN',
  sendgrid: 'SENDGRID_API_KEY', twilio: 'TWILIO_API_KEY', cloudflare: 'CLOUDFLARE_API_TOKEN',
}

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

// Từ chung đứng trước khoá ("key: sk-…", "token=ghp_…") không phải tên biến ⇒ dùng tên gợi ý theo loại khoá.
const GENERIC = new Set(['KEY', 'KEYS', 'TOKEN', 'SECRET', 'API', 'APIKEY', 'API_KEY', 'PASSWORD', 'PASS', 'PWD', 'MK', 'KHOA', 'MA'])
const envName = (s) => (s && /^[A-Z][A-Z0-9_]{3,}$|^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(s) && !GENERIC.has(s.toUpperCase()) ? s.toUpperCase() : null)

// Mọi khoá trên một dòng, kể cả hai khoá cùng loại (scanLine chỉ trả khớp đầu của mỗi loại ⇒ che khớp đã lấy rồi quét lại).
function allHits(line) {
  const out = []
  let rest = line
  for (let hits = scanLine(rest); hits.length; hits = scanLine(rest)) {
    for (const h of hits) {
      out.push({ ...h, value: line.slice(h.index, h.end) })
      rest = rest.slice(0, h.index) + ' '.repeat(h.end - h.index) + rest.slice(h.end)
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/**
 * Tìm khoá trong tin nhắn và cất vào kho. Trả { found, saved: [{name, kind, extra}], unsaved: [kind] }.
 * User ghi rõ `TÊN=khoá` ⇒ ghi đè đúng tên đó (đổi khoá sau khi lộ). Tên gợi ý đã có khoá khác ⇒ cất thêm TÊN_2, TÊN_3…
 * (extra = tên gốc) để không xoá mất khoá cũ khi user có hai khoá cùng hãng; AI chép bằng `lay TÊN_2 --as TÊN`.
 */
export function stash(text, { vault = vaultPath() } = {}) {
  const saved = [], unsaved = []
  let found = 0
  for (const line of String(text ?? '').split(/\r?\n/)) {
    for (const h of allHits(line)) {
      found++
      const named = envName(/([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*["']?$/.exec(line.slice(0, h.index))?.[1])
      const base = named ?? GUESS[h.name]
      if (!base) { unsaved.push(h.name); continue }
      let name = base
      const cur = read(vault)
      if (!named) for (let i = 2; valueOf(cur, name) !== undefined && valueOf(cur, name) !== h.value; i++) name = `${base}_${i}`
      upsert(vault, name, h.value)
      saved.push({ name, kind: h.name, extra: name !== base ? base : null })
    }
  }
  return { found, saved, unsaved }
}

export function promptHook(payload, opts = {}) {
  const r = stash(typeof payload?.prompt === 'string' ? payload.prompt : '', opts)
  if (!r.found) return null
  const names = r.saved.map((s) => s.name)
  const reason = [
    'Tin nhắn có khoá bí mật nên chưa gửi cho AI (để khoá không lên máy chủ của AI).',
    names.length ? `Đã cất vào kho khoá của máy: ${names.join(', ')}.` : '',
    ...r.saved.filter((s) => s.extra).map((s) => `Kho đã có ${s.extra} khác nên khoá mới mang tên ${s.name}; muốn thay khoá cũ thì nói "thay ${s.extra} bằng khoá mới".`),
    r.unsaved.length ? `Có ${r.unsaved.length} khoá chưa cất được (${[...new Set(r.unsaved)].join(', ')}): đặt vào file .env bằng tay.` : '',
    names.length ? `Gửi lại tin nhắn, thay khoá bằng tên ${names.length > 1 ? 'của nó' : names[0]}; AI sẽ tự chép khoá vào dự án.` : 'Gửi lại tin nhắn không kèm khoá.',
  ].filter(Boolean).join(' ')
  return { decision: 'block', reason }
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
    else throw new Error('dùng: khoa.mjs prompt | ds [thư mục dự án] | lay <TÊN> [thư mục dự án] [--as TÊN_ENV] | thay <TÊN> <TÊN_MỚI_TRONG_KHO>')
  } catch (e) {
    process.stderr.write(`lỗi: ${e.message}\n`)
    process.exitCode = 1
  }
}
