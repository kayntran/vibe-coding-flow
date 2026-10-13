// Test cho mac-check.mjs: node --test ~/.claude/hooks/mac-check.test.mjs
// Không cần Mac thật: lõi nhận `run` giả (ghi lại mọi lệnh ssh/scp/git) + thư mục tạm giả. Đường dẫn máy này có dấu cách + tiếng Việt.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { MARK, UsageError, buildCommands, macTest, main, makeId, missingTool, parseArgs, parseTap, remoteScript, shq, summarize } from './mac-check.mjs'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

test('tên CLI không khớp mẫu file test mặc định của node --test (khớp ⇒ chạy toàn bộ test sẽ tự gọi sang Mac)', () => {
  assert.doesNotMatch('mac-check.mjs', /^test[-.]|[-._]test\.[cm]?js$|^test\.[cm]?js$/)
})
const NOW = new Date('2026-10-13T10:15:30.123Z')
const ID = 'flowtest-a1b2c3d-20261013-101530123'
const REPO = path.join(os.tmpdir(), 'Dự án', 'bộ kit thử')
const TMP_DIR = path.join(os.tmpdir(), 'Thư mục tạm', 'lần 1')
// Hợp đồng: không phần tử mảng tham số nào được là lệnh xoá thư mục (xoá chỉ nằm trong script gửi qua stdin).
const DANGER = /(^|[\s;&|])(rm|rmdir|rd|del|erase)(\s|$)|-rf\b|-fr\b|Remove-Item|rimraf/i

// TAP thật của node:test (nhóm có 1 bài hỏng thường + 1 bài thiếu công cụ), đường dẫn kiểu Mac.
const LOC = (line) => `      location: '/tmp/${ID}/kit/hooks/demo.test.mjs:${line}:3'`
const TAP_MIXED = [
  'TAP version 13', '# Subtest: nhóm A',
  '    # Subtest: đạt', '    ok 1 - đạt', '      ---', '      duration_ms: 9.08', "      type: 'test'", '      ...',
  '    # Subtest: hỏng thường', '    not ok 2 - hỏng thường', '      ---', LOC(7), "      failureType: 'testCodeFailure'",
  '      error: |-', '        Expected values to be strictly equal:', '        ', '        1 !== 2', '        ', "      code: 'ERR_ASSERTION'", '      ...',
  '    # Subtest: thiếu công cụ', '    not ok 3 - thiếu công cụ', '      ---', LOC(8), "      failureType: 'testCodeFailure'",
  "      error: 'spawnSync osv-scanner ENOENT'", "      code: 'ENOENT'", '      ...',
  '    1..3',
  'not ok 1 - nhóm A', '  ---', "  type: 'suite'", "  failureType: 'subtestsFailed'", "  error: '2 subtests failed'", '  ...',
  '# Subtest: lẻ đạt', 'ok 2 - lẻ đạt', '  ---', "  type: 'test'", '  ...',
  '1..2', '# tests 4', '# suites 1', '# pass 2', '# fail 2', '# cancelled 0', '# skipped 0', '# todo 0',
].join('\n')
const TAP_GREEN = ['TAP version 13', '# Subtest: a', 'ok 1 - a', '  ---', '  ...', '# Subtest: b', 'ok 2 - b', '  ---', '  ...', '1..2', '# tests 2', '# suites 0', '# pass 2', '# fail 0'].join('\n')
const TAP_ONLY_MACHINE = TAP_MIXED.replace('    not ok 2 - hỏng thường', '    ok 2 - hỏng thường').replace('# pass 2', '# pass 3').replace('# fail 2', '# fail 1')
const out = (tap, { cleaned = true } = {}) => `${MARK} node v24.18.0\n${tap}\n${cleaned ? `${MARK} cleaned\n` : ''}`

