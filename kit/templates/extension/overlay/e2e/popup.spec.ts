import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { chromium, expect, test as base, type BrowserContext } from '@playwright/test'

// Nạp extension đã build vào Chromium thật rồi mở popup như một trang (cách chính thức của Playwright cho extension).
// Chạy từ gốc dự án (`{{PM_RUN}} test:e2e`), nên đường dẫn tính từ thư mục hiện tại.
const extensionPath = resolve('dist')

const test = base.extend<{ context: BrowserContext; popupUrl: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    await use(context)
    await context.close()
  },
  popupUrl: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    await use(`chrome-extension://${worker.url().split('/')[2]}/popup.html`)
  },
})

test('S-01: popup hiện tên app và lời mời làm màn đầu tiên', async ({ context, popupUrl }) => {
  const page = await context.newPage()
  await page.goto(popupUrl)
  const screen = page.locator('[data-s="S-01"]')
  await expect(screen).toBeVisible()
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('{{APP_NAME}}')
  await expect(screen).toContainText('Chưa có màn nào')
})

// Tên có chữ "a11y": máy kiểm (flow-check) chạy riêng các test trợ năng bằng playwright test --grep=a11y.
test('S-01: a11y — không có lỗi truy cập (axe)', async ({ context, popupUrl }) => {
  const page = await context.newPage()
  await page.goto(popupUrl)
  await expect(page.locator('[data-s="S-01"]')).toBeVisible()
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(result.violations).toEqual([])
})

test('extension chưa xin quyền nào', async ({ context, popupUrl }) => {
  const page = await context.newPage()
  const res = await page.goto(popupUrl.replace('popup.html', 'manifest.json'))
  const manifest = await res!.json()
  expect(manifest.permissions ?? []).toEqual([])
  expect(manifest.host_permissions ?? []).toEqual([])
  expect(manifest.content_scripts ?? []).toEqual([])
})
