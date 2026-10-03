// Test cho lib/so-chot.mjs: node --test ~/.claude/hooks/lib/so-chot.test.mjs
// Mọi thứ chạy trong os.tmpdir: repo tạm + HOME/USERPROFILE giả (cache ~/.claude/cache/so-chot nằm trong HOME giả); không đọc/ghi ~/.claude thật.
// AC2/AC9 dùng git thật (hai worktree, merge=union). Giờ VN cố định bằng tham số `now`.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'so-chot-test-')))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME)
process.env.HOME = HOME
process.env.USERPROFILE = HOME
if (path.resolve(os.homedir()) !== path.resolve(HOME)) throw new Error(`HOME giả không có hiệu lực (${os.homedir()}): dừng để khỏi đụng ~/.claude thật`)

const L = await import('./so-chot.mjs')
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'so-chot.mjs')
const CACHE_DIR = path.join(HOME, '.claude', 'cache', 'so-chot')
const MODS_DIR = path.join(HOME, '.claude', 'mods', 'so-chot')

const GITCONF = path.join(TMP, 'gitconfig')
fs.writeFileSync(GITCONF, '[user]\n\tname = t\n\temail = t@t.t\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n')
const GENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: GITCONF, GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: GENV })
function gitOk(cwd, ...args) {
  const r = git(cwd, ...args)
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}${r.stdout}`)
  return r.stdout
}

after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

let seq = 0
function repo(name = 'repo') {
  const dir = path.join(TMP, `${name}-${++seq}`)
  fs.mkdirSync(dir, { recursive: true })
  gitOk(dir, 'init', '-q', '-b', 'main')
  return fs.realpathSync(dir)
}
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (root, rel) => fs.existsSync(path.join(root, rel))
const INDEX = '.claude/so-chot/INDEX.md'
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex')

// Thư mục tính năng + progress.md (ageDays: lùi mtime).
function spec(root, name, progress = 'Trạng thái: đang làm\n', ageDays = 0) {
  const f = write(root, `docs/specs/${name}/progress.md`, progress)
  const t = new Date(Date.now() - ageDays * 86400000)
  fs.utimesSync(f, t, t)
  return f
}

// Đặt thẳng một file quyết định (không qua ghi(): nhanh cho fixture lớn, hoặc để dựng file hỏng/lạ).
function plant(root, d = {}) {
  const ma = d.ma ?? L.newMa()
  const dec = {
    ma, tom_tat: d.tom_tat ?? `Điều ${ma}`, pham_vi: d.pham_vi ?? 'chung', trang_thai: d.trang_thai ?? 'dang-dung',
    luc: d.luc ?? '2026-10-01 10:00', ai_quyet: d.ai_quyet ?? 'ban', ...(d.thay_cho ? { thay_cho: d.thay_cho } : {}),
  }
  dec.file = `${dec.pham_vi}/${ma}-${L.slugOf(dec.tom_tat)}.md`
  write(root, `.claude/so-chot/${dec.file}`, L.renderDecision(dec, { vi_sao: d.vi_sao ?? 'vì sao', ap_dung: d.ap_dung ?? 'áp dụng', da_can_nhac: d.da_can_nhac ?? [] }))
  return dec
}

// Ảnh chụp mọi file (trừ .git): đường dẫn → size:mtime:băm.
function snap(root) {
  const out = {}
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      if (n === '.git') continue
      const p = path.join(d, n)
      if (fs.lstatSync(p).isDirectory()) walk(p)
      else out[path.relative(root, p).replace(/\\/g, '/')] = `${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}:${sha(fs.readFileSync(p))}`
    }
  }
  walk(root)
  return out
}

// Symlink/junction có thể bị cấm trên Windows (file symlink cần Developer Mode); junction thư mục thì không cần quyền.
function link(t, target, at, type) {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  try { fs.symlinkSync(target, at, type); return true } catch (e) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e
    t.skip(`không tạo được symlink (${e.code})`)
    return false
  }
}

const sections = (text) => text.split('\n\n')
const section = (text, startsWith) => sections(text).find((s) => s.startsWith(startsWith))
const T_VN = Date.UTC(2026, 9, 2, 9, 41) // 2026-10-02 16:41 giờ VN

describe('AC1 định dạng quyết định', () => {
  test('ghi tạo đúng một file trong thư mục phạm vi: front matter + Vì sao/Áp dụng/Đã cân nhắc; slug tiếng Việt; giờ VN', () => {
    const root = repo()
    const d = L.ghi(root, { tom_tat: 'Dùng pnpm thay npm', vi_sao: 'Nhanh hơn', ap_dung: 'Mọi lệnh cài gói', da_can_nhac: ['yarn: chậm hơn'], ai_quyet: 'ban' }, { now: T_VN })
    assert.match(d.ma, /^[a-z0-9]{8}$/)
    assert.equal(d.file, `chung/${d.ma}-dung-pnpm-thay-npm.md`)
    assert.equal(d.luc, '2026-10-02 16:41')
    assert.equal(d.trang_thai, 'dang-dung')
    assert.deepEqual(fs.readdirSync(path.join(root, '.claude/so-chot')).sort(), ['INDEX.md', 'chung'])
    assert.deepEqual(fs.readdirSync(path.join(root, '.claude/so-chot/chung')), [`${d.ma}-dung-pnpm-thay-npm.md`])
    const text = read(root, `.claude/so-chot/${d.file}`)
    for (const line of [`ma: ${d.ma}`, 'tom_tat: "Dùng pnpm thay npm"', 'pham_vi: chung', 'trang_thai: dang-dung', 'luc: 2026-10-02 16:41', 'ai_quyet: ban']) {
      assert.ok(text.split('\n').includes(line), line)
    }
    assert.ok(!/^thay_cho:/m.test(text) && !/^lien_quan:/m.test(text) && !/^sua_luc:/m.test(text))
    assert.match(text, /## Vì sao\nNhanh hơn\n\n## Áp dụng thế nào\nMọi lệnh cài gói\n\n## Đã cân nhắc\n- yarn: chậm hơn\n/)
    const p = L.parseDecision(text, d.file)
    assert.equal(p.ma, d.ma)
    assert.equal(p.tom_tat, 'Dùng pnpm thay npm')
  })

  test('giờ luôn là giờ VN (UTC+7), qua nửa đêm đổi ngày, không phụ thuộc múi giờ máy', () => {
    assert.equal(L.vnTime(T_VN), '2026-10-02 16:41')
    assert.equal(L.vnTime(Date.UTC(2026, 9, 2, 20, 30)), '2026-10-03 03:30')
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { vnTime } from ${JSON.stringify(new URL(`file:///${SCRIPT.replace(/\\/g, '/')}`).href)}; process.stdout.write(vnTime(${Date.UTC(2026, 9, 2, 20, 30)}))`],
      { encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' } })
    assert.equal(r.stdout, '2026-10-03 03:30', r.stderr)
    const root = repo()
    assert.equal(L.ghi(root, { tom_tat: 'x' }, { now: Date.UTC(2026, 9, 2, 20, 30) }).luc, '2026-10-03 03:30')
  })

  test('slug ASCII ≤ 6 từ, tom_tat giữ nguyên dấu; tiêu đề rất dài không làm tên file dài', () => {
    assert.equal(L.slugOf('Đổi cách tính tiền cho khách hàng thân thiết ở màn hình thanh toán'), 'doi-cach-tinh-tien-cho-khach')
    assert.equal(L.slugOf('!!! ???'), 'quyet-dinh')
    assert.ok(L.slugOf('Ă'.repeat(300)).length <= 48)
    const root = repo()
    const long = 'Đường dẫn thật dài '.repeat(30)
    const d = L.ghi(root, { tom_tat: long })
    assert.ok(path.basename(d.file).length < 80)
    assert.ok(d.tom_tat.length <= 200)
  })

  test('FA3 oneLine bỏ ký tự đổi chiều chữ (U+200E/F, U+202A–E, U+2066–9); ký tự điều khiển C0 vẫn thành dấu cách', () => {
    assert.equal(L.oneLine('a‮b'), 'ab')
    assert.equal(L.oneLine('x‎‏y‪‫‬‭‮z⁦⁧⁨⁩w'), 'xyzw')
    assert.equal(L.oneLine('a\u0000b\nc'), 'a b c')
    assert.equal(L.oneLine('אבג 😀 ok'), 'אבג 😀 ok') // chữ RTL thật và emoji giữ nguyên
    const bidi = /[‎‏‪-‮⁦-⁩]/
    const root = repo()
    const d = L.ghi(root, { tom_tat: 'Luật ‮đảo‬ chiều ⁦x⁩', vi_sao: 'v' })
    assert.equal(d.tom_tat, 'Luật đảo chiều x')
    assert.ok(!bidi.test(L.excerpt(root, { coMod: false })))
    assert.ok(!bidi.test(read(root, `.claude/so-chot/${d.file}`).split('## Vì sao')[0]))
    assert.ok(!bidi.test(L.render(root).index))
  })

  test('FA3 vi_sao / ap_dung / da_can_nhac giới hạn 8 KB mỗi trường, cắt thì ghi "…(đã cắt)"; vừa đúng 8 KB thì giữ nguyên', () => {
    const root = repo()
    const big = 'Lý do rất dài, tiếng Việt có dấu. '.repeat(10000) // ~340 KB
    const d = L.ghi(root, { tom_tat: 'Thân dài', vi_sao: big, ap_dung: big, da_can_nhac: Array.from({ length: 3000 }, (_, i) => `Phương án ${i}: ${'x'.repeat(40)}`) })
    const text = read(root, `.claude/so-chot/${d.file}`)
    assert.ok(Buffer.byteLength(text) < 3 * 8192 + 1024, `file ${Buffer.byteLength(text)} byte`)
    const field = (head, next) => text.split(`## ${head}\n`)[1].split(next)[0].trimEnd()
    const fields = [field('Vì sao', '\n\n## Áp dụng'), field('Áp dụng thế nào', '\n\n## Đã cân nhắc'), field('Đã cân nhắc', '\n\n\n')]
    for (const f of fields) {
      assert.ok(Buffer.byteLength(f) <= 8192, `${Buffer.byteLength(f)} byte`)
      assert.ok(f.endsWith('…(đã cắt)'))
      assert.ok(!f.includes('�'), 'không cắt giữa ký tự')
    }
    assert.ok(L.parseDecision(text, d.file).than.includes('## Đã cân nhắc'))
    const exact = L.ghi(root, { tom_tat: 'Vừa đủ', vi_sao: 'a'.repeat(8192), ap_dung: 'a'.repeat(8193) })
    const t2 = read(root, `.claude/so-chot/${exact.file}`)
    assert.ok(t2.includes(`## Vì sao\n${'a'.repeat(8192)}\n\n`))
    assert.ok(!t2.includes('a'.repeat(8193)) && t2.includes('…(đã cắt)'))
  })

  test('FA5 tom_tat dài bị cắt ở ranh giới từ + "…", không cắt giữa từ', () => {
    const root = repo()
    const d = L.ghi(root, { tom_tat: 'điều '.repeat(100) })
    assert.ok(d.tom_tat.length <= 200 && d.tom_tat.endsWith('…'))
    assert.ok(d.tom_tat.slice(0, -1).split(' ').every((w) => w === 'điều'), d.tom_tat)
    assert.equal(L.cutWords('ngắn thôi', 50), 'ngắn thôi')
    assert.equal(L.cutWords('một hai ba bốn năm', 12), 'một hai ba…')
    assert.equal(L.cutWords('x'.repeat(30), 10), `${'x'.repeat(9)}…`) // không có dấu cách để cắt ⇒ cắt cứng
  })

  test('phạm vi tính năng: file nằm trong thư mục tính năng', () => {
    const root = repo()
    spec(root, '2026-10-02-feat-a')
    const d = L.ghi(root, { tom_tat: 'Chọn Postgres', pham_vi: '2026-10-02-feat-a' })
    assert.equal(d.file, `2026-10-02-feat-a/${d.ma}-chon-postgres.md`)
    assert.ok(exists(root, `.claude/so-chot/${d.file}`))
  })

  test('parseDecision/renderDecision khứ hồi với dấu nháy, hai chấm, lien_quan, thay_cho, sua_luc, CRLF và BOM', () => {
    const d = { ma: 'abcd1234', tom_tat: 'Dùng "pnpm": nhanh hơn', pham_vi: 'chung', trang_thai: 'cho-xem', luc: '2026-10-02 16:41', ai_quyet: 'tu-chon-khi-vang', thay_cho: 'efgh5678', lien_quan: ['aaaa1111', 'bbbb2222'], sua_luc: '2026-10-03 08:00', file: 'chung/abcd1234-x.md' }
    const text = L.renderDecision(d, { vi_sao: 'v', ap_dung: 'a', da_can_nhac: ['p1', 'p2'] })
    const p = L.parseDecision(text, d.file)
    for (const k of Object.keys(d)) assert.deepEqual(p[k], d[k], k)
    assert.match(p.than, /## Đã cân nhắc\n- p1\n- p2/)
    assert.equal(L.parseDecision(`\uFEFF${text.replace(/\n/g, '\r\n')}`, d.file).tom_tat, d.tom_tat)
  })

  test('parseDecision báo { loi } cho front matter hỏng, không ném', () => {
    const ok = L.renderDecision({ ma: 'abcd1234', tom_tat: 't', pham_vi: 'chung', trang_thai: 'dang-dung', luc: '2026-10-02 16:41', ai_quyet: 'ban' })
    const cases = {
      'không front matter': 'xin chào',
      'không đóng': '---\nma: abcd1234\n',
      'thiếu ma': ok.replace(/^ma: .*\n/m, ''),
      'ma hỏng': ok.replace('ma: abcd1234', 'ma: AB'),
      'trang_thai lạ': ok.replace('trang_thai: dang-dung', 'trang_thai: huy'),
      'luc hỏng': ok.replace('luc: 2026-10-02 16:41', 'luc: hôm qua'),
      'dòng rác': ok.replace('ai_quyet: ban', 'rác không có hai chấm'),
      'tom_tat rỗng': ok.replace('tom_tat: "t"', 'tom_tat: ""'),
      rỗng: '',
    }
    for (const [name, text] of Object.entries(cases)) {
      const r = L.parseDecision(text, 'chung/x.md')
      assert.equal(typeof r.loi, 'string', name)
      assert.equal(r.file, 'chung/x.md')
    }
  })
})