// run giả: ghi lại lệnh, trả kết quả theo kiểu lệnh. over = { probe, copy, run, clean, bundle, dirty, branch }
function fake(over = {}) {
  const calls = []
  const run = (cmd, args, o = {}) => {
    calls.push({ cmd, args, cwd: o.cwd, input: o.input, timeout: o.timeout })
    const ok = { status: 0, stdout: '', stderr: '' }
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { ...ok, stdout: `${SHA}\n` }
    if (cmd === 'git' && args[0] === 'rev-parse') return { ...ok, stdout: `${over.branch ?? 'flow-v7-dot4'}\n` }
    if (cmd === 'git' && args[0] === 'status') return { ...ok, stdout: over.dirty ? ' M hooks/a.mjs\n' : '' }
    if (cmd === 'git' && args[0] === 'bundle') return over.bundle ?? ok
    if (cmd === 'scp') return over.copy ?? ok
    if (cmd === 'ssh' && args.at(-1) === 'true') return over.probe ?? ok
    if (cmd === 'ssh' && o.input?.includes('trap cleanup EXIT')) return over.run ?? { ...ok, stdout: out(TAP_GREEN) }
    if (cmd === 'ssh') return over.clean ?? { ...ok, stdout: `${MARK} cleaned\n` }
    throw new Error(`lệnh lạ ${cmd}`)
  }
  return { run, calls }
}
function go(over = {}, opts = {}) {
  const f = fake(over)
  const removed = []
  const said = []
  const res = macTest({ repo: REPO, host: 'macmini', now: NOW, run: f.run, tmp: { make: () => TMP_DIR, remove: (d) => removed.push(d) }, say: (s) => said.push(s), ...opts })
  return { ...res, calls: f.calls, removed, said }
}

describe('parseArgs', () => {
  test('mặc định macmini, không --only; --host / --only (lặp được, dạng = cũng được)', () => {
    assert.deepEqual(parseArgs([]), { host: 'macmini', only: [], help: false })
    assert.deepEqual(parseArgs(['--host', 'kayn@10.0.0.5', '--only', 'hooks/lib/luu.test.mjs', '--only=hooks/*.test.mjs']), { host: 'kayn@10.0.0.5', only: ['hooks/lib/luu.test.mjs', 'hooks/*.test.mjs'], help: false })
    assert.equal(parseArgs(['--host=mac-mini_2']).host, 'mac-mini_2')
    assert.equal(parseArgs(['-h']).help, true)
  })
  test('--only: gạch chéo ngược và ./ đầu được chuẩn hoá', () => {
    assert.deepEqual(parseArgs(['--only', '.\\hooks\\lib\\luu.test.mjs']).only, ['hooks/lib/luu.test.mjs'])
  })
  test('host có thể bị hiểu thành cờ ssh hoặc chứa ký tự shell ⇒ từ chối', () => {
    for (const h of ['-oProxyCommand=evil', '-v', 'a b', 'mac;ls', 'mac$(x)', '`x`', '', 'a|b']) assert.throws(() => parseArgs(['--host', h]), UsageError, `host ${JSON.stringify(h)}`)
    assert.throws(() => parseArgs(['--host']), UsageError)
  })
  test('--only có ký tự shell / ra ngoài kit / như cờ node ⇒ từ chối; cờ lạ ⇒ từ chối', () => {
    for (const g of ["x'y", 'a b', '$(x)', 'a;b', '`x`', '/etc/passwd', '../x.test.mjs', 'hooks/../../x', '--import=evil', '-x', '', 'a&b', 'a|b', 'a>b']) assert.throws(() => parseArgs(['--only', g]), UsageError, `only ${JSON.stringify(g)}`)
    assert.throws(() => parseArgs(['--only']), UsageError)
    assert.throws(() => parseArgs(['--bogus']), UsageError)
  })
})

