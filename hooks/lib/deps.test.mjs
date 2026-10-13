// Test cho lib/deps.mjs + deps-check.mjs (cổng thư viện mới, AC-38): node --test hooks/lib/deps.test.mjs
// Không chạm mạng thật: fetch được tiêm (mạng giả); repo git là thư mục tạm.
import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NPM_POPULAR, GO_POPULAR, DEFAULT_MIN_AGE_DAYS, MAX_TIMEOUT_MS,
  distance, nearPopular, parseGoMod, resolveVersion, newPackages, vet,
} from './deps.mjs'
import { run } from '../deps-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'deps-check.mjs')
// Tắt bảo trì tự động của git (Mac: commit tách `git maintenance run --auto --detach` chạy nền sau khi lệnh đã trả về); xem flow-dispatch.test.mjs.
Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' })

// ---------- mạng giả ----------
const DAY = 86400000
const NOW = Date.parse('2026-10-11T00:00:00Z')
const ago = (days) => new Date(NOW - days * DAY).toISOString()
const goEnc = (m) => m.replace(/[A-Z]/g, (c) => '!' + c.toLowerCase())
const NPM = (name) => `https://registry.npmjs.org/${name.replace('/', '%2F')}`
const GO = (mod) => `https://proxy.golang.org/${goEnc(mod)}`
const OSV = 'https://api.osv.dev/v1/query'

// Mỗi route: [url chuỗi | RegExp, (url, init) => Response | Error]. Không khớp route nào ⇒ 599 (để test lộ ra request ngoài dự kiến).
function fakeNet(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined })
    for (const [match, respond] of routes) {
      if (typeof match === 'string' ? url === match : match.test(url)) {
        const r = await respond(String(url), init)
        if (r instanceof Error) throw r
        return r
      }
    }
    return new Response('route không có', { status: 599 })
  }
  return { fetch, calls }
}
const J = (status, body) => () => new Response(JSON.stringify(body), { status })
const T = (status, body) => () => new Response(body, { status })
const osvNone = [OSV, J(200, {})]

const packument = ({ created = ago(400), versions = ['1.0.0'], latest, tags = {} } = {}) => ({
  name: 'x',
  'dist-tags': { latest: latest ?? versions.at(-1), ...tags },
  versions: Object.fromEntries(versions.map((v) => [v, { version: v }])),
  time: { created, modified: ago(1), ...Object.fromEntries(versions.map((v) => [v, created])) },
})

const opts = (net, extra = {}) => ({ fetch: net.fetch, now: NOW, ...extra })

// ---------- repo git tạm ----------
const tmp = (p = 'deps-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p))
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function mkRepo() {
  const dir = tmp()
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'tester')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}
const put = (dir, rel, content) => {
  const f = path.join(dir, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}
const commit = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) put(dir, rel, content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'c')
  return git(dir, 'rev-parse', 'HEAD')
}
const pj = (o) => ({ name: 'app', version: '1.0.0', ...o })
const key = (p) => `${p.eco}:${p.name}`

// ================= danh sách tên phổ biến =================
describe('danh sách tên phổ biến nhúng sẵn', () => {
  test('đúng 500 tên npm và 200 module Go, không trùng, đúng dạng tên', () => {
    assert.equal(NPM_POPULAR.length, 500)
    assert.equal(GO_POPULAR.length, 200)
    assert.equal(new Set(NPM_POPULAR).size, 500)
    assert.equal(new Set(GO_POPULAR).size, 200)
    for (const n of NPM_POPULAR) assert.match(n, /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i, n)
    for (const m of GO_POPULAR) {
      assert.match(m, /^[a-z0-9][\w.~-]*(\/[\w.~-]+)+$|^[a-z0-9][\w.~-]*\.[a-z]+$/i, m)
      assert.doesNotMatch(m, /\/v\d+$/, `${m}: tên gốc, không hậu tố /vN`)
    }
  })
  test('có các tên mốc quen thuộc', () => {
    for (const n of ['react', 'react-dom', 'typescript', 'lodash', 'express', 'axios', 'zod', 'vite', '@types/node']) {
      assert.ok(NPM_POPULAR.includes(n), `thiếu npm ${n}`)
    }
    for (const m of ['golang.org/x/sys', 'github.com/stretchr/testify', 'github.com/spf13/cobra', 'google.golang.org/grpc']) {
      assert.ok(GO_POPULAR.includes(m), `thiếu go ${m}`)
    }
  })
})

