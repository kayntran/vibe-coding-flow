// node --test hooks/lib/git-bin.test.mjs — git gọi bằng đường dẫn tuyệt đối đã resolve (không theo tên): Windows tìm chương trình trong thư mục
// làm việc của tiến trình con TRƯỚC PATH, nên `spawnSync('git', …, { cwd: <dự án> })` chạy nhầm git.exe do repo lạ mang theo.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitBin, runGit } from './git-bin.mjs'

const WIN = process.platform === 'win32'
const EXE = WIN ? 'git.exe' : 'git'
const tmps = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'git-bin-')); tmps.push(d); return d }
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const fakeGit = (dir) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, EXE); fs.writeFileSync(f, WIN ? 'MZ' : '#!/bin/sh\necho gia\n'); if (!WIN) fs.chmodSync(f, 0o755); return f }

test('gitBin: trả đường dẫn TUYỆT ĐỐI tới một file git có thật trên PATH', () => {
  const g = gitBin()
  assert.ok(g, 'máy chạy test phải có git')
  assert.ok(path.isAbsolute(g), g)
  assert.ok(fs.statSync(g).isFile())
  assert.match(path.basename(g).toLowerCase(), /^git(\.exe)?$/)
})

test('gitBin: theo thứ tự PATH, bỏ mục tương đối (".", "bin", rỗng); không bao giờ chọn thư mục làm việc hiện tại', () => {
  const a = tmp(); const b = tmp(); const cwdDir = tmp()
  const fa = fakeGit(a); const fb = fakeGit(b); fakeGit(cwdDir)
  const old = process.cwd()
  process.chdir(cwdDir)
  try {
    assert.equal(gitBin({ PATH: [a, b].join(path.delimiter) }), fa)
    assert.equal(gitBin({ PATH: [b, a].join(path.delimiter) }), fb)
    assert.equal(gitBin({ PATH: ['.', '', 'bin', `.${path.sep}x`, b].join(path.delimiter) }), fb, 'mục tương đối bị bỏ qua dù đứng trước')
    assert.equal(gitBin({ PATH: ['.', cwdDir, b].join(path.delimiter), VIBE_FLOW_PATH_ONLY: '1' }), path.join(cwdDir, EXE), 'mục TUYỆT ĐỐI do người dùng đặt vào PATH thì được tin, kể cả khi trùng thư mục đang đứng')
  } finally {
    process.chdir(old)
  }
})

test('gitBin: không có trên PATH ⇒ chỉ rơi về thư mục cài quen (tuyệt đối) hoặc null; không đọc từ thư mục làm việc', () => {
  const empty = tmp()
  const cwdDir = tmp()
  fakeGit(cwdDir)
  const old = process.cwd()
  process.chdir(cwdDir)
  try {
    const g = gitBin({ PATH: empty, VIBE_FLOW_PATH_ONLY: '1' })
    assert.equal(g, null)
  } finally {
    process.chdir(old)
  }
})

test('runGit: chạy git thật (version); cwd chứa git giả KHÔNG bị chạy; không có git ⇒ kết quả lỗi chứ không ném', () => {
  const r = runGit(['--version'], { encoding: 'utf8' })
  assert.equal(r.status, 0, String(r.error ?? r.stderr))
  assert.match(r.stdout, /^git version/)
  const none = runGit(['--version'], { env: { PATH: tmp(), VIBE_FLOW_PATH_ONLY: '1' } })
  assert.equal(none.status, null)
  assert.ok(none.error)
})

// Windows chỉ tìm chương trình trong thư mục làm việc của tiến trình con khi tiến trình cha KHÔNG đặt NoDefaultCurrentDirectoryInExePath
// (máy có đặt biến này thì lỗ hổng không tái hiện được) ⇒ chạy phép thử trong một tiến trình con đã bỏ biến đó khỏi môi trường.
test('runGit: thư mục làm việc chứa git giả (bản sao node.exe trên Windows / script trên posix) ⇒ vẫn chạy git thật, kể cả khi hệ điều hành cho tìm trong thư mục hiện tại', () => {
  const proj = tmp()
  const fake = path.join(proj, EXE)
  if (WIN) fs.copyFileSync(process.execPath, fake)
  else { fs.writeFileSync(fake, '#!/bin/sh\necho GIT-GIA\n'); fs.chmodSync(fake, 0o755) }
  const probe = path.join(tmp(), 'probe.mjs')
  fs.writeFileSync(probe, `import { runGit } from ${JSON.stringify(new URL('./git-bin.mjs', import.meta.url).href)}\nconst r = runGit(['--version'], { cwd: process.argv[2], encoding: 'utf8' })\nprocess.stdout.write(String(r.stdout))\n`)
  const out = spawnSync(process.execPath, [probe, proj], { encoding: 'utf8', env: { ...process.env, NoDefaultCurrentDirectoryInExePath: undefined, PATH: process.env.PATH } })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^git version/, `phải là git thật, không phải bản giả trong thư mục dự án: ${out.stdout}`)
})
