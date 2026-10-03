// Test cho lib/legacy-migrate.mjs: node --test ~/.claude/hooks/lib/legacy-migrate.test.mjs
// Mọi thứ chạy trong os.tmpdir: repo git tạm mô phỏng tên kiểu 1Scout (ai-agent vs ai-agent-gaps-2…) + HOME/USERPROFILE giả.
// Không đọc/ghi ~/.claude thật và không đụng bất kỳ dự án thật nào.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-migrate-test-')))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME)
process.env.HOME = HOME
process.env.USERPROFILE = HOME
if (path.resolve(os.homedir()) !== path.resolve(HOME)) throw new Error(`HOME giả không có hiệu lực (${os.homedir()}): dừng để khỏi đụng ~/.claude thật`)
const GITCONF = path.join(TMP, 'gitconfig')
fs.writeFileSync(GITCONF, '[user]\n\tname = t\n\temail = t@t.t\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n')
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k]
process.env.GIT_CONFIG_GLOBAL = GITCONF
process.env.GIT_CONFIG_NOSYSTEM = '1'

const L = await import('./so-chot.mjs')
const M = await import('./legacy-migrate.mjs')
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'legacy-migrate.mjs')

after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const git = (cwd, args, env = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
function gitOk(cwd, ...args) {
  const r = git(cwd, args)
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}${r.stdout}`)
  return r.stdout
}
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (root, rel) => fs.existsSync(path.join(root, rel))
const commitAll = (root, msg, iso) => { gitOk(root, 'add', '-A'); const r = git(root, ['commit', '-q', '-m', msg], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }); assert.equal(r.status, 0, r.stderr) }
const nCommits = (root) => Number(gitOk(root, 'rev-list', '--count', 'HEAD').trim())
const porcelain = (root) => gitOk(root, 'status', '--porcelain').trim()
const readPlan = (root) => JSON.parse(read(root, '.claude/so-chot/.migrate-plan.json'))
const savePlan = (root, p) => write(root, '.claude/so-chot/.migrate-plan.json', JSON.stringify(p, null, 2))
const migrated = (root) => L.scan(root).decisions.filter((d) => d.ai_quyet === 'chuyen-tu-so-cu')
const byTomTat = (root, part) => { const r = migrated(root).filter((d) => d.tom_tat.includes(part)); assert.equal(r.length, 1, `${part}: ${r.length}`); return r[0] }

// ---------- dữ liệu mô phỏng ----------

const DEC_AGENT = `# Quyết định: AI agent

Các điều đã chốt với user:

- **Chốt:** dùng Gemini 3.8 Flash cho tác vụ rẻ
- Không cho agent tự gửi email
  khi chưa có duyệt của user
- Giới hạn 5 lượt gọi tool mỗi phiên
`
const DEC_GAPS = `# Gaps 2

1. Thêm kiểm tra quyền trước khi chạy tool
2. Log mọi lần agent gọi API ngoài
`
const DEC_SEO = `# SEO audit

| # | Quyết định | Lý do |
|---|---|---|
| 1 | Quét tối đa 200 URL | giới hạn chi phí |
| 2 | Bỏ qua trang noindex | tránh nhiễu |
`
const PROG_AGENT = '# Tiến độ: AI agent\nTrạng thái: xong\nXong ngày: 2026-03-20\nNhánh / worktree: feat/ai-agent\nĐã chốt:\n- dùng Gemini\n- không email\n'
const PROG_GAPS = '# Tiến độ: AI agent gaps 2\nTrạng thái: đang làm\nBước tiếp theo: viết test\nNhánh / worktree: feat/gaps-2\n'
const PROG_SEO = '# Tiến độ: SEO audit\nGhi chú: chưa rõ làm tới đâu\n'

// [ngày commit, { file: nội dung }]
const HISTORY = [
  ['2026-03-01T10:00:00+07:00', { '.claude/plans/ai-agent.plan.md': '# Plan AI agent\n', '.claude/plans/ai-agent.decisions.md': DEC_AGENT }],
  ['2026-03-20T10:00:00+07:00', { '.claude/plans/ai-agent.progress.md': PROG_AGENT }],
  ['2026-03-22T10:00:00+07:00', { '.claude/reports/ai-agent-review.md': '# Review AI agent\n' }],
  ['2026-04-10T10:00:00+07:00', {
    '.claude/plans/ai-agent-gaps-2.plan.md': '# Plan gaps 2\n', '.claude/plans/ai-agent-gaps-2.decisions.md': DEC_GAPS, '.claude/plans/ai-agent-gaps-2.progress.md': PROG_GAPS,
  }],
  ['2026-04-20T10:00:00+07:00', { '.claude/reports/ai-agent-gaps-2-review.md': '# Review gaps 2\n' }],
  ['2026-04-21T10:00:00+07:00', { '.claude/reports/ai-agent-gaps-review.md': '# Review gaps (không rõ thuộc cái nào)\n' }],
  ['2026-05-05T10:00:00+07:00', { '.claude/plans/seo-audit.plan.md': '# Plan SEO\n', '.claude/plans/seo-audit.decisions.md': DEC_SEO, '.claude/plans/seo-audit.progress.md': PROG_SEO }],
  ['2026-06-01T10:00:00+07:00', { '.claude/plans/billing.plan.md': '# Plan billing\n' }],
  ['2026-06-02T10:00:00+07:00', { '.claude/plans/random-ideas.md': 'ý tưởng linh tinh\n' }],
  ['2026-06-03T10:00:00+07:00', { '.claude/reports/weekly-summary.md': 'tổng kết tuần\n', '.claude/reports/seo-extra.md': 'seo phụ\n' }],
]
const N_FILES = 16
// R9: tóm tắt nói nội dung: "Quyết định cũ của <tính năng>: <ý đầu> (+N ý)"
const TT_AGENT = 'Quyết định cũ của ai-agent: Chốt: dùng Gemini 3.8 Flash cho tác vụ rẻ (+2 ý)'
const TT_GAPS = 'Quyết định cũ của ai-agent-gaps-2: Thêm kiểm tra quyền trước khi chạy tool (+1 ý)'
const TT_SEO = 'Quyết định cũ của seo-audit: 1 · Quét tối đa 200 URL · giới hạn chi phí (+1 ý)'
const N_ITEMS = 3 // FC5: mỗi file decisions = một quyết định (3 file: ai-agent 3 ý, gaps-2 2 ý, seo-audit 2 ý)
const N_Y = 7
const AGENT_DIR = '2026-03-01-ai-agent'
const GAPS_DIR = '2026-04-10-ai-agent-gaps-2'
const SEO_DIR = '2026-05-05-seo-audit'
const BILLING_DIR = '2026-06-01-billing'

let seq = 0
function legacyRepo() {
  const root = path.join(TMP, `repo-${++seq}`)
  fs.mkdirSync(root, { recursive: true })
  gitOk(root, 'init', '-q', '-b', 'main')
  write(root, 'src/app.txt', 'app\n')
  commitAll(root, 'init', '2026-02-01T09:00:00+07:00')
  for (const [iso, files] of HISTORY) {
    for (const [rel, text] of Object.entries(files)) write(root, rel, text)
    commitAll(root, `legacy ${iso}`, iso)
  }
  return fs.realpathSync(root)
}
// Trả lời dòng không chắc rồi (nếu cần) chạy plan.
function planned() {
  const root = legacyRepo()
  const out = M.plan(root)
  const p = readPlan(root)
  for (const r of p.dong) if (r.can_hoi) r.chon = 'ai-agent-gaps-2'
  savePlan(root, p)
  return { root, out, base: nCommits(root) }
}
function applied() {
  const ctx = planned()
  ctx.res = M.apply(ctx.root)
  return ctx
}
function assertFinal(root, base) {
  assert.equal(nCommits(root), base + 2, 'đúng 2 commit mới')
  assert.equal(porcelain(root), '', 'working tree sạch sau khi chuyển')
  assert.equal(migrated(root).length, N_ITEMS, 'đủ quyết định, không trùng')
  const v = M.verify(root)
  assert.ok(v.ok, JSON.stringify(v.loi))
  assert.equal(v.nguon_decisions, N_ITEMS)
  assert.equal(v.dich_quyet_dinh, N_ITEMS)
  assert.equal(v.so_y, N_Y)
}

// ---------- tách ý ----------

describe('parseItems', () => {
  const texts = (s) => M.parseItems(s).items.map((i) => i.text)
  test('gạch đầu dòng + đánh số + dòng nối tiếp/thụt vào + khối code; dòng chữ ngoài ý được đếm', () => {
    const r = M.parseItems('# T\n\nlời mở\n\n- một\n  tiếp theo\n- hai\n\n  đoạn thụt vào\n1) ba\n```js\n- không phải ý\n```\n* bốn\n')
    assert.deepEqual(r.items.map((i) => i.text), ['- một\n  tiếp theo', '- hai\n\n  đoạn thụt vào', '1) ba\n```js\n- không phải ý\n```', '* bốn'])
    assert.equal(r.ngoai, 1)
  })
  test('CRLF, BOM và front matter không làm lệch', () => {
    assert.deepEqual(texts('﻿---\na: b\n---\r\n- x\r\n- y\r\n'), ['- x', '- y'])
  })
  test('bảng markdown: bỏ dòng tiêu đề và dòng ngăn cách, mỗi dòng dữ liệu một ý', () => {
    assert.deepEqual(texts(DEC_SEO), ['| 1 | Quét tối đa 200 URL | giới hạn chi phí |', '| 2 | Bỏ qua trang noindex | tránh nhiễu |'])
  })
  test('không có mục nào ⇒ mỗi đoạn dưới tiêu đề ##, rồi mỗi đoạn văn', () => {
    assert.deepEqual(texts('# T\n## Một\nnội dung 1\n## Hai\nnội dung 2\n## Rỗng\n'), ['## Một\nnội dung 1', '## Hai\nnội dung 2'])
    assert.deepEqual(texts('# T\n\nđoạn a\ndòng 2\n\nđoạn b\n'), ['đoạn a\ndòng 2', 'đoạn b'])
    assert.deepEqual(texts(''), [])
  })
})

// ---------- plan (AC25) ----------

describe('plan', () => {
  test('ghép theo tiền tố: ai-agent ≠ ai-agent-gaps-2; có độ chắc; dòng không chắc vào cần-hỏi; không thuộc tính năng ⇒ legacy; không di chuyển gì', () => {
    const root = legacyRepo()
    const before = gitOk(root, 'ls-files')
    const out = M.plan(root)
    assert.equal(out.tong, N_FILES)
    assert.equal(out.tinh_nang, 4)
    assert.equal(out.tu_ghep, N_FILES - 1)
    assert.equal(out.legacy, 3)
    assert.deepEqual(out.can_hoi.map((c) => c.nguon), ['.claude/reports/ai-agent-gaps-review.md'])
    assert.deepEqual(out.can_hoi[0].ung_vien.sort(), ['ai-agent', 'ai-agent-gaps-2'])

    const p = readPlan(root)
    const row = (n) => p.dong.find((r) => r.nguon.endsWith(`/${n}`))
    assert.equal(row('ai-agent.plan.md').tinh_nang, 'ai-agent')
    assert.equal(row('ai-agent-gaps-2.plan.md').tinh_nang, 'ai-agent-gaps-2')
    assert.equal(row('ai-agent-gaps-2.decisions.md').tinh_nang, 'ai-agent-gaps-2', 'tên chính xác, không bị nuốt vào ai-agent')
    assert.equal(row('ai-agent-gaps-2.decisions.md').do_chac, 'cao')
    assert.equal(row('ai-agent-review.md').tinh_nang, 'ai-agent')
    assert.equal(row('ai-agent-review.md').do_chac, 'cao')
    const vua = row('ai-agent-gaps-2-review.md')
    assert.equal(vua.tinh_nang, 'ai-agent-gaps-2')
    assert.equal(vua.do_chac, 'cao', 'FC2: <slug>-review với slug là tính năng có thật ⇒ tên chỉ rõ tính năng')
    assert.equal(vua.can_hoi, false)
    const hoi = row('ai-agent-gaps-review.md')
    assert.equal(hoi.do_chac, 'thap')
    assert.equal(hoi.can_hoi, true)
    assert.equal(hoi.tinh_nang, null)
    assert.equal(hoi.chon, null)
    for (const n of ['random-ideas.md', 'weekly-summary.md', 'seo-extra.md']) {
      assert.equal(row(n).tinh_nang, null, n)
      assert.equal(row(n).can_hoi, false, n)
      assert.match(row(n).dich, /^docs\/legacy\//, n)
    }
    assert.equal(row('ai-agent.decisions.md').so_y, 3)
    assert.match(row('ai-agent.decisions.md').ghi_chu, /1 dòng chữ nằm ngoài/)
    assert.equal(row('seo-audit.decisions.md').so_y, 2)
    assert.equal(row('ai-agent.plan.md').dich, `docs/specs/${AGENT_DIR}/PLAN.md`)
    assert.equal(row('ai-agent.decisions.md').dich, `docs/specs/${AGENT_DIR}/notes/decisions.md`)
    assert.equal(row('ai-agent.progress.md').dich, `docs/specs/${AGENT_DIR}/progress.md`)
    assert.equal(row('ai-agent-review.md').dich, `docs/specs/${AGENT_DIR}/notes/ai-agent-review.md`)

    // ngày thư mục = lần commit đầu của nhóm (giờ VN)
    assert.deepEqual(Object.fromEntries(Object.entries(p.tinh_nang).map(([k, v]) => [k, v.thu_muc])), {
      'ai-agent': AGENT_DIR, 'ai-agent-gaps-2': GAPS_DIR, billing: BILLING_DIR, 'seo-audit': SEO_DIR,
    })
    assert.deepEqual(p.tinh_nang['ai-agent-gaps-2'].gan, ['ai-agent'])
    assert.equal(p.tinh_nang['ai-agent'].nguon_ngay, 'git')

    // không di chuyển, không sửa gì: chỉ có file bảng mới (chưa theo dõi)
    assert.equal(gitOk(root, 'ls-files'), before)
    assert.equal(porcelain(root), '?? .claude/so-chot/')
    assert.ok(exists(root, '.claude/plans/ai-agent.plan.md') && !exists(root, 'docs'))
  })

  test('lập lại bảng giữ câu trả lời đã điền (khớp nguồn + băm); sau khi chuyển thì từ chối lập lại', () => {
    const { root } = planned()
    const again = M.plan(root)
    assert.equal(again.can_hoi.length, 0, 'câu trả lời được giữ')
    assert.equal(readPlan(root).dong.find((r) => r.can_hoi).chon, 'ai-agent-gaps-2')
    M.apply(root)
    assert.throws(() => M.plan(root), /đã chuyển rồi/)
  })

  test('tên có ngày, hoa/thường, dấu cách vẫn ghép đúng; thư mục con và file không phải .md chỉ được báo', () => {
    const root = path.join(TMP, `repo-${++seq}`)
    fs.mkdirSync(root, { recursive: true })
    gitOk(root, 'init', '-q', '-b', 'main')
    write(root, '.claude/plans/2026-01-05-Thanh-Toán.plan.md', '# x\n')
    write(root, '.claude/reports/thanh-toan-kiem-tra.md', 'r\n')
    write(root, '.claude/plans/old/a.md', 'sub\n')
    write(root, '.claude/plans/ghi-chu.txt', 'txt\n')
    commitAll(root, 'x', '2026-01-05T08:00:00+07:00')
    const out = M.plan(fs.realpathSync(root))
    const p = readPlan(root)
    assert.deepEqual(Object.keys(p.tinh_nang), ['thanh-toan'])
    assert.equal(p.dong.find((r) => r.nguon.endsWith('kiem-tra.md')).tinh_nang, 'thanh-toan')
    assert.equal(out.canh_bao.filter((c) => /thư mục con|không phải \.md/.test(c)).length, 2)
  })
})

// ---------- apply (AC26, 27) ----------

describe('apply', () => {
  test('còn dòng chưa trả lời ⇒ từ chối, không đổi gì', () => {
    const root = legacyRepo()
    M.plan(root)
    const base = nCommits(root)
    assert.throws(() => M.apply(root), /chưa duyệt xong.*ai-agent-gaps-review\.md.*chưa trả lời/)
    assert.equal(nCommits(root), base)
    assert.ok(exists(root, '.claude/plans/ai-agent.plan.md') && !exists(root, 'docs') && !exists(root, '.claude/so-chot/.migrated.json'))
  })

  test('đáp án sai bị chặn: tính năng không có, decisions đi legacy, "chung" cho file không phải decisions', () => {
    for (const [nguon, chon, re] of [
      ['ai-agent-gaps-review.md', 'khong-co', /không có tính năng "khong-co"/],
      ['ai-agent.decisions.md', 'legacy', /decisions không đi legacy/],
      ['ai-agent.plan.md', 'chung', /chỉ dành cho file decisions/],
    ]) {
      const { root } = planned()
      const p = readPlan(root)
      p.dong.find((r) => r.nguon.endsWith(`/${nguon}`)).chon = chon
      savePlan(root, p)
      assert.throws(() => M.apply(root), re)
      assert.ok(exists(root, '.claude/plans/ai-agent.plan.md'), 'chưa dời gì')
    }
  })

  test('hai commit tách: (1) toàn git mv nguyên trạng R100, (2) chuyển nội dung không đổi tên; quyết định ⚠️ đúng phạm vi; progress; INDEX/ROADMAP', () => {
    const { root, base, res } = applied()
    assert.equal(res.di_chuyen, N_FILES)
    assert.equal(res.quyet_dinh_moi, N_ITEMS)
    assertFinal(root, base)

    const J = JSON.parse(read(root, '.claude/so-chot/.migrated.json'))
    const c1 = gitOk(root, 'show', '--name-status', '--format=', '-M', J.commit1).trim().split('\n')
    assert.equal(c1.length, N_FILES)
    assert.ok(c1.every((l) => l.startsWith('R100\t')), c1.join('\n'))
    assert.ok(c1.includes(`R100\t.claude/plans/ai-agent-gaps-2.decisions.md\tdocs/specs/${GAPS_DIR}/notes/decisions.md`))
    assert.ok(c1.includes(`R100\t.claude/reports/ai-agent-gaps-review.md\tdocs/specs/${GAPS_DIR}/notes/ai-agent-gaps-review.md`), 'dòng đã trả lời vào đúng tính năng')
    assert.ok(c1.includes('R100\t.claude/reports/weekly-summary.md\tdocs/legacy/weekly-summary.md'))
    assert.equal(gitOk(root, 'rev-parse', 'HEAD~1').trim(), J.commit1)
    const c2 = gitOk(root, 'show', '--name-status', '--format=', '-M', 'HEAD').trim().split('\n')
    assert.ok(c2.every((l) => /^[AM]\t/.test(l)), c2.join('\n'))
    for (const f of ['.claude/so-chot/.migrated.json', '.claude/so-chot/INDEX.md', 'docs/ROADMAP.md', '.gitattributes']) assert.ok(c2.some((l) => l.endsWith(`\t${f}`)), f)
    assert.ok(c2.some((l) => l === `M\tdocs/specs/${AGENT_DIR}/progress.md`))
    assert.ok(!exists(root, '.claude/plans/ai-agent.plan.md') && !exists(root, '.claude/reports/weekly-summary.md'))

    // FC5: file nguồn giữ nguyên byte trong notes/, mỗi FILE decisions một quyết định ⚠️ đúng phạm vi (không còn mỗi ý một quyết định)
    assert.equal(read(root, `docs/specs/${AGENT_DIR}/notes/decisions.md`), DEC_AGENT)
    const want = [
      [TT_AGENT, AGENT_DIR], [TT_GAPS, GAPS_DIR], [TT_SEO, SEO_DIR],
    ]
    for (const [tt, dir] of want) {
      const d = byTomTat(root, tt)
      assert.equal(d.tom_tat, tt)
      assert.equal(d.pham_vi, dir, tt)
      assert.equal(d.hien, 'cho-xem', tt)
      assert.equal(d.luc, `${dir.slice(0, 10)} 10:00`, 'luc = lần commit đầu của file nguồn (giờ VN)')
      assert.ok(d.file.startsWith(`${dir}/`), d.file)
    }
    const dAgent = byTomTat(root, TT_AGENT)
    for (const y of ['Chốt: dùng Gemini 3.8 Flash cho tác vụ rẻ', 'Không cho agent tự gửi email', 'Giới hạn 5 lượt gọi tool mỗi phiên']) assert.ok(dAgent.than.includes(y), y)
    assert.ok(dAgent.than.includes(`[notes/decisions.md](../../../docs/specs/${AGENT_DIR}/notes/decisions.md)`), 'link tới bản gốc')

    const prog = read(root, `docs/specs/${AGENT_DIR}/progress.md`)
    assert.ok(prog.includes(`Sổ chốt (chuyển từ sổ cũ): .claude/so-chot/${AGENT_DIR}/ — 1 điều ⚠️ chờ xem lại`))
    assert.ok(prog.includes('Đã chốt:\n- dùng Gemini\n- không email'), 'phần cũ giữ nguyên (AC23)')
    assert.ok(!exists(root, `docs/specs/${BILLING_DIR}/progress.md`), 'không bịa progress.md')

    // AC27: ROADMAP sinh từ thư mục tính năng; không rõ trạng thái ⇒ Cần xem lại
    const rm = read(root, 'docs/ROADMAP.md')
    const sec = (title) => new RegExp(`## ${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(rm)[1]
    assert.match(sec('Đang làm'), new RegExp(GAPS_DIR))
    assert.match(sec('Đã xong'), new RegExp(`2026-03-20 · ${AGENT_DIR}`))
    // R10: số trong tiêu đề = số tính năng; lý do gom thành tiêu đề nhóm; quyết định ⚠️ ở mục riêng
    assert.match(rm, /## Cần xem lại \(2\)\n/)
    assert.match(sec('Cần xem lại'), new RegExp(`### Không rõ trạng thái \\(1\\)\\n- ${SEO_DIR}`))
    assert.match(sec('Cần xem lại'), new RegExp(`### Chưa có sổ tiến độ \\(1\\)\\n- ${BILLING_DIR}`))
    assert.match(rm, /## Quyết định ⚠️ chờ xem lại \(3\)\n- xem \.claude\/so-chot\/INDEX\.md/)
    const idx = read(root, '.claude/so-chot/INDEX.md')
    assert.ok(idx.includes(`## ⚠️ Chờ xem lại (${N_ITEMS})`), 'INDEX nhóm ⚠️ ở đầu, mỗi file decisions một dòng')
    for (const d of migrated(root)) assert.ok(idx.includes(`[${d.ma.slice(0, 4)}](`), `INDEX có dòng của ${d.ma}`)
    assert.match(read(root, '.gitattributes'), /INDEX\.md merge=union/)

    // nhật ký băm nguồn
    for (const f of ['.claude/plans/ai-agent.plan.md', '.claude/plans/seo-audit.decisions.md']) assert.match(J.nguon[f].sha, /^[0-9a-f]{40}$/)
    assert.equal(Object.keys(J.y).length, N_ITEMS)
  })

  test('chạy lại sau khi đã xong: không thêm commit, không thêm file, không nhân đôi', () => {
    const { root, base } = applied()
    const files = gitOk(root, 'ls-files')
    const again = M.apply(root)
    assert.equal(again.da_xong, true)
    assert.equal(again.commit2, null)
    assert.equal(again.quyet_dinh_moi, 0)
    assert.equal(nCommits(root), base + 2)
    assert.equal(gitOk(root, 'ls-files'), files)
    assertFinal(root, base)
  })

  const STOPS = ['mv:2', 'commit1', 'ghi:0', 'ghi:2', 'tro', 'tro-xong', 'progress', 'journal', 'write', 'commit2']
  for (const stop of STOPS) {
    test(`bị ngắt tại "${stop}" rồi chạy lại: kết quả y hệt chạy một mạch, không bản trùng`, () => {
      const { root, base } = planned()
      assert.throws(() => M.apply(root, { onBuoc: (b) => { if (b === stop) throw new Error('ngắt thử') } }), /ngắt thử/)
      const mid = M.apply(root)
      assert.equal(mid.commit2 !== null || mid.da_xong, true)
      assertFinal(root, base)
      const keys = migrated(root).map((d) => /băm ([0-9a-f]{40})/.exec(d.than)[1])
      assert.equal(new Set(keys).size, N_ITEMS, 'mỗi file decisions nguồn đúng một quyết định')
    })
  }

  test('nguồn đổi sau khi lập bảng ⇒ từ chối, không dời gì', () => {
    const { root, base } = planned()
    fs.appendFileSync(path.join(root, '.claude/plans/ai-agent.decisions.md'), '- thêm ý mới\n')
    assert.throws(() => M.apply(root), /ai-agent\.decisions\.md đã đổi sau khi lập bảng/)
    assert.equal(nCommits(root), base)
    assert.ok(!exists(root, 'docs'))
  })

  test('index git có file ngoài việc chuyển ⇒ từ chối trước khi dời; không cuốn file lạ vào commit', () => {
    const { root, base } = planned()
    write(root, 'src/app.txt', 'đã sửa\n')
    gitOk(root, 'add', 'src/app.txt')
    assert.throws(() => M.apply(root), /index git đang có file ngoài việc chuyển \(src\/app\.txt\)/)
    assert.ok(exists(root, '.claude/plans/ai-agent.plan.md'))
    gitOk(root, 'reset', '-q')
    gitOk(root, 'checkout', '--', 'src/app.txt')
    M.apply(root)
    assertFinal(root, base)
  })

  test('file nguồn chưa được git theo dõi vẫn chuyển được (commit 1 ghi là thêm mới) và verify chấp nhận', () => {
    const root = legacyRepo()
    write(root, '.claude/plans/ai-agent.research.md', '# nghiên cứu chưa commit\n')
    const base = nCommits(root)
    const out = M.plan(root)
    assert.ok(out.canh_bao.some((c) => /chưa được git theo dõi/.test(c)))
    const p = readPlan(root)
    for (const r of p.dong) if (r.can_hoi) r.chon = 'ai-agent'
    savePlan(root, p)
    M.apply(root)
    assert.equal(read(root, `docs/specs/${AGENT_DIR}/research.md`), '# nghiên cứu chưa commit\n')
    assert.equal(nCommits(root), base + 2)
    assert.equal(porcelain(root), '')
    const J = JSON.parse(read(root, '.claude/so-chot/.migrated.json'))
    assert.ok(gitOk(root, 'show', '--name-status', '--format=', '-M', J.commit1).includes(`A\tdocs/specs/${AGENT_DIR}/research.md`))
    const v = M.verify(root)
    assert.ok(v.ok, JSON.stringify(v.loi))
  })

  test('decisions chọn "chung" ⇒ file vào docs/legacy, cả file thành MỘT quyết định phạm vi chung ⚠️ (thân link bản gốc)', () => {
    const { root } = planned()
    const p = readPlan(root)
    p.dong.find((r) => r.nguon.endsWith('/seo-audit.decisions.md')).chon = 'chung'
    savePlan(root, p)
    M.apply(root)
    assert.equal(read(root, 'docs/legacy/seo-audit.decisions.md'), DEC_SEO)
    const d = byTomTat(root, 'Quyết định cũ chung từ seo-audit.decisions.md: 1 · Quét tối đa 200 URL · giới hạn chi phí (+1 ý)')
    assert.equal(d.pham_vi, 'chung')
    assert.equal(d.hien, 'cho-xem')
    assert.ok(d.than.includes('Quét tối đa 200 URL') && d.than.includes('[docs/legacy/seo-audit.decisions.md](../../../docs/legacy/seo-audit.decisions.md)'))
    assert.ok(M.verify(root).ok)
  })
})

