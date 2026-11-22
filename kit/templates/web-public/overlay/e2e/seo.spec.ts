import { expect, test } from '@playwright/test'

// Máy kiểm seo-public (flow-check) chạy `playwright test --grep=seo`: tên test nào cũng bắt đầu bằng "seo:".
// Nguyên tắc: bot xem trước link (Zalo, Facebook) và Googlebot lượt đầu KHÔNG chạy JavaScript, nên các thẻ phải có sẵn trong HTML
// máy chủ trả về. Test chạy vào BẢN BUILD (xem playwright.config.ts), nơi CSP có nonce như bản thật.

// Mọi trang công khai (đường dẫn). Thêm route công khai mới (src/routes.ts) ⇒ thêm đường dẫn vào đây.
// Trang có tham số (vd /san-pham/<slug>): dùng một slug có thật trong dữ liệu mẫu.
const PAGES = ['/']
const FACEBOOK_BOT = { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }
const metaTag = (html: string, key: 'name' | 'property', value: string) =>
  new RegExp(`<meta[^>]*${key}="${value}"[^>]*content="([^"]*)"|<meta[^>]*content="([^"]*)"[^>]*${key}="${value}"`).exec(html)?.slice(1).find(Boolean)

test.describe('seo', () => {
  test.use({ javaScriptEnabled: false }) // như bot xem trước link: không chạy JS

  for (const path of PAGES) {
    test(`seo: ${path} có title, mô tả, canonical, Open Graph và đúng một h1 ngay trong HTML (tắt JS)`, async ({ page }) => {
      const res = await page.goto(path)
      expect(res?.status()).toBe(200)
      await expect(page.locator('h1')).toHaveCount(1)
      expect(await page.title()).not.toBe('')
      const content = (selector: string) => page.locator(selector).first().getAttribute('content')
      expect(await content('meta[name="description"]')).toBeTruthy()
      expect(await content('meta[property="og:title"]')).toBeTruthy()
      expect(await content('meta[property="og:description"]')).toBeTruthy()
      const ogUrl = await content('meta[property="og:url"]')
      expect(await content('meta[property="og:image"]')).toMatch(/^https?:\/\//) // địa chỉ tuyệt đối
      expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(ogUrl)
    })

    test(`seo: ${path} bot Facebook (không JS, user-agent riêng) vẫn thấy og:title, og:image, canonical`, async ({ request }) => {
      const html = await (await request.get(path, { headers: FACEBOOK_BOT })).text()
      expect(metaTag(html, 'property', 'og:title')).toBeTruthy()
      expect(metaTag(html, 'property', 'og:image')).toMatch(/^https?:\/\//)
      expect(html).toMatch(/<link[^>]*rel="canonical"/)
    })
  }

  test('seo: đường dẫn không có thật trả 404 thật, không cho Google ghi nhận', async ({ request }) => {
    const res = await request.get('/trang-khong-co-that')
    expect(res.status()).toBe(404)
    expect(await res.text()).toContain('name="robots" content="noindex"')
  })

  test('seo: robots.txt chặn khu riêng và chỉ đường tới sitemap.xml', async ({ request }) => {
    const res = await request.get('/robots.txt')
    expect(res.status()).toBe(200)
    const robots = await res.text()
    expect(robots).toMatch(/Disallow: \/admin/)
    expect(robots).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/)
  })

  test('seo: sitemap.xml sinh từ route, có trang công khai, không có khu riêng', async ({ request }) => {
    const res = await request.get('/sitemap.xml')
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('xml')
    const xml = await res.text()
    expect(xml).toMatch(/<loc>https?:\/\//)
    for (const path of PAGES) expect(xml).toContain(`${path}</loc>`)
    expect(xml).not.toContain('/admin')
    expect(xml).not.toContain('/sitemap.xml') // route không phải trang (sitemap, robots) không vào sitemap
    expect(xml).not.toContain('/robots.txt')
  })

  test('seo: header bảo mật có trên phản hồi thật của Worker (CSP có nonce, nosniff, chống nhúng) — cả trang, 404 và khu riêng', async ({ request }) => {
    const page = await request.get('/')
    const csp = page.headers()['content-security-policy'] ?? ''
    const nonce = /script-src[^;]*'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce, 'script-src phải có nonce').toBeTruthy()
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).toMatch(/frame-ancestors 'none'/)
    expect(await page.text()).toContain(`nonce="${nonce}"`) // script nội tuyến của trang mang đúng nonce của header
    expect(page.headers()['x-content-type-options']).toBe('nosniff')
    expect(page.headers()['x-frame-options']).toBe('DENY')
    expect(page.headers()['referrer-policy']).toBeTruthy()
    for (const path of ['/trang-khong-co-that', '/robots.txt']) {
      const res = await request.get(path)
      expect(res.headers()['content-security-policy'], `${path} thiếu CSP`).toMatch(/nonce-/)
      expect(res.headers()['x-content-type-options'], `${path} thiếu nosniff`).toBe('nosniff')
    }
    const admin = await request.get('/admin')
    expect(admin.headers()['x-robots-tag']).toContain('noindex')
    expect(admin.headers()['cache-control']).toContain('no-store')
  })
})

// Bật JS: CSP không được chặn script nội tuyến của trang (lỗi này chỉ lộ ở bản build, dev không thấy: trang hiện nhưng bấm không được).
test('seo: bật JS, CSP không chặn script nào của trang', async ({ page }) => {
  const blocked: string[] = []
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) blocked.push(m.text()) })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  expect(blocked).toEqual([])
})
