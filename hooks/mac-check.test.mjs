// Test cho mac-check.mjs: node --test ~/.claude/hooks/mac-check.test.mjs
// Không cần Mac thật: lõi nhận `run` giả (ghi lại mọi lệnh ssh/scp/git) + thư mục tạm giả. Đường dẫn máy này có dấu cách + tiếng Việt.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MARK, UsageError, buildCommands, devinScript, macTest, macTestDevin, main, missingTool, parseArgs, parseTap, remoteCommands, remoteScript, shq, summarize } from './mac-check.mjs'
import { DevinUnavailable, ToolError, makeCtx, runProc, wrapRemote } from './lib/devin.mjs'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

test('tên CLI không khớp mẫu file test mặc định của node --test (khớp ⇒ chạy toàn bộ test sẽ tự gọi sang Mac)', () => {
  assert.doesNotMatch('mac-check.mjs', /^test[-.]|[-._]test\.[cm]?js$|^test\.[cm]?js$/)
})
// Thư mục riêng do `mktemp -d /tmp/flowtest-XXXXXX` trên Mac tạo (0700, tên ngẫu nhiên) — bundle và bản sao nằm TRONG đó.
const DIR = '/tmp/flowtest-aB3xY9'
const REPO = path.join(os.tmpdir(), 'Dự án', 'bộ kit thử')
const TMP_DIR = path.join(os.tmpdir(), 'Thư mục tạm', 'lần 1')
// Hợp đồng: không phần tử mảng tham số nào được là lệnh xoá thư mục (xoá chỉ nằm trong script gửi qua stdin).
const DANGER = /(^|[\s;&|])(rm|rmdir|rd|del|erase)(\s|$)|-rf\b|-fr\b|Remove-Item|rimraf/i

// TAP thật của node:test (nhóm có 1 bài hỏng thường + 1 bài thiếu công cụ), đường dẫn kiểu Mac.
const LOC = (line) => `      location: '${DIR}/kit/hooks/demo.test.mjs:${line}:3'`
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

// run giả: ghi lại lệnh, trả kết quả theo kiểu lệnh. over = { probe, mkdir, copy, run, clean, bundle, dirty, branch }
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
    if (cmd === 'ssh' && o.input?.includes('mktemp -d')) return over.mkdir ?? { ...ok, stdout: `${MARK} dir ${DIR}\n` }
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
  const res = macTest({ repo: REPO, host: 'macmini', run: f.run, tmp: { make: () => TMP_DIR, remove: (d) => removed.push(d) }, say: (s) => said.push(s), ...opts })
  return { ...res, calls: f.calls, removed, said }
}

