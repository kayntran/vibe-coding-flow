import { defineConfig } from '@playwright/test'

// Kiểm popup của extension ĐÃ BUILD (thư mục dist/): `{{PM_RUN}} test:e2e` build trước rồi chạy test.
export default defineConfig({
  testDir: 'e2e',
  reporter: 'list',
  fullyParallel: false,
  workers: 1,
})