// ---------- verify: đối chiếu từng quyết định ----------

describe('verify', () => {
  const decFile = (root, d) => path.join(root, '.claude/so-chot', d.file)
  const split = (t) => { const i = t.indexOf('\n---\n', 4) + 5; return [t.slice(0, i), t.slice(i)] }

  test('bản chuyển đúng ⇒ ok, đếm đủ (theo file decisions)', () => {
    const { root } = applied()
    const v = M.verify(root)
    assert.deepEqual({ ok: v.ok, nguon_decisions: v.nguon_decisions, dich_quyet_dinh: v.dich_quyet_dinh, so_y: v.so_y, tong_file: v.tong_file, loi: v.loi },
      { ok: true, nguon_decisions: N_ITEMS, dich_quyet_dinh: N_ITEMS, so_y: N_Y, tong_file: N_FILES, loi: [] })
  })

  test('bỏ sót một quyết định ⇒ thieu (nêu file nguồn)', () => {
    const { root } = applied()
    const d = byTomTat(root, 'Quyết định cũ của ai-agent-gaps-2')
    fs.rmSync(decFile(root, d))
    const v = M.verify(root)
    assert.equal(v.ok, false)
    assert.deepEqual(v.loi.map((l) => [l.loai, l.nguon]), [['thieu', '.claude/plans/ai-agent-gaps-2.decisions.md']])
    assert.equal(v.dich_quyet_dinh, N_ITEMS - 1)
  })

  test('nhân đôi một quyết định ⇒ nhan_doi (mã khác nhưng cùng file nguồn)', () => {
    const { root } = applied()
    const d = byTomTat(root, TT_AGENT)
    const dup = read(root, `.claude/so-chot/${d.file}`).replace(`ma: ${d.ma}`, 'ma: zzzzzzzz')
    write(root, `.claude/so-chot/${d.pham_vi}/zzzzzzzz-ban-sao.md`, dup)
    const v = M.verify(root)
    assert.equal(v.ok, false)
    assert.equal(v.loi.filter((l) => l.loai === 'nhan_doi').length, 1)
    assert.equal(v.dich_quyet_dinh, N_ITEMS + 1)
  })

  test('ghép nhầm phạm vi (vẫn đủ số quyết định, front matter hợp lệ) ⇒ sai_pham_vi', () => {
    const { root } = applied()
    const d = byTomTat(root, 'Quyết định cũ của ai-agent-gaps-2')
    const moved = read(root, `.claude/so-chot/${d.file}`).replace(`pham_vi: ${GAPS_DIR}`, `pham_vi: ${SEO_DIR}`)
    fs.rmSync(decFile(root, d))
    write(root, `.claude/so-chot/${SEO_DIR}/${path.basename(d.file)}`, moved)
    assert.equal(migrated(root).length, N_ITEMS, 'đếm số lượng vẫn đủ')
    const v = M.verify(root)
    assert.equal(v.ok, false)
    assert.deepEqual(v.loi.map((l) => [l.loai, l.mong_doi, l.thuc_te]), [['sai_pham_vi', GAPS_DIR, SEO_DIR]])
  })

  test('sửa thân (bỏ một ý) và đổi tóm tắt (số lượng, phạm vi vẫn đúng) ⇒ sai_noi_dung cho cả hai', () => {
    const { root } = applied()
    const a = byTomTat(root, TT_AGENT)
    const b = byTomTat(root, 'Quyết định cũ của seo-audit')
    const [, ba] = split(read(root, `.claude/so-chot/${a.file}`))
    assert.ok(ba.includes('- Giới hạn 5 lượt gọi tool mỗi phiên'))
    fs.writeFileSync(decFile(root, a), read(root, `.claude/so-chot/${a.file}`).replace('- Giới hạn 5 lượt gọi tool mỗi phiên\n', ''))
    fs.writeFileSync(decFile(root, b), read(root, `.claude/so-chot/${b.file}`).replaceAll('(+1 ý)', '(+8 ý)'))
    const v = M.verify(root)
    assert.equal(v.ok, false)
    assert.equal(v.loi.filter((l) => l.loai === 'sai_noi_dung').length, 2)
    assert.equal(v.nguon_decisions, v.dich_quyet_dinh, 'chỉ đếm thì không phát hiện được')
  })

  test('sót một và nhân đôi một cùng lúc: tổng số vẫn bằng nhau nhưng verify vẫn bắt cả hai', () => {
    const { root } = applied()
    const gone = byTomTat(root, 'Quyết định cũ của seo-audit')
    const dupOf = byTomTat(root, TT_AGENT)
    fs.rmSync(decFile(root, gone))
    write(root, `.claude/so-chot/${dupOf.pham_vi}/zzzzzzzz-ban-sao.md`, read(root, `.claude/so-chot/${dupOf.file}`).replace(`ma: ${dupOf.ma}`, 'ma: zzzzzzzz'))
    const v = M.verify(root)
    assert.equal(v.nguon_decisions, v.dich_quyet_dinh)
    assert.deepEqual(v.loi.map((l) => l.loai).sort(), ['nhan_doi', 'thieu'])
  })

  test('quyết định được tự duyệt (không còn ⚠️, chưa ai xem) ⇒ khong_cho_xem; sau khi người dùng duyệt (da-xem) thì hợp lệ', () => {
    const { root } = applied()
    const d = byTomTat(root, TT_AGENT)
    fs.writeFileSync(decFile(root, d), read(root, `.claude/so-chot/${d.file}`).replace('trang_thai: cho-xem', 'trang_thai: dang-dung'))
    assert.deepEqual(M.verify(root).loi.map((l) => l.loai), ['khong_cho_xem'])
    fs.writeFileSync(decFile(root, d), read(root, `.claude/so-chot/${d.file}`).replace('trang_thai: dang-dung', 'trang_thai: cho-xem'))
    L.daXem(root, d.ma)
    assert.ok(M.verify(root).ok)
  })

  test('bản gốc decisions đổi sau khi chuyển ⇒ nguon_doi (không báo thêm lỗi nội dung); file đích mất ⇒ mat_file; quyết định không có nguồn ⇒ mo_coi', () => {
    const { root } = applied()
    fs.appendFileSync(path.join(root, `docs/specs/${GAPS_DIR}/notes/decisions.md`), '3. Ý thêm sau\n')
    fs.rmSync(path.join(root, `docs/specs/${SEO_DIR}/PLAN.md`))
    const v = M.verify(root)
    assert.deepEqual(v.loi.map((l) => l.loai).sort(), ['mat_file', 'nguon_doi'])
    const orphan = L.ghi(root, { tom_tat: 'Ý lạ', pham_vi: 'chung', ai_quyet: 'chuyen-tu-so-cu', vi_sao: 'không có băm' })
    const v2 = M.verify(root)
    assert.ok(v2.loi.some((l) => l.loai === 'mo_coi' && l.file === orphan.file))
  })

  test('commit 1 lẫn thay đổi nội dung (không phải R100) ⇒ commit1_khong_sach', () => {
    const { root } = applied()
    const J = JSON.parse(read(root, '.claude/so-chot/.migrated.json'))
    J.commit1 = gitOk(root, 'rev-parse', 'HEAD').trim() // HEAD = commit 2: có file thêm mới ngoài danh sách di chuyển
    write(root, '.claude/so-chot/.migrated.json', JSON.stringify(J, null, 2))
    const v = M.verify(root)
    assert.ok(v.loi.some((l) => l.loai === 'commit1_khong_sach'))
  })
})

