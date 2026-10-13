import { defineConfig, devices } from '@playwright/test'

// Cổng lấy từ biến PORT (mặc định 5173), cùng cách với vite.config.ts: chạy song song nhiều bản thì mỗi bản một PORT.
const port = Number(process.env.PORT) || 5173

// Kiểm giao diện trong trình duyệt thường (không có phần Go ⇒ dùng dữ liệu mẫu). Kiểm cả app Wails: chạy `wails dev`.
export default defineConfig({
  testDir: 'e2e',
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: '{{PM_DEV}} --strictPort',
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
  },
})
