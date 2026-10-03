// legacy-migrate: chuyển tài liệu kiểu cũ của một dự án (.claude/plans/*.md, .claude/reports/*.md) sang cấu trúc v6 (sổ chốt + docs/specs).
// Spec: plans/flow-v6-so-chot/{SPEC,PLAN}.md (AC25–27). Dùng so-chot.mjs để ghi quyết định / INDEX / ROADMAP.
//
// Ba bước, mỗi bước một lệnh CLI (stdout JSON, exit 0; lỗi ⇒ exit 1 + một dòng stderr; verify không đạt ⇒ in JSON rồi exit 1):
//   plan   <projectRoot>   ghép file → tính năng theo tên, kèm độ chắc; ghi bảng ra .claude/so-chot/.migrate-plan.json. KHÔNG di chuyển gì.
//                          Dòng không chắc (do_chac "thap") có can_hoi=true: người dùng trả lời bằng cách điền "chon" (tên tính năng | "legacy" | "chung" cho decisions).
//                          Bảng còn ghi: khong_chuyen (nguồn bị git bỏ qua), tro_cu (chỗ trong file .md/.txt đã theo dõi trỏ tới đường dẫn sẽ dời: apply tự thay),
//                          can_sua_tay (chỗ KHÔNG tự sửa: file text khác như .go/.astro/.yml, và chỗ nhắc cả thư mục .claude/plans/; verify cũng liệt kê, chỉ cảnh báo),
//                          thay_doi_phu (.gitattributes, đổi tên README, file tạo mới, progress.md, sửa chỗ trỏ, dời ROADMAP viết tay ở docs/ và ở gốc dự án).
//                          Ngày một file (luc, thư mục tính năng) = dòng ngày có nhãn trong file (Ngày/Ngày chốt/Date…), không có thì lần commit đầu.
//   apply  <projectRoot>   theo bảng đã duyệt: commit 1 = git mv nguyên trạng (kể cả docs/ROADMAP.md viết tay ⇒ docs/legacy/ROADMAP-viet-tay.md);
//                          commit 2 = chuyển nội dung (MỖI file *.decisions.md ⇒ MỘT quyết định ⚠️ đúng phạm vi, bản gốc giữ nguyên byte;
//                          *.progress.md ⇒ progress.md có dòng trỏ sổ chốt; thay đúng chuỗi đường dẫn cũ → mới ở các file đã theo dõi đang trỏ tới) + INDEX/ROADMAP.
//                          Nhật ký băm nguồn .claude/so-chot/.migrated.json (tạo ở lần apply đầu, từ đó là bản duy nhất được theo: sửa bảng sau đó
//                          không có tác dụng). Chạy lại / bị ngắt giữa chừng không tạo bản trùng: mỗi quyết định mang "băm <key>" trong thân nên dù
//                          nhật ký chưa kịp ghi vẫn nhận lại được. Thiếu git identity ⇒ báo trước khi đổi bất cứ gì. Không bao giờ `git add -f`.
//                          Nhật ký và bảng nằm trong repo nên KHÔNG đáng tin: mọi đường dẫn (nguồn .md trong .claude/plans|reports, đích docs/specs|legacy, không .git,
//                          không symlink), mã băm, mã commit được kiểm TRƯỚC khi đổi gì (sai ⇒ từ chối cả bảng). .gitignore bỏ qua file nào sẽ phải commit ⇒ báo trước.
//                          Lần apply đầu mà index đã có file stage ⇒ từ chối (git mv không được rơi vào commit 2).
//   verify <projectRoot>   đối chiếu TỪNG file decisions nguồn → quyết định đích → phạm vi (bắt sót, nhân đôi, ghép nhầm phạm vi, sai nội dung, bản gốc bị đổi)
//                          và báo chỗ còn trỏ tới đường dẫn cũ, không chỉ đếm dòng.
//
// Quy ước tên: `<slug>.<plan|decisions|progress|spec|research>.md` và dạng gạch `<slug>-<…>(-N).md` xác định tính năng <slug>; tên có chữ "decisions" ở dạng
// khác thì vẫn là file quyết định (ghép vào tính năng cùng slug nếu có, không thì hỏi; không bao giờ đi legacy). `<slug>-<notes|review|recon>(-N).md` gắn vào
// tính năng <slug> nếu có thật. File tên khác (báo cáo…) ghép theo tiền tố từng-từ với slug đã có: khớp một tiền tố ⇒ chắc; khớp tiền tố dài nhất trong nhiều
// tiền tố lồng nhau ⇒ vừa (tự ghép, vẫn ghi lý do); chung từ (≥ 2) với một tính năng nhiều hơn mức tiền tố đã khớp (vd ai-agent-gaps-review.md với ai-agent vs
// ai-agent-gaps-2) ⇒ thấp, phải hỏi, kèm tối đa 4 ứng viên xếp theo độ giống và lý do; không giống tính năng nào ⇒ docs/legacy/.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as L from './so-chot.mjs'