// ---------- vòng sửa 1: FC1–FC8 (mô phỏng các ca trong báo cáo QA 1Scout) ----------

// Repo git tạm: `tracked` đã commit (một commit lúc `iso`), `loose` ghi sau commit (chưa theo dõi; file nào trúng .gitignore thì là file bị ignore).
function makeRepo({ tracked = {}, loose = {}, iso = '2026-05-01T10:00:00+07:00' } = {}) {
  const root = path.join(TMP, `repo-${++seq}`)
  fs.mkdirSync(root, { recursive: true })
  gitOk(root, 'init', '-q', '-b', 'main')
  write(root, 'src/app.txt', 'app\n')
  commitAll(root, 'init', '2026-02-01T09:00:00+07:00')
  if (Object.keys(tracked).length) {
    for (const [rel, text] of Object.entries(tracked)) write(root, rel, text)
    commitAll(root, 'legacy', iso)
  }
  for (const [rel, text] of Object.entries(loose)) write(root, rel, text)
  return fs.realpathSync(root)
}
const rowOf = (root, name) => readPlan(root).dong.find((r) => r.nguon === name || r.nguon.endsWith(`/${name}`))
const commitFiles = (root, rev) => gitOk(root, 'show', '--name-status', '--format=', '-M', rev).trim().split('\n').filter(Boolean)
const journal = (root) => JSON.parse(read(root, '.claude/so-chot/.migrated.json'))

describe('FC1: nguồn bị git bỏ qua (.gitignore)', () => {
  const GI = '.claude/reports/*\n!.claude/reports/README.md\n'
  const IGN = { '.claude/reports/x.md': '#x\n', '.claude/reports/alpha-review.md': 'review alpha\n' }
  const mk = () => makeRepo({
    tracked: { '.gitignore': GI, '.claude/plans/alpha.plan.md': '# alpha\n', '.claude/plans/alpha.decisions.md': '- chốt A\n', '.claude/reports/README.md': '# reports\n' },
    loose: IGN,
  })

  test('plan: nguồn bị ignore vào mục "không chuyển", không có dòng trong bảng, có cảnh báo', () => {
    const root = mk()
    const out = M.plan(root)
    assert.deepEqual(out.khong_chuyen.map((k) => k.nguon).sort(), Object.keys(IGN).sort())
    assert.ok(out.khong_chuyen.every((k) => /git đang bỏ qua/.test(k.ly_do)), JSON.stringify(out.khong_chuyen))
    const p = readPlan(root)
    assert.deepEqual(p.khong_chuyen, out.khong_chuyen)
    assert.ok(!p.dong.some((r) => r.nguon in IGN))
    assert.equal(out.tong, 3, 'chỉ alpha.plan, alpha.decisions và README (đã theo dõi, được .gitignore cho phép)')
    assert.ok(out.canh_bao.some((c) => /2 file .*git đang bỏ qua/.test(c)), out.canh_bao.join(' | '))
  })

  test('apply: file bị ignore ở nguyên chỗ, không vào git (không add -f), working tree sạch, verify ok', () => {
    const root = mk()
    M.plan(root)
    M.apply(root)
    for (const [rel, text] of Object.entries(IGN)) {
      assert.equal(read(root, rel), text, `${rel} giữ nguyên chỗ cũ`)
      assert.equal(gitOk(root, 'ls-files', '--', rel).trim(), '', `${rel} không được theo dõi`)
    }
    assert.ok(!exists(root, 'docs/legacy/x.md') && !exists(root, 'docs/specs/2026-05-01-alpha/notes/alpha-review.md'))
    assert.ok(!/x\.md|alpha-review/.test(gitOk(root, 'log', '--all', '--format=', '--name-only')), 'không lọt vào commit nào')
    assert.equal(read(root, '.gitignore'), GI)
    assert.equal(porcelain(root), '')
    assert.ok(M.verify(root).ok)
  })

  test('đích nằm trong vùng bị ignore ⇒ apply từ chối trước khi dời gì (không ép add)', () => {
    const root = makeRepo({ tracked: { '.gitignore': 'docs/legacy/\n', '.claude/plans/alpha.plan.md': '# a\n' }, loose: { '.claude/plans/misc.md': 'lạc\n' } })
    const base = nCommits(root)
    M.plan(root)
    assert.equal(rowOf(root, 'misc.md').dich, 'docs/legacy/misc.md')
    assert.throws(() => M.apply(root), /bị git bỏ qua.*misc\.md/)
    assert.equal(nCommits(root), base)
    assert.ok(exists(root, '.claude/plans/misc.md') && exists(root, '.claude/plans/alpha.plan.md') && !exists(root, 'docs') && !exists(root, '.claude/so-chot/.migrated.json'))
  })
})

