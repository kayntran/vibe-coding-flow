// Test cho lib/rule-change.mjs: node --test ~/.claude/hooks/lib/rule-change.test.mjs
// eslintLoosening chấm hai bản chữ của eslint.config.*; looseRuleChanges đọc file qua read/list giả (không cần git).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from './arch.mjs'
import { eslintLoosening, looseRuleChanges } from './rule-change.mjs'

const roots = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

// eslint.config.js mẫu (kiểu typescript-eslint + defineConfig); `extra` chèn thành phần tử cuối của mảng.
const CFG = (extra = '', head = '') => [
  "import js from '@eslint/js'", head, "import globals from 'globals'", "import { defineConfig, globalIgnores } from 'eslint/config'", '',
  'export default defineConfig([', "  globalIgnores(['dist']),", '  js.configs.recommended,', '  {', "    files: ['**/*.ts'],", '    rules: {',
  "      'no-console': 'error',", "      complexity: ['error', 10],", '    },', '  },', extra, '])', '',
].filter((l) => l !== null).join('\n')
const ok = (before, after) => assert.equal(eslintLoosening(before, after), null, `đáng lẽ là siết:\n${after}`)
const bad = (before, after, re) => { const r = eslintLoosening(before, after); assert.ok(r, `đáng lẽ bị tính là nới:\n${after}`); assert.match(`dòng ${r.line}: ${r.why}`, re); return r }

