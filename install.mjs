// Cài/cập nhật bộ flow cho máy này (AC-39). Chạy lại nhiều lần vẫn an toàn: nội dung không đổi thì không ghi, không sao lưu.
// Dùng:  node ~/.claude/install.mjs          (thường được gọi bởi install.sh / install.ps1 sau khi kéo kit về ~/.claude)
//        node install.mjs backup <ref>        (chạy TRƯỚC checkout lần đầu: sao lưu file đang có trùng tên với file của kit thành *.before-kit-<thời điểm>)
//
// Làm theo thứ tự (ADR-0002 gốc kit ở ~/.claude; ADR-0003 một nguồn → nhiều bản xuất; ADR-0004 hook Claude kèm bí danh Devin):
//   1. Quét ký tự ẩn (zero-width, bidi, tag U+E0000–E007F) trong mọi luật/skill/agent của kit — có ⇒ DỪNG, chưa ghi gì (AC-28).
//   2. Claude Code: ghép hook (hooks/lib/hostgen.mjs claudeHooks) + permissions.deny chặn đọc file bí mật vào ~/.claude/settings.json.
//   3. Codex có mặt (~/.codex hoặc $CODEX_HOME tồn tại, hoặc `codex` trên PATH): khối VIBE-FLOW trong AGENTS.md, skill flow-* sang
//      ~/.agents/skills, ~/.codex/agents/<vai>.toml, ~/.codex/hooks.json; bộ điều phối Codex cũ → ~/.codex/backup-vibe-flow-<thời điểm>/.
//   4. In việc user cần làm: trust hook trong Codex (/hooks), đăng nhập CLI nào chưa sẵn sàng (hooks/lib/clis.mjs).
// Quy tắc: không xoá file của user (chỉ chuyển vào backup); không in secret; bản do kit sinh ra (có dấu "tự sinh bởi vibe-flow")
// được cập nhật tại chỗ không cần sao lưu, file trùng tên KHÔNG phải của kit thì sao lưu trước khi thay.
// Biến môi trường: VIBE_FLOW_NO_LOGIN_CHECK=1 bỏ bước kiểm đăng nhập CLI (CI/kiểm thử);
//   VIBE_FLOW_PATH_ONLY=1 tìm `codex` chỉ trên PATH, bỏ các thư mục quen /opt/homebrew/bin, /usr/local/bin, ~/.local/bin (kiểm thử "máy không có Codex").
import { existsSync, readFileSync, writeFileSync, copyFileSync, cpSync, statSync, mkdirSync, readdirSync, renameSync, rmSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname, resolve, relative, basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

// Chặn đọc file bí mật (Claude Code, permissions.deny). Nguồn cú pháp (đọc 2026-10-11):
//   https://code.claude.com/docs/en/settings-reference#exclude-sensitive-files  (permissions.deny: danh sách luật `Read(đường-dẫn)`)
//   https://code.claude.com/docs/en/permissions#read-and-edit  (cú pháp gitignore; tên trần như `.env` khớp ở mọi độ sâu dưới thư mục
//   làm việc; `*.pem` khớp theo đuôi; luật `Read(!mẫu)` đứng SAU luật chặn thì mở lại đúng mẫu đó; Read deny cũng chặn Edit/Write cùng đường dẫn).
// Mở lại `.env.example|sample|template` cho khớp hooks/lib/secrets.mjs isSensitiveFile (file mẫu không chứa secret, AI cần đọc để biết biến nào cần).
// Hạn chế (theo docs): chỉ áp cho công cụ file và lệnh Bash quen (cat, head…), không chặn script tự mở file.
export const SECRET_DENY = [
  'Read(.env)',
  'Read(.env.*)',
  'Read(!.env.example)',
  'Read(!.env.sample)',
  'Read(!.env.template)',
  'Read(*.pem)',
  'Read(*.key)',
]

const GENERATED = 'tự sinh bởi vibe-flow'
const SKILL_MARK = '.vibe-flow-generated'
const LEGACY_HOOK = /worker-wait-hook|orchestration-policy/i

const here = dirname(fileURLToPath(import.meta.url))
const norm = (p) => p.replaceAll('\\', '/')
const makeStamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[-:T]/g, '')
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function freePath(p) {
  if (!existsSync(p)) return p
  for (let i = 1; ; i++) if (!existsSync(`${p}.${i}`)) return `${p}.${i}`
}

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function readJsonObject(file) {
  if (!existsSync(file)) return { exists: false, data: null, text: null }
  const text = readFileSync(file, 'utf8')
  let data
  try { data = JSON.parse(text.replace(/^﻿/, '')) } catch (e) { throw new Error(`${basename(file)} không phải JSON hợp lệ (${e.message.replace(/\s+/g, ' ')}); sửa hoặc xoá file rồi chạy lại: ${norm(file)}`) }
  if (!isPlain(data)) throw new Error(`${basename(file)} không phải một object JSON: ${norm(file)}`)
  return { exists: true, data, text }
}