describe('FC2: tên dạng gạch', () => {
  const D = '2026-05-01'
  const CH = `docs/specs/${D}-content-hub`
  const mk = () => makeRepo({
    tracked: {
      '.claude/plans/content-hub-decisions.md': '- D1 chọn A\n- D2 chọn B\n',
      '.claude/plans/content-hub-plan.md': '# plan\n',
      '.claude/plans/content-hub-progress.md': '# Tiến độ\nTrạng thái: đang làm\n',
      '.claude/plans/content-hub-spec-2.md': '# spec 2\n',
      '.claude/plans/ai-writer-decisions.md': '- W1\n',
      '.claude/reports/content-hub-review.md': 'r\n',
      '.claude/reports/content-hub-recon-2.md': 'recon\n',
      '.claude/reports/content-hub-notes.md': 'n\n',
      '.claude/reports/lonely-review.md': 'không thuộc ai\n',
    },
  })

  test('plan: nhận -decisions/-plan/-progress/-spec(-N) như dạng chấm (cao); -review/-recon/-notes gắn đúng tính năng; review lẻ vẫn legacy', () => {
    const root = mk()
    const out = M.plan(root)
    for (const [name, loai, tn, dich] of [
      ['content-hub-decisions.md', 'decisions', 'content-hub', `${CH}/notes/decisions.md`],
      ['content-hub-plan.md', 'plan', 'content-hub', `${CH}/PLAN.md`],
      ['content-hub-progress.md', 'progress', 'content-hub', `${CH}/progress.md`],
      ['content-hub-spec-2.md', 'spec', 'content-hub', `${CH}/SPEC.md`],
      ['ai-writer-decisions.md', 'decisions', 'ai-writer', `docs/specs/${D}-ai-writer/notes/decisions.md`],
    ]) {
      const r = rowOf(root, name)
      assert.deepEqual([r.loai, r.tinh_nang, r.do_chac, r.can_hoi, r.dich], [loai, tn, 'cao', false, dich], name)
    }
    for (const n of ['content-hub-review.md', 'content-hub-recon-2.md', 'content-hub-notes.md']) {
      const r = rowOf(root, n)
      assert.deepEqual([r.tinh_nang, r.do_chac, r.can_hoi, r.dich], ['content-hub', 'cao', false, `${CH}/notes/${n}`], n)
    }
    const lone = rowOf(root, 'lonely-review.md')
    assert.equal(lone.tinh_nang, null)
    assert.match(lone.dich, /^docs\/legacy\//)
    assert.equal(out.tinh_nang, 2)
    assert.equal(out.can_hoi.length, 0)
  })

  test('apply: file decisions dạng gạch vào sổ chốt đúng phạm vi (mỗi file một quyết định), không nằm ở docs/legacy', () => {
    const root = mk()
    const base = nCommits(root)
    M.plan(root)
    M.apply(root)
    assert.equal(nCommits(root), base + 2)
    assert.deepEqual(migrated(root).map((d) => [d.pham_vi, d.tom_tat]).sort(), [[`${D}-ai-writer`, 'Quyết định cũ của ai-writer: W1'], [`${D}-content-hub`, 'Quyết định cũ của content-hub: D1 chọn A (+1 ý)']])
    assert.ok(!exists(root, 'docs/legacy/content-hub-decisions.md') && !exists(root, 'docs/legacy/ai-writer-decisions.md'))
    assert.equal(porcelain(root), '')
    assert.ok(M.verify(root).ok)
  })

  test('tên có "decisions" nhưng không theo mẫu: ghép vào tính năng có sẵn (vừa) hoặc phải hỏi; không bao giờ đi legacy', () => {
    const root = makeRepo({ tracked: { '.claude/plans/x.plan.md': '# x\n', '.claude/plans/x-decisions-v2.md': '- X1\n', '.claude/plans/DECISIONS.md': '- Z1\n- Z2\n', '.claude/plans/y-decisions-v3.md': '- Y1\n' } })
    const out = M.plan(root)
    const v2 = rowOf(root, 'x-decisions-v2.md')
    assert.deepEqual([v2.loai, v2.tinh_nang, v2.do_chac, v2.can_hoi], ['decisions', 'x', 'vua', false])
    assert.deepEqual(out.can_hoi.map((c) => c.nguon).sort(), ['.claude/plans/DECISIONS.md', '.claude/plans/y-decisions-v3.md'])
    assert.ok(readPlan(root).dong.filter((r) => r.can_hoi).every((r) => r.loai === 'decisions'))
    const p = readPlan(root)
    for (const r of p.dong) if (r.can_hoi) r.chon = 'legacy'
    savePlan(root, p)
    assert.throws(() => M.apply(root), /decisions không đi legacy/)
    for (const r of p.dong) if (r.can_hoi) r.chon = 'chung'
    savePlan(root, p)
    M.apply(root)
    assert.deepEqual(migrated(root).map((d) => d.pham_vi).sort(), [`${D}-x`, 'chung', 'chung'])
    assert.ok(M.verify(root).ok)
  })
})

describe('FC3: ứng viên cho dòng cần hỏi', () => {
  test('ai-agent-tool-gaps: ứng viên gồm ai-agent-gaps, xếp theo độ giống, tối đa 4, mỗi cái kèm lý do', () => {
    const root = makeRepo({
      tracked: {
        '.claude/plans/ai-agent.plan.md': '# a\n',
        '.claude/plans/ai-agent-gaps.decisions.md': '- g1\n',
        '.claude/plans/ai-agent-tool-search.plan.md': '# s\n',
        '.claude/plans/ai-agent-a.plan.md': '# a\n',
        '.claude/plans/ai-agent-b.plan.md': '# b\n',
        '.claude/plans/ai-agent-c.plan.md': '# c\n',
        '.claude/plans/billing.plan.md': '# b\n',
        '.claude/reports/ai-agent-tool-gaps.md': 'khoảng hở tool\n',
        '.claude/reports/ai-agent-tool-gaps-2.md': 'khoảng hở tool 2\n',
      },
    })
    const out = M.plan(root)
    assert.deepEqual(out.can_hoi.map((c) => c.nguon).sort(), ['.claude/reports/ai-agent-tool-gaps-2.md', '.claude/reports/ai-agent-tool-gaps.md'])
    for (const c of out.can_hoi) {
      assert.ok(c.ung_vien.includes('ai-agent-gaps'), `${c.nguon}: ${c.ung_vien}`)
      assert.ok(c.ung_vien.length <= 4, c.ung_vien.join())
      assert.ok(!c.ung_vien.includes('billing'), 'không giống thì không đưa')
      for (const u of c.ung_vien) assert.ok(c.ung_vien_ly_do[u], `${u} có lý do`)
      assert.match(c.ung_vien_ly_do['ai-agent-gaps'], /gaps/)
    }
  })

  test('QA B3: x-tool-gaps.md + x-gaps.decisions.md ⇒ phải hỏi, ung_vien chứa x-gaps', () => {
    const root = makeRepo({ tracked: { '.claude/reports/x-tool-gaps.md': 'ghi chú\n', '.claude/plans/x-gaps.decisions.md': '- g\n(xem x-tool-gaps.md)\n' } })
    const out = M.plan(root)
    assert.deepEqual(out.can_hoi.map((c) => [c.nguon, c.ung_vien]), [['.claude/reports/x-tool-gaps.md', ['x-gaps']]])
  })
})

describe('FC4: chỗ trỏ tới đường dẫn cũ', () => {
  const A = '2026-05-01-alpha'
  const CLAUDE = '﻿# Dự án\r\nMở phiên mới → đọc `.claude/plans/HANDOFF.md` trước.\r\n'
  const NOTES = 'Xem .claude/plans/HANDOFF.md.\nToàn cục: ~/.claude/plans/HANDOFF.md\nBản sao: .claude/plans/HANDOFF.md.bak\n'
  const RULES = 'plan ở .claude/plans/alpha.plan.md và (.claude/plans/alpha.decisions.md)\n'
  const PLAN = '# alpha\nquyết định ở `.claude/plans/alpha.decisions.md`\n'
  const PLAN_NEW = `# alpha\nquyết định ở \`docs/specs/${A}/notes/decisions.md\`\n`
  const DEC = '- A1 (xem .claude/plans/alpha.plan.md)\n' // file decisions: bản gốc giữ nguyên byte dù có nhắc đường cũ
  const CLAUDE_NEW = CLAUDE.replace('.claude/plans/HANDOFF.md', 'docs/legacy/HANDOFF.md')
  const mk = () => makeRepo({
    tracked: {
      '.claude/CLAUDE.md': CLAUDE, '.claude/rules/flow.md': RULES, 'docs/notes.md': NOTES,
      '.claude/plans/HANDOFF.md': '# handoff\n', '.claude/plans/alpha.plan.md': PLAN, '.claude/plans/alpha.decisions.md': DEC,
    },
  })

  test('plan liệt kê chỗ trỏ (file, dòng, cũ → mới); bỏ qua ~/.claude và đuôi .bak; chỉ file decisions đánh dấu không sửa', () => {
    const root = mk()
    const out = M.plan(root)
    const p = readPlan(root)
    const key = (e) => `${e.file}:${e.dong} ${e.cu} → ${e.moi}`
    assert.deepEqual(p.tro_cu.filter((e) => e.sua).map(key).sort(), [
      '.claude/CLAUDE.md:2 .claude/plans/HANDOFF.md → docs/legacy/HANDOFF.md',
      `.claude/rules/flow.md:1 .claude/plans/alpha.decisions.md → docs/specs/${A}/notes/decisions.md`,
      `.claude/rules/flow.md:1 .claude/plans/alpha.plan.md → docs/specs/${A}/PLAN.md`,
      `.claude/plans/alpha.plan.md:2 .claude/plans/alpha.decisions.md → docs/specs/${A}/notes/decisions.md`,
      'docs/notes.md:1 .claude/plans/HANDOFF.md → docs/legacy/HANDOFF.md',
    ].sort())
    assert.deepEqual(p.tro_cu.filter((e) => !e.sua).map((e) => e.file), ['.claude/plans/alpha.decisions.md'])
    assert.equal(out.tro_cu.se_sua, 5)
    assert.ok(out.canh_bao.some((c) => /HANDOFF/.test(c)), out.canh_bao.join(' | '))
  })

  test('apply: thay đúng chuỗi cũ → mới ở commit 2 (giữ BOM + CRLF), cả trong file vừa dời; commit 1 vẫn toàn R100; file decisions nguyên byte; verify ok', () => {
    const root = mk()
    const base = nCommits(root)
    M.plan(root)
    const res = M.apply(root)
    assert.equal(nCommits(root), base + 2)
    assert.equal(porcelain(root), '')
    assert.equal(read(root, '.claude/CLAUDE.md'), CLAUDE_NEW)
    assert.equal(read(root, 'docs/notes.md'), NOTES.replace('Xem .claude/plans/HANDOFF.md.', 'Xem docs/legacy/HANDOFF.md.'))
    assert.equal(read(root, '.claude/rules/flow.md'), `plan ở docs/specs/${A}/PLAN.md và (docs/specs/${A}/notes/decisions.md)\n`)
    assert.equal(read(root, `docs/specs/${A}/PLAN.md`), PLAN_NEW, 'file vừa dời cũng được sửa chỗ trỏ')
    assert.equal(read(root, `docs/specs/${A}/notes/decisions.md`), DEC, 'file decisions giữ nguyên byte')
    assert.ok(commitFiles(root, journal(root).commit1).every((l) => l.startsWith('R100\t')))
    const c2 = commitFiles(root, 'HEAD')
    for (const f of ['.claude/CLAUDE.md', 'docs/notes.md', '.claude/rules/flow.md', `docs/specs/${A}/PLAN.md`]) assert.ok(c2.includes(`M\t${f}`), f)
    assert.ok(!c2.some((l) => l.endsWith('notes/decisions.md')), 'decisions không có trong commit 2 dưới dạng sửa')
    assert.deepEqual(res.tro_cu_sua.slice().sort(), ['.claude/CLAUDE.md', '.claude/rules/flow.md', 'docs/notes.md', `docs/specs/${A}/PLAN.md`])
    assert.deepEqual(res.tro_cu_bo_qua, [])
    const v = M.verify(root)
    assert.ok(v.ok, JSON.stringify(v.loi))
  })

  test('file đang có sửa chưa commit của người dùng ⇒ không sửa, không cuốn vào commit; verify báo còn chỗ trỏ cũ', () => {
    const root = mk()
    M.plan(root)
    const mine = `${RULES}dòng người dùng vừa thêm\n`
    write(root, '.claude/rules/flow.md', mine)
    const res = M.apply(root)
    assert.deepEqual(res.tro_cu_bo_qua, ['.claude/rules/flow.md'])
    assert.equal(read(root, '.claude/rules/flow.md'), mine)
    assert.ok(!commitFiles(root, 'HEAD').some((l) => l.endsWith('.claude/rules/flow.md')))
    assert.equal(porcelain(root), 'M .claude/rules/flow.md')
    const v = M.verify(root)
    assert.equal(v.ok, false)
    assert.deepEqual(v.loi.map((l) => [l.loai, l.file]), [['tro_duong_cu', '.claude/rules/flow.md']])
  })

  test('file SẮP DỜI đang có sửa chưa commit của người dùng ⇒ vẫn dời (R100), không sửa chỗ trỏ, sửa dở của người dùng không cuốn vào commit; verify báo', () => {
    const root = mk()
    const mine = `${PLAN}dòng người dùng vừa thêm\n`
    write(root, '.claude/plans/alpha.plan.md', mine)
    M.plan(root)
    const res = M.apply(root)
    assert.deepEqual(res.tro_cu_bo_qua, [`docs/specs/${A}/PLAN.md`])
    assert.equal(read(root, `docs/specs/${A}/PLAN.md`), mine)
    assert.ok(!commitFiles(root, 'HEAD').some((l) => l.endsWith('/PLAN.md')))
    assert.ok(commitFiles(root, journal(root).commit1).some((l) => l.startsWith('R100\t') && l.endsWith(`docs/specs/${A}/PLAN.md`)))
    assert.equal(porcelain(root), `M docs/specs/${A}/PLAN.md`)
    const v = M.verify(root)
    assert.deepEqual(v.loi.map((l) => [l.loai, l.file]), [['tro_duong_cu', `docs/specs/${A}/PLAN.md`]])
  })

  test('progress.md vừa có chỗ trỏ cũ vừa được thêm dòng trỏ sổ chốt: sửa cả hai, verify không báo "khác bản gốc"', () => {
    const root = makeRepo({
      tracked: {
        '.claude/plans/alpha.plan.md': '# a\n', '.claude/plans/alpha.decisions.md': '- A1\n',
        '.claude/plans/alpha.progress.md': '# Tiến độ\nTrạng thái: đang làm\nxem .claude/plans/alpha.plan.md\n',
      },
    })
    M.plan(root)
    M.apply(root)
    const prog = read(root, `docs/specs/${A}/progress.md`)
    assert.ok(prog.includes(`xem docs/specs/${A}/PLAN.md`) && prog.includes('Sổ chốt (chuyển từ sổ cũ)'), prog)
    const v = M.verify(root)
    assert.ok(v.ok, JSON.stringify(v.loi))
    assert.deepEqual(v.canh_bao.filter((c) => /khác bản gốc/.test(c)), [])
  })

  test('verify báo khi sau này lại có chỗ trỏ đường cũ', () => {
    const root = mk()
    M.plan(root)
    M.apply(root)
    assert.ok(M.verify(root).ok)
    write(root, '.claude/CLAUDE.md', CLAUDE)
    const v = M.verify(root)
    assert.equal(v.ok, false)
    assert.deepEqual(v.loi.map((l) => [l.loai, l.file, l.cu, l.moi]), [['tro_duong_cu', '.claude/CLAUDE.md', '.claude/plans/HANDOFF.md', 'docs/legacy/HANDOFF.md']])
  })

  for (const stop of ['tro', 'tro-xong', 'journal', 'write', 'commit2']) {
    test(`bị ngắt tại "${stop}" khi có sửa chỗ trỏ rồi chạy lại: không bỏ sót, không cuốn file lạ, kết quả y hệt`, () => {
      const root = mk()
      M.plan(root)
      const base = nCommits(root)
      assert.throws(() => M.apply(root, { onBuoc: (b) => { if (b === stop) throw new Error('ngắt thử') } }), /ngắt thử/)
      M.apply(root)
      assert.equal(nCommits(root), base + 2)
      assert.equal(porcelain(root), '')
      assert.equal(read(root, '.claude/CLAUDE.md'), CLAUDE_NEW)
      assert.ok(M.verify(root).ok)
    })
  }
})

describe('FC5: mỗi file decisions = MỘT quyết định ⚠️', () => {
  test('tóm tắt có số ý; thân liệt kê tối đa 5 ý đầu + link bản gốc; bản gốc nguyên byte; verify theo file', () => {
    const items = `${Array.from({ length: 7 }, (_, i) => `- ý số ${i + 1}`).join('\n')}\n`
    const src = `# Beta\n\n${items}`
    const root = makeRepo({ tracked: { '.claude/plans/beta.plan.md': '# b\n', '.claude/plans/beta.decisions.md': src } })
    M.plan(root)
    M.apply(root)
    const ds = migrated(root)
    assert.equal(ds.length, 1, 'bảy ý nhưng chỉ một quyết định')
    const d = ds[0]
    assert.equal(d.tom_tat, 'Quyết định cũ của beta: ý số 1 (+6 ý)')
    assert.equal(d.pham_vi, '2026-05-01-beta')
    assert.equal(d.hien, 'cho-xem')
    for (const i of [1, 2, 3, 4, 5]) assert.ok(d.than.includes(`ý số ${i}`), `liệt kê ý ${i}`)
    assert.ok(!d.than.includes('ý số 6') && !d.than.includes('ý số 7'), 'chỉ 5 ý đầu')
    assert.match(d.than, /còn 2 ý/)
    assert.ok(d.than.includes('[notes/decisions.md](../../../docs/specs/2026-05-01-beta/notes/decisions.md)'))
    assert.equal(read(root, 'docs/specs/2026-05-01-beta/notes/decisions.md'), src)
    const v = M.verify(root)
    assert.deepEqual({ ok: v.ok, nguon_decisions: v.nguon_decisions, dich_quyet_dinh: v.dich_quyet_dinh, so_y: v.so_y }, { ok: true, nguon_decisions: 1, dich_quyet_dinh: 1, so_y: 7 })
  })

  test('hai file decisions cùng tính năng ⇒ hai quyết định, tóm tắt phân biệt theo tên file', () => {
    const root = makeRepo({ tracked: { '.claude/plans/beta.decisions.md': '- b1\n', '.claude/plans/beta-decisions-2.md': '- b2\n- b3\n' } })
    M.plan(root)
    M.apply(root)
    assert.deepEqual(migrated(root).map((d) => d.tom_tat).sort(), ['Quyết định cũ của beta — beta-decisions-2.md: b2 (+1 ý)', 'Quyết định cũ của beta — beta.decisions.md: b1'])
    assert.ok(M.verify(root).ok)
  })
})

describe('FC6: docs/ROADMAP.md viết tay', () => {
  const HAND = '# Roadmap của tôi\n\n- Việc A (đang cân nhắc)\n- Việc B\n'
  const mk = () => makeRepo({ tracked: { 'docs/ROADMAP.md': HAND, '.claude/plans/alpha.plan.md': '# a\n', '.claude/plans/alpha.decisions.md': '- A1\n' } })

  test('plan: bảng có dòng dời ROADMAP viết tay sang docs/legacy/ROADMAP-viet-tay.md', () => {
    const root = mk()
    const out = M.plan(root)
    const r = rowOf(root, 'docs/ROADMAP.md')
    assert.deepEqual([r.loai, r.dich, r.can_hoi], ['roadmap_cu', 'docs/legacy/ROADMAP-viet-tay.md', false])
    assert.ok(out.thay_doi_phu.some((s) => /ROADMAP-viet-tay/.test(s)), out.thay_doi_phu.join(' | '))
  })

  test('apply: git mv R100 ở commit 1 rồi mới sinh ROADMAP mới (có dấu tự sinh); bản viết tay nguyên byte, không bị đè; verify ok', () => {
    const root = mk()
    const base = nCommits(root)
    M.plan(root)
    M.apply(root)
    assert.equal(nCommits(root), base + 2)
    assert.equal(read(root, 'docs/legacy/ROADMAP-viet-tay.md'), HAND)
    assert.ok(commitFiles(root, journal(root).commit1).includes('R100\tdocs/ROADMAP.md\tdocs/legacy/ROADMAP-viet-tay.md'))
    const rm = read(root, 'docs/ROADMAP.md')
    assert.ok(rm.startsWith('<!-- tự sinh bởi so-chot.mjs'), 'ROADMAP mới do so-chot sinh')
    assert.ok(!rm.includes('Việc A'))
    assert.ok(commitFiles(root, 'HEAD').includes('A\tdocs/ROADMAP.md'), 'commit 2 chỉ thêm ROADMAP mới, không xoá/đổi tên')
    assert.equal(porcelain(root), '')
    const v = M.verify(root)
    assert.ok(v.ok, JSON.stringify(v.loi))
  })

  test('chạy lại sau khi đã xong (docs/ROADMAP.md giờ là bản mới): không thêm commit, không báo "đích đã có file khác"', () => {
    const root = mk()
    const base = nCommits(root)
    M.plan(root)
    M.apply(root)
    const files = gitOk(root, 'ls-files')
    const again = M.apply(root)
    assert.equal(again.da_xong, true)
    assert.equal(nCommits(root), base + 2)
    assert.equal(gitOk(root, 'ls-files'), files)
    assert.equal(read(root, 'docs/legacy/ROADMAP-viet-tay.md'), HAND)
    assert.ok(M.verify(root).ok)
  })

  for (const stop of ['mv:0', 'commit1', 'write', 'commit2']) {
    test(`bị ngắt tại "${stop}" rồi chạy lại: ROADMAP viết tay vẫn được dời đúng một lần, bản mới không bị coi là nguồn`, () => {
      const root = mk()
      const base = nCommits(root)
      M.plan(root)
      assert.throws(() => M.apply(root, { onBuoc: (b) => { if (b === stop) throw new Error('ngắt thử') } }), /ngắt thử/)
      M.apply(root)
      assert.equal(nCommits(root), base + 2)
      assert.equal(porcelain(root), '')
      assert.equal(read(root, 'docs/legacy/ROADMAP-viet-tay.md'), HAND)
      assert.ok(read(root, 'docs/ROADMAP.md').startsWith('<!-- tự sinh bởi so-chot.mjs'))
      assert.ok(M.verify(root).ok)
    })
  }

  test('ROADMAP do so-chot sinh (có dấu) thì KHÔNG bị dời; không có ROADMAP thì không có dòng', () => {
    const root = makeRepo({ tracked: { '.claude/plans/alpha.plan.md': '# a\n' } })
    M.plan(root)
    assert.ok(!readPlan(root).dong.some((r) => r.loai === 'roadmap_cu'))
    L.write(root)
    assert.ok(exists(root, 'docs/ROADMAP.md'))
    fs.rmSync(path.join(root, '.claude/so-chot'), { recursive: true })
    commitAll(root, 'roadmap tự sinh', '2026-05-02T10:00:00+07:00')
    M.plan(root)
    assert.ok(!readPlan(root).dong.some((r) => r.nguon === 'docs/ROADMAP.md'))
  })
})

describe('FC7: thiếu git identity', () => {
  test('báo tiếng Việt một dòng kèm lệnh git config, trước khi đổi bất cứ gì; có identity thì chạy lại được', () => {
    const { root, base } = planned()
    const noId = path.join(TMP, 'gitconfig-noid')
    fs.writeFileSync(noId, '[user]\n\tuseConfigOnly = true\n[core]\n\tautocrlf = false\n')
    const keep = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = noId
    try {
      const before = porcelain(root)
      let err
      try { M.apply(root) } catch (e) { err = e }
      assert.ok(err, 'phải lỗi')
      assert.match(err.message, /^[^\n]+$/, 'một dòng')
      assert.match(err.message, /git config user\.name/)
      assert.match(err.message, /git config user\.email/)
      assert.equal(nCommits(root), base)
      assert.ok(exists(root, '.claude/plans/ai-agent.plan.md') && !exists(root, 'docs') && !exists(root, '.claude/so-chot/.migrated.json'))
      assert.equal(porcelain(root), before)
      assert.equal(gitOk(root, 'diff', '--cached', '--name-only').trim(), '', 'chưa stage gì')
      const r = spawnSync(process.execPath, [SCRIPT, 'apply', root], { encoding: 'utf8', env: process.env })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /^lỗi: [^\n]*git config user\.name[^\n]*git config user\.email[^\n]*\n$/)
    } finally {
      process.env.GIT_CONFIG_GLOBAL = keep
    }
    M.apply(root)
    assertFinal(root, base)
  })
})

