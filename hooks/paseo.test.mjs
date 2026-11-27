import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexProvider, codexProviders, inPaseo, pick, providerId } from './paseo.mjs'
import { parseDroidHelp } from './lib/models.mjs'

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

test('pick Codex thiếu hạng mạnh (máy chỉ có gpt-6-luna) ⇒ hạ hạng trong Codex + lời báo; KHÔNG BAO GIỜ nhận id của Factory (provider "codex/<id>" chỉ chạy được Codex)', () => {
  const w = world()
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'fixtures', 'models')
  fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(w.home, '.codex', 'models_cache.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(fixtures, 'codex.json'), 'utf8')), fetched_at: new Date().toISOString() }))
  // Factory có gpt-6-sol trong cache: nếu pick lỡ bật allowFallbackHost thì id này sẽ lọt ra.
  fs.mkdirSync(path.join(w.home, '.claude', 'cache'), { recursive: true })
  const droid = parseDroidHelp(fs.readFileSync(path.join(fixtures, 'droid-help.txt'), 'utf8'))
  fs.writeFileSync(path.join(w.home, '.claude', 'cache', 'models.json'), JSON.stringify({ hosts: { droid: { fetchedAt: Date.now(), entries: droid } } }))
  for (const platform of ['darwin', 'win32']) {
    const r = pick('code-reviewer', { home: w.home, env: {}, platform })
    assert.ok(!/gpt-6-sol|droid|latest/.test(JSON.stringify(r)), `${platform}: ${JSON.stringify(r)}`)
    if (platform === 'darwin') assert.match(r.provider, /^codex\/gpt-6-luna$/)
    assert.ok(r.warnings.some((w) => /hạng mạnh/.test(w) && /gpt-6-luna/.test(w)), `${platform}: ${r.warnings}`)
  }
})

test('pick Codex 2 tài khoản (danh sách model khác nhau): provider nào thì model của tài khoản đó — codex ⇒ luna của tk 1, tk 1 hết lượt ⇒ codex-b ⇒ gpt-6.2-sol của tk 2; không bao giờ chéo', () => {
  const w = world()
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'fixtures', 'models')
  for (const [dir, file] of [['.codex', 'codex.json'], ['.codex-2', 'codex-2.json']]) {
    fs.mkdirSync(path.join(w.home, dir), { recursive: true })
    fs.writeFileSync(path.join(w.home, dir, 'auth.json'), '{}')
    fs.writeFileSync(path.join(w.home, dir, 'models_cache.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8')), fetched_at: new Date().toISOString() }))
  }
  const one = pick('code-reviewer', { home: w.home, env: {}, platform: 'darwin' })
  assert.equal(one.provider, 'codex/gpt-6-luna')
  assert.ok(one.warnings.some((x) => /Tài khoản Codex 2 có gpt-6\.2-sol/.test(x)), String(one.warnings))
  const state = path.join(w.home, '.claude', 'cache', 'codex-het-luot.json')
  fs.mkdirSync(path.dirname(state), { recursive: true })
  const k = path.join(w.home, '.codex')
  fs.writeFileSync(state, JSON.stringify({ [k]: { until: Date.now() + 3600000 }, [k.toLowerCase()]: { until: Date.now() + 3600000 } }))
  const two = pick('code-reviewer', { home: w.home, env: {}, platform: 'darwin' })
  assert.equal(two.provider, 'codex-b/gpt-6.2-sol')
  assert.equal(two.account, '2')
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
