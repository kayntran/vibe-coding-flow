import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexProvider, codexProviders, inPaseo, pick, providerId } from './paseo.mjs'

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-'))
  fs.mkdirSync(path.join(home, '.paseo'))
  fs.writeFileSync(path.join(home, '.paseo', 'config.json'), JSON.stringify({
    agents: { providers: {
      claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } },
      'codex-b': { extends: 'codex', label: 'Codex B', env: { CODEX_HOME: path.join(home, '.codex-2') } },
      'codex-tat': { extends: 'codex', enabled: false, env: { CODEX_HOME: path.join(home, '.codex-3') } },
    } },
  }))
  return { home, state: path.join(home, 'state.json') }
}

test('inPaseo theo PASEO_AGENT_ID', () => {
  assert.equal(inPaseo({ PASEO_AGENT_ID: 'a' }), true)
  assert.equal(inPaseo({}), false)
})

test('codexProviders: "codex" là ~/.codex, mục extends codex có CODEX_HOME là tài khoản khác, mục tắt bị bỏ', () => {
  const w = world()
  assert.deepEqual(codexProviders({ home: w.home, env: {} }), [
    { id: 'codex', home: path.join(w.home, '.codex') },
    { id: 'codex-b', home: path.join(w.home, '.codex-2') },
  ])
})

test('codexProvider: tài khoản 1 đang hết lượt ⇒ chọn provider của tài khoản 2; qua giờ ⇒ lại tài khoản 1', () => {
  const w = world()
  fs.writeFileSync(w.state, JSON.stringify({ [path.join(w.home, '.codex').toUpperCase()]: { until: 5000 } }))
  assert.deepEqual(codexProvider({ home: w.home, env: {}, file: w.state, now: 1000 }), { id: 'codex-b', account: '2' })
  assert.deepEqual(codexProvider({ home: w.home, env: {}, file: w.state, now: 9000 }), { id: 'codex', account: '1' })
})

test('codexProviders: provider codex bị tắt thì bỏ; CODEX_HOME dạng ~ được mở rộng; tương đối thì bỏ; không còn gì ⇒ báo lỗi rõ', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-'))
  fs.mkdirSync(path.join(home, '.paseo'))
  const cfg = (providers) => fs.writeFileSync(path.join(home, '.paseo', 'config.json'), JSON.stringify({ agents: { providers } }))
  cfg({ codex: { enabled: false }, 'codex-b': { extends: 'codex', env: { CODEX_HOME: '~/.codex-2' } }, 'codex-c': { extends: 'codex', env: { CODEX_HOME: 'rel/dir' } } })
  assert.deepEqual(codexProviders({ home, env: {} }), [{ id: 'codex-b', home: path.join(home, '.codex-2') }])
  cfg({ codex: { enabled: false } })
  assert.throws(() => codexProvider({ home, env: {}, file: path.join(home, 's.json') }), /không có provider Codex/)
})

test('providerId bỏ phần model: "codex-b/gpt-x" ⇒ "codex-b" (đúng chuỗi pick in ra dùng cho het-luot)', () => {
  assert.equal(providerId('codex-b/gpt-x'), 'codex-b')
  assert.equal(providerId('codex'), 'codex')
})

test('pick Codex trên Windows ⇒ viaPaseo:false (chạy ngầm qua CLI, chốt 8338); máy khác ⇒ phiên Paseo', () => {
  const w = world()
  assert.equal(pick('code-reviewer', { home: w.home, env: {}, platform: 'win32' }).viaPaseo, false)
  assert.equal(pick('code-reviewer', { home: w.home, env: {}, platform: 'darwin' }).viaPaseo, true)
  assert.equal(pick('coder', { home: w.home, env: {}, platform: 'win32' }).viaPaseo, true, 'Claude vẫn chạy thành phiên Paseo')
})

test('pick: vai soát mặc định Codex (provider đủ dạng id/model), vai viết code mặc định Claude (tên dòng), vai lạ báo lỗi', () => {
  const w = world()
  const rev = pick('code-reviewer', { home: w.home, env: {}, platform: 'linux' })
  assert.match(rev.provider, /^codex(\/|$)/)
  assert.equal(rev.modeId, 'auto')
  const coder = pick('coder', { home: w.home, env: {} })
  assert.equal(coder.provider, 'claude')
  assert.equal(coder.modelLine, 'sonnet')
  assert.ok(coder.agentFile.endsWith(path.join('agents', 'coder.md')))
  assert.throws(() => pick('khong-co', { home: w.home, env: {} }), /không có vai/)
})