// ================= khoảng cách + gần tên =================
describe('distance / nearPopular', () => {
  test('khoảng cách chỉnh sửa, hoán đổi hai ký tự kề nhau tính 1', () => {
    assert.equal(distance('abc', 'abc'), 0)
    assert.equal(distance('abc', 'abd'), 1)
    assert.equal(distance('abc', 'abcd'), 1)
    assert.equal(distance('', 'abc'), 3)
    assert.equal(distance('lodash', 'lodahs'), 1)
    assert.equal(distance('kitten', 'sitting'), 3)
  })
  test('npm: lỗi gõ một ký tự của tên phổ biến ⇒ trả tên thật; đúng tên phổ biến ⇒ không gần', () => {
    assert.equal(nearPopular('npm', 'lodahs'), 'lodash')
    assert.equal(nearPopular('npm', 'expresss'), 'express')
    assert.equal(nearPopular('npm', 'reaact'), 'react')
    assert.equal(nearPopular('npm', 'lodash'), undefined)
  })
  test('npm: tên dài hơn cho phép lệch tới 2 ký tự, tên ngắn thì chặt hơn (ít báo nhầm)', () => {
    assert.equal(nearPopular('npm', 'typescrpit-'), 'typescript') // dài ≥8: lệch 2 vẫn gần
    assert.equal(nearPopular('npm', 'vue'), undefined) // ≤4 ký tự: không so gần
    assert.equal(nearPopular('npm', 'lodsh2'), undefined) // 6 ký tự lệch 2 ⇒ không báo
  })
  test('npm có scope: cùng scope thì so phần sau scope (bớt báo nhầm @types/ms ~ @types/ws); khác scope thì so cả chuỗi', () => {
    assert.ok(NPM_POPULAR.includes('@types/ws') && NPM_POPULAR.includes('@types/react'))
    assert.equal(nearPopular('npm', '@types/ms'), undefined)
    assert.equal(nearPopular('npm', '@types/reactt'), '@types/react')
    assert.equal(nearPopular('npm', '@typse/node'), '@types/node')
  })
  test('npm: tên xa mọi tên phổ biến ⇒ không gần', () => {
    assert.equal(nearPopular('npm', 'my-awesome-app-utils'), undefined)
  })
  test('go: bỏ hậu tố /vN khi so; gõ sai chủ repo/tên repo ⇒ gần', () => {
    assert.equal(nearPopular('go', 'github.com/stretchr/testify'), undefined)
    assert.equal(nearPopular('go', 'github.com/stretchr/testify/v2'), undefined)
    assert.equal(nearPopular('go', 'github.com/stretchr/testfy'), 'github.com/stretchr/testify')
    assert.equal(nearPopular('go', 'github.com/stretcher/testify'), 'github.com/stretchr/testify')
    assert.equal(nearPopular('go', 'github.com/someone/unrelated-lib'), undefined)
  })
  test('mọi tên trong danh sách: chính nó không bị coi là "gần" tên khác', () => {
    for (const n of NPM_POPULAR) assert.equal(nearPopular('npm', n), undefined, n)
    for (const m of GO_POPULAR) assert.equal(nearPopular('go', m), undefined, m)
  })
})

// ================= chọn phiên bản =================
describe('resolveVersion', () => {
  const versions = ['0.3.1', '0.3.9', '0.4.0', '1.0.0', '1.2.3', '1.2.9', '1.9.0', '2.0.0', '2.1.0-beta.1']
  const tags = { latest: '2.0.0', next: '2.1.0-beta.1' }
  const r = (spec) => resolveVersion(spec, versions, tags)
  test('đúng một bản', () => {
    assert.equal(r('1.2.3'), '1.2.3')
    assert.equal(r('=1.2.3'), '1.2.3')
    assert.equal(r('2.1.0-beta.1'), '2.1.0-beta.1')
  })
  test('^ ~ và x-range lấy bản mới nhất còn trong khoảng, bỏ bản tiền phát hành', () => {
    assert.equal(r('^1.2.3'), '1.9.0')
    assert.equal(r('~1.2.3'), '1.2.9')
    assert.equal(r('^0.3.1'), '0.3.9')
    assert.equal(r('1.x'), '1.9.0')
    assert.equal(r('1'), '1.9.0')
    assert.equal(r('1.2'), '1.2.9')
    assert.equal(r('^2.0.0'), '2.0.0')
  })
  test('tag, *, rỗng ⇒ bản của tag / latest; khoảng phức tạp ⇒ latest', () => {
    assert.equal(r('latest'), '2.0.0')
    assert.equal(r('next'), '2.1.0-beta.1')
    assert.equal(r('*'), '2.0.0')
    assert.equal(r(''), '2.0.0')
    assert.equal(r('>=1.0.0 <2'), '2.0.0')
    assert.equal(r('1.0.0 || 2.0.0'), '2.0.0')
  })
  test('không bản nào khớp ⇒ null', () => {
    assert.equal(r('9.9.9'), null)
    assert.equal(r('^3.0.0'), null)
    assert.equal(r('~0.5.0'), null)
  })
})

// ================= go.mod =================
describe('parseGoMod', () => {
  test('require dạng khối và một dòng; bỏ // indirect, replace, exclude, comment', () => {
    const txt = [
      'module example.com/app', '', 'go 1.22', '',
      'require github.com/a/one v1.0.0',
      'require (',
      '\tgithub.com/b/two v2.3.4 // indirect',
      '\tgithub.com/c/three/v3 v3.1.0',
      '\t// github.com/d/commented v1.0.0',
      '\t"github.com/e/quoted" v0.0.0-20230101000000-abcdef123456',
      ')',
      'replace github.com/a/one => ../one',
      'exclude github.com/f/ex v1.0.0',
    ].join('\r\n')
    assert.deepEqual(parseGoMod(txt), [
      { name: 'github.com/a/one', version: 'v1.0.0' },
      { name: 'github.com/c/three/v3', version: 'v3.1.0' },
      { name: 'github.com/e/quoted', version: 'v0.0.0-20230101000000-abcdef123456' },
    ])
  })
})

