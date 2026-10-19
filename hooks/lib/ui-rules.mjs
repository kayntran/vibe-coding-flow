// ui-rules.mjs — luật "giao diện người mới dùng được" (AC-18), phần THUẦN: không trình duyệt, không đĩa, không mạng.
// hooks/ui-check.mjs mở app bằng Playwright, chạy `collectScript` trong trang để lấy ảnh chụp cấu trúc (snapshot) rồi đưa cho `audit`.
//
//   collectScript            chuỗi JS (biểu thức tự chạy) — page.evaluate(collectScript) trả snapshot:
//                              { route, viewport, dialogsOnLoad: số hộp thoại đang hiện lúc mở,
//                                buttons: [{ text, name, iconOnly, primary, inDialog, dialogButtons, inToolbar, title }] }
//                            text = chữ NGƯỜI DÙNG NHÌN THẤY (chữ sr-only 1px và chữ trong phần tử display:none không tính);
//                            name = tên đọc được (aria-label > aria-labelledby > chữ > alt/<title> svg > title); primary = [data-primary]
//                            hoặc class `bg-primary` không kèm data-variant khác "default" (mẫu shadcn); dialogButtons = số nút CÓ CHỮ
//                            trong cùng hộp thoại (nút × đóng không tính); hint = "nút nào" (<thẻ.lớp> có icon …, trong phần tử bao quanh), chỉ có cho nút không tên.
//   audit(snapshot, opts)    → [{ rule, key, msg, fix, severity }]; opts = { route, viewport, whitelistIcons }
//   keyOf / countKeys / overBaseline   khoá + đếm + so mốc (app cũ: chỉ đỏ khi số lỗi của MỘT khoá vượt số đã chốt)
//
// Luật (severity "error" chặn; "warn" chỉ nhắc): primary-many · icon-only · vague-label · dialog-on-load · no-name · long-label(warn).

export const RULES = ['primary-many', 'icon-only', 'vague-label', 'dialog-on-load', 'no-name', 'long-label']

// Tên (đã bỏ dấu, chữ thường) được phép đứng một mình không kèm chữ: nhà · in · tìm kiếm (research-journey §7) · đóng (X) (sổ chốt [2e0j]). Mở rộng: ui.json whitelistIcons.
const DEFAULT_ICON_WHITELIST = ['home', 'trang chu', 'nha', 'print', 'in', 'search', 'tim kiem', 'tim', 'dong', 'close']
// Nhãn mơ hồ (đã bỏ dấu, chữ thường, bỏ dấu câu cuối).
const VAGUE_LABELS = new Set(['ok', 'yes', 'no', 'submit', 'co', 'khong', 'xac nhan', 'dong y'])
const MAX_WORDS = 3
const MAX_HINTS = 3

export const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim()
const clean = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
const words = (s) => (s ? s.split(' ').length : 0)

// --- thu thập trong trang ---------------------------------------------------------------------------------------------------------------

