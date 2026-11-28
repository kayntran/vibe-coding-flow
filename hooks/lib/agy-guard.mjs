// agy-guard: (1) đưa MỘT đường dẫn về dạng tuyệt đối đã chuẩn hoá (~, $HOME, %USERPROFILE%, .., ổ đĩa/UNC/gạch chéo lẫn lộn) và đích THẬT của nó (realpath của file hoặc
// thư mục cha gần nhất đang tồn tại ⇒ liên kết/junction không lách được); (2) nhận ra việc ghi/xoá/di chuyển vào CẤU HÌNH GÁC CHÍNH NÓ, cả qua công cụ ghi file lẫn qua lệnh shell.
// Dùng bởi hooks/agy-hook.mjs. Hàm thuần theo (cwd, home) truyền vào; chỉ đọc hệ thống file để lấy realpath, không ghi gì.
//
// Cấu hình tự bảo vệ (tính từ thư mục nhà):
//   file : .gemini/config/hooks.json · .gemini/config/mcp_config.json · .gemini/antigravity-cli/settings.json · .gemini/settings.json · .gemini/AGENTS.md · .claude/settings.json
//   thư mục (mọi thứ bên trong): .gemini/config/agents · .claude/hooks (mã bộ chặn) · .claude/kit (bảng vai, luật)
//   thư mục cha (chỉ chặn khi XOÁ/DI CHUYỂN cả thư mục): .gemini · .gemini/config · .gemini/antigravity-cli · .claude
// Muốn sửa các file này ⇒ chạy lại installer do user chạy (node ~/.claude/install.mjs) hoặc user tự sửa; AI không tự làm được.
import fs from 'node:fs'
import path from 'node:path'

const FILES = ['.gemini/config/hooks.json', '.gemini/config/mcp_config.json', '.gemini/antigravity-cli/settings.json', '.gemini/settings.json', '.gemini/agents.md', '.claude/settings.json']
const DIRS = ['.gemini/config/agents', '.claude/hooks', '.claude/kit']
const ANCESTORS = ['.gemini', '.gemini/config', '.gemini/antigravity-cli', '.claude']
const SHOW = { '.gemini/agents.md': '.gemini/AGENTS.md' }
const WIN = process.platform === 'win32'

const lowerSlash = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase().replace(/(.)\/+$/, '$1')
const isWinStyle = (p) => /^[a-zA-Z]:([\\/]|$)/.test(p) || /^\\\\/.test(p)

// Chuẩn hoá một đường dẫn tuyệt đối THEO KIỂU CỦA CHÍNH NÓ (ổ đĩa/UNC ⇒ win32; còn lại ⇒ posix), bỏ . và .. — chạy giống nhau trên mọi hệ điều hành.
const normalizeAbs = (p) => (isWinStyle(p) ? path.win32.normalize(p) : path.posix.normalize(p))

/**
 * Đường dẫn thô → { abs, unresolved, glob } hoặc null nếu rỗng. abs = tuyệt đối đã bỏ ".."; unresolved = còn biến ($X, %X%, `…`) không biết giá trị (abs = null);
 * glob = có ký tự đại diện (abs = phần thư mục đứng trước đoạn có ký tự đại diện).
 */