describe('eslintLoosening — chỉ cho qua khi CHẮC là siết', () => {
  test('không đổi gì / chỉ đổi chú thích, khoảng trắng ⇒ siết (null)', () => {
    ok(CFG(), CFG())
    ok(CFG(), CFG().replace("  js.configs.recommended,", '  // ghi chú mới\n  js.configs.recommended,   /* thêm */'))
  })
  test('thêm import gói + khối mới chỉ có luật mức error (files, ignores, plugins, name) ⇒ siết', () => {
    const block = "  {\n    name: 'shadcn',\n    files: ['src/**/*.tsx'],\n    ignores: ['src/**/*.test.tsx'],\n    plugins: { shadcn, x: other.plugin },\n    rules: {\n      'shadcn/no-raw-colors': 'error',\n      eqeqeq: 2,\n      'no-var': ['error'],\n    },\n  },"
    ok(CFG(), CFG(block, "import { plugin as shadcn } from '@shadcn/lint'\nimport other from 'eslint-plugin-other';"))
  })
  test('khối mới chèn giữa các khối có sẵn (dòng "}," / "{" giống nhau ở biên) vẫn nhận ra', () => {
    const before = CFG()
    const after = before.replace("  js.configs.recommended,\n", "  js.configs.recommended,\n  {\n    rules: { 'no-debugger': 'error' },\n  },\n")
    ok(before, after)
    const mid = CFG("  {\n    files: ['a/**'],\n    rules: { 'no-alert': 'error' },\n  },")
    ok(mid, mid.replace("  {\n    files: ['a/**'],", "  {\n    files: ['b/**'],\n    rules: { 'no-eval': 'error' },\n  },\n  {\n    files: ['a/**'],"))
  })
  test('thêm luật mức error vào khối rules có sẵn ⇒ siết; thêm vào cuối khi dòng trước chưa có dấu phẩy ⇒ siết', () => {
    ok(CFG(), CFG().replace("      'no-console': 'error',", "      'no-console': 'error',\n      'no-debugger': 'error',"))
    const noComma = CFG().replace("      complexity: ['error', 10],", "      complexity: ['error', 10]")
    ok(noComma, noComma.replace("      complexity: ['error', 10]", "      complexity: ['error', 10],\n      'no-eval': 'error'"))
    ok(CFG('  { rules: { a: 1 } }'), CFG("  { rules: { a: 1 } },\n  { rules: { 'no-eval': 'error' } }"))
  })
  test('đổi luật từ off sang error tại chỗ ⇒ siết', () => {
    const off = CFG().replace("      'no-console': 'error',", "      'no-console': 'off',")
    ok(off, CFG())
  })
  test('gỡ khối miễn (tắt luật, languageOptions sourceType/globals, ignores) và gỡ dòng tắt luật ⇒ siết', () => {
    const exempt = "  {\n    files: ['**/*.cjs'],\n    languageOptions: { sourceType: 'commonjs', globals: globals.node },\n    rules: { '@typescript-eslint/no-require-imports': 'off' },\n  },"
    ok(CFG(exempt), CFG())
    ok(CFG("  { ignores: ['.dependency-cruiser.cjs'] },"), CFG())
    ok(CFG("  globalIgnores(['legacy/**']),"), CFG())
    ok(CFG().replace("      'no-console': 'error',", "      'no-console': 'error',\n      'no-alert': 'off',\n      eqeqeq: [0, 'smart'],"), CFG())
  })
  test('thêm khối miễn ⇒ nới, nêu dòng và lý do đời thường (tắt luật / languageOptions)', () => {
    const exempt = "  {\n    files: ['**/*.cjs'],\n    languageOptions: { sourceType: 'commonjs', globals: globals.node },\n    rules: { '@typescript-eslint/no-require-imports': 'off' },\n  },"
    const r = bad(CFG(), CFG(exempt), /tắt luật/)
    assert.equal(r.line, 16)
    assert.match(r.why, /languageOptions/)
  })
  test('mức warn, kèm tuỳ chọn, ghi đè luật đã có trong cùng khối, khối chỉ có ignores, globalIgnores mới ⇒ nới', () => {
    const add = (line) => CFG().replace("      'no-console': 'error',", `      'no-console': 'error',\n${line}`)
    bad(CFG(), add("      'no-alert': 'warn',"), /mức "error"/)
    bad(CFG(), add("      'max-depth': ['error', 4],"), /mức "error"/)
    bad(CFG(), add("      complexity: 'error',"), /đã có trong cùng khối/)
    bad(CFG(), CFG("  { ignores: ['src/legacy/**'] },"), /bỏ qua file/)
    bad(CFG(), CFG().replace("  globalIgnores(['dist']),", "  globalIgnores(['dist']),\n  globalIgnores(['src/**']),"), /bỏ qua file/)
    bad(CFG(), CFG("  { files: ['**/*.ts'], linterOptions: { reportUnusedDisableDirectives: 'off' } },"), /linterOptions/)
  })
  test('khối mới có thứ khó đoán (spread, languageOptions, settings, extends) hoặc import kiểu lạ ⇒ nới', () => {
    bad(CFG(), CFG('  ...tseslint.configs.strict,'), /không chắc/)
    bad(CFG(), CFG("  { files: ['x'], settings: { a: 1 } },"), /settings/)
    bad(CFG(), CFG("  { extends: [js.configs.all] },"), /extends/)
    bad(CFG(), CFG('', "import loose from './loose.js'"), /import/)
    bad(CFG(), CFG('', "import './side-effect.js'"), /import/)
    bad(CFG(), CFG('', "const x = require('y')"), /không chắc/)
  })
  test('xoá/sửa dòng có sẵn đang siết luật ⇒ nới: bỏ luật error, hạ error xuống off, đổi files, bỏ preset, comment cả khối', () => {
    bad(CFG(), CFG().replace("      'no-console': 'error',\n", ''), /gỡ luật "no-console"/)
    bad(CFG(), CFG().replace("      'no-console': 'error',", "      'no-console': 'off',"), /tắt luật/)
    bad(CFG(), CFG().replace("    files: ['**/*.ts'],", "    files: ['src/**/*.ts'],"), /dòng 10: .*không chắc/)
    bad(CFG(), CFG().replace('  js.configs.recommended,\n', ''), /bỏ|gỡ/)
    bad(CFG(), CFG().replace("      'no-console': 'error',", "      /* 'no-console': 'error', */"), /gỡ luật "no-console"/)
    bad(CFG(), CFG().replace("  globalIgnores(['dist']),", "  globalIgnores(['dist', 'src']),"), /bỏ|gỡ/)
  })
  test('file không đọc chắc được (regex, chuỗi ${}) ⇒ nới', () => {
    bad(CFG(), CFG("  { files: [/x/], rules: { a: 'error' } },"), /không đọc/)
    bad(CFG(), CFG("  { files: [`${dir}/x`] },"), /không đọc/)
  })
  test('thêm luật/plugin vào khối có "..." hoặc trùng tên plugin ⇒ nới (có thể ghi đè tuỳ chọn/plugin đang có)', () => {
    const spread = CFG().replace('    rules: {\n', '    rules: {\n      ...strictRules,\n')
    bad(spread, spread.replace("      'no-console': 'error',", "      'no-console': 'error',\n      'max-depth': 'error',"), /\.\.\./)
    const plugins = CFG().replace("    files: ['**/*.ts'],", "    files: ['**/*.ts'],\n    plugins: {\n      react,\n      x: other.plugin,\n    },")
    bad(plugins, plugins.replace('      x: other.plugin,\n', '      x: other.plugin,\n      react: fake,\n'), /plugin "react"/)
    ok(plugins, plugins.replace('      x: other.plugin,\n', '      x: other.plugin,\n      y: more,\n'))
    const spreadPlugins = plugins.replace('      react,\n', '      react,\n      ...base,\n')
    bad(spreadPlugins, spreadPlugins.replace('      x: other.plugin,\n', '      x: other.plugin,\n      y: more,\n'), /\.\.\./)
  })
  test('gỡ import: chỉ khi là gói và tên không còn dùng; đổi nguồn import giữ tên ⇒ nới', () => {
    const exempt = "  {\n    files: ['**/*.cjs'],\n    languageOptions: { sourceType: 'commonjs', globals: globals.node },\n    rules: { '@typescript-eslint/no-require-imports': 'off' },\n  },"
    ok(CFG(exempt), CFG().replace("import globals from 'globals'\n", ''))
    bad(CFG().replace("import js from '@eslint/js'", "import js from './strict-config.mjs'"), CFG(), /import/)
    bad(CFG(), CFG().replace("import js from '@eslint/js'\n", ''), /import/)
  })
  test('gỡ globalIgnores / khối ignores có mẫu "!" (đưa file trở lại vòng kiểm) ⇒ nới', () => {
    const neg = CFG().replace("  globalIgnores(['dist']),", "  globalIgnores(['dist']),\n  globalIgnores(['!node_modules/', 'node_modules/*', '!node_modules/mylib/']),")
    bad(neg, CFG(), /"!"/)
    bad(CFG("  { ignores: ['!dist/keep.js'] },"), CFG(), /"!"/)
  })
})

