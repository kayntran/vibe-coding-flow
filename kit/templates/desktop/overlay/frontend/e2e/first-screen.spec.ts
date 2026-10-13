import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('S-01: màn đầu hiện tên app và lời mời làm màn đầu tiên', async ({ page }) => {
  await page.goto('/')
  const screen = page.locator('[data-s="S-01"]')
  await expect(screen).toBeVisible()
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('{{APP_NAME}}')
  await expect(screen).toContainText('Chưa có màn nào')
})

// Tên có chữ "a11y": máy kiểm (flow-check) chạy riêng các test trợ năng bằng playwright test --grep=a11y.
test('S-01: a11y — không có lỗi truy cập (axe)', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-s="S-01"]')).toBeVisible()
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(result.violations).toEqual([])
})