describe('parseArgs', () => {
  test('mặc định KHÔNG có host (⇒ máy macOS của Devin), không --only; --host / --only (lặp được, dạng = cũng được)', () => {
    assert.deepEqual(parseArgs([]), { host: null, only: [], help: false })
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
  test('thư mục tạm trên Mac do mktemp -d tạo (0700, tên ngẫu nhiên) TRƯỚC khi chép gì sang — không có tên đoán trước được theo commit/giờ', () => {
    const c = buildCommands({ host: 'macmini', repo: REPO, bundleDir: TMP_DIR })
    assert.ok(c.mkdir.input.includes('mktemp -d /tmp/flowtest-XXXXXX'), c.mkdir.input)
    assert.deepEqual(c.mkdir.args.slice(-3), ['--', 'macmini', 'bash -s'])
    assert.ok(!/node --test|git clone|rm /.test(c.mkdir.input), 'script tạo thư mục chỉ tạo, không chạy/xoá gì')
    assert.match(c.mkdir.input, /mktemp -d [^\n]*\|\| exit 98/)
  })
  test('run: PATH Homebrew, trap dọn, kiểm node/git, clone từ bundle rồi checkout đúng sha, node --test tap; mọi lệnh con có </dev/null', () => {
    const s = remoteScript({ dir: DIR, sha: SHA, only: ['hooks/lib/luu.test.mjs'] })
    assert.match(s, /export PATH='\/opt\/homebrew\/bin:\/usr\/local\/bin'":\$PATH"/)
    assert.match(s, /trap cleanup EXIT/)
    assert.match(s, /trap 'exit 129' HUP/)
    assert.ok(s.includes(`DIR=${DIR}\n`) && s.includes('BUNDLE="$DIR/flowtest.bundle"'), 'bundle nằm TRONG thư mục riêng')
    assert.match(s, /case "\$DIR" in \/tmp\/flowtest-\*\) rm -rf -- "\$DIR" ;; esac/, 'chỉ xoá khi đường dẫn thuộc /tmp/flowtest-*')
    assert.ok(!/\brm -f\b/.test(s), 'không xoá riêng file nào ngoài thư mục riêng (bundle nằm trong DIR nên đi theo DIR)')
    assert.match(s, /command -v "\$t"[^\n]*exit 97/)
    assert.match(s, /\[ -d "\$DIR" \] && \[ ! -L "\$DIR" \] \|\| exit 98/, 'thư mục phải có thật và không là symlink')
    assert.ok(!/mkdir "\$DIR"/.test(s), 'thư mục đã được mktemp tạo sẵn, script không tự mkdir')
    assert.match(s, /git -c advice\.detachedHead=false clone -q "\$BUNDLE" "\$DIR\/kit" <\/dev\/null \|\| exit 98/)
    assert.ok(s.includes(`git checkout -q --detach ${SHA} </dev/null || exit 98`))
    assert.ok(s.includes("node --test --test-reporter=tap 'hooks/lib/luu.test.mjs' </dev/null"))
    assert.match(s, /rc=\$\?\nexit "\$rc"/)
    assert.ok(!s.includes('\r') && /^[\x09\x0a\x20-\x7e]*$/.test(s), 'chỉ ASCII, không CR')
  })
  test('không --only ⇒ node --test trần (toàn bộ bộ kiểm); nhiều --only ⇒ mỗi glob một cặp nháy đơn', () => {
    assert.ok(remoteScript({ dir: DIR, sha: SHA }).includes('node --test --test-reporter=tap </dev/null'))
    assert.ok(remoteScript({ dir: DIR, sha: SHA, only: ['a/*.test.mjs', 'b/{x,y}.test.mjs'] }).includes("tap 'a/*.test.mjs' 'b/{x,y}.test.mjs' </dev/null"))
  })
  test('clean: chỉ dọn đúng thư mục riêng + báo cleaned, không chạm node/git; gọi lại được', () => {
    const s = remoteScript({ dir: DIR, sha: SHA, mode: 'clean' })
    assert.ok(s.includes('rm -rf --') && s.includes('cleanup\nexit 0'))
    assert.ok(!/node --test|git clone|trap/.test(s))
    assert.ok(s.includes(`if [ ! -e "$DIR" ]; then echo '${MARK} cleaned'`), 'chỉ xác nhận thư mục riêng đã biến mất')
  })
  test('thư mục/commit lạ ⇒ ném lỗi (chỉ nhận /tmp/flowtest-<chữ+số> do mktemp trả; không bao giờ ghép giá trị lạ vào script)', () => {
    for (const bad of ['/tmp/flowtest-x; ls', '/tmp/../etc', '/tmp/flowtest-', '/tmp/flowtest-ab', '/tmp/flowtest-abcdef/../..', '/etc/flowtest-abcdef', '/tmp/flowtest-abc def', '/tmp/flowtest-abcdef\n', 'flowtest-abcdef', '/tmp/flowtest-abc.def', undefined]) {
      assert.throws(() => remoteScript({ dir: bad, sha: SHA }), undefined, `dir ${JSON.stringify(bad)}`)
    }
    assert.throws(() => remoteScript({ dir: DIR, sha: 'HEAD; ls' }))
  })
  test('shq: nháy đơn trong chuỗi được thoát đúng', () => {
    assert.equal(shq("a'b"), `'a'\\''b'`)
    assert.equal(shq('x y'), "'x y'")
  })
  test('cú pháp bash hợp lệ (bỏ qua nếu máy không có bash)', (t) => {
    for (const mode of ['run', 'clean']) {
      const r = spawnSync('bash', ['-n'], { input: remoteScript({ dir: DIR, sha: SHA, only: ['hooks/*.test.mjs'], mode }), encoding: 'utf8' })
      if (r.error) return t.skip('không có bash')
      assert.equal(r.status, 0, `bash -n (${mode}): ${r.stderr}`)
    }
    const m = spawnSync('bash', ['-n'], { input: buildCommands({ host: 'macmini', repo: REPO, bundleDir: TMP_DIR }).mkdir.input, encoding: 'utf8' })
    if (m.error) return t.skip('không có bash')
    assert.equal(m.status, 0, `bash -n (mkdir): ${m.stderr}`)
  })
})

describe('buildCommands / remoteCommands', () => {
  const pre = buildCommands({ host: 'macmini', repo: REPO, bundleDir: TMP_DIR })
  const cmds = { ...pre, ...remoteCommands({ host: 'macmini', dir: DIR, sha: SHA, only: ['hooks/lib/luu.test.mjs'], bundleDir: TMP_DIR }) }
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
    for (const c of [cmds.probe, cmds.mkdir, cmds.copy, cmds.run, cmds.clean]) {
      const all = `${c.args.join('\n')}\n${c.input ?? ''}`
      assert.ok(!all.includes(REPO) && !all.includes(TMP_DIR) && !all.includes('Dự án'), `${c.cmd} không chứa đường dẫn máy này`)
    }
  })
  test('scp ghi bundle VÀO thư mục riêng mktemp đã tạo (đích không đoán trước được, không ghi thẳng /tmp/flowtest-<sha>…bundle)', () => {
    assert.deepEqual(cmds.copy.args.slice(-3), ['--', 'flowtest.bundle', `macmini:${DIR}/flowtest.bundle`])
    for (const c of Object.values(cmds)) {
      const all = `${c.args.join('\n')}\n${c.input ?? ''}`
      assert.ok(!/\/tmp\/flowtest-[0-9a-f]{7}-/.test(all) && !/\/tmp\/flowtest-[^\s/"']*\.bundle/.test(all), `${c.cmd}: tên trên Mac không chứa sha/ngày/giờ và không có file bundle nằm ngay dưới /tmp`)
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
    const t = parseTap(`not ok 1 - ${DIR}/kit/hooks/x.test.mjs\n  ---\n  error: 'Cannot find module'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1`)
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
  const kindOf = (c) => c.cmd + ' ' + (c.cmd === 'ssh' ? (c.args.at(-1) === 'true' ? 'probe' : c.input.includes('mktemp -d') ? 'mkdir' : c.input.includes('trap cleanup EXIT') ? 'run' : 'clean') : c.args[0])
  test('đường xanh: đúng thứ tự git → ssh thử → bundle → ssh mktemp (thư mục riêng) → scp vào thư mục đó → ssh chạy; tổng kết + đã dọn; gỡ thư mục tạm máy này', () => {
    const r = go()
    assert.equal(r.exit, 0)
    assert.deepEqual(r.calls.map(kindOf), ['git rev-parse', 'git rev-parse', 'git status', 'ssh probe', 'git bundle', 'ssh mkdir', 'scp -q', 'ssh run'])
    assert.equal(r.calls.find((c) => c.cmd === 'scp').args.at(-1), `macmini:${DIR}/flowtest.bundle`, 'scp ghi vào thư mục mktemp trả về')
    assert.ok(r.calls.at(-1).input.includes(`DIR=${DIR}\n`))
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
  test('git bundle lỗi ⇒ exit 1, không scp, chưa tạo gì trên Mac', () => {
    const r = go({ bundle: { status: 128, stdout: '', stderr: 'fatal: Refusing to create empty bundle' } })
    assert.equal(r.exit, 1)
    assert.ok(!r.calls.some((c) => c.cmd === 'scp'))
    assert.ok(!r.calls.some((c) => c.cmd === 'ssh' && c.input?.includes('mktemp')), 'bundle local hỏng thì chưa mktemp')
  })
  test('mktemp trên Mac lỗi / không trả thư mục hợp lệ (kể cả đường dẫn lạ như /etc, ../) ⇒ exit 3, KHÔNG scp, không chạy gì', () => {
    const bad = [
      ['mktemp lỗi', { status: 1, stdout: '', stderr: 'mktemp: mkstemp failed on /tmp/flowtest-XXXXXX: No space left' }, /No space left/],
      ['không có dòng thư mục', { status: 0, stdout: 'Welcome to macOS\n', stderr: '' }, /không trả đường dẫn/],
      ['đường dẫn ngoài /tmp/flowtest-', { status: 0, stdout: `${MARK} dir /etc\n`, stderr: '' }, /không trả đường dẫn/],
      ['đường dẫn có ..', { status: 0, stdout: `${MARK} dir /tmp/flowtest-abcdef/../../etc\n`, stderr: '' }, /không trả đường dẫn/],
    ]
    for (const [name, mkdir, re] of bad) {
      const r = go({ mkdir })
      assert.equal(r.exit, 3, name)
      assert.match(r.lines[0], /Không tạo được thư mục tạm trên Mac/, name)
      assert.match(r.lines[0], re, name)
      assert.ok(!r.calls.some((c) => c.cmd === 'scp'), `${name}: không scp`)
      assert.ok(!r.calls.some((c) => c.cmd === 'ssh' && c.input?.includes('trap cleanup EXIT')), `${name}: không chạy test`)
      assert.deepEqual(r.removed, [TMP_DIR], name)
    }
  })
  test('thư mục riêng khác nhau mỗi lần (mktemp): đích scp và script chạy/dọn đều theo thư mục mktemp trả về, không theo giờ/sha', () => {
    const r = go({ mkdir: { status: 0, stdout: `${MARK} dir /tmp/flowtest-Q9zK2m\n`, stderr: '' } })
    assert.equal(r.exit, 0)
    assert.equal(r.calls.find((c) => c.cmd === 'scp').args.at(-1), 'macmini:/tmp/flowtest-Q9zK2m/flowtest.bundle')
    assert.ok(r.calls.at(-1).input.includes('DIR=/tmp/flowtest-Q9zK2m\n'))
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
    assert.equal(drop.lines.at(-1), `Chưa dọn được thư mục tạm trên Mac: ${DIR} (macOS tự dọn /tmp khi khởi động lại).`)
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
  test('cờ sai / host nguy hiểm ⇒ exit 2 + dòng dùng', async () => {
    for (const argv of [['--bogus'], ['--host', '-oProxyCommand=x'], ['--only', '../x']]) {
      const e = sink()
      assert.equal(await main(argv, { stderr: e, stdout: sink() }), 2, argv.join(' '))
      assert.match(e.text(), /dùng: mac-check\.mjs/)
    }
  })
  test('-h ⇒ exit 0 và in cách dùng, không chạy gì', async () => {
    const o = sink()
    assert.equal(await main(['-h'], { stdout: o, run: () => { throw new Error('không được chạy') } }), 0)
    assert.match(o.text(), /exit: 0 xanh/)
    assert.match(o.text(), /máy macOS của Devin/)
  })
  test('--host macmini giữ LỐI CŨ (ssh): in tiến trình rồi tổng kết, trả mã thoát của lõi; không đụng Devin', async () => {
    const f = fake({ run: { status: 1, stdout: out(TAP_MIXED), stderr: '' } })
    const o = sink()
    const vm = new Proxy({}, { get: () => { throw new Error('lối ssh không được gọi Devin') } })
    const code = await main(['--host', 'macmini', '--only', 'hooks/lib/luu.test.mjs'], { repo: REPO, run: f.run, stdout: o, vm, tmp: { make: () => TMP_DIR, remove() {} } })
    assert.equal(code, 1)
    assert.match(o.text(), /Đóng gói bản hiện tại…\nChép sang Mac…\nChạy bộ kiểm trên Mac…\nMac \(macmini, node v24\.18\.0\): 4 bài/)
  })
})

// ---------- đường mặc định: máy macOS của Devin (AC-15) ----------
const SIGNED = 'https://s3.example.test/signed/att1abcdef?X-Amz-Signature=SIGSECRET'
const OUT = (tap, { cleaned = true } = {}) => out(tap, { cleaned })

describe('devinScript', () => {
  const s = devinScript({ url: SIGNED, sha: SHA, only: ['hooks/lib/luu.test.mjs'] })
  test('MỘT script: mktemp -d riêng + trap dọn + kiểm node/git/curl + curl bundle vào thư mục riêng + clone + checkout đúng sha + node --test tap; lệnh con có </dev/null; chỉ ASCII', () => {
    assert.match(s, /^export PATH='\/opt\/homebrew\/bin:\/usr\/local\/bin'":\$HOME\/\.local\/bin:\$PATH"\n/)
    assert.match(s, /DIR=\$\(mktemp -d \/tmp\/flowtest-XXXXXX <\/dev\/null\) \|\| exit 98/)
    assert.match(s, /trap cleanup EXIT[\s\S]*trap 'exit 129' HUP/)
    assert.match(s, /case "\$DIR" in \/tmp\/flowtest-\*\) rm -rf -- "\$DIR" ;; esac/, 'chỉ xoá khi đường dẫn thuộc /tmp/flowtest-*')
    assert.match(s, /for t in node git curl; do[\s\S]*exit 97/)
    assert.ok(s.includes(`curl -fsSL --retry 3 --max-time 300 -o "$DIR/flowtest.bundle" '${SIGNED}' </dev/null || exit 96`), 'link ký sẵn trong nháy đơn, tải VÀO thư mục riêng')
    assert.ok(s.includes('git -c advice.detachedHead=false clone -q "$DIR/flowtest.bundle" "$DIR/kit" </dev/null || exit 98'))
    assert.ok(s.includes(`git checkout -q --detach ${SHA} </dev/null || exit 98`))
    assert.ok(s.includes("node --test --test-reporter=tap 'hooks/lib/luu.test.mjs' </dev/null"))
    assert.ok(!/\bscp\b|\bssh\b|stdin/.test(s), 'không còn scp/ssh trong script')
    assert.ok(!s.includes('\r') && /^[\x09\x0a\x20-\x7e]*$/.test(s))
    assert.ok(devinScript({ url: SIGNED, sha: SHA }).includes('node --test --test-reporter=tap </dev/null'))
  })
  test('sha/link lạ ⇒ ném lỗi (không bao giờ ghép giá trị lạ vào script); bash -n ổn', (t) => {
    for (const bad of [{ sha: 'HEAD; ls' }, { url: 'http://x/y' }, { url: "https://x/'; rm -rf ~; '" }, { url: 'file:///etc/passwd' }, { url: undefined }]) assert.throws(() => devinScript({ url: SIGNED, sha: SHA, ...bad }), undefined, JSON.stringify(bad))
    const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' })
    if (r.error) return t.skip('không có bash')
    assert.equal(r.status, 0, r.stderr)
  })
  test('qua wrapRemote của lõi: dòng lệnh tới `devin ssh` chỉ có ký tự an toàn (không nháy kép, không xuống dòng, không link thô)', () => {
    const cmd = wrapRemote(s)
    assert.ok(!/["\n\r]/.test(cmd) && !cmd.includes('SIGSECRET') && !cmd.includes('s3.example'))
    assert.equal(Buffer.from(/printf %s '([A-Za-z0-9+/=]+)'/.exec(cmd)[1], 'base64').toString('utf8'), s)
  })
})

// vm giả (cùng hình với vmClient của lõi); timeline chung với `run` git để kiểm thứ tự.
function fakeVm(timeline, over = {}) {
  const calls = { run: [], upload: [] }
  const vm = {
    calls,
    up: async () => { timeline.push('up'); return over.up ? over.up() : { id: 'devin-mac123abc' } },
    upload: async (file, name) => { timeline.push('upload'); calls.upload.push({ file, name }); const u = { name }; Object.defineProperty(u, 'url', { value: SIGNED }); return u },
    runScript: async (id, script, o) => { timeline.push('run'); calls.run.push({ id, script, o }); if (over.run instanceof Error) throw over.run; return over.run ?? { code: 0, stdout: OUT(TAP_GREEN), stderr: '', timedOut: false } },
    sleep: async () => { timeline.push('sleep'); if (over.sleep instanceof Error) throw over.sleep; return over.sleep ?? { ok: true, status: 'suspended', id: 'devin-mac123abc' } },
  }
  return vm
}
async function goDevin({ vmOver = {}, git = {}, opts = {} } = {}) {
  const timeline = []
  const f = fake(git)
  const run = (cmd, args, o) => { timeline.push(`${cmd} ${args[0]}`); return f.run(cmd, args, o) }
  const removed = []
  const said = []
  const vm = fakeVm(timeline, vmOver)
  let res
  let error
  try {
    res = await macTestDevin({ repo: REPO, run, tmp: { make: () => TMP_DIR, remove: (d) => removed.push(d) }, say: (s) => said.push(s), vm, ...opts })
  } catch (e) {
    error = e
  }
  return { res, error, timeline, removed, said, vm }
}

describe('macTestDevin (vm giả)', () => {
  test('đường xanh: git → đóng gói bundle (rẻ) → bật máy → chép → chạy → NGỦ; tổng kết như lối ssh; bundle/link không lọt ra lời; thư mục tạm máy này được gỡ', async () => {
    const r = await goDevin({ opts: { only: ['hooks/lib/luu.test.mjs'] } })
    assert.equal(r.res.exit, 0)
    assert.deepEqual(r.timeline, ['git rev-parse', 'git rev-parse', 'git status', 'git bundle', 'up', 'upload', 'run', 'sleep'])
    assert.deepEqual(r.res.lines, ['Mac (Devin macOS, node v24.18.0): 2 bài · 2 đạt · 0 hỏng — xanh', 'Đã dọn thư mục tạm trên máy ảo.'])
    assert.deepEqual(r.removed, [TMP_DIR])
    assert.match(r.said[0], /máy macOS của Devin: nhánh flow-v7-dot4 \(commit a1b2c3d\)/)
    const [run] = r.vm.calls.run
    assert.equal(run.id, 'devin-mac123abc')
    assert.ok(run.script.includes(`'${SIGNED}'`) && run.script.includes("tap 'hooks/lib/luu.test.mjs'"))
    assert.deepEqual(run.o.secrets, [SIGNED], 'link ký sẵn bị che nếu máy ảo in lại')
    assert.equal(run.o.timeout, 20 * 60_000)
    assert.equal(r.vm.calls.upload[0].name, 'flowtest-a1b2c3d4.bundle')
    assert.ok(![...r.res.lines, ...r.said].join('\n').match(/SIGSECRET|s3\.example/))
  })
  test('có bài hỏng ⇒ exit 1 kèm tên bài (đọc TAP như lối ssh); vẫn ngủ', async () => {
    const r = await goDevin({ vmOver: { run: { code: 1, stdout: OUT(TAP_MIXED), stderr: '', timedOut: false } } })
    assert.equal(r.res.exit, 1)
    assert.match(r.res.lines.join('\n'), /Hỏng do kit \(1\):\n  - hooks\/demo\.test\.mjs > hỏng thường/)
    assert.equal(r.timeline.at(-1), 'sleep')
  })
  test('chỉ hỏng vì Mac thiếu công cụ ⇒ exit 0 và nói rõ (như lối ssh)', async () => {
    const r = await goDevin({ vmOver: { run: { code: 1, stdout: OUT(TAP_ONLY_MACHINE), stderr: '', timedOut: false } } })
    assert.equal(r.res.exit, 0)
    assert.match(r.res.lines.join('\n'), /Thiếu công cụ trên Mac, KHÔNG phải lỗi kit \(1 bài\): osv-scanner/)
  })
  test('Devin chưa đăng nhập / hết hạn mức lúc bật máy ⇒ exit 3 + lệnh đăng nhập, không chép/chạy gì; vẫn thử cho ngủ (máy tạo dở)', async () => {
    const r = await goDevin({ vmOver: { up: () => { throw new DevinUnavailable('not-logged-in', 'Devin chưa đăng nhập', 'devin auth login') } } })
    assert.equal(r.res.exit, 3)
    assert.equal(r.res.lines[0], 'Devin không dùng được: Devin chưa đăng nhập — chạy: devin auth login')
    assert.deepEqual(r.timeline.slice(4), ['up', 'sleep'])
  })
  test('cài Node lên máy ảo lỗi (ToolError) ⇒ exit 3 (máy chưa dùng được), vẫn ngủ', async () => {
    const r = await goDevin({ vmOver: { up: () => { throw new ToolError('Cài Node lên máy ảo lỗi: Node tải về sai mã kiểm') } } })
    assert.equal(r.res.exit, 3)
    assert.match(r.res.lines[0], /Máy macOS của Devin chưa dùng được: Cài Node/)
    assert.equal(r.timeline.at(-1), 'sleep')
  })
  test('lỗi bất ngờ giữa chừng ⇒ ném tiếp NHƯNG máy vẫn ngủ và thư mục tạm vẫn gỡ (AC-07)', async () => {
    const r = await goDevin({ vmOver: { run: new Error('nổ') } })
    assert.match(r.error.message, /nổ/)
    assert.equal(r.timeline.at(-1), 'sleep')
    assert.deepEqual(r.removed, [TMP_DIR])
  })
  test('máy không ngủ kịp ⇒ xanh cũng thành exit 1 + CẢNH BÁO kèm lệnh sleep; ngủ ném lỗi cũng vậy; exit 3 vì Devin hỏng thì không đòi thêm', async () => {
    const slow = await goDevin({ vmOver: { sleep: { ok: false, status: 'running' } } })
    assert.equal(slow.res.exit, 1)
    assert.match(slow.res.lines.at(-1), /^CẢNH BÁO: máy macOS của Devin chưa ngủ \(trạng thái running\) — chạy: node hooks\/devin-vm\.mjs sleep --os macos/)
    const thrown = await goDevin({ vmOver: { sleep: new ToolError('MCP lỗi') } })
    assert.equal(thrown.res.exit, 1)
    assert.match(thrown.res.lines.at(-1), /CẢNH BÁO: không cho máy macOS của Devin ngủ được/)
    const down = await goDevin({ vmOver: { up: () => { throw new DevinUnavailable('network', 'mạng') }, sleep: new DevinUnavailable('network', 'mạng') } })
    assert.deepEqual([down.res.exit, down.res.lines.length], [3, 1])
  })
  test('mã thoát của script: 97 thiếu node ⇒ 3 · 96 không tải được ⇒ 3 · 98 ⇒ 1 · 255/mất nối ⇒ 3 · quá giờ ⇒ 1 · không đọc được kết quả ⇒ 1', async () => {
    const t = async (run) => (await goDevin({ vmOver: { run: { stdout: '', stderr: '', timedOut: false, ...run } } })).res
    const missing = await t({ code: 97, stdout: `${MARK} missing node\n${MARK} cleaned\n` })
    assert.equal(missing.exit, 3)
    assert.match(missing.lines[0], /chưa có node/)
    assert.equal((await t({ code: 96 })).exit, 3)
    assert.equal((await t({ code: 98, stderr: 'fatal: bad object' })).exit, 1)
    assert.equal((await t({ code: 255, stderr: 'client_loop: send disconnect' })).exit, 3)
    const slow = await t({ code: null, timedOut: true })
    assert.deepEqual([slow.exit, /quá 20 phút/.test(slow.lines[0])], [1, true])
    const none = await t({ code: 1, stderr: 'Error: Cannot find module x' })
    assert.equal(none.exit, 1)
    assert.match(none.lines[0], /không đọc được kết quả.*Cannot find module x/)
    assert.match((await t({ code: 0, stdout: OUT(TAP_GREEN, { cleaned: false }) })).lines.at(-1), /Chưa xác nhận dọn thư mục tạm trên máy ảo/)
  })
  test('git bundle lỗi ⇒ exit 1 và CHƯA đụng máy ảo (không bật, không ngủ); git hỏng ⇒ exit 1', async () => {
    const r = await goDevin({ git: { bundle: { status: 128, stdout: '', stderr: 'fatal: Refusing to create empty bundle' } } })
    assert.equal(r.res.exit, 1)
    assert.deepEqual(r.timeline.filter((x) => !x.startsWith('git ')), [])
    const g = await macTestDevin({ repo: REPO, run: () => ({ status: 128, stdout: '', stderr: 'fatal' }), tmp: { make: () => TMP_DIR, remove() {} }, vm: {} })
    assert.equal(g.exit, 1)
  })
  test('có file chưa commit ⇒ một dòng lưu ý, vẫn chạy', async () => {
    const r = await goDevin({ git: { dirty: true } })
    assert.equal(r.res.exit, 0)
    assert.ok(r.said.some((s) => /chưa commit.*chỉ nhận phần đã commit/.test(s)))
  })
})

describe('main mặc định (Devin)', () => {
  const sink = () => { const b = []; return { write: (s) => b.push(s), text: () => b.join('') } }
  test('không --host ⇒ chạy qua vm (Devin), in tiến trình + tổng kết, trả mã thoát; --only đi vào script; ghi một dòng log nếu có ctx', async () => {
    const timeline = []
    const f = fake()
    const vm = fakeVm(timeline)
    const o = sink()
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-log-')), 'devin-vm.log')
    const ctx = makeCtx({ logFile })
    const code = await main(['--only', 'hooks/lib/luu.test.mjs'], { repo: REPO, run: f.run, stdout: o, vm, ctx, tmp: { make: () => TMP_DIR, remove() {} } })
    assert.equal(code, 0)
    assert.match(o.text(), /Đóng gói bản hiện tại…\nBật máy macOS của Devin…\nChép bản kit lên máy ảo…\nChạy bộ kiểm trên máy macOS của Devin…\nMac \(Devin macOS, node v24\.18\.0\): 2 bài/)
    assert.ok(vm.calls.run[0].script.includes("tap 'hooks/lib/luu.test.mjs'"))
    assert.match(fs.readFileSync(logFile, 'utf8'), /^\S+\tmac-check\tdevin-mac123abc\t\d+\t0\n$/)
    assert.ok(!fs.readFileSync(logFile, 'utf8').includes('luu.test'), 'log không có nội dung lệnh')
  })
})

// ---------- tích hợp với lib/devin.mjs: REST/MCP/ssh giả, git thật ----------
describe('tích hợp: mac-check ⇒ lib/devin.mjs', () => {
  test('bundle THẬT của HEAD lên qua tệp đính kèm; script tới máy ảo trong đối số base64 (không stdin); máy macOS được tạo không nối kho; xong thì ngủ; khoá/link không ra stdout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-int-'))
    const gitIn = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
    const repo = path.join(root, 'kit mẫu')
    fs.mkdirSync(path.join(repo, 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'hooks', 'a.test.mjs'), 'export {}\n')
    gitIn(repo, 'init', '-q', '-b', 'main')
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-q', '-m', 'k1')
    const head = gitIn(repo, 'rev-parse', 'HEAD')
    fs.mkdirSync(path.join(root, 'devin'))
    fs.writeFileSync(path.join(root, 'devin', 'credentials.toml'), 'windsurf_api_key = "devin-session-token$KEYSECRET123456"\n')
    fs.writeFileSync(path.join(root, 'devin', 'config.json'), JSON.stringify({ devin: { org_id: 'org-abcdef123456' } }))

    const sessions = new Map()
    const calls = []
    const atts = new Map()
    const j = (status, o) => new Response(JSON.stringify(o), { status })
    const fetch = async (url, init = {}) => {
      const u = new URL(url)
      const method = init.method ?? 'GET'
      calls.push({ method, host: u.host, path: u.pathname, body: init.body })
      if (u.host === 'mcp.devin.ai') {
        const b = JSON.parse(init.body)
        if (b.method === 'initialize') return j(200, { jsonrpc: '2.0', id: b.id, result: {} })
        if (b.method.startsWith('notifications/')) return new Response(null, { status: 202 })
        // chỉ action "sleep" cho máy ngủ; "message" là ping giữ thức (không được làm máy ngủ)
        if (b.params.arguments.action === 'sleep') sessions.get(b.params.arguments.session_id).sleepIn = 1
        return j(200, { jsonrpc: '2.0', id: b.id, result: { content: [] } })
      }
      const rest = u.pathname.replace(/^\/v3\/organizations\/[^/]+/, '')
      if (method === 'POST' && rest === '/sessions') { sessions.set('devin-mac1abcdef', { status: 'running', body: JSON.parse(init.body) }); return j(200, { session_id: 'mac1abcdef' }) }
      const sm = /^\/sessions\/([^/]+)$/.exec(rest)
      if (sm) { const s = sessions.get(sm[1]); if (s?.sleepIn && --s.sleepIn === 0) s.status = 'suspended'; return s ? j(200, { status: s.status }) : j(404, {}) }
      if (method === 'POST' && rest === '/attachments') { const f = init.body.get('file'); atts.set('att1abcdef', Buffer.from(await f.arrayBuffer())); return j(200, { attachment_id: 'att1abcdef', name: f.name }) }
      if (/^\/attachments\//.test(rest)) return new Response(null, { status: 307, headers: { location: SIGNED } })
      return j(404, {})
    }
    const ssh = []
    const spawn = async (cmd, args, o = {}) => {
      if (cmd === 'git') return runProc(cmd, args, o)
      assert.equal(o.input, undefined, 'không gửi qua stdin')
      const [, id, command] = args
      const b = /printf %s '([A-Za-z0-9+/=]*)'/.exec(command)
      const script = b ? Buffer.from(b[1], 'base64').toString('utf8') : command
      ssh.push({ id, command, script })
      if (/devinvm-ready/.test(command)) return { code: 0, stdout: 'devinvm-ready\n', stderr: '' }
      if (script.includes('SHASUMS256')) return { code: 0, stdout: '@@DEVINVM@@ node v24.9.0\n', stderr: '' }
      return { code: 0, stdout: OUT(TAP_GREEN), stderr: '' }
    }
    let t = 0
    const logFile = path.join(root, 'devin-vm.log')
    const ctx = makeCtx({
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|^DEVIN|^FLOW_STATE_DIR$/i.test(k))), DEVIN_CREDENTIALS: path.join(root, 'devin', 'credentials.toml') },
      home: root, stateDir: path.join(root, 'state'), logFile, devinBin: 'DEVIN', fetch, spawn, sleep: async (ms) => { t += ms }, now: () => (t += 1000),
    })
    const buf = []
    const o = { write: (s) => buf.push(s), text: () => buf.join('') }
    const code = await main([], { repo, ctx, stdout: o })
    assert.equal(code, 0, o.text())
    assert.match(o.text(), /Mac \(Devin macOS, node v24\.18\.0\): 2 bài · 2 đạt · 0 hỏng — xanh/)
    // máy macOS tạo bằng SWE-2, không nối kho
    const body = sessions.get('devin-mac1abcdef').body
    assert.deepEqual([body.platform, body.devin_mode, 'repos' in body], ['macos', 'swe-2-medium', false])
    // bundle thật: chứa đúng HEAD
    const bf = path.join(root, 'up.bundle')
    fs.writeFileSync(bf, atts.get('att1abcdef'))
    assert.match(gitIn(repo, 'bundle', 'list-heads', bf), new RegExp(head))
    // script chính nhận đúng link + sha; Node đã được cài lần đầu; máy NGỦ
    const main_ = ssh.find((s) => s.script.includes('node --test'))
    assert.ok(main_.script.includes(`'${SIGNED}'`) && main_.script.includes(head))
    assert.ok(ssh.some((s) => s.script.includes('SHASUMS256')))
    assert.equal(sessions.get('devin-mac1abcdef').status, 'suspended')
    // khoá + link ký sẵn không ra stdout hay log
    const all = `${o.text()}\n${fs.readFileSync(logFile, 'utf8')}`
    assert.ok(!/SIGSECRET|KEYSECRET|s3\.example/.test(all))
    assert.match(fs.readFileSync(logFile, 'utf8'), /\tmac-check\tdevin-mac1abcdef\t\d+\t0\n/)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
