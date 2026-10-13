// Test cho lib/ui-rules.mjs: node --test hooks/lib/ui-rules.test.mjs
// Kit không cài Playwright ⇒ audit kiểm bằng snapshot giả; collectScript chạy trong vm với DOM giả tối thiểu (đủ các API nó dùng).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { RULES, audit, collectScript, countKeys, fold, keyOf, overBaseline } from './ui-rules.mjs'

// ---------- snapshot giả ----------
const btn = (o = {}) => ({ text: '', name: '', iconOnly: false, primary: false, inDialog: false, dialogButtons: 0, inToolbar: false, title: '', ...o })
const labeled = (text, o = {}) => btn({ text, name: text, ...o })
const icon = (name, o = {}) => btn({ text: '', name, iconOnly: true, ...o })
const snap = (buttons, extra = {}) => ({ route: '/', viewport: 1280, dialogsOnLoad: 0, buttons, ...extra })
const rules = (findings) => findings.map((f) => f.rule)
const errors = (findings) => findings.filter((f) => f.severity === 'error')

describe('audit — từng luật', () => {
  test('trang sạch: nút có chữ 1–3 chữ, một nút chính ⇒ không có phát hiện', () => {
    assert.deepEqual(audit(snap([labeled('Lưu', { primary: true }), labeled('Huỷ đơn'), icon('Tìm kiếm')])), [])
  })

  test('kịch bản research §6: 5 lỗi bắt đủ (2 icon-only, "OK", 2 nút chính, nhãn 6 chữ)', () => {
    const f = audit(snap([
      icon('Xoá'), icon('Cài đặt'), labeled('OK'),
      labeled('Lưu', { primary: true }), labeled('Gửi đi', { primary: true }),
      labeled('Bấm vào đây để lưu lại ngay'),
    ]))
    assert.deepEqual(rules(f).sort(), ['icon-only', 'icon-only', 'long-label', 'primary-many', 'primary-many', 'vague-label'])
    assert.equal(errors(f).length, 5)
    assert.equal(f.find((x) => x.rule === 'long-label').severity, 'warn')
  })

  test('mỗi phát hiện có đủ rule/key/msg/fix/severity, msg và fix là câu đời thường', () => {
    for (const x of audit(snap([icon('Xoá'), labeled('OK'), labeled('Đây là nhãn rất dài'), btn(), labeled('A', { primary: true }), labeled('B', { primary: true })], { dialogsOnLoad: 1 }))) {
      assert.deepEqual(Object.keys(x).sort(), ['fix', 'key', 'msg', 'rule', 'severity'])
      assert.ok(RULES.includes(x.rule), x.rule)
      assert.ok(x.msg.length > 15 && x.fix.length > 15, x.rule)
      assert.match(x.severity, /^(error|warn)$/)
    }
  })

  describe('icon-only', () => {
    test('nút chỉ hình ngoài danh sách trắng ⇒ lỗi chặn, nêu tên nút', () => {
      const [f] = audit(snap([icon('Xoá')]))
      assert.equal(f.rule, 'icon-only')
      assert.equal(f.severity, 'error')
      assert.match(f.msg, /"Xoá"/)
    })
    test('nhà · in · tìm kiếm (không phân biệt hoa/thường/dấu, tiếng Anh cũng được) để hình trơn', () => {
      for (const n of ['Trang chủ', 'trang chu', 'Home', 'In', 'Print', 'Tìm kiếm', 'TIM KIEM', 'Search', 'Tìm']) {
        assert.deepEqual(audit(snap([icon(n)])), [], n)
      }
    })
    test('whitelistIcons của dự án mở rộng danh sách trắng', () => {
      assert.equal(audit(snap([icon('Đóng')])).length, 1)
      assert.deepEqual(audit(snap([icon('Đóng')]), { whitelistIcons: ['đóng'] }), [])
    })
    test('thanh công cụ có title ⇒ được; thanh công cụ không title, hoặc title nằm ngoài thanh ⇒ vẫn lỗi', () => {
      assert.deepEqual(audit(snap([icon('Đậm', { inToolbar: true, title: 'Đậm' })])), [])
      assert.equal(rules(audit(snap([icon('Đậm', { inToolbar: true })]))).join(), 'icon-only')
      assert.equal(rules(audit(snap([icon('Đậm', { title: 'Đậm' })]))).join(), 'icon-only')
    })
    test('ký hiệu trơn ("×", "+") chữ hiện ra không phải chữ ⇒ tính là chỉ hình', () => {
      assert.equal(rules(audit(snap([labeled('×')]))).join(), 'icon-only')
      assert.equal(rules(audit(snap([labeled('+')]))).join(), 'icon-only')
    })
  })

  describe('no-name', () => {
    test('nút không chữ và không tên đọc được ⇒ no-name, KHÔNG báo thêm icon-only (một lỗi một lần)', () => {
      const f = audit(snap([btn({ iconOnly: true })]))
      assert.deepEqual(rules(f), ['no-name'])
      assert.equal(f[0].severity, 'error')
    })
    test('thanh công cụ có title vẫn cần có tên (no-name không được miễn)', () => {
      assert.deepEqual(rules(audit(snap([btn({ iconOnly: true, inToolbar: true })]))), ['no-name'])
    })
    test('nút không tên mang theo gợi ý vị trí (hint) để tìm ra nút nào; khoá không đổi theo hint (mốc cũ vẫn khớp)', () => {
      const f = audit(snap([btn({ iconOnly: true, hint: '<button.size-9> có icon lucide-plus, trong header.pages-head' })]))
      assert.equal(f[0].hint, '<button.size-9> có icon lucide-plus, trong header.pages-head')
      assert.equal(f[0].key, audit(snap([btn({ iconOnly: true })]))[0].key)
      assert.equal('hint' in audit(snap([btn({ iconOnly: true })]))[0], false, 'không có hint ⇒ không thêm khoá hint')
    })
    test('overBaseline gom hint của các nút cùng khoá (tối đa 3, không trùng) vào lỗi đại diện', () => {
      const hints = ['<button.a>', '<button.b>', '<button.a>', '<button.c>', '<button.d>']
      const r = overBaseline(audit(snap(hints.map((hint) => btn({ iconOnly: true, hint })))), null)
      assert.equal(r.blocking.length, 1)
      assert.equal(r.blocking[0].count, 5)
      assert.deepEqual(r.blocking[0].hints, ['<button.a>', '<button.b>', '<button.c>'])
    })
  })

  describe('vague-label', () => {
    test('OK/Yes/No/Submit/Có/Không/Xác nhận/Đồng ý (mọi kiểu hoa/dấu/dấu câu cuối) ⇒ lỗi chặn', () => {
      for (const t of ['OK', 'ok', 'Yes', 'No', 'Submit', 'Có', 'CÓ', 'Không', 'Xác nhận', 'xác nhận', 'Đồng ý', 'OK!', 'Yes.', 'Xác nhận…']) {
        const f = audit(snap([labeled(t)]))
        assert.deepEqual(rules(f), ['vague-label'], t)
        assert.equal(f[0].severity, 'error')
      }
    })
    test('nhãn có động từ + đối tượng không bị bắt ("Xác nhận đơn", "Gửi đơn", "Giữ lại")', () => {
      assert.deepEqual(audit(snap([labeled('Xác nhận đơn'), labeled('Gửi đơn'), labeled('Giữ lại')])), [])
    })
    test('hộp thoại thuần thông tin chỉ MỘT nút "OK" ⇒ được; hộp thoại hai nút "Có"/"Không" ⇒ vẫn bị bắt; ngoài hộp thoại ⇒ bị bắt', () => {
      assert.deepEqual(audit(snap([labeled('OK', { inDialog: true, dialogButtons: 1 })])), [])
      const two = audit(snap([labeled('Có', { inDialog: true, dialogButtons: 2 }), labeled('Không', { inDialog: true, dialogButtons: 2 })]))
      assert.deepEqual(rules(two), ['vague-label', 'vague-label'])
      assert.deepEqual(rules(audit(snap([labeled('OK', { dialogButtons: 1 })]))), ['vague-label'])
    })
  })

  describe('long-label', () => {
    test('3 chữ ổn; 4 chữ trở lên ⇒ chỉ cảnh báo (severity warn)', () => {
      assert.deepEqual(audit(snap([labeled('Thêm đơn mới')])), [])
      const f = audit(snap([labeled('Thêm một đơn mới')]))
      assert.deepEqual(rules(f), ['long-label'])
      assert.equal(f[0].severity, 'warn')
    })
    test('nhãn dài gồm khoảng trắng thừa/xuống dòng vẫn đếm đúng số chữ', () => {
      assert.deepEqual(audit(snap([labeled('  Thêm \n đơn   mới ')])), [])
    })
  })

  describe('primary-many', () => {
    test('0 hoặc 1 nút chính ⇒ ổn; từ 2 ⇒ mỗi nút chính một lỗi chặn', () => {
      assert.deepEqual(audit(snap([labeled('Lưu')])), [])
      assert.deepEqual(audit(snap([labeled('Lưu', { primary: true })])), [])
      const f = audit(snap([labeled('Lưu', { primary: true }), labeled('Thêm', { primary: true }), labeled('Xoá đơn', { primary: true })]))
      assert.deepEqual(rules(f), ['primary-many', 'primary-many', 'primary-many'])
      assert.match(f[0].msg, /3 nút/)
    })
    test('nút chính trong hộp thoại đếm riêng với nút chính ngoài hộp thoại', () => {
      assert.deepEqual(audit(snap([labeled('Lưu', { primary: true }), labeled('Xoá đơn', { primary: true, inDialog: true, dialogButtons: 2 })])), [])
    })
  })

  describe('dialog-on-load', () => {
    test('có hộp thoại lúc mở ⇒ lỗi chặn, mỗi hộp một lỗi', () => {
      assert.deepEqual(rules(audit(snap([], { dialogsOnLoad: 2 }))), ['dialog-on-load', 'dialog-on-load'])
      assert.deepEqual(audit(snap([], { dialogsOnLoad: 0 })), [])
    })
  })

  test('snapshot rỗng/hỏng không ném', () => {
    assert.deepEqual(audit({}), [])
    assert.deepEqual(audit(null), [])
    assert.deepEqual(audit({ buttons: 'x' }), [])
  })
})