describe('remoteScript', () => {
  test('mã thư mục: sha7 + ngày + giờ-ms, mỗi lần một mã mới', () => {
    assert.equal(makeId(SHA, NOW), ID)
    assert.notEqual(makeId(SHA, new Date(NOW.getTime() + 1)), ID)
  })
  test('run: PATH Homebrew, trap dọn, kiểm node/git, clone từ bundle rồi checkout đúng sha, node --test tap; mọi lệnh con có </dev/null', () => {
    const s = remoteScript({ id: ID, sha: SHA, only: ['hooks/lib/luu.test.mjs'] })
    assert.match(s, /export PATH='\/opt\/homebrew\/bin:\/usr\/local\/bin'":\$PATH"/)
    assert.match(s, /trap cleanup EXIT/)
    assert.match(s, /trap 'exit 129' HUP/)
    assert.ok(s.includes(`DIR=/tmp/${ID}`) && s.includes(`BUNDLE=/tmp/${ID}.bundle`))
    assert.match(s, /case "\$DIR" in \/tmp\/flowtest-\*\) rm -rf -- "\$DIR" ;; esac/, 'chỉ xoá khi đường dẫn thuộc /tmp/flowtest-*')
    assert.match(s, /command -v "\$t"[^\n]*exit 97/)
    assert.match(s, /mkdir "\$DIR" \|\| exit 98/, 'mkdir không -p: thư mục phải MỚI')
    assert.match(s, /git -c advice\.detachedHead=false clone -q "\$BUNDLE" "\$DIR\/kit" <\/dev\/null \|\| exit 98/)
    assert.ok(s.includes(`git checkout -q --detach ${SHA} </dev/null || exit 98`))
    assert.ok(s.includes("node --test --test-reporter=tap 'hooks/lib/luu.test.mjs' </dev/null"))
    assert.match(s, /rc=\$\?\nexit "\$rc"/)
    assert.ok(!s.includes('\r') && /^[\x09\x0a\x20-\x7e]*$/.test(s), 'chỉ ASCII, không CR')
  })
  test('không --only ⇒ node --test trần (toàn bộ bộ kiểm); nhiều --only ⇒ mỗi glob một cặp nháy đơn', () => {
    assert.ok(remoteScript({ id: ID, sha: SHA }).includes('node --test --test-reporter=tap </dev/null'))
    assert.ok(remoteScript({ id: ID, sha: SHA, only: ['a/*.test.mjs', 'b/{x,y}.test.mjs'] }).includes("tap 'a/*.test.mjs' 'b/{x,y}.test.mjs' </dev/null"))
  })
  test('clean: chỉ dọn + báo cleaned, không chạm node/git; gọi lại được', () => {
    const s = remoteScript({ id: ID, sha: SHA, mode: 'clean' })
    assert.ok(s.includes('rm -rf --') && s.includes('cleanup\nexit 0'))
    assert.ok(!/node --test|git clone|trap/.test(s))
  })
  test('mã thư mục/commit lạ ⇒ ném lỗi (không bao giờ ghép giá trị lạ vào script)', () => {
    assert.throws(() => remoteScript({ id: 'flowtest-x; ls', sha: SHA }))
    assert.throws(() => remoteScript({ id: '../../etc', sha: SHA }))
    assert.throws(() => remoteScript({ id: ID, sha: 'HEAD; ls' }))
  })
  test('shq: nháy đơn trong chuỗi được thoát đúng', () => {
    assert.equal(shq("a'b"), `'a'\\''b'`)
    assert.equal(shq('x y'), "'x y'")
  })
  test('cú pháp bash hợp lệ (bỏ qua nếu máy không có bash)', (t) => {
    for (const mode of ['run', 'clean']) {
      const r = spawnSync('bash', ['-n'], { input: remoteScript({ id: ID, sha: SHA, only: ['hooks/*.test.mjs'], mode }), encoding: 'utf8' })
      if (r.error) return t.skip('không có bash')
      assert.equal(r.status, 0, `bash -n (${mode}): ${r.stderr}`)
    }
  })
})