// ---------- backup <ref> (trước checkout lần đầu) ----------

const sameBytes = (a, b) => a.equals(b) || a.toString('latin1').replaceAll('\r\n', '\n') === b.toString('latin1').replaceAll('\r\n', '\n')

function backupMatching(root, ref, stamp) {
  const names = execFileSync('git', ['-C', root, 'ls-tree', '-r', '-z', '--name-only', ref], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  const saved = []
  for (const f of names) {
    const dest = join(root, f)
    if (!existsSync(dest) || !statSync(dest).isFile()) continue
    const blob = execFileSync('git', ['-C', root, 'show', `${ref}:${f}`], { maxBuffer: 64 * 1024 * 1024 })
    if (sameBytes(blob, readFileSync(dest))) continue // trùng y hệt ⇒ checkout không làm mất gì
    copyFileSync(dest, freePath(`${dest}.before-kit-${stamp}`))
    saved.push(f)
  }
  return saved
}

// ---------- gộp cấu hình (hàm thuần, có test) ----------

// Nhận diện hook của kit theo "script + đối số" sau `/.claude/hooks/` (bỏ nháy kép) — đường dẫn máy khác hay có/không nháy đều cùng khoá.
export function hookKey(command) {
  const s = String(command ?? '').replaceAll('"', '').replaceAll('\\', '/')
  const m = /\/\.claude\/hooks\/(.+)$/.exec(s)
  return m ? m[1].trim() : null
}

// Giữ cách ghép cũ: với từng hook cần có, bỏ đúng command cũ của cùng script+đối số (cùng sự kiện), giữ hook khác chung entry, entry rỗng thì bỏ, rồi thêm hook mới.
export function mergeClaudeHooks(settings, wanted) {
  if (settings.hooks !== undefined && !isPlain(settings.hooks)) throw new Error('"hooks" trong settings.json không phải object')
  settings.hooks ??= {}
  for (const [event, matcher, hook] of wanted) {
    const list = settings.hooks[event] ?? []
    if (!Array.isArray(list)) throw new Error(`hooks.${event} trong settings.json không phải danh sách`)
    const k = hookKey(hook.command)
    settings.hooks[event] = list
      .map((e) => (e && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => hookKey(h?.command) !== k) } : e))
      .filter((e) => !(e && Array.isArray(e.hooks)) || e.hooks.length > 0)
    settings.hooks[event].push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] })
  }
}

export function mergeDeny(settings, rules = SECRET_DENY) {
  if (settings.permissions !== undefined && !isPlain(settings.permissions)) throw new Error('"permissions" trong settings.json không phải object')
  const p = (settings.permissions ??= {})
  p.deny ??= []
  if (!Array.isArray(p.deny)) throw new Error('"permissions.deny" trong settings.json không phải danh sách')
  for (const r of rules) if (!p.deny.includes(r)) p.deny.push(r)
}