describe('FC8: bảng plan liệt kê thay đổi phụ', () => {
  test('sửa .gitattributes có sẵn, đổi tên README của reports, file tạo mới, progress.md, chỗ trỏ cũ; plan không ghi gì ngoài file bảng', () => {
    const root = makeRepo({
      tracked: {
        '.gitattributes': '* text=auto\n', '.claude/plans/alpha.plan.md': '# a\n', '.claude/plans/alpha.decisions.md': '- A1\n',
        '.claude/plans/alpha.progress.md': '# Tiến độ\nTrạng thái: đang làm\n', '.claude/reports/README.md': '# reports\n', 'docs/n.md': 'xem .claude/plans/alpha.plan.md\n',
      },
    })
    const out = M.plan(root)
    const phu = out.thay_doi_phu
    const has = (re) => assert.ok(phu.some((s) => re.test(s)), `${re}: ${phu.join(' | ')}`)
    has(/^sửa \.gitattributes: thêm 4 dòng merge=union/)
    has(/^đổi tên \.claude\/reports\/README\.md → docs\/legacy\/README\.md/)
    has(/^tạo mới: .*1 quyết định ⚠️.*INDEX\.md.*ROADMAP\.md.*\.migrated\.json/)
    has(/^thêm dòng trỏ sổ chốt vào 1 file progress\.md/)
    has(/^sửa 1 file đang trỏ đường cũ \(1 chỗ\)/)
    assert.deepEqual(readPlan(root).thay_doi_phu, phu)
    assert.equal(porcelain(root), '?? .claude/so-chot/')
    assert.equal(read(root, '.gitattributes'), '* text=auto\n')
  })

  test('chưa có .gitattributes ⇒ ghi "tạo .gitattributes"', () => {
    const root = makeRepo({ tracked: { '.claude/plans/alpha.plan.md': '# a\n' } })
    const phu = M.plan(root).thay_doi_phu
    assert.ok(phu.some((s) => /^tạo \.gitattributes \(4 dòng merge=union/.test(s)), phu.join(' | '))
    assert.ok(!exists(root, '.gitattributes'))
  })
})

// ---------- vòng sửa 2: R1–R4 ----------

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')

// Ảnh chụp mọi file/thư mục ngoài .git (đường dẫn → băm; symlink/junction không đi theo) để chứng minh "không đổi gì".
function snapFiles(dir) {
  const out = {}
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      if (n === '.git') continue
      const p = path.join(d, n)
      const st = fs.lstatSync(p)
      const rel = path.relative(dir, p).replace(/\\/g, '/')
      if (st.isSymbolicLink()) out[rel] = '->'
      else if (st.isDirectory()) { out[`${rel}/`] = 'dir'; walk(p) } else out[rel] = sha1(fs.readFileSync(p))
    }
  }
  walk(dir)
  return out
}