// ================= newPackages =================
describe('newPackages', () => {
  test('npm: chỉ 4 khối dependencies/dev/peer/optional; bản nâng cấp, chuyển khối, xoá không tính mới', () => {
    const dir = mkRepo()
    const base = commit(dir, {
      'package.json': pj({ dependencies: { react: '^18.0.0', old: '1.0.0' }, devDependencies: { vitest: '^1.0.0' } }),
    })
    const head = commit(dir, {
      'package.json': pj({
        dependencies: { react: '^19.0.0', vitest: '^2.0.0' }, // react nâng cấp, vitest chuyển khối
        devDependencies: { 'new-dev': '^1.0.0' },
        peerDependencies: { 'new-peer': '>=2' },
        optionalDependencies: { 'new-opt': '~3.1.0' },
        scripts: { build: 'x' },
        overrides: { sneaky: '1.0.0' },
        resolutions: { sneaky2: '1.0.0' },
        bundledDependencies: ['sneaky3'],
        engines: { node: '>=20' },
      }),
    })
    const got = newPackages(base, head, dir)
    assert.deepEqual(got.map((p) => [p.eco, p.name, p.version]).sort(), [
      ['npm', 'new-dev', '^1.0.0'], ['npm', 'new-opt', '~3.1.0'], ['npm', 'new-peer', '>=2'],
    ])
    assert.ok(got.every((p) => p.file === 'package.json'))
  })
  test('go.mod: module mới, bỏ indirect/replace, nâng phiên bản không tính mới', () => {
    const dir = mkRepo()
    const base = commit(dir, { 'go.mod': 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/one v1.0.0\n)\n' })
    const head = commit(dir, {
      'go.mod': 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/one v1.5.0\n\tgithub.com/b/two v0.2.0\n\tgithub.com/c/indirect v1.0.0 // indirect\n)\nreplace github.com/z/zz => github.com/y/yy v1.0.0\n',
    })
    assert.deepEqual(newPackages(base, head, dir).map((p) => [p.eco, p.name, p.version, p.file]), [
      ['go', 'github.com/b/two', 'v0.2.0', 'go.mod'],
    ])
  })
  test('monorepo: package.json ở thư mục con; node_modules bị bỏ qua; cùng tên ở hai nơi chỉ báo một lần', () => {
    const dir = mkRepo()
    const base = commit(dir, { 'README.md': 'x' })
    const head = commit(dir, {
      'package.json': pj({ dependencies: { shared: '^1.0.0' } }),
      'packages/web/package.json': pj({ dependencies: { shared: '^1.0.0', 'web-only': '^2.0.0' } }),
      'node_modules/foo/package.json': pj({ dependencies: { 'inside-node-modules': '1.0.0' } }),
      'vendor/x/go.mod': 'module x\nrequire github.com/v/vendored v1.0.0\n',
    })
    const got = newPackages(base, head, dir)
    assert.deepEqual(got.map(key).sort(), ['npm:shared', 'npm:web-only'])
    assert.equal(got.find((p) => p.name === 'web-only').file, 'packages/web/package.json')
  })
  test('file package.json mới hoàn toàn: mọi dependency đều mới', () => {
    const dir = mkRepo()
    const base = commit(dir, { 'a.txt': 'x' })
    const head = commit(dir, { 'package.json': pj({ dependencies: { one: '1.0.0' }, devDependencies: { two: '2.0.0' } }) })
    assert.deepEqual(newPackages(base, head, dir).map(key).sort(), ['npm:one', 'npm:two'])
  })
  test('không có mốc gốc (null) = repo trống ⇒ tất cả đều mới; head ":" = bản đã git add', () => {
    const dir = mkRepo()
    commit(dir, { 'package.json': pj({ dependencies: { committed: '1.0.0' } }) })
    put(dir, 'package.json', pj({ dependencies: { committed: '1.0.0', staged: '1.0.0' } }))
    git(dir, 'add', 'package.json')
    put(dir, 'package.json', pj({ dependencies: { committed: '1.0.0', staged: '1.0.0', unstaged: '1.0.0' } }))
    assert.deepEqual(newPackages('HEAD', ':', dir).map(key), ['npm:staged'])
    assert.deepEqual(newPackages(null, 'HEAD', dir).map(key), ['npm:committed'])
  })
  test('nguồn đặc biệt: alias npm: lấy tên thật; file:/workspace:/link: bỏ; git/url đánh dấu source', () => {
    const dir = mkRepo()
    const base = commit(dir, { 'README.md': 'x' })
    const head = commit(dir, {
      'package.json': pj({
        dependencies: {
          'my-alias': 'npm:real-pkg@^1.2.0',
          'scoped-alias': 'npm:@sc/real@2.0.0',
          'local-a': 'file:../a', 'local-b': 'workspace:*', 'local-c': 'link:../c', 'local-d': './d',
          'from-git': 'git+https://github.com/o/r.git#v1', 'from-gh': 'o/r', 'from-url': 'https://example.com/x.tgz',
          plain: '^1.0.0',
        },
      }),
    })
    const got = Object.fromEntries(newPackages(base, head, dir).map((p) => [p.name, p]))
    assert.deepEqual(Object.keys(got).sort(), ['@sc/real', 'from-gh', 'from-git', 'from-url', 'plain', 'real-pkg'])
    assert.equal(got['real-pkg'].version, '^1.2.0')
    assert.equal(got['@sc/real'].version, '2.0.0')
    assert.equal(got['from-git'].source, 'git')
    assert.equal(got['from-gh'].source, 'git')
    assert.equal(got['from-url'].source, 'url')
    assert.equal(got.plain.source, undefined)
  })
  test('nguồn git/url viết hoa, ssh:// , git+ssh:// , scp-kiểu git@ cũng đánh dấu source (không lọt thành tên registry)', () => {
    const dir = mkRepo()
    const base = commit(dir, { 'README.md': 'x' })
    const specs = {
      'u-upper': 'HTTPS://example.com/x.tgz', 'u-http': 'http://example.com/x.tgz',
      'g-upper': 'GIT+HTTPS://github.com/o/r.git', 'g-ssh': 'ssh://git@github.com/o/r.git', 'g-gitssh': 'git+ssh://git@github.com/o/r.git',
      'g-scp': 'git@github.com:o/r.git', 'g-gh': 'github:o/r', 'g-short': 'o/r#main',
    }
    const head = commit(dir, { 'package.json': pj({ devDependencies: specs }) })
    const got = Object.fromEntries(newPackages(base, head, dir).map((p) => [p.name, p.source]))
    assert.deepEqual(got, Object.fromEntries(Object.keys(specs).map((k) => [k, k.startsWith('u-') ? 'url' : 'git'])))
  })
  test('mốc git không có ⇒ ném lỗi rõ (không trả mảng rỗng như thể sạch)', () => {
    const dir = mkRepo()
    commit(dir, { 'a.txt': 'x' })
    assert.throws(() => newPackages('khong-co-moc', 'HEAD', dir), /khong-co-moc/)
    assert.throws(() => newPackages('HEAD', 'HEAD', path.join(dir, 'khong-co-thu-muc')), /git|thư mục/)
  })
  test('package.json hỏng ở bản mới ⇒ ném lỗi nêu tên file; hỏng ở bản gốc ⇒ coi như chưa có', () => {
    const dir = mkRepo()
    const bad = commit(dir, { 'package.json': '{ không phải json' })
    const good = commit(dir, { 'package.json': pj({ dependencies: { one: '1.0.0' } }) })
    assert.deepEqual(newPackages(bad, good, dir).map(key), ['npm:one'])
    assert.throws(() => newPackages(good, bad, dir), /package\.json/)
  })
})

// ================= vet npm =================
describe('vet npm', () => {
  const pkg = (name, version = '^1.0.0') => ({ eco: 'npm', name, version })

  test('có thật, đủ tuổi, không lỗ hổng ⇒ ok; hỏi đúng registry + OSV với bản đã chọn', async () => {
    const net = fakeNet([
      [NPM('good-lib'), J(200, packument({ created: ago(400), versions: ['1.0.0', '1.4.2', '2.0.0'] }))],
      [OSV, J(200, {})],
    ])
    const r = await vet(pkg('good-lib', '^1.0.0'), opts(net))
    assert.equal(r.status, 'ok')
    assert.equal(r.exists, true)
    assert.equal(r.ageDays, 400)
    assert.equal(r.nearPopular, undefined)
    assert.deepEqual(r.vulns, [])
    assert.deepEqual(r.problems, [])
    assert.equal(r.resolved, '1.4.2')
    const osv = net.calls.find((c) => c.url === OSV)
    assert.deepEqual(osv.body, { package: { name: 'good-lib', ecosystem: 'npm' }, version: '1.4.2' })
    assert.equal(osv.init.method, 'POST')
    assert.ok(net.calls.every((c) => c.init.signal instanceof AbortSignal), 'mọi request có signal để huỷ khi quá hạn')
  })
  test('tên có scope: gọi registry với %2F', async () => {
    const net = fakeNet([[NPM('@sc/lib'), J(200, packument())], osvNone])
    const r = await vet(pkg('@sc/lib'), opts(net))
    assert.equal(r.status, 'ok')
    assert.equal(net.calls[0].url, 'https://registry.npmjs.org/@sc%2Flib')
  })
  test('registry 404 ⇒ không tồn tại (tên bịa), không hỏi OSV', async () => {
    const net = fakeNet([[NPM('totally-made-up-lib'), T(404, '{"error":"Not found"}')]])
    const r = await vet(pkg('totally-made-up-lib'), opts(net))
    assert.equal(r.status, 'bad')
    assert.equal(r.exists, false)
    assert.equal(r.ageDays, null)
    assert.ok(r.problems.some((p) => /không (có|tồn tại)/.test(p)), r.problems.join('|'))
    assert.equal(net.calls.length, 1)
  })
  test('gói đã bị gỡ (không còn phiên bản nào) ⇒ coi như không tồn tại', async () => {
    const net = fakeNet([[NPM('gone-lib'), J(200, { name: 'gone-lib', time: { created: ago(900), unpublished: { time: ago(5) } } })]])
    const r = await vet(pkg('gone-lib'), opts(net))
    assert.equal(r.exists, false)
    assert.equal(r.status, 'bad')
  })
  test('quá mới (< 7 ngày mặc định) ⇒ bad; hạ ngưỡng thì ok', async () => {
    assert.equal(DEFAULT_MIN_AGE_DAYS, 7)
    const routes = () => [[NPM('fresh-lib'), J(200, packument({ created: ago(3) }))], osvNone]
    const a = await vet(pkg('fresh-lib'), opts(fakeNet(routes())))
    assert.equal(a.status, 'bad')
    assert.equal(a.ageDays, 3)
    assert.ok(a.problems.some((p) => /3 ngày/.test(p)), a.problems.join('|'))
    const b = await vet(pkg('fresh-lib'), opts(fakeNet(routes()), { minAgeDays: 2 }))
    assert.equal(b.status, 'ok')
    const c = await vet(pkg('fresh-lib'), opts(fakeNet(routes()), { minAgeDays: 7 }))
    assert.equal(c.status, 'bad')
  })
  test('tên gần tên phổ biến ⇒ bad kể cả khi có thật và đủ tuổi; báo tên thật', async () => {
    const net = fakeNet([[NPM('lodahs'), J(200, packument({ created: ago(30) }))], osvNone])
    const r = await vet(pkg('lodahs'), opts(net))
    assert.equal(r.nearPopular, 'lodash')
    assert.equal(r.status, 'bad')
    assert.ok(r.problems.some((p) => p.includes('lodash')), r.problems.join('|'))
  })
  test('tên gần phổ biến nhưng không tồn tại: vẫn báo nearPopular (tính offline)', async () => {
    const net = fakeNet([[NPM('expresss'), T(404, '{}')]])
    const r = await vet(pkg('expresss'), opts(net))
    assert.equal(r.nearPopular, 'express')
    assert.equal(r.exists, false)
  })
  test('có lỗ hổng đã biết (OSV) ⇒ bad, liệt kê id + tóm tắt + mức nghiêm trọng', async () => {
    const net = fakeNet([
      [NPM('vuln-lib'), J(200, packument({ versions: ['1.0.0'] }))],
      [OSV, J(200, { vulns: [
        { id: 'GHSA-aaaa-bbbb-cccc', summary: 'Prototype pollution', database_specific: { severity: 'HIGH' } },
        { id: 'MAL-2025-1234', summary: 'Malicious code in vuln-lib' },
      ] })],
    ])
    const r = await vet(pkg('vuln-lib', '1.0.0'), opts(net))
    assert.equal(r.status, 'bad')
    assert.deepEqual(r.vulns.map((v) => v.id), ['GHSA-aaaa-bbbb-cccc', 'MAL-2025-1234'])
    assert.equal(r.vulns[0].severity, 'HIGH')
    assert.equal(r.vulns[0].summary, 'Prototype pollution')
    assert.ok(r.problems.some((p) => p.includes('GHSA-aaaa-bbbb-cccc')))
  })
  test('phiên bản ghi trong package.json không có trên registry ⇒ bad, không hỏi OSV', async () => {
    const net = fakeNet([[NPM('good-lib'), J(200, packument({ versions: ['1.0.0'] }))], osvNone])
    const r = await vet(pkg('good-lib', '^9.0.0'), opts(net))
    assert.equal(r.status, 'bad')
    assert.equal(r.resolved, null)
    assert.ok(r.problems.some((p) => p.includes('^9.0.0')), r.problems.join('|'))
    assert.ok(!net.calls.some((c) => c.url === OSV))
  })
  test('tên không hợp lệ (có thể làm lệch URL) ⇒ bad, không gọi mạng', async () => {
    for (const name of ['../etc', 'a b', 'x?y=1', '.hidden', '']) {
      const net = fakeNet([])
      const r = await vet(pkg(name), opts(net))
      assert.equal(r.status, 'bad', name)
      assert.equal(r.exists, false, name)
      assert.equal(net.calls.length, 0, name)
    }
  })
  test('nguồn ngoài registry (git/url/tarball) ⇒ bad "nguồn ngoài kho chính thức, chưa kiểm chứng", không gọi mạng', async () => {
    for (const [source, version] of [['git', 'git+https://github.com/o/r.git'], ['git', 'o/r'], ['url', 'https://example.com/x.tgz']]) {
      const net = fakeNet([])
      const r = await vet({ eco: 'npm', name: 'from-src', version, source }, opts(net))
      assert.equal(r.status, 'bad', version)
      assert.ok(r.problems.includes('nguồn ngoài kho chính thức, chưa kiểm chứng'), r.problems.join('|'))
      assert.equal(r.exists, null)
      assert.equal(net.calls.length, 0)
    }
  })
  test('nguồn ngoài registry có mục "tên@nguồn" trong trustedSources (user duyệt) ⇒ ok, không gọi mạng; tên khác vẫn bad', async () => {
    const net = fakeNet([])
    const SRC = 'git+https://github.com/o/r.git'
    const pkgOf = (name, version = SRC) => ({ eco: 'npm', name, version, source: 'git' })
    const trusted = await vet(pkgOf('zq-internal'), opts(net, { trustedSources: [`other@${SRC}`, `zq-internal@${SRC}`] }))
    assert.equal(trusted.status, 'ok')
    assert.deepEqual(trusted.problems, [])
    assert.deepEqual(trusted.unknown, [])
    assert.equal((await vet(pkgOf('zq-other'), opts(net, { trustedSources: [`zq-internal@${SRC}`] }))).status, 'bad')
    assert.equal((await vet(pkgOf('zq-internal'), opts(net, { trustedSources: `zq-internal@${SRC}` }))).status, 'bad', 'phải là mảng, chuỗi không tính')
    assert.equal(net.calls.length, 0)
  })
  // Review lượt 2: allowlist chỉ có tên cho qua MỌI URL của tên đó (đổi URL git sang máy chủ khác vẫn lọt) ⇒ phải ghim cả nguồn.
  test('mục chỉ có tên, hoặc tên khớp mà nguồn khác (host/sha/đuôi) ⇒ vẫn bad; scoped @org/pkg@nguồn khớp đúng', async () => {
    const net = fakeNet([])
    const SRC = 'git+https://github.com/o/r.git#' + 'a'.repeat(40)
    const pkgOf = (name, version = SRC) => ({ eco: 'npm', name, version, source: 'git' })
    for (const entry of ['zq-internal', `zq-internal@${SRC.replace('github.com', 'evil.example')}`, `zq-internal@${SRC.slice(0, -1)}b`, `zq-internal@${SRC}x`, `zq-internal@ ${SRC}`, SRC, `@zq-internal@${SRC}`]) {
      const r = await vet(pkgOf('zq-internal'), opts(net, { trustedSources: [entry] }))
      assert.equal(r.status, 'bad', entry)
      assert.ok(r.problems.includes('nguồn ngoài kho chính thức, chưa kiểm chứng'), entry)
    }
    assert.equal((await vet(pkgOf('@zq/internal'), opts(net, { trustedSources: [`@zq/internal@${SRC}`] }))).status, 'ok')
    assert.equal((await vet(pkgOf('zq-internal'), opts(net, { trustedSources: [`@zq/internal@${SRC}`] }))).status, 'bad')
    assert.equal(net.calls.length, 0)
  })
  test('tên không hợp lệ vẫn bad dù nằm trong trustedSources', async () => {
    const r = await vet({ eco: 'npm', name: 'Bad Name!', version: 'o/r', source: 'git' }, opts(fakeNet([]), { trustedSources: ['Bad Name!@o/r', 'Bad Name!'] }))
    assert.equal(r.status, 'bad')
    assert.ok(r.problems.some((p) => /không phải tên package hợp lệ/.test(p)), r.problems.join('|'))
  })

  describe('mạng lỗi ⇒ unknown, không ném', () => {
    test('registry 500', async () => {
      const net = fakeNet([[NPM('some-lib'), T(500, 'oops')]])
      const r = await vet(pkg('some-lib'), opts(net))
      assert.equal(r.status, 'unknown')
      assert.equal(r.exists, null)
      assert.equal(r.ageDays, null)
      assert.ok(r.unknown.length > 0)
    })
    test('registry 429 / JSON hỏng / fetch ném lỗi / fetch ném đồng bộ / trả undefined', async () => {
      const cases = [
        T(429, 'slow down'),
        T(200, '<html>không phải json</html>'),
        () => new TypeError('fetch failed'),
        () => { throw new Error('ném đồng bộ') },
        () => undefined,
      ]
      for (const respond of cases) {
        const net = fakeNet([[NPM('some-lib'), respond]])
        const r = await vet(pkg('some-lib'), opts(net))
        assert.equal(r.status, 'unknown')
      }
    })
    test('registry ổn nhưng OSV hỏng ⇒ unknown, giữ lại phần đã biết (tuổi, tồn tại)', async () => {
      const net = fakeNet([[NPM('some-lib'), J(200, packument({ created: ago(100) }))], [OSV, () => new TypeError('fetch failed')]])
      const r = await vet(pkg('some-lib'), opts(net))
      assert.equal(r.status, 'unknown')
      assert.equal(r.exists, true)
      assert.equal(r.ageDays, 100)
      assert.ok(r.unknown.some((u) => /OSV/.test(u)), r.unknown.join('|'))
    })
    test('đã có vấn đề chắc chắn thì mạng lỗi ở bước khác không che mất: vẫn bad', async () => {
      const net = fakeNet([[NPM('lodahs'), J(200, packument({ created: ago(100) }))], [OSV, T(503, 'x')]])
      const r = await vet(pkg('lodahs'), opts(net))
      assert.equal(r.status, 'bad')
      assert.ok(r.unknown.length > 0)
    })
    test('treo mãi ⇒ hết hạn rồi trả unknown (không treo cổng)', async () => {
      const net = fakeNet([[NPM('slow-lib'), () => new Promise(() => {})]])
      const t0 = Date.now()
      const r = await vet(pkg('slow-lib'), opts(net, { timeoutMs: 40 }))
      assert.equal(r.status, 'unknown')
      assert.ok(Date.now() - t0 < 2000)
      assert.ok(r.unknown.some((u) => /hết thời gian|quá/.test(u)), r.unknown.join('|'))
    })
    test('mỗi request tối đa 8 giây, kể cả khi truyền timeoutMs lớn hơn', async (t) => {
      assert.equal(MAX_TIMEOUT_MS, 8000)
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const net = fakeNet([[NPM('slow-lib'), () => new Promise(() => {})]])
      let done = false
      const p = vet(pkg('slow-lib'), opts(net, { timeoutMs: 60000 })).then((r) => { done = true; return r })
      for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res))
      t.mock.timers.tick(MAX_TIMEOUT_MS - 1)
      for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res))
      assert.equal(done, false)
      t.mock.timers.tick(1)
      for (let i = 0; i < 50 && !done; i++) await new Promise((res) => setImmediate(res))
      assert.equal(done, true, 'đúng giây thứ 8 phải bỏ cuộc')
      assert.equal((await p).status, 'unknown')
    })
  })
})

