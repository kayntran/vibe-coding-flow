// Test cho registry hai nguồn của skills-check: kit/official.json (chính hãng) + kit/approved-skills.json (nguồn ngoài user duyệt [wj8n]).
// node --test hooks/skills-check.test.mjs — chạy trên HOME giả + dự án tạm, không đọc ~/.claude.json hay skill thật của máy.
// Ba ca bắt buộc: sepay = official · payment-integration = approved · payos = none ("kit chưa có skill"). Thư viện cũ không đổi hành vi.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, loadOfficial, APPROVED_FILE, OFFICIAL_FILE } from './lib/skills-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'skills-check.mjs')
const PIN = /^[0-9a-f]{40}$/
const roots = []
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-check-reg-')))
  roots.push(root)
  const sb = { root, home: path.join(root, 'home'), proj: path.join(root, 'proj') }
  fs.mkdirSync(path.join(sb.proj, '.git'), { recursive: true })
  fs.mkdirSync(sb.home, { recursive: true })
  sb.skill = (name, dir = '.claude') => {
    const d = path.join(sb.proj, dir, 'skills', name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
  }
  sb.rows = (libs, host = 'claude') => Object.fromEntries(check(sb.proj, host, { home: sb.home, env: { PATH: '' }, libs }).map((r) => [r.lib, r]))
  return sb
}

describe('registry: hai file, một danh sách', () => {
  const official = JSON.parse(fs.readFileSync(OFFICIAL_FILE, 'utf8'))
  const approved = JSON.parse(fs.readFileSync(APPROVED_FILE, 'utf8'))
  const strip = (o) => Object.keys(o).filter((k) => !k.startsWith('_'))

  test('SePay chính hãng nằm ở official.json (repo sepayvn/sepay-skills, skill sepay); nguồn ngoài KHÔNG nằm ở official.json', () => {
    assert.equal(official.sepay.skill.repo, 'sepayvn/sepay-skills')
    assert.deepEqual(official.sepay.skill.names, ['sepay'])
    assert.match(official.sepay.skill.installCmd, /^npx skills add sepayvn\/sepay-skills\b/)
    assert.equal(official.sepay.mcp, null)
    for (const k of ['payment-integration', 'payos']) assert.ok(!(k in official), `${k} không được nằm ở official.json`)
  })

  test('approved-skills.json: mỗi mục có sourceOrg + note; mục có skill thì ghim đúng commit 40 ký tự và lệnh cài dùng đúng commit đó; đã soát nội dung', () => {
    for (const k of strip(approved)) {
      assert.ok(approved[k].sourceOrg && approved[k].note, `${k}: thiếu sourceOrg/note`)
      assert.ok(!(k in official), `${k} có ở cả hai file`)
      const s = approved[k].skill
      if (!s) continue
      assert.match(s.commit, PIN, `${k}: commit phải ghim đủ 40 ký tự`)
      assert.ok(s.installCmd.includes(`@${s.commit}`), `${k}: lệnh cài không ghim đúng commit`)
      assert.match(s.repo, /^[\w.-]+\/[\w.-]+$/)
      assert.ok(Array.isArray(s.names) && s.names.length, `${k}.names`)
      assert.match(approved[k].reviewed?.on ?? '', /^\d{4}-\d{2}-\d{2}$/, `${k}: thiếu ngày soát nội dung`)
      assert.ok(approved[k].license, `${k}: thiếu ghi chú giấy phép`)
    }
    assert.equal(approved['payment-integration'].skill.repo, 'mrgoonie/claudekit-skills')
    assert.deepEqual(approved['payment-integration'].skill.names, ['payment-integration'])
  })

  test('loadOfficial() trả cả hai nguồn gắn source; file khác không tự kéo approved; trùng tên giữa hai file là lỗi', () => {
    const all = loadOfficial()
    assert.equal(all.sepay.source, 'official')
    assert.equal(all['payment-integration'].source, 'approved')
    assert.equal(all.supabase.source, 'official')
    assert.deepEqual(Object.keys(all).sort(), [...strip(official), ...strip(approved)].sort())
    assert.deepEqual(Object.keys(loadOfficial(OFFICIAL_FILE, null)).sort(), strip(official).sort())
    const sb = sandbox()
    const a = path.join(sb.root, 'a.json')
    const b = path.join(sb.root, 'b.json')
    fs.writeFileSync(a, JSON.stringify({ x: { sourceOrg: 'x', skill: null, mcp: null, note: 'n' } }))
    fs.writeFileSync(b, JSON.stringify({ x: { sourceOrg: 'y', skill: null, mcp: null, note: 'n' } }))
    assert.deepEqual(Object.keys(loadOfficial(a)), ['x'])
    assert.throws(() => loadOfficial(a, b), /cả official\.json và approved-skills\.json/)
  })
})