describe('buildCommands', () => {
  const cmds = buildCommands({ host: 'macmini', id: ID, sha: SHA, only: ['hooks/lib/luu.test.mjs'], repo: REPO, bundleDir: TMP_DIR })
  test('ssh: mảng tham số cố định (-T, BatchMode, timeout kết nối, --, host, "bash -s"); script đi qua stdin', () => {
    assert.deepEqual(cmds.probe.args.slice(0, 2), ['-T', '-o'])
    assert.ok(cmds.probe.args.includes('BatchMode=yes') && cmds.probe.args.includes('ConnectTimeout=10'))
    assert.deepEqual(cmds.probe.args.slice(-3), ['--', 'macmini', 'true'])
    assert.deepEqual(cmds.run.args.slice(-3), ['--', 'macmini', 'bash -s'])
    assert.ok(cmds.run.input.includes('trap cleanup EXIT') && cmds.clean.input.includes('cleanup\nexit 0'))
  })
  test('đường dẫn có dấu cách/tiếng Việt: chỉ làm một phần tử mảng cho git (cwd + đích bundle); scp dùng tên tương đối + cwd; Mac không bao giờ thấy đường dẫn máy này', () => {
    assert.equal(cmds.bundle.cwd, REPO)
    assert.deepEqual(cmds.bundle.args, ['bundle', 'create', path.join(TMP_DIR, 'flowtest.bundle'), 'HEAD'])
    assert.equal(cmds.copy.cwd, TMP_DIR)
    assert.deepEqual(cmds.copy.args.slice(-3), ['--', 'flowtest.bundle', `macmini:/tmp/${ID}.bundle`])
    for (const c of [cmds.probe, cmds.copy, cmds.run, cmds.clean]) {
      const all = `${c.args.join('\n')}\n${c.input ?? ''}`
      assert.ok(!all.includes(REPO) && !all.includes(TMP_DIR) && !all.includes('Dự án'), `${c.cmd} không chứa đường dẫn máy này`)
    }
  })
  test('KHÔNG dòng lệnh nào chứa thao tác xoá thư mục; việc xoá chỉ nằm trong script stdin', () => {
    for (const c of Object.values(cmds)) assert.ok(!DANGER.test([c.cmd, ...c.args].join(' ')), `${c.cmd} ${c.args.join(' ')}`)
    assert.ok(DANGER.test(cmds.run.input), 'script từ xa có lệnh xoá (bên trong, có rào /tmp/flowtest-*)')
  })
})