// apply (và verify nếu có nhật ký) phải từ chối `re`; sau đó repo y nguyên: không file/thư mục mới, không commit, không stage, .git/config và .git/hooks không đổi.
function rejected(root, re, label, { verify = true } = {}) {
  const gitDir = path.join(root, '.git')
  const hooksDir = path.join(gitDir, 'hooks')
  const before = {
    files: snapFiles(root), n: nCommits(root), cfg: fs.readFileSync(path.join(gitDir, 'config')), hooks: fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir).sort() : null,
  }
  assert.throws(() => M.apply(root), re, `${label}: apply`)
  assert.deepEqual(snapFiles(root), before.files, `${label}: working tree đã đổi`)
  assert.equal(nCommits(root), before.n, `${label}: có commit mới`)
  assert.equal(gitOk(root, 'diff', '--cached', '--name-only').trim(), '', `${label}: đã stage gì đó`)
  assert.deepEqual(fs.readFileSync(path.join(gitDir, 'config')), before.cfg, `${label}: .git/config bị đổi`)
  assert.deepEqual(fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir).sort() : null, before.hooks, `${label}: .git/hooks bị đổi`)
  if (verify) assert.throws(() => M.verify(root), re, `${label}: verify`)
}

describe('R1: nhật ký / bảng ghép là dữ liệu repo KHÔNG đáng tin (đường dẫn)', () => {
  const PAYLOAD = '#!/bin/sh\necho pwn\n'
  const JTIME = '2026-10-02 10:00'
  const SRC = '.claude/plans/evil.md'
  const RE = /không hợp lệ/
  const OUT = path.join(TMP, 'r1-outside.md')
  const OUT_ABS = path.join(TMP, 'r1-abs-outside.md').replace(/\\/g, '/')
  const notCreated = () => { for (const f of [OUT, OUT_ABS, 'C:/r1-x.md']) assert.ok(!fs.existsSync(f), `không được tạo ${f}`) }

  // Repo mà nhật ký .migrated.json do kẻ tấn công cài: items = [[nguồn, đích, ghi đè trường]].
  function attackRepo(items, extra = {}) {
    const tracked = Object.fromEntries(items.filter(([s]) => !/(^|\/)(\.\.|\.git)(\/|$)/.test(s) && s !== 'src/app.txt').map(([s]) => [s, PAYLOAD]))
    const root = makeRepo({ tracked })
    const nguon = {}
    for (const [src, dich, o] of items) {
      let buf = Buffer.from(PAYLOAD)
      try { buf = fs.readFileSync(path.join(root, src)) } catch {}
      nguon[src] = { sha: sha1(buf), loai: 'khac', pham_vi: null, tn: null, dich, luc: JTIME, ...o }
    }
    write(root, '.claude/so-chot/.migrated.json', JSON.stringify({ v: 1, tao_luc: JTIME, commit1: null, nguon, y: {}, sua_tro: [], ...extra }, null, 2))
    return root
  }

  test('đối chứng: cùng cách dựng nhưng đích hợp lệ (docs/legacy/…) thì apply chạy bình thường', () => {
    const root = attackRepo([[SRC, 'docs/legacy/evil.md']])
    const res = M.apply(root)
    assert.equal(res.di_chuyen, 1)
    assert.equal(read(root, 'docs/legacy/evil.md'), PAYLOAD)
    assert.ok(M.verify(root).ok)
  })

  const BAD_DICH = [
    '.git/hooks/pre-commit', '.GIT/config', '.Git/hooks/post-commit', '.git', '.git/', 'docs/legacy/../../.git/hooks/pre-commit', '../r1-outside.md', 'docs/../../r1-outside.md',
    'C:/r1-x.md', OUT_ABS, '/etc/r1-x', 'docs\\..\\.git\\hooks\\pre-commit', '.git./hooks/pre-commit', 'GIT~1/hooks/pre-commit', 'docs/legacy//x.md',
    '.husky/pre-commit', '.github/workflows/x.yml', 'src/app.txt', '', null, 42,
  ]
  for (const dich of BAD_DICH) {
    test(`nhật ký có đích ${JSON.stringify(dich)} ⇒ từ chối trước khi đổi gì (không tạo/ghi tệp ngoài repo hay dưới .git)`, () => {
      const root = attackRepo([[SRC, dich]])
      rejected(root, RE, String(dich))
      assert.equal(read(root, SRC), PAYLOAD, 'nguồn còn nguyên chỗ cũ')
      assert.ok(!exists(root, '.git/hooks/pre-commit') && !exists(root, '.git/hooks/post-commit'))
      notCreated()
    })
  }

  for (const src of ['.git/config', 'src/app.txt', 'docs/payload.md', '.claude/plans/../../src/app.txt', '.claude/plans/x.txt', '.claude/plans/sub/deep.md', '.claude/plans/.git']) {
    test(`nhật ký có nguồn ${JSON.stringify(src)} (không phải .md trực tiếp trong .claude/plans|reports) ⇒ từ chối, file nguồn không bị dời`, () => {
      const root = attackRepo([[src, 'docs/legacy/x.md']])
      rejected(root, RE, src)
      assert.ok(!exists(root, 'docs/legacy'), 'không dời gì')
    })
  }

  test('Codex: docs/payload.md ⇒ .git/hooks/pre-commit (script thực thi) không bao giờ được cài', () => {
    const root = attackRepo([['docs/payload.md', '.git/hooks/pre-commit']])
    rejected(root, RE, 'payload')
    assert.ok(!exists(root, '.git/hooks/pre-commit'))
  })

  test('một dòng xấu trong nhiều dòng ⇒ từ chối cả bảng; dòng tốt đứng trước cũng không bị dời', () => {
    const root = attackRepo([['.claude/plans/a-good.md', 'docs/legacy/a-good.md'], [SRC, '.git/hooks/pre-commit']])
    rejected(root, RE, 'nhiều dòng')
    assert.ok(exists(root, '.claude/plans/a-good.md') && !exists(root, 'docs'))
  })

  test('.git là FILE (worktree): đích ".git" không được ghi đè con trỏ gitdir', () => {
    const main = makeRepo({ tracked: { 'a.txt': 'a\n' } })
    const wt = path.join(TMP, `r1-wt-${++seq}`)
    gitOk(main, 'worktree', 'add', '-q', '-b', 'r1-wt', wt)
    const root = fs.realpathSync(wt)
    assert.ok(fs.lstatSync(path.join(root, '.git')).isFile())
    write(root, SRC, PAYLOAD)
    commitAll(root, 'evil', '2026-05-01T10:00:00+07:00')
    const gitFile = fs.readFileSync(path.join(root, '.git'), 'utf8')
    write(root, '.claude/so-chot/.migrated.json', JSON.stringify({ v: 1, tao_luc: JTIME, commit1: null, nguon: { [SRC]: { sha: sha1(PAYLOAD), loai: 'khac', pham_vi: null, tn: null, dich: '.git', luc: JTIME } }, y: {}, sua_tro: [] }))
    const n = nCommits(root)
    assert.throws(() => M.apply(root), RE)
    assert.equal(fs.readFileSync(path.join(root, '.git'), 'utf8'), gitFile, 'con trỏ gitdir còn nguyên')
    assert.equal(nCommits(root), n)
    assert.equal(read(root, SRC), PAYLOAD)
  })

  test('thư mục đích là junction/symlink trỏ ra ngoài ⇒ từ chối cả bảng trước khi dời bất cứ gì', (t) => {
    const outside = path.join(TMP, `r1-junction-out-${++seq}`)
    fs.mkdirSync(outside)
    const root = attackRepo([['.claude/plans/a-first.md', 'docs/legacy/a-first.md'], ['.claude/plans/b-second.md', 'docs/specs/2026-05-01-x/PLAN.md', { loai: 'plan', pham_vi: '2026-05-01-x', tn: 'x' }]])
    fs.mkdirSync(path.join(root, 'docs/specs'), { recursive: true })
    try { fs.symlinkSync(outside, path.join(root, 'docs/specs/2026-05-01-x'), 'junction') } catch (e) { t.skip(`không tạo được junction/symlink: ${e.code}`); return }
    rejected(root, RE, 'junction')
    assert.deepEqual(fs.readdirSync(outside), [], 'không ghi gì ra ngoài')
    assert.ok(exists(root, '.claude/plans/a-first.md'))
  })

  test('bảng .migrate-plan.json bị sửa: thu_muc có ".." ⇒ từ chối trước khi đổi gì (không cài gì vào .git)', () => {
    const { root } = planned()
    const p = readPlan(root)
    p.tinh_nang['ai-agent'].thu_muc = '../../.git/hooks'
    savePlan(root, p)
    rejected(root, RE, 'thu_muc', { verify: false })
    assert.ok(!exists(root, '.git/hooks/PLAN.md') && !exists(root, '.git/hooks/notes'))
    assert.ok(!exists(root, '.claude/so-chot/.migrated.json'))
  })

  test('bảng .migrate-plan.json bị sửa: thêm dòng nguồn ".git/config" (đúng băm) ⇒ từ chối, .git/config không bị dời', () => {
    const { root } = planned()
    const p = readPlan(root)
    p.dong.push({ nguon: '.git/config', sha: sha1(fs.readFileSync(path.join(root, '.git/config'))), loai: 'khac', tinh_nang: null, do_chac: 'cao', can_hoi: false, ly_do: 'x', luc: JTIME, chon: null, dich: null })
    savePlan(root, p)
    rejected(root, RE, '.git/config', { verify: false })
    assert.ok(!exists(root, 'docs/legacy/config'))
  })

  test('bảng .migrate-plan.json: "chon" là tên đặc biệt của Object ("constructor") không được coi là tính năng', () => {
    const { root } = planned()
    const p = readPlan(root)
    for (const r of p.dong) if (r.can_hoi) r.chon = 'constructor'
    savePlan(root, p)
    rejected(root, /không có tính năng "constructor"/, 'constructor', { verify: false })
  })

  const mutate = (fn) => {
    const ctx = applied()
    const J = journal(ctx.root)
    const key = Object.keys(J.nguon).find((k) => J.nguon[k].loai === 'decisions')
    fn(J, key)
    write(ctx.root, '.claude/so-chot/.migrated.json', JSON.stringify(J, null, 2))
    return ctx.root
  }
  const BAD_J = {
    'sha không phải 40 hex': (J, k) => { J.nguon[k].sha = 'zz' },
    'sha_sau là chuỗi lạ': (J, k) => { J.nguon[k].sha_sau = '--output=x' },
    'loai lạ': (J, k) => { J.nguon[k].loai = 'chay-lenh' },
    'pham_vi có ..': (J, k) => { J.nguon[k].pham_vi = '../../x' },
    'dich vào .git': (J, k) => { J.nguon[k].dich = '.git/hooks/pre-commit' },
    'y.file thoát ra ngoài': (J) => { J.y['0'.repeat(40)] = { ma: 'x', file: '../../.git/hooks/pre-commit', pham_vi: 'chung' } },
    'sua_tro vào .git': (J) => { J.sua_tro = ['.git/hooks/pre-commit'] },
    'sua_tro không phải mảng': (J) => { J.sua_tro = '../x' },
    'nguon không phải object': (J) => { J.nguon = [] },
  }
  for (const [name, fn] of Object.entries(BAD_J)) {
    test(`nhật ký sai dạng (${name}) ⇒ apply và verify đều từ chối, không đổi gì`, () => {
      rejected(mutate(fn), RE, name)
    })
  }
})