describe('khoá và so mốc', () => {
  test('key = route|khổ|luật|nhãn (nhãn gọn, chữ thường, không chứa dấu |)', () => {
    assert.equal(keyOf('/don-hang', 390, 'icon-only', '  Xoá  '), '/don-hang|390|icon-only|xoá')
    assert.equal(keyOf('/a|b', 1280, 'vague-label', 'A | B'), '/a/b|1280|vague-label|a / b')
    const [f] = audit(snap([icon('Xoá')], { route: '/don-hang', viewport: 390 }))
    assert.equal(f.key, '/don-hang|390|icon-only|xoá')
  })

  test('opts.route / opts.viewport thắng giá trị trong snapshot', () => {
    const [f] = audit(snap([icon('Xoá')]), { route: '/x?e=1', viewport: 390 })
    assert.equal(f.key, '/x?e=1|390|icon-only|xoá')
  })

  test('countKeys đếm số lần mỗi khoá (chỉ lỗi chặn), khoá sắp xếp ổn định', () => {
    const f = audit(snap([icon('Xoá'), icon('Xoá'), icon('Sửa'), labeled('Thêm một đơn mới')]))
    assert.deepEqual(countKeys(f), { '/|1280|icon-only|sửa': 1, '/|1280|icon-only|xoá': 2 })
    assert.deepEqual(Object.keys(countKeys(f, 'warn')), ['/|1280|long-label|thêm một đơn mới'])
  })

  describe('overBaseline (app cũ: chỉ đỏ khi số lỗi của một khoá VƯỢT số đã chốt)', () => {
    const base = countKeys(audit(snap([icon('Xoá'), labeled('OK')])))

    test('không có mốc ⇒ mọi lỗi chặn đều chặn; cảnh báo không bao giờ chặn', () => {
      const r = overBaseline(audit(snap([icon('Xoá'), labeled('Thêm một đơn mới')])), null)
      assert.equal(r.blocking.length, 1)
      assert.equal(r.inBaseline, 0)
    })
    test('đúng bằng mốc ⇒ không chặn, đếm vào "đã chốt"', () => {
      const r = overBaseline(audit(snap([icon('Xoá'), labeled('OK')])), base)
      assert.deepEqual(r.blocking, [])
      assert.equal(r.inBaseline, 2)
    })
    test('ít hơn mốc (đã sửa bớt) ⇒ không chặn', () => {
      assert.deepEqual(overBaseline(audit(snap([icon('Xoá')])), base).blocking, [])
    })
    test('THÊM một nút lỗi CÙNG route/khổ/luật/nhãn ⇒ vượt mốc ⇒ chặn, nói thêm bao nhiêu', () => {
      const r = overBaseline(audit(snap([icon('Xoá'), icon('Xoá'), labeled('OK')])), base)
      assert.equal(r.blocking.length, 1)
      assert.equal(r.blocking[0].rule, 'icon-only')
      assert.equal(r.blocking[0].count, 2)
      assert.equal(r.blocking[0].allowed, 1)
      assert.equal(r.blocking[0].extra, 1)
      assert.equal(r.inBaseline, 2)
    })
    test('lỗi khác nhãn / khác khổ / khác route ⇒ khoá mới ⇒ chặn', () => {
      assert.equal(overBaseline(audit(snap([icon('Xoá'), icon('Sửa'), labeled('OK')])), base).blocking.length, 1)
      assert.equal(overBaseline(audit(snap([icon('Xoá'), labeled('OK')]), { viewport: 390 }), base).blocking.length, 2)
      assert.equal(overBaseline(audit(snap([icon('Xoá'), labeled('OK')], { route: '/khac' })), base).blocking.length, 2)
    })
    test('số trong mốc hỏng (âm, chữ, thiếu) coi như 0 ⇒ không nới luật', () => {
      const f = audit(snap([icon('Xoá')]))
      for (const bad of [-3, 'abc', null, undefined, NaN]) assert.equal(overBaseline(f, { [f[0].key]: bad }).blocking.length, 1, String(bad))
    })
  })
})

