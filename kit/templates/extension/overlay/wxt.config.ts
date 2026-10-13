import { defineConfig } from 'wxt'

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  // Bản build (và zip) ra thư mục dist/ như web: máy kiểm tìm manifest, quét khoá bí mật và đo dung lượng ở đó.
  // Bản chạy thử (dev) ra dist/.-dev để khỏi đè bản build.
  outDir: 'dist',
  outDirTemplate: '.{{modeSuffix}}',
  modules: ['@wxt-dev/module-react'],
  // Xem thử popup ở http://localhost:{{PORT}}/src/entrypoints/popup/index.html. Cổng lấy từ biến PORT (mặc định {{PORT}}): chạy song song nhiều bản thì mỗi bản một PORT.
  dev: { server: { port: Number(process.env.PORT) || {{PORT}}, strictPort: true } },
  // Không tự mở trình duyệt khi chạy `dev`.
  webExt: { disabled: true },
  manifest: {
    name: '{{APP_NAME}}',
    description: '{{APP_NAME}}',
    // Quyền TỐI THIỂU: chưa xin quyền nào (không khai permissions). Thêm quyền ⇒ hỏi người dùng và ghi lý do vào AI_RULES.md.
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self';" },
  },
})