describe('AC2/AC9 hai nhánh cùng ghi rồi gộp bằng git thật', () => {
  const commit = (cwd, msg) => { gitOk(cwd, 'add', '-A'); gitOk(cwd, 'commit', '-qm', msg) }
  const noMarkers = (text) => assert.ok(!/^(<{7}|={7}|>{7})/m.test(text), 'còn dấu xung đột')

  test('hai worktree ghi quyết định + ý tưởng song song: gộp không xung đột, đủ cả hai, mã khác nhau, lần sinh kế tiếp ra bản sạch', () => {
    const main = repo('ac2')
    const base = L.ghi(main, { tom_tat: 'Điều gốc' }, { now: T_VN })
    commit(main, 'base')
    const wt1 = path.join(TMP, 'ac2-wt1')
    const wt2 = path.join(TMP, 'ac2-wt2')
    gitOk(main, 'worktree', 'add', '-q', '-b', 'b1', wt1)
    gitOk(main, 'worktree', 'add', '-q', '-b', 'b2', wt2)
    const a = L.ghi(wt1, { tom_tat: 'Điều từ nhánh một' }, { now: T_VN + 60000 })
    const b = L.ghi(wt2, { tom_tat: 'Điều từ nhánh hai' }, { now: T_VN + 60000 }) // cùng phút, cùng thư mục, cùng dòng INDEX
    L.ghiYTuong(wt1, { loai: 'tính năng', noi_dung: 'Ý tưởng một' })
    L.ghiYTuong(wt2, { loai: 'cải tiến', noi_dung: 'Ý tưởng hai' })
    commit(wt1, 'b1')
    commit(wt2, 'b2')
    assert.notEqual(a.ma, b.ma)
    gitOk(main, 'merge', '-q', 'b1', '-m', 'm1')
    const m = git(main, 'merge', 'b2', '-m', 'm2')
    assert.equal(m.status, 0, m.stdout + m.stderr)
    assert.equal(gitOk(main, 'ls-files', '-u').trim(), '')
    for (const f of [INDEX, 'docs/ROADMAP.md', 'docs/IDEAS.md']) noMarkers(read(main, f))
    // đủ cả hai: file quyết định, dòng ý tưởng, dòng INDEX
    const sc = L.scan(main)
    assert.deepEqual(sc.decisions.map((d) => d.ma).sort(), [base.ma, a.ma, b.ma].sort())
    const idea = read(main, 'docs/IDEAS.md')
    assert.ok(idea.includes('Ý tưởng một') && idea.includes('Ý tưởng hai'))
    const idx = read(main, INDEX)
    assert.ok(idx.includes(`[${a.ma.slice(0, 4)}]`) && idx.includes(`[${b.ma.slice(0, 4)}]`))
    // INDEX sau merge=union (hai nhánh cùng sửa tiêu đề/số đếm) luôn bị báo lệch trong phần nạp (FA2) cho tới khi sinh lại
    assert.ok(L.scan(main).loi.some((l) => l.loai === 'index-lech'))
    assert.match(L.excerpt(main, { coMod: false }), /INDEX lệch nguồn/)
    // lần sinh kế tiếp ra bản sạch, không báo lệch nữa
    L.write(main)
    assert.equal(read(main, INDEX), L.render(main).index)
    assert.equal((read(main, INDEX).match(/^- \[/gm) ?? []).length, 3)
    assert.deepEqual(L.scan(main).loi.filter((l) => l.loai.startsWith('index')), [])
    assert.equal(L.excerpt(main, { coMod: false }).includes('INDEX lệch'), false)
  })

  test('cả hai nhánh cùng TẠO INDEX/ROADMAP/IDEAS từ đầu (add/add) vẫn không xung đột', () => {
    const main = repo('ac9')
    L.ensureGitattributes(main)
    commit(main, 'base')
    gitOk(main, 'branch', 'b1')
    gitOk(main, 'branch', 'b2')
    const wt1 = path.join(TMP, 'ac9-wt1')
    const wt2 = path.join(TMP, 'ac9-wt2')
    gitOk(main, 'worktree', 'add', '-q', wt1, 'b1')
    gitOk(main, 'worktree', 'add', '-q', wt2, 'b2')
    const a = L.ghi(wt1, { tom_tat: 'Một' })
    const b = L.ghi(wt2, { tom_tat: 'Hai' })
    L.ghiYTuong(wt1, { loai: 'tính năng', noi_dung: 'Y1' })
    L.ghiYTuong(wt2, { loai: 'tính năng', noi_dung: 'Y2' })
    commit(wt1, 'b1')
    commit(wt2, 'b2')
    gitOk(main, 'merge', '-q', 'b1', '-m', 'm1')
    const m = git(main, 'merge', 'b2', '-m', 'm2')
    assert.equal(m.status, 0, m.stdout + m.stderr)
    for (const f of [INDEX, 'docs/ROADMAP.md', 'docs/IDEAS.md']) noMarkers(read(main, f))
    assert.deepEqual(L.scan(main).decisions.map((d) => d.ma).sort(), [a.ma, b.ma].sort())
    assert.match(read(main, 'docs/IDEAS.md'), /Y1[\s\S]*Y2|Y2[\s\S]*Y1/)
  })

  test('hai nhánh cùng triển khai MỘT ý tưởng: gộp không xung đột, số ý tưởng vẫn đếm theo mã', () => {
    const main = repo('ac19')
    spec(main, '2026-10-05-a')
    spec(main, '2026-10-06-b')
    const idea = L.ghiYTuong(main, { loai: 'tính năng', noi_dung: 'Xuất PDF' })
    commit(main, 'base')
    const wt1 = path.join(TMP, 'ac19-wt1')
    const wt2 = path.join(TMP, 'ac19-wt2')
    gitOk(main, 'worktree', 'add', '-q', '-b', 'b1', wt1)
    gitOk(main, 'worktree', 'add', '-q', '-b', 'b2', wt2)
    L.suKienYTuong(wt1, idea.ma, { lam: '2026-10-05-a' })
    L.suKienYTuong(wt2, idea.ma, { lam: '2026-10-06-b' })
    commit(wt1, 'b1')
    commit(wt2, 'b2')
    gitOk(main, 'merge', '-q', 'b1', '-m', 'm1')
    const m = git(main, 'merge', 'b2', '-m', 'm2')
    assert.equal(m.status, 0, m.stdout + m.stderr)
    const lines = read(main, 'docs/IDEAS.md').split('\n').filter(Boolean)
    assert.equal(lines.length, 3)
    assert.match(L.render(main).roadmap, /## Ý tưởng \(1 · 0 chưa làm\)/)
  })

  test('mã trùng giả lập khi tạo ⇒ sinh lại, hai file đều còn', () => {
    const root = repo()
    const real = crypto.randomInt
    try {
      crypto.randomInt = () => 5
      const first = L.ghi(root, { tom_tat: 'Một' })
      assert.equal(first.ma, '55555555')
      let n = 0
      crypto.randomInt = () => (n++ < 8 ? 5 : 6) // lần thử đầu trùng '55555555', lần hai '66666666'
      const second = L.ghi(root, { tom_tat: 'Hai' })
      assert.equal(second.ma, '66666666')
    } finally {
      crypto.randomInt = real
    }
    assert.equal(L.scan(root).decisions.length, 2)
  })
})

describe('AC3 mã cố định, tiền tố', () => {
  test('mọi dòng hiển thị kèm mã 4 ký tự; gõ tiền tố chọn được, tiền tố trùng/quá ngắn/không có ⇒ lỗi rõ', () => {
    const root = repo()
    plant(root, { ma: 'abcd1111', tom_tat: 'Điều một', trang_thai: 'cho-xem' })
    plant(root, { ma: 'abcd2222', tom_tat: 'Điều hai', trang_thai: 'cho-xem' })
    plant(root, { ma: 'wxyz3333', tom_tat: 'Điều ba' })
    const idx = L.render(root).index
    for (const m of ['abcd', 'abcd', 'wxyz']) assert.ok(idx.includes(`[${m}](`))
    for (const line of idx.split('\n').filter((l) => l.startsWith('- '))) assert.match(line, /^- \[[a-z0-9]{4}\]\([^)]+\) · (?:\S+ · )?\d{4}-\d{2}-\d{2} · /)
    const ex = L.excerpt(root, { coMod: false })
    assert.ok(ex.split('\n').filter((l) => l.startsWith('- [')).every((l) => /^- \[[a-z0-9]{4}\]/.test(l)))
    assert.ok(L.tim(root, 'điều ba').every((h) => h.dong.startsWith('- [wxyz]')))
    assert.throws(() => L.daXem(root, 'abcd'), /trùng 2 quyết định.*abcd1111.*abcd2222/)
    assert.throws(() => L.daXem(root, 'abc'), /quá ngắn/)
    assert.throws(() => L.daXem(root, 'zzzz'), /không có quyết định/)
    assert.equal(L.daXem(root, 'abcd1').trang_thai, 'dang-dung')
  })
})

describe('AC5 thay quyết định', () => {
  test('chỉ quyết định mới ghi thay_cho; bản cũ ↩️ được suy ra, file cũ không đổi một byte', () => {
    const root = repo()
    const old = L.ghi(root, { tom_tat: 'Dùng npm' })
    const before = fs.readFileSync(path.join(root, '.claude/so-chot', old.file))
    const nu = L.ghi(root, { tom_tat: 'Dùng pnpm', thay_cho: old.ma.slice(0, 6) })
    assert.equal(nu.thay_cho, old.ma)
    assert.deepEqual(fs.readFileSync(path.join(root, '.claude/so-chot', old.file)), before)
    const { decisions, loi } = L.scan(root)
    const o = decisions.find((d) => d.ma === old.ma)
    assert.equal(o.hien, 'da-thay')
    assert.equal(o.trang_thai, 'dang-dung')
    assert.deepEqual(o.thay_boi, [nu.ma])
    assert.equal(decisions.find((d) => d.ma === nu.ma).hien, 'dang-dung')
    assert.deepEqual(loi, [])
    const idx = read(root, INDEX)
    const oldLine = idx.split('\n').find((l) => l.startsWith(`- [${old.ma.slice(0, 4)}]`))
    assert.ok(oldLine.includes('↩️') && oldLine.includes(`(thay bởi [${nu.ma.slice(0, 4)}])`))
    assert.ok(idx.indexOf(oldLine) > idx.indexOf('## Đã cất · đã thay'))
    const ex = L.excerpt(root, { coMod: false })
    assert.ok(ex.includes('Dùng pnpm') && !ex.includes('Dùng npm'))
    assert.ok(!L.tim(root, 'dung npm').some((h) => h.ma === old.ma)) // ↩️ không hiện khi tìm thường
    assert.ok(L.tim(root, 'dung npm', { lichSu: true }).some((h) => h.ma === old.ma))
    assert.throws(() => L.ghi(root, { tom_tat: 'x', thay_cho: 'khongco1' }), /không có quyết định/)
  })

  test('hai quyết định cùng thay một bản ⇒ báo người dùng phân xử, giữ cả hai, không tự chọn', () => {
    const root = repo()
    const old = L.ghi(root, { tom_tat: 'Bản cũ' })
    const c1 = L.ghi(root, { tom_tat: 'Bản mới một', thay_cho: old.ma })
    const c2 = L.ghi(root, { tom_tat: 'Bản mới hai', thay_cho: old.ma })
    const { decisions, loi } = L.scan(root)
    assert.equal(decisions.find((d) => d.ma === old.ma).hien, 'da-thay')
    assert.equal(decisions.find((d) => d.ma === c1.ma).hien, 'dang-dung')
    assert.equal(decisions.find((d) => d.ma === c2.ma).hien, 'dang-dung')
    const w = loi.filter((l) => l.loai === 'hai-ban-thay')
    assert.equal(w.length, 1)
    assert.ok(w[0].msg.includes(old.ma.slice(0, 4)) && w[0].msg.includes(c1.ma.slice(0, 4)) && w[0].msg.includes(c2.ma.slice(0, 4)))
    assert.match(L.excerpt(root, { coMod: false }), /Hai quyết định cùng thay/)
    assert.match(read(root, INDEX), /## Cảnh báo\n- ⚠ Hai quyết định cùng thay/)
  })
})

describe('AC6 tự chọn khi vắng / chuyển từ sổ cũ ⇒ ⚠️', () => {
  test('ai_quyet tu-chon-khi-vang và chuyen-tu-so-cu ⇒ cho-xem (không ép được thành đang dùng); ban/ban-gat ⇒ dang-dung', () => {
    const root = repo()
    assert.equal(L.ghi(root, { tom_tat: 'a', ai_quyet: 'tu-chon-khi-vang' }, { write: false }).trang_thai, 'cho-xem')
    assert.equal(L.ghi(root, { tom_tat: 'b', ai_quyet: 'chuyen-tu-so-cu', trang_thai: 'dang-dung' }, { write: false }).trang_thai, 'cho-xem')
    assert.equal(L.ghi(root, { tom_tat: 'c', ai_quyet: 'ban' }, { write: false }).trang_thai, 'dang-dung')
    assert.equal(L.ghi(root, { tom_tat: 'd', ai_quyet: 'ban-gat' }, { write: false }).trang_thai, 'dang-dung')
    assert.equal(L.ghi(root, { tom_tat: 'e', luc: '2025-01-02 03:04', ai_quyet: 'chuyen-tu-so-cu' }, { write: false }).luc, '2025-01-02 03:04')
    assert.equal(L.scan(root).decisions.filter((d) => d.hien === 'cho-xem').length, 3)
  })

  test('daXem: ⚠️ → ✅ chỉ đổi trang_thai + sua_luc; huy: không xoá file; chạy lại không đổi; đã huỷ không đảo lại được', () => {
    const root = repo()
    const d = L.ghi(root, { tom_tat: 'Chờ xem', ai_quyet: 'tu-chon-khi-vang', vi_sao: 'lý do giữ nguyên' })
    const f = path.join(root, '.claude/so-chot', d.file)
    const before = fs.readFileSync(f, 'utf8')
    const r = L.daXem(root, d.ma.slice(0, 4), { now: T_VN })
    assert.equal(r.trang_thai, 'dang-dung')
    assert.equal(r.sua_luc, '2026-10-02 16:41')
    const after = fs.readFileSync(f, 'utf8')
    assert.equal(after, before.replace('trang_thai: cho-xem', 'trang_thai: dang-dung').replace('\n---\n', '\nsua_luc: 2026-10-02 16:41\n---\n'))
    const snapA = snap(root)
    assert.equal(L.daXem(root, d.ma).trang_thai, 'dang-dung') // lặp lại: không đổi
    assert.deepEqual(snap(root), snapA)
    const h = L.huy(root, d.ma)
    assert.equal(h.trang_thai, 'da-huy')
    assert.ok(fs.existsSync(f))
    assert.throws(() => L.daXem(root, d.ma), /không chuyển được/)
    assert.equal(L.tim(root, 'cho xem').length, 0)
    assert.equal(L.tim(root, 'cho xem', { lichSu: true })[0].dong.includes('✖'), true)
  })
})

describe('AC7 file hỏng / bị xoá', () => {
  test('front matter hỏng ⇒ không chặn phiên; một dòng cảnh báo trong INDEX và trong phần nạp', () => {
    const root = repo()
    const good = plant(root, { tom_tat: 'Luật tốt' })
    write(root, '.claude/so-chot/chung/zzzz9999-hong.md', 'không phải front matter\n')
    write(root, '.claude/so-chot/chung/yyyy8888-thieu.md', '---\nma: yyyy8888\n---\nthiếu trường\n')
    const sc = L.scan(root)
    assert.deepEqual(sc.decisions.map((d) => d.ma), [good.ma])
    const hong = sc.loi.filter((l) => l.loai === 'hong')
    assert.equal(hong.length, 2)
    assert.ok(hong.some((l) => l.msg.includes('chung/zzzz9999-hong.md')))
    const idx = L.render(root).index
    assert.match(idx, /## Cảnh báo\n- ⚠ File quyết định hỏng: chung\/yyyy8888-thieu\.md/)
    assert.ok(idx.includes('chung/zzzz9999-hong.md'))
    const ex = L.excerpt(root, { coMod: false })
    assert.ok(ex.includes('Luật tốt') && ex.includes('File quyết định hỏng'))
  })

  test('file bị xoá: INDEX còn dòng ⇒ cảnh báo; quyết định thay_cho trỏ vào đó ⇒ cảnh báo (bền); write sinh lại', () => {
    const root = repo()
    const a = L.ghi(root, { tom_tat: 'Điều bị xoá' })
    const b = L.ghi(root, { tom_tat: 'Điều thay thế', thay_cho: a.ma })
    fs.rmSync(path.join(root, '.claude/so-chot', a.file))
    const sc = L.scan(root)
    assert.deepEqual(sc.decisions.map((d) => d.ma), [b.ma])
    assert.ok(sc.loi.some((l) => l.loai === 'index-mat' && l.msg.includes(a.file)))
    assert.ok(sc.loi.some((l) => l.loai === 'thay-mat' && l.msg.includes(b.ma.slice(0, 4))))
    const idx = L.render(root).index
    assert.ok(idx.includes('## Cảnh báo') && idx.includes('thay cho mã không còn tồn tại'))
    assert.ok(!idx.includes('đã mất'), 'R5: INDEX mới sinh từ nguồn không còn dòng của file đã mất ⇒ không mang cảnh báo "đã mất" (cảnh báo này chỉ đúng với INDEX CŨ)')
    const ex = L.excerpt(root, { coMod: false })
    assert.ok(ex.includes('đã mất') && ex.includes('Điều thay thế') && !ex.includes('Điều bị xoá'))
    L.write(root)
    const after = L.scan(root).loi.map((l) => l.loai)
    assert.deepEqual(after, ['thay-mat']) // cảnh báo tham chiếu vẫn còn, cảnh báo INDEX đã hết
  })

  test('R5 write() idempotent sau khi file bị xoá: lần ghi thứ hai không đổi file nào (không nhả cảnh báo "đã mất" vào INDEX mới rồi xoá đi)', () => {
    const root = repo()
    const a = L.ghi(root, { tom_tat: 'Điều bị xoá' })
    L.ghi(root, { tom_tat: 'Điều thay thế', thay_cho: a.ma })
    fs.rmSync(path.join(root, '.claude/so-chot', a.file))
    const w1 = L.write(root)
    assert.ok(w1.ghi.includes(INDEX))
    const idx1 = read(root, INDEX)
    assert.ok(!idx1.includes('đã mất'), idx1)
    const s1 = snap(root)
    const w2 = L.write(root)
    assert.deepEqual(w2.ghi, [], 'lần ghi thứ hai không ghi gì')
    assert.equal(read(root, INDEX), idx1)
    assert.deepEqual(snap(root), s1, 'kể cả mtime')
    assert.deepEqual(L.scan(root).loi.map((l) => l.loai), ['thay-mat'])
  })
})

describe('AC8 dấu vân tay, cache ngoài repo, hook chỉ đọc', () => {
  test('fingerprint đổi khi sửa progress / IDEAS / file quyết định (kể cả file không phải mtime lớn nhất) / xoá file; không đổi khi không đụng gì', () => {
    const root = repo()
    const A = L.ghi(root, { tom_tat: 'A' }, { write: false })
    const B = L.ghi(root, { tom_tat: 'B' }, { write: false })
    const C = L.ghi(root, { tom_tat: 'C' }, { write: false })
    const prog = spec(root, '2026-10-02-x')
    L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'ý' })
    const t0 = Date.now() / 1000 - 1000
    const fA = path.join(root, '.claude/so-chot', A.file)
    for (const [i, d] of [A, B, C].entries()) fs.utimesSync(path.join(root, '.claude/so-chot', d.file), t0 + i * 10, t0 + i * 10) // C có mtime lớn nhất
    const fp0 = L.scan(root).fingerprint
    assert.match(fp0, /^[0-9a-f]{40}$/)
    assert.equal(L.scan(root).fingerprint, fp0)
    // sửa A: khác size, giữ NGUYÊN mtime cũ
    const textA = fs.readFileSync(fA, 'utf8')
    fs.writeFileSync(fA, `${textA}\nthêm dòng`)
    fs.utimesSync(fA, t0, t0)
    const fp1 = L.scan(root).fingerprint
    assert.notEqual(fp1, fp0)
    // sửa A: cùng size, mtime khác nhưng vẫn nhỏ hơn mtime cực đại (của C)
    fs.writeFileSync(fA, `${textA}\nthêm dòng`)
    fs.utimesSync(fA, t0 + 5, t0 + 5)
    const fp2 = L.scan(root).fingerprint
    assert.notEqual(fp2, fp1)
    // sửa progress
    fs.appendFileSync(prog, 'Bước tiếp theo: Z\n')
    const fp3 = L.scan(root).fingerprint
    assert.notEqual(fp3, fp2)
    // sửa IDEAS
    L.ghiYTuong(root, { loai: 'cải tiến', noi_dung: 'ý hai' })
    const fp4 = L.scan(root).fingerprint
    assert.notEqual(fp4, fp3)
    // thêm thư mục tính năng (đổi tập pham_vi hợp lệ)
    write(root, 'docs/specs/2026-10-03-y/note.md', 'x')
    const fp5 = L.scan(root).fingerprint
    assert.notEqual(fp5, fp4)
    // xoá file
    fs.rmSync(path.join(root, '.claude/so-chot', B.file))
    const fp6 = L.scan(root).fingerprint
    assert.notEqual(fp6, fp5)
    assert.equal(new Set([fp0, fp1, fp2, fp3, fp4, fp5, fp6]).size, 7)
  })

  test('excerpt: cache ngoài repo theo fingerprint (trúng khi không đổi, tính lại khi nguồn/nhánh đổi); toàn bộ đường đọc không ghi repo', () => {
    const root = repo()
    spec(root, '2026-10-02-x', 'Trạng thái: đang làm\nNhánh / worktree: feat/x\n')
    L.ghi(root, { tom_tat: 'Luật một' })
    L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'ý' })
    gitOk(root, 'add', '-A')
    gitOk(root, 'commit', '-qm', 'base')
    fs.rmSync(CACHE_DIR, { recursive: true, force: true })
    const before = snap(root)
    const t1 = L.excerpt(root, { branch: 'feat/x', coMod: false })
    assert.ok(t1.includes('Luật một'))
    // mọi hàm đọc: không ghi repo
    L.render(root); L.scan(root); L.tim(root, 'luat'); L.openProgress(root, 'feat/x'); L.excerpt(root, { branch: 'zzz' })
    assert.deepEqual(snap(root), before)
    assert.equal(gitOk(root, 'status', '--porcelain').trim(), '')
    const caches = fs.readdirSync(CACHE_DIR)
    assert.equal(caches.length, 1)
    assert.ok(!path.join(CACHE_DIR, caches[0]).startsWith(root))
    // chứng minh trúng cache: sửa nội dung cache, gọi lại phải trả đúng nội dung đó
    const cf = path.join(CACHE_DIR, caches[0])
    const c = JSON.parse(fs.readFileSync(cf, 'utf8'))
    for (const k of Object.keys(c.items)) c.items[k] = 'ĐÃ-CACHE'
    fs.writeFileSync(cf, JSON.stringify(c))
    assert.equal(L.excerpt(root, { branch: 'feat/x', coMod: false }), 'ĐÃ-CACHE')
    assert.notEqual(L.excerpt(root, { branch: 'feat/y', coMod: false }), 'ĐÃ-CACHE') // nhánh khác ⇒ khoá khác
    assert.notEqual(L.excerpt(root, { branch: 'feat/x', coMod: true }), 'ĐÃ-CACHE') // có mod ⇒ khoá khác
    // nguồn đổi ⇒ fingerprint đổi ⇒ tính lại
    L.ghi(root, { tom_tat: 'Luật hai' })
    const t2 = L.excerpt(root, { branch: 'feat/x', coMod: false })
    assert.ok(t2.includes('Luật một') && t2.includes('Luật hai') && t2 !== 'ĐÃ-CACHE')
  })

  test('không ghi được cache (HOME chỉ đọc) ⇒ vẫn trả phần nạp, không ném', () => {
    const root = repo()
    L.ghi(root, { tom_tat: 'Luật' })
    fs.rmSync(CACHE_DIR, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true })
    fs.writeFileSync(CACHE_DIR, 'tôi là file chặn đường') // mkdir cache/so-chot sẽ lỗi
    try {
      assert.ok(L.excerpt(root, { coMod: false }).includes('Luật'))
    } finally {
      fs.rmSync(CACHE_DIR, { force: true })
    }
  })

  test('render không ghi gì; write chỉ ghi khi nội dung đổi, không để lại file tạm, INDEX/ROADMAP có dòng đầu tự sinh', () => {
    const root = repo()
    L.ghi(root, { tom_tat: 'A' })
    const before = snap(root)
    L.render(root)
    assert.deepEqual(snap(root), before)
    const w = L.write(root)
    assert.deepEqual(w, { ghi: [], bo_qua: [] }) // đã sinh bởi ghi(), không đổi
    assert.deepEqual(snap(root), before)
    for (const f of [INDEX, 'docs/ROADMAP.md']) {
      assert.match(read(root, f).split('\n')[0], /^<!-- tự sinh bởi so-chot\.mjs, đừng sửa tay · stamp: [0-9a-f]{10} -->$/)
    }
    assert.deepEqual(Object.keys(snap(root)).filter((f) => f.includes('.tmp-')), [])
  })

  test('INDEX/ROADMAP không phụ thuộc mtime (clone mới cho cùng kết quả)', () => {
    const root = repo()
    spec(root, '2026-10-02-x', 'Trạng thái: xong\nXong ngày: 2026-10-03\n')
    L.ghi(root, { tom_tat: 'A' }, { now: T_VN })
    const r1 = L.render(root)
    for (const f of Object.keys(snap(root))) { const t = new Date(Date.now() - 12345678); fs.utimesSync(path.join(root, f), t, t) }
    assert.deepEqual(L.render(root), r1)
  })
})