// ~/.codex/hooks.json: bỏ hook của kit (mọi đường dẫn) và hook của bộ điều phối cũ, giữ hook khác, rồi thêm hook của kit. Sự kiện chỉ còn hook bị bỏ ⇒ bỏ hẳn sự kiện.
export function mergeCodexHooks(existing, kit) {
  if (!existing) return { json: kit, legacy: 0 }
  if (existing.hooks !== undefined && !isPlain(existing.hooks)) throw new Error('"hooks" trong hooks.json của Codex không phải object')
  const kitKeys = new Set(Object.values(kit.hooks).flat().flatMap((g) => g.hooks.map((h) => hookKey(h.command))))
  const hooks = {}
  let legacy = 0
  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue }
    const kept = []
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue }
      const keep = g.hooks.filter((h) => {
        if (LEGACY_HOOK.test(JSON.stringify(h))) { legacy++; return false }
        const k = hookKey(h?.command)
        return !(k && kitKeys.has(k))
      })
      if (keep.length === g.hooks.length) kept.push(g)
      else if (keep.length) kept.push({ ...g, hooks: keep })
    }
    if (kept.length || groups.length === 0) hooks[event] = kept
  }
  for (const [event, groups] of Object.entries(kit.hooks)) hooks[event] = [...(hooks[event] ?? []), ...groups]
  return { json: { ...existing, hooks }, legacy }
}

const MARK = (name) => ({
  start: new RegExp(`<!--\\s*${name}:START\\s*-->`),
  end: new RegExp(`<!--\\s*${name}:END\\s*-->`),
  label: name,
})
const VIBE = MARK('VIBE-FLOW')
const LEGACY = MARK('CODEX-ORCHESTRATION')

function findRegion(text, { start, end, label }) {
  const s = start.exec(text)
  if (!s) {
    if (end.test(text)) throw new Error(`AGENTS.md có ${label}:END mà thiếu ${label}:START`)
    return null
  }
  const after = s.index + s[0].length
  const e = end.exec(text.slice(after))
  if (!e) throw new Error(`AGENTS.md có ${label}:START mà thiếu ${label}:END`)
  const to = after + e.index + e[0].length
  if (start.test(text.slice(to))) throw new Error(`AGENTS.md có nhiều hơn một khối ${label}`)
  return { from: s.index, to }
}

// Thay khối VIBE-FLOW giữa marker, giữ phần ngoài. Khối CODEX-ORCHESTRATION cũ: thay tại chỗ (hoặc cắt nếu đã có khối VIBE-FLOW).
// touchedOutside = đã đổi chữ nằm NGOÀI khối của kit (nối thêm vào file của user / cắt khối cũ) ⇒ nơi gọi lưu bản gốc; legacy = có khối CODEX-ORCHESTRATION cũ.
export function spliceAgents(existing, block) {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const blk = block.replaceAll('\r\n', '\n').trimEnd().replaceAll('\n', eol)
  const v = findRegion(existing, VIBE)
  // Tìm khối cũ ở phần NGOÀI khối VIBE-FLOW (luật nhúng trong khối có thể nhắc tên marker cũ).
  const outside = v ? existing.slice(0, v.from) + ' '.repeat(v.to - v.from) + existing.slice(v.to) : existing
  const l = findRegion(outside, LEGACY)
  let text = existing
  if (v && l) {
    const cut = (t, r) => {
      const before = t.slice(0, r.from).replace(/(?:[ \t]*\r?\n)+$/, '')
      const after = t.slice(r.to).replace(/^(?:[ \t]*\r?\n)+/, '')
      return before && after ? `${before}${eol}${eol}${after}` : `${before}${after}`
    }
    const put = (t, r, s) => t.slice(0, r.from) + s + t.slice(r.to)
    text = l.from > v.from ? put(cut(text, l), v, blk) : cut(put(text, v, blk), { from: l.from, to: l.to })
    return { text, touchedOutside: true, legacy: true }
  }
  if (v) return { text: existing.slice(0, v.from) + blk + existing.slice(v.to), touchedOutside: false, legacy: false }
  if (l) return { text: existing.slice(0, l.from) + blk + existing.slice(l.to), touchedOutside: true, legacy: true }
  if (!existing.trim()) return { text: blk + eol, touchedOutside: false, legacy: false }
  return { text: existing + (existing.endsWith(eol) ? eol : eol + eol) + blk + eol, touchedOutside: true, legacy: false }
}