describe('parseTap / summarize', () => {
  test('TAP thật: đếm từ dòng tổng; chỉ bài hỏng LÁ (nhóm cha hỏng vì con thì bỏ); đọc cả error nhiều dòng; file tương đối kit', () => {
    const t = parseTap(TAP_MIXED)
    assert.deepEqual([t.tests, t.pass, t.fail, t.hasSummary], [4, 2, 2, true])
    assert.deepEqual(t.failures.map((f) => [f.name, f.file, f.error]), [
      ['hỏng thường', 'hooks/demo.test.mjs', 'Expected values to be strictly equal:'],
      ['thiếu công cụ', 'hooks/demo.test.mjs', 'spawnSync osv-scanner ENOENT'],
    ])
  })
  test('file test hỏng ngay từ đầu (không có bài con) vẫn tính là một bài hỏng, tên file bỏ tiền tố /tmp/flowtest-…/kit/', () => {
    const t = parseTap(`not ok 1 - /tmp/${ID}/kit/hooks/x.test.mjs\n  ---\n  error: 'Cannot find module'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1`)
    assert.deepEqual(t.failures.map((f) => f.name), ['hooks/x.test.mjs'])
  })
  test('missingTool: spawn ENOENT / command not found / env: x: No such file; lỗi thường ⇒ null', () => {
    assert.equal(missingTool("error: 'spawnSync osv-scanner ENOENT'"), 'osv-scanner')
    assert.equal(missingTool('spawn /opt/homebrew/bin/ast-grep ENOENT'), 'ast-grep')
    assert.equal(missingTool('sh: wails: command not found'), 'wails')
    assert.equal(missingTool('env: sg: No such file or directory'), 'sg')
    assert.equal(missingTool('Expected values to be strictly equal: 1 !== 2'), null)
  })
  test('xanh: một dòng tổng có chữ "xanh", exit 0', () => {
    const r = summarize({ host: 'macmini', nodeVer: 'v24.18.0', status: 0, stdout: TAP_GREEN })
    assert.equal(r.exit, 0)
    assert.deepEqual(r.lines, ['Mac (macmini, node v24.18.0): 2 bài · 2 đạt · 0 hỏng — xanh'])
  })
  test('hỏng do kit + thiếu công cụ Mac: exit 1, hai danh sách tách nhau', () => {
    const r = summarize({ host: 'macmini', status: 1, stdout: TAP_MIXED })
    assert.equal(r.exit, 1)
    assert.equal(r.lines[0], 'Mac (macmini): 4 bài · 2 đạt · 2 hỏng')
    assert.equal(r.lines[1], 'Hỏng do kit (1):')
    assert.equal(r.lines[2], '  - hooks/demo.test.mjs > hỏng thường — Expected values to be strictly equal:')
    assert.equal(r.lines[3], 'Thiếu công cụ trên Mac, KHÔNG phải lỗi kit (1 bài): osv-scanner')
  })
  test('chỉ hỏng vì Mac thiếu công cụ ⇒ exit 0 và nói rõ', () => {
    const r = summarize({ host: 'macmini', status: 1, stdout: TAP_ONLY_MACHINE })
    assert.equal(r.exit, 0)
    assert.match(r.lines.join('\n'), /Thiếu công cụ trên Mac, KHÔNG phải lỗi kit \(1 bài\): osv-scanner/)
    assert.ok(!r.lines.join('\n').includes('Hỏng do kit'))
  })
  test('không có dòng tổng / 0 bài / mã thoát lạ ⇒ exit 1, không bao giờ xanh im lặng', () => {
    const none = summarize({ host: 'm', status: 1, stdout: '', stderr: 'Error: Cannot find module x' })
    assert.equal(none.exit, 1)
    assert.match(none.lines[0], /không đọc được kết quả.*Cannot find module x/)
    const zero = summarize({ host: 'm', status: 0, stdout: '# tests 0\n# pass 0\n# fail 0', only: ['hooks/nope.test.mjs'] })
    assert.equal(zero.exit, 1)
    assert.match(zero.lines[0], /không có bài kiểm nào chạy.*--only hooks\/nope\.test\.mjs/)
    assert.equal(summarize({ host: 'm', status: 139, stdout: TAP_GREEN }).exit, 1)
    assert.equal(summarize({ host: 'm', status: 1, stdout: TAP_GREEN.replace('# fail 0', '# fail 1') }).exit, 1, 'fail>0 mà không đọc được bài nào ⇒ vẫn đỏ')
  })
  test('danh sách hỏng dài bị cắt ở 20 dòng + "… và N bài nữa"', () => {
    const many = Array.from({ length: 25 }, (_, i) => `not ok ${i + 1} - bài ${i}\n  ---\n  error: 'sai'\n  ...`).join('\n')
    const r = summarize({ host: 'm', status: 1, stdout: `${many}\n1..25\n# tests 25\n# pass 0\n# fail 25` })
    assert.equal(r.lines.length, 1 + 1 + 20 + 1)
    assert.equal(r.lines.at(-1), '  … và 5 bài nữa')
  })
})

