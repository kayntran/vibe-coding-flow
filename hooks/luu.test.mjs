// Test cho CLI luu.mjs: node --test ~/.claude/hooks/luu.test.mjs
// Chạy script thật qua spawnSync trên repo git tạm (đường dẫn có dấu cách + tiếng Việt). Không mạng; cấu hình git của máy không bị đụng.
// Khoá giả được GHÉP chuỗi lúc chạy để file test này không tự bị máy quét khoá bắt.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanHidden } from './lib/secrets.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'luu.mjs')
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luu cli thử ')))
const CFG = path.join(TMP, 'gitconfig')
before(() => fs.writeFileSync(CFG, ''))
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'FLOW_LUU_NOW')),
  GIT_CONFIG_GLOBAL: CFG, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@t.t',
  // Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
}
const FAKE_KEY = ['gh', 'p_', 'Ab1Cd2Ef3G'.repeat(4)].join('')
let seq = 0
const mk = (name = 'dự án thử') => { const d = path.join(TMP, `${name} ${++seq}`); fs.mkdirSync(d, { recursive: true }); return d }
const wr = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
const rd = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const cli = (args, env = ENV) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env })
function g(root, ...args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', env: ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const commit = (root, msg) => { g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', msg) }
const nowEnv = (iso) => ({ ...ENV, FLOW_LUU_NOW: iso })

// Dự án thử: bat → "Thêm trang đăng nhập" → "Thêm giỏ hàng" (có đổi eslint.config.js ở giữa để thử exit 4).
function project() {
  const root = mk()
  wr(root, 'a.txt', '1\n'); wr(root, 'app.db', 'db1')
  assert.equal(cli(['bat', root], nowEnv('2026-10-12T10:00:00')).status, 0)
  wr(root, 'a.txt', '2\n'); wr(root, 'login.txt', 'login\n'); commit(root, 'Thêm màn đăng nhập')
  const t2 = cli(['tao', root, 'Thêm', 'trang', 'đăng', 'nhập'], nowEnv('2026-10-12T10:10:00'))
  assert.equal(t2.status, 0, t2.stderr)
  wr(root, 'a.txt', '3\n'); wr(root, 'cart.txt', 'cart\n'); wr(root, 'eslint.config.js', 'strict\n'); commit(root, 'Thêm giỏ hàng')
  assert.equal(cli(['tao', root, 'Thêm giỏ hàng'], nowEnv('2026-10-12T10:20:00')).status, 0)
  return root
}
const P1 = 'luu/20261012-1000-bat-dau'
const P2 = 'luu/20261012-1010-them-trang-dang-nhap'
const P3 = 'luu/20261012-1020-them-gio-hang'

describe('dùng sai ⇒ exit 2', () => {
  const cases = [
    [[], 'không có đối số'], [['bat'], 'thiếu thư mục'], [['khong-co', 'x'], 'lệnh lạ'], [['ds', 'x', '--zzz'], 'cờ lạ'],
    [['quay', 'x'], 'thiếu điểm'], [['quay', 'x', 'luu/a', '--viec-do', 'xoa'], '--viec-do sai'], [['quay', 'x', 'luu/a', '--viec-do'], '--viec-do thiếu giá trị'],
    [['tao', 'x'], 'thiếu tên'], [['tim', 'x'], 'thiếu câu'], [['xem', 'x'], 'thiếu điểm'], [['bat', 'x', 'thừa'], 'thừa đối số'], [['ds', 'x', 'thừa'], 'thừa đối số'],
  ]
  for (const [args, why] of cases) {
    test(why, () => {
      const r = cli(args)
      assert.equal(r.status, 2, `${r.stdout}${r.stderr}`)
      assert.match(r.stderr, /dùng: luu\.mjs/)
    })
  }
  test('--help ⇒ exit 0 và in cách dùng', () => {
    const r = cli(['--help'])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /bat .*tao .*ds .*tim .*xem .*quay/s)
  })
})