// ---------- cài ----------

function listFiles(dir, base = dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p, base))
    else if (e.isFile()) out.push({ rel: norm(relative(base, p)), abs: p })
  }
  return out
}

const frontName = (md) => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md.replace(/^﻿/, ''))
  return /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm?.[1] ?? '')?.[1] ?? null
}

function scanTargets(kitDir) {
  const t = []
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'WORKERS.md', 'WORKTREE.md']) if (existsSync(join(kitDir, f))) t.push(join(kitDir, f))
  for (const d of ['agents', 'workers', 'kit']) if (existsSync(join(kitDir, d))) t.push(join(kitDir, d))
  const sk = join(kitDir, 'skills')
  if (existsSync(sk)) for (const e of readdirSync(sk, { withFileTypes: true })) if (e.isDirectory() && e.name.startsWith('flow-')) t.push(join(sk, e.name))
  return t
}

/**
 * opts (tất cả tuỳ chọn; test tiêm giả): home · env · kitDir (nguồn bộ kit; mặc định ~/.claude) · log · stamp ·
 * models (thêm vào opts của models.resolve: catalog, exec, now…) · checkAll (kiểm CLI; mặc định clis.checkAll).
 * Trả { code, changed[], todo[], problems[], notes[] }. code 0 = xong, 1 = có lỗi/dừng.
 */