describe('macTest (run giả)', () => {
  test('đường xanh: đúng thứ tự git → ssh thử → bundle → scp → ssh chạy; tổng kết + đã dọn; gỡ thư mục tạm máy này', () => {
    const r = go()
    assert.equal(r.exit, 0)
    assert.deepEqual(r.calls.map((c) => c.cmd + ' ' + (c.cmd === 'ssh' ? (c.args.at(-1) === 'true' ? 'probe' : 'run') : c.args[0])), ['git rev-parse', 'git rev-parse', 'git status', 'ssh probe', 'git bundle', 'scp -q', 'ssh run'])
    assert.deepEqual(r.lines, ['Mac (macmini, node v24.18.0): 2 bài · 2 đạt · 0 hỏng — xanh', 'Đã dọn thư mục tạm trên Mac.'])
    assert.deepEqual(r.removed, [TMP_DIR])
    assert.match(r.said[0], /nhánh flow-v7-dot4 \(commit a1b2c3d\)/)
    assert.ok(r.calls.filter((c) => c.cmd === 'git').every((c) => c.cwd === REPO))
  })
  test('có file chưa commit ⇒ một dòng lưu ý, vẫn chạy', () => {
    const r = go({ dirty: true })
    assert.equal(r.exit, 0)
    assert.ok(r.said.some((s) => /chưa commit.*chỉ nhận phần đã commit/.test(s)))
  })
  test('--only đi vào script từ xa', () => {
    const r = go({}, { only: ['hooks/lib/luu.test.mjs'] })
    assert.ok(r.calls.at(-1).input.includes("tap 'hooks/lib/luu.test.mjs' </dev/null"))
  })
  test('có bài hỏng ⇒ exit 1 kèm tên bài; vẫn dọn', () => {
    const r = go({ run: { status: 1, stdout: out(TAP_MIXED), stderr: '' } })
    assert.equal(r.exit, 1)
    assert.match(r.lines.join('\n'), /Hỏng do kit \(1\):\n  - hooks\/demo\.test\.mjs > hỏng thường/)
    assert.equal(r.lines.at(-1), 'Đã dọn thư mục tạm trên Mac.')
  })
  test('không ssh được ⇒ exit 3, lời đời thường, không đóng gói/chép gì, vẫn gỡ thư mục tạm', () => {
    const r = go({ probe: { status: 255, stdout: '', stderr: 'ssh: Could not resolve hostname macmini' } })
    assert.equal(r.exit, 3)
    assert.match(r.lines[0], /Không nối được tới Mac \(macmini\)\. ssh: Could not resolve hostname macmini/)
    assert.match(r.lines[1], /Mac đang bật, cùng mạng/)
    assert.ok(!r.calls.some((c) => c.cmd === 'scp' || c.args[0] === 'bundle'))
    assert.deepEqual(r.removed, [TMP_DIR])
  })
  test('máy này không có lệnh ssh ⇒ exit 3', () => {
    const r = go({ probe: { status: null, error: Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }) } })
    assert.equal(r.exit, 3)
    assert.match(r.lines[0], /chưa có lệnh ssh/)
  })
  test('scp lỗi ⇒ exit 3 và gọi script dọn (mode clean) để bundle dở không nằm lại trên Mac', () => {
    const r = go({ copy: { status: 1, stdout: '', stderr: 'scp: /tmp: No space left' } })
    assert.equal(r.exit, 3)
    assert.match(r.lines[0], /Không chép được sang Mac.*No space left/)
    const last = r.calls.at(-1)
    assert.ok(last.cmd === 'ssh' && last.input.includes('cleanup\nexit 0') && !last.input.includes('node --test'))
  })
  test('git bundle lỗi ⇒ exit 1, không scp', () => {
    const r = go({ bundle: { status: 128, stdout: '', stderr: 'fatal: Refusing to create empty bundle' } })
    assert.equal(r.exit, 1)
    assert.ok(!r.calls.some((c) => c.cmd === 'scp'))
  })
  test('Mac thiếu node/git (mã 97) ⇒ exit 3 nêu tên công cụ; không dựng được bản sao (98) ⇒ exit 1', () => {
    const miss = go({ run: { status: 97, stdout: `${MARK} missing node\n${MARK} cleaned\n`, stderr: '' } })
    assert.equal(miss.exit, 3)
    assert.match(miss.lines[0], /Mac chưa có node/)
    const clone = go({ run: { status: 98, stdout: `${MARK} cleaned\n`, stderr: 'fatal: bad object' } })
    assert.equal(clone.exit, 1)
    assert.match(clone.lines[0], /không dựng được bản sao.*bad object/)
  })
  test('mất kết nối giữa chừng (255) hoặc quá giờ ⇒ không tin dấu cleaned: gọi script dọn lại; dọn không xong ⇒ nói rõ thư mục nào', () => {
    const drop = go({ run: { status: 255, stdout: '', stderr: 'client_loop: send disconnect' }, clean: { status: 255, stdout: '', stderr: '' } })
    assert.equal(drop.exit, 3)
    assert.match(drop.lines[0], /Mất kết nối với Mac/)
    assert.equal(drop.lines.at(-1), `Chưa dọn được thư mục tạm trên Mac: /tmp/${ID} (macOS tự dọn /tmp khi khởi động lại).`)
    assert.equal(drop.calls.filter((c) => c.cmd === 'ssh' && c.input?.includes('cleanup\nexit 0')).length, 1)
    const slow = go({ run: { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) } })
    assert.equal(slow.exit, 1)
    assert.match(slow.lines[0], /quá 20 phút/)
    assert.equal(slow.lines.at(-1), 'Đã dọn thư mục tạm trên Mac.')
  })
  test('git của kit hỏng ⇒ exit 1, không đụng ssh', () => {
    const run = (cmd) => ({ status: cmd === 'git' ? 128 : 0, stdout: '', stderr: 'fatal: not a git repository' })
    const r = macTest({ repo: REPO, run, tmp: { make: () => TMP_DIR, remove() {} } })
    assert.equal(r.exit, 1)
  })
  test('toàn bộ lệnh của một lần chạy đầy đủ: không dòng lệnh nào chứa thao tác xoá thư mục', () => {
    for (const c of go().calls) assert.ok(!DANGER.test([c.cmd, ...c.args].join(' ')), `${c.cmd} ${c.args.join(' ')}`)
  })
})