describe('R2: mã commit đọc từ nhật ký', () => {
  const RE = /không hợp lệ/
  const setCommit1 = (root, v) => { const J = journal(root); J.commit1 = v; write(root, '.claude/so-chot/.migrated.json', JSON.stringify(J, null, 2)) }

  test('commit1 = "--output=<tệp ngoài repo>" ⇒ verify và apply từ chối, không tạo tệp (trước đây git show ghi đè tệp đó)', () => {
    const { root } = applied()
    const out = path.join(TMP, `r2-pwned-${++seq}.txt`)
    setCommit1(root, `--output=${out}`)
    assert.throws(() => M.verify(root), RE)
    assert.ok(!fs.existsSync(out), 'verify không được tạo tệp')
    const n = nCommits(root)
    assert.throws(() => M.apply(root), RE)
    assert.equal(nCommits(root), n)
    assert.ok(!fs.existsSync(out), 'apply không được tạo tệp')
    const r = spawnSync(process.execPath, [SCRIPT, 'verify', root], { encoding: 'utf8', env: process.env })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^lỗi: [^\n]*không hợp lệ[^\n]*\n$/)
    assert.ok(!fs.existsSync(out), 'CLI không được tạo tệp')
  })

  test('commit1 phải là 7–40 ký tự hex thường; mọi dạng khác (tuỳ chọn, tên ref, hoa, có xuống dòng, kiểu lạ) bị từ chối', () => {
    const { root } = applied()
    const real = journal(root).commit1
    for (const bad of ['--output=x', '-h', '--end-of-options', 'abc123', 'HEAD', 'HEAD~1', 'main', real.toUpperCase(), `${real}0`, `${real}\n--output=x`, `${real.slice(0, 8)} `, 42, {}, []]) {
      setCommit1(root, bad)
      assert.throws(() => M.verify(root), RE, JSON.stringify(bad))
    }
    setCommit1(root, real.slice(0, 7))
    assert.ok(M.verify(root).ok, 'dạng rút gọn 7 ký tự hợp lệ vẫn dùng được')
    setCommit1(root, real)
    assert.ok(M.verify(root).ok)
  })

  test('mã đúng dạng nhưng không còn trong lịch sử (rebase/squash) ⇒ chỉ cảnh báo như trước, không lỗi', () => {
    const { root } = applied()
    setCommit1(root, 'deadbeef')
    const v = M.verify(root)
    assert.ok(v.canh_bao.some((c) => /commit 1 không còn trong lịch sử/.test(c)), v.canh_bao.join(' | '))
  })
})

