// Test cho lib/rule-files.mjs: node --test ~/.claude/hooks/lib/rule-files.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRuleFile as archIsRuleFile } from './arch.mjs'
import { EXTRA_RULE_PATHS, GATE_CONFIG, KIT_RULES, isRuleFile } from './rule-files.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

describe('danh sách đang có ở cổng gộp', () => {
  const OLD = [
    'docs/arch.json', 'docs/arch-baseline.json',
    '.dependency-cruiser.cjs', '.dependency-cruiser.json', 'frontend/.dependency-cruiser.js',
    '.go-arch-lint.yml', 'backend/.go-arch-lint.yaml', '.golangci.yml', '.golangci.toml',
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', 'packages/web/eslint.config.cjs',
    '.eslintrc', '.eslintrc.json', '.eslintrc.cjs', 'eslint-suppressions.json',
    'biome.json', 'biome.jsonc', 'apps/x/biome.json', 'sgconfig.yml', 'sgconfig.yaml',
    'kit/rules/sast/ai-sql-string-concat.yml', 'kit/rules/fixtures/a.js',
    'kit/checkers.json', '.claude/flow.json',
  ]
  for (const f of OLD) test(`file luật: ${f}`, () => assert.equal(isRuleFile(f), true))

  test('thứ không phải file luật', () => {
    for (const f of ['src/app.ts', 'README.md', 'docs/other.json', 'docs/arch.md', 'package.json', 'kit/rules', 'kit/checkers.json.bak', 'kit/hooks/x.mjs',
      '.claude/flow.json.bak', 'sub/.claude/flow.json', '.golangci', 'eslint.config', 'src/eslint.config.js.map', '']) {
      assert.equal(isRuleFile(f), false, f)
    }
  })

  test('khớp với isRuleFile của lib/arch.mjs cho phần luật kiến trúc/lint', () => {
    for (const f of ['docs/arch.json', 'a/b/biome.json', 'src/app.ts', 'docs/other.json', '.eslintrc.yml']) {
      assert.equal(isRuleFile(f), archIsRuleFile(f) || KIT_RULES.test(f) || GATE_CONFIG.test(f), f)
    }
  })
})

describe('thêm ở đợt 3', () => {
  test('.claude/ui.json · docs/ui-baseline.json · .claude/luu.json', () => {
    assert.deepEqual(EXTRA_RULE_PATHS, ['.claude/ui.json', 'docs/ui-baseline.json', '.claude/luu.json'])
    for (const f of EXTRA_RULE_PATHS) assert.equal(isRuleFile(f), true, f)
  })
  test('chỉ đúng đường dẫn, không file cùng tên ở chỗ khác', () => {
    for (const f of ['ui.json', 'sub/.claude/ui.json', 'docs/ui-baseline.json.bak', 'docs/ui-baseline.md', '.claude/luu.json5', '.claude/ui.jsonl']) assert.equal(isRuleFile(f), false, f)
  })
})

describe('chuẩn hoá đường dẫn', () => {
  test('dấu \\ kiểu Windows, ./ đầu, / cuối', () => {
    assert.equal(isRuleFile('kit\\rules\\sast\\a.yml'), true)
    assert.equal(isRuleFile('.\\.claude\\ui.json'), true)
    assert.equal(isRuleFile('./docs/arch.json'), true)
    assert.equal(isRuleFile('./.\\docs/ui-baseline.json'), true)
    assert.equal(isRuleFile('/docs/arch.json'), false) // đường dẫn tuyệt đối không phải đường dẫn trong repo
    assert.equal(isRuleFile('src\\app.ts'), false)
  })
  test('không phải chuỗi / rỗng ⇒ false, không ném', () => {
    for (const v of [undefined, null, '', '.', './']) assert.equal(isRuleFile(v), false)
  })
})

describe('archRuleFiles', () => {
  test('hàm thay phần luật kiến trúc; phần kit/ui/luu vẫn luôn tính', () => {
    const none = () => false
    assert.equal(isRuleFile('docs/arch.json', { archRuleFiles: none }), false)
    assert.equal(isRuleFile('eslint.config.js', { archRuleFiles: none }), false)
    assert.equal(isRuleFile('kit/checkers.json', { archRuleFiles: none }), true)
    assert.equal(isRuleFile('.claude/luu.json', { archRuleFiles: none }), true)
    assert.equal(isRuleFile('src/mine.cfg', { archRuleFiles: (rel) => rel === 'src/mine.cfg' }), true)
  })
  test('danh sách (Array/Set) đường dẫn', () => {
    assert.equal(isRuleFile('x/my.rules', { archRuleFiles: ['x/my.rules'] }), true)
    assert.equal(isRuleFile('.\\x\\my.rules', { archRuleFiles: new Set(['./x/my.rules']) }), true)
    assert.equal(isRuleFile('docs/arch.json', { archRuleFiles: [] }), false)
  })
})

// Khi flow-gate.mjs còn giữ bản riêng của hai mẫu này thì chúng phải trùng; đã chuyển sang import lib/rule-files.mjs thì bỏ qua.
describe('đồng bộ với flow-gate.mjs', () => {
  const gate = fs.readFileSync(path.join(HERE, '..', 'flow-gate.mjs'), 'utf8')
  const own = (name) => new RegExp(`^const ${name} = (/.+/)\\s*$`, 'm').exec(gate)?.[1]
  const asRe = (lit) => new RegExp(lit.slice(1, lit.lastIndexOf('/')), lit.slice(lit.lastIndexOf('/') + 1))
  for (const [name, mine] of [['KIT_RULES', KIT_RULES], ['GATE_CONFIG', GATE_CONFIG]]) {
    const lit = own(name)
    test(`${name} trùng flow-gate.mjs`, { skip: lit ? false : 'flow-gate đã import từ lib/rule-files.mjs' }, () => {
      assert.equal(asRe(lit).source, mine.source)
    })
  }
})