describe('AC8b INDEX lệch nguồn', () => {
  test('INDEX bị union-merge (trùng/lẫn) ⇒ phần nạp vẫn đúng từ nguồn + một dòng cảnh báo; write sinh lại bản sạch', () => {
    const root = repo()
    const a = L.ghi(root, { tom_tat: 'Luật một' })
    L.ghi(root, { tom_tat: 'Luật hai' })
    const idx = read(root, INDEX)
    fs.writeFileSync(path.join(root, INDEX), `${idx}\n${idx}`) // dấu vết union: mọi dòng hai lần
    const ex = L.excerpt(root, { coMod: false })
    assert.equal(ex.split('Luật một').length - 1, 1)
    assert.equal(ex.split('Luật hai').length - 1, 1)
    assert.equal(ex.split('INDEX lệch nguồn').length - 1, 1)
    assert.ok(L.scan(root).loi.some((l) => l.loai === 'index-lech'))
    L.write(root)
    assert.equal(read(root, INDEX), L.render(root).index)
    assert.equal(L.excerpt(root, { coMod: false }).includes('INDEX lệch'), false)
    // file nguồn mất trong khi INDEX còn dòng: phần nạp bỏ điều đó và nói đã mất
    fs.rmSync(path.join(root, '.claude/so-chot', a.file))
    const ex2 = L.excerpt(root, { coMod: false })
    assert.ok(!ex2.includes('Luật một') && ex2.includes('Luật hai') && ex2.includes('đã mất'))
  })
})