describe('bat · tao · ds · tim · xem', () => {
  test('bat: tạo git + điểm "Bắt đầu"; chạy lại chỉ báo một dòng; thư mục không có ⇒ exit 1', () => {
    const root = mk()
    wr(root, 'a.txt', '1')
    const r = cli(['bat', root], nowEnv('2026-10-12T09:05:00'))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Đã bật điểm lưu.*Bắt đầu.*luu\/20261012-0905-bat-dau/)
    const again = cli(['bat', root])
    assert.equal(again.status, 0)
    assert.equal(again.stdout.trim(), 'Đã có git ở đây, không đổi gì.')
    const bad = cli(['bat', path.join(TMP, 'khong-co')])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /^lỗi: Không thấy thư mục/)
  })

  test('bat: file có khoá bí mật ⇒ exit 1, nêu file, không in khoá, không commit', () => {
    const root = mk()
    wr(root, 'cfg.js', `export const t = "${FAKE_KEY}"\n`)
    const r = cli(['bat', root])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /cfg\.js:1/)
    assert.equal((r.stdout + r.stderr).includes('ghp_'), false)
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, env: ENV }).status, 0)
  })

  test('tao: tên nhiều từ không cần nháy; HEAD đã có điểm ⇒ báo không tạo thêm', () => {
    const root = project()
    const again = cli(['tao', root, 'Tên', 'khác'])
    assert.equal(again.status, 0)
    assert.match(again.stdout, /đã là điểm lưu "Thêm giỏ hàng".*không tạo thêm/)
    assert.equal(g(root, 'tag', '-l', 'luu/*').split('\n').length, 3)
  })

  test('ds: mới nhất trước, có số việc; --json ra mảng nguyên vẹn', () => {
    const root = project()
    const r = cli(['ds', root])
    assert.equal(r.status, 0, r.stderr)
    const lines = r.stdout.trim().split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0], /"Thêm giỏ hàng".*luu\/20261012-1020-them-gio-hang.*mới nhất/)
    assert.match(lines[1], /"Thêm trang đăng nhập".*1 việc sau đó/)
    assert.match(lines[2], /"Bắt đầu".*2 việc sau đó/)
    const j = JSON.parse(cli(['ds', root, '--json']).stdout)
    assert.deepEqual(j.map((p) => p.tag), [P3, P2, P1])
    assert.deepEqual(j.map((p) => p.since), [0, 1, 2])
  })

  test('ds trên dự án không phải git ⇒ exit 1 + hướng dẫn bat', () => {
    const r = cli(['ds', mk()])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /chưa dùng git.*luu\.mjs bat/)
  })

  test('tim: khớp không dấu; --json; không khớp ⇒ exit 0 + một dòng', () => {
    const root = project()
    const r = cli(['tim', root, 'dang nhap'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout.split('\n')[0], /^1\. "Thêm trang đăng nhập" — .* · luu\/20261012-1010-them-trang-dang-nhap · [0-9a-f]+$/)
    assert.equal(JSON.parse(cli(['tim', root, 'gio', 'hang', '--json']).stdout)[0].tag, P3)
    const none = cli(['tim', root, 'xyzzy plugh'])
    assert.equal(none.status, 0)
    assert.equal(none.stdout.trim(), 'Không có điểm lưu nào khớp.')
  })

  test('xem: nói bằng lời những gì sẽ bị gỡ, kèm file luật, việc dở, nhắc dữ liệu; --json', () => {
    const root = project()
    wr(root, 'dang-do.txt', 'x')
    const r = cli(['xem', root, P1])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Quay về "Bắt đầu" .* sẽ gỡ:/)
    assert.match(r.stdout, /2 điểm lưu sau đó.*"Thêm giỏ hàng".*"Thêm trang đăng nhập"/)
    assert.match(r.stdout, /2 việc đã làm sau đó: Thêm giỏ hàng; Thêm màn đăng nhập/)
    assert.match(r.stdout, /việc đang dở chưa lưu \(1 file: dang-do\.txt\)/)
    assert.match(r.stdout, /LUẬT KIỂM TRA sẽ đổi.*--doi-luat.*eslint\.config\.js/)
    assert.match(r.stdout, /Dữ liệu trong app .* không quay theo/)
    const j = JSON.parse(cli(['xem', root, P1, '--json']).stdout)
    assert.deepEqual(j.ruleFiles, ['eslint.config.js'])
    assert.deepEqual(j.dirty, ['dang-do.txt'])
    assert.equal(j.target.name, 'Bắt đầu')
  })

  test('tên điểm lưu có ký tự ẩn/điều khiển (do người khác đặt) không lọt ra đầu ra', () => {
    const root = project()
    g(root, 'tag', '-a', 'luu/20261012-1030-doc-hai', '-m', 'A​B‮C \u001b[31mđỏ', 'HEAD~1')
    const out = cli(['ds', root]).stdout + cli(['tim', root, 'doc hai']).stdout
    assert.equal(scanHidden(out).length, 0)
    assert.equal(out.includes('\u001b'), false)
    assert.match(out, /"ABC \[31mđỏ"/)
  })
})