export function canon(raw, cwd, home) {
  if (typeof raw !== 'string') return null
  let s = raw.trim().replace(/^["']|["']$/g, '')
  if (!s) return null
  s = s.replace(/^file:\/\/\/?(?=[a-zA-Z]:|\/)/i, '')
  const homeMark = /^(?:~|\$home|\$\{home\}|\$env:userprofile|\$env:home|\$userprofile|%userprofile%|%home%)(?=[\\/]|$)/i
  const fromHome = homeMark.test(s)
  s = s.replace(homeMark, home)
  if (fromHome && !isWinStyle(home)) s = s.replace(/\\/g, '/') // %USERPROFILE%\.gemini\… viết kiểu Windows nhưng máy chủ là posix: đoạn sau dấu nhà vẫn là dấu phân cách
  if (/[$`]|%[^%\\/\s]+%/.test(s)) return { abs: null, unresolved: true, glob: false }
  if (WIN) s = s.replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') // /c/Users/x (Git Bash) và /mnt/c/… (WSL) ⇒ C:/Users/x
  let glob = false
  const gi = s.search(/[*?[]/)
  if (gi >= 0) { glob = true; s = s.slice(0, Math.max(s.lastIndexOf('/', gi), s.lastIndexOf('\\', gi), 0)) || '.' }
  const absolute = isWinStyle(s) || s.startsWith('/')
  const base = path.isAbsolute(cwd) ? cwd : path.resolve(cwd)
  const abs = absolute ? normalizeAbs(s) : normalizeAbs(isWinStyle(base) ? path.win32.resolve(base, s) : path.posix.resolve(base, s))
  // rawAbs: cùng đường dẫn nhưng GIỮ NGUYÊN "." và ".." (chỉ posix): kernel posix mở từng đoạn theo thứ tự, ".." tính từ đích thật của liên kết đứng trước nó (physicalPath).
  const rawAbs = !WIN && !isWinStyle(s) && !isWinStyle(base) ? (absolute ? s : `${base.replace(/\/+$/, '')}/${s}`) : null
  return { abs, rawAbs, unresolved: false, glob }
}

/**
 * Đích thật theo đúng thứ tự posix mở file: đi từng đoạn từ gốc; "." bỏ; ".." lùi một cấp TỪ VỊ TRÍ THẬT hiện tại (sau khi đã theo liên kết); đoạn đang tồn tại thì lấy realpath
 * (theo liên kết), chưa tồn tại thì giữ nguyên chữ. Khác với rút ".." theo chữ rồi mới realpath: `alias/../hooks.json` với alias → thư mục khác phải ra `<cha của đích alias>/hooks.json`.
 * Windows rút ".." theo chữ TRƯỚC khi mở file nên không dùng hàm này ở đó.
 */
export function physicalPath(rawAbs) {
  let cur = '/'
  for (const part of String(rawAbs).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { cur = path.posix.dirname(cur); continue }
    const next = path.posix.join(cur, part)
    try { cur = fs.realpathSync.native(next) } catch { cur = next }
  }
  return cur
}

// Đích thật: realpath của file, hoặc của thư mục cha gần nhất đang tồn tại rồi nối phần chưa tồn tại. Không phân giải được ⇒ chính abs.
export function realTarget(abs) {
  if (!path.isAbsolute(abs)) return abs
  let cur = abs
  const rest = []
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(cur)
      return rest.length ? path.join(real, ...rest.reverse()) : real
    } catch {
      const up = path.dirname(cur)
      if (up === cur) return abs
      rest.push(path.basename(cur))
      cur = up
    }
  }
  return abs
}

/** Các dạng cần kiểm của một đường dẫn: tên đã chuẩn hoá theo chữ + đích thật của nó + (posix) đích thật khi ".." tính sau liên kết. Chặn nếu BẤT KỲ dạng nào trúng. */
export function checkForms(abs, rawAbs = null) {
  const out = [abs]
  const add = (p) => { if (p && !out.some((q) => lowerSlash(q) === lowerSlash(p))) out.push(p) }
  add(realTarget(abs))
  if (rawAbs) add(physicalPath(rawAbs))
  return out
}

/** Thư mục nhà (và bản realpath của nó nếu khác) ở dạng chữ thường, gạch xuôi. */
export function homesOf(home) {
  const out = new Set([lowerSlash(home)])
  try { out.add(lowerSlash(fs.realpathSync.native(home))) } catch {}
  return [...out]
}

/**
 * Một trong các dạng đường dẫn nằm trong vùng cấu hình tự bảo vệ không? Trả đường dẫn tương đối (vd '.gemini/config/hooks.json') hoặc null.
 * destructive: việc xoá/di chuyển — chặn cả khi đích là thư mục CHA của vùng. glob: đích có ký tự đại diện (abs là thư mục đứng trước) ⇒ như destructive.
 */
export function configHit(forms, homes, { destructive = false, glob = false } = {}) {
  const wide = destructive || glob
  for (const p of forms) {
    const key = lowerSlash(p)
    for (const h of homes) {
      for (const f of FILES) {
        const full = `${h}/${f}`
        if (key === full || (glob && full.startsWith(`${key}/`))) return SHOW[f] ?? f
      }
      if (wide) for (const a of ANCESTORS) if (key === `${h}/${a}`) return a
      for (const d of DIRS) {
        const full = `${h}/${d}`
        if (key === full || key.startsWith(`${full}/`) || (wide && full.startsWith(`${key}/`))) return d
      }
    }
  }
  return null
}

// ---------- lệnh shell ----------

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'time', 'nice', 'nohup', 'start', 'call'])
const CD = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl'])
const COPY = new Set(['cp', 'copy', 'cpi', 'copy-item', 'install', 'xcopy', 'scp', 'rsync', 'robocopy'])
const COPY_BULK = new Set(['scp', 'rsync', 'robocopy']) // chép cả thư mục / từ xa: không biết tên từng file đích
const PARENTS = [...new Set([...FILES, ...DIRS].map((p) => path.posix.dirname(p)))] // thư mục chứa trực tiếp file/thư mục được bảo vệ

const isDirectory = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const joinLike = (dir, name) => (isWinStyle(dir) ? path.win32.join(dir, name) : path.posix.join(dir, name))
// Tên chắc chắn của file đích khi chép `s` vào một thư mục; null nếu không biết (ký tự đại diện, biến, ".", "..", rỗng).
function leafName(s) {
  const t = String(s).trim().replace(/^["']|["']$/g, '')
  if (!t || /[*?[$`]|%[^%\\/\s]+%/.test(t)) return null
  const seg = t.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return seg && seg !== '.' && seg !== '..' ? seg : null
}
// Một trong các dạng đường dẫn đúng là thư mục chứa trực tiếp thứ được bảo vệ ⇒ trả tên tương đối của nó.
function parentHit(forms, homes) {
  for (const p of forms) for (const h of homes) for (const rel of PARENTS) if (lowerSlash(p) === `${h}/${rel}`) return rel
  return null
}
const ANY_ARG = new Set(['mv', 'move', 'mi', 'move-item', 'ren', 'rename', 'rni', 'rename-item', 'rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'remove-item', 'unlink', 'shred',
  'ln', 'mklink', 'ni', 'new-item', 'sc', 'set-content', 'ac', 'add-content', 'clc', 'clear-content', 'out-file', 'tee', 'tee-object', 'truncate', 'touch', 'mkdir', 'md',
  'chmod', 'chown', 'chgrp', 'icacls', 'attrib', 'takeown', 'patch', 'sponge'])
const DESTRUCTIVE = new Set(['mv', 'move', 'mi', 'move-item', 'ren', 'rename', 'rni', 'rename-item', 'rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'remove-item', 'unlink', 'shred', 'truncate'])
const OUT_FLAGS = new Set(['-o', '--output', '-O', '--output-document', '-outfile', '-out'])
const SHELLS_C = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const INLINE = { node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval'], deno: ['eval'], python: ['-c'], python3: ['-c'], py: ['-c'], pypy: ['-c'], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'] }

const baseName = (w) => path.posix.basename(w.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '')

// Tách lệnh thành các đoạn { words, redirs }. Ngắt ở ; && || | & ( ) xuống dòng; nhận > >> >| &> N> (đích chuyển hướng vào redirs), bỏ >&N, < và <<WORD; bỏ comment #.
function parse(cmd) {
  const segs = []
  let words = []
  let redirs = []
  let tok = ''
  let has = false
  let quote = null
  let mode = null // 'redir' | 'skip': từ kế tiếp là đích chuyển hướng / bị bỏ
  const word = () => {
    if (!has) return
    if (mode === 'redir') redirs.push(tok)
    else if (mode !== 'skip') words.push(tok)
    mode = null
    tok = ''
    has = false
  }
  const cut = () => { word(); mode = null; if (words.length || redirs.length) segs.push({ words, redirs }); words = []; redirs = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && c === '\\' && /["\\$`]/.test(cmd[i + 1] ?? '')) tok += cmd[++i]
      else tok += c
    } else if (c === '"' || c === "'") { quote = c; has = true }
    else if (c === '\\' && cmd[i + 1] === '\n') i++
    else if (/\s/.test(c) && c !== '\n') word()
    else if (c === '#' && !has) { while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++ }
    else if (c === '>') {
      if (has && /^\d+$/.test(tok)) { tok = ''; has = false } else word()
      if (cmd[i + 1] === '>' || cmd[i + 1] === '|') i++
      if (cmd[i + 1] === '&' && /[\d-]/.test(cmd[i + 2] ?? '')) { i += 2; mode = null; continue } // 2>&1: nhân đôi mô tả file, không phải file
      if (cmd[i + 1] === '&') i++
      mode = 'redir'
    } else if (c === '<') {
      word()
      while (cmd[i + 1] === '<') i++
      mode = 'skip'
    } else if (c === '&' && cmd[i + 1] === '>') { word() } // &>file: nhánh '>' kế tiếp xử lý
    else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '\n') cut()
    else { tok += c; has = true }
  }
  cut()
  return segs
}

const unresolvedSuspicious = (raw) => /(^|[\\/])\.(gemini|claude)([\\/]|$)/i.test(raw) || /(^|[\\/])(hooks\.json|mcp_config\.json)$/i.test(raw)

// Mô tả lỏng việc nhắc tới vùng bảo vệ trong đoạn mã chạy thẳng (node -e, python -c…): cần có dấu hiệu thư mục nhà để không nhầm với .claude/settings.json của chính dự án.
function looseMention(text, homes) {
  const t = text.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase()
  if (!/\.gemini\/(config\/(hooks\.json|mcp_config\.json|agents)|antigravity-cli\/settings\.json|settings\.json|agents\.md)|\.claude\/(hooks|kit|settings\.json)/.test(t)) return null
  const hasHome = /homedir|userprofile|\$home|\$\{home\}|%home%|~\//.test(t) || homes.some((h) => t.includes(h))
  return hasHome ? 'mã chạy thẳng nhắc tới cấu hình tự bảo vệ' : null
}

/**
 * Lệnh shell có GHI/XOÁ/DI CHUYỂN vào vùng cấu hình tự bảo vệ không? ctx = { cwd, home }. Trả { rel, target } hoặc null.
 * Phát hiện: chuyển hướng > >> tới đích; cp/copy… (đích cuối); mv/rm/del/Set-Content/Out-File/tee/sed -i/ln/chmod… (mọi đối số); cd rồi ghi file tương đối;
 * bash/sh -c, cmd /c, powershell -Command/-EncodedCommand, eval/iex (xét lại phần lệnh bên trong); node -e / python -c… nhắc tới đường dẫn bảo vệ.
 * Lệnh chỉ ĐỌC (cat, ls, rg, git -C … log, chạy script node ~/.claude/hooks/x.mjs, cp từ vùng ra ngoài) không bị tính.
 */
export function shellProtectedWrite(cmd, ctx, depth = 0) {
  if (typeof cmd !== 'string' || depth > 4) return null
  const { home } = ctx
  const homes = homesOf(home)
  let cwd = ctx.cwd
  const hit = (raw, opts) => {
    const c = canon(raw, cwd, home)
    if (!c) return null
    if (c.unresolved) return unresolvedSuspicious(raw) ? { rel: 'đường dẫn chứa biến chưa rõ', target: raw } : null
    const rel = configHit(checkForms(c.abs, c.rawAbs), homes, { ...opts, glob: c.glob })
    return rel ? { rel, target: raw } : null
  }
  // Chép VÀO một thư mục chứa file được bảo vệ (~/.gemini/config, ~/.gemini/antigravity-cli, ~/.gemini, ~/.claude): tên đích = tên nguồn, nên `cp ./hooks.json ~/.gemini/config/`
  // ghi đè ~/.gemini/config/hooks.json. Kiểm từng tên đích; nguồn không biết tên (ký tự đại diện, biến, ".", "..") hoặc chép cả thư mục / từ xa (robocopy, rsync, scp) ⇒ không biết tập file đích ⇒ chặn.
  const copyInto = (destRaw, sources, bulk) => {
    const c = canon(destRaw, cwd, home)
    if (!c || c.unresolved || c.glob) return null
    const forms = checkForms(c.abs, c.rawAbs)
    if (!/[\\/]$/.test(destRaw.trim()) && !forms.some(isDirectory)) return null // đích là một TÊN FILE: hit() đã kiểm
    const parent = parentHit(forms, homes)
    if (!parent) return null
    if (bulk) return { rel: parent, target: destRaw }
    for (const s of sources) {
      const name = leafName(s)
      if (name === null) return { rel: parent, target: destRaw }
      const rel = configHit(forms.flatMap((f) => checkForms(joinLike(f, name))), homes, {})
      if (rel) return { rel, target: s }
    }
    return null
  }
  for (const seg of parse(cmd)) {
    for (const r of seg.redirs) { const h = hit(r, {}); if (h) return h }
    const words = [...seg.words]
    while (words.length) {
      if (/^[A-Za-z_]\w*=/.test(words[0]) || /^\$env:\w+=/i.test(words[0])) words.shift()
      else if (WRAPPERS.has(baseName(words[0]))) { words.shift(); while (words[0]?.startsWith('-')) words.shift() }
      else break
    }
    if (!words.length) continue
    const verb = baseName(words[0])
    const args = words.slice(1)
    const positional = args.filter((a) => !a.startsWith('-') && !/^\/[a-zA-Z]$/.test(a))
    const flagValue = (names) => { const i = args.findIndex((a) => names.includes(a.toLowerCase())); return i >= 0 ? args[i + 1] : undefined }

    if (CD.has(verb)) {
      const d = positional[0]
      if (d === undefined) { cwd = home; continue }
      const c = canon(d, cwd, home)
      if (c?.abs && !c.glob) cwd = c.abs
      continue
    }
    if (SHELLS_C.has(verb) || verb === 'wsl' || verb === 'eval' || verb === 'iex' || verb === 'invoke-expression') {
      const inner = SHELLS_C.has(verb) ? flagValue(['-c', '-lc', '-ic']) ?? '' : args.filter((a) => !a.startsWith('-')).join(' ')
      const h = shellProtectedWrite(inner, { cwd, home }, depth + 1)
      if (h) return h
      continue
    }
    if (verb === 'cmd') {
      const i = args.findIndex((a) => /^\/[ck]$/i.test(a))
      const h = i >= 0 ? shellProtectedWrite(args.slice(i + 1).join(' '), { cwd, home }, depth + 1) : null
      if (h) return h
      continue
    }
    if (verb === 'powershell' || verb === 'pwsh') {
      let inner = null
      const ci = args.findIndex((a) => /^-c(ommand)?$/i.test(a))
      const ei = args.findIndex((a) => /^-e(nc|ncodedcommand)?$/i.test(a))
      if (ci >= 0) inner = args.slice(ci + 1).join(' ')
      else if (ei >= 0 && args[ei + 1]) { try { inner = Buffer.from(args[ei + 1], 'base64').toString('utf16le') } catch { inner = null } }
      if (inner) { const h = shellProtectedWrite(inner, { cwd, home }, depth + 1); if (h) return h }
      continue
    }
    if (INLINE[verb]) {
      // mã chạy thẳng: cờ -e/-c… đứng TRƯỚC tên script (sau tên script, -p/-e là đối số của script, không phải của trình thông dịch)
      const scriptAt = args.findIndex((a) => !a.startsWith('-'))
      const at = args.findIndex((a) => INLINE[verb].includes(a))
      if (at >= 0 && (scriptAt < 0 || at < scriptAt || INLINE[verb].includes(args[scriptAt - 1] ?? ''))) {
        const code = args.slice(at + 1).join(' ')
        const rel = looseMention(code, homes)
        if (rel) return { rel, target: code.slice(0, 80) }
      }
    }
    if (verb === 'sed' || verb === 'perl' || verb === 'ruby') {
      if (args.some((a) => /^--in-place/.test(a) || /^-[a-zA-Z]*i/.test(a))) for (const p of positional) { const h = hit(p, {}); if (h) return h }
    }
    if (verb === 'dd') for (const a of args) if (/^of=/i.test(a)) { const h = hit(a.slice(3), {}); if (h) return h }
    if (['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'].includes(verb)) {
      const o = args.findIndex((a) => OUT_FLAGS.has(a.toLowerCase()) || OUT_FLAGS.has(a))
      if (o >= 0 && args[o + 1]) { const h = hit(args[o + 1], {}); if (h) return h }
    }
    if (COPY.has(verb)) {
      const second = verb === 'xcopy' || verb === 'robocopy' // xcopy/robocopy NGUỒN ĐÍCH [lọc…]: đích là đối số thứ hai
      const named = flagValue(['-t', '--target-directory', '-destination', '-destinationpath'])
      const dest = named ?? (second ? positional[1] : positional.length >= 2 ? positional.at(-1) : undefined)
      if (dest) {
        const sources = second ? positional.slice(0, 1) : named ? positional.filter((p) => p !== named) : positional.slice(0, -1)
        const h = hit(dest, {}) ?? copyInto(dest, sources, COPY_BULK.has(verb))
        if (h) return h
      }
    } else if (ANY_ARG.has(verb)) {
      const destructive = DESTRUCTIVE.has(verb)
      for (const p of positional) { const h = hit(p, { destructive }); if (h) return h }
    }
  }
  // .NET / API ghi file viết thẳng trong dòng lệnh (PowerShell [IO.File]::WriteAllText(…)): xét cả dòng vì dấu ngoặc làm đứt đoạn lệnh; chỉ các lời gọi ghi tường minh
  if (/\[(?:system\.)?io\.(?:file|directory)\]::(?:write|append|copy|move|delete|create|open|replace)|\.writeall|\.appendall/i.test(cmd)) {
    const rel = looseMention(cmd, homes)
    if (rel) return { rel, target: cmd.slice(0, 80) }
  }
  return null
}