describe('FA2 số đếm trong INDEX tính từ nguồn', () => {
  function setup() {
    const root = repo()
    spec(root, '2026-10-02-fa')
    L.ghi(root, { tom_tat: 'Luật một' }, { now: T_VN })
    L.ghi(root, { tom_tat: 'Luật hai' }, { now: T_VN + 60000 })
    L.ghi(root, { tom_tat: 'Điều A', pham_vi: '2026-10-02-fa' }, { now: T_VN + 120000 })
    L.ghi(root, { tom_tat: 'Chờ A', pham_vi: '2026-10-02-fa', ai_quyet: 'tu-chon-khi-vang' }, { now: T_VN + 180000 })
    return root
  }

  test('mỗi tiêu đề "(N)" = số dòng điều đúng của nhóm đó; INDEX sinh xong không bị báo lệch kể cả khi đang có cảnh báo khác', () => {
    const root = setup()
    const counted = (idx) => idx.split(/^## /m).slice(1).filter((sec) => /^[^\n]*\((\d+)\)\n/.test(sec)).map((sec) => [Number(/^[^\n]*\((\d+)\)\n/.exec(sec)[1]), sec.split('\n').filter((l) => l.startsWith('- [')).length])
    const c = counted(read(root, INDEX))
    assert.ok(c.length >= 3)
    for (const [n, lines] of c) assert.equal(n, lines)
    assert.deepEqual(L.scan(root).loi, [])
    // đang có cảnh báo (file hỏng) ghi trong INDEX: vẫn không bị coi là INDEX lệch
    write(root, '.claude/so-chot/chung/zzzz9999-hong.md', 'không phải front matter\n')
    L.write(root)
    assert.match(read(root, INDEX), /## Cảnh báo\n- ⚠ File quyết định hỏng/)
    assert.deepEqual(L.scan(root).loi.map((l) => l.loai), ['hong'])
  })

  test('INDEX có dòng đúng nhưng số đếm sai (kiểu sau union-merge) vẫn có đúng một cảnh báo trong phần nạp; write sinh lại bản sạch', () => {
    const root = setup()
    const idx = read(root, INDEX)
    fs.writeFileSync(path.join(root, INDEX), idx.replace(/\((\d+)\)/, (m, n) => `(${Number(n) + 1})`)) // chỉ sai một số đếm
    assert.ok(L.scan(root).loi.some((l) => l.loai === 'index-lech'))
    assert.equal(L.excerpt(root, { coMod: false }).split('INDEX lệch nguồn').length - 1, 1)
    L.write(root)
    assert.equal(read(root, INDEX), idx)
    assert.deepEqual(L.scan(root).loi, [])
    // hai dòng stamp (dấu vết union của hai nhánh) cũng là lệch
    fs.writeFileSync(path.join(root, INDEX), `${idx.split('\n')[0]}\n${idx}`)
    assert.ok(L.scan(root).loi.some((l) => l.loai === 'index-lech'))
  })

  test('INDEX kiểu cũ (dòng "→ đường dẫn") vẫn đọc được: file mất vẫn bị báo; còn nguyên thì chỉ báo lệch rồi sinh lại thành kiểu mới', () => {
    const root = repo()
    const a = L.ghi(root, { tom_tat: 'Luật một' }, { now: T_VN })
    const b = L.ghi(root, { tom_tat: 'Luật hai' }, { now: T_VN + 60000 })
    const oldLine = (d, giua) => `- [${d.ma.slice(0, 4)}] ${d.luc} · ✅ · [chung] ${d.tom_tat} → ${d.file}${giua ?? ''}`
    fs.writeFileSync(path.join(root, INDEX), [
      '<!-- tự sinh bởi so-chot.mjs, đừng sửa tay · stamp: 0123456789 -->', '# Sổ chốt', '',
      'Mỗi dòng một điều đã chốt. ✅ đang dùng · ⚠️ chờ xem lại · ↩️ đã thay · ✖ đã huỷ · 📦 đã cất.', '',
      '## Còn hiệu lực (2)', oldLine(a), oldLine(b), '', '## Đã cất · đã thay · đã huỷ (0)', '(chưa có)', '',
    ].join('\n'))
    assert.deepEqual(L.scan(root).loi.map((l) => l.loai), ['index-lech']) // đọc được cả hai dòng cũ: không báo mất
    fs.rmSync(path.join(root, '.claude/so-chot', a.file))
    assert.ok(L.scan(root).loi.some((l) => l.loai === 'index-mat' && l.msg.includes(a.file)))
    L.write(root)
    const nu = read(root, INDEX)
    assert.ok(nu.includes(`[${b.ma.slice(0, 4)}](${b.file})`) && !nu.includes(' → '))
    assert.deepEqual(L.scan(root).loi, [])
  })
})

describe('FA5 INDEX dễ đọc cho người không biết code', () => {
  test('nhóm theo phạm vi (luật chung rồi tính năng mới nhất trước), ⚠️ gom nhóm riêng ở đầu, link trên mã, không đuôi đường dẫn, không giờ phút', () => {
    const root = repo()
    spec(root, '2026-09-01-cu')
    spec(root, '2026-10-05-moi')
    const at = (n) => ({ now: T_VN + n * 60000 })
    const c1 = L.ghi(root, { tom_tat: 'Luật chung đầu' }, at(0))
    L.ghi(root, { tom_tat: 'Điều của tính năng cũ', pham_vi: '2026-09-01-cu' }, at(1))
    const m1 = L.ghi(root, { tom_tat: 'Điều của tính năng mới', pham_vi: '2026-10-05-moi' }, at(2))
    const c2 = L.ghi(root, { tom_tat: 'Luật chung sau', thay_cho: c1.ma }, at(3))
    const w1 = L.ghi(root, { tom_tat: 'Chờ xem của cũ', pham_vi: '2026-09-01-cu', ai_quyet: 'tu-chon-khi-vang' }, at(4))
    const w2 = L.ghi(root, { tom_tat: 'Chờ xem chung', ai_quyet: 'tu-chon-khi-vang' }, at(5))
    const gone = L.ghi(root, { tom_tat: 'Đã bỏ' }, at(6))
    L.huy(root, gone.ma, at(7))
    const idx = L.render(root).index
    const line = (d, mark = '') => `- [${d.ma.slice(0, 4)}](${d.file}) · ${mark}2026-10-02 · ${d.tom_tat}`
    assert.deepEqual(idx.split('\n').filter((l) => /^## /.test(l)), [
      '## ⚠️ Chờ xem lại (2)', '## Luật chung (1)', '## 2026-10-05-moi (1)', '## 2026-09-01-cu (1)', '## Đã cất · đã thay · đã huỷ (2)',
    ])
    const block = (head) => idx.split(`${head}\n`)[1].split('\n## ')[0].trimEnd()
    assert.equal(block('## ⚠️ Chờ xem lại (2)'), ['### Luật chung', line(w2), '', '### 2026-09-01-cu', line(w1)].join('\n'))
    assert.equal(block('## Luật chung (1)'), line(c2).replace(/$/, ` (thay [${c1.ma.slice(0, 4)}])`))
    assert.equal(block('## 2026-10-05-moi (1)'), line(m1))
    assert.ok(block('## Đã cất · đã thay · đã huỷ (2)').split('\n').includes(`- [${c1.ma.slice(0, 4)}](${c1.file}) · ↩️ · 2026-10-02 · Luật chung đầu (thay bởi [${c2.ma.slice(0, 4)}])`))
    assert.ok(block('## Đã cất · đã thay · đã huỷ (2)').split('\n').includes(`- [${gone.ma.slice(0, 4)}](${gone.file}) · ✖ · 2026-10-02 · Đã bỏ`))
    const dong = idx.split('\n').filter((l) => l.startsWith('- '))
    assert.ok(dong.every((l) => !/ → /.test(l) && !/\d{2}:\d{2}/.test(l)), 'không đuôi → đường dẫn, không giờ phút')
    assert.ok(idx.indexOf('## ⚠️') < idx.indexOf('## Luật chung') && idx.indexOf('## Luật chung') < idx.indexOf('## 2026-10-05-moi'))
    assert.deepEqual(L.scan(root).loi, [])
  })

  test('trong nhóm xếp theo thời gian (cũ → mới), kể cả khi ghi không theo thứ tự; tóm tắt dài cắt ở ranh giới từ + "…", không cắt giữa chữ', () => {
    const root = repo()
    const long = Array.from({ length: 80 }, (_, i) => `chữ${i}`).join(' ')
    plant(root, { ma: 'zzzz1111', tom_tat: 'Mới hơn', luc: '2026-10-03 09:00' })
    plant(root, { ma: 'aaaa2222', tom_tat: 'Cũ hơn', luc: '2026-10-01 23:59' })
    plant(root, { ma: 'mmmm3333', tom_tat: long, luc: '2026-10-02 08:00' })
    const dong = L.render(root).index.split('\n').filter((l) => l.startsWith('- '))
    assert.deepEqual(dong.map((l) => l.slice(0, 8)), ['- [aaaa]', '- [mmmm]', '- [zzzz]'])
    const shown = dong[1].split(' · ').slice(2).join(' · ')
    assert.ok(shown.length <= 200 && shown.endsWith('…'), `${shown.length}`)
    assert.ok(long.split(' ').includes(shown.slice(0, -1).split(' ').pop()), 'từ cuối còn nguyên')
    assert.ok(long.startsWith(shown.slice(0, -1)))
  })
})

describe('AC8b (tiếp) đường dẫn có dấu cách/dấu tiếng Việt', () => {
  test('thư mục tính năng có dấu cách và chữ có dấu: INDEX sinh xong không bị báo lệch, tìm và nạp được', () => {
    const root = repo()
    spec(root, '2026-10-02-tính năng mới', 'Trạng thái: đang làm\nNhánh / worktree: feat/tn\n')
    const d = L.ghi(root, { tom_tat: 'Điều có đường dẫn lạ', pham_vi: '2026-10-02-tính năng mới' })
    L.ghi(root, { tom_tat: 'Điều chung' })
    assert.deepEqual(L.scan(root).loi, [])
    assert.ok(read(root, INDEX).includes(`[${d.ma.slice(0, 4)}](<2026-10-02-tính năng mới/${d.ma}-dieu-co-duong-dan-la.md>)`))
    assert.ok(L.excerpt(root, { branch: 'feat/tn', coMod: false }).includes('## Tính năng đang làm: 2026-10-02-tính năng mới (1)'))
    assert.equal(L.close(root, '2026-10-02-tính năng mới').cat[0], d.ma)
  })
})

describe('AC8c đường dẫn trong thư mục dự án', () => {
  test('pham_vi ra ngoài / không có thư mục ⇒ ghi() từ chối, không tạo gì ngoài root', () => {
    const root = repo()
    const outside = path.join(path.dirname(root), `${path.basename(root)}-ngoai`)
    fs.mkdirSync(path.join(outside, 'x'), { recursive: true })
    for (const bad of ['../x', '../../x', '..', '.', 'a/b', 'a\\b', 'C:\\x', '/etc', '2026-10-02-khong-co', '.git', 'chung/../x']) {
      assert.throws(() => L.ghi(root, { tom_tat: 'x', pham_vi: bad }), /phạm vi/, bad)
    }
    assert.deepEqual(fs.readdirSync(path.join(outside, 'x')), [])
    assert.deepEqual(fs.readdirSync(outside), ['x'])
    assert.equal(exists(root, '.claude'), false)
    assert.equal(L.safePath(root, '../x'), null)
    assert.equal(L.safePath(root, path.join(outside, 'x')), null)
    assert.equal(L.safePath(root, 'docs/../../x'), null)
    assert.equal(L.safePath(root, 'a/b.md'), path.join(root, 'a', 'b.md'))
  })

  test('file đặt tay có pham_vi ../x hoặc lệch thư mục ⇒ bị bỏ kèm cảnh báo; thư mục so-chot không có tính năng thật ⇒ bỏ, một cảnh báo', () => {
    const root = repo()
    const bad = { ma: 'aaaa1111', tom_tat: 'Độc', pham_vi: '../x', trang_thai: 'dang-dung', luc: '2026-10-01 10:00', ai_quyet: 'ban' }
    write(root, '.claude/so-chot/chung/aaaa1111-doc.md', L.renderDecision(bad))
    write(root, '.claude/so-chot/chung/bbbb2222-lech.md', L.renderDecision({ ...bad, ma: 'bbbb2222', pham_vi: '2026-10-02-a' }))
    write(root, '.claude/so-chot/2026-10-09-ma/cccc3333-x.md', L.renderDecision({ ...bad, ma: 'cccc3333', pham_vi: '2026-10-09-ma' }))
    write(root, '.claude/so-chot/2026-10-09-ma/dddd4444-x.md', L.renderDecision({ ...bad, ma: 'dddd4444', pham_vi: '2026-10-09-ma' }))
    const good = plant(root, { tom_tat: 'Tốt' })
    const sc = L.scan(root)
    assert.deepEqual(sc.decisions.map((d) => d.ma), [good.ma])
    assert.equal(sc.loi.filter((l) => l.loai === 'pham-vi').length, 3)
    assert.ok(sc.loi.some((l) => l.msg.includes('2 file') && l.msg.includes('2026-10-09-ma')))
    assert.ok(!L.excerpt(root, { coMod: false }).includes('Độc'))
  })

  test('.claude/so-chot/chung là junction ra ngoài ⇒ không đọc, từ chối ghi, thư mục ngoài không đổi', (t) => {
    const root = repo()
    const outside = path.join(TMP, `ngoai-chung-${++seq}`)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'eeee5555-bi-mat.md'), L.renderDecision({ ma: 'eeee5555', tom_tat: 'BÍ MẬT', pham_vi: 'chung', trang_thai: 'dang-dung', luc: '2026-10-01 10:00', ai_quyet: 'ban' }))
    if (!link(t, outside, path.join(root, '.claude/so-chot/chung'), 'junction')) return
    const sc = L.scan(root)
    assert.deepEqual(sc.decisions, [])
    assert.ok(sc.loi.some((l) => l.loai === 'symlink'))
    assert.ok(!L.excerpt(root, { coMod: false }).includes('BÍ MẬT'))
    assert.throws(() => L.ghi(root, { tom_tat: 'x' }), /ngoài thư mục dự án|symlink/)
    assert.deepEqual(fs.readdirSync(outside), ['eeee5555-bi-mat.md'])
  })

  test('docs là junction ra ngoài ⇒ write bỏ qua ROADMAP/IDEAS (không ghi ra ngoài), INDEX vẫn ghi trong repo', (t) => {
    const root = repo()
    const outside = path.join(TMP, `ngoai-docs-${++seq}`)
    fs.mkdirSync(path.join(outside, 'specs', '2026-10-02-x'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'specs', '2026-10-02-x', 'progress.md'), 'Trạng thái: đang làm\nNhánh / worktree: feat/leak\n')
    if (!link(t, outside, path.join(root, 'docs'), 'junction')) return
    L.ghi(root, { tom_tat: 'Trong repo' })
    assert.ok(exists(root, INDEX))
    const w = L.write(root)
    assert.deepEqual(w.bo_qua.map((b) => b.file), ['docs/ROADMAP.md'])
    assert.throws(() => L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'y' }), /ngoài thư mục dự án|symlink/)
    assert.deepEqual(fs.readdirSync(outside), ['specs'])
    assert.deepEqual(fs.readdirSync(path.join(outside, 'specs')), ['2026-10-02-x'])
    assert.equal(L.openProgress(root, 'feat/leak'), null)
    assert.throws(() => L.ghi(root, { tom_tat: 'y', pham_vi: '2026-10-02-x' }), /phạm vi/)
  })

  test('thư mục tính năng là junction ra ngoài ⇒ không thành phạm vi, không có progress, có cảnh báo', (t) => {
    const root = repo()
    const outside = path.join(TMP, `ngoai-spec-${++seq}`)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'progress.md'), 'Trạng thái: đang làm\nNhánh / worktree: feat/leak\n')
    if (!link(t, outside, path.join(root, 'docs/specs/2026-10-02-linked'), 'junction')) return
    assert.equal(L.openProgress(root, 'feat/leak'), null)
    assert.throws(() => L.ghi(root, { tom_tat: 'x', pham_vi: '2026-10-02-linked' }), /phạm vi/)
    assert.ok(L.scan(root).loi.some((l) => l.loai === 'symlink' && l.msg.includes('2026-10-02-linked')))
    assert.equal(L.excerpt(root, { branch: 'feat/leak', coMod: false }), '') // chỉ có symlink bị bỏ ⇒ coi như chưa có sổ
  })

  test('file quyết định là symlink tới file ngoài ⇒ bỏ qua, không lộ nội dung', (t) => {
    const root = repo()
    const secret = path.join(TMP, `secret-${++seq}.md`)
    fs.writeFileSync(secret, L.renderDecision({ ma: 'ffff6666', tom_tat: 'BÍ MẬT', pham_vi: 'chung', trang_thai: 'dang-dung', luc: '2026-10-01 10:00', ai_quyet: 'ban' }))
    if (!link(t, secret, path.join(root, '.claude/so-chot/chung/ffff6666-bi-mat.md'), 'file')) return
    plant(root, { tom_tat: 'Tốt' })
    const sc = L.scan(root)
    assert.equal(sc.decisions.length, 1)
    assert.ok(sc.loi.some((l) => l.loai === 'symlink'))
    assert.ok(!L.excerpt(root, { coMod: false }).includes('BÍ MẬT'))
  })

  test('trùng mã giả lập (hai file cùng ma) ⇒ cảnh báo trong phần nạp và INDEX, không tự đổi', () => {
    const root = repo()
    spec(root, '2026-10-02-a')
    plant(root, { ma: 'dupe0001', tom_tat: 'Bản chung' })
    plant(root, { ma: 'dupe0001', tom_tat: 'Bản tính năng', pham_vi: '2026-10-02-a' })
    const sc = L.scan(root)
    assert.equal(sc.decisions.length, 2)
    const w = sc.loi.filter((l) => l.loai === 'trung-ma')
    assert.equal(w.length, 1)
    assert.ok(w[0].msg.includes('dupe0001'))
    assert.match(L.excerpt(root, { coMod: false }), /Trùng mã \[dupe\]/)
    assert.match(L.render(root).index, /Trùng mã \[dupe\]/)
  })
})