describe('quay', () => {
  test('việc dở mà thiếu cờ ⇒ exit 3 + câu hỏi + danh sách file; không đổi gì', () => {
    const root = project()
    wr(root, 'a.txt', 'đang sửa\n')
    const r = cli(['quay', root, P2, '--doi-luat', '--khong-kiem'])
    assert.equal(r.status, 3)
    assert.match(r.stdout, /Giữ hay bỏ\? .*--viec-do giu.*--viec-do bo/)
    assert.match(r.stdout, /^- a\.txt$/m)
    assert.equal(rd(root, 'a.txt'), 'đang sửa\n')
    assert.equal(g(root, 'tag', '-l', 'luu/*').split('\n').length, 3)
  })

  test('chạm file luật ⇒ exit 4 + liệt kê; --doi-luat thì chạy', () => {
    const root = project()
    const r = cli(['quay', root, P1, '--khong-kiem'])
    assert.equal(r.status, 4, `${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /đổi luật kiểm tra.*--doi-luat/)
    assert.match(r.stdout, /^- eslint\.config\.js \(sẽ bị gỡ\)$/m)
    assert.equal(rd(root, 'a.txt'), '3\n')
    const ok = cli(['quay', root, P1, '--doi-luat', '--khong-kiem'])
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`)
    assert.equal(rd(root, 'a.txt'), '1\n')
    assert.equal(fs.existsSync(path.join(root, 'eslint.config.js')), false)
  })

  test('quay thành công: nói điểm mới, điểm vừa rời, dữ liệu không quay theo; quay nhầm quay lại được', () => {
    const root = project()
    wr(root, 'a.txt', 'đang sửa\n')
    const r = cli(['quay', root, P2, '--viec-do', 'giu', '--doi-luat', '--khong-kiem'], nowEnv('2026-10-12T11:00:00'))
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /^Đã quay về "Thêm trang đăng nhập"/)
    assert.match(r.stdout, /Việc đang dở đã lưu thành điểm "Lưu tạm trước khi quay lại" \(luu\/20261012-1100-luu-tam-truoc-khi-quay-lai\)/)
    assert.match(r.stdout, /Điểm lưu mới: commit [0-9a-f]+, luu\/20261012-1100-quay-lai-them-trang-dang-nhap/)
    assert.match(r.stdout, /^Điểm vừa rời: "Lưu tạm trước khi quay lại" /m)
    assert.match(r.stdout, /^Quay nhầm thì chạy: luu\.mjs quay <thư mục> luu\/20261012-1100-luu-tam-truoc-khi-quay-lai --viec-do bo/m)
    assert.match(r.stdout, /Dữ liệu trong app .* không quay theo/)
    assert.equal(r.stdout.match(/không quay theo/g).length, 1, 'chỉ một dòng nói dữ liệu không quay theo')
    for (const l of r.stdout.split('\n')) assert.ok(l.length <= 170, `dòng quá dài (${l.length}): ${l}`)
    // giu = cất rồi ĐẶT LẠI file dở vào thư mục làm việc (chưa lưu): a.txt là bản đang sửa, git thấy là file đã sửa
    assert.match(r.stdout, /Đã đặt lại vào thư mục làm việc \(1 file, chưa lưu\): a\.txt/)
    assert.equal(rd(root, 'a.txt'), 'đang sửa\n')
    assert.equal(g(root, 'status', '--porcelain').trim(), 'M a.txt')
    // quay nhầm: về lại điểm vừa rời (luật eslint.config.js quay lại ⇒ lại cần người dùng gật, nên có --doi-luat; a.txt đang dở nên chọn --viec-do)
    const left = 'luu/20261012-1100-luu-tam-truoc-khi-quay-lai'
    const noFlag = cli(['quay', root, left, '--khong-kiem'], nowEnv('2026-10-12T11:05:00'))
    assert.equal(noFlag.status, 4, `${noFlag.stdout}${noFlag.stderr}`)
    const back = cli(['quay', root, left, '--doi-luat', '--viec-do', 'bo', '--khong-kiem'], nowEnv('2026-10-12T11:05:00'))
    assert.equal(back.status, 0, `${back.stdout}${back.stderr}`)
    assert.equal(rd(root, 'a.txt'), 'đang sửa\n')
    assert.equal(rd(root, 'eslint.config.js'), 'strict\n')
  })

  test('--viec-do bo: cất rồi thôi — thư mục làm việc về sạch, nói rõ cách lấy lại; khác hẳn câu của giu', () => {
    const root = project()
    wr(root, 'a.txt', 'đang sửa\n')
    const r = cli(['quay', root, P2, '--viec-do', 'bo', '--doi-luat', '--khong-kiem'], nowEnv('2026-10-12T11:00:00'))
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /Việc đang dở đã lưu thành điểm "Việc dở đã bỏ — lưu tạm trước khi quay lại" rồi bỏ khỏi thư mục làm việc/)
    assert.match(r.stdout, /Muốn lấy lại: luu\.mjs quay <thư mục> luu\/20261012-1100-viec-do-da-bo-luu-tam-truoc-khi-quay-lai/)
    for (const l of r.stdout.split('\n')) assert.ok(l.length <= 170, `dòng quá dài (${l.length}): ${l}`)
    assert.doesNotMatch(r.stdout, /đặt lại vào thư mục làm việc/)
    assert.equal(rd(root, 'a.txt'), '2\n')
    assert.equal(g(root, 'status', '--porcelain'), '')
  })

  test('việc dở thiếu cờ: câu hỏi giải thích khác biệt giu / bo', () => {
    const root = project()
    wr(root, 'a.txt', 'đang sửa\n')
    const r = cli(['quay', root, P2, '--doi-luat', '--khong-kiem'])
    assert.equal(r.status, 3)
    assert.match(r.stdout, /--viec-do giu = .*đặt lại.*--viec-do bo = .*về đúng điểm/)
  })

  test('xem / quay nhận tên đời thường khi khớp duy nhất một điểm; khớp nhiều ⇒ exit 2 + liệt kê để chọn (stderr), không đổi gì', () => {
    const root = project()
    const v = cli(['xem', root, 'thêm trang đăng nhập'])
    assert.equal(v.status, 0, v.stderr)
    assert.match(v.stdout, /Quay về "Thêm trang đăng nhập"/)
    const amb = cli(['quay', root, 'thêm', '--doi-luat', '--khong-kiem'])
    assert.equal(amb.status, 2, `${amb.stdout}${amb.stderr}`)
    assert.match(amb.stderr, /Có 2 điểm lưu khớp "thêm" — gõ rõ hơn hoặc dùng tên đầy đủ/)
    assert.ok(amb.stderr.includes(P2) && amb.stderr.includes(P3), amb.stderr)
    assert.equal(rd(root, 'a.txt'), '3\n')
    const ok = cli(['quay', root, 'Thêm trang đăng nhập', '--doi-luat', '--khong-kiem'], nowEnv('2026-10-12T11:00:00'))
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`)
    assert.equal(rd(root, 'a.txt'), '2\n')
  })

  test('dữ liệu theo dõi sẵn (app.db) không đổi; gộp vào một dòng "không quay theo; giữ nguyên: …"', () => {
    const root = mk()
    wr(root, 'a.txt', '1\n')
    assert.equal(cli(['bat', root], nowEnv('2026-10-12T10:00:00')).status, 0)
    wr(root, 'app.db', 'db-v1'); wr(root, 'a.txt', '2\n'); g(root, 'add', '-f', 'app.db'); commit(root, 'thêm db')
    const r = cli(['quay', root, P1, '--khong-kiem'], nowEnv('2026-10-12T10:30:00'))
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /Dữ liệu trong app \(database, tệp tải lên\) không quay theo; giữ nguyên: app\.db\./)
    assert.equal(r.stdout.match(/không quay theo/g).length, 1)
    assert.equal(rd(root, 'app.db'), 'db-v1')
    assert.equal(rd(root, 'a.txt'), '1\n')
  })

  test('việc dở chứa khoá ⇒ exit 1 + nêu file, không in khoá, không commit', () => {
    const root = project()
    wr(root, 'src/k.js', `const k = "${FAKE_KEY}"\n`)
    const head = g(root, 'rev-parse', 'HEAD')
    const r = cli(['quay', root, P2, '--viec-do', 'bo', '--doi-luat', '--khong-kiem'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^lỗi: .*src\/k\.js:1 — github/s)
    assert.equal((r.stdout + r.stderr).includes('ghp_'), false)
    assert.equal(g(root, 'rev-parse', 'HEAD'), head)
  })

  test('sai nơi: worktree, nhánh khác, điểm không có ⇒ exit 1 với câu đời thường', () => {
    const root = project()
    const wt = path.join(TMP, `wt ${++seq}`)
    g(root, 'worktree', 'add', '-q', '-b', 'phu', wt)
    const inWt = cli(['quay', wt, P2, '--khong-kiem'])
    assert.equal(inWt.status, 1)
    assert.match(inWt.stderr, /bản làm việc riêng/)
    assert.match(cli(['quay', root, 'luu/khong-co', '--khong-kiem']).stderr, /Không có điểm lưu/)
    g(root, 'switch', '-q', '-c', 'tinh-nang')
    assert.match(cli(['quay', root, P2, '--khong-kiem']).stderr, /không phải nhánh chính/)
  })

  test('không có --khong-kiem ⇒ chạy máy kiểm của kit và in kết quả (không chặn)', () => {
    const root = mk()
    wr(root, 'a.txt', '1\n')
    cli(['bat', root], nowEnv('2026-10-12T10:00:00'))
    wr(root, 'a.txt', '2\n'); commit(root, 'đổi')
    const r = cli(['quay', root, P1], nowEnv('2026-10-12T10:30:00'))
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    const checkLines = r.stdout.split('\n').filter((l) => /Máy kiểm/.test(l))
    assert.equal(checkLines.length, 1, `chỉ một dòng tổng, không in cả bảng: ${r.stdout}`)
    assert.match(checkLines[0], /^Máy kiểm sau khi quay: (đạt\.|\d+ mục chưa đạt \(không chặn\)\. Xem chi tiết: node .*flow-check\.mjs --dir )/)
    assert.doesNotMatch(r.stdout, /Kết quả: |^THIẾU|^KHÔNG |^\s+->/m)
  })

  test('đang ở đúng điểm đó ⇒ nói không có gì để quay, exit 0', () => {
    const root = project()
    const r = cli(['quay', root, P3, '--khong-kiem'])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /Đang ở đúng "Thêm giỏ hàng" rồi/)
  })
})