// Hàm này được chuyển thành chuỗi và chạy TRONG trình duyệt ⇒ phải tự đủ (không dùng biến/hàm ngoài), chỉ dùng API DOM.
function collect() {
  const box = (el) => el.getBoundingClientRect()
  const shown = (el) => {
    const r = box(el)
    if (!(r.width > 0 && r.height > 0)) return false // display:none (cả do cha) cho hộp 0×0
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden'
  }
  const onScreen = (el) => { const r = box(el); return r.right > 0 && r.bottom > 0 && r.left < innerWidth } // menu trượt ra ngoài màn không tính
  const isDialog = (el) => { const role = el.getAttribute('role'); return role === 'dialog' || role === 'alertdialog' || el.tagName.toLowerCase() === 'dialog' }
  const up = (el, test) => { for (let p = el.parentElement; p; p = p.parentElement) if (test(p)) return p; return null }

  // Gợi ý "nút nào" cho nút không tên: <thẻ#id.lớp1.lớp2> + icon gần nhất (lớp lucide-…, data-lucide, src ảnh) + phần tử bao quanh gần nhất có id/lớp/thẻ ngữ nghĩa.
  const attr = (el, k) => String(el.getAttribute(k) || '').trim()
  const classes = (el, n) => attr(el, 'class').split(/\s+/).filter(Boolean).slice(0, n)
  const SEMANTIC = ['header', 'nav', 'main', 'footer', 'aside', 'form', 'section', 'li', 'tr', 'td', 'th', 'table', 'dialog']
  const tagOf = (el) => {
    const tag = el.tagName.toLowerCase()
    const id = attr(el, 'id')
    const href = tag === 'a' ? attr(el, 'href').slice(0, 40) : ''
    return `${tag}${id ? `#${id}` : ''}${classes(el, 2).map((c) => `.${c}`).join('')}${href ? ` href="${href}"` : ''}`
  }
  const iconOf = (el) => {
    const queue = Array.from(el.childNodes || []).filter((c) => c.nodeType === 1)
    for (let i = 0; queue.length && i < 30; i++) {
      const c = queue.shift()
      const tag = c.tagName.toLowerCase()
      if (tag === 'svg' || tag === 'i' || tag === 'img' || tag === 'span') {
        const named = attr(c, 'data-lucide') || (attr(c, 'class').split(/\s+/).find((x) => /^(?:lucide-|icon|fa-|bi-|mdi-|ri-|ph-|tabler-)/.test(x)) || '')
        if (named) return named
        if (tag === 'img') return attr(c, 'src').slice(0, 60) || 'img'
        if (tag === 'svg') return classes(c, 1)[0] || 'svg'
      }
      queue.push(...Array.from(c.childNodes || []).filter((x) => x.nodeType === 1))
    }
    return ''
  }
  const hintOf = (el) => {
    const around = up(el, (p) => p.tagName.toLowerCase() !== 'body' && p.tagName.toLowerCase() !== 'html' && (attr(p, 'id') || classes(p, 1).length || SEMANTIC.includes(p.tagName.toLowerCase())))
    const icon = iconOf(el)
    return `<${tagOf(el)}>${icon ? ` có icon ${icon}` : ''}${around ? `, trong ${tagOf(around)}` : ''}`.slice(0, 160)
  }

  // Gom chữ trong nút: visible = chữ thật sự nhìn thấy (hộp >1px, như sr-only thì loại); all = mọi chữ không bị display:none (dùng đặt tên).
  const scan = (root) => {
    const res = { visible: [], all: [], alt: [] }
    const walk = (n) => {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType === 3) {
          const t = String(c.textContent || '').replace(/\s+/g, ' ').trim()
          if (!t) continue
          const r = box(n)
          if (!(r.width > 0 && r.height > 0)) continue
          res.all.push(t)
          if (r.width > 1 && r.height > 1 && getComputedStyle(n).visibility !== 'hidden') res.visible.push(t)
        } else if (c.nodeType === 1) {
          const tag = c.tagName.toLowerCase()
          if (tag === 'img') {
            const alt = String(c.getAttribute('alt') || '').trim()
            if (alt) res.alt.push(alt)
          } else if (tag === 'svg') {
            const ti = Array.from(c.childNodes || []).find((x) => x.nodeType === 1 && x.tagName.toLowerCase() === 'title')
            const t = ti ? String(ti.textContent || '').trim() : ''
            if (t) res.alt.push(t)
          } else if (tag !== 'script' && tag !== 'style') walk(c)
        }
      }
    }
    walk(root)
    return res
  }

  const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')).filter(shown)
  const els = Array.from(document.querySelectorAll('button,[role="button"],a[href],input[type="submit"],input[type="button"]'))
  const perDialog = new Map()
  const buttons = []
  for (const el of els) {
    if (!shown(el) || !onScreen(el)) continue
    const isInput = el.tagName.toLowerCase() === 'input'
    const s = isInput ? { visible: [String(el.value || el.getAttribute('value') || '')], all: [String(el.value || el.getAttribute('value') || '')], alt: [] } : scan(el)
    const text = s.visible.join(' ').replace(/\s+/g, ' ').trim()
    const label = String(el.getAttribute('aria-label') || '').trim()
    const by = String(el.getAttribute('aria-labelledby') || '').trim()
    const byText = by ? by.split(/\s+/).map((id) => { const t = document.getElementById(id); return t ? String(t.textContent || '').trim() : '' }).join(' ').trim() : ''
    const title = String(el.getAttribute('title') || '').trim()
    const name = (label || byText || s.all.join(' ').replace(/\s+/g, ' ').trim() || s.alt.join(' ').trim() || title).slice(0, 200)
    const cls = String(el.getAttribute('class') || '').split(/\s+/)
    const dp = el.getAttribute('data-primary')
    const variant = el.getAttribute('data-variant')
    const dlg = up(el, isDialog)
    if (dlg && text) perDialog.set(dlg, (perDialog.get(dlg) || 0) + 1)
    buttons.push({
      text: text.slice(0, 200),
      name,
      iconOnly: !text,
      primary: (dp !== null && dp !== 'false') || (cls.indexOf('bg-primary') >= 0 && (!variant || variant === 'default')),
      inDialog: !!dlg,
      dialogEl: dlg,
      inToolbar: !!up(el, (p) => p.getAttribute('data-toolbar') !== null),
      title,
      hint: name ? '' : hintOf(el),
    })
  }
  for (const b of buttons) { b.dialogButtons = b.dialogEl ? perDialog.get(b.dialogEl) || 0 : 0; delete b.dialogEl }
  return { route: location.pathname + location.search + location.hash, viewport: innerWidth, dialogsOnLoad: dialogs.length, buttons }
}