export async function install(opts = {}) {
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  const say = opts.log ?? ((s) => console.log(s))
  const stamp = opts.stamp ?? makeStamp()
  const root = norm(join(home, '.claude'))
  const kitDir = opts.kitDir ?? root
  const changed = []
  const problems = []
  const notes = []
  const todo = []

  const hostgen = await import('./hooks/lib/hostgen.mjs')
  const { scanHiddenPaths } = await import('./hooks/lib/secrets.mjs')
  const models = await import('./hooks/lib/models.mjs')
  const clis = await import('./hooks/lib/clis.mjs')

  // 1. ký tự ẩn trong file luật/skill/agent của kit
  const scan = scanHiddenPaths(scanTargets(kitDir))
  if (scan.findings.length || scan.errors.length) {
    const rel = (f) => norm(relative(kitDir, f))
    say('Dừng cài: file luật của kit có ký tự ẩn (có thể giấu lệnh cho AI) hoặc không kiểm được. Chưa ghi gì cả.')
    for (const f of scan.findings) say(`- ${rel(f.file)} dòng ${f.line} cột ${f.col}: ký tự ẩn ${f.kind} ×${f.count}`)
    for (const e of scan.errors) say(`- ${rel(e.file)}: ${e.error}`)
    say('Hãy báo người giữ kit và đừng cài bản này.')
    return { code: 1, changed, todo, problems: ['ký tự ẩn trong file luật của kit'], notes }
  }
  say('Đã kiểm ký tự ẩn trong luật, skill, agent của kit: sạch.')

  // 2. Claude Code
  let codexOk = false
  try {
    mkdirSync(root, { recursive: true })
    const file = join(root, 'settings.json')
    const cur = readJsonObject(file)
    const wanted = hostgen.claudeHooks(root)
    const next = structuredClone(cur.data ?? {})
    mergeClaudeHooks(next, wanted)
    mergeDeny(next)
    if (!cur.exists || JSON.stringify(cur.data) !== JSON.stringify(next)) {
      if (cur.exists) copyFileSync(file, freePath(`${file}.before-kit-${stamp}`))
      writeAtomic(file, JSON.stringify(next, null, 2) + '\n')
      changed.push('settings.json')
      say(`Claude Code: đã ghép ${wanted.length} hook và chặn đọc file bí mật (.env, *.pem, *.key).`)
    } else {
      say('Claude Code: đã đủ, không đổi gì.')
    }
  } catch (e) {
    problems.push(`Claude Code: ${e.message}`)
  }

  // 3. Codex
  const codexDir = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex')
  const codexPresent = existsSync(codexDir) || Boolean(models.findExe('codex', env, home))
  if (codexPresent) {
    try {
      codexOk = await installCodex()
    } catch (e) {
      problems.push(`Codex: ${e.message}`)
    }
  }

  async function installCodex() {
    const agentsSkills = join(home, '.agents', 'skills')
    const backupDir = join(codexDir, `backup-vibe-flow-${stamp}`)
    const backupPath = (abs) => {
      let rel = relative(home, abs)
      if (rel.startsWith('..') || isAbsolute(rel)) rel = relative(codexDir, abs)
      if (rel.startsWith('..') || isAbsolute(rel)) rel = basename(abs)
      return freePath(join(backupDir, rel))
    }
    const toBackup = (abs, move) => {
      const dest = backupPath(abs)
      mkdirSync(dirname(dest), { recursive: true })
      if (move) { try { renameSync(abs, dest) } catch { cpSync(abs, dest, { recursive: true }); rmSync(abs, { recursive: true, force: true }) } } else cpSync(abs, dest, { recursive: true })
    }
    const same = (file, data) => existsSync(file) && (Buffer.isBuffer(data) ? readFileSync(file).equals(data) : readFileSync(file, 'utf8') === data)

    // --- tính trước (chưa ghi gì): lỗi ở đây ⇒ bỏ cả phần Codex, không ghi nửa chừng ---
    const claudeMd = join(kitDir, 'CLAUDE.md')
    if (!existsSync(claudeMd)) throw new Error(`kit thiếu CLAUDE.md (${norm(claudeMd)})`)
    const block = hostgen.codexAgentsBlock(readFileSync(claudeMd, 'utf8'))
    const agentsFile = join(codexDir, 'AGENTS.md')
    const agentsBefore = existsSync(agentsFile) ? readFileSync(agentsFile, 'utf8') : null
    const spliced = spliceAgents(agentsBefore ?? '', block)

    const hooksFile = join(codexDir, 'hooks.json')
    const hooksCur = readJsonObject(hooksFile)
    const hooksMerge = mergeCodexHooks(hooksCur.data, hostgen.codexHooksJson(root))
    const hooksText = JSON.stringify(hooksMerge.json, null, 2) + '\n'

    const roles = models.loadRoles(join(kitDir, 'kit', 'roles.json'))
    const resolveOpts = { home, env, roles, memo: new Map(), ...(opts.models ?? {}) }
    const warned = new Set()
    const tomls = new Map()
    const agentsDir = join(kitDir, 'agents')
    for (const f of existsSync(agentsDir) ? readdirSync(agentsDir).filter((x) => x.endsWith('.md')).sort() : []) {
      try {
        const md = readFileSync(join(agentsDir, f), 'utf8')
        const name = frontName(md)
        if (!name) throw new Error('thiếu name trong frontmatter')
        const r = models.resolve('codex', name, resolveOpts)
        for (const w of r.warnings) warned.add(w)
        tomls.set(name, hostgen.codexAgentToml(md, roles, { model: r.model, effort: r.effort }))
      } catch (e) {
        notes.push(`Bỏ qua vai ${f.replace(/\.md$/, '')} cho Codex: ${e.message}`)
      }
    }
    notes.push(...warned)

    const skillsSrc = join(kitDir, 'skills')
    const skills = existsSync(skillsSrc)
      ? readdirSync(skillsSrc, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('flow-')).map((e) => e.name).sort()
      : []

    // --- ghi ---
    mkdirSync(codexDir, { recursive: true })
    let n = 0
    let legacyMoved = hooksMerge.legacy > 0 || spliced.legacy

    // bộ điều phối cũ
    for (const e of readdirSync(codexDir)) {
      if (e === 'orchestration-policy.md' || e.startsWith('worker-wait-hook')) {
        toBackup(join(codexDir, e), true)
        changed.push(`codex: cất ${e} vào ${basename(backupDir)}`)
        legacyMoved = true
        n++
      }
    }

    // AGENTS.md
    if (agentsBefore === null || spliced.text !== agentsBefore) {
      if (agentsBefore !== null && spliced.touchedOutside) toBackup(agentsFile, false)
      writeAtomic(agentsFile, spliced.text)
      changed.push('codex: AGENTS.md')
      n++
    }

    // skill sang ~/.agents/skills
    for (const name of skills) {
      const src = join(skillsSrc, name)
      const dest = join(agentsSkills, name)
      const hadMark = existsSync(join(dest, SKILL_MARK))
      if (existsSync(dest) && !hadMark) { toBackup(dest, true); changed.push(`codex: cất skill ${name} có sẵn vào ${basename(backupDir)}`) }
      const files = listFiles(src)
      let wrote = false
      for (const f of files) {
        const data = readFileSync(f.abs)
        const out = join(dest, f.rel)
        if (!same(out, data)) { writeAtomic(out, data); wrote = true }
      }
      const mark = join(dest, SKILL_MARK)
      if (!existsSync(mark)) { writeAtomic(mark, `${GENERATED} — đừng sửa tay\n`); wrote = true }
      if (hadMark) {
        const keep = new Set([...files.map((f) => f.rel), SKILL_MARK])
        for (const f of listFiles(dest)) if (!keep.has(f.rel)) { toBackup(f.abs, true); wrote = true }
      }
      if (wrote) { changed.push(`codex: skill ${name}`); n++ }
    }
    if (existsSync(agentsSkills)) {
      for (const e of readdirSync(agentsSkills, { withFileTypes: true })) {
        if (e.isDirectory() && !skills.includes(e.name) && existsSync(join(agentsSkills, e.name, SKILL_MARK))) {
          toBackup(join(agentsSkills, e.name), true)
          changed.push(`codex: cất skill ${e.name} (đã bỏ khỏi kit) vào ${basename(backupDir)}`)
          n++
        }
      }
    }

    // TOML vai
    const tomlDir = join(codexDir, 'agents')
    for (const [name, text] of tomls) {
      const file = join(tomlDir, `${name}.toml`)
      if (same(file, text)) continue
      if (existsSync(file) && !readFileSync(file, 'utf8').includes(GENERATED)) toBackup(file, false)
      writeAtomic(file, text)
      changed.push(`codex: vai ${name}`)
      n++
    }
    if (existsSync(tomlDir)) {
      for (const f of readdirSync(tomlDir).filter((x) => x.endsWith('.toml'))) {
        if (tomls.has(f.replace(/\.toml$/, ''))) continue
        if (readFileSync(join(tomlDir, f), 'utf8').includes(GENERATED)) {
          toBackup(join(tomlDir, f), true)
          changed.push(`codex: cất vai ${f} (đã bỏ khỏi kit) vào ${basename(backupDir)}`)
          n++
        }
      }
    }

    // hooks.json
    if (!hooksCur.exists || JSON.stringify(hooksCur.data) !== JSON.stringify(hooksMerge.json)) {
      if (hooksCur.exists) toBackup(hooksFile, false)
      writeAtomic(hooksFile, hooksText)
      changed.push('codex: hooks.json')
      n++
    }

    say(n ? `Codex: đã cập nhật (luật AGENTS.md, ${skills.length} skill, ${tomls.size} vai, hook).` : 'Codex: đã đủ, không đổi gì.')
    if (legacyMoved) {
      say(`Bộ điều phối Codex cũ đã được cất trong ${norm(backupDir)} (không xoá).`)
    }
    return true
  }

  // 4. việc user cần làm
  if (codexPresent && codexOk && changed.includes('codex: hooks.json')) todo.push('Mở Codex, gõ /hooks rồi bấm tin (trust) các hook của vibe-flow. Hook vừa đổi nên Codex chưa chạy chúng cho tới khi bạn bấm tin.')
  // AC-42: AI tìm kiếm bằng rg (nhanh, đỡ CPU khi nhiều worker chạy) — chưa có thì đưa đúng lệnh cài theo hệ điều hành.
  if (!(opts.hasRg ?? Boolean(models.findExe('rg', env, home)))) {
    const how = process.platform === 'win32' ? 'winget install BurntSushi.ripgrep.MSVC' : process.platform === 'darwin' ? 'brew install ripgrep' : 'sudo apt install ripgrep'
    todo.push(`Cài rg để AI tìm kiếm nhanh: ${how}`)
  }
  const check = opts.checkAll ?? (env.VIBE_FLOW_NO_LOGIN_CHECK ? null : clis.checkAll)
  if (check) {
    try {
      const results = Object.values(await check(clis.CLI_NAMES, { home, env, fresh: true }))
      for (const r of results) if (!r.ready && r.loginCmd) todo.push(`Đăng nhập ${r.name}: ${r.loginCmd}`)
      const missing = results.filter((r) => r.installed === false).map((r) => r.name)
      if (missing.length) todo.push(`Chưa cài (cài khi cần dùng): ${missing.join(', ')}. Xem lệnh cài: node ~/.claude/hooks/cli-check.mjs`)
    } catch {
      notes.push('Chưa kiểm được trạng thái đăng nhập các CLI; chạy: node ~/.claude/hooks/cli-check.mjs')
    }
  }

  for (const n of notes) say(`Lưu ý: ${n}`)
  for (const p of problems) say(`Lỗi: ${p}`)
  if (todo.length) {
    say('Việc bạn cần làm:')
    todo.forEach((t, i) => say(`${i + 1}. ${t}`))
  } else if (!problems.length) {
    say('Xong. Không còn việc gì cần làm.')
  }
  if (problems.length) say('Chưa xong: sửa lỗi ở trên rồi chạy lại đúng lệnh cài.')
  return { code: problems.length ? 1 : 0, changed, todo, problems, notes }
}