// ================= vet go =================
describe('vet go', () => {
  const pkg = (name, version = 'v1.2.3') => ({ eco: 'go', name, version })
  const MOD = 'github.com/Some-Org/lib'
  const goRoutes = ({ list = 'v1.0.0\nv1.2.3\nv1.1.0\n', infoTime = ago(500), osv = osvNone } = {}) => [
    [`${GO(MOD)}/@v/list`, T(200, list)],
    [/\/@v\/v[^/]+\.info$/, (url) => new Response(JSON.stringify({ Version: url.match(/\/(v[^/]+)\.info$/)[1], Time: infoTime }), { status: 200 })],
    osv,
  ]

  test('có thật, đủ tuổi, sạch ⇒ ok; chữ hoa trong đường dẫn mã hoá thành !chữ-thường; tuổi lấy từ bản cũ nhất', async () => {
    const net = fakeNet(goRoutes())
    const r = await vet(pkg(MOD), opts(net))
    assert.equal(r.status, 'ok')
    assert.equal(r.exists, true)
    assert.equal(r.ageDays, 500)
    assert.deepEqual(r.vulns, [])
    assert.ok(net.calls.some((c) => c.url === 'https://proxy.golang.org/github.com/!some-!org/lib/@v/list'))
    assert.ok(net.calls.some((c) => c.url === 'https://proxy.golang.org/github.com/!some-!org/lib/@v/v1.0.0.info'), 'hỏi bản cũ nhất')
    const osv = net.calls.find((c) => c.url === OSV)
    assert.deepEqual(osv.body, { package: { name: MOD, ecosystem: 'Go' }, version: '1.2.3' })
  })
  test('list rỗng (chỉ pseudo-version) ⇒ tuổi lấy từ chính bản đang dùng', async () => {
    const net = fakeNet(goRoutes({ list: '' }))
    const r = await vet(pkg(MOD, 'v0.0.0-20240101000000-abcdef123456'), opts(net))
    assert.equal(r.status, 'ok')
    assert.equal(r.ageDays, 500)
    assert.ok(net.calls.some((c) => c.url.endsWith('/@v/v0.0.0-20240101000000-abcdef123456.info')))
    assert.equal(net.calls.find((c) => c.url === OSV).body.version, '0.0.0-20240101000000-abcdef123456')
  })
  test('thẻ cũ nhất đã bị gỡ (info 404) ⇒ thử thẻ kế tiếp (gặp thật: Masterminds/semver v3.0.0)', async () => {
    const net = fakeNet([
      [`${GO(MOD)}/@v/list`, T(200, 'v1.1.0\nv1.0.0\nv1.2.3\n')],
      [`${GO(MOD)}/@v/v1.0.0.info`, T(404, 'not found')],
      [`${GO(MOD)}/@v/v1.1.0.info`, J(200, { Version: 'v1.1.0', Time: ago(300) })],
      osvNone,
    ])
    const r = await vet(pkg(MOD), opts(net))
    assert.equal(r.status, 'ok')
    assert.equal(r.ageDays, 300)
  })
  test('proxy 404 hoặc 410 ⇒ không tồn tại, không hỏi OSV', async () => {
    for (const code of [404, 410]) {
      const net = fakeNet([[`${GO(MOD)}/@v/list`, T(code, 'not found')]])
      const r = await vet(pkg(MOD), opts(net))
      assert.equal(r.exists, false)
      assert.equal(r.status, 'bad')
      assert.equal(net.calls.length, 1)
    }
  })
  test('quá mới ⇒ bad', async () => {
    const net = fakeNet(goRoutes({ infoTime: ago(2) }))
    const r = await vet(pkg(MOD), opts(net))
    assert.equal(r.status, 'bad')
    assert.equal(r.ageDays, 2)
  })
  test('có lỗ hổng ⇒ bad', async () => {
    const net = fakeNet(goRoutes({ osv: [OSV, J(200, { vulns: [{ id: 'GO-2025-0001', summary: 'x' }] })] }))
    const r = await vet(pkg(MOD), opts(net))
    assert.equal(r.status, 'bad')
    assert.deepEqual(r.vulns.map((v) => v.id), ['GO-2025-0001'])
  })
  test('gần tên module phổ biến ⇒ bad', async () => {
    const mod = 'github.com/stretchr/testfy'
    const net = fakeNet([[`${GO(mod)}/@v/list`, T(200, 'v1.0.0\n')], [/\.info$/, J(200, { Version: 'v1.0.0', Time: ago(300) })], osvNone])
    const r = await vet(pkg(mod, 'v1.0.0'), opts(net))
    assert.equal(r.nearPopular, 'github.com/stretchr/testify')
    assert.equal(r.status, 'bad')
  })
  test('đường dẫn module không hợp lệ ⇒ bad, không gọi mạng', async () => {
    const net = fakeNet([])
    const r = await vet(pkg('github.com/../../etc'), opts(net))
    assert.equal(r.status, 'bad')
    assert.equal(net.calls.length, 0)
  })
  test('mạng lỗi ⇒ unknown, không ném', async () => {
    for (const respond of [T(500, 'x'), () => new TypeError('fetch failed'), () => new Promise(() => {})]) {
      const net = fakeNet([[/proxy\.golang\.org/, respond], [OSV, respond]])
      const r = await vet(pkg(MOD), opts(net, { timeoutMs: 30 }))
      assert.equal(r.status, 'unknown')
      assert.equal(r.exists, null)
    }
  })
  test('proxy ổn nhưng không lấy được tuổi ⇒ unknown (không bịa số)', async () => {
    const net = fakeNet([[`${GO(MOD)}/@v/list`, T(200, 'v1.0.0\n')], [/\.info$/, T(500, 'x')], osvNone])
    const r = await vet(pkg(MOD, 'v1.0.0'), opts(net))
    assert.equal(r.exists, true)
    assert.equal(r.ageDays, null)
    assert.equal(r.status, 'unknown')
  })
})