export const collectScript = `(${collect.toString()})()`

// --- khoá + mốc -------------------------------------------------------------------------------------------------------------------------

const part = (s) => clean(s).toLowerCase().replace(/\|/g, '/').slice(0, 80)
// key = route|khổ|luật|nhãn — "đếm số lần xuất hiện của khoá" là cái được so với mốc.
export const keyOf = (route, viewport, rule, label) => [part(route), part(viewport), rule, part(label)].join('|')

export function countKeys(findings, severity = 'error') {
  const counts = {}
  for (const f of findings) if (f.severity === severity) counts[f.key] = (counts[f.key] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

// Lỗi chặn vượt mốc: counts = null ⇒ không có mốc (mọi lỗi chặn). Có mốc ⇒ một khoá chỉ đỏ khi số hiện tại > số đã chốt
// (thêm một nút lỗi cùng route/khổ/luật/nhãn vẫn bị bắt). Trả { blocking: [{...lỗi đầu của khoá, count, allowed, extra}], inBaseline }.
export function overBaseline(findings, counts) {
  const groups = new Map()
  for (const f of findings) {
    if (f.severity !== 'error') continue
    let g = groups.get(f.key)
    if (g) g.count++
    else { g = { ...f, count: 1, hints: [] }; groups.set(f.key, g) }
    if (f.hint && g.hints.length < MAX_HINTS && !g.hints.includes(f.hint)) g.hints.push(f.hint) // "nút nào" của các nút cùng khoá (nút không tên)
  }
  const blocking = []
  let inBaseline = 0
  for (const g of groups.values()) {
    const allowed = Math.max(0, Math.floor(Number(counts?.[g.key]) || 0))
    inBaseline += Math.min(g.count, allowed)
    if (g.count > allowed) blocking.push({ ...g, allowed, extra: g.count - allowed })
  }
  return { blocking, inBaseline }
}

// --- kiểm --------------------------------------------------------------------------------------------------------------------------------

const q = (s) => `"${s}"`

export function audit(snapshot, opts = {}) {
  const buttons = Array.isArray(snapshot?.buttons) ? snapshot.buttons : []
  const route = opts.route ?? snapshot?.route ?? ''
  const viewport = opts.viewport ?? snapshot?.viewport ?? ''
  const white = new Set([...DEFAULT_ICON_WHITELIST, ...(Array.isArray(opts.whitelistIcons) ? opts.whitelistIcons : []).map(fold)])
  const out = []
  const add = (rule, label, msg, fix, severity = 'error', hint = '') => out.push({ rule, key: keyOf(route, viewport, rule, label), msg, fix, severity, ...(hint ? { hint } : {}) })

  const dialogs = Math.max(0, Math.floor(Number(Array.isArray(snapshot?.dialogsOnLoad) ? snapshot.dialogsOnLoad.length : snapshot?.dialogsOnLoad) || 0))
  for (let i = 0; i < dialogs; i++) {
    add('dialog-on-load', '', 'Vừa mở màn đã có hộp thoại bật ra chắn lối — người mới chưa kịp làm gì đã bị hỏi.',
      'Bỏ hộp thoại lúc mở màn; chỉ hiện khi người dùng bấm một nút.')
  }

  for (const b of buttons) {
    const text = clean(b.text)
    const name = clean(b.name)
    const title = clean(b.title)
    const symbolOnly = text !== '' && !/[\p{L}\p{N}]/u.test(text) // "×", "+", "⋮", "☰": ký hiệu, không phải chữ
    const iconOnly = b.iconOnly === true || text === '' || symbolOnly
    if (iconOnly) {
      if (!name) {
        add('no-name', '', 'Có một nút không có tên — người dùng không đoán được nó làm gì, người dùng đọc màn hình cũng không nghe được tên.',
          'Thêm chữ hiện ra cho nút (nút chỉ có hình thì thêm cả aria-label).', 'error', clean(b.hint).slice(0, 160))
      } else if (!white.has(fold(name)) && !(b.inToolbar && title)) {
        add('icon-only', name, `Nút ${q(name)} chỉ có hình, không có chữ hiện ra — người mới nhìn không biết bấm vào sẽ làm gì.`,
          `Thêm chữ 1 từ cạnh hình (vd ${q(name)}). Chỉ nhà, in, tìm kiếm, đóng (X) được để hình trơn; thanh công cụ dày thì để hình trơn kèm title (hiện khi rê chuột).`)
      }
      continue
    }
    const exempt = b.inDialog === true && Number(b.dialogButtons) === 1 // hộp thoại thuần thông tin chỉ có một nút
    if (!exempt && VAGUE_LABELS.has(fold(text).replace(/[\s.!?…:]+$/u, ''))) {
      add('vague-label', text, `Nút ${q(text)} không nói rõ bấm vào sẽ xảy ra việc gì.`,
        'Đổi thành việc nút làm, 1–3 chữ mở bằng động từ (vd "Lưu", "Xoá đơn", "Giữ lại").')
    }
    if (words(text) > MAX_WORDS) {
      add('long-label', text, `Nút ${q(text)} dài ${words(text)} chữ — người mới phải đọc mới hiểu.`,
        'Rút còn 1–3 chữ, mở bằng động từ.', 'warn')
    }
  }

  // Nút chính: tính riêng trong hộp thoại và ngoài hộp thoại; mỗi nút chính thừa là một lỗi (để so mốc theo số lượng).
  for (const inDialog of [false, true]) {
    const primaries = buttons.filter((b) => b.primary === true && (b.inDialog === true) === inDialog)
    if (primaries.length < 2) continue
    for (const b of primaries) {
      const label = clean(b.text) || clean(b.name) || clean(b.title)
      add('primary-many', label, `Màn có ${primaries.length} nút nổi bật nhất${label ? ` (có ${q(label)})` : ''} — người mới không biết bấm nút nào trước.`,
        'Chỉ để MỘT nút chính (việc người dùng làm tiếp theo); các nút còn lại đổi sang kiểu phụ (secondary / outline).')
    }
  }
  return out
}