describe('ba ca: sepay=official · payment-integration=approved · payos=none', () => {
  test('sepay: chưa cài ⇒ missing + lệnh cài chính hãng; cài vào dự án ⇒ installed, source official', () => {
    const sb = sandbox()
    const before = sb.rows(['sepay']).sepay
    assert.equal(before.status, 'missing')
    assert.equal(before.source, 'official')
    assert.equal(before.installCmd, loadOfficial().sepay.skill.installCmd)
    sb.skill('sepay')
    const after = sb.rows(['sepay']).sepay
    assert.equal(after.status, 'installed')
    assert.equal(after.usable, 'ok')
    assert.equal(after.source, 'official')
    assert.deepEqual(after.found.skills, ['sepay'])
  })

  test('sepay: skill cộng đồng tên giống (sepay-helper) không tính là đã cài ⇒ community-only', () => {
    const sb = sandbox()
    sb.skill('sepay-helper')
    const r = sb.rows(['sepay']).sepay
    assert.equal(r.status, 'community-only')
    assert.ok(r.warnings.some((w) => w.includes('sepay-helper')))
  })

  test('payment-integration: chưa cài ⇒ missing + lệnh cài GHIM commit; cài ⇒ installed, source approved', () => {
    const sb = sandbox()
    const before = sb.rows(['payment-integration'])['payment-integration']
    assert.equal(before.status, 'missing')
    assert.equal(before.source, 'approved')
    assert.equal(before.sourceOrg, 'mrgoonie')
    assert.match(before.installCmd, /^npx skills add mrgoonie\/claudekit-skills@[0-9a-f]{40} --skill payment-integration$/)
    sb.skill('payment-integration')
    const after = sb.rows(['payment-integration'])['payment-integration']
    assert.equal(after.status, 'installed')
    assert.equal(after.usable, 'ok')
    assert.equal(after.source, 'approved')
  })

  test('payment-integration cũng nhận ra ở thư mục skill của Codex (.agents), không nhận ở app không đọc thư mục đó', () => {
    const sb = sandbox()
    sb.skill('payment-integration', '.agents')
    assert.equal(sb.rows(['payment-integration'], 'codex')['payment-integration'].status, 'installed')
    assert.equal(sb.rows(['payment-integration'], 'claude')['payment-integration'].status, 'missing')
  })

  test('payos: none, "kit chưa có skill", không lệnh cài; cài một skill tên payos cũng không đổi thành installed', () => {
    const sb = sandbox()
    sb.skill('payos')
    const r = sb.rows(['payos']).payos
    assert.equal(r.status, 'none')
    assert.equal(r.usable, 'unknown')
    assert.equal(r.installCmd, null)
    assert.match(r.note, /kit chưa có skill/)
    assert.equal(r.source, 'approved')
  })

  test('hai skill cùng cài: mỗi cái đúng nguồn của nó, không lẫn', () => {
    const sb = sandbox()
    sb.skill('sepay')
    sb.skill('payment-integration')
    const by = sb.rows(['sepay', 'payment-integration', 'payos'])
    assert.deepEqual(['sepay', 'payment-integration', 'payos'].map((l) => [by[l].status, by[l].source]), [['installed', 'official'], ['installed', 'approved'], ['none', 'approved']])
  })
})

describe('thư viện cũ không đổi hành vi', () => {
  test('máy trống: thư viện chính hãng cũ vẫn missing + lệnh cài của official.json, source official; Go/Wails vẫn none', () => {
    const sb = sandbox()
    const by = sb.rows(undefined)
    const off = JSON.parse(fs.readFileSync(OFFICIAL_FILE, 'utf8'))
    for (const l of ['cloudflare', 'supabase', 'shadcn', 'stripe', 'playwright', 'vercel', 'neon', 'sentry']) {
      assert.equal(by[l].status, 'missing', l)
      assert.equal(by[l].source, 'official', l)
      assert.equal(by[l].installCmd, off[l].skill.installCmd, l)
    }
    for (const l of ['go', 'wails']) {
      assert.equal(by[l].status, 'none', l)
      assert.equal(by[l].source, 'official', l)
      assert.equal(by[l].installCmd, null, l)
    }
    assert.equal(Object.keys(by).length, Object.keys(loadOfficial()).length, 'mỗi thư viện của hai file đúng một dòng')
  })

  test('skill chính hãng cũ (supabase) cài vào dự án ⇒ installed như trước', () => {
    const sb = sandbox()
    sb.skill('supabase')
    const r = sb.rows(['supabase']).supabase
    assert.equal(r.status, 'installed')
    assert.equal(r.usable, 'ok')
    assert.equal(r.source, 'official')
  })
})

describe('hooks/skills-check.mjs (CLI) thấy cả hai nguồn', () => {
  const run = (sb, args) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['codex_home'].includes(k.toLowerCase())))
    const r = spawnSync(process.execPath, [CLI, '--host', 'claude', '--dir', sb.proj, ...args], { encoding: 'utf8', cwd: sb.root, env: { ...base, HOME: sb.home, USERPROFILE: sb.home } })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }

  test('--lib sepay,payment-integration,payos --json: có source từng dòng, exit 0', () => {
    const sb = sandbox()
    sb.skill('sepay')
    const r = run(sb, ['--lib', 'sepay,payment-integration,payos', '--json'])
    assert.equal(r.code, 0, r.err)
    const rows = JSON.parse(r.out).results
    assert.deepEqual(rows.map((x) => [x.lib, x.status, x.source]), [['sepay', 'installed', 'official'], ['payment-integration', 'missing', 'approved'], ['payos', 'none', 'approved']])
  })

  test('bản chữ: payment-integration thiếu ⇒ in lệnh cài ghim commit; payos ⇒ none kèm "kit chưa có skill"', () => {
    const sb = sandbox()
    const r = run(sb, ['--lib', 'payment-integration,payos'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /payment-integration\s+missing/)
    assert.match(r.out, /npx skills add mrgoonie\/claudekit-skills@[0-9a-f]{40} --skill payment-integration/)
    assert.match(r.out, /payos\s+none/)
    assert.match(r.out, /kit chưa có skill/)
  })
})