describe('AC10–12 khẩu phần nạp', () => {
  // 2.000 quyết định: 150 chung đang dùng · 300 ⚠️ (chung 100, f2 150, f3 50) · f1: 100 đang dùng + 10 ⚠️ + 30 đã cất · f2: 710 · f3: 700 đã cất.
  function big() {
    const root = repo('big')
    spec(root, '2026-10-01-f1', 'Trạng thái: đang làm\nNhánh / worktree: feat/f1\n', 1)
    spec(root, '2026-10-02-f2', 'Trạng thái: đang làm\nNhánh / worktree: feat/f2\n', 0)
    spec(root, '2026-09-01-f3', 'Trạng thái: xong\nXong ngày: 2026-09-20\n')
    const f1 = '2026-10-01-f1'
    const f2 = '2026-10-02-f2'
    const f3 = '2026-09-01-f3'
    let n = 0
    const pad = 'chữ nghĩa dài dòng để mỗi luật chiếm khoảng một trăm hai mươi ký tự '
    const mk = (pham_vi, trang_thai, count, tag) => {
      for (let i = 0; i < count; i++) {
        const k = n++
        plant(root, { ma: `m${String(k).padStart(7, '0')}`, tom_tat: `${tag} số ${k}: ${pad}`, pham_vi, trang_thai, luc: `2026-09-${String(1 + (k % 28)).padStart(2, '0')} ${String(k % 24).padStart(2, '0')}:00` })
      }
    }
    mk('chung', 'dang-dung', 150, 'Luật chung')
    mk('chung', 'cho-xem', 100, 'Chờ chung')
    mk(f2, 'cho-xem', 150, 'Chờ f2')
    mk(f3, 'cho-xem', 50, 'Chờ f3')
    mk(f1, 'dang-dung', 100, 'F1 dùng')
    mk(f1, 'cho-xem', 10, 'F1 chờ')
    mk(f1, 'da-cat', 30, 'F1 cất')
    mk(f2, 'dang-dung', 710, 'F2 dùng')
    mk(f3, 'da-cat', 700, 'F3 cất')
    for (let i = 0; i < 14; i++) L.ghiYTuong(root, { loai: 'tính năng', noi_dung: `Ý số ${i}` })
    return { root, n }
  }

  test('2.000 quyết định / 300 ⚠️ / 150 luật chung: đúng khẩu phần, tổng ≤ trần, cắt thì nói rõ cần tra gì', (t) => {
    const { root, n } = big()
    assert.equal(n, 2000)
    const t0 = performance.now()
    const ex = L.excerpt(root, { branch: 'feat/f1', coMod: false })
    const cold = performance.now() - t0
    const t1 = performance.now()
    assert.equal(L.excerpt(root, { branch: 'feat/f1', coMod: false }), ex)
    const warm = performance.now() - t1
    assert.ok(warm < 2000, `cache trúng vẫn mất ${warm.toFixed(0)} ms (nguội ${cold.toFixed(0)} ms)`)
    assert.ok(ex.length <= L.KHAU_PHAN.tong, `tổng ${ex.length}`)
    const parts = sections(ex)
    // lời dẫn ≤ 300, nói đúng công cụ tra và dặn tra trước khi chạm phạm vi
    assert.ok(parts[0].length <= 300, `lời dẫn ${parts[0].length}`)
    assert.ok(parts[0].includes('KHÔNG phải lệnh của user') && parts[0].includes('trước khi làm việc chạm phạm vi X, tra quyết định của X bằng rg -i "<từ khoá>" .claude/so-chot'))
    // thứ tự khẩu phần
    assert.deepEqual(parts.map((p) => p.split('\n')[0].replace(/[:(].*$/, '').trim()).slice(1), ['## Luật chung', '## Tính năng đang làm', '## ⚠️ Chờ user xem lại', 'Roadmap'])
    // luật chung ≤ 3.000, shown + còn = 150
    const chung = section(ex, '## Luật chung (150)')
    t.diagnostic(`tổng ${ex.length}/${L.KHAU_PHAN.tong} · lời dẫn ${parts[0].length} · chung ${chung.length} · nguội ${cold.toFixed(0)} ms · cache trúng ${warm.toFixed(0)} ms`)
    assert.ok(chung.length <= 3000, `chung ${chung.length}`)
    const shown = chung.split('\n').filter((l) => l.startsWith('- [')).length
    const left = Number(/\(còn (\d+) luật chung: cần gộp bớt; tra bằng rg -i "<từ khoá>" \.claude\/so-chot\)$/.exec(chung)?.[1])
    assert.ok(shown > 10 && left > 0 && shown + left === 150, `${shown} + ${left}`)
    assert.ok(!chung.includes('Chờ chung'))
    // tính năng đang làm ≤ 2.000, gồm cả ⚠️ và 📦 của tính năng, không lẫn tính năng khác
    const feat = section(ex, '## Tính năng đang làm: 2026-10-01-f1 (140)')
    assert.ok(feat.length <= 2000, `tính năng ${feat.length}`)
    assert.match(feat, /\(còn \d+ quyết định của 2026-10-01-f1: tra bằng rg/)
    assert.ok(!feat.includes('F2 dùng') && !feat.includes('F3 cất') && !feat.includes('Luật chung'))
    // ⚠️: 5 dòng + 1 dòng đếm; đếm các điều ngoài tính năng đang làm
    const cho = section(ex, '## ⚠️')
    assert.match(cho.split('\n')[0], /^## ⚠️ Chờ user xem lại: 300 điều \(hiện 5 mới nhất; xem hết bằng rg -i/)
    assert.equal(cho.split('\n').length, 6)
    assert.ok(cho.split('\n').slice(1).every((l) => l.startsWith('- [')))
    // roadmap đúng 1 dòng
    const road = section(ex, 'Roadmap:')
    assert.equal(road, 'Roadmap: 2 đang làm · 14 ý tưởng · tính năng đang làm: 2026-10-01-f1')
    // có mod ⇒ công cụ tra là tim_chot (không rg)
    const exMod = L.excerpt(root, { branch: 'feat/f1', coMod: true })
    assert.ok(exMod.includes('mcp__so-chot__tim_chot') && !exMod.includes('rg -i'))
    assert.ok(exMod.length <= L.KHAU_PHAN.tong)
    // trần nhỏ hơn ⇒ mọi khẩu phần co theo, tổng vẫn ≤ trần
    for (const budget of [4000, 2500, 1000]) {
      const small = L.excerpt(root, { branch: 'feat/f1', coMod: false, budget })
      assert.ok(small.length <= budget, `budget ${budget}: ${small.length}`)
      assert.ok(small.includes('tra bằng'))
    }
  })

  test('không bị cắt ⇒ không có dòng "(còn …)"; sổ nhỏ nạp đủ, cũ → mới', () => {
    const root = repo()
    plant(root, { ma: 'aaaa0001', tom_tat: 'Mới hơn', luc: '2026-10-02 10:00' })
    plant(root, { ma: 'aaaa0002', tom_tat: 'Cũ hơn', luc: '2026-10-01 10:00' })
    const ex = L.excerpt(root, { coMod: false })
    assert.ok(!ex.includes('(còn '))
    assert.ok(ex.indexOf('Cũ hơn') < ex.indexOf('Mới hơn'))
    assert.ok(ex.includes('## Luật chung (2)'))
  })

  test('khi bị cắt luật chung: nạp các điều MỚI nhất vừa đủ, không âm thầm bỏ', () => {
    const root = repo()
    for (let i = 0; i < 100; i++) plant(root, { ma: `r${String(i).padStart(7, '0')}`, tom_tat: `Luật ${String(i).padStart(3, '0')} ${'x'.repeat(120)}`, luc: `2026-10-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` })
    const ex = L.excerpt(root, { coMod: false })
    assert.ok(ex.includes('Luật 099') && !ex.includes('Luật 000'))
    assert.match(ex, /\(còn \d+ luật chung: cần gộp bớt; tra bằng/)
  })
})

describe('AC13 có mod / không có mod; AC14 không có sổ', () => {
  test('dò mod ở ~/.claude/mods/so-chot khi không truyền coMod; hook vẫn nạp đủ khi không có mod', () => {
    const root = repo()
    L.ghi(root, { tom_tat: 'Luật' })
    fs.rmSync(MODS_DIR, { recursive: true, force: true })
    const noMod = L.excerpt(root)
    assert.ok(noMod.includes('Luật') && noMod.includes('rg -i') && !noMod.includes('mcp__so-chot__tim_chot'))
    fs.mkdirSync(MODS_DIR, { recursive: true })
    try {
      const withMod = L.excerpt(root)
      assert.ok(withMod.includes('Luật') && withMod.includes('mcp__so-chot__tim_chot') && !withMod.includes('rg -i'))
    } finally {
      fs.rmSync(path.join(HOME, '.claude', 'mods'), { recursive: true, force: true })
    }
  })

  test('dự án không có sổ chốt / roadmap ⇒ chuỗi rỗng, không lỗi, không tạo file', () => {
    const root = repo()
    assert.equal(L.excerpt(root), '')
    fs.mkdirSync(path.join(root, '.claude/so-chot'), { recursive: true })
    fs.mkdirSync(path.join(root, 'docs/specs'), { recursive: true })
    assert.equal(L.excerpt(root, { branch: 'main' }), '')
    spec(root, '2026-10-02-xong', 'Trạng thái: xong\nXong ngày: 2026-10-03\n')
    assert.equal(L.excerpt(root, { branch: 'main' }), '') // chỉ có tính năng đã xong, không có ý tưởng
    assert.equal(L.excerpt(path.join(TMP, 'khong-co-thu-muc-nay')), '')
    assert.equal(Object.keys(snap(root)).length, 1)
  })
})

describe('AC15–17 cất kho, mở lại, tìm', () => {
  function setup() {
    const root = repo()
    spec(root, '2026-10-02-fa', 'Trạng thái: đang làm\nNhánh / worktree: feat/a\n')
    spec(root, '2026-10-02-fb', 'Trạng thái: đang làm\nNhánh / worktree: feat/b\n')
    const ch = L.ghi(root, { tom_tat: 'Luật chung giữ mãi' })
    const a1 = L.ghi(root, { tom_tat: 'Sửa lỗi đăng nhập kiểu A', pham_vi: '2026-10-02-fa', vi_sao: 'Vì cần token ngắn hạn' })
    const a2 = L.ghi(root, { tom_tat: 'A chờ xem', pham_vi: '2026-10-02-fa', ai_quyet: 'tu-chon-khi-vang' })
    const a3 = L.ghi(root, { tom_tat: 'A đã huỷ', pham_vi: '2026-10-02-fa' })
    L.huy(root, a3.ma)
    const b1 = L.ghi(root, { tom_tat: 'B của tính năng khác', pham_vi: '2026-10-02-fb' })
    return { root, ch, a1, a2, a3, b1 }
  }
  const front = (root, d) => /^trang_thai: (.*)$/m.exec(read(root, `.claude/so-chot/${d.file}`))[1]

  test('AC15 close: cất đúng phạm vi tính năng (không dời file); chung, tính năng khác, đã huỷ, điều ⚠️ không đổi; chạy lại không đổi gì', () => {
    const { root, ch, a1, a2, a3, b1 } = setup()
    fs.writeFileSync(path.join(root, 'docs/specs/2026-10-02-fa/progress.md'), 'Trạng thái: xong\nXong ngày: 2026-10-03\nNhánh / worktree: feat/a\n')
    const keep = Object.fromEntries([ch, a2, a3, b1].map((d) => [d.file, fs.readFileSync(path.join(root, '.claude/so-chot', d.file), 'utf8')]))
    const r1 = L.close(root, '2026-10-02-fa')
    assert.deepEqual(r1.cat, [a1.ma]) // FA4: chỉ điều đang dùng; a2 là ⚠️ nên ở lại
    assert.deepEqual([front(root, a1), front(root, a2), front(root, a3), front(root, ch), front(root, b1)], ['da-cat', 'cho-xem', 'da-huy', 'dang-dung', 'dang-dung'])
    for (const [f, text] of Object.entries(keep)) assert.equal(read(root, `.claude/so-chot/${f}`), text, f)
    assert.ok(exists(root, `.claude/so-chot/${a1.file}`) && exists(root, `.claude/so-chot/${a2.file}`)) // không dời file
    assert.ok(r1.ghi.includes(INDEX))
    const idx = read(root, INDEX)
    assert.equal(idx.split('\n').filter((l) => l.startsWith('- [') && l.includes('📦')).length, 1)
    assert.ok(idx.indexOf(idx.split('\n').find((l) => l.startsWith('- [') && l.includes('📦'))) > idx.indexOf('## Đã cất · đã thay'))
    assert.match(read(root, 'docs/ROADMAP.md'), /## Đã xong \(1 gần nhất \/ 1\)\n- 2026-10-03 · 2026-10-02-fa/)
    // chạy lại: không còn gì để cất, không file nào đổi (kể cả mtime)
    const s1 = snap(root)
    const r2 = L.close(root, '2026-10-02-fa')
    assert.deepEqual(r2, { cat: [], ghi: [], bo_qua: [] })
    assert.deepEqual(snap(root), s1)
    // bị ngắt giữa chừng (file đã cất chưa ghi xong, INDEX cũ) rồi chạy lại ⇒ cùng kết quả cuối
    const f1 = path.join(root, '.claude/so-chot', a1.file)
    fs.writeFileSync(f1, fs.readFileSync(f1, 'utf8').replace('trang_thai: da-cat', 'trang_thai: dang-dung'))
    fs.rmSync(path.join(root, INDEX))
    L.close(root, '2026-10-02-fa')
    assert.equal(read(root, INDEX), idx)
    assert.equal(front(root, a1), 'da-cat')
    assert.throws(() => L.close(root, 'chung'), /không phải "chung"/)
    assert.throws(() => L.close(root, '2026-10-02-khong-co'), /không có thư mục tính năng/)
    assert.throws(() => L.close(root, '../x'), /không có thư mục tính năng/)
  })

  test('AC22 xong: ghi "Trạng thái: xong" + "Xong ngày" vào progress.md rồi cất kho; chạy lại không đổi gì', () => {
    const { root, a1 } = setup()
    const prog = path.join(root, 'docs/specs/2026-10-02-fa/progress.md')
    fs.writeFileSync(prog, '# Tiến độ: A\nTrạng thái: đang làm\nNhánh / worktree: feat/a\n')
    const r1 = L.xong(root, '2026-10-02-fa', { now: Date.UTC(2026, 9, 3, 18, 30) }) // 01:30 ngày 04 giờ VN
    assert.equal(read(root, 'docs/specs/2026-10-02-fa/progress.md'), '# Tiến độ: A\nTrạng thái: xong\nXong ngày: 2026-10-04\nNhánh / worktree: feat/a\n')
    assert.equal(r1.progress, true)
    assert.deepEqual(r1.cat, [a1.ma])
    const s1 = snap(root)
    const r2 = L.xong(root, '2026-10-02-fa', { now: Date.UTC(2026, 9, 9) })
    assert.equal(r2.progress, false)
    assert.deepEqual(r2.cat, [])
    assert.deepEqual(snap(root), s1)
    fs.writeFileSync(path.join(root, 'docs/specs/2026-10-02-fb/progress.md'), '# Tiến độ: B\nNhánh / worktree: feat/b\n')
    L.xong(root, '2026-10-02-fb', { now: Date.UTC(2026, 9, 5) })
    assert.match(read(root, 'docs/specs/2026-10-02-fb/progress.md'), /^# Tiến độ: B\nTrạng thái: xong\nXong ngày: 2026-10-05\n/)
    assert.throws(() => L.xong(root, 'chung'), /không có thư mục tính năng/)
    assert.throws(() => L.xong(root, '../x'), /không có thư mục tính năng/)
  })

  test('FA1 xong sau khi mở lại: "Xong ngày" ghi lại theo lần đóng này (giờ VN); đang xong sẵn thì giữ nguyên', () => {
    const { root } = setup()
    const rel = 'docs/specs/2026-10-02-fa/progress.md'
    const prog = path.join(root, rel)
    fs.writeFileSync(prog, 'Trạng thái: đang làm\nXong ngày: 2026-09-15\nNhánh / worktree: feat/a\n') // đã từng xong, được mở lại
    const r1 = L.xong(root, '2026-10-02-fa', { now: Date.UTC(2026, 9, 2, 3, 0) })
    assert.equal(read(root, rel), 'Trạng thái: xong\nXong ngày: 2026-10-02\nNhánh / worktree: feat/a\n')
    assert.equal(r1.progress, true)
    assert.match(read(root, 'docs/ROADMAP.md'), /## Đã xong \(1 gần nhất \/ 1\)\n- 2026-10-02 · 2026-10-02-fa/)
    // markdown bao quanh dòng "Xong ngày" giữ nguyên, chỉ ngày đổi; ngày tính theo giờ VN (03:00 ngày 03)
    fs.writeFileSync(prog, '- **Trạng thái:** đang làm\n- **Xong ngày:** 2026-09-15\n')
    L.xong(root, '2026-10-02-fa', { now: Date.UTC(2026, 9, 2, 20, 0) })
    assert.equal(read(root, rel), 'Trạng thái: xong\n- **Xong ngày:** 2026-10-03\n')
    // đã xong sẵn (chạy lại, hoặc gõ tay "xong"): giữ ngày cũ, không đổi file
    fs.writeFileSync(prog, 'Trạng thái: xong\nXong ngày: 2026-09-15\n')
    L.write(root) // ROADMAP theo sổ mới; từ đây chạy xong lần nữa không được đổi file nào
    const s = snap(root)
    const r3 = L.xong(root, '2026-10-02-fa', { now: Date.UTC(2026, 9, 20) })
    assert.equal(r3.progress, false)
    assert.equal(read(root, rel), 'Trạng thái: xong\nXong ngày: 2026-09-15\n')
    assert.deepEqual(snap(root), s)
  })

  test('R6 xong() giữ kiểu xuống dòng gốc (CRLF/LF) của progress.md; đã xong sẵn ⇒ không đổi file (không ghi lại, kể cả khi lẫn CRLF/LF)', () => {
    const { root } = setup()
    const rel = 'docs/specs/2026-10-02-fa/progress.md'
    const prog = path.join(root, rel)
    // CRLF, đang làm: chỉ đổi dòng cần đổi, mọi dòng vẫn CRLF
    fs.writeFileSync(prog, '# Tiến độ: A\r\nTrạng thái: đang làm\r\nNhánh / worktree: feat/a\r\n')
    const r1 = L.xong(root, '2026-10-02-fa', { now: T_VN })
    assert.equal(read(root, rel), '# Tiến độ: A\r\nTrạng thái: xong\r\nXong ngày: 2026-10-02\r\nNhánh / worktree: feat/a\r\n')
    assert.equal(r1.progress, true)
    // CRLF, thiếu dòng Trạng thái: dòng chèn thêm cũng CRLF
    fs.writeFileSync(prog, '# Tiến độ: A\r\nNhánh / worktree: feat/a\r\n')
    L.xong(root, '2026-10-02-fa', { now: T_VN })
    assert.equal(read(root, rel), '# Tiến độ: A\r\nTrạng thái: xong\r\nXong ngày: 2026-10-02\r\nNhánh / worktree: feat/a\r\n')
    // đã xong sẵn, CRLF: chạy lại không đổi byte nào, không ghi lại file
    L.write(root)
    const bytes = fs.readFileSync(prog)
    const mt = fs.statSync(prog).mtimeMs
    const s = snap(root)
    const r2 = L.xong(root, '2026-10-02-fa', { now: T_VN + 5 * 86400000 })
    assert.equal(r2.progress, false)
    assert.deepEqual(fs.readFileSync(prog), bytes)
    assert.equal(fs.statSync(prog).mtimeMs, mt, 'không được ghi lại')
    assert.deepEqual(snap(root), s)
    // đã xong sẵn, lẫn CRLF và LF: nội dung không đổi ⇒ không đổi file
    fs.writeFileSync(prog, 'Trạng thái: xong\r\nXong ngày: 2026-09-15\nNhánh / worktree: feat/a\r\n')
    const bytes2 = fs.readFileSync(prog)
    const r3 = L.xong(root, '2026-10-02-fa', { now: T_VN })
    assert.equal(r3.progress, false)
    assert.deepEqual(fs.readFileSync(prog), bytes2)
    // LF vẫn LF
    fs.writeFileSync(prog, '# Tiến độ: A\nTrạng thái: đang làm\n')
    L.xong(root, '2026-10-02-fa', { now: T_VN })
    assert.equal(read(root, rel), '# Tiến độ: A\nTrạng thái: xong\nXong ngày: 2026-10-02\n')
  })

  test('FA4 close/xong chỉ cất điều đang dùng; điều ⚠️ giữ nguyên tới khi người dùng xem (phiên khác vẫn thấy ở phần ⚠️)', () => {
    const { root, a1, a2 } = setup()
    const before = read(root, `.claude/so-chot/${a2.file}`)
    const r = L.xong(root, '2026-10-02-fa', { now: T_VN })
    assert.deepEqual(r.cat, [a1.ma])
    assert.equal(read(root, `.claude/so-chot/${a2.file}`), before)
    assert.equal(L.scan(root).decisions.find((d) => d.ma === a2.ma).hien, 'cho-xem')
    const ex = L.excerpt(root, { branch: 'feat/b', coMod: false })
    assert.match(ex, new RegExp(`## ⚠️ Chờ user xem lại \\(1\\)\\n- \\[${a2.ma.slice(0, 4)}\\] \\[2026-10-02-fa\\] A chờ xem`))
    assert.deepEqual(L.xong(root, '2026-10-02-fa', { now: T_VN }).cat, []) // chạy lại: ⚠️ vẫn ở lại
    L.daXem(root, a2.ma) // người dùng đã xem ⇒ lần đóng sau mới cất được
    assert.deepEqual(L.close(root, '2026-10-02-fa').cat, [a2.ma])
  })

  test('AC16 mở lại tính năng: quyết định 📦 được nạp như của tính năng đang làm, file không đổi', () => {
    const { root, a1, a2, b1 } = setup()
    fs.writeFileSync(path.join(root, 'docs/specs/2026-10-02-fa/progress.md'), 'Trạng thái: xong\nXong ngày: 2026-10-03\nNhánh / worktree: feat/a\n')
    L.close(root, '2026-10-02-fa')
    const closed = L.excerpt(root, { branch: 'feat/a', coMod: false })
    assert.ok(!closed.includes('Sửa lỗi đăng nhập kiểu A') && !closed.includes('## Tính năng đang làm')) // đã xong, không nạp
    fs.writeFileSync(path.join(root, 'docs/specs/2026-10-02-fa/progress.md'), 'Trạng thái: đang làm\nNhánh / worktree: feat/a\n')
    const s = snap(root)
    const ex = L.excerpt(root, { branch: 'feat/a', coMod: false })
    const feat = section(ex, '## Tính năng đang làm: 2026-10-02-fa (2)')
    assert.ok(feat.includes(`- [${a1.ma.slice(0, 4)}] 📦 Sửa lỗi đăng nhập kiểu A`))
    assert.ok(feat.includes(`- [${a2.ma.slice(0, 4)}] ⚠️ A chờ xem`)) // ⚠️ không bị cất khi đóng (FA4)
    assert.ok(!ex.includes('B của tính năng khác'))
    assert.deepEqual(snap(root), s) // mở lại không đổi file nào
    assert.equal(L.scan(root).decisions.find((d) => d.ma === b1.ma).hien, 'dang-dung')
  })

  test('AC17 tim: gồm 📦 (đánh dấu), ↩️/✖ chỉ khi xem lịch sử; không phân biệt dấu/hoa; tìm cả trong thân; khớp tóm tắt xếp trước', () => {
    const { root, a1, a2, a3 } = setup()
    L.close(root, '2026-10-02-fa')
    const hits = L.tim(root, 'SUA LOI dang nhap')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].ma, a1.ma)
    assert.equal(hits[0].hien, 'da-cat')
    assert.ok(hits[0].dong.includes('📦') && hits[0].dong.startsWith(`- [${a1.ma.slice(0, 4)}]`))
    assert.ok(!('than' in hits[0]))
    assert.equal(L.tim(root, 'đã huỷ').length, 0)
    assert.equal(L.tim(root, 'đã huỷ', { lichSu: true })[0].ma, a3.ma)
    assert.equal(L.tim(root, 'token ngắn hạn')[0].ma, a1.ma) // chỉ có trong "Vì sao"
    assert.equal(L.tim(root, 'zzzqqq xyzw').length, 0)
    assert.deepEqual(L.tim(root, '   '), [])
    assert.equal(L.tim(root, `A chờ`)[0].ma, a2.ma)
    assert.ok(L.tim(root, 'a', { gioiHan: 2 }).length <= 2)
  })
})

describe('AC18 ROADMAP', () => {
  test('Đang làm / Cần xem lại / Đã xong 20 gần nhất + lưu trữ / Ý tưởng đếm + 20 mới nhất; quyết định ⚠️ vào Cần xem lại', () => {
    const root = repo()
    for (let i = 0; i < 25; i++) {
      const day = String(1 + i).padStart(2, '0')
      spec(root, `2026-08-${day}-xong-${day}`, `# Tiến độ: Việc ${day}\nTrạng thái: xong\nXong ngày: 2026-09-${day}\n`)
    }
    spec(root, '2026-10-01-dang-a', '# Tiến độ: Việc A\nTrạng thái: đang làm\nPha: 4 · thi công\nBước tiếp theo: làm X\n')
    spec(root, '2026-10-02-dang-b', '- **Trạng thái:** đang làm\n')
    spec(root, '2026-10-03-mo-ho', '# Không có dòng trạng thái\n')
    write(root, 'docs/specs/2026-10-04-chua-co-progress/SPEC.md', 'x')
    plant(root, { tom_tat: 'Chờ xem', trang_thai: 'cho-xem' })
    for (let i = 0; i < 30; i++) L.ghiYTuong(root, { loai: i % 2 ? 'tính năng' : 'cải tiến', noi_dung: `Ý tưởng ${String(i).padStart(2, '0')}` }, { now: Date.UTC(2026, 9, 1 + (i % 28)) })
    const { roadmap, roadmapLuuTru, index } = L.render(root)
    const sec = (title) => new RegExp(`## ${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(roadmap)[1].split('\n').filter((l) => l.startsWith('- '))
    const dang = sec('Đang làm')
    assert.equal(dang.length, 2)
    assert.equal(dang[0], '- 2026-10-02-dang-b')
    assert.equal(dang[1], '- 2026-10-01-dang-a — Việc A · 4 · thi công · tiếp: làm X')
    // R10: số trong tiêu đề = số tính năng (không đếm dòng quyết định ⚠️); lý do là tiêu đề nhóm; quyết định ⚠️ ở mục riêng
    assert.match(roadmap, /## Cần xem lại \(2\)\n/)
    assert.deepEqual(sec('Cần xem lại'), ['- 2026-10-04-chua-co-progress', '- 2026-10-03-mo-ho'])
    assert.match(roadmap, /### Chưa có sổ tiến độ \(1\)\n- 2026-10-04-chua-co-progress\n/)
    assert.match(roadmap, /### Không rõ trạng thái \(1\)\n- 2026-10-03-mo-ho\n/)
    assert.ok(roadmap.includes(`## Quyết định ⚠️ chờ xem lại (1)\n- xem ${INDEX}\n`), roadmap)
    const xong = sec('Đã xong')
    assert.equal(xong.length, 20)
    assert.equal(xong[0], '- 2026-09-25 · 2026-08-25-xong-25 — Việc 25') // mới xong trước
    assert.equal(xong[19], '- 2026-09-06 · 2026-08-06-xong-06 — Việc 06')
    assert.match(roadmap, /## Đã xong \(20 gần nhất \/ 25\)/)
    assert.match(roadmap, /\(còn 5 mục cũ hơn: docs\/ROADMAP-luu-tru\.md\)/)
    const luu = roadmapLuuTru.split('\n').filter((l) => l.startsWith('- '))
    assert.equal(luu.length, 5)
    assert.equal(luu[0], '- 2026-09-05 · 2026-08-05-xong-05 — Việc 05')
    assert.equal(luu[4], '- 2026-09-01 · 2026-08-01-xong-01 — Việc 01')
    assert.ok(xong.every((l) => !luu.includes(l)))
    assert.match(roadmap, /## Ý tưởng \(30 · 30 chưa làm\)/)
    assert.equal(sec('Ý tưởng').length, 20)
    assert.ok(read(root, 'docs/specs/2026-10-01-dang-a/progress.md')) // nguồn không bị đụng
    assert.ok(index.includes('# Sổ chốt'))
    // xong không rõ ngày ⇒ dùng ngày trong tên thư mục
    spec(root, '2026-07-07-khong-ngay', '# Tiến độ: Không ngày\nTrạng thái: xong\n')
    assert.ok(L.render(root).roadmapLuuTru.includes('- 2026-07-07 · 2026-07-07-khong-ngay — Không ngày'))
  })

  test('chưa có gì ⇒ vẫn ra INDEX + ROADMAP hợp lệ (ROADMAP: một câu, không mục rỗng); file lưu trữ rỗng thì không tạo', () => {
    const root = repo()
    const w = L.write(root)
    assert.deepEqual(w.ghi.sort(), [INDEX, 'docs/ROADMAP.md'].sort())
    const rm = read(root, 'docs/ROADMAP.md')
    assert.ok(rm.includes('# Roadmap\n\n(chưa có gì)\n'), rm)
    assert.ok(!rm.includes('(chưa có)') && !rm.includes('## Đang làm'), 'R10: bỏ mục rỗng')
    assert.ok(read(root, INDEX).includes('(chưa có)'))
  })

  test('R10 "Cần xem lại" chỉ đếm tính năng; lý do lặp gom thành tiêu đề nhóm; quyết định ⚠️ ở mục riêng; mục rỗng bị bỏ', () => {
    const root = repo()
    for (let i = 1; i <= 4; i++) write(root, `docs/specs/2026-10-0${i}-chua-${i}/SPEC.md`, 'x')
    spec(root, '2026-10-05-mo-ho', '# Mơ hồ\n')
    plant(root, { tom_tat: 'Chờ một', trang_thai: 'cho-xem' })
    plant(root, { tom_tat: 'Chờ hai', trang_thai: 'cho-xem' })
    const { roadmap } = L.render(root)
    assert.match(roadmap, /## Cần xem lại \(5\)\n/)
    assert.equal((roadmap.match(/chưa có sổ tiến độ/gi) ?? []).length, 1, 'lý do chỉ ghi một lần (tiêu đề nhóm)')
    assert.match(roadmap, /### Chưa có sổ tiến độ \(4\)\n(- [^\n]+\n){4}/)
    assert.match(roadmap, /### Không rõ trạng thái \(1\)\n- 2026-10-05-mo-ho\n/)
    assert.match(roadmap, /## Quyết định ⚠️ chờ xem lại \(2\)\n- xem /)
    assert.ok(!roadmap.includes('(chưa có)') && !roadmap.includes('## Đang làm') && !roadmap.includes('## Ý tưởng') && !roadmap.includes('## Đã xong'), roadmap)
    L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'Một ý' })
    assert.match(L.render(root).roadmap, /## Ý tưởng \(1 · 1 chưa làm\)\n- y-/)
  })
})

describe('FA6 ROADMAP', () => {
  const REL = 'docs/ROADMAP.md'
  const LUU = 'docs/ROADMAP-luu-tru.md'
  const done = (root, n) => { for (let i = 0; i < n; i++) spec(root, `2026-08-${String(1 + i).padStart(2, '0')}-xong-${i}`, `# Tiến độ: Việc ${i}\nTrạng thái: xong\nXong ngày: 2026-09-${String(1 + i).padStart(2, '0')}\n`) }

  test('"Cần xem lại" dùng lời người dùng, không nhắc file/máy ("progress.md")', () => {
    const root = repo()
    spec(root, '2026-10-03-mo-ho', '# Việc mơ hồ\nkhông có dòng trạng thái\n')
    write(root, 'docs/specs/2026-10-04-chua-co/SPEC.md', 'x')
    plant(root, { tom_tat: 'Chờ', trang_thai: 'cho-xem' })
    const { roadmap } = L.render(root)
    const xem = /## Cần xem lại[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(roadmap)[1]
    assert.ok(xem.includes('### Chưa có sổ tiến độ (1)\n- 2026-10-04-chua-co'))
    assert.ok(xem.includes('### Không rõ trạng thái (1)\n- 2026-10-03-mo-ho'))
    assert.ok(!/progress\.md|không rõ trạng thái trong/.test(roadmap), 'không còn lý do máy')
  })

  test('ROADMAP-luu-tru.md chỉ được ghi khi có mục (> 20 mục xong) hoặc file đã có sẵn; rỗng thì không tạo', () => {
    const root = repo()
    done(root, 20)
    L.write(root)
    assert.ok(exists(root, REL) && !exists(root, LUU), 'đúng 20 mục xong: chưa có gì để lưu trữ')
    done(root, 21)
    const w = L.write(root)
    assert.ok(w.ghi.includes(LUU))
    assert.ok(read(root, LUU).includes('## Đã xong cũ hơn (1)'))
    // quay về ≤ 20: file đã có thì cập nhật cho đúng (không để dữ liệu cũ), không xoá
    fs.rmSync(path.join(root, 'docs/specs/2026-08-21-xong-20'), { recursive: true })
    const w2 = L.write(root)
    assert.ok(w2.ghi.includes(LUU))
    assert.ok(read(root, LUU).includes('## Đã xong cũ hơn (0)\n(chưa có)'))
  })

  test('docs/ROADMAP.md viết tay (không có dòng tự sinh) ⇒ từ chối ghi đè và báo; file do so-chot sinh hoặc chưa có ⇒ ghi bình thường', () => {
    const root = repo()
    const hand = '# Roadmap của tôi\n\n- Làm A\n- Làm B\n'
    write(root, REL, hand)
    done(root, 21)
    L.ghi(root, { tom_tat: 'Điều' }) // ghi() gọi write(): không được đụng file viết tay
    assert.equal(read(root, REL), hand)
    const w = L.write(root)
    assert.deepEqual(w.bo_qua.map((b) => b.file), [REL])
    assert.match(w.bo_qua[0].ly_do, /viết tay/)
    assert.equal(read(root, REL), hand)
    assert.ok(exists(root, INDEX), 'INDEX vẫn sinh')
    assert.ok(!exists(root, LUU), 'ROADMAP bị từ chối thì file lưu trữ đi kèm cũng không tạo')
    const r = spawnSync(process.execPath, [SCRIPT, 'gen', root], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const g = JSON.parse(r.stdout)
    assert.deepEqual(g.bo_qua.map((b) => b.file), [REL])
    assert.ok(g.canh_bao.some((m) => m.includes(REL) && m.includes('viết tay')))
    assert.equal(read(root, REL), hand)
    // chưa có ⇒ tạo; đã do so-chot sinh (kể cả xuống dòng CRLF) ⇒ cập nhật khi nội dung đổi
    const r2 = repo()
    L.write(r2)
    assert.match(read(r2, REL).split('\n')[0], /^<!-- tự sinh bởi so-chot\.mjs/)
    fs.writeFileSync(path.join(r2, REL), read(r2, REL).replace(/\n/g, '\r\n'))
    spec(r2, '2026-10-02-moi', 'Trạng thái: đang làm\n')
    assert.ok(L.write(r2).ghi.includes(REL))
    assert.ok(read(r2, REL).includes('2026-10-02-moi'))
    // file rỗng: không phải nội dung của ai ⇒ ghi được
    const r3 = repo()
    write(r3, REL, '\n')
    assert.deepEqual(L.write(r3).bo_qua, [])
    assert.match(read(r3, REL), /^<!-- tự sinh/)
  })
})

describe('AC19–21 ý tưởng', () => {
  test('chỉ ghi thêm một dòng; mã y-xxxxxx; không tra trùng; không đụng ROADMAP/INDEX; file thiếu xuống dòng cuối vẫn đúng', () => {
    const root = repo()
    const a = L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'Xuất   PDF\nra file' }, { now: T_VN })
    assert.match(a.ma, /^y-[a-z0-9]{6}$/)
    assert.equal(a.line, `- ${a.ma} · 2026-10-02 · tính năng · Xuất PDF ra file`)
    assert.equal(read(root, 'docs/IDEAS.md'), `${a.line}\n`)
    assert.ok(!exists(root, 'docs/ROADMAP.md') && !exists(root, INDEX))
    const before = read(root, 'docs/IDEAS.md')
    const b = L.ghiYTuong(root, { loai: 'cai-tien', noi_dung: 'Xuất   PDF ra file' }, { now: T_VN }) // trùng nội dung, loại ASCII
    assert.notEqual(a.ma, b.ma)
    assert.equal(b.line, `- ${b.ma} · 2026-10-02 · cải tiến · Xuất PDF ra file`)
    assert.ok(read(root, 'docs/IDEAS.md').startsWith(before)) // chỉ ghi thêm
    fs.writeFileSync(path.join(root, 'docs/IDEAS.md'), `${read(root, 'docs/IDEAS.md').trimEnd()}\n- tay · không phải dòng ý tưởng`) // người sửa tay, thiếu \n cuối
    const c = L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'Ý ba' })
    assert.deepEqual(read(root, 'docs/IDEAS.md').split('\n').slice(-3), ['- tay · không phải dòng ý tưởng', c.line, ''])
    assert.throws(() => L.ghiYTuong(root, { loai: 'khác', noi_dung: 'x' }), /loại ý tưởng/)
    assert.throws(() => L.ghiYTuong(root, { loai: 'tính năng', noi_dung: '  ' }), /thiếu nội dung/)
    assert.match(read(root, '.gitattributes'), /docs\/IDEAS\.md merge=union/)
  })

  test('số ý tưởng = số mã khác nhau: sự kiện làm/bỏ nhiều lần, hai nhánh cùng triển khai, dòng lặp, mã lạ đều không đổi số đếm', () => {
    const root = repo()
    spec(root, '2026-10-05-a')
    spec(root, '2026-10-06-b')
    const i1 = L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'Một' })
    const i2 = L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'Một' })
    const count = () => Number(/## Ý tưởng \((\d+) · (\d+) chưa làm\)/.exec(L.render(root).roadmap)[1])
    assert.equal(count(), 2)
    assert.equal(L.suKienYTuong(root, i1.ma, { lam: '2026-10-05-a' }).ghi, true)
    assert.equal(L.suKienYTuong(root, i1.ma, { lam: '2026-10-06-b' }).ghi, true) // hai nhánh cùng làm: hai dòng, một mã
    assert.equal(L.suKienYTuong(root, i1.ma, { lam: '2026-10-05-a' }).ghi, false) // y hệt: không ghi lại
    assert.equal(L.suKienYTuong(root, i1.ma, { bo: true }).ghi, true)
    assert.equal(L.suKienYTuong(root, i1.ma, { bo: true }).ghi, false)
    fs.appendFileSync(path.join(root, 'docs/IDEAS.md'), `${i2.line}\n`) // dòng ý tưởng lặp (vd union merge)
    fs.appendFileSync(path.join(root, 'docs/IDEAS.md'), '- y-zzzzzz · 2026-10-02 · bỏ\n') // sự kiện của mã không tồn tại
    assert.equal(count(), 2)
    assert.deepEqual(read(root, 'docs/IDEAS.md').split('\n').filter((l) => l.includes(i1.ma)).map((l) => l.split(' · ').slice(2).join(' · ')), ['tính năng · Một', '→ 2026-10-05-a', '→ 2026-10-06-b', 'bỏ'])
    const road = L.render(root).roadmap
    assert.match(road, /## Ý tưởng \(2 · 1 chưa làm\)/)
    assert.ok(road.includes(`- ${i1.ma} · `) && road.includes(' · đã bỏ'))
    assert.throws(() => L.suKienYTuong(root, 'y-khongco', { bo: true }), /không có ý tưởng/)
    assert.throws(() => L.suKienYTuong(root, i2.ma, { lam: '../x' }), /không có thư mục tính năng/)
    assert.throws(() => L.suKienYTuong(root, i2.ma, { lam: '2026-10-05-a', bo: true }), /đúng một/)
    // làm xong rồi: ý tưởng hiện "→ <thư mục spec>" (AC20)
    L.suKienYTuong(root, i2.ma, { lam: '2026-10-06-b' })
    assert.ok(L.render(root).roadmap.includes(`- ${i2.ma} · `) && L.render(root).roadmap.includes('→ 2026-10-06-b'))
  })

  test('AC21 roadmap trong phần nạp đúng 1 dòng: số đang làm · số ý tưởng · tính năng đang làm', () => {
    const root = repo()
    spec(root, '2026-10-05-a', 'Trạng thái: đang làm\nNhánh / worktree: feat/a\n')
    spec(root, '2026-10-06-b', 'Trạng thái: đang làm\nNhánh / worktree: feat/b\n')
    spec(root, '2026-10-07-c', 'Trạng thái: xong\n')
    L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'Một' })
    L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'Hai' })
    L.ghiYTuong(root, { loai: 'tính năng', noi_dung: 'Ba' })
    assert.equal(L.excerpt(root, { branch: 'feat/b', coMod: false }), 'Roadmap: 2 đang làm · 3 ý tưởng · tính năng đang làm: 2026-10-06-b')
    assert.equal(L.excerpt(root, { branch: 'feat/zzz', coMod: false }), 'Roadmap: 2 đang làm · 3 ý tưởng · tính năng đang làm: không có')
    assert.equal(L.excerpt(root, { coMod: false }), 'Roadmap: 2 đang làm · 3 ý tưởng · tính năng đang làm: không có')
  })
})

describe('AC22b tính năng đang làm theo nhánh', () => {
  test('openProgress quét mọi thư mục (không giới hạn 50), bỏ sổ đã xong, khớp đúng nhánh, không khớp ⇒ null', () => {
    const root = repo()
    for (let i = 0; i < 60; i++) spec(root, `d${String(i).padStart(2, '0')}`, 'Trạng thái: xong\n')
    spec(root, 'd00', 'Trạng thái: đang làm\nNhánh / worktree: feat/cu, D:/AI/Vibe Coding/wt cũ\n', 30) // thư mục thứ 60 theo tên giảm dần, mtime cũ nhất
    const r = L.openProgress(root, 'feat/cu')
    assert.equal(r.feature, 'd00')
    assert.equal(r.rel, 'docs/specs/d00/progress.md')
    assert.equal(r.file, path.join(root, 'docs', 'specs', 'd00', 'progress.md'))
    assert.ok(r.mtimeMs > 0)
    assert.equal(L.openProgress(root, 'feat/khac'), null)
    assert.equal(L.openProgress(root, 'feat'), null) // tiền tố không phải khớp
    assert.equal(L.openProgress(root, ''), null)
    assert.equal(L.openProgress(root, undefined), null)
  })

  test('đã xong thì không khớp dù cùng nhánh; dạng markdown; một dòng nhiều nhánh', () => {
    const root = repo()
    spec(root, 'x1', 'Trạng thái: xong\nNhánh / worktree: feat/same\n')
    assert.equal(L.openProgress(root, 'feat/same'), null)
    spec(root, 'x2', '- **Nhánh / worktree:** `feat/md`\n- **Trạng thái:** đang làm\n')
    assert.equal(L.openProgress(root, 'feat/md').feature, 'x2')
    spec(root, 'x3', 'Trạng thái: đang làm\nNhánh / worktree: feat/p; feat/q, C:/wt\n')
    assert.equal(L.openProgress(root, 'feat/q').feature, 'x3')
    assert.equal(L.openProgress(root, 'feat/p').feature, 'x3')
  })

  test('R7 trường Nhánh / worktree dạng thật: tách theo , ; · và bóc backtick/nháy/khoảng trắng quanh TỪNG token', () => {
    const br = (v) => L.parseProgress(`# T\nTrạng thái: đang làm\nNhánh / worktree: ${v}\n`).branches
    assert.deepEqual(br('`feat/x` · `.claude/worktrees/x`'), ['feat/x', '.claude/worktrees/x'])
    assert.deepEqual(br('worktree-serp-providers · .claude/worktrees/serp-providers'), ['worktree-serp-providers', '.claude/worktrees/serp-providers'])
    assert.deepEqual(br('"feat/a" ; ‘feat/b’ ,  `feat/c`  ·D:/wt/c'), ['feat/a', 'feat/b', 'feat/c', 'D:/wt/c'])
    assert.ok(br('`feat/d` (worktree chính) · `D:/wt/d`').includes('feat/d'), 'từ đầu của token cũng được bóc backtick')
    assert.deepEqual(br('feat/p; feat/q, C:/wt'), ['feat/p', 'feat/q', 'C:/wt'])
    assert.deepEqual(br(''), [])

    const root = repo()
    spec(root, 'r7a', 'Trạng thái: đang làm\nNhánh / worktree: `feat/x` · `.claude/worktrees/x`\n')
    spec(root, 'r7b', 'Trạng thái: đang làm\nNhánh / worktree: `feat/other` · `.claude/worktrees/other`\n', 3)
    L.ghi(root, { tom_tat: 'Điều của X', pham_vi: 'r7a' })
    L.ghi(root, { tom_tat: 'Điều của Other', pham_vi: 'r7b' })
    assert.equal(L.openProgress(root, 'feat/x').feature, 'r7a')
    assert.equal(L.openProgress(root, '.claude/worktrees/x').feature, 'r7a')
    for (const b of ['feat/x', ' feat/x ', 'feat/x\n']) {
      const ex = L.excerpt(root, { branch: b, coMod: false })
      assert.ok(ex.includes('## Tính năng đang làm: r7a (1)') && ex.includes('Điều của X') && !ex.includes('Điều của Other'), `excerpt nhánh ${JSON.stringify(b)}:\n${ex}`)
      assert.equal(L.openProgress(root, b).feature, 'r7a', `openProgress nhánh ${JSON.stringify(b)}`)
    }
    assert.ok(!L.excerpt(root, { branch: '   ', coMod: false }).includes('## Tính năng đang làm'), 'nhánh toàn khoảng trắng ⇒ như không biết nhánh')
  })

  test('hai tính năng mở ở hai nhánh: mỗi phiên nạp đúng tính năng của nhánh mình; nhánh lạ ⇒ không đoán, chỉ liệt kê sổ đang mở', () => {
    const root = repo()
    spec(root, '2026-10-01-a', 'Trạng thái: đang làm\nNhánh / worktree: feat/a\n', 5)
    spec(root, '2026-10-02-b', 'Trạng thái: đang làm\nNhánh / worktree: feat/b\n', 0) // b mới hơn: không được lấn a
    L.ghi(root, { tom_tat: 'Luật chung' })
    L.ghi(root, { tom_tat: 'Điều của A', pham_vi: '2026-10-01-a' })
    L.ghi(root, { tom_tat: 'Điều của B', pham_vi: '2026-10-02-b' })
    assert.equal(L.openProgress(root, 'feat/a').feature, '2026-10-01-a')
    assert.equal(L.openProgress(root, 'feat/b').feature, '2026-10-02-b')
    const exA = L.excerpt(root, { branch: 'feat/a', coMod: false })
    const exB = L.excerpt(root, { branch: 'feat/b', coMod: false })
    assert.ok(exA.includes('Điều của A') && !exA.includes('Điều của B') && exA.includes('Luật chung'))
    assert.ok(exB.includes('Điều của B') && !exB.includes('Điều của A') && exB.includes('Luật chung'))
    const none = L.excerpt(root, { branch: 'feat/lạ', coMod: false })
    assert.ok(!none.includes('Điều của A') && !none.includes('Điều của B') && !none.includes('## Tính năng đang làm'))
    assert.match(none, /Sổ tiến độ đang mở \(nhánh này chưa gắn sổ nào\): 2026-10-02-b, 2026-10-01-a/)
    assert.ok(!L.excerpt(root, { coMod: false }).includes('Điều của A')) // không biết nhánh ⇒ không đoán
  })
})

describe('ensureGitattributes', () => {
  test('tạo đủ 4 dòng merge=union; idempotent; giữ nguyên nội dung và kiểu xuống dòng có sẵn; git nhận đúng thuộc tính', () => {
    const root = repo()
    assert.equal(L.ensureGitattributes(root).changed, true)
    const t1 = read(root, '.gitattributes')
    assert.deepEqual(t1.split('\n').filter(Boolean).sort(), [
      '.claude/so-chot/INDEX.md merge=union', 'docs/IDEAS.md merge=union', 'docs/ROADMAP-luu-tru.md merge=union', 'docs/ROADMAP.md merge=union',
    ])
    assert.deepEqual(L.ensureGitattributes(root), { changed: false })
    assert.equal(read(root, '.gitattributes'), t1)
    for (const f of [INDEX, 'docs/ROADMAP.md', 'docs/ROADMAP-luu-tru.md', 'docs/IDEAS.md']) assert.match(gitOk(root, 'check-attr', 'merge', '--', f), /merge: union/)

    const r2 = repo()
    fs.writeFileSync(path.join(r2, '.gitattributes'), '* text=auto eol=lf\r\ndocs/IDEAS.md merge=union')
    assert.equal(L.ensureGitattributes(r2).changed, true)
    const t2 = read(r2, '.gitattributes')
    assert.ok(t2.startsWith('* text=auto eol=lf\r\ndocs/IDEAS.md merge=union\r\n'))
    assert.equal((t2.match(/IDEAS/g) ?? []).length, 1)
    assert.equal(t2.split('\r\n').filter(Boolean).length, 5)
  })
})

describe('CLI', () => {
  const run = (cmd, root, arg, input) => spawnSync(process.execPath, [SCRIPT, cmd, root, ...(arg === undefined ? [] : [arg])], { encoding: 'utf8', input })
  const ok = (r) => { assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); return JSON.parse(r.stdout) }

  test('ghi / tim / da-xem / huy / y-tuong / excerpt / gen / close in JSON, exit 0', () => {
    const root = repo()
    spec(root, '2026-10-02-cli', 'Trạng thái: đang làm\nNhánh / worktree: feat/cli\n')
    const d = ok(run('ghi', root, JSON.stringify({ tom_tat: 'Dùng pnpm', vi_sao: 'nhanh', ai_quyet: 'tu-chon-khi-vang' })))
    assert.equal(d.trang_thai, 'cho-xem')
    assert.ok(!('than' in d))
    const d2 = ok(run('ghi', root, '-', JSON.stringify({ tom_tat: 'Qua stdin', pham_vi: '2026-10-02-cli' })))
    assert.equal(d2.pham_vi, '2026-10-02-cli')
    assert.equal(ok(run('tim', root, JSON.stringify({ query: 'pnpm' })))[0].ma, d.ma)
    assert.equal(ok(run('tim', root, 'qua stdin'))[0].ma, d2.ma)
    assert.equal(ok(run('da-xem', root, JSON.stringify({ ma: d.ma.slice(0, 5) }))).trang_thai, 'dang-dung')
    const y = ok(run('y-tuong', root, JSON.stringify({ loai: 'tính năng', noi_dung: 'Xuất PDF' })))
    assert.match(y.ma, /^y-/)
    assert.equal(ok(run('y-tuong', root, JSON.stringify({ ma: y.ma, lam: '2026-10-02-cli' }))).ghi, true)
    const ex = ok(run('excerpt', root, JSON.stringify({ branch: 'feat/cli', coMod: false })))
    assert.ok(ex.text.includes('Dùng pnpm') && ex.text.includes('Qua stdin') && ex.text.includes('Roadmap: 1 đang làm · 1 ý tưởng'))
    const g = ok(run('gen', root))
    assert.deepEqual(g.canh_bao, [])
    assert.deepEqual(g.bo_qua, [])
    assert.equal(ok(run('huy', root, d.ma)).trang_thai, 'da-huy')
    const c = ok(run('close', root, '2026-10-02-cli'))
    assert.deepEqual(c.cat, [d2.ma])
    assert.equal(ok(run('close', root, JSON.stringify({ feature: '2026-10-02-cli' }))).cat.length, 0)
  })

  test('lỗi ⇒ exit 1 + đúng một dòng stderr, stdout rỗng', () => {
    const root = repo()
    for (const r of [
      run('ghi', root, JSON.stringify({ tom_tat: 'x', pham_vi: '../x' })),
      run('ghi', root, JSON.stringify({})),
      run('da-xem', root, 'zzzz'),
      run('close', root, 'chung'),
      run('khong-co-lenh', root),
      run('ghi', path.join(root, 'khong-co'), JSON.stringify({ tom_tat: 'x' })),
      run('gen'),
    ]) {
      assert.equal(r.status, 1)
      assert.equal(r.stdout, '')
      assert.match(r.stderr, /^lỗi: [^\n]+\n$|^lỗi: dùng: [^\n]+\n$/)
    }
    assert.equal(exists(root, '.claude'), false)
  })
})