// --- looseRuleChanges: file luật đổi trên nhánh → file nào bị tính là nới ---------------------------------------------------------------

const ARCH = (modules) => `${JSON.stringify({ version: 1, parts: [{ name: 'web', stack: 'web', root: 'src', modules, shared: ['src/shared'], forbidden: [] }] }, null, 2)}\n`
const MODS = [{ name: 'shared', path: 'src/shared', mayDependOn: [] }, { name: 'features/a', path: 'src/features/a', mayDependOn: ['shared'] }]
const MODS2 = [...MODS, { name: 'features/b', path: 'src/features/b', mayDependOn: ['shared'] }]
const GO_ARCH = `${JSON.stringify({ version: 1, parts: [{ name: 'go', stack: 'go', root: 'internal', modules: [{ name: 'billing', path: 'internal/billing', mayDependOn: [] }, { name: 'orders', path: 'internal/orders', mayDependOn: ['billing'] }] }] }, null, 2)}\n`
const gen = (files) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rule-change-test-')))
  roots.push(d)
  for (const [rel, text] of Object.entries(files)) { const f = path.join(d, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const r = A.genFiles(d)
  return { ...Object.fromEntries(r.files.map((f) => [f.rel, f.text])), legacy: Object.fromEntries(r.legacy.map((f) => [f.rel, f.text])) }
}
// Hai phía của nhánh: { base: { rel: chữ }, head: { rel: chữ } } → read/list như git show / git ls-tree
const sides = (base, head) => ({
  read: (side, rel) => (side === 'base' ? base : head)[rel] ?? null,
  list: (side, roots) => Object.keys(side === 'base' ? base : head).filter((f) => roots.some((r) => f.startsWith(`${r}/`))),
})
const judge = (base, head, changes) => looseRuleChanges({ changes, ...sides(base, head) })

describe('looseRuleChanges', () => {
  test('docs/arch.json thêm module + .dependency-cruiser.mjs sinh lại khớp ⇒ không file nào bị tính là nới', () => {
    const head = { 'docs/arch.json': ARCH(MODS2), 'tsconfig.json': '{}' }
    const g = gen(head)
    head['.dependency-cruiser.mjs'] = g['.dependency-cruiser.mjs']
    const r = judge({ 'docs/arch.json': ARCH(MODS), 'tsconfig.json': '{}' }, head, [{ st: 'M', file: 'docs/arch.json' }, { st: 'A', file: '.dependency-cruiser.mjs' }])
    assert.deepEqual([...r], [])
  })
  test('file sinh: thiếu tsconfig ở nhánh nên bản sinh lại khác ⇒ nới (so đúng cây của nhánh, không phải thư mục đang mở)', () => {
    const g = gen({ 'docs/arch.json': ARCH(MODS2), 'tsconfig.json': '{}' })
    const r = judge({}, { 'docs/arch.json': ARCH(MODS2), '.dependency-cruiser.mjs': g['.dependency-cruiser.mjs'] }, [{ st: 'A', file: '.dependency-cruiser.mjs' }])
    assert.match(r.get('.dependency-cruiser.mjs'), /khác bản kit sinh lại/)
  })
  test('file sinh không có dòng "Sinh bởi" (viết tay) ⇒ nới như file luật thường; arch.json của nhánh hỏng ⇒ nới', () => {
    const hand = judge({}, { 'docs/arch.json': ARCH(MODS), '.dependency-cruiser.mjs': 'export default { forbidden: [] }\n' }, [{ st: 'A', file: '.dependency-cruiser.mjs' }])
    assert.equal(hand.get('.dependency-cruiser.mjs'), '')
    const g = gen({ 'docs/arch.json': ARCH(MODS) })
    const broken = judge({ '.dependency-cruiser.mjs': g['.dependency-cruiser.mjs'] }, { 'docs/arch.json': '{', '.dependency-cruiser.mjs': g['.dependency-cruiser.mjs'] }, [{ st: 'M', file: '.dependency-cruiser.mjs' }])
    assert.match(broken.get('.dependency-cruiser.mjs'), /docs\/arch\.json/)
  })
  test('Go: .go-arch-lint.yml / .golangci.yml sinh lại theo thư mục Go của nhánh; thêm thư mục mà không gen lại ⇒ lệch ⇒ nới', () => {
    const tree = { 'docs/arch.json': GO_ARCH, 'go.mod': 'module example.com/app\n', 'internal/billing/b.go': 'package billing\n', 'internal/orders/svc/s.go': 'package svc\n', 'internal/orders/svc/s_test.go': 'package svc\n' }
    const g = gen(tree)
    const head = { ...tree, '.go-arch-lint.yml': g['.go-arch-lint.yml'], '.golangci.yml': g['.golangci.yml'] }
    const changes = [{ st: 'A', file: '.go-arch-lint.yml' }, { st: 'A', file: '.golangci.yml' }]
    assert.deepEqual([...judge({}, head, changes)], [])
    const moved = judge({}, { ...head, 'internal/orders/api/a.go': 'package api\n' }, changes)
    assert.match(moved.get('.go-arch-lint.yml'), /khác bản kit sinh lại/)
    assert.equal(moved.has('.golangci.yml'), false)
  })
  test('bản kit sinh thay/che file viết tay (.cjs viết tay, .golangci.yml/.yaml viết tay) ⇒ nới', () => {
    const tree = { 'docs/arch.json': ARCH(MODS), 'tsconfig.json': '{}' }
    const g = gen(tree)
    const hand = "module.exports = { forbidden: [{ name: 'them', from: {}, to: {} }] }\n"
    const shadow = judge({ ...tree, '.dependency-cruiser.cjs': hand }, { ...tree, '.dependency-cruiser.cjs': hand, '.dependency-cruiser.mjs': g['.dependency-cruiser.mjs'] }, [{ st: 'A', file: '.dependency-cruiser.mjs' }])
    assert.match(shadow.get('.dependency-cruiser.mjs'), /che mất \.dependency-cruiser\.cjs/)
    const go = { 'docs/arch.json': GO_ARCH, 'go.mod': 'module example.com/app\n', 'internal/billing/b.go': 'package billing\n', 'internal/orders/o.go': 'package orders\n' }
    const gg = gen(go)
    const handGo = 'linters:\n  enable: [gosec]\n'
    const replaced = judge({ ...go, '.golangci.yml': handGo }, { ...go, '.golangci.yml': gg['.golangci.yml'] }, [{ st: 'M', file: '.golangci.yml' }])
    assert.match(replaced.get('.golangci.yml'), /viết tay/)
    const yaml = judge({ ...go, '.golangci.yaml': handGo }, { ...go, '.golangci.yaml': handGo, '.golangci.yml': gg['.golangci.yml'] }, [{ st: 'A', file: '.golangci.yml' }])
    assert.match(yaml.get('.golangci.yml'), /che mất \.golangci\.yaml/)
  })
  test('đường dẫn lạ trong cây của nhánh (dấu \\, ..) ⇒ nới và không ghi ra ngoài thư mục tạm', () => {
    const escape = `rc-escape-${process.pid}-${Date.now()}`
    roots.push(path.join(os.tmpdir(), escape)) // bản lỗi ghi ra đây: dọn sau bài
    const go = { 'docs/arch.json': GO_ARCH, 'go.mod': 'module example.com/app\n', 'internal/billing/b.go': 'package billing\n', [`internal/..\\..\\${escape}/p.go`]: 'package p\n' }
    const r = judge({}, { ...go, '.go-arch-lint.yml': `# ${A.GEN_MARK}\n` }, [{ st: 'A', file: '.go-arch-lint.yml' }])
    assert.match(r.get('.go-arch-lint.yml'), /đường dẫn lạ/)
    assert.equal(fs.existsSync(path.join(os.tmpdir(), escape)), false, 'đã ghi ra ngoài thư mục tạm')
  })
  test('.claude/ui.json: thêm màn/trạng thái, bớt nút miễn chữ ⇒ siết; thêm miễn, bỏ màn/trạng thái, đổi start/url/khoá lạ, hỏng, thêm mới, xoá ⇒ nới', () => {
    const UI = (o = {}) => `${JSON.stringify({ start: 'pnpm dev --port {PORT}', url: 'http://localhost:{PORT}', routes: ['/'], states: [{ route: '/', s: 'S-01' }], ...o }, null, 2)}\n`
    const ui = (before, after, st = 'M') => judge({ '.claude/ui.json': before }, { '.claude/ui.json': after }, [{ st, file: '.claude/ui.json' }]).get('.claude/ui.json') ?? null
    const more = { routes: ['/', '/guests'], states: [{ route: '/', s: 'S-01' }, { route: '/guests', s: 'S-30' }, { route: '/guests', setup: '?s=S-31', s: 'S-31' }] }
    assert.equal(ui(UI(), UI(more)), null)
    assert.equal(ui(UI({ whitelistIcons: ['Chia sẻ', 'Lọc'] }), UI({ whitelistIcons: ['chia se'] })), null)
    assert.match(ui(UI(), UI({ ...more, whitelistIcons: ['Đóng'] })), /"Đóng"/)
    assert.match(ui(UI(more), UI()), /\/guests/)
    assert.match(ui(UI(more), UI({ ...more, states: more.states.slice(0, 2) })), /S-31/)
    assert.match(ui(UI(), UI({ url: 'http://localhost:9999' })), /url/)
    assert.match(ui(UI(), UI({ start: 'npx serve empty' })), /start/)
    assert.match(ui(UI(), UI({ viewports: [390] })), /viewports/)
    assert.match(ui(UI(), '{'), /không đọc/)
    // bản mới sai dạng ⇒ máy kiểm giao diện thoát mã 2, không kiểm màn nào (review Grok)
    for (const bad of [{ routes: ['/', 'x'] }, { states: [{ route: '/', s: 'S-01' }, { route: '/', s: 'S-01', setup: 'x' }] }, { states: [{ route: '/', s: 'S-01' }, { route: '/x' }] }, { whitelistIcons: null }, { whitelistIcons: [1] }, { routes: 'x' }]) {
      assert.match(ui(UI(), UI(bad)), /sai dạng/, JSON.stringify(bad))
    }
    assert.equal(ui(null, UI(), 'A'), '')
    assert.equal(ui(UI(), null, 'D'), '')
  })
  test('baseline, biome, eslint mới, xoá arch.json ⇒ vẫn nới như cũ', () => {
    const r = judge({ 'docs/arch.json': ARCH(MODS) }, { 'docs/arch-baseline.json': '{}', 'biome.json': '{}', 'web/eslint.config.js': 'export default []' }, [
      { st: 'A', file: 'docs/arch-baseline.json' }, { st: 'A', file: 'biome.json' }, { st: 'A', file: 'web/eslint.config.js' }, { st: 'D', file: 'docs/arch.json' },
    ])
    assert.deepEqual([...r.keys()].sort(), ['biome.json', 'docs/arch-baseline.json', 'docs/arch.json', 'web/eslint.config.js'])
  })
})