// ---------- chạy trực tiếp ----------

const isMain = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (isMain) {
  try {
    if (process.argv[2] === 'backup') {
      const root = join(homedir(), '.claude')
      const ref = process.argv[3] ?? 'origin/main'
      const stamp = makeStamp()
      const saved = backupMatching(root, ref, stamp)
      console.log(saved.length ? `Đã sao lưu ${saved.length} file trùng tên (*.before-kit-${stamp}):\n- ${saved.join('\n- ')}` : 'Không có file trùng tên, không cần sao lưu.')
    } else if (process.argv[2]) {
      console.error('Dùng: node ~/.claude/install.mjs   (hoặc: node install.mjs backup <ref>)')
      process.exitCode = 2
    } else {
      const want = join(homedir(), '.claude')
      const real = (p) => { try { return realpathSync.native(p) } catch { return resolve(p) } }
      const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
      if (lower(real(here)) !== lower(real(want))) {
        console.error('install.mjs phải nằm ở ~/.claude (gốc của kit). Dán lại lệnh cài một dòng trong README để kéo kit về đúng chỗ.')
        process.exitCode = 1
      } else {
        process.exitCode = (await install()).code
      }
    }
  } catch (e) {
    console.error(`Cài không xong: ${e.message}`)
    process.exitCode = 1
  }
}
