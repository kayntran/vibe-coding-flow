// updates: máy kiểm bản cập nhật công cụ (codex, claude, agy, cursor-agent, grok, devin, node, pnpm, git). Chỉ công cụ CÓ trên máy.
// Nguồn bản mới + cách cài + chuỗi lỗi bản cũ: docs/specs/2026-10-12-may-kiem-cap-nhat/notes/update-sources.md (đã tra thật 2026-10-12).
//
//   await checkAll({fresh, timeoutMs, fetch, exec, now, …}) → [{ tool, label, installed, latest, method, cmd, userRuns, affectsAll, note, eol }]
//   await checkOne(tool, opts) → mục trên hoặc null (không có trên máy / nguồn lỗi)
//   updateCommand(tool, {platform, path, method, latest, onLts, realpath}) → { cmd, userRuns, note? } | null
//   noteLine(cache, today, {now}) → một dòng nhắc | null        staleHint(tool, text, opts) → câu đời thường | null (async, kiểm tươi)
//
// Hợp đồng an toàn:
//   - Chỉ chạy `<bin> --version` và câu hỏi chỉ đọc `winget show --id <id> --versions` (để biết winget đã có bản cần ghim chưa), qua clis.runCommand (.cmd/.ps1 Windows chạy an toàn).
//     KHÔNG BAO GIỜ chạy lệnh cập nhật — chỉ DỰNG chuỗi lệnh để AI/user chạy sau khi user gật. Lệnh luôn ghim đúng bản đã chọn (đủ 7 ngày); không ghim được ⇒ chỉ ghi chú.
//   - Chuỗi từ mạng chỉ vào kết quả sau khi qua regex nghiêm (phiên bản số); lệnh in ra (từng dòng) phải khớp SAFE_CMD (không nháy, ; | & $ ` < > \).
//   - Lỗi mạng / nguồn rác / quá giờ ⇒ bỏ công cụ đó (ghi một dòng log), không ném. Mỗi nguồn ≤ 5 giây; tối đa 9 request nhỏ mỗi ngày.
//   - Cache ~/.claude/cache/updates.json { at, tools, notified? } ghi nguyên tử; xoá file là về trạng thái đầu.
//     Quyền kích kiểm nền = file khoá updates.spawn.lock cạnh cache (claimRefresh).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBin, runCommand } from './clis.mjs'

const DAY = 86400000
const HOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CACHE_TTL_MS = DAY // kết quả nhớ 24 giờ
export const MIN_AGE_DAYS = 7 // luật an toàn kit: bản vừa phát hành chưa đủ 7 ngày thì chưa khuyên (node, pnpm, git)
const NAG_MAX_AGE_MS = 3 * DAY // cache cũ hơn mức này thì không nhắc (số liệu có thể đã lỗi thời)
const SPAWN_GRACE_MS = 10 * 60 * 1000 // vừa kích kiểm nền xong thì chưa kích lại
const MAX_SHOWN = 5 // số công cụ tối đa nêu trong dòng nhắc
const STALE_TAIL = 8000 // chỉ xét đuôi của chuỗi lỗi
const MAX_LOG_BYTES = 256 * 1024

// Lệnh in ra: chỉ chữ/số, @ . _ : / = - và dấu cách. Cấm nháy, ; | & $ ` < > \ ( ) và xuống dòng (học SAFE_REF của flow-gate, chặt hơn vì có dấu cách).
export const SAFE_CMD = /^(?!-)[A-Za-z0-9@._:/= -]+$/
// Lệnh có thể nhiều dòng (fnm/nvm: cài rồi đặt mặc định): MỖI dòng phải khớp SAFE_CMD, không dòng trống.
export const isSafeCmd = (cmd) => typeof cmd === 'string' && cmd.length > 0 && cmd.length <= 300 && cmd.split('\n').every((l) => SAFE_CMD.test(l))
const SAFE_VER = /^\d+(?:\.\d+){1,3}(?:-[0-9a-f]{6,40})?$/
const SEMVER3 = /^\d+\.\d+\.\d+$/
const METHODS = new Set(['pnpm', 'npm', 'brew', 'self', 'native', 'winget', 'corepack', 'fnm', 'nvm', 'volta', 'desktop', 'apple', 'unknown'])

const slash = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase()
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const verOrNull = (v) => (typeof v === 'string' && SAFE_VER.test(v) ? v : null)
const pick = (map, key, dflt) => (Object.hasOwn(map, key) ? map[key] : dflt)

// ---------- phiên bản ----------

// Đọc phiên bản từ đầu ra `--version`. Ba dạng đặc biệt: cursor-agent `2026.10.01-e373342`, Git for Windows `2.52.0.windows.1` (→ `2.52.0.1`), còn lại số chấm đầu tiên.
export function parseVersion(text) {
  const s = String(text ?? '')
  let m = /(?<![\d.])(\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,40})(?![\w.])/.exec(s)
  if (m) return m[1]
  m = /(?<![\d.])(\d+\.\d+\.\d+)\.windows\.(\d+)(?![\d.])/.exec(s)
  if (m) return `${m[1]}.${m[2]}`
  m = /(?<![\d.])(\d+(?:\.\d+){1,3})(?![\d.])/.exec(s)
  return m ? m[1] : null
}

const nums = (v) => String(v).split('-')[0].split('.').map((x) => Number(x))

