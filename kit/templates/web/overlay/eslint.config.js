import js from '@eslint/js'
import { plugin as shadcn } from '@shadcn/lint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Luật giao diện shadcn (@shadcn/lint) chạy trong bước eslint: bắt class Tailwind tự chế, màu thô, giá trị tuỳ ý, style inline.
const shadcnRules = {
  'shadcn/no-restyle': ['error', { allow: ['layout'] }],
  'shadcn/no-raw-colors': 'error',
  'shadcn/no-arbitrary-values': 'error',
  'shadcn/no-inline-styles': 'error',
  'shadcn/no-unknown-classes': 'error',
  'shadcn/require-static-classes': 'error',
}

export default defineConfig([
  // test-results / playwright-report: Playwright tạo và xoá thư mục này khi test chạy song song với eslint ⇒ eslint quét trúng thì lỗi ENOENT.
  globalIgnores(['dist', 'test-results', 'playwright-report']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { shadcn },
    rules: {
      'react-refresh/only-export-components': 'off',
      ...shadcnRules,
    },
  },
  {
    // Thành phần do shadcn sinh ra viết theo thiết kế riêng của nó: không soát bằng luật dành cho code của app.
    files: ['src/components/**'],
    rules: Object.fromEntries(Object.keys(shadcnRules).map((rule) => [rule, 'off'])),
  },
])
