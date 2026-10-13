import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // test-results / playwright-report: Playwright tạo và xoá thư mục này khi test chạy song song với eslint ⇒ eslint quét trúng thì lỗi ENOENT.
  globalIgnores(['dist', '.output', '.wxt', 'test-results', 'playwright-report']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Luật React chỉ áp cho code giao diện (e2e/ có tham số `use` của Playwright, không phải hook React).
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
])
