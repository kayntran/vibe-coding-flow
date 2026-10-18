// Test cho CLI arch.mjs: node --test ~/.claude/hooks/arch.test.mjs
// Chạy script thật trong thư mục tạm. Phần công cụ ngoài đã được test bằng runner giả ở lib/arch.test.mjs;
// ở đây chỉ kiểm lệnh, cờ, mã thoát và lời báo.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'arch.mjs')
// Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền ⇒ dọn thư mục tạm gặp ENOTEMPTY); xem flow-dispatch.test.mjs.
Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' })
const roots = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'arch-cli-'))); roots.push(d); return d }
const put = (dir, rel, text = '') => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
const has = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')))
const cli = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts })
const nLines = (n) => `${Array.from({ length: n }, (_, i) => `// ${i}`).join('\n')}\n`
// dự án web có sẵn: tính năng a, b + shared (init sẽ suy module từ thư mục)
const webRepo = () => {
  const dir = tmp()
  put(dir, 'package.json', '{"name":"demo"}')
  put(dir, 'src/features/a/ui/A.ts', 'export const a = 1\n')
  put(dir, 'src/features/b/ui/B.ts', 'export const b = 1\n')
  put(dir, 'src/shared/u.ts', 'export const u = 1\n')
  return dir
}

describe('dùng sai lệnh', () => {
  test('không lệnh / lệnh lạ / thiếu giá trị cờ ⇒ exit 2 + dòng "dùng:"', () => {
    for (const args of [[], ['xoa-het'], ['init', '--stack'], ['size', '--changed']]) {
      const r = cli(args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /dùng:|cần một giá trị/)
    }
  })
})

describe('init', () => {
  test('dự án mới: --stack web tạo hai file, exit 0, dặn bước tiếp; chạy lại ⇒ "đã có", không đổi file', () => {
    const dir = tmp()
    const r = cli(['init', '--stack', 'web', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Đã tạo docs\/arch\.json/)
    assert.match(r.stdout, /Đã tạo docs\/ARCHITECTURE\.md/)
    assert.match(r.stdout, /arch\.mjs gen/)
    const before = [read(dir, 'docs/arch.json'), read(dir, 'docs/ARCHITECTURE.md')]
    const again = cli(['init', '--stack', 'web', '--dir', dir])
    assert.equal(again.status, 0)
    assert.match(again.stdout, /docs\/arch\.json đã có/)
    assert.match(again.stdout, /docs\/ARCHITECTURE\.md đã có/)
    assert.deepEqual([read(dir, 'docs/arch.json'), read(dir, 'docs/ARCHITECTURE.md')], before)
  })
  test('--dir mặc định là thư mục hiện tại; wails tạo cả phần web lẫn go', () => {
    const dir = tmp()
    const r = cli(['init', '--stack', 'wails'], { cwd: dir })
    assert.equal(r.status, 0, r.stderr)
    const arch = JSON.parse(read(dir, 'docs/arch.json'))
    assert.deepEqual(arch.parts.map((p) => p.root), ['frontend/src', 'internal'])
  })
  test('dự án có sẵn: suy module từ thư mục, báo soát lại; sync xanh ngay sau đó', () => {
    const dir = webRepo()
    const r = cli(['init', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /suy 3 module/)
    const arch = JSON.parse(read(dir, 'docs/arch.json'))
    assert.deepEqual(arch.parts[0].modules.map((m) => m.name), ['features/a', 'features/b', 'shared'])
    assert.equal(cli(['sync', '--dir', dir]).status, 0)
  })
  test('stack lạ hoặc không nhận ra ⇒ exit 1 + một dòng lỗi', () => {
    const bad = cli(['init', '--stack', 'cobol', '--dir', tmp()])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /stack phải là/)
    const none = cli(['init', '--dir', tmp()])
    assert.equal(none.status, 1)
    assert.match(none.stderr, /--stack/)
    assert.equal(none.stderr.trim().split('\n').length, 1)
  })
})

describe('sync', () => {
  test('khớp ⇒ exit 0; thêm thư mục tính năng chưa khai báo ⇒ exit 1 kèm tên thư mục và lời sửa', () => {
    const dir = webRepo()
    cli(['init', '--dir', dir])
    const ok = cli(['sync', '--dir', dir])
    assert.equal(ok.status, 0, ok.stdout)
    assert.match(ok.stdout, /khớp: 3 module/)
    put(dir, 'src/features/billing/ui/Pay.ts', 'export const p = 1\n')
    const bad = cli(['sync', '--dir', dir])
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /src\/features\/billing/)
    assert.match(bad.stdout, /Sửa: .*Codemap/)
  })
  test('chưa có arch.json ⇒ exit 1 nói chạy init', () => {
    const r = cli(['sync', '--dir', tmp()])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /arch\.mjs init/)
  })
})

