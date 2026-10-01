// Test cho lib/brief.mjs: node --test ~/.claude/hooks/lib/brief.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { briefPlan, briefValues, briefWord, resolvePath } from './brief.mjs'

test('briefValues: nháy, không nháy có dấu cách, dừng ở khoá kế tiếp / ; / hết dòng, cắt dấu câu cuối', () => {
  assert.deepEqual(briefValues('plan="D:\\AI\\Vibe Coding\\PLAN.md" lane=A', 'plan'), ['D:\\AI\\Vibe Coding\\PLAN.md'])
  assert.deepEqual(briefValues("plan='a b/PLAN.md'", 'plan'), ['a b/PLAN.md'])
  assert.deepEqual(briefValues('plan=`a b/PLAN.md`', 'plan'), ['a b/PLAN.md'])
  assert.deepEqual(briefValues('plan=<PLAN.md>', 'plan'), ['PLAN.md'])
  assert.equal(briefValues('plan=D:\\AI\\Vibe Coding\\x\\PLAN.md lane=A', 'plan')[0], 'D:\\AI\\Vibe Coding\\x\\PLAN.md')
  assert.equal(briefValues('lane=A, plan=a b/PLAN.md, base=main', 'plan')[0], 'a b/PLAN.md')
  assert.equal(briefValues('plan=a b/PLAN.md; lane=A', 'plan')[0], 'a b/PLAN.md')
  assert.equal(briefValues('x\nplan=a b/PLAN.md\nlane=A', 'plan')[0], 'a b/PLAN.md')
})

test('briefValues: chữ thường theo sau đường dẫn ⇒ thêm ứng viên ngắn dần (dài nhất trước)', () => {
  assert.deepEqual(briefValues('plan=a b/PLAN.md (xem thêm ở đó)\nlane=A', 'plan'), [
    'a b/PLAN.md (xem thêm ở đó', 'a b/PLAN.md (xem thêm ở', 'a b/PLAN.md (xem thêm', 'a b/PLAN.md (xem', 'a b/PLAN.md', 'a',
  ])
  assert.ok(briefValues('plan=a b/PLAN.md (xem thêm)\nlane=A', 'plan').includes('a b/PLAN.md'))
})

test('briefValues: khoá phải đứng đầu từ (PORT_BASE= không phải base=), không phân biệt hoa thường, thiếu/rỗng ⇒ []', () => {
  assert.deepEqual(briefValues('PORT_BASE=4120', 'base'), [])
  assert.deepEqual(briefValues('outcome=x', 'plan'), [])
  assert.deepEqual(briefValues('plan= lane=A', 'plan'), [])
  assert.equal(briefValues('PLAN=x.md', 'plan')[0], 'x.md')
})

test('briefWord: một từ (tên làn / nhánh), bỏ chữ theo sau và dấu câu', () => {
  assert.equal(briefWord('plan=x lane=A base=main', 'lane'), 'A')
  assert.equal(briefWord('plan=x lane=A base=main', 'base'), 'main')
  assert.equal(briefWord('lane=A, plan=x', 'lane'), 'A')
  assert.equal(briefWord('lane=A (làn đầu)\nplan=x', 'lane'), 'A')
  assert.equal(briefWord('base=release/1.2.', 'base'), 'release/1.2')
  assert.equal(briefWord('outcome=x', 'lane'), null)
})

test('resolvePath: tương đối theo cwd, ~/ theo thư mục home, /c/… của git bash (Windows)', () => {
  const cwd = path.resolve(os.tmpdir(), 'brief-cwd')
  assert.equal(resolvePath('docs/PLAN.md', cwd), path.join(cwd, 'docs', 'PLAN.md'))
  assert.equal(resolvePath('~/p/PLAN.md', cwd), path.join(os.homedir(), 'p', 'PLAN.md'))
  assert.equal(resolvePath('~', cwd), os.homedir())
  const abs = path.join(cwd, 'x.md')
  assert.equal(resolvePath(abs, '/khong/lien/quan'), abs)
  if (process.platform === 'win32') {
    assert.equal(resolvePath('/c/Users/x/PLAN.md', cwd).toLowerCase(), 'c:\\users\\x\\plan.md')
  }
})

test('briefPlan: chọn ứng viên tồn tại (kể cả khi có chữ thường theo sau), không có thì lấy ứng viên đầu, thiếu plan= ⇒ null', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brief-')))
  try {
    const plan = path.join(root, 'my plans', 'PLAN.md')
    fs.mkdirSync(path.dirname(plan))
    fs.writeFileSync(plan, '# plan\n')
    assert.equal(briefPlan(`plan=${plan} lane=A`, root), plan)
    assert.equal(briefPlan(`plan=${plan} (xem thêm ở đó)\nlane=A`, root), plan)
    assert.equal(briefPlan(`plan="${plan}"`, '/khong/lien/quan'), plan)
    assert.equal(briefPlan('plan="my plans/PLAN.md" lane=A', root), plan) // tương đối theo cwd
    assert.equal(briefPlan('plan=khong-co.md lane=A', root), path.join(root, 'khong-co.md'))
    assert.equal(briefPlan('lane=A', root), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