const PLAN_REL = '.claude/so-chot/.migrate-plan.json'
const JOURNAL_REL = '.claude/so-chot/.migrated.json'
const SRC_DIRS = ['.claude/plans', '.claude/reports']
const ROADMAP_REL = 'docs/ROADMAP.md'
const ROADMAP_TAY_REL = 'docs/legacy/ROADMAP-viet-tay.md'
const ROADMAP_GOC_REL = 'ROADMAP.md' // R10: ROADMAP.md viết tay ở GỐC dự án cũng dời đi (kẻo còn hai roadmap trùng tên)
const ROADMAP_GOC_TAY_REL = 'docs/legacy/ROADMAP-goc-viet-tay.md'
const ROADMAP_MOVES = new Map([[ROADMAP_REL, ROADMAP_TAY_REL], [ROADMAP_GOC_REL, ROADMAP_GOC_TAY_REL]]) // nguồn → đích của các ROADMAP viết tay
const WATCH = [...SRC_DIRS, ROADMAP_REL, ROADMAP_GOC_REL]
const KINDS = ['plan', 'decisions', 'progress', 'spec', 'research']
const DASH_KIND_RE = new RegExp(`^(.+)-(${KINDS.join('|')})(-\\d+)?$`, 'i')
const DASH_ATTACH_RE = /^(.+)-(notes|review|recon)(-\d+)?$/i
const SLOT = { plan: 'PLAN.md', spec: 'SPEC.md', progress: 'progress.md', research: 'research.md', decisions: 'notes/decisions.md' }
const SO_CHOT_FILES = ['.claude/so-chot/INDEX.md', 'docs/ROADMAP.md', 'docs/ROADMAP-luu-tru.md']
const POINTER_RE = /^Sổ chốt \(chuyển từ sổ cũ\):.*$/mu
const MARKER_RE = /băm ([0-9a-f]{40})/u
const AI_QUYET = 'chuyen-tu-so-cu'
const GEN_RE = /^<!-- tự sinh bởi so-chot\.mjs/m // dòng đánh dấu file do so-chot sinh (docs/ROADMAP.md không có ⇒ viết tay)
const AUTO_RE = /\.(?:md|txt)$/i // R11: chỉ file .md/.txt được tự thay chỗ trỏ; file text khác (mã nguồn, cấu hình) chỉ được báo để sửa tay
// R11: chỗ nhắc CẢ THƯ MỤC (.claude/plans/, .claude/reports/…) chứ không phải một file cụ thể: không có đích mới để thay ⇒ luôn sửa tay.
const DIR_RE = /(?<=^|[\s"'`(\[<=:,|*>])\.claude\/(?:plans|reports)(?:\/(?![A-Za-z0-9_.-])|(?![A-Za-z0-9_./-]))/gm
const MAX_TEXT = 1024 * 1024
const MAX_UNG_VIEN = 4
const MAX_Y_LIET_KE = 5
const SO_CHOT_DIR = '.claude/so-chot'
const oneLine = L.oneLine

// R1/R2: nhật ký .migrated.json và bảng .migrate-plan.json nằm TRONG repo ⇒ có thể do người khác cài sẵn. Mọi chuỗi đọc từ đó (đường dẫn, mã băm, mã commit)
// phải qua các kiểm tra dưới đây TRƯỚC khi dùng làm đối số fs/git; sai ⇒ từ chối cả bảng/nhật ký, chưa đổi gì.
const HEX40_RE = /^[0-9a-f]{40}$/
const COMMIT_RE = /^[0-9a-f]{7,40}$/
const SRC_RE = /^\.claude\/(?:plans|reports)\/[^/]+\.[mM][dD]$/ // nguồn: .md nằm thẳng trong .claude/plans hoặc .claude/reports (hoặc ROADMAP viết tay)
const DEST_RE = /^docs\/(?:specs\/[^/]+\/(?:notes\/)?[^/]+|legacy\/[^/]+)$/ // đích: chỉ docs/specs/<tính năng>/… hoặc docs/legacy/…
const PHAM_VI_RE = /^(?:chung|\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*)$/
const GIT_NAME_RE = /^(?:\.git|git~\d+)$/
const LOAI_OK = new Set([...KINDS, 'khac', 'roadmap_cu'])
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

// ---------- tiện ích ----------

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const lc = (s) => s.toLowerCase()
const norm = (s) => String(s).replace(/\s+/g, ' ').trim()
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const sameDir = (a, b) => (process.platform === 'win32' ? lc(path.resolve(a)) === lc(path.resolve(b)) : path.resolve(a) === path.resolve(b))

function git(root, args, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error) throw new Error(`không chạy được git: ${r.error.message}`)
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.slice(0, 3).join(' ')} lỗi: ${oneLine(r.stderr || r.stdout, 200)}`)
  return r
}

function openRoot(projectRoot) {
  const root = fs.realpathSync.native(path.resolve(String(projectRoot ?? '')))
  const r = git(root, ['rev-parse', '--show-toplevel'], { allowFail: true })
  if (r.status !== 0) throw new Error('thư mục này không phải repo git')
  const top = fs.realpathSync.native(r.stdout.trim())
  if (!sameDir(top, root)) throw new Error(`projectRoot phải là thư mục gốc của repo git (${top})`)
  return root
}

const abs = (root, rel) => {
  const a = L.safePath(root, rel)
  if (!a) throw new Error(`đường dẫn không an toàn (ra ngoài dự án hoặc qua symlink/junction): ${rel}`)
  return a
}
const isFile = (root, rel) => {
  const a = L.safePath(root, rel)
  try { return !!a && fs.lstatSync(a).isFile() } catch { return false }
}
const readRaw = (root, rel) => fs.readFileSync(abs(root, rel))

function readJson(root, rel) {
  const a = L.safePath(root, rel)
  if (!a) throw new Error(`${rel} nằm ngoài dự án hoặc qua symlink/junction`)
  try { return JSON.parse(fs.readFileSync(a, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return null
    throw new Error(`${rel} hỏng: ${oneLine(e.message, 100)}`)
  }
}
function writeJson(root, rel, obj) {
  const a = abs(root, rel)
  fs.mkdirSync(path.dirname(a), { recursive: true })
  const tmp = `${a}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`)
  fs.renameSync(tmp, a)
}

// ---------- R1/R2: kiểm dữ liệu đọc từ nhật ký / bảng ghép ----------

const bad = (what, msg) => { throw new Error(`${what} không hợp lệ (dữ liệu trong repo, không đáng tin): ${msg}; chưa đổi gì`) }
const show = (v) => oneLine(typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)), 60)

// null nếu `rel` an toàn: tương đối dạng a/b (không "\", ":", NUL, không bắt đầu bằng "/"), không có thành phần rỗng / "." / "..", không thành phần nào là `.git`
// (kể cả hoa/thường khác, dấu chấm/cách ở cuối kiểu Windows, tên ngắn GIT~1, ký tự rộng 0; `.git` là file hay thư mục đều thế), và không ra ngoài repo / qua symlink/junction.
function relProblem(root, rel) {
  if (typeof rel !== 'string' || rel === '') return 'không phải đường dẫn'
  if (/[\0:\\]/.test(rel) || rel.startsWith('/')) return `không phải đường dẫn tương đối dạng a/b (${show(rel)})`
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return `có thành phần rỗng, "." hoặc ".." (${show(rel)})`
  if (parts.some((p) => GIT_NAME_RE.test(p.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '').replace(/[. ]+$/, '').toLowerCase()))) return `nằm trong .git (${show(rel)})`
  if (!L.safePath(root, rel)) return `ra ngoài dự án hoặc qua symlink/junction (${show(rel)})`
  return null
}

// Kiểm cả bảng `nguon` (nhật ký.nguon, hoặc bảng ghép đã quy ra) trước khi chạm vào đâu.
function checkNguon(root, nguon, what) {
  if (!isObj(nguon)) bad(what, 'nguon phải là một object')
  for (const [rel, e] of Object.entries(nguon)) {
    if (!isObj(e)) bad(what, `dòng ${show(rel)} không phải object`)
    if (!LOAI_OK.has(e.loai)) bad(what, `loai lạ ở ${show(rel)}: ${show(e.loai)}`)
    const roadmap = e.loai === 'roadmap_cu'
    let p = relProblem(root, rel)
    if (!p && !(roadmap ? ROADMAP_MOVES.has(rel) : SRC_RE.test(rel))) p = `nguồn phải là .md nằm thẳng trong .claude/plans hoặc .claude/reports${roadmap ? ` (ROADMAP viết tay: ${[...ROADMAP_MOVES.keys()].join(', ')})` : ''} (${show(rel)})`
    if (p) bad(what, `nguồn: ${p}`)
    p = relProblem(root, e.dich)
    if (!p && !(roadmap ? e.dich === ROADMAP_MOVES.get(rel) : DEST_RE.test(e.dich))) p = `đích phải nằm trong docs/specs/<tính năng>/ hoặc docs/legacy/ (${show(e.dich)})`
    if (p) bad(what, `đích của ${show(rel)}: ${p}`)
    if (typeof e.sha !== 'string' || !HEX40_RE.test(e.sha)) bad(what, `sha của ${show(rel)} phải là 40 ký tự hex`)
    if (e.sha_sau !== undefined && !(typeof e.sha_sau === 'string' && HEX40_RE.test(e.sha_sau))) bad(what, `sha_sau của ${show(rel)} phải là 40 ký tự hex`)
    if (e.pham_vi !== null && !(typeof e.pham_vi === 'string' && PHAM_VI_RE.test(e.pham_vi))) bad(what, `pham_vi của ${show(rel)}: ${show(e.pham_vi)}`)
    if (e.tn != null) {
      if (typeof e.tn !== 'string' || typeof e.pham_vi !== 'string' || e.pham_vi === 'chung' || !e.dich.startsWith(`docs/specs/${e.pham_vi}/`)) bad(what, `đích của ${show(rel)} không khớp thư mục tính năng`)
    } else if (!e.dich.startsWith('docs/legacy/')) bad(what, `đích của ${show(rel)} phải nằm trong docs/legacy/`)
  }
}

function checkJournal(root, J) {
  const what = `nhật ký ${JOURNAL_REL}`
  if (!isObj(J)) bad(what, 'không phải object')
  checkNguon(root, J.nguon, what)
  if (J.commit1 != null && !(typeof J.commit1 === 'string' && COMMIT_RE.test(J.commit1))) bad(what, `commit1 phải là mã commit 7–40 ký tự hex thường (nhận ${show(J.commit1)})`)
  if (!isObj(J.y)) bad(what, 'y phải là một object')
  for (const [key, y] of Object.entries(J.y)) {
    if (!HEX40_RE.test(key) || !isObj(y)) bad(what, `y: khoá hoặc giá trị lạ (${show(key)})`)
    if (typeof y.file !== 'string' || !/^[^/]+\/[^/]+\.md$/.test(y.file)) bad(what, `y.file lạ (${show(y.file)})`)
    const p = relProblem(root, `${SO_CHOT_DIR}/${y.file}`)
    if (p) bad(what, `y.file: ${p}`)
    if (typeof y.pham_vi !== 'string' || !PHAM_VI_RE.test(y.pham_vi)) bad(what, `y.pham_vi lạ (${show(y.pham_vi)})`)
  }
  if (J.sua_tro !== undefined) {
    if (!Array.isArray(J.sua_tro)) bad(what, 'sua_tro phải là mảng đường dẫn')
    for (const f of J.sua_tro) { const p = relProblem(root, f); if (p) bad(what, `sua_tro: ${p}`) }
  }
}

// R3: file nào của việc chuyển cũng phải commit được mà không cần `git add -f`. Bị .gitignore bỏ qua mà để tới commit 2 mới biết thì dự án kẹt giữa hai commit
// (nhật ký, quyết định, INDEX đã ghi ra đĩa). Kiểm TRƯỚC khi đổi gì; check-ignore không báo file đã theo dõi nên chạy lại sau khi xong vẫn qua.
function checkIgnored(root, J) {
  const phamVi = [...new Set(Object.values(J.nguon).filter((e) => e.loai === 'decisions' && e.pham_vi).map((e) => e.pham_vi))].sort()
  const want = [JOURNAL_REL, PLAN_REL, ...SO_CHOT_FILES, 'docs/IDEAS.md', '.gitattributes', ...phamVi.map((p) => `${SO_CHOT_DIR}/${p}/x.md`)]
  const ign = [...ignoredSet(root, want)]
  if (!ign.length) return
  const fix = [...new Set(ign.map((p) => (p.startsWith(`${SO_CHOT_DIR}/`) ? `!${SO_CHOT_DIR}/` : `!${p}`)))]
  throw new Error(`git đang bỏ qua (.gitignore) ${ign.length} file mà việc chuyển phải commit (${ign.slice(0, 3).join(', ')}): thêm vào .gitignore ${fix.map((l) => `\`${l}\``).join(', ')} rồi chạy lại apply (chưa đổi gì)`)
}

// ---------- git: danh tính, file bị bỏ qua, file đã theo dõi ----------

// FC7: commit cần tên + email; thiếu thì dừng TRƯỚC khi đổi bất cứ gì (git tự báo tiếng Anh, dính vào thông báo cắt cụt).
function needIdentity(root) {
  if (['GIT_COMMITTER_IDENT', 'GIT_AUTHOR_IDENT'].every((v) => git(root, ['var', v], { allowFail: true }).status === 0)) return
  throw new Error('chưa có tên/email git để tạo commit: chạy `git config user.name "Tên bạn"` và `git config user.email "email@bạn"` rồi chạy lại apply (chưa đổi gì)')
}

// FC1: các đường dẫn (chưa được theo dõi) mà .gitignore đang bỏ qua. File ĐÃ theo dõi không bao giờ nằm trong kết quả (check-ignore không báo).
function ignoredSet(root, paths) {
  if (!paths.length) return new Set()
  const r = spawnSync('git', ['-c', 'core.quotepath=off', 'check-ignore', '-z', '--stdin'], { cwd: root, encoding: 'utf8', input: `${paths.join('\0')}\0`, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`không chạy được git: ${r.error.message}`)
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore lỗi: ${oneLine(r.stderr || r.stdout, 200)}`)
  return new Set(r.stdout.split('\0').filter(Boolean))
}
const trackedUnder = (root, paths) => new Set(git(root, ['ls-files', '-z', '--', ...paths], { allowFail: true }).stdout.split('\0').filter(Boolean))
const trackedAll = (root) => git(root, ['ls-files', '-z'], { allowFail: true }).stdout.split('\0').filter(Boolean)