// -1 | 0 | 1 theo từng thành phần số (thiếu = 0); hậu tố băm của cursor-agent bị bỏ qua (ngày đã nằm ở phần số).
export function compareVersions(a, b) {
  const x = nums(a)
  const y = nums(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0
    const q = y[i] ?? 0
    if (!Number.isFinite(p) || !Number.isFinite(q)) return 0
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

// Rút gọn cặp (đang cài, bản mới) đến thành phần đầu tiên khác nhau: 0.153.0 vs 0.162.1 → "0.153" "0.162"; 25.2.1 vs 26.11.1 → "25" "26".
function shortPair(a, b) {
  const x = String(a).split('-')[0].split('.')
  const y = String(b).split('-')[0].split('.')
  let i = 0
  while (i < Math.max(x.length, y.length) - 1 && Number(x[i] ?? 0) === Number(y[i] ?? 0)) i++
  return [x.slice(0, i + 1).join('.'), y.slice(0, i + 1).join('.')]
}

// ---------- nhận diện cách cài ----------

const OWN = { // thư mục riêng của bộ cài từng hãng
  claude: ['native', /\/\.local\/bin\/claude|\/\.local\/share\/claude\/|\/\.claude\/local\//],
  agy: ['self', /\/agy\/bin\/|\/\.agy\//],
  'cursor-agent': ['self', /\/cursor-agent\//],
  grok: ['self', /\/\.grok\//],
  devin: ['self', /\/devin\/cli\/|\/\.local\/bin\/devin/],
}
const defaultRealpath = (p) => fs.realpathSync.native(p)
// Nội dung (≤ 4 KB) của file chạy và bản .cmd cạnh nó — chỉ để nhận shim; không đọc được ⇒ [].
function shimText(binPath, o) {
  const read = o.readFile ?? ((p) => { const b = Buffer.alloc(4096); const fd = fs.openSync(p, 'r'); try { return b.toString('utf8', 0, fs.readSync(fd, b, 0, 4096, 0)) } finally { fs.closeSync(fd) } })
  const out = []
  for (const p of new Set([String(binPath ?? ''), `${String(binPath ?? '').replace(/\.(cmd|ps1|exe)$/i, '')}.cmd`])) {
    try { out.push(String(read(p))) } catch { /* không có file này */ }
  }
  return out
}

// Cách cài theo đường dẫn file chạy (và đường dẫn thật sau liên kết tượng trưng: Mac /opt/homebrew/bin/codex → …/lib/node_modules/…).
// Thứ tự quan trọng: Devin Desktop → corepack → pnpm → npm (kể cả npm dưới node của brew) → bộ cài riêng → brew → fnm/nvm/volta → winget → Apple Git.
export function detectMethod(tool, binPath, o = {}) {
  const platform = o.platform ?? process.platform
  const paths = [slash(binPath)]
  try {
    const real = (o.realpath ?? defaultRealpath)(binPath)
    if (real) paths.push(slash(real))
  } catch { /* không giải được liên kết ⇒ dùng đường dẫn gốc */ }
  const has = (re) => paths.some((p) => re.test(p))
  if (has(/\/resources\/app\/extensions\//)) return 'desktop'
  if (has(/\/corepack\//)) return 'corepack'
  // Windows: shim .cmd trong thư mục npm của corepack (pnpm.cmd gọi node_modules\corepack\dist\pnpm.js) — đường dẫn giống npm nhưng npm sẽ từ chối EEXIST.
  if (platform === 'win32' && shimText(binPath, o).some((t) => /corepack[\\/]dist[\\/]/i.test(t))) return 'corepack'
  if (has(/\/pnpm\/|\/\.pnpm\//)) return 'pnpm'
  if (has(/\/node_modules\/|\/appdata\/roaming\/npm\/|\/\.npm-global\/|\/npm\/[^/]+$/)) return 'npm'
  const own = OWN[tool]
  if (own && has(own[1])) return own[0]
  if (has(/\/(?:cellar|caskroom|homebrew|linuxbrew)\//)) return 'brew'
  if (has(/\/fnm(?:_multishells)?\/|\/\.fnm\//)) return 'fnm'
  if (has(/\/\.?nvm\//)) return 'nvm'
  if (has(/\/\.?volta\//)) return 'volta'
  if (platform === 'win32' && (tool === 'node' || tool === 'git') && has(/\/program files(?: \(x86\))?\/(?:nodejs|git)\//)) return 'winget'
  if (platform === 'darwin' && tool === 'git' && (paths[0] === '/usr/bin/git' || has(/\/commandlinetools\//))) return 'apple'
  return 'unknown'
}

// ---------- lệnh cập nhật (chỉ DỰNG chuỗi) ----------

// Luật chung: lệnh in ra phải cài ĐÚNG bản `latest` đã chọn (đủ 7 ngày, cùng dòng LTS đang dùng). Không ghim được ⇒ không in lệnh nhảy bản (chỉ ghi chú);
// brew không ghim được ⇒ vẫn in lệnh nhưng kèm ghi chú "bản brew có thể khác". Nhiều bước (fnm/nvm) ⇒ nhiều dòng, mỗi dòng một lệnh an toàn.
const YOUNG = 'Chưa có bản đủ 7 ngày để khuyên cập nhật (bản mới hơn còn dưới 7 ngày tuổi).'
const brewNote = (v) => (v ? `Homebrew cài bản của Homebrew, có thể khác ${v}.` : 'Homebrew cài bản của Homebrew.')
const lines = (...l) => l.join('\n')

// Tên bản trên winget: Git for Windows tag A.B.C.windows.1 ⇒ "A.B.C"; windows.N (N>1) ⇒ "A.B.C.N" (đã đối chiếu `winget show --id Git.Git --versions`); node giữ nguyên.
export function wingetVersion(tool, latest) {
  const m = tool === 'git' ? /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(latest ?? '') : null
  return m ? (m[2] === '1' ? m[1] : latest) : latest
}
// winget chưa có bản đã chọn `v`: có bản dự phòng (đã kiểm: cùng dòng, mới hơn bản đang cài, đủ 7 ngày) ⇒ ghim bản đó; không ⇒ chỉ ghi chú.
const wingetMissing = (v, where, pin, fallback) => (fallback
  ? { cmd: pin(fallback), note: `Bản ${v} winget chưa có; cài ${fallback} trước (hoặc chờ winget cập nhật, hoặc tải ${v} ở ${where}).` }
  : { cmd: null, note: `winget chưa có ${v}: chờ winget cập nhật hoặc tải ${v} ở ${where}.` })

const CMD = {
  codex: ({ method }) => ({ cmd: pick({ pnpm: 'pnpm add -g @openai/codex@latest', npm: 'npm install -g @openai/codex@latest', brew: 'brew upgrade --cask codex' }, method, 'codex update') }),
  claude: ({ method }) => ({ cmd: pick({ npm: 'npm install -g @anthropic-ai/claude-code@latest', brew: 'brew upgrade claude-code' }, method, 'claude update') }),
  agy: () => ({ cmd: 'agy update' }),
  'cursor-agent': () => ({ cmd: 'cursor-agent update' }),
  grok: () => ({ cmd: 'grok update' }),
  devin: ({ method }) => (method === 'desktop'
    ? { cmd: null, note: 'Devin CLI này đi kèm Devin Desktop, không cập nhật riêng được: cập nhật Devin Desktop.' }
    : { cmd: method === 'brew' ? 'brew upgrade devin' : 'devin update' }),
  // onLts = bản đã chọn thuộc dòng LTS ⇒ gói LTS của winget (kèm --version nên không bao giờ nhảy sang LTS major khác).
  node: ({ method, platform, latest, onLts, paths, wingetHas, wingetFallback }) => {
    if (!latest) return { cmd: null, note: YOUNG }
    if (method === 'winget') {
      const pin = (v) => `winget upgrade --id ${onLts ? 'OpenJS.NodeJS.LTS' : 'OpenJS.NodeJS'} --version ${v}`
      return wingetHas === false ? wingetMissing(latest, 'nodejs.org/en/download', pin, wingetFallback) : { cmd: pin(latest) }
    }
    if (method === 'brew') return { cmd: `brew upgrade ${/\/cellar\/(node(?:@\d+)?)\//.exec(paths.join(' '))?.[1] ?? 'node'}`, note: brewNote(latest) }
    // install chỉ tải; default đổi cho shell mới; use đổi ngay terminal đang mở (symlink multishell trên PATH)
    if (method === 'fnm') return { cmd: lines(`fnm install ${latest}`, `fnm default ${latest}`, `fnm use ${latest}`) }
    if (method === 'nvm') return { cmd: lines(`nvm install ${latest}`, platform === 'win32' ? `nvm use ${latest}` : `nvm alias default ${latest}`) } // nvm-windows không có alias
    if (method === 'volta') return { cmd: `volta install node@${latest}` }
    return { cmd: null, note: 'Chưa nhận ra Node cài bằng gì: tải bản mới ở nodejs.org/en/download rồi cài đè.' }
  },
  pnpm: ({ method, latest }) => {
    if (!latest) return { cmd: null, note: YOUNG }
    if (method === 'corepack') return { cmd: `corepack install -g pnpm@${latest}` }
    if (method === 'npm') return { cmd: `npm install -g pnpm@${latest}` }
    if (method === 'pnpm') return { cmd: `pnpm self-update ${latest}` }
    if (method === 'brew') return { cmd: 'brew upgrade pnpm', note: brewNote(latest) }
    return { cmd: null, note: 'Chưa nhận ra pnpm cài bằng gì.' }
  },
  git: ({ method, platform, latest, wingetHas, wingetFallback }) => {
    if (method === 'apple') return { cmd: null, note: 'Apple Git cập nhật cùng macOS (Cập nhật phần mềm / Xcode Command Line Tools); muốn bản mới hơn: brew install git.' }
    if (method === 'brew') return { cmd: 'brew upgrade git', note: brewNote(latest) }
    if (platform !== 'win32') return { cmd: null, note: 'Chưa nhận ra git cài bằng gì.' }
    if (!latest) return { cmd: null, note: YOUNG }
    const where = 'github.com/git-for-windows/git/releases'
    if (method !== 'winget') return { cmd: null, note: `Tải Git for Windows ${latest} ở ${where} (đừng dùng cập nhật tự động của Git: nó cài bản mới nhất, có thể chưa đủ 7 ngày).` }
    const pin = (v) => `winget upgrade --id Git.Git --version ${v}`
    const wv = wingetVersion('git', latest)
    return wingetHas === false ? wingetMissing(wv, where, pin, wingetFallback) : { cmd: pin(wv) }
  },
}

// → { cmd: string|null, userRuns, note? } | null (công cụ lạ). userRuns = user tự chạy (node/git ảnh hưởng mọi dự án; Devin Desktop không có lệnh).
// `latest` từ mạng chỉ được ghép vào lệnh khi là số phiên bản nghiêm; lệnh cuối cùng phải khớp SAFE_CMD, không thì cmd = null.
export function updateCommand(tool, o = {}) {
  if (!Object.hasOwn(CMD, tool)) return null
  const platform = o.platform ?? process.platform
  const method = o.method ?? (o.path ? detectMethod(tool, o.path, o) : 'unknown')
  const paths = [slash(o.path)]
  try {
    const real = o.path ? (o.realpath ?? defaultRealpath)(o.path) : null
    if (real) paths.push(slash(real))
  } catch { /* giữ đường dẫn gốc */ }
  const r = CMD[tool]({ method, platform, latest: verOrNull(o.latest), onLts: Boolean(o.onLts), wingetHas: o.wingetHas ?? null, wingetFallback: verOrNull(o.wingetFallback), paths })
  const cmd = isSafeCmd(r.cmd) ? r.cmd : null
  const userRuns = Boolean(CATALOG[tool].affectsAll) || method === 'desktop'
  // Có công cụ tự đổi `npm` ⇒ `pnpm` trong lệnh (gặp thật 2026-10-12): cài thành bản thứ hai qua pnpm (thường hỏng) thay vì nâng bản npm đang dùng.
  // Đường npm-cli.js dựng từ Node đang chạy (đúng cả khi Node cài qua fnm/nvm), viết sẵn dạng chạy được trong PowerShell lẫn bash.
  // Ghi chú chỉ dành cho Windows ⇒ path.win32 (máy khác giả lập win32, `path` posix không tách được "C:\…\node.exe").
  const npmCli = path.win32.join(path.win32.dirname(o.nodePath ?? process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const npmNote = cmd && method === 'npm' && platform === 'win32' && /^npm /.test(cmd)
    ? `Có công cụ đổi npm→pnpm thì chạy npm gốc: node "${npmCli}" ${cmd.slice(4)}`
    : null
  const note = [r.note, npmNote].filter(Boolean).join('. ')
  return { cmd, userRuns, ...(note ? { note } : {}) }
}

// ---------- tìm file chạy ----------

const defaultExists = (platform) => (p) => {
  try {
    if (!fs.statSync(p).isFile()) return false
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch { return false }
}

function envGet(o, key) {
  if (o.env[key] !== undefined) return o.env[key]
  if (o.platform !== 'win32') return undefined
  const k = Object.keys(o.env).find((x) => x.toLowerCase() === key.toLowerCase())
  return k === undefined ? undefined : o.env[k]
}

// Mọi file chạy được trên PATH, tối đa MỘT mỗi thư mục (Windows: .exe/.com/.cmd/.bat theo PATHEXT — file không đuôi của npm không chạy được).
export function findAll(name, o) {
  const win = o.platform === 'win32'
  const P = win ? path.win32 : path.posix
  const dirs = (envGet(o, 'PATH') ?? '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  const exts = win
    ? (envGet(o, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => ['.exe', '.com', '.cmd', '.bat'].includes(e))
    : ['']
  const hits = []
  for (const d of dirs) {
    const hit = exts.map((e) => P.join(d, name + e)).find((p) => o.exists(p))
    if (hit) hits.push(hit)
  }
  return hits
}

// ---------- mạng ----------

// Một request có hạn chót cứng (cả đọc thân), không phụ thuộc fetch có tôn trọng signal hay không. Chỉ nhận 200; lỗi ⇒ ném Error với lời ngắn (không kèm URL/nội dung).
async function httpGet(o, url, accept) {
  const ctl = new AbortController()
  let timer
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error('quá giờ')) }, o.timeoutMs) })
  expired.catch(() => {})
  try {
    const res = await Promise.race([o.fetch(url, { signal: ctl.signal, headers: { accept } }), expired])
    if (res.status !== 200) throw new Error(`máy chủ trả ${res.status}`)
    return await Promise.race([res.text(), expired])
  } catch (e) {
    throw new Error(e?.message === 'quá giờ' || /^máy chủ trả \d+$/.test(e?.message ?? '') ? e.message : 'không kết nối được')
  } finally {
    clearTimeout(timer)
  }
}
const asJson = (text) => { try { return JSON.parse(text) } catch { throw new Error('dữ liệu lạ') } }
const strictVer = (v) => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!SEMVER3.test(s)) throw new Error('phiên bản lạ')
  return s
}
const oldEnough = (ms, now) => Number.isFinite(ms) && now - ms >= MIN_AGE_DAYS * DAY

const NPM_TAGS = (pkg) => `https://registry.npmjs.org/-/package/${pkg}/dist-tags`
const AGY_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
const CURSOR_VER = '(\\d{4}\\.\\d{1,2}\\.\\d{1,2}-[0-9a-f]{6,40})'
const GIT_PAGE_SIZE = 10
const GIT_MAX_PAGES = 5

// Node: bản mới nhất ĐÃ PHÁT HÀNH ≥ 7 ngày. Dòng LTS đang dùng ⇒ ở lại dòng đó (bản mới nhất cùng major); dòng Current hoặc dòng lẻ đã ngừng ⇒ bản mới nhất.
// Dòng lẻ cũ hơn major mới nhất = đã ngừng hỗ trợ (quy ước phát hành của Node).
export function pickNode(index, installed, now) {
  if (!Array.isArray(index)) throw new Error('dữ liệu lạ')
  const rows = []
  for (const e of index) {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(e?.version ?? '')
    const t = Date.parse(`${e?.date}T00:00:00Z`)
    if (m && Number.isFinite(t)) rows.push({ v: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]), t, lts: Boolean(e.lts) })
  }
  if (!rows.length) throw new Error('dữ liệu lạ')
  rows.sort((a, b) => compareVersions(b.v, a.v))
  const ok = rows.filter((r) => oldEnough(r.t, now))
  if (!ok.length) return { latest: null }
  const m = Number(String(installed).split('.')[0])
  const onLine = ok.some((r) => r.major === m && r.lts) // đang ở một dòng LTS (22, 24…): ở lại dòng đó
  const target = (onLine && ok.find((r) => r.major === m)) || ok[0]
  const lts = ok.find((r) => r.lts) ?? null
  const eol = m % 2 === 1 && m < rows[0].major
  const note = eol ? `dòng ${m} đã ngừng hỗ trợ${lts && lts.major !== target.major ? `; bản LTS ổn định: ${lts.v}` : ''}` : null
  // onLts: bản đã chọn thuộc dòng LTS ⇒ chọn gói LTS khi ghim lệnh. pool: mọi bản đủ 7 ngày CÙNG major với bản đã chọn (dự phòng khi winget chưa có bản đã chọn).
  return { latest: target.v, onLts: target.lts, eol, note, pool: ok.filter((r) => r.major === target.major).map((r) => r.v) }
}

// pnpm: bản ổn định cao nhất đã phát hành ≥ 7 ngày, không vượt dist-tag latest.
function pickPnpm(doc, now) {
  if (!isPlain(doc) || !isPlain(doc.time)) throw new Error('dữ liệu lạ')
  const tag = typeof doc['dist-tags']?.latest === 'string' && SEMVER3.test(doc['dist-tags'].latest) ? doc['dist-tags'].latest : null
  let best = null
  for (const [v, when] of Object.entries(doc.time)) {
    if (!SEMVER3.test(v) || !oldEnough(Date.parse(when), now)) continue
    if (tag && compareVersions(v, tag) > 0) continue
    if (!best || compareVersions(v, best) > 0) best = v
  }
  return { latest: best }
}

// Git for Windows: tag v2.56.0.windows.2 → 2.56.0.2; bản chính thức (không pre-release), ≥ 7 ngày. pool = mọi bản như vậy trong danh sách (dự phòng khi winget chưa có bản mới nhất).
function pickGitWindows(list, now) {
  if (!Array.isArray(list)) throw new Error('dữ liệu lạ')
  let best = null
  const pool = []
  for (const r of list) {
    const m = /^v(\d+\.\d+\.\d+)\.windows\.(\d+)$/.exec(r?.tag_name ?? '')
    if (!m || r.draft || r.prerelease || !oldEnough(Date.parse(r.published_at), now)) continue
    const v = `${m[1]}.${m[2]}`
    pool.push(v)
    if (!best || compareVersions(v, best) > 0) best = v
  }
  return { latest: best, pool }
}

// Chọn bản winget ĐANG CÓ để cài thay bản đã chọn: thuộc pool (cùng dòng + đủ 7 ngày theo nguồn chính hãng), mới hơn bản đang cài, cao nhất. Không có ⇒ null.
// winget đặt tên Git: windows.1 ⇒ "A.B.C", windows.N ⇒ "A.B.C.N" — đổi về dạng của ta để so với pool.
function pickWingetFallback(tool, have, pool, installed) {
  const ours = (v) => (tool === 'git' && /^\d+\.\d+\.\d+$/.test(v) ? `${v}.1` : v)
  const ok = new Set(pool ?? [])
  let best = null
  for (const v of have) {
    if (!ok.has(ours(v)) || compareVersions(ours(v), installed) <= 0) continue
    if (!best || compareVersions(ours(v), ours(best)) > 0) best = v
  }
  return best
}

// ---------- danh mục công cụ (thêm công cụ = thêm một mục) ----------
// cli: tìm file chạy bằng clis.resolveBin (có Devin Desktop, thư mục quen của từng hãng); không phải cli: tìm trên PATH.
// source(c) → { latest, … } | ném lỗi. c = { get(url, accept), o (opts đã chuẩn hoá), installed }.

const CATALOG = {
  codex: { label: 'Codex', cli: true, dup: true, source: async (c) => ({ latest: strictVer(asJson(await c.get(NPM_TAGS('@openai/codex')))?.latest) }) },
  claude: { label: 'Claude Code', cli: true, source: async (c) => ({ latest: strictVer(await c.get('https://downloads.claude.ai/claude-code-releases/latest')) }) },
  agy: {
    label: 'agy', cli: true,
    source: async (c) => {
      const os_ = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[c.o.platform] ?? 'linux'
      const arch = c.o.arch === 'arm64' ? 'arm64' : 'amd64'
      return { latest: strictVer(asJson(await c.get(`${AGY_BASE}/${os_}_${arch}.json`))?.version) }
    },
  },
  'cursor-agent': {
    label: 'Cursor Agent', cli: true,
    source: async (c) => {
      const text = await c.get(c.o.platform === 'win32' ? 'https://cursor.com/install?win32=true' : 'https://cursor.com/install', 'text/plain')
      const m = new RegExp(`\\$version\\s*=\\s*'${CURSOR_VER}'`).exec(text) ?? new RegExp(`versions/${CURSOR_VER}`).exec(text)
      if (!m) throw new Error('phiên bản lạ')
      return { latest: m[1] }
    },
  },
  grok: { label: 'Grok', cli: true, source: async (c) => ({ latest: strictVer(await c.get('https://x.ai/cli/stable', 'text/plain')) }) },
  devin: { label: 'Devin', cli: true, source: async (c) => ({ latest: strictVer(asJson(await c.get('https://static.devin.ai/cli/current/manifest.json'))?.version) }) },
  node: { label: 'Node', affectsAll: true, source: async (c) => pickNode(asJson(await c.get('https://nodejs.org/dist/index.json')), await c.installed, c.o.now) },
  pnpm: { label: 'pnpm', source: async (c) => pickPnpm(asJson(await c.get('https://registry.npmjs.org/pnpm')), c.o.now) },
  git: {
    label: 'Git', affectsAll: true,
    // Chỉ Git for Windows có nguồn máy-đọc-được chính hãng; Apple Git (Mac) và git của distro Linux theo hệ điều hành ⇒ không có bản để so.
    // Lật trang (10 release/trang, mới → cũ) cho tới khi gặp bản stable đủ 7 ngày, rồi lật thêm MỘT trang để có bản dự phòng cho winget
    // (winget hay chậm hơn GitHub: bản dự phòng thường nằm ngay trang sau); trần 5 trang, trang ngắn hơn 10 = hết release.
    source: async (c) => {
      if (c.o.platform !== 'win32') return { latest: null }
      const pool = []
      let latest = null
      for (let page = 1; page <= GIT_MAX_PAGES; page++) {
        const list = asJson(await c.get(`https://api.github.com/repos/git-for-windows/git/releases?per_page=${GIT_PAGE_SIZE}&page=${page}`))
        const r = pickGitWindows(list, c.o.now)
        pool.push(...r.pool)
        if (latest) return { latest, pool } // đã lấy xong trang dự phòng
        latest = r.latest
        if (list.length < GIT_PAGE_SIZE) return { latest, pool }
      }
      return { latest, pool }
    },
  },
}
export const TOOL_NAMES = Object.freeze(Object.keys(CATALOG))
export const labelOf = (tool) => CATALOG[tool]?.label ?? null

// ---------- opts ----------

export function cacheFile(opts = {}) {
  if (opts.cacheFile) return opts.cacheFile
  const dir = opts.cacheDir ?? process.env.UPDATES_CACHE_DIR ?? path.join(opts.home ?? os.homedir(), '.claude', 'cache')
  return path.join(dir, 'updates.json')
}

function defaultLog(opts) {
  const file = opts.logFile ?? process.env.UPDATES_LOG ?? path.join(HOOK_DIR, 'updates.log')
  return (msg) => {
    try {
      let size = 0
      try { size = fs.statSync(file).size } catch { /* chưa có log */ }
      if (size < MAX_LOG_BYTES) fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`)
    } catch { /* log không ghi được thì thôi: hook không bao giờ in lỗi ra phiên */ }
  }
}

function norm(opts = {}) {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? os.homedir()
  return {
    platform, home, env: opts.env ?? process.env, arch: opts.arch ?? process.arch,
    exists: opts.exists ?? defaultExists(platform),
    realpath: opts.realpath ?? defaultRealpath,
    fetch: opts.fetch ?? globalThis.fetch,
    exec: opts.exec ?? runCommand,
    now: typeof opts.now === 'function' ? opts.now() : (opts.now ?? Date.now()),
    timeoutMs: Math.min(Math.max(Number(opts.timeoutMs) || 5000, 1), 5000),
    fresh: Boolean(opts.fresh),
    useCache: opts.cache !== false,
    cacheOpts: { cacheFile: cacheFile({ ...opts, home }) },
    log: opts.log ?? defaultLog(opts),
    tools: opts.tools ?? TOOL_NAMES,
  }
}

// ---------- cache ----------

export function readCache(opts = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(opts), 'utf8'))
    return isPlain(j) ? j : {}
  } catch { return {} }
}

// Đọc lại cache NGAY trước khi ghi (tiến trình nền và hook SessionStart cùng ghi: không đè dấu của nhau), ghi nguyên tử (tmp + rename). Không ghi được ⇒ bỏ qua.
export function updateCache(opts, fn) {
  const file = cacheFile(opts)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    const next = fn(readCache(opts))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(next))
    fs.renameSync(tmp, file)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* không dọn được thì thôi */ }
  }
}

export function isStale(cache, now = Date.now()) {
  const at = Number(cache?.at)
  return !(Number.isFinite(at) && at <= now + 60_000 && now - at < CACHE_TTL_MS)
}

// Quyền kích kiểm nền: MỘT phiên duy nhất giành được trong mỗi 10 phút. Tạo file khoá updates.spawn.lock (cạnh cache) bằng 'wx' = nguyên tử, nên hai phiên mở cùng lúc
// khi cache cũ thì chỉ một bên được spawn; đang mất mạng thì các phiên sau cũng không đẻ thêm tiến trình trong 10 phút. Khoá ghi giờ giành quyền; quá 10 phút
// (tiến trình trước đã chết/đã xong) hoặc giờ ở tương lai xa (đồng hồ lệch) ⇒ coi là hết hạn, giành lại. Không đụng được đĩa ⇒ false (không kích).
export function claimRefresh(opts = {}, now = Date.now()) {
  const lock = path.join(path.dirname(cacheFile(opts)), 'updates.spawn.lock')
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }) } catch { return false }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx')
      try { fs.writeSync(fd, String(now)) } finally { fs.closeSync(fd) }
      return true
    } catch (e) {
      if (e?.code !== 'EEXIST') return false
      try {
        const at = Number(fs.readFileSync(lock, 'utf8'))
        const age = Number.isFinite(at) && at > 0 ? now - at : Date.now() - fs.statSync(lock).mtimeMs // nội dung rác ⇒ theo giờ sửa file
        if (age > -60_000 && age < SPAWN_GRACE_MS) return false // lệch đồng hồ vài giây vẫn là khoá còn hiệu lực
        fs.rmSync(lock, { force: true })
      } catch { return false }
    }
  }
  return false
}

export function todayOf(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Mục kết quả luôn qua đây (kể cả đọc từ cache — file có thể bị sửa): chỉ giữ trường đã biết, phiên bản/lệnh qua regex nghiêm, nhãn lấy từ danh mục.
function cleanEntry(tool, e) {
  const def = CATALOG[tool]
  const installed = verOrNull(e?.installed)
  if (!def || !installed) return null
  return {
    tool, label: def.label, installed, latest: verOrNull(e.latest),
    method: typeof e.method === 'string' && METHODS.has(e.method) ? e.method : 'unknown',
    cmd: isSafeCmd(e.cmd) ? e.cmd : null,
    userRuns: Boolean(e.userRuns), affectsAll: Boolean(def.affectsAll),
    note: typeof e.note === 'string' && e.note ? e.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 500) : null,
    eol: Boolean(e.eol),
  }
}

const fromCache = (cache) => TOOL_NAMES.map((t) => cleanEntry(t, isPlain(cache.tools) ? cache.tools[t] : null)).filter(Boolean)

// ---------- kiểm ----------

async function installedVersion(bin, o) {
  const r = await o.exec(bin, ['--version'], { timeoutMs: o.timeoutMs, env: { ...o.env, NO_COLOR: '1', NO_OPEN_BROWSER: '1' }, platform: o.platform })
  if (r.error) throw new Error('không chạy được --version')
  if (r.timedOut) throw new Error('--version quá giờ')
  const v = parseVersion(r.stdout) ?? parseVersion(r.stderr)
  if (!v) throw new Error('--version trả chữ lạ')
  return v
}

// Các bản winget ĐANG CÓ của gói `id`, hoặc null khi không hỏi được (không có winget / lệnh lỗi / chữ lạ) — khi đó vẫn in lệnh ghim bản đã chọn:
// thiếu bản thì winget tự báo lỗi, không cài bản khác. Câu hỏi CHỈ ĐỌC: `winget show --id <id> --versions` (đo 0,5-0,7 giây).
async function wingetVersions(id, o) {
  try {
    const bin = findAll('winget', o)[0] ?? 'winget'
    const r = await o.exec(bin, ['show', '--id', id, '--versions', '--accept-source-agreements'], { timeoutMs: o.timeoutMs, env: { ...o.env, NO_COLOR: '1' }, platform: o.platform })
    if (r.error || r.timedOut || r.code !== 0) return null
    const rows = String(r.stdout).split(/\r?\n/).map((l) => l.trim())
    const start = rows.findIndex((l) => /^-{3,}$/.test(l))
    const versions = start < 0 ? [] : rows.slice(start + 1).filter((l) => /^\d+(?:\.\d+){1,4}$/.test(l))
    return versions.length ? versions : null
  } catch { return null }
}

// { kind: 'absent' } | { kind: 'failed', installed? } | { kind: 'ok', entry }. Không có trên máy ⇒ không hỏi mạng. Không ném.
// failed + installed = đọc được --version nhưng nguồn bản mới lỗi: người gọi vẫn ghi installed mới vào cache (giữ latest/cmd cũ).
async function probeTool(tool, o) {
  const def = CATALOG[tool]
  const why = (e) => String(e?.message ?? 'lỗi').replace(/[\r\n]+/g, ' ').slice(0, 80)
  let bin
  try {
    bin = def.cli
      ? resolveBin(tool, { platform: o.platform, env: o.env, home: o.home, exists: o.exists })
      : findAll(tool, o)[0] ?? null
  } catch (e) {
    o.log(`${tool}: bỏ qua (${why(e)})`)
    return { kind: 'failed' }
  }
  if (!bin) return { kind: 'absent' }
  // --version và nguồn bản mới chạy song song (nguồn của node cần bản đang cài nên nhận promise). Gắn .catch để lỗi đến sớm không thành "unhandled rejection".
  const installedP = installedVersion(bin, o)
  installedP.catch(() => {})
  const sourceP = def.source({ o, installed: installedP, get: (url, accept = 'application/json') => httpGet(o, url, accept) })
  sourceP.catch(() => {})
  let installed
  try {
    installed = await installedP
  } catch (e) {
    o.log(`${tool}: bỏ qua (${why(e)})`)
    return { kind: 'failed' }
  }
  try {
    const d = await sourceP
    const method = detectMethod(tool, bin, o)
    let wingetHas = null
    let wingetFallback = null
    if (method === 'winget' && d.latest && compareVersions(installed, d.latest) < 0) {
      const have = await wingetVersions(tool === 'git' ? 'Git.Git' : d.onLts ? 'OpenJS.NodeJS.LTS' : 'OpenJS.NodeJS', o)
      if (have) {
        wingetHas = have.includes(wingetVersion(tool, d.latest))
        if (!wingetHas) wingetFallback = pickWingetFallback(tool, have, d.pool, installed)
      }
    }
    const cmd = updateCommand(tool, { platform: o.platform, path: bin, realpath: o.realpath, method, latest: d.latest, onLts: d.onLts, wingetHas, wingetFallback })
    const notes = [d.note, cmd.note]
    if (def.dup) {
      const methods = [...new Set(findAll(tool, o).map((p) => detectMethod(tool, p, o)))]
      // cảnh báo hai bản đứng ĐẦU: ghi chú bị cắt ở trần độ dài thì vẫn còn lời khuyên gỡ bản thừa
      if (methods.length > 1) notes.unshift(`Máy có hai bản ${def.label} (${methods.join(' và ')}). Lệnh cập nhật chỉ sửa bản đang dùng (${method}); bản còn lại nên gỡ.`)
    }
    const entry = cleanEntry(tool, {
      installed, latest: d.latest ?? null, method, cmd: cmd.cmd, userRuns: cmd.userRuns, eol: d.eol,
      note: notes.filter(Boolean).map((n) => n.replace(/[.\s]+$/, '')).join('. ').concat(notes.some(Boolean) ? '.' : '') || null,
    })
    if (!entry) throw new Error('kết quả lạ')
    return { kind: 'ok', entry }
  } catch (e) {
    o.log(`${tool}: bỏ qua (${why(e)})`)
    return { kind: 'failed', installed }
  }
}

function assertTool(tool) {
  if (!Object.hasOwn(CATALOG, tool)) throw new RangeError(`công cụ không có trong danh sách (${TOOL_NAMES.join(', ')}): ${tool}`)
}

// opts (đều tuỳ chọn; test tiêm giả): fresh · timeoutMs (≤5000) · fetch(url,{signal,headers}) → {status,text()} · exec(file,args,{timeoutMs,env,platform}) → {code,stdout,stderr,timedOut,error}
// · now (ms hoặc hàm) · cacheDir | cacheFile (env UPDATES_CACHE_DIR) · cache:false · platform · arch · env · home · exists · realpath · log(msg) · logFile (env UPDATES_LOG) · tools (chỉ kiểm các công cụ này)
export async function checkAll(opts = {}) {
  const o = norm(opts)
  const cache = o.useCache ? readCache(o.cacheOpts) : {}
  if (!o.fresh && o.useCache && !isStale(cache, o.now)) return fromCache(cache)
  const results = await Promise.all(o.tools.map((t) => (assertTool(t), probeTool(t, o))))
  const fresh = Object.fromEntries(o.tools.map((t, i) => [t, results[i]]))
  if (o.useCache) {
    // Nguồn lỗi ⇒ giữ mục cũ (latest/cmd) nhưng đọc được --version thì ghi installed mới (đã cập nhật xong thì thôi nhắc); công cụ đã gỡ ⇒ xoá mục;
    // at luôn cập nhật để mất mạng không đẻ thêm lần thử ở mỗi phiên.
    updateCache(o.cacheOpts, (cur) => {
      const tools = {}
      for (const t of TOOL_NAMES) {
        const r = fresh[t]
        const old = isPlain(cur.tools) && isPlain(cur.tools[t]) ? cur.tools[t] : null
        if (r?.kind === 'ok') tools[t] = r.entry
        else if (r?.kind !== 'absent' && old) tools[t] = r?.installed && verOrNull(r.installed) ? { ...old, installed: r.installed } : old // hỏng hoặc không thuộc lượt kiểm này
      }
      return { ...cur, at: o.now, tools }
    })
  }
  return TOOL_NAMES.map((t) => (fresh[t]?.kind === 'ok' ? fresh[t].entry : null)).filter(Boolean)
}

export async function checkOne(tool, opts = {}) {
  assertTool(tool)
  const o = norm(opts)
  if (!o.fresh && o.useCache) {
    const cache = readCache(o.cacheOpts)
    if (!isStale(cache, o.now)) {
      const hit = cleanEntry(tool, isPlain(cache.tools) ? cache.tools[tool] : null)
      if (hit) return hit
    }
  }
  const r = await probeTool(tool, o)
  if (o.useCache && (r.kind !== 'failed' || verOrNull(r.installed))) {
    updateCache(o.cacheOpts, (cur) => {
      const tools = isPlain(cur.tools) ? { ...cur.tools } : {}
      if (r.kind === 'ok') tools[tool] = r.entry
      else if (r.kind === 'absent') delete tools[tool]
      else if (isPlain(tools[tool])) tools[tool] = { ...tools[tool], installed: r.installed } // nguồn lỗi nhưng --version đọc được: giữ latest/cmd cũ
      else return cur
      return { ...cur, tools }
    })
  }
  return r.kind === 'ok' ? r.entry : null
}

// ---------- dòng nhắc ----------

// Một dòng liệt kê công cụ có bản mới (null khi không có gì / hôm nay đã nhắc / cache quá cũ). today = todayOf(now); today=null ⇒ bỏ qua dấu "đã nhắc".
// o.now có ⇒ cache cũ hơn 3 ngày không được nhắc. Chỉ dùng dữ liệu đã qua cleanEntry ⇒ không chữ lạ nào lọt vào context của AI.
export function noteLine(cache, today, o = {}) {
  if (!isPlain(cache) || !isPlain(cache.tools)) return null
  if (today != null && cache.notified === today) return null
  if (o.now != null && !(Number.isFinite(cache.at) && o.now - cache.at <= NAG_MAX_AGE_MS)) return null
  const rows = fromCache(cache).filter((e) => e.latest && compareVersions(e.installed, e.latest) < 0)
  if (!rows.length) return null
  const shown = rows.slice(0, MAX_SHOWN).map((e) => {
    const [a, b] = shortPair(e.installed, e.latest)
    return `${e.label} ${a} → ${b}${e.eol ? ` (dòng ${e.installed.split('.')[0]} đã ngừng hỗ trợ)` : ''}`
  })
  const more = rows.length - MAX_SHOWN
  const example = (rows.find((e) => !e.affectsAll) ?? rows[0]).label
  return `Có bản mới: ${shown.join(', ')}${more > 0 ? ` (+${more} nữa)` : ''}. Nói "cập nhật ${example}" để AI cập nhật.`
}

// ---------- lỗi kiểu bản cũ ----------

// hard = chắc là do bản cũ · soft = KHÔNG chắc (Codex "not supported … ChatGPT account" thường là lỗi gói/đăng nhập hoặc model bị gỡ; đừng gộp với hard).
const STALE = {
  codex: { hard: [/requires? a newer version of codex/i, /upgrade to the latest app or cli/i], soft: [/is not supported when using codex with a chatgpt account/i] },
  claude: { hard: [/version [\d.]+ or higher is required/i, /isn'?t described by this version'?s model catalog/i, /\bclaude update\b/i, /update claude code/i] },
  grok: { hard: [/required minimum version/i, /\bgrok update\b/i, /not supported in this version/i] },
  'cursor-agent': { hard: [/current cli version .{0,40} is less than required minimum version/i] },
  devin: { hard: [/written by a newer version of the cli/i, /please update (?:to the latest version )?with/i] },
}
const STALE_GENERIC = [/requires? a newer version/i, /newer version (?:of the (?:cli|app) )?is required/i, /please (?:upgrade|update) to the latest (?:app|cli|version)/i]

// 'stale' | 'maybe' | null. Chỉ xét đuôi 8.000 ký tự (lời của model dài không làm lệch).
export function classifyStale(tool, text) {
  const s = String(text ?? '').slice(-STALE_TAIL)
  if (!s.trim()) return null
  const own = Object.hasOwn(STALE, tool) ? STALE[tool] : {}
  if ([...(own.hard ?? []), ...STALE_GENERIC].some((re) => re.test(s))) return 'stale'
  if ((own.soft ?? []).some((re) => re.test(s))) return 'maybe'
  return null
}

// CLI ngoài báo lỗi kiểu bản cũ ⇒ kiểm phiên bản TƯƠI (bỏ bộ nhớ 24 giờ) rồi nói nguyên nhân + đề nghị cập nhật bằng một câu đời thường. Không ném.
export async function staleHint(tool, text, opts = {}) {
  try {
    const kind = classifyStale(tool, text)
    if (!kind || !Object.hasOwn(CATALOG, tool)) return null
    const label = CATALOG[tool].label
    let e = null
    try { e = await checkOne(tool, { ...opts, fresh: true }) } catch { e = null }
    const ask = `Nói "cập nhật ${label}" để AI cập nhật.`
    if (e?.latest) {
      if (compareVersions(e.installed, e.latest) < 0) {
        return `${label} đang ở bản ${e.installed}, bản mới nhất là ${e.latest}: lỗi này ${kind === 'stale' ? 'là do' : 'có thể do'} bản cũ. ${ask}`
      }
      return kind === 'stale'
        ? `${label} đã ở bản mới nhất (${e.installed}) nên lỗi này không phải do bản cũ: thử tắt hẳn ${label} rồi mở lại, hoặc đổi model.`
        : `Model này không dùng được với gói/tài khoản hiện tại hoặc đã bị gỡ; cập nhật ${label} không sửa được. Đổi sang model khác hoặc kiểm tra gói tài khoản.`
    }
    return kind === 'stale' ? `Lỗi này thường do ${label} bản cũ nhưng chưa kiểm được bản mới nhất (mất mạng?). ${ask}` : null
  } catch {
    return null
  }
}