describe('main', () => {
  const sink = () => { const b = []; return { write: (s) => b.push(s), text: () => b.join('') } }
  test('cờ sai / host nguy hiểm ⇒ exit 2 + dòng dùng', () => {
    for (const argv of [['--bogus'], ['--host', '-oProxyCommand=x'], ['--only', '../x']]) {
      const e = sink()
      assert.equal(main(argv, { stderr: e, stdout: sink() }), 2, argv.join(' '))
      assert.match(e.text(), /dùng: mac-check\.mjs/)
    }
  })
  test('-h ⇒ exit 0 và in cách dùng, không chạy gì', () => {
    const o = sink()
    assert.equal(main(['-h'], { stdout: o, run: () => { throw new Error('không được chạy') } }), 0)
    assert.match(o.text(), /exit: 0 xanh/)
  })
  test('chạy đủ qua main với run giả: in tiến trình rồi tổng kết, trả mã thoát của lõi', () => {
    const f = fake({ run: { status: 1, stdout: out(TAP_MIXED), stderr: '' } })
    const o = sink()
    const code = main(['--only', 'hooks/lib/luu.test.mjs'], { repo: REPO, run: f.run, now: NOW, stdout: o, tmp: { make: () => TMP_DIR, remove() {} } })
    assert.equal(code, 1)
    assert.match(o.text(), /Đóng gói bản hiện tại…\nChép sang Mac…\nChạy bộ kiểm trên Mac…\nMac \(macmini, node v24\.18\.0\): 4 bài/)
  })
})