describe('R3: apply kiểm .gitignore cho mọi file sẽ commit TRƯỚC khi đổi gì', () => {
  const GI = '.claude/*\n!.claude/plans/\n'
  const mk = (gi = GI) => makeRepo({ tracked: { '.gitignore': gi, '.claude/plans/alpha.plan.md': '# a\n', '.claude/plans/alpha.decisions.md': '- A1\n' } })

  test('.gitignore `.claude/*` + `!.claude/plans/`: báo một dòng tiếng Việt cách sửa, không đổi gì; thêm dòng `!` theo gợi ý thì chạy được', () => {
    const root = mk()
    M.plan(root)
    const base = nCommits(root)
    const before = snapFiles(root)
    let err
    try { M.apply(root) } catch (e) { err = e }
    assert.ok(err, 'phải lỗi')
    assert.match(err.message, /^[^\n]+$/, 'một dòng')
    assert.match(err.message, /git đang bỏ qua.*\.gitignore.*`!\.claude\/so-chot\/`.*chưa đổi gì/)
    assert.equal(nCommits(root), base)
    assert.deepEqual(snapFiles(root), before, 'không file/thư mục nào đổi')
    assert.ok(!exists(root, '.claude/so-chot/.migrated.json') && !exists(root, 'docs'))
    assert.equal(gitOk(root, 'diff', '--cached', '--name-only').trim(), '')
    assert.ok(exists(root, '.claude/plans/alpha.plan.md'))
    const fix = [...err.message.matchAll(/`(![^`]+)`/g)].map((m) => m[1])
    fs.appendFileSync(path.join(root, '.gitignore'), `${fix.join('\n')}\n`)
    M.apply(root)
    assert.equal(nCommits(root), base + 2)
    assert.equal(porcelain(root), 'M .gitignore')
    assert.ok(M.verify(root).ok)
  })

  for (const [pattern, path0] of [
    ['.claude/so-chot/.migrated.json', '.claude/so-chot/.migrated.json'],
    ['.claude/so-chot/.migrate-plan.json', '.claude/so-chot/.migrate-plan.json'],
    ['.claude/so-chot/INDEX.md', '.claude/so-chot/INDEX.md'],
    ['.claude/so-chot/*/', '.claude/so-chot/2026-05-01-alpha/x.md'],
    ['docs/ROADMAP.md', 'docs/ROADMAP.md'],
    ['docs/ROADMAP-luu-tru.md', 'docs/ROADMAP-luu-tru.md'],
    ['docs/IDEAS.md', 'docs/IDEAS.md'],
    ['.gitattributes', '.gitattributes'],
  ]) {
    test(`file ${path0} bị bỏ qua (luật "${pattern}") ⇒ từ chối trước khi đổi gì, nêu đúng file đó`, () => {
      const root = mk(`${pattern}\n`)
      M.plan(root)
      const base = nCommits(root)
      const before = snapFiles(root)
      assert.throws(() => M.apply(root), (e) => e.message.includes(path0) && /git đang bỏ qua.*\.gitignore/.test(e.message) && !e.message.includes('\n'))
      assert.equal(nCommits(root), base)
      assert.deepEqual(snapFiles(root), before)
      assert.ok(!exists(root, '.claude/so-chot/.migrated.json') && !exists(root, 'docs/specs'))
    })
  }

  test('file đã được theo dõi thì không bị coi là bị bỏ qua (chạy lại sau khi xong vẫn ổn)', () => {
    const root = mk('.claude/*\n!.claude/plans/\n!.claude/so-chot/\n')
    M.plan(root)
    M.apply(root)
    assert.equal(M.apply(root).da_xong, true)
  })
})

describe('R4: lần apply đầu không để git mv rơi vào commit 2', () => {
  test('lần đầu (chưa có nhật ký) mà index đã có file stage (kể cả .gitattributes) ⇒ từ chối, không đổi gì; bỏ stage rồi chạy lại ⇒ đủ 2 commit tách', () => {
    const { root, base } = planned()
    write(root, '.gitattributes', '* text=auto\n')
    gitOk(root, 'add', '.gitattributes')
    const before = snapFiles(root)
    assert.throws(() => M.apply(root), /index git đang có file đã stage.*\.gitattributes.*commit hoặc bỏ stage/)
    assert.equal(nCommits(root), base)
    assert.deepEqual(snapFiles(root), before)
    assert.equal(gitOk(root, 'diff', '--cached', '--name-only').trim(), '.gitattributes', 'index của người dùng giữ nguyên')
    assert.ok(!exists(root, '.claude/so-chot/.migrated.json'))
    gitOk(root, 'reset', '-q')
    M.apply(root)
    assert.equal(nCommits(root), base + 2)
    assert.ok(commitFiles(root, journal(root).commit1).every((l) => l.startsWith('R100\t')), 'commit 1 toàn đổi tên')
    assert.ok(M.verify(root).ok)
  })

  test('bị ngắt giữa chừng rồi người dùng stage thêm .gitattributes ⇒ chạy lại từ chối (không gộp git mv vào commit 2); bỏ stage thì xong đúng', () => {
    const { root, base } = planned()
    assert.throws(() => M.apply(root, { onBuoc: (b) => { if (b === 'mv:2') throw new Error('ngắt thử') } }), /ngắt thử/)
    write(root, '.gitattributes', '* text=auto\n')
    gitOk(root, 'add', '.gitattributes')
    assert.throws(() => M.apply(root), /index git có file ngoài việc dời.*\.gitattributes.*commit hoặc bỏ stage/)
    assert.equal(nCommits(root), base, 'chưa có commit nào')
    gitOk(root, 'reset', '-q', '--', '.gitattributes')
    M.apply(root)
    assert.equal(nCommits(root), base + 2)
    assert.ok(commitFiles(root, journal(root).commit1).every((l) => l.startsWith('R100\t')), 'commit 1 toàn đổi tên')
    assert.ok(M.verify(root).ok)
  })
})

// ---------- vòng sửa 2 (QA): R9–R11 ----------

describe('R9: tóm tắt nói nội dung, tên file phân biệt được, ngày theo file', () => {
  const LONG = `Chốt ${Array.from({ length: 70 }, (_, i) => `từ${i}`).join(' ')}`
  const FEATS = { 'ai-agent': `- ${LONG}\n- hai\n- ba\n`, 'ai-agent-gaps': '- Giới hạn 5 lượt gọi tool mỗi phiên\n', 'ai-agent-jev-routing': '- Chọn router theo vùng\n- Cache kết quả 10 phút\n', 'ai-agent-tool-search': '# Tìm tool\n\n1. Dùng embedding để tìm tool\n2. Giới hạn 8 kết quả\n', trong: '# Chưa có gì\n' }
  const mk = () => makeRepo({ tracked: Object.fromEntries(Object.entries(FEATS).flatMap(([tn, dec]) => [[`.claude/plans/${tn}.plan.md`, `# ${tn}\n`], [`.claude/plans/${tn}.decisions.md`, dec]])) })

  test('tóm tắt = "Quyết định cũ của <tính năng>: <ý đầu, cắt ở ranh giới từ> (+N ý)" ≤ 200 ký tự; một ý ⇒ không có (+N ý); không tách được ý ⇒ nói rõ', () => {
    const root = mk()
    M.plan(root)
    M.apply(root)
    const by = (tn) => migrated(root).find((d) => d.pham_vi.endsWith(`-${tn}`))
    for (const d of migrated(root)) assert.ok(d.tom_tat.length <= 200, `${d.tom_tat.length}: ${d.tom_tat}`)
    assert.equal(migrated(root).length, Object.keys(FEATS).length)
    const long = by('ai-agent').tom_tat
    assert.match(long, /^Quyết định cũ của ai-agent: Chốt từ0 từ1 /)
    assert.match(long, /từ\d+… \(\+2 ý\)$/, 'ý đầu bị cắt ở ranh giới từ (không giữa từ), còn nguyên "(+2 ý)"')
    assert.equal(by('ai-agent-gaps').tom_tat, 'Quyết định cũ của ai-agent-gaps: Giới hạn 5 lượt gọi tool mỗi phiên')
    assert.equal(by('ai-agent-jev-routing').tom_tat, 'Quyết định cũ của ai-agent-jev-routing: Chọn router theo vùng (+1 ý)')
    assert.equal(by('ai-agent-tool-search').tom_tat, 'Quyết định cũ của ai-agent-tool-search: Dùng embedding để tìm tool (+1 ý)')
    assert.equal(by('trong').tom_tat, 'Quyết định cũ của trong (chưa tách được ý)')
    assert.ok(M.verify(root).ok)
  })

  test('tên file quyết định chứa slug tính năng đầy đủ: không trùng/cụt giữa các tính năng cùng tiền tố; không lẫn số ý', () => {
    const root = mk()
    M.plan(root)
    M.apply(root)
    const names = migrated(root).map((d) => [d.pham_vi.slice(11), path.basename(d.file)])
    for (const [tn, base] of names) assert.match(base, new RegExp(`^[a-z0-9]{8}-quyet-dinh-cu-${tn}\\.md$`), `${tn}: ${base}`)
    assert.equal(new Set(names.map(([, b]) => b.slice(9))).size, names.length, 'phần tên sau mã không trùng giữa các tính năng')
    assert.ok(M.verify(root).ok)
  })

  test('luc lấy ngày ghi trong file nếu có dòng ngày rõ ràng (Ngày / Ngày chốt / Date…, lấy sớm nhất; bỏ Cập nhật, Xong ngày, ngày sai/tương lai), không thì lần commit đầu; thư mục tính năng theo đó', () => {
    const root = makeRepo({
      iso: '2026-10-02T10:00:00+07:00',
      tracked: {
        '.claude/plans/alpha.plan.md': '# a\n',
        '.claude/plans/alpha.decisions.md': '# Quyết định alpha\n\n**Ngày:** 20/09/2025\n\n- A1 đầu tiên\n',
        '.claude/plans/beta.decisions.md': 'Cập nhật: 2025-09-30\nNgày chốt: 2025-09-15\nDate: 2025-09-17\n- B1 đầu tiên\n',
        '.claude/plans/gamma.decisions.md': 'Xong ngày: 2025-09-01\nNgày: 2025-13-45\n- C1 đầu tiên\n',
        '.claude/plans/eps.decisions.md': 'Ngày: 2099-01-01\n- E1 đầu tiên\n',
      },
    })
    const out = M.plan(root)
    const p = readPlan(root)
    assert.equal(rowOf(root, 'alpha.decisions.md').luc, '2025-09-20 00:00')
    assert.equal(rowOf(root, 'beta.decisions.md').luc, '2025-09-15 00:00')
    assert.equal(rowOf(root, 'gamma.decisions.md').luc, '2026-10-02 10:00')
    assert.equal(rowOf(root, 'eps.decisions.md').luc, '2026-10-02 10:00')
    assert.deepEqual(Object.fromEntries(Object.entries(p.tinh_nang).map(([k, v]) => [k, [v.thu_muc, v.nguon_ngay]])), {
      alpha: ['2025-09-20-alpha', 'file'], beta: ['2025-09-15-beta', 'file'], eps: ['2026-10-02-eps', 'git'], gamma: ['2026-10-02-gamma', 'git'],
    })
    assert.equal(out.tinh_nang, 4)
    M.apply(root)
    const d = (tn) => migrated(root).find((x) => x.pham_vi.endsWith(`-${tn}`))
    assert.deepEqual([d('alpha').pham_vi, d('alpha').luc], ['2025-09-20-alpha', '2025-09-20 00:00'])
    assert.deepEqual([d('beta').pham_vi, d('beta').luc], ['2025-09-15-beta', '2025-09-15 00:00'])
    assert.equal(d('gamma').luc, '2026-10-02 10:00')
    assert.ok(M.verify(root).ok)
  })
})

describe('R10: ROADMAP.md viết tay ở GỐC dự án cũng được dời', () => {
  const A = '2026-05-01-alpha'
  const ROOT_RM = '# Roadmap của tôi\n\n- Việc A\n- Kế hoạch: .claude/plans/alpha.plan.md\n- Mọi kế hoạch cũ ở `.claude/plans/` nhé\n'
  const DOCS_RM = '# Roadmap trong docs\n\n- Việc B\n'
  const DEST = 'docs/legacy/ROADMAP-goc-viet-tay.md'
  const mk = (extra = {}) => makeRepo({ tracked: { 'ROADMAP.md': ROOT_RM, 'README.md': 'Xem ROADMAP.md để biết kế hoạch (và docs/ROADMAP.md cho phần mới).\n', '.claude/plans/alpha.plan.md': '# a\n', '.claude/plans/alpha.decisions.md': '- A1 quyết định đầu tiên\n', ...extra } })

  test('plan: dòng roadmap_cu cho ROADMAP.md gốc → docs/legacy/ROADMAP-goc-viet-tay.md; apply: R100 ở commit 1, chỗ trỏ tới nó được sửa, ROADMAP mới được sinh, verify ok, chạy lại không đổi', () => {
    const root = mk()
    const base = nCommits(root)
    const out = M.plan(root)
    const r = rowOf(root, 'ROADMAP.md')
    assert.deepEqual([r.nguon, r.loai, r.dich, r.can_hoi], ['ROADMAP.md', 'roadmap_cu', DEST, false])
    assert.ok(out.thay_doi_phu.some((s) => /ROADMAP\.md.*ROADMAP-goc-viet-tay/.test(s)), out.thay_doi_phu.join(' | '))
    M.apply(root)
    assert.equal(nCommits(root), base + 2)
    assert.ok(!exists(root, 'ROADMAP.md'))
    assert.equal(read(root, DEST), ROOT_RM.replace('.claude/plans/alpha.plan.md', `docs/specs/${A}/PLAN.md`), 'chỗ trỏ tới file đã dời trong chính nó cũng được sửa')
    assert.equal(read(root, 'README.md'), 'Xem docs/legacy/ROADMAP-goc-viet-tay.md để biết kế hoạch (và docs/ROADMAP.md cho phần mới).\n', 'chỗ trỏ tới ROADMAP.md gốc được sửa; docs/ROADMAP.md không bị đụng')
    assert.ok(commitFiles(root, journal(root).commit1).includes(`R100\tROADMAP.md\t${DEST}`))
    assert.match(read(root, 'docs/ROADMAP.md'), /^<!-- tự sinh bởi so-chot\.mjs/)
    assert.equal(porcelain(root), '')
    const v = M.verify(root)
    assert.ok(v.ok, JSON.stringify(v.loi))
    assert.ok(v.can_sua_tay.mau.some((e) => e.file === DEST && e.cu === '.claude/plans/'), 'chỗ nhắc cả thư mục .claude/plans/ ở bản đã dời được báo để sửa tay')
    const files = gitOk(root, 'ls-files')
    assert.equal(M.apply(root).da_xong, true)
    assert.equal(gitOk(root, 'ls-files'), files)
    assert.equal(nCommits(root), base + 2)
  })

  test('có cả docs/ROADMAP.md viết tay: hai dòng, hai đích khác nhau, đều R100; bị ngắt giữa chừng rồi chạy lại vẫn đúng', () => {
    for (const stop of [null, 'mv:0', 'commit1', 'write']) {
      const root = mk({ 'docs/ROADMAP.md': DOCS_RM })
      const base = nCommits(root)
      M.plan(root)
      assert.deepEqual(readPlan(root).dong.filter((r) => r.loai === 'roadmap_cu').map((r) => [r.nguon, r.dich]).sort(), [['ROADMAP.md', DEST], ['docs/ROADMAP.md', 'docs/legacy/ROADMAP-viet-tay.md']])
      if (stop) assert.throws(() => M.apply(root, { onBuoc: (b) => { if (b === stop) throw new Error('ngắt thử') } }), /ngắt thử/)
      M.apply(root)
      assert.equal(nCommits(root), base + 2, String(stop))
      assert.ok(!exists(root, 'ROADMAP.md'))
      assert.equal(read(root, 'docs/legacy/ROADMAP-viet-tay.md'), DOCS_RM)
      assert.ok(read(root, DEST).startsWith('# Roadmap của tôi'))
      assert.match(read(root, 'docs/ROADMAP.md'), /^<!-- tự sinh bởi so-chot\.mjs/)
      assert.ok(commitFiles(root, journal(root).commit1).every((l) => l.startsWith('R100\t')), String(stop))
      assert.equal(porcelain(root), '', String(stop))
      assert.ok(M.verify(root).ok, String(stop))
    }
  })

  test('ROADMAP.md gốc do so-chot sinh (có dấu) hoặc rỗng thì không bị dời', () => {
    const root = makeRepo({ tracked: { 'ROADMAP.md': '<!-- tự sinh bởi so-chot.mjs, đừng sửa tay · stamp: 0 -->\n# Roadmap\n', '.claude/plans/alpha.plan.md': '# a\n' } })
    M.plan(root)
    assert.ok(!readPlan(root).dong.some((r) => r.nguon === 'ROADMAP.md'))
  })
})

describe('R11: chỗ trỏ đường cũ ở file không phải .md/.txt và chỗ nhắc cấp thư mục', () => {
  const A = '2026-05-01-alpha'
  const GO = 'package main\n// .claude/plans/alpha.plan.md\nfunc main() {}\n'
  const ASTRO = '---\n// xem .claude/plans/alpha.decisions.md\n---\n<p>x</p>\n'
  const YML = 'plan: .claude/plans/alpha.plan.md\n'
  const GUIDE = 'Xem .claude/plans/alpha.plan.md. Mọi thứ ở `.claude/plans/` (thư mục).\n'
  const RULE = 'ngoại lệ ".claude/plans/" sửa thẳng\n'
  const GI = '.claude/reports/*\n'
  const mk = () => makeRepo({
    tracked: {
      '.claude/plans/alpha.plan.md': '# a\n', '.claude/plans/alpha.decisions.md': '- A1 quyết định đầu tiên\n',
      'desktop/tray.go': GO, 'site/Footer.astro': ASTRO, 'config.yml': YML, 'docs/guide.md': GUIDE, '.claude/rules/worktree.md': RULE, 'notes.txt': 'chi tiết: .claude/plans/alpha.plan.md\n',
      '.gitignore': GI, 'bin.dat': Buffer.concat([Buffer.from('x'), Buffer.from([0]), Buffer.from('.claude/plans/alpha.plan.md')]),
    },
  })
  const key = (e) => `${e.file}:${e.dong} ${e.cu}${e.moi ? ` → ${e.moi}` : ''}`
  const WANT = [
    `.gitignore:1 .claude/reports/`, `.claude/rules/worktree.md:1 .claude/plans/`, `config.yml:1 .claude/plans/alpha.plan.md → docs/specs/${A}/PLAN.md`,
    `desktop/tray.go:2 .claude/plans/alpha.plan.md → docs/specs/${A}/PLAN.md`, 'docs/guide.md:1 .claude/plans/', `site/Footer.astro:2 .claude/plans/alpha.decisions.md → docs/specs/${A}/notes/decisions.md`,
  ].sort()

  test('plan: quét mọi file text đã theo dõi (không chỉ theo đuôi); chỉ .md/.txt được tự sửa; còn lại + nhắc thư mục nằm ở "cần sửa tay" (bảng + kết quả), có cảnh báo', () => {
    const root = mk()
    const out = M.plan(root)
    const p = readPlan(root)
    assert.deepEqual(p.can_sua_tay.map(key).sort(), WANT)
    assert.deepEqual(p.tro_cu.filter((e) => e.sua).map((e) => e.file).sort(), ['docs/guide.md', 'notes.txt'])
    assert.equal(out.can_sua_tay.tong, 6)
    assert.deepEqual(out.can_sua_tay.mau.map(key).sort(), WANT)
    assert.ok(out.canh_bao.some((c) => /6 chỗ trong 6 file.*sửa tay/.test(c)), out.canh_bao.join(' | '))
    assert.equal(out.tro_cu.se_sua, 2)
  })

  test('apply: file không phải .md/.txt giữ nguyên từng byte, .md/.txt được sửa; verify ok kèm danh sách sửa tay (cảnh báo, không làm verify đỏ)', () => {
    const root = mk()
    const base = nCommits(root)
    M.plan(root)
    const res = M.apply(root)
    assert.equal(nCommits(root), base + 2)
    assert.equal(porcelain(root), '')
    for (const [rel, text] of [['desktop/tray.go', GO], ['site/Footer.astro', ASTRO], ['config.yml', YML], ['.claude/rules/worktree.md', RULE], ['.gitignore', GI]]) assert.equal(read(root, rel), text, rel)
    assert.equal(read(root, 'docs/guide.md'), `Xem docs/specs/${A}/PLAN.md. Mọi thứ ở \`.claude/plans/\` (thư mục).\n`)
    assert.equal(read(root, 'notes.txt'), `chi tiết: docs/specs/${A}/PLAN.md\n`)
    assert.deepEqual(res.tro_cu_sua.slice().sort(), ['docs/guide.md', 'notes.txt'])
    const v = M.verify(root)
    assert.ok(v.ok, JSON.stringify(v.loi))
    assert.deepEqual(v.loi, [])
    assert.equal(v.can_sua_tay.tong, 6)
    assert.deepEqual(v.can_sua_tay.mau.map(key).sort(), WANT)
    assert.ok(v.canh_bao.some((c) => /6 chỗ trong 6 file.*sửa tay/.test(c)), v.canh_bao.join(' | '))
    const r = spawnSync(process.execPath, [SCRIPT, 'verify', root], { encoding: 'utf8', env: process.env })
    assert.equal(r.status, 0, r.stderr)
  })
})

// ---------- CLI ----------

describe('CLI', () => {
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: process.env })

  test('plan → apply → verify: stdout JSON, exit 0; thiếu đối số / lệnh lạ / chưa duyệt ⇒ exit 1 + một dòng stderr', () => {
    const root = legacyRepo()
    for (const args of [[], ['plan'], ['xoa', root]]) {
      const r = cli(...args)
      assert.equal(r.status, 1)
      assert.match(r.stderr, /^lỗi: dùng: legacy-migrate\.mjs <plan\|apply\|verify> <projectRoot>\n$/)
    }
    const p = cli('plan', root)
    assert.equal(p.status, 0, p.stderr)
    assert.equal(JSON.parse(p.stdout).tong, N_FILES)
    const bad = cli('apply', root)
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /^lỗi: bảng chưa duyệt xong/)
    assert.equal(bad.stderr.trim().split('\n').length, 1)
    const plan = readPlan(root)
    for (const r of plan.dong) if (r.can_hoi) r.chon = 'ai-agent-gaps-2'
    savePlan(root, plan)
    const a = cli('apply', root)
    assert.equal(a.status, 0, a.stderr)
    assert.equal(JSON.parse(a.stdout).quyet_dinh_moi, N_ITEMS)
    const v = cli('verify', root)
    assert.equal(v.status, 0, v.stderr)
    assert.equal(JSON.parse(v.stdout).ok, true)
    fs.rmSync(path.join(root, '.claude/so-chot', GAPS_DIR), { recursive: true })
    const v2 = cli('verify', root)
    assert.equal(v2.status, 1)
    const j = JSON.parse(v2.stdout)
    assert.equal(j.ok, false)
    assert.ok(j.loi.some((l) => l.loai === 'thieu'))
  })

  test('thư mục không phải gốc repo git ⇒ lỗi rõ', () => {
    const dir = path.join(TMP, 'khong-git')
    fs.mkdirSync(dir, { recursive: true })
    const r = cli('plan', dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /không phải repo git|thư mục gốc của repo git/)
  })
})