describe('size', () => {
  test('file quá 400 dòng ⇒ exit 1; --changed chỉ xét file được nêu', () => {
    const dir = webRepo()
    cli(['init', '--dir', dir])
    assert.equal(cli(['size', '--dir', dir]).status, 0)
    put(dir, 'src/features/a/ui/Big.ts', nLines(450))
    put(dir, 'src/features/b/ui/Big2.ts', nLines(450))
    const all = cli(['size', '--dir', dir])
    assert.equal(all.status, 1)
    assert.match(all.stdout, /2 file quá trần/)
    assert.match(all.stdout, /Big\.ts dài 450 dòng, trần là 400/)
    assert.match(all.stdout, /Sửa: Hãy tách/)
    const some = cli(['size', '--dir', dir, '--changed', 'src/features/b/ui/Big2.ts,src/shared/u.ts'])
    assert.equal(some.status, 1)
    assert.match(some.stdout, /1 file quá trần/)
    assert.doesNotMatch(some.stdout, /Big\.ts dài/)
    assert.equal(cli(['size', '--dir', dir, '--changed', 'src/shared/u.ts']).status, 0)
  })
})

describe('arch.json hỏng', () => {
  test('size: nói đúng "docs/arch.json chưa dùng được" (không nhãn "file quá trần dòng"); lời sửa giống nhau chỉ in một lần; root kiểu option bị từ chối kèm lời dặn', () => {
    const dir = tmp()
    put(dir, 'docs/arch.json', JSON.stringify({ version: 1, parts: [{ name: 'web', stack: 'lạ', root: '--exclude', forbidden: [{ from: 'a' }] }] }))
    const r = cli(['size', '--dir', dir])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /docs\/arch\.json chưa dùng được \(\d+ lỗi\)/)
    assert.doesNotMatch(r.stdout, /quá trần/)
    assert.match(r.stdout, /"root" "--exclude" không dùng được/)
    assert.equal((r.stdout.match(/Sửa:/g) ?? []).length, 1, r.stdout)
  })
})