// ================= CLI =================
describe('deps-check CLI', () => {
  test('--list: liệt kê thư viện mới, không gọi mạng; exit 0', async () => {
    const dir = mkRepo()
    const base = commit(dir, { 'package.json': pj({ dependencies: { react: '^18.0.0' } }) })
    const head = commit(dir, { 'package.json': pj({ dependencies: { react: '^18.0.0', zod: '^3.0.0' } }), 'go.mod': 'module x\nrequire github.com/a/b v1.0.0\n' })
    const r = await run(['--list', '--repo', dir, '--base', base, '--head', head, '--json'], { fetch: () => { throw new Error('không được gọi mạng') } })
    assert.equal(r.code, 0)
    const out = JSON.parse(r.lines.join('\n'))
    assert.deepEqual(out.packages.map(key).sort(), ['go:github.com/a/b', 'npm:zod'])
  })
  test('mặc định so HEAD với bản đã git add; không có gì mới ⇒ exit 0 và nói rõ', async () => {
    const dir = mkRepo()
    commit(dir, { 'package.json': pj({ dependencies: { react: '^18.0.0' } }) })
    const net = fakeNet([])
    const r = await run(['--repo', dir], opts(net))
    assert.equal(r.code, 0)
    assert.match(r.lines.join('\n'), /không có thư viện mới/i)
    assert.equal(net.calls.length, 0)
  })
  test('thư viện mới có vấn đề ⇒ exit 1, in dòng tiếng Việt kèm lý do', async () => {
    const dir = mkRepo()
    const base = commit(dir, { 'package.json': pj({ dependencies: {} }) })
    const head = commit(dir, { 'package.json': pj({ dependencies: { 'good-lib': '^1.0.0', 'made-up-lib': '^1.0.0' } }) })
    const net = fakeNet([[NPM('good-lib'), J(200, packument())], [NPM('made-up-lib'), T(404, '{}')], osvNone])
    const r = await run(['--repo', dir, '--base', base, '--head', head], opts(net))
    assert.equal(r.code, 1)
    const text = r.lines.join('\n')
    assert.match(text, /good-lib/)
    assert.match(text, /made-up-lib.*(không có|không tồn tại)/s)
  })
  test('mạng lỗi toàn bộ ⇒ exit 0 nhưng nói rõ "chưa kiểm được" (không im lặng)', async () => {
    const dir = mkRepo()
    const base = commit(dir, { 'package.json': pj({}) })
    const head = commit(dir, { 'package.json': pj({ dependencies: { 'some-lib': '^1.0.0' } }) })
    const net = fakeNet([[/./, () => new TypeError('fetch failed')]])
    const r = await run(['--repo', dir, '--base', base, '--head', head], opts(net))
    assert.equal(r.code, 0)
    assert.match(r.lines.join('\n'), /chưa kiểm được/)
  })
  test('--vet npm:tên@bản kiểm một gói; --json ra { ok, packages }', async () => {
    const net = fakeNet([[NPM('good-lib'), J(200, packument({ versions: ['1.0.0', '1.3.0'] }))], osvNone])
    const r = await run(['--vet', 'npm:good-lib@^1.0.0', '--json'], opts(net))
    assert.equal(r.code, 0)
    const out = JSON.parse(r.lines.join('\n'))
    assert.equal(out.ok, true)
    assert.equal(out.packages[0].name, 'good-lib')
    assert.equal(out.packages[0].status, 'ok')
    assert.equal(out.packages[0].resolved, '1.3.0')
  })
  test('--vet go:module@version', async () => {
    const net = fakeNet([
      [`${GO('github.com/a/b')}/@v/list`, T(200, 'v1.0.0\n')],
      [/\.info$/, J(200, { Version: 'v1.0.0', Time: ago(100) })],
      [OSV, J(200, { vulns: [{ id: 'GO-1', summary: 's' }] })],
    ])
    const r = await run(['--vet', 'go:github.com/a/b@v1.0.0'], opts(net))
    assert.equal(r.code, 1)
    assert.match(r.lines.join('\n'), /GO-1/)
  })
  test('--min-age đổi ngưỡng tuổi', async () => {
    const routes = () => [[NPM('fresh-lib'), J(200, packument({ created: ago(3) }))], osvNone]
    assert.equal((await run(['--vet', 'npm:fresh-lib'], opts(fakeNet(routes())))).code, 1)
    assert.equal((await run(['--vet', 'npm:fresh-lib', '--min-age', '2'], opts(fakeNet(routes())))).code, 0)
  })
  test('sai cách dùng / mốc git không có ⇒ exit 2 (không coi là sạch)', async () => {
    const dir = mkRepo()
    commit(dir, { 'a.txt': 'x' })
    assert.equal((await run(['--vet', 'khong-co-dau-hai-cham'], {})).code, 2)
    assert.equal((await run(['--vet', 'pip:requests'], {})).code, 2)
    assert.equal((await run(['--bogus'], {})).code, 2)
    assert.equal((await run(['--repo', dir, '--base', 'khong-co-moc', '--list'], {})).code, 2)
    assert.equal((await run(['--min-age', 'abc', '--vet', 'npm:x'], {})).code, 2)
  })
  test('chạy như lệnh thật: --help exit 0; --list trong repo tạm; mốc xấu exit 2', () => {
    const dir = mkRepo()
    const base = commit(dir, { 'a.txt': 'x' })
    const head = commit(dir, { 'package.json': pj({ dependencies: { zod: '^3.0.0' } }) })
    const node = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
    const help = node('--help')
    assert.equal(help.status, 0)
    assert.match(help.stdout, /deps-check/)
    const list = node('--list', '--repo', dir, '--base', base, '--head', head)
    assert.equal(list.status, 0, list.stderr)
    assert.match(list.stdout, /zod/)
    const bad = node('--list', '--repo', dir, '--base', 'khong-co-moc')
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /khong-co-moc/)
  })
})