describe('fold', () => {
  test('bỏ dấu, đ→d, hạ chữ thường, gọn khoảng trắng', () => {
    assert.equal(fold('  Đồng   Ý '), 'dong y')
    assert.equal(fold('Tìm KIẾM'), 'tim kiem')
    assert.equal(fold(null), '')
  })
})

// ---------- collectScript trong vm với DOM giả ----------
const rect = (w = 80, h = 30, l = 10, t = 10) => ({ width: w, height: h, left: l, top: t, right: l + w, bottom: t + h })
const HIDDEN = rect(0, 0, 0, 0)
const SR_ONLY = rect(1, 1, 0, 0)

function node(tag, attrs = {}, children = [], { box = rect(), style = {} } = {}) {
  const n = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: children, parentElement: null, style,
    getAttribute: (k) => (k in attrs ? String(attrs[k]) : null),
    getBoundingClientRect: () => box,
    get textContent() { return children.map((c) => c.textContent).join('') },
  }
  for (const c of children) c.parentElement = n
  return n
}
const tx = (s) => ({ nodeType: 3, textContent: s, parentElement: null })

function fakeWindow(body, { width = 1280, url = { pathname: '/don', search: '?a=1', hash: '#x' } } = {}) {
  const all = []
  const walk = (n) => { if (n.nodeType === 1) { all.push(n); n.childNodes.forEach(walk) } }
  walk(body)
  const matcher = (sel) => {
    const m = /^([a-z]*)(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/.exec(sel)
    assert.ok(m, `selector giả chưa hỗ trợ: ${sel}`)
    const [, tag, attr, val] = m
    return (el) => (!tag || el.tagName.toLowerCase() === tag) && (!attr || (val === undefined ? el.getAttribute(attr) !== null : el.getAttribute(attr) === val))
  }
  const document = {
    querySelectorAll: (sel) => { const ms = sel.split(',').map(matcher); return all.filter((el) => ms.some((m) => m(el))) },
    getElementById: (id) => all.find((el) => el.attrs.id === id) ?? null,
  }
  return vm.createContext({ document, getComputedStyle: (el) => ({ display: 'block', visibility: 'visible', ...el.style }), innerWidth: width, location: url })
}
const collect = (body, o) => vm.runInContext(collectScript, fakeWindow(body, o))

describe('collectScript (chạy trong vm với DOM giả)', () => {
  test('là chuỗi biểu thức JS hợp lệ, tự chạy được và trả snapshot đúng dạng', () => {
    assert.equal(typeof collectScript, 'string')
    assert.doesNotThrow(() => new vm.Script(collectScript))
    const s = collect(node('body', {}, []))
    assert.deepEqual({ ...s, buttons: [...s.buttons] }, { route: '/don?a=1#x', viewport: 1280, dialogsOnLoad: 0, buttons: [] })
  })

  test('chữ nhìn thấy / tên / icon-only / nút chính', () => {
    const body = node('body', {}, [
      node('button', { 'data-primary': '' }, [tx('Lưu')]),
      node('button', { class: 'inline-flex bg-primary px-4' }, [tx('Thêm đơn')]),
      node('button', { class: 'bg-primary', 'data-variant': 'outline' }, [tx('Huỷ đơn')]),
      node('button', { 'data-primary': 'false' }, [tx('Sửa')]),
      node('button', { 'aria-label': 'Xoá' }, [node('svg')]),
      node('button', {}, [node('svg', {}, [node('title', {}, [tx('Cài đặt')])])]),
      node('button', {}, [node('svg'), node('span', { class: 'sr-only' }, [tx('Đóng')], { box: SR_ONLY })]),
      node('button', {}, [node('svg'), node('span', { class: 'hidden md:inline' }, [tx('Lưu nháp')], { box: HIDDEN })]),
      node('input', { type: 'submit', value: 'Gửi đơn' }),
      node('a', { href: '/' }, [tx('Trang chủ')]),
      node('button', { 'aria-labelledby': 'lbl' }, [node('svg')]),
      node('span', { id: 'lbl' }, [tx('Mở menu')]),
    ])
    const b = collect(body).buttons
    const by = (i) => b[i]
    assert.equal(by(0).text, 'Lưu'); assert.equal(by(0).primary, true)
    assert.equal(by(1).primary, true, 'class bg-primary')
    assert.equal(by(2).primary, false, 'bg-primary kèm data-variant khác "default" không phải nút chính')
    assert.equal(by(3).primary, false, 'data-primary="false"')
    assert.deepEqual([by(4).text, by(4).name, by(4).iconOnly], ['', 'Xoá', true])
    assert.deepEqual([by(5).text, by(5).name, by(5).iconOnly], ['', 'Cài đặt', true], 'tên lấy từ <title> của svg')
    assert.deepEqual([by(6).text, by(6).name, by(6).iconOnly], ['', 'Đóng', true], 'chữ sr-only (1px) không phải chữ nhìn thấy nhưng vẫn là tên')
    assert.deepEqual([by(7).text, by(7).name, by(7).iconOnly], ['', '', true], 'chữ trong phần tử ẩn (khổ hẹp) không nhìn thấy, cũng không là tên')
    assert.deepEqual([by(8).text, by(8).iconOnly], ['Gửi đơn', false], 'input submit lấy value')
    assert.deepEqual([by(9).text, by(9).name], ['Trang chủ', 'Trang chủ'], 'link a[href] cũng là nút')
    assert.deepEqual([by(10).text, by(10).name], ['', 'Mở menu'], 'aria-labelledby')
    assert.equal(b.length, 11)
  })

  test('bỏ nút ẩn, nút ngoài màn hình; nút trong thanh công cụ ghi inToolbar + title', () => {
    const body = node('body', {}, [
      node('button', {}, [tx('Ẩn')], { box: HIDDEN }),
      node('button', {}, [tx('Vô hình')], { style: { visibility: 'hidden' } }),
      node('button', {}, [tx('Trượt ra ngoài')], { box: rect(80, 30, -500, 10) }),
      node('button', {}, [tx('Ngoài phải')], { box: rect(80, 30, 1400, 10) }),
      node('div', { 'data-toolbar': '' }, [node('button', { title: 'Đậm' }, [node('svg')])]),
    ])
    const b = collect(body).buttons
    assert.equal(b.length, 1)
    assert.deepEqual([b[0].inToolbar, b[0].title, b[0].name, b[0].iconOnly], [true, 'Đậm', 'Đậm', true])
  })

  test('hộp thoại: đếm hộp đang hiện, nút nằm trong hộp, số nút CÓ CHỮ (nút × không tính)', () => {
    const body = node('body', {}, [
      node('button', {}, [tx('Lưu')]),
      node('div', { role: 'dialog' }, [node('p', {}, [tx('Đã lưu xong.')]), node('button', { 'aria-label': 'Đóng' }, [node('svg')]), node('button', {}, [tx('OK')])]),
      node('div', { role: 'alertdialog' }, [node('button', {}, [tx('Xoá đơn')]), node('button', {}, [tx('Giữ lại')])]),
      node('div', { role: 'dialog' }, [node('button', {}, [tx('Không thấy')], { box: HIDDEN })], { box: HIDDEN }), // hộp thoại đóng (display:none): cả cây hộp 0×0
    ])
    const s = collect(body)
    assert.equal(s.dialogsOnLoad, 2)
    const b = Object.fromEntries(s.buttons.map((x) => [x.text || x.name, x]))
    assert.deepEqual([b['Lưu'].inDialog, b['Lưu'].dialogButtons], [false, 0])
    assert.deepEqual([b['OK'].inDialog, b['OK'].dialogButtons], [true, 1])
    assert.deepEqual([b['Đóng'].inDialog, b['Đóng'].dialogButtons], [true, 1])
    assert.deepEqual([b['Xoá đơn'].inDialog, b['Xoá đơn'].dialogButtons], [true, 2])
    assert.equal(s.buttons.some((x) => x.text === 'Không thấy'), false)
  })

  test('hint của nút: thẻ + lớp đầu, icon gần nhất (lớp lucide-…), và phần tử bao quanh có id/lớp/thẻ ngữ nghĩa', () => {
    const body = node('body', {}, [
      node('header', { class: 'pages-head flex' }, [
        node('div', {}, [
          node('button', { class: 'inline-flex size-9 rounded-md' }, [node('svg', { class: 'lucide lucide-plus size-4' })]),
        ]),
      ]),
      node('button', { id: 'x' }, []),
      node('a', { href: '/cai-dat/tai-khoan' }, [node('img', { src: '/icons/gear.svg' })]),
      node('button', { 'aria-label': 'Xoá' }, [node('svg')]),
    ])
    const b = collect(body).buttons
    assert.match(b[0].hint, /^<button\.inline-flex\.size-9>/)
    assert.match(b[0].hint, /icon lucide-plus/)
    assert.match(b[0].hint, /header\.pages-head/)
    assert.doesNotMatch(b[0].hint, /<div>|div/, 'bỏ qua phần tử bao quanh trơn (không id, không lớp)')
    assert.match(b[1].hint, /^<button#x>/)
    assert.match(b[2].hint, /^<a href="\/cai-dat\/tai-khoan">/)
    assert.match(b[2].hint, /icon .*gear\.svg/)
    assert.equal(b[3].name, 'Xoá')
    assert.ok(b.every((x) => x.hint.length <= 160), 'gợi ý ngắn')
  })

  test('snapshot thật đi qua audit: dialog 1 nút OK được miễn, icon-only/nút chính bị bắt, khổ hẹp ghi vào khoá', () => {
    const body = node('body', {}, [
      node('button', { 'data-primary': '' }, [tx('Lưu')]),
      node('button', { 'data-primary': '' }, [tx('Thêm đơn')]),
      node('button', { 'aria-label': 'Xoá' }, [node('svg')]),
      node('div', { role: 'dialog' }, [node('button', {}, [tx('OK')])]),
    ])
    const s = collect(body, { width: 390 })
    assert.equal(s.viewport, 390)
    const f = audit(s, { route: '/don' })
    assert.deepEqual(rules(f).sort(), ['dialog-on-load', 'icon-only', 'primary-many', 'primary-many'])
    assert.ok(f.every((x) => x.key.startsWith('/don|390|')))
  })
})