// ROADMAP viết tay ở `rel` (docs/ROADMAP.md hoặc ROADMAP.md gốc: có nội dung, không có dòng "tự sinh bởi so-chot.mjs") ⇒ Buffer; không có / rỗng / do so-chot sinh ⇒ null.
function roadmapTay(root, rel) {
  if (!isFile(root, rel)) return null
  const buf = readRaw(root, rel)
  const text = buf.toString('utf8')
  return text.trim() === '' || GEN_RE.test(text) ? null : buf
}

// FC8: .gitattributes sẽ bị tạo / thêm dòng nào (chạy đúng hàm của so-chot trên bản sao tạm, không đụng repo).
function gitattributesChange(root) {
  const a = L.safePath(root, '.gitattributes')
  if (!a) return null
  let cur = null
  try { if (fs.lstatSync(a).isFile()) cur = fs.readFileSync(a, 'utf8') } catch {}
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-migrate-ga-'))
  try {
    if (cur !== null) fs.writeFileSync(path.join(tmp, '.gitattributes'), cur)
    const r = L.ensureGitattributes(tmp)
    return r.changed ? { tao: cur === null, them: r.them } : null
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------- FC4: chỗ trỏ tới đường dẫn nguồn sẽ dời ----------

// Text đã theo dõi, đọc được (≤ 1 MB, không NUL, UTF-8 hợp lệ nên ghi lại không làm hỏng byte); không thì null. Nhận diện theo NỘI DUNG, không theo đuôi
// (R11: .go/.astro/.gitignore… cũng được quét để báo; việc có tự sửa hay không do AUTO_RE quyết).
function readTextFile(root, rel) {
  const a = L.safePath(root, rel)
  if (!a) return null
  let buf
  try {
    const st = fs.lstatSync(a)
    if (!st.isFile() || st.size > MAX_TEXT) return null
    buf = fs.readFileSync(a)
  } catch { return null }
  if (buf.includes(0)) return null
  const text = buf.toString('utf8')
  return Buffer.from(text, 'utf8').equals(buf) ? text : null
}

// Khớp ĐÚNG chuỗi đường dẫn cũ: đứng đầu dòng hoặc sau khoảng trắng/dấu bao (` " ' ( [ < = : , | * >), và không dính tiếp vào tên dài hơn
// (vd .bak, -2). Đường dẫn trong ~/.claude/… hay thư mục khác (đứng sau "/" hoặc "~") không khớp.
function refRegex(olds) {
  const alt = [...olds.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')
  return new RegExp(`(?<=^|[\\s"'\`(\\[<=:,|*>])(?:${alt})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'gm')
}
const replaceRefs = (text, re, olds) => text.replace(re, (m) => olds.get(m) ?? m)
function findRefs(file, text, re, olds, sua) {
  const out = []
  text.split('\n').forEach((line, i) => { for (const m of line.matchAll(re)) out.push({ file, dong: i + 1, cu: m[0], moi: olds.get(m[0]) ?? null, sua }) })
  return out
}
// R11: chỗ KHÔNG tự sửa được ⇒ người dùng sửa tay: (a) chỗ trỏ tới file nguồn trong file không phải .md/.txt (mã nguồn, cấu hình), (b) chỗ nhắc cả thư mục
// (.claude/plans/) trong mọi file text. `re` null (không có nguồn nào để dời) thì chỉ có loại (b).
function findManual(file, text, re, olds) {
  const out = []
  text.split('\n').forEach((line, i) => {
    if (re && !AUTO_RE.test(file)) for (const m of line.matchAll(re)) out.push({ file, dong: i + 1, cu: m[0], moi: olds.get(m[0]) ?? null, ly_do: 'file không phải .md/.txt: không tự sửa' })
    for (const m of line.matchAll(DIR_RE)) out.push({ file, dong: i + 1, cu: m[0], moi: null, ly_do: 'nhắc cả thư mục: không có đích mới để thay' })
  })
  return out
}
const nFiles = (es) => new Set(es.map((e) => e.file)).size
const canhTay = (tay) => `${tay.length} chỗ trong ${nFiles(tay)} file cần sửa tay (không tự sửa: file không phải .md/.txt, hoặc nhắc cả thư mục .claude/plans/): vd ${tay[0].file}:${tay[0].dong} ${tay[0].cu}`
// File đã theo dõi mà việc chuyển KHÔNG di chuyển / không phải sổ chốt: những chỗ cần sửa chuỗi.
function trackedTexts(root, skip) {
  const out = []
  for (const rel of trackedAll(root)) {
    if (skip.has(rel) || rel.startsWith('.claude/so-chot/')) continue
    const text = readTextFile(root, rel)
    if (text !== null) out.push({ rel, text })
  }
  return out
}

// ---------- tách "ý" của một file decisions ----------

// Ý = mục gạch đầu dòng / đánh số ở cột 0 (kèm dòng thụt vào và dòng nối tiếp), hoặc một dòng dữ liệu của bảng markdown.
// File không có mục nào ⇒ mỗi đoạn dưới một tiêu đề (##…), rồi tới mỗi đoạn văn. `ngoai` = số dòng chữ nằm ngoài mọi ý (vẫn còn nguyên trong file gốc).
export function parseItems(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  let start = 0
  if (lines[0]?.trim() === '---') { const e = lines.findIndex((l, k) => k > 0 && l.trim() === '---'); if (e > 0) start = e + 1 }
  const BULLET = /^(?:[-*+]|\d{1,3}[.)])[ \t]+\S/
  const ROW = /^\|.*\|[ \t]*$/
  const SEP = /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
  const items = []
  let cur = null
  let blanks = 0
  let fence = null
  let ngoai = 0
  const close = () => { if (cur) items.push({ text: cur.join('\n').trim() }); cur = null; blanks = 0 }
  const add = (line) => { for (; blanks > 0; blanks--) cur.push(''); cur.push(line) }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    const fm = /^[ \t]*(```|~~~)/.exec(line)
    if (fence) {
      if (cur) add(line); else ngoai++
      if (fm && fm[1] === fence) fence = null
      continue
    }
    if (fm) { fence = fm[1]; if (cur) add(line); else ngoai++; continue }
    if (!line.trim()) { blanks++; continue }
    if (/^#{1,6}[ \t]/.test(line)) { close(); continue }
    if (BULLET.test(line)) { close(); cur = [line]; continue }
    if (ROW.test(line)) {
      close()
      if (!SEP.test(line.trim()) && !SEP.test((lines[i + 1] ?? '').trim())) items.push({ text: line.trim() }) // bỏ dòng ngăn cách và dòng tiêu đề bảng
      continue
    }
    if (/^[ \t]+\S/.test(line)) { if (cur) add(line); else ngoai++; continue }
    if (cur && blanks === 0) { cur.push(line); continue }
    close()
    ngoai++
  }
  close()
  if (items.length) return { items, ngoai }

  const body = lines.slice(start)
  const secs = []
  let sec = null
  for (const l of body) {
    if (/^#{1,6}[ \t]/.test(l)) { if (sec) secs.push(sec); sec = /^#{2,6}[ \t]/.test(l) ? [l] : null } else if (sec) sec.push(l)
  }
  if (sec) secs.push(sec)
  const bySec = secs.filter((s) => s.slice(1).some((l) => l.trim())).map((s) => ({ text: s.join('\n').trim() }))
  if (bySec.length) return { items: bySec, ngoai: 0 }

  const paras = body.filter((l) => !/^#[ \t]/.test(l)).join('\n').split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean).map((p) => ({ text: p }))
  return { items: paras, ngoai: 0 }
}

function tomTatOf(text, idx, base, max = 160) {
  const clean = (l) => l.trim().replace(/^#{1,6}[ \t]+/, '').replace(/^(?:[-*+]|\d{1,3}[.)])[ \t]+/, '').replace(/^\[[ xX]\][ \t]*/, '').replace(/(\*\*|__)/g, '')
  const ls = text.split('\n')
  let s = ls[0].trim().startsWith('|') ? ls[0].split('|').map((c) => c.trim()).filter(Boolean).join(' · ').replace(/(\*\*|__)/g, '') : clean(ls[0])
  if (s.length < 12 && ls[1]) s = `${s} ${clean(ls[1])}`
  return L.cutWords(oneLine(s), max) || `Mục ${idx + 1} của ${base}`
}

// FC5: mỗi FILE decisions = MỘT quyết định ⚠️ phạm vi tính năng. Khoá nhận lại = nguồn + băm nội dung lúc lập bảng (không đổi dù file đích sau đó bị sửa).
const keyOfFile = (nguon, sha) => sha1(`${nguon}\0${sha}`)
const soFile = (J, e) => Object.values(J.nguon).filter((x) => x.loai === 'decisions' && x.pham_vi === e.pham_vi).length // số file decisions cùng phạm vi
// R9: tóm tắt NÓI NỘI DUNG: "Quyết định cũ của <tính năng>: <ý đầu, cắt ở ranh giới từ> (+N ý)" (một ý ⇒ không có "(+N ý)"; không tách được ý ⇒ nói rõ). Tổng ≤ 200 ký tự.
function tomTatFile(e, rel, items, dup) {
  const base = rel.split('/').at(-1)
  const who = e.tn ? `Quyết định cũ của ${e.tn}${dup > 1 ? ` — ${base}` : ''}` : `Quyết định cũ chung từ ${base}`
  if (!items.length) return `${who} (chưa tách được ý)`
  const more = items.length > 1 ? ` (+${items.length - 1} ý)` : ''
  return `${who}: ${tomTatOf(items[0].text, 0, base, Math.max(40, 200 - who.length - 2 - more.length))}${more}`
}
// R9: tên file quyết định = <mã>-<slug đầy đủ của tính năng>, không cụt ở 6 từ (3 tính năng ai-agent-* không còn trùng tên) và không lẫn số ý.
function slugFile(e, rel, dup) {
  const base = rel.split('/').at(-1).replace(/\.md$/i, '')
  return e.tn ? `quyet-dinh-cu-${e.tn}${dup > 1 ? `-${base}` : ''}` : `quyet-dinh-cu-chung-${base}`
}
// Thân: dòng định danh (có băm), link bản gốc (nguyên byte, ở chỗ mới), tối đa 5 ý đầu (mỗi ý một dòng tóm tắt), phần còn lại chỉ đếm.
function viSaoFile(e, rel, items, key) {
  const base = rel.split('/').at(-1)
  const text = e.tn ? e.dich.replace(`docs/specs/${e.pham_vi}/`, '') : e.dich
  const head = `Chuyển từ sổ cũ ${rel} (nay ${e.dich}) · ${items.length} ý · băm ${key}\n\nChưa ai xem lại. Bản gốc nguyên văn: [${text}](${encodeURI(`../../../${e.dich}`)})`
  if (!items.length) return `${head}\n\nKhông tách được ý riêng: đọc bản gốc.`
  const lines = items.slice(0, MAX_Y_LIET_KE).map((it, i) => `- ${tomTatOf(it.text, i, base)}`)
  const more = items.length > MAX_Y_LIET_KE ? [`…còn ${items.length - MAX_Y_LIET_KE} ý nữa trong bản gốc.`] : []
  return [head, '', ...lines, ...more].join('\n')
}

// ---------- ghép file → tính năng ----------

// kind ∈ KINDS ⇒ file này XÁC ĐỊNH tính năng `key` (dạng chấm `x.decisions.md` hoặc dạng gạch `x-decisions.md`, `x-spec-2.md`).
// tentative=true ⇒ tên chỉ chứa chữ "decisions" (FC2): vẫn là file quyết định nhưng không tự tạo tính năng.
// kind 'khac' ⇒ ghép theo tên; `hint` = slug đứng trước hậu tố -notes/-review/-recon (gắn vào tính năng đó nếu có thật).
function classify(name) {
  const stem = name.replace(/\.md$/i, '')
  const key = (s) => slugify(s.replace(/^\d{4}-\d{2}-\d{2}[-_ ]+/, ''))
  const dot = new RegExp(`^(.+)\\.(${KINDS.join('|')})$`, 'i').exec(stem)
  if (dot && key(dot[1])) return { kind: dot[2].toLowerCase(), key: key(dot[1]) }
  const dash = DASH_KIND_RE.exec(stem)
  if (dash && key(dash[1])) return { kind: dash[2].toLowerCase(), key: key(dash[1]) }
  const toks = key(stem).split('-').filter(Boolean)
  const di = toks.indexOf('decisions')
  if (di >= 0) return { kind: 'decisions', key: toks.slice(0, di).join('-'), tentative: true }
  const att = DASH_ATTACH_RE.exec(stem)
  const hint = att ? key(att[1]) : ''
  return { kind: 'khac', key: key(stem), ...(hint ? { hint } : {}) }
}

const commonLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i }

// FC3: mọi tính năng có từ chung (không tính số trần) với tên, xếp theo độ giống: nhiều từ chung hơn, rồi tiền tố chung dài hơn, rồi theo tên.
function rankAll(tk, feats) {
  const set = new Set(tk)
  return [...feats]
    .map(([slug, ft]) => ({ slug, ft, pre: commonLen(ft, tk), shared: [...new Set(ft)].filter((t) => set.has(t) && !/^\d+$/.test(t)) }))
    .filter((r) => r.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length || b.pre - a.pre || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}
function whyCand(r) {
  const pre = r.ft.slice(0, r.pre)
  const rest = r.shared.filter((t) => !pre.includes(t))
  return [pre.length ? `tiền tố chung "${pre.join('-')}"` : '', rest.length ? `từ chung: ${rest.join(', ')}` : ''].filter(Boolean).join(' + ')
}
const ungVien = (rank) => {
  const top = rank.slice(0, MAX_UNG_VIEN)
  return { ung_vien: top.map((r) => r.slug), ung_vien_ly_do: Object.fromEntries(top.map((r) => [r.slug, whyCand(r)])) }
}

// File có chữ "decisions" trong tên nhưng không theo mẫu: tính năng cùng slug có thật ⇒ vừa; không thì hỏi (chọn tính năng hoặc "chung"); không bao giờ legacy.
function matchDecisions(key, feats) {
  if (key && feats.has(key)) return { tinh_nang: key, do_chac: 'vua', can_hoi: false, ly_do: `tên chứa "decisions" ⇒ coi là quyết định của tính năng ${key}` }
  const rank = rankAll(key.split('-').filter(Boolean), feats)
  return {
    tinh_nang: null, do_chac: 'thap', can_hoi: true, ...ungVien(rank), de_xuat: null,
    ly_do: 'tên chứa "decisions" nhưng không ghép được tính năng: chọn tính năng hoặc "chung" (quyết định luôn vào sổ chốt, không đi legacy)',
  }
}

function matchUntyped(key, feats) {
  const tk = key.split('-').filter(Boolean)
  const cands = [...feats].filter(([, ft]) => ft.length && commonLen(ft, tk) === ft.length).sort((a, b) => b[1].length - a[1].length)
  const best = cands[0]
  const rank = rankAll(tk, feats)
  const near = rank.filter((r) => !cands.some(([c]) => c === r.slug) && r.shared.length >= 2 && r.shared.length > (best?.[1].length ?? 0))
  if (near.length) {
    const uv = ungVien(rank)
    return {
      tinh_nang: null, do_chac: 'thap', can_hoi: true, ...uv, de_xuat: best?.[0] ?? null,
      ly_do: `tên giống nhiều tính năng (${uv.ung_vien.join(', ')}), không chắc thuộc cái nào`,
    }
  }
  if (!best) return { tinh_nang: null, do_chac: 'cao', can_hoi: false, ly_do: 'không giống tính năng nào ⇒ docs/legacy' }
  if (cands.length > 1) {
    return { tinh_nang: best[0], do_chac: 'vua', can_hoi: false, ung_vien: cands.map(([s]) => s), ly_do: `khớp tiền tố dài nhất ${best[0]} (cũng khớp: ${cands.slice(1).map(([s]) => s).join(', ')})` }
  }
  return { tinh_nang: best[0], do_chac: 'cao', can_hoi: false, ly_do: `khớp tiền tố ${best[0]}` }
}

// R9: ngày ghi trong file = dòng có NHÃN rõ ràng ở đầu dòng (Ngày / Ngày chốt / Ngày tạo / Ngày ghi / Ngày lập / Ngày quyết định / Chốt ngày / Date / Created…,
// có thể bọc markdown), ngày dạng YYYY-MM-DD hoặc DD/MM/YYYY (DD-MM-YYYY, DD.MM.YYYY); chỉ xét 60 dòng đầu; nhiều dòng ⇒ lấy sớm nhất. "Cập nhật", "Xong ngày" không phải
// ngày chốt nên không tính. Bỏ ngày không có thật (tháng 13…), năm < 2000, ngày ở tương lai (quá `now` một ngày). Không có ⇒ null (dùng ngày commit đầu).
const NGAY_NHAN_RE = /^[ \t>*_#-]*(?:ngày(?:[ \t]+(?:chốt|tạo|ghi|lập|quyết định))?|chốt ngày|date|created(?:[ \t]+(?:at|on))?)[ \t*_]*[:：][ \t*_]*(.+?)[ \t*_]*$/iu
function parseNgay(s, now) {
  const a = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(s)
  const b = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/.exec(s)
  const [y, mo, d] = a ? [a[1], a[2], a[3]].map(Number) : b ? [b[3], b[2], b[1]].map(Number) : []
  if (!y || y < 2000) return null
  const t = Date.UTC(y, mo - 1, d)
  const dt = new Date(t)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || t > now + 86400000) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function ngayTrongFile(text, now) {
  let best = null
  for (const line of text.normalize('NFC').split(/\r?\n/, 60)) {
    const m = NGAY_NHAN_RE.exec(line)
    const d = m ? parseNgay(m[1], now) : null
    if (d && (!best || d < best)) best = d
  }
  return best
}

// Ngày + giờ VN của lần commit đầu của từng file nguồn (một lần gọi git); file chưa vào git ⇒ không có trong map.
function commitTimes(root) {
  const r = git(root, ['log', '--format=@@%ct', '--name-only', '--', ...WATCH], { allowFail: true })
  const map = new Map()
  let cur = null
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('@@')) cur = Number(line.slice(2))
    else if (line.trim() && cur) { const p = line.trim(); if (!map.has(p) || cur < map.get(p)) map.set(p, cur) }
  }
  return map
}

function listSources(root, canh) {
  const out = []
  for (const dir of SRC_DIRS) {
    const a = L.safePath(root, dir)
    if (!a) { canh.push(`bỏ qua ${dir}: symlink/junction hoặc ngoài thư mục dự án`); continue }
    let names
    try { names = fs.readdirSync(a).sort() } catch { continue }
    for (const n of names) {
      const rel = `${dir}/${n}`
      const st = fs.lstatSync(path.join(a, n))
      if (st.isSymbolicLink()) canh.push(`bỏ qua ${rel}: symlink/junction`)
      else if (st.isDirectory()) canh.push(`bỏ qua thư mục con ${rel}: không tự chuyển, xử lý tay`)
      else if (st.isFile() && !/\.md$/i.test(n)) canh.push(`bỏ qua ${rel}: không phải .md`)
      else if (st.isFile()) out.push({ rel, name: n, buf: fs.readFileSync(path.join(a, n)) })
    }
  }
  return out
}

// Chọn đích cho từng dòng: slot chuẩn của tính năng (PLAN.md, progress.md, notes/decisions.md…) hoặc notes/<tên gốc>; trùng ⇒ thêm tiền tố / số. Xác định, không xem đĩa.
function allocate(list, feats) {
  const used = new Set()
  const out = new Map()
  for (const { nguon, loai, target } of [...list].sort((a, b) => (a.nguon < b.nguon ? -1 : 1))) {
    const parts = nguon.split('/')
    const base = parts.at(-1)
    const srcDir = parts[1]
    const cands = loai === 'roadmap_cu'
      ? [ROADMAP_MOVES.get(nguon)]
      : target === 'legacy' || target === 'chung'
      ? [`docs/legacy/${base}`, `docs/legacy/${srcDir}-${base}`]
      : (() => { const dir = `docs/specs/${feats[target].thu_muc}`; return [...(SLOT[loai] ? [`${dir}/${SLOT[loai]}`] : []), `${dir}/notes/${base}`, `${dir}/notes/${srcDir}-${base}`] })()
    let d = cands.find((c) => !used.has(lc(c)))
    for (let n = 2; !d; n++) { const c = cands.at(-1).replace(/(\.[^./]*)?$/, `-${n}$1`); if (!used.has(lc(c))) d = c }
    used.add(lc(d))
    out.set(nguon, d)
  }
  return out
}

function targetOf(r, feats) {
  const c = r.chon ?? (r.can_hoi ? null : (r.tinh_nang ?? 'legacy'))
  if (c === null) return { err: 'chưa trả lời: điền "chon" = tên tính năng | "legacy"' }
  const s = String(c)
  if (s === 'legacy') return r.loai === 'decisions' ? { err: 'file decisions không đi legacy: chọn tính năng hoặc "chung"' } : { target: 'legacy' }
  if (s === 'chung') return r.loai === 'decisions' ? { target: 'chung' } : { err: '"chung" chỉ dành cho file decisions' }
  return Object.hasOwn(feats, s) && feats[s] ? { target: s } : { err: `không có tính năng "${oneLine(s, 40)}" trong bảng` }
}

// ---------- plan ----------

export function plan(projectRoot, opts = {}) {
  const root = openRoot(projectRoot)
  if (readJson(root, JOURNAL_REL)) throw new Error(`đã chuyển rồi (${JOURNAL_REL}); dùng verify, không lập bảng lại`)
  const canh = []
  const tracked = trackedUnder(root, WATCH)
  const times = commitTimes(root)
  const all = listSources(root, canh)
  for (const rel of ROADMAP_MOVES.keys()) { // FC6: ROADMAP viết tay phải dời đi trước khi sinh ROADMAP mới (R10: cả ROADMAP.md ở gốc dự án)
    const buf = roadmapTay(root, rel)
    if (buf) all.push({ rel, name: 'ROADMAP.md', buf, roadmap: true })
  }
  const now = opts.now ?? Date.now()

  // FC1: nguồn chưa theo dõi mà .gitignore đang bỏ qua ⇒ không chuyển (không bao giờ git add -f), liệt kê riêng.
  const ign = ignoredSet(root, all.filter((f) => !tracked.has(f.rel)).map((f) => f.rel))
  const khong_chuyen = all.filter((f) => ign.has(f.rel)).map((f) => ({ nguon: f.rel, ly_do: 'git đang bỏ qua (.gitignore): không chuyển, để nguyên chỗ cũ' }))
  if (khong_chuyen.length) canh.push(`${khong_chuyen.length} file git đang bỏ qua (.gitignore): không chuyển, để nguyên chỗ cũ (vd ${khong_chuyen[0].nguon})`)

  const files = all.filter((f) => !ign.has(f.rel)).map((f) => {
    const ct = times.get(f.rel)
    const ngayFile = f.roadmap ? null : ngayTrongFile(f.buf.toString('utf8'), now) // R9: ngày ghi trong file ưu tiên hơn lần commit đầu
    return {
      ...f, ...(f.roadmap ? { kind: 'roadmap_cu', key: '' } : classify(f.name)), sha: sha1(f.buf),
      luc: ngayFile ? `${ngayFile} 00:00` : L.vnTime(ct ? ct * 1000 : fs.statSync(abs(root, f.rel)).mtimeMs), ngayTu: ngayFile ? 'file' : ct ? 'git' : 'mtime',
    }
  })
  const untracked = files.filter((f) => !tracked.has(f.rel)).length
  if (untracked) canh.push(`${untracked} file nguồn chưa được git theo dõi: sẽ được dời bằng fs rồi git add (commit 1 ghi là thêm mới, không phải đổi tên)`)

  const feats = new Map()
  for (const f of files) if (f.kind !== 'khac' && f.kind !== 'roadmap_cu' && !f.tentative && f.key) feats.set(f.key, f.key.split('-'))
  const prev = readJson(root, PLAN_REL)
  const chonCu = new Map((Array.isArray(prev?.dong) ? prev.dong : []).filter((r) => isObj(r) && r.chon != null).map((r) => [`${r.nguon}\0${r.sha}`, r.chon]))

  const rows = files.map((f) => {
    const base = { nguon: f.rel, sha: f.sha }
    let row
    if (f.kind === 'roadmap_cu') {
      row = { ...base, loai: 'roadmap_cu', tinh_nang: null, do_chac: 'cao', can_hoi: false, ly_do: `${f.rel} viết tay ⇒ dời sang ${ROADMAP_MOVES.get(f.rel)}${f.rel === ROADMAP_REL ? ', rồi mới sinh ROADMAP mới' : ''}` }
    } else if (f.tentative) {
      row = { ...base, loai: 'decisions', ...matchDecisions(f.key, feats) }
    } else if (f.kind !== 'khac' && f.key) {
      row = { ...base, loai: f.kind, tinh_nang: f.key, do_chac: 'cao', can_hoi: false, ly_do: `tên file chỉ rõ tính năng ${f.key}` }
    } else if (f.hint && feats.has(f.hint)) {
      row = { ...base, loai: 'khac', tinh_nang: f.hint, do_chac: 'cao', can_hoi: false, ly_do: `tên file chỉ rõ tính năng ${f.hint}` }
    } else {
      row = { ...base, loai: 'khac', ...matchUntyped(f.key, feats) }
    }
    row.luc = f.luc
    if (f.kind === 'decisions') {
      const p = parseItems(f.buf.toString('utf8'))
      row.so_y = p.items.length
      if (!p.items.length) canh.push(`${f.rel}: không tách được ý nào, kiểm tra tay`)
      else if (p.ngoai) row.ghi_chu = `${p.ngoai} dòng chữ nằm ngoài các ý (vẫn còn trong notes/decisions.md)`
    }
    row.chon = chonCu.get(`${f.rel}\0${f.sha}`) ?? null
    return row
  })

  const tinh_nang = {}
  for (const slug of [...feats.keys()].sort()) {
    const mine = rows.filter((r) => r.tinh_nang === slug)
    const first = mine.reduce((a, r) => (r.luc < a.luc ? r : a))
    const ngay = first.luc.slice(0, 10)
    tinh_nang[slug] = {
      thu_muc: `${ngay}-${slug}`, ngay, nguon_ngay: files.find((f) => f.rel === first.nguon).ngayTu,
      so_file: mine.length, gan: [...feats].filter(([s, ft]) => s !== slug && ft.length < feats.get(slug).length && commonLen(ft, feats.get(slug)) === ft.length).map(([s]) => s),
    }
  }
  const targets = rows.map((r) => ({ r, t: targetOf(r, tinh_nang) }))
  const dest = allocate(targets.filter((x) => x.t.target).map((x) => ({ nguon: x.r.nguon, loai: x.r.loai, target: x.t.target })), tinh_nang)
  for (const { r, t } of targets) r.dich = t.target ? dest.get(r.nguon) : null

  // FC4: chỗ trong file đã theo dõi trỏ tới đường dẫn nguồn sẽ dời (dòng chưa biết đích: moi = null). sua=false chỉ với file decisions (bản gốc giữ nguyên byte).
  // docs/ROADMAP.md viết tay không có "chỗ trỏ cần sửa": đường đó sẽ là ROADMAP mới do so-chot sinh. R11: file không phải .md/.txt và chỗ nhắc cả thư mục ⇒ `tay` (sửa tay).
  const olds = new Map(rows.filter((r) => r.nguon !== ROADMAP_REL).map((r) => [r.nguon, r.dich]))
  const tro = []
  const tay = []
  if (rows.length) {
    const re = olds.size ? refRegex(olds) : null
    const skip = new Set(rows.flatMap((r) => [r.nguon, r.dich].filter(Boolean)))
    const dichOf = new Map(rows.map((r) => [r.nguon, r.dich]))
    for (const { rel, text } of trackedTexts(root, skip)) {
      if (re && AUTO_RE.test(rel)) tro.push(...findRefs(rel, text, re, olds, true))
      tay.push(...findManual(rel, text, re, olds))
    }
    for (const f of files) { // file sắp dời: chỗ trỏ ghi theo đường cũ (sẽ được sửa ở chỗ mới); chỗ sửa tay ghi theo đường MỚI (nơi người dùng sẽ mở)
      const text = f.buf.toString('utf8')
      if (re) tro.push(...findRefs(f.rel, text, re, olds, f.kind !== 'decisions'))
      if (f.kind !== 'decisions') tay.push(...findManual(dichOf.get(f.rel) ?? f.rel, text, re, olds))
    }
  }
  const troSua = tro.filter((e) => e.sua)
  const troGiu = tro.filter((e) => !e.sua)
  const nFile = (es) => new Set(es.map((e) => e.file)).size
  if (troSua.length) canh.push(`${troSua.length} chỗ trong ${nFile(troSua)} file đang trỏ tới đường dẫn sẽ dời (vd ${troSua[0].file}:${troSua[0].dong} ${troSua[0].cu} → ${troSua[0].moi ?? '?'}): apply thay đúng chuỗi ở commit 2`)
  if (troGiu.length) canh.push(`${troGiu.length} chỗ trong ${nFile(troGiu)} file decisions cũng nhắc đường cũ: giữ nguyên bản gốc (nguyên byte), không tự sửa`)
  if (tay.length) canh.push(canhTay(tay))

  // FC8: các thay đổi phụ ngoài việc dời file, để người duyệt bảng thấy hết.
  const phu = []
  const ga = gitattributesChange(root)
  if (ga) {
    const ds = ga.them.map((l) => l.split(' ')[0]).join(', ')
    phu.push(ga.tao ? `tạo .gitattributes (${ga.them.length} dòng merge=union: ${ds})` : `sửa .gitattributes: thêm ${ga.them.length} dòng merge=union (${ds})`)
  }
  for (const r of rows) if (r.dich && /^readme\.md$/i.test(r.nguon.split('/').at(-1))) phu.push(`đổi tên ${r.nguon} → ${r.dich} (tên README dễ nhầm; luật .gitignore riêng cho file này, nếu có, mất tác dụng)`)
  for (const r of rows) if (r.loai === 'roadmap_cu') phu.push(`dời ${r.nguon} viết tay${r.nguon === ROADMAP_GOC_REL ? ' ở gốc dự án' : ''} → ${r.dich} (commit 1)${r.nguon === ROADMAP_REL ? ', rồi sinh ROADMAP mới tự động' : ''}`)
  phu.push(`tạo mới: ${rows.filter((r) => r.loai === 'decisions').length} quyết định ⚠️ trong .claude/so-chot/<phạm vi>/, ${SO_CHOT_FILES[0]}, ${ROADMAP_REL} (+ docs/ROADMAP-luu-tru.md nếu có hơn 20 mục xong), ${PLAN_REL}, ${JOURNAL_REL}`)
  const featDec = new Set(targets.filter(({ r, t }) => r.loai === 'decisions' && t.target && t.target !== 'chung').map(({ t }) => t.target))
  const nProg = targets.filter(({ r, t }) => r.loai === 'progress' && featDec.has(t.target)).length
  if (nProg) phu.push(`thêm dòng trỏ sổ chốt vào ${nProg} file progress.md (chỉ tính năng có quyết định cũ; progress.md khác giữ nguyên)`)
  if (troSua.length) phu.push(`sửa ${nFile(troSua)} file đang trỏ đường cũ (${troSua.length} chỗ): thay đúng chuỗi cũ → mới ở commit 2`)

  const out = { v: 1, tao_luc: L.vnTime(opts.now ?? Date.now()), tinh_nang, dong: rows, khong_chuyen, tro_cu: tro, can_sua_tay: tay, thay_doi_phu: phu, canh_bao: canh }
  writeJson(root, PLAN_REL, out)
  const hoi = rows.filter((r) => r.can_hoi && r.chon == null)
  return {
    file: PLAN_REL, tong: rows.length, tinh_nang: Object.keys(tinh_nang).length,
    tu_ghep: rows.filter((r) => !r.can_hoi).length, legacy: rows.filter((r) => !r.can_hoi && !r.tinh_nang).length,
    can_hoi: hoi.map((r) => ({ nguon: r.nguon, ung_vien: r.ung_vien ?? [], ung_vien_ly_do: r.ung_vien_ly_do ?? {}, de_xuat: r.de_xuat ?? null, ly_do: r.ly_do })),
    khong_chuyen, tro_cu: { tong: tro.length, se_sua: troSua.length, mau: tro.slice(0, 10) }, can_sua_tay: { tong: tay.length, mau: tay.slice(0, 10) }, thay_doi_phu: phu,
    canh_bao: canh,
  }
}

// ---------- apply ----------

const stagedPaths = (root) => git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z']).stdout.split('\0').filter(Boolean)
const head = (root) => git(root, ['rev-parse', 'HEAD']).stdout.trim()
function commit(root, msg) { git(root, ['commit', '-q', '-m', msg]); return head(root) }

function resolvePlan(root, plan) {
  const what = `bảng ghép ${PLAN_REL}`
  if (!Array.isArray(plan.dong) || !isObj(plan.tinh_nang)) bad(what, 'thiếu dong (mảng) hoặc tinh_nang (object)')
  if (plan.dong.some((r) => !isObj(r) || typeof r.nguon !== 'string')) bad(what, 'có dòng không phải object hoặc nguon không phải chuỗi')
  const errs = []
  const list = []
  for (const r of plan.dong) {
    const t = targetOf(r, plan.tinh_nang)
    if (t.err) errs.push(`${r.nguon}: ${t.err}`)
    else list.push({ r, target: t.target })
  }
  if (errs.length) throw new Error(`bảng chưa duyệt xong (${errs.length} dòng; sửa trong ${PLAN_REL}): ${errs.slice(0, 5).join(' | ')}${errs.length > 5 ? ' | …' : ''}`)
  const dest = allocate(list.map(({ r, target }) => ({ nguon: r.nguon, loai: r.loai, target })), plan.tinh_nang)
  // R1: quy bảng ra dạng nhật ký rồi kiểm MỌI đường dẫn / băm / thư mục tính năng của cả bảng trước khi đụng tới đĩa hay git.
  const nguon = {}
  for (const { r, target } of [...list].sort((a, b) => (a.r.nguon < b.r.nguon ? -1 : 1))) {
    const tn = target === 'chung' || target === 'legacy' ? null : target
    nguon[r.nguon] = { sha: r.sha, loai: r.loai, pham_vi: target === 'chung' ? 'chung' : target === 'legacy' ? null : plan.tinh_nang[target].thu_muc, tn, dich: dest.get(r.nguon), luc: r.luc }
  }
  checkNguon(root, nguon, what)
  // FC1: file chưa theo dõi mà nguồn/đích nằm trong vùng .gitignore thì git add sẽ từ chối, và ta không bao giờ ép (-f) ⇒ dừng trước khi đổi gì.
  const tracked = trackedUnder(root, WATCH)
  const ign = ignoredSet(root, list.filter(({ r }) => !tracked.has(r.nguon)).flatMap(({ r }) => [r.nguon, dest.get(r.nguon)]))
  if (ign.size) throw new Error(`${ign.size} file bị git bỏ qua (.gitignore), không chuyển được vì không ép add (-f): ${[...ign].slice(0, 3).join(', ')}; sửa .gitignore hoặc chạy lại plan`)
  for (const [rel, e] of Object.entries(nguon)) {
    if (!isFile(root, rel)) throw new Error(`thiếu file nguồn ${rel}: chạy lại plan`)
    if (sha1(readRaw(root, rel)) !== e.sha) throw new Error(`${rel} đã đổi sau khi lập bảng: chạy lại plan (lời đã trả lời được giữ)`)
  }
  return nguon
}

// Dòng trỏ sổ chốt chèn ngay sau tiêu đề # của progress.md (không đụng dòng khác); đã có ⇒ giữ nguyên.
function withPointer(raw, line) {
  if (POINTER_RE.test(raw)) return raw
  const bom = raw.startsWith('﻿')
  const t = bom ? raw.slice(1) : raw
  const eol = t.includes('\r\n') ? '\r\n' : '\n'
  const lines = t.split(/\r?\n/)
  const h = lines.findIndex((l) => /^#[ \t]/.test(l))
  lines.splice(h >= 0 && h < 10 ? h + 1 : 0, 0, line)
  return (bom ? '﻿' : '') + lines.join(eol)
}
const stripPointer = (raw) => raw.replace(/^Sổ chốt \(chuyển từ sổ cũ\):.*(\r?\n|$)/mu, '')

export function apply(projectRoot, opts = {}) {
  const root = openRoot(projectRoot)
  const step = (name) => opts.onBuoc?.(name)
  needIdentity(root) // FC7: trước khi đổi bất cứ gì
  let J = readJson(root, JOURNAL_REL)
  const fresh = !J
  if (fresh) {
    const p = readJson(root, PLAN_REL)
    if (!p) throw new Error(`chưa có bảng ghép: chạy plan trước (${PLAN_REL})`)
    if (!p.dong?.length) throw new Error('bảng ghép rỗng: không có gì để chuyển')
    J = { v: 1, tao_luc: L.vnTime(opts.now ?? Date.now()), commit1: null, nguon: resolvePlan(root, p), y: {}, sua_tro: [] } // resolvePlan đã kiểm bảng (R1)
  } else checkJournal(root, J) // R1/R2: nhật ký có sẵn trong repo là dữ liệu không đáng tin, kiểm hết trước khi dùng
  checkIgnored(root, J) // R3
  const rels = Object.keys(J.nguon)
  const moveSet = new Set(rels.flatMap((r) => [r, J.nguon[r].dich]))
  const staged0 = stagedPaths(root)
  const suaTro = new Set(J.sua_tro ?? [])
  const ours = (p) => moveSet.has(p) || suaTro.has(p) || p.startsWith('.claude/so-chot/') || p.startsWith('docs/ROADMAP') || p === '.gitattributes'
  const foreign = staged0.filter((p) => !ours(p))
  if (foreign.length) throw new Error(`index git đang có file ngoài việc chuyển (${foreign.slice(0, 3).join(', ')}): commit hoặc bỏ stage trước`)
  // R4: lần đầu mà index đã có file stage (kể cả .gitattributes, ROADMAP… thuộc loại "của việc chuyển") thì commit 1 không còn toàn git mv: file đó rơi vào commit 1 hoặc cuốn git mv sang commit 2.
  if (fresh && staged0.length) throw new Error(`index git đang có file đã stage (${staged0.slice(0, 3).join(', ')}): commit hoặc bỏ stage trước khi chuyển lần đầu (chưa đổi gì)`)
  if (fresh) writeJson(root, JOURNAL_REL, J)

  // ---- bước 1: git mv nguyên trạng ----
  const tracked = trackedUnder(root, WATCH)
  let moved = 0
  for (const [i, rel] of rels.entries()) {
    const e = J.nguon[rel]
    const hasSrc = isFile(root, rel)
    const hasDst = isFile(root, e.dich)
    if (e.loai === 'roadmap_cu' && hasDst) continue // đã dời; docs/ROADMAP.md bây giờ là bản mới do so-chot sinh, không phải nguồn
    if (hasSrc && hasDst) throw new Error(`đích đã có file khác: ${e.dich} (nguồn ${rel}); đổi tên hoặc xoá file đích rồi chạy lại`)
    if (!hasSrc && !hasDst) throw new Error(`mất cả nguồn lẫn đích: ${rel} → ${e.dich}`)
    if (!hasSrc) continue
    if (sha1(readRaw(root, rel)) !== e.sha) throw new Error(`${rel} đã đổi sau khi lập bảng: chạy lại plan`)
    step(`mv:${i}`)
    fs.mkdirSync(path.dirname(abs(root, e.dich)), { recursive: true })
    if (tracked.has(rel)) git(root, ['mv', '--', rel, e.dich])
    else { fs.renameSync(abs(root, rel), abs(root, e.dich)); git(root, ['add', '--', e.dich]) }
    moved++
  }
  const staged1 = stagedPaths(root)
  if (J.commit1 == null && staged1.length) {
    const other = staged1.filter((p) => !moveSet.has(p)) // R4: bị ngắt giữa chừng rồi người dùng stage thêm ⇒ không để git mv rơi sang commit 2
    if (other.length) throw new Error(`index git có file ngoài việc dời (${other.slice(0, 3).join(', ')}): commit hoặc bỏ stage trước`)
    step('commit1')
    J.commit1 = commit(root, `chuyển sổ cũ (1/2): git mv nguyên trạng ${rels.length} file vào docs/specs và docs/legacy`)
    writeJson(root, JOURNAL_REL, J)
  }

  // ---- bước 2: chuyển nội dung ----
  const known = new Map()
  for (const d of L.scan(root).decisions) {
    const m = MARKER_RE.exec(d.than ?? '')
    if (m && d.ai_quyet === AI_QUYET) known.set(m[1], d)
  }
  let created = 0
  let adopted = 0
  let n = 0
  for (const rel of rels) {
    const e = J.nguon[rel]
    if (e.loai !== 'decisions') continue
    const raw = readRaw(root, e.dich)
    if (sha1(raw) !== e.sha) throw new Error(`${e.dich} đã đổi sau khi lập bảng: chạy lại từ plan`)
    const { items } = parseItems(raw.toString('utf8'))
    step(`ghi:${n++}`)
    const key = keyOfFile(rel, e.sha)
    const have = known.get(key)
    if (have && have.pham_vi === e.pham_vi) { J.y[key] = { ma: have.ma, file: have.file, pham_vi: e.pham_vi }; adopted++; continue }
    const d = L.ghi(root, {
      tom_tat: tomTatFile(e, rel, items, soFile(J, e)), slug: slugFile(e, rel, soFile(J, e)), pham_vi: e.pham_vi, ai_quyet: AI_QUYET, luc: e.luc,
      vi_sao: viSaoFile(e, rel, items, key),
    }, { write: false, gitattributes: false })
    J.y[key] = { ma: d.ma, file: d.file, pham_vi: e.pham_vi }
    created++
    writeJson(root, JOURNAL_REL, J)
  }

  // ---- FC4: thay đúng chuỗi đường dẫn cũ → mới trong file đã theo dõi đang trỏ tới, kể cả file vừa dời (trừ file decisions: giữ nguyên byte;
  //      sổ chốt; file người dùng đang sửa dở chưa commit) ----
  step('tro')
  const olds = new Map(rels.filter((r) => r !== ROADMAP_REL).map((r) => [r, J.nguon[r].dich])) // docs/ROADMAP.md: đường đó giờ là ROADMAP mới do so-chot sinh
  const decDest = new Set(rels.filter((r) => J.nguon[r].loai === 'decisions').map((r) => J.nguon[r].dich))
  const nguonOfDest = new Map(rels.map((r) => [J.nguon[r].dich, r]))
  const troBoQua = []
  if (olds.size) {
    const re = refRegex(olds)
    const dirty = new Set(git(root, ['diff', '--name-only', '-z']).stdout.split('\0').filter(Boolean))
    const todo = []
    for (const { rel, text } of trackedTexts(root, decDest)) {
      if (!AUTO_RE.test(rel)) continue // R11: chỉ .md/.txt được tự sửa; file text khác để người dùng sửa tay (plan/verify liệt kê)
      const next = replaceRefs(text, re, olds)
      if (next === text) continue
      if (dirty.has(rel) && !suaTro.has(rel)) troBoQua.push(rel) // đang có sửa chưa commit của người dùng: không sửa, không cuốn vào commit
      else todo.push({ rel, next })
    }
    if (todo.length) {
      for (const x of todo) if (nguonOfDest.has(x.rel)) J.nguon[nguonOfDest.get(x.rel)].sha_sau = sha1(Buffer.from(x.next))
      J.sua_tro = [...new Set([...suaTro, ...todo.map((x) => x.rel)])]
      writeJson(root, JOURNAL_REL, J) // ghi nhật ký TRƯỚC khi sửa: bị ngắt giữa chừng thì lần sau vẫn nhận các file đã sửa là của việc chuyển
      for (const x of todo) fs.writeFileSync(abs(root, x.rel), x.next)
    }
  }
  step('tro-xong')
  step('progress')
  const soY = {}
  for (const y of Object.values(J.y)) soY[y.pham_vi] = (soY[y.pham_vi] ?? 0) + 1
  const progressSua = []
  for (const rel of rels) {
    const e = J.nguon[rel]
    if (e.loai !== 'progress' || !e.pham_vi || !soY[e.pham_vi]) continue
    const raw = readRaw(root, e.dich).toString('utf8')
    const next = withPointer(raw, `Sổ chốt (chuyển từ sổ cũ): .claude/so-chot/${e.pham_vi}/ — ${soY[e.pham_vi]} điều ⚠️ chờ xem lại`)
    if (next !== raw) { fs.writeFileSync(abs(root, e.dich), next); progressSua.push(e.dich) }
  }
  step('journal')
  writeJson(root, JOURNAL_REL, J)
  L.ensureGitattributes(root)
  step('write')
  const wr = L.write(root)

  const add = [JOURNAL_REL, PLAN_REL, '.gitattributes', ...SO_CHOT_FILES, ...Object.values(J.y).map((y) => `.claude/so-chot/${y.file}`), ...(J.sua_tro ?? []),
    ...rels.filter((r) => J.nguon[r].loai === 'progress').map((r) => J.nguon[r].dich)].filter((p) => isFile(root, p))
  git(root, ['add', '--', ...add])
  const staged2 = stagedPaths(root)
  const out = { commit1: J.commit1, commit2: null, di_chuyen: moved, quyet_dinh_moi: created, quyet_dinh_nhan_lai: adopted, progress_sua: progressSua.length, tro_cu_sua: J.sua_tro ?? [], tro_cu_bo_qua: troBoQua }
  if (wr.bo_qua?.length) out.canh_bao = wr.bo_qua.map((b) => `${b.file}: ${oneLine(b.ly_do, 160)}`)
  if (staged2.length) {
    const allowed = new Set([...add, ...moveSet])
    const bad = staged2.filter((p) => !allowed.has(p))
    if (bad.length) throw new Error(`index git có file ngoài việc chuyển (${bad.slice(0, 3).join(', ')}): commit hoặc bỏ stage trước`)
    step('commit2')
    out.commit2 = commit(root, `chuyển sổ cũ (2/2): ${Object.keys(J.y).length} quyết định ⚠️ chờ xem lại, progress.md, INDEX/ROADMAP`)
  }
  out.da_xong = out.commit2 === null && moved === 0 && created === 0
  return out
}

// ---------- verify ----------

export function verify(projectRoot) {
  const root = openRoot(projectRoot)
  const J = readJson(root, JOURNAL_REL)
  if (!J) throw new Error(`chưa chuyển (không có ${JOURNAL_REL}): chạy apply trước`)
  checkJournal(root, J) // R1/R2: nhật ký là dữ liệu repo, kiểm trước khi đưa bất cứ chuỗi nào cho fs/git
  const loi = []
  const canh = []
  const sc = L.scan(root)
  const byKey = new Map()
  for (const d of sc.decisions) {
    if (d.ai_quyet !== AI_QUYET) continue
    const m = MARKER_RE.exec(d.than ?? '')
    if (!m) { loi.push({ loai: 'mo_coi', file: d.file, ly_do: 'quyết định chuyển từ sổ cũ nhưng không có băm nguồn' }); continue }
    byKey.set(m[1], [...(byKey.get(m[1]) ?? []), d])
  }
  for (const l of sc.loi.filter((x) => ['hong', 'pham-vi', 'trung-ma'].includes(x.loai))) canh.push(`sổ chốt: ${oneLine(l.msg, 140)}`)
  // FC5: đối chiếu THEO FILE decisions nguồn: bản gốc còn nguyên, đúng một quyết định, đúng phạm vi, đúng nội dung (tóm tắt + thân).
  const seen = new Set()
  let nguonDec = 0
  let soY = 0
  for (const [rel, e] of Object.entries(J.nguon)) {
    if (e.loai !== 'roadmap_cu' && isFile(root, rel)) loi.push({ loai: 'nguon_con_lai', nguon: rel, ly_do: 'file nguồn vẫn còn ở chỗ cũ (chưa dời)' })
    if (!isFile(root, e.dich)) { loi.push({ loai: 'mat_file', nguon: rel, dich: e.dich }); continue }
    const raw = readRaw(root, e.dich)
    if (e.loai !== 'decisions') {
      const cur = e.loai === 'progress' ? sha1(Buffer.from(stripPointer(raw.toString('utf8')))) : sha1(raw)
      if (cur !== (e.sha_sau ?? e.sha)) canh.push(`${e.dich} khác bản gốc (đã sửa sau khi chuyển?)`)
      continue
    }
    nguonDec++
    const doi = sha1(raw) !== e.sha
    if (doi) loi.push({ loai: 'nguon_doi', nguon: rel, dich: e.dich, ly_do: 'file decisions đã đổi sau khi chuyển: quyết định đã chuyển có thể không còn khớp' })
    const { items } = parseItems(raw.toString('utf8'))
    soY += items.length
    const key = keyOfFile(rel, e.sha)
    const ref = { nguon: rel, dich: e.dich }
    const hits = byKey.get(key) ?? []
    if (!hits.length) { loi.push({ loai: 'thieu', ...ref }); continue }
    seen.add(key)
    if (hits.length > 1) loi.push({ loai: 'nhan_doi', ...ref, file: hits.map((d) => d.file) })
    const d = hits[0]
    if (d.pham_vi !== e.pham_vi) loi.push({ loai: 'sai_pham_vi', ...ref, mong_doi: e.pham_vi, thuc_te: d.pham_vi, file: d.file })
    if (!doi) {
      const tt = L.cutWords(oneLine(tomTatFile(e, rel, items, soFile(J, e))), 200)
      if (d.tom_tat !== tt || !norm(d.than).includes(norm(viSaoFile(e, rel, items, key)))) loi.push({ loai: 'sai_noi_dung', ...ref, file: d.file })
    }
    if (d.trang_thai === 'dang-dung' && !d.sua_luc) loi.push({ loai: 'khong_cho_xem', ...ref, file: d.file, ly_do: 'quyết định chuyển từ sổ cũ phải ⚠️ chờ xem lại' })
  }
  for (const [key, ds] of byKey) if (!seen.has(key)) for (const d of ds) loi.push({ loai: 'mo_coi', file: d.file, ly_do: 'không ứng với file decisions nào trong nguồn' })

  // FC4: còn chỗ nào (file đã theo dõi, không phải file decisions đã dời / sổ chốt) trỏ tới đường dẫn cũ?
  // R11: .md/.txt còn chỗ trỏ cũ ⇒ lỗi (apply tự sửa được); file text khác và chỗ nhắc cả thư mục ⇒ "cần sửa tay": cảnh báo, KHÔNG làm verify đỏ.
  const olds = new Map(Object.entries(J.nguon).filter(([r]) => r !== ROADMAP_REL).map(([r, e]) => [r, e.dich]))
  const decDestV = new Set(Object.values(J.nguon).filter((e) => e.loai === 'decisions').map((e) => e.dich))
  const conTro = new Map()
  const tay = []
  const reV = olds.size ? refRegex(olds) : null
  for (const { rel, text } of trackedTexts(root, decDestV)) {
    if (reV && AUTO_RE.test(rel)) { const hs = findRefs(rel, text, reV, olds, true); if (hs.length) conTro.set(rel, hs) }
    tay.push(...findManual(rel, text, reV, olds))
  }
  for (const [file, hs] of [...conTro].slice(0, 20)) loi.push({ loai: 'tro_duong_cu', file, so_cho: hs.length, dong: hs[0].dong, cu: hs[0].cu, moi: hs[0].moi })
  if (conTro.size > 20) canh.push(`còn ${conTro.size - 20} file nữa trỏ tới đường dẫn cũ (chỉ liệt kê 20 file đầu)`)
  if (tay.length) canh.push(canhTay(tay))

  // 2 commit tách: commit 1 chỉ gồm đổi tên (R100) / thêm file nguồn chưa theo dõi; commit 2 không xoá/đổi tên gì.
  const srcs = new Set(Object.keys(J.nguon))
  const moveSet = new Set([...srcs, ...Object.values(J.nguon).map((e) => e.dich)])
  // R2: `h` luôn là mã hex đã kiểm (checkJournal) hoặc mã do git trả; vẫn đặt sau --end-of-options để không bao giờ bị hiểu là tuỳ chọn (vd --output=<tệp>).
  const nameStatus = (h) => git(root, ['show', '--name-status', '--format=', '-M', '--end-of-options', h], { allowFail: true })
  const commitExists = (h) => git(root, ['cat-file', '-e', '--end-of-options', `${h}^{commit}`], { allowFail: true }).status === 0
  if (J.commit1) {
    const r = commitExists(J.commit1) ? nameStatus(J.commit1) : null
    if (!r || r.status !== 0) canh.push('commit 1 không còn trong lịch sử (rebase/squash?), bỏ qua kiểm tra tách commit')
    else {
      for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
        const [st, ...ps] = line.split('\t')
        if (!(st === 'R100' || st === 'A' || (st === 'D' && srcs.has(ps[0]))) || ps.some((p) => !moveSet.has(p))) loi.push({ loai: 'commit1_khong_sach', dong: oneLine(line, 160) })
      }
    }
  }
  const c2 = git(root, ['log', '--diff-filter=A', '-n1', '--format=%H', '--', JOURNAL_REL], { allowFail: true }).stdout.trim()
  if (c2) {
    for (const line of nameStatus(c2).stdout.split(/\r?\n/).filter(Boolean)) {
      if (/^[RD]/.test(line)) loi.push({ loai: 'commit2_co_doi_ten', dong: oneLine(line, 160) })
    }
  } else canh.push('chưa thấy commit 2 (nhật ký chưa được commit)')

  const dichQd = [...byKey.values()].reduce((s, ds) => s + ds.length, 0)
  return { ok: loi.length === 0, nguon_decisions: nguonDec, dich_quyet_dinh: dichQd, so_y: soY, tong_file: Object.keys(J.nguon).length, loi, canh_bao: canh, can_sua_tay: { tong: tay.length, mau: tay.slice(0, 20) } }
}

// ---------- CLI ----------

function runCli(argv) {
  const [cmd, root] = argv
  try {
    if (!['plan', 'apply', 'verify'].includes(cmd) || !root) throw new Error('dùng: legacy-migrate.mjs <plan|apply|verify> <projectRoot>')
    const r = { plan, apply, verify }[cmd](root)
    process.stdout.write(`${JSON.stringify(r)}\n`)
    if (cmd === 'verify' && !r.ok) process.exitCode = 1
  } catch (e) {
    process.stderr.write(`lỗi: ${oneLine(e?.message ?? e, 400)}\n`)
    process.exitCode = 1
  }
}

try {
  if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) runCli(process.argv.slice(2))
} catch {}