describe('gen', () => {
  test('web: ghi .dependency-cruiser.mjs, in khối ESLint; chạy lại cho cùng kết quả', () => {
    const dir = webRepo()
    cli(['init', '--dir', dir])
    const r = cli(['gen', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Đã ghi \.dependency-cruiser\.mjs/)
    assert.match(r.stdout, /max-lines-per-function/)
    const first = read(dir, '.dependency-cruiser.mjs')
    assert.equal(cli(['gen', '--dir', dir]).status, 0)
    assert.equal(read(dir, '.dependency-cruiser.mjs'), first)
  })
  test('web: .dependency-cruiser.cjs cũ do kit sinh ⇒ gen báo đã xoá và thay bằng .mjs', () => {
    const dir = webRepo()
    cli(['init', '--dir', dir])
    put(dir, '.dependency-cruiser.cjs', '// Sinh bởi: node ~/.claude/hooks/arch.mjs gen (từ docs/arch.json) — sửa docs/arch.json rồi chạy lại, đừng sửa tay file này.\nmodule.exports = {}\n')
    const r = cli(['gen', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Đã xoá \.dependency-cruiser\.cjs \(bản cũ do kit sinh, nay thay bằng \.dependency-cruiser\.mjs\)/)
    assert.equal(has(dir, '.dependency-cruiser.cjs'), false)
  })
  test('Go: .golangci.yml có sẵn không bị ghi đè, khối cần ghép được in ra', () => {
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
    put(dir, 'internal/billing/domain/d.go', 'package domain\n')
    put(dir, '.golangci.yml', '# của tôi\n')
    cli(['init', '--dir', dir])
    const r = cli(['gen', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(read(dir, '.golangci.yml'), '# của tôi\n')
    assert.match(r.stdout, /\.golangci\.yml đã có — kit không ghi đè/)
    assert.match(r.stdout, /depguard/)
    assert.match(r.stdout, /funlen/)
    assert.match(read(dir, '.go-arch-lint.yml'), /^# Sinh bởi.*\n[\s\S]*version: 3/)
  })
  test('arch.json hỏng ⇒ exit 1, không ghi file nào', () => {
    const dir = tmp()
    put(dir, 'docs/arch.json', '{')
    const r = cli(['gen', '--dir', dir])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /docs\/arch\.json/)
    assert.equal(has(dir, '.dependency-cruiser.mjs'), false)
  })
})

describe('baseline', () => {
  test('dự án chỉ có Go: không nhắc ranh giới web / ESLint; không có miền nào thì không cần go-arch-lint', () => {
    const dir = tmp()
    put(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n')
    put(dir, 'internal/x/a.go', 'package x\n')
    put(dir, 'docs/arch.json', JSON.stringify({ version: 1, parts: [{ name: 'go', stack: 'go', root: 'internal', modules: [], forbidden: [] }] }))
    const r = cli(['baseline', '--dir', dir])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Đã chốt mốc docs\/arch-baseline\.json/)
    assert.doesNotMatch(r.stdout, /ranh giới web|ESLint/)
    assert.match(r.stdout, /Go 0 vi phạm ranh giới cũ/)
  })
  test('phần web không chốt được ranh giới (chưa gen cấu hình depcruise) ⇒ exit 1 và nói rõ "CHƯA CHỐT: ranh giới web", không báo xong như thể ổn', () => {
    const dir = webRepo()
    cli(['init', '--dir', dir])
    const r = cli(['baseline', '--dir', dir])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /CHƯA CHỐT: ranh giới web/)
    assert.match(r.stdout, /ranh giới web chưa chốt/)
    assert.match(r.stdout, /arch\.mjs gen/)
  })
  test('chưa có depcruise (PATH trống) ⇒ THIẾU kèm đúng lệnh cài ghim typescript dưới 7 và nơi cài; exit 1', () => {
    const dir = webRepo()
    cli(['init', '--dir', dir])
    cli(['gen', '--dir', dir])
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'))
    const r = cli(['baseline', '--dir', dir], { env: { ...env, PATH: '' } })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /THIẾU depcruise — cài: npm i -D dependency-cruiser@\^18 typescript@\^6 \(chạy trong thư mục có package\.json của phần web/)
  })
  const sh =(dir, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
  test('ghi docs/arch-baseline.json với commit hiện tại và file đã quá trần; công cụ thiếu thì exit 1 kèm lệnh cài', () => {
    const dir = webRepo()
    put(dir, 'src/features/a/ui/Big.ts', nLines(450))
    cli(['init', '--dir', dir])
    cli(['gen', '--dir', dir])
    sh(dir, 'init', '-q')
    sh(dir, 'add', '-A')
    assert.equal(sh(dir, 'commit', '-q', '-m', 'goc').status, 0)
    const head = sh(dir, 'rev-parse', 'HEAD').stdout.trim()
    const r = cli(['baseline', '--dir', dir])
    const data = JSON.parse(read(dir, 'docs/arch-baseline.json'))
    assert.equal(data.base, head)
    assert.deepEqual(data.size, { 'src/features/a/ui/Big.ts': 450 })
    assert.match(r.stdout, /Đã chốt mốc docs\/arch-baseline\.json: commit /)
    assert.match(r.stdout, /1 file đã quá trần dòng/)
    // exit 1 ⇔ có công cụ THIẾU (máy có depcruise thì chạy thật và exit 0)
    assert.equal(r.status, /THIẾU|CHƯA CHỐT/.test(r.stdout) ? 1 : 0, r.stdout + r.stderr)
    // THIẾU vì chưa cài, hoặc vì đã cài nhưng Node của máy ngoài "engines" của nó — cả hai đều nói rõ phải làm gì
    if (r.status === 1) assert.match(r.stdout, /THIẾU depcruise — (cài: npm i -D dependency-cruiser|Máy kiểm kiến trúc web cần Node 22, Node 24 LTS hoặc Node 26 trở lên; máy đang dùng Node \d)/)
    // sau mốc: file cũ dài thêm bị bắt, file khác sạch
    assert.equal(cli(['size', '--dir', dir]).status, 0)
    put(dir, 'src/features/a/ui/Big.ts', nLines(451))
    assert.equal(cli(['size', '--dir', dir]).status, 1)
  })
})
