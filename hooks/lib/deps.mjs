// deps: cổng thư viện mới (AC-38). Tìm package/module MỚI trong diff package.json / go.mod, rồi kiểm từng cái:
// có thật không (npm registry, proxy.golang.org), đủ tuổi chưa, tên có giống package phổ biến không (AI bịa ~20% tên;
// kẻ xấu đăng ký sẵn tên bịa/gõ nhầm), có lỗ hổng/mã độc đã biết không (OSV).
// Node built-in (fetch có sẵn), không package ngoài. Mạng lỗi/quá hạn ⇒ status 'unknown' (không chặn, không ném) — người gọi phải báo ra.
// CLI: hooks/deps-check.mjs. Người dùng chính: flow-gate (commit có package mới), skill flow-*.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export const DEFAULT_MIN_AGE_DAYS = 7
export const MAX_TIMEOUT_MS = 8000 // trần cho MỖI request

const NPM_REGISTRY = 'https://registry.npmjs.org/'
const GO_PROXY = 'https://proxy.golang.org/'
const OSV_QUERY = 'https://api.osv.dev/v1/query'
const DAY = 86400000

// ---------- tên phổ biến (để bắt tên gõ nhầm / tên bịa giống tên thật) ----------
// Cách lấy (2026-10-11), đều từ nguồn công khai, xếp theo số lần xuất hiện:
//  - npm: lấy 5.013 repo GitHub nhiều sao nhất, chưa archive (search API: language:typescript|javascript + topic nextjs, react, vue,
//    svelte, astro, nuxt, vite, tailwindcss, supabase, express, nodejs, chrome-extension, shadcn-ui, trpc, prisma, stripe, firebase,
//    electron, react-native, cloudflare-workers, sveltekit, remix, fastify, nestjs), đọc package.json ở gốc từng repo (4.102 repo có),
//    đếm số repo khai báo mỗi package (dependencies + dev + peer + optional) ⇒ 500 tên đứng đầu; bỏ tên không có trên registry.
//    Chọn cách này thay vì top lượt tải (wooorm/npm-high-impact) vì top tải toàn đồ lót nội bộ (ms, ansi-regex…) và thiếu
//    next/vite/tailwindcss/supabase-js — đúng thứ AI hay thêm.
//  - Go: 938 repo Go nhiều sao nhất, chưa archive (language:go), đọc go.mod bản mới nhất qua proxy.golang.org/…/@v/<ver>.mod (688 repo
//    có require), đếm số go.mod yêu cầu mỗi module (kể cả indirect), bỏ hậu tố /vN ⇒ 200 module đứng đầu.
// Kiểm bằng tay được: chạy lại truy vấn trên. Không phải danh sách chặn — chỉ là mốc so tên.
const words = (s) => Object.freeze(s.trim().split(/\s+/))
export const NPM_POPULAR = words(`
  typescript eslint @types/node prettier react react-dom husky @types/react vitest tailwindcss eslint-config-prettier
  lint-staged vite @types/react-dom @typescript-eslint/parser @typescript-eslint/eslint-plugin postcss jest zod
  rimraf cross-env autoprefixer eslint-plugin-import tsx eslint-plugin-prettier clsx @eslint/js @babel/core
  @types/jest tailwind-merge globals ts-node typescript-eslint eslint-plugin-react dotenv next @playwright/test turbo
  @commitlint/cli jsdom lucide-react @commitlint/config-conventional class-variance-authority express @changesets/cli
  @babel/preset-env vue rollup webpack axios eslint-plugin-react-hooks @vitest/coverage-v8 semver lodash esbuild
  concurrently prettier-plugin-tailwindcss ts-jest eslint-config-next oxlint @biomejs/biome tslib mocha fs-extra sass
  date-fns chalk @testing-library/react uuid glob @tailwindcss/typography sharp @vitejs/plugin-react
  @testing-library/jest-dom @radix-ui/react-slot babel-loader oxfmt svelte @radix-ui/react-dialog @tailwindcss/vite
  @tailwindcss/postcss next-themes prisma @types/express css-loader webpack-cli @prisma/client react-hook-form rxjs
  @radix-ui/react-dropdown-menu tailwindcss-animate npm-run-all eslint-plugin-jsx-a11y chai sonner
  @radix-ui/react-label @types/lodash @tanstack/react-query marked playwright babel-eslint electron wrangler dayjs
  @rollup/plugin-node-resolve remark-gfm @radix-ui/react-tooltip js-yaml supertest prettier-plugin-svelte sinon
  tw-animate-css vue-tsc ws @hookform/resolvers vue-router babel-jest @radix-ui/react-select ts-loader
  @changesets/changelog-github @radix-ui/react-popover @babel/preset-react jest-environment-jsdom reflect-metadata
  astro lerna nodemon yaml @vitejs/plugin-vue fastify knip @radix-ui/react-tabs cmdk execa eslint-plugin-promise
  style-loader @rollup/plugin-commonjs @types/semver eslint-plugin-jest @babel/preset-typescript moment
  electron-builder eslint-plugin-vue react-markdown svelte-check core-js zustand @testing-library/user-event
  commander pg @radix-ui/react-avatar c8 @types/ws framer-motion stylelint @radix-ui/react-separator @sveltejs/kit
  sass-loader react-router-dom @nestjs/common @radix-ui/react-switch nanoid @babel/runtime @eslint/eslintrc
  jsonwebtoken @babel/cli @nestjs/core prop-types shiki @types/fs-extra @testing-library/dom i18next motion
  babel-core nuxt happy-dom nyc webpack-dev-server @vitest/ui recharts eslint-import-resolver-typescript
  @sveltejs/vite-plugin-svelte ai stripe @swc/core @types/supertest chokidar graphql html-webpack-plugin yargs
  @tailwindcss/forms @vercel/analytics drizzle-orm @radix-ui/react-scroll-area @nestjs/testing @trpc/server cors
  node-fetch @radix-ui/react-accordion ajv eslint-plugin-svelte nodemailer @radix-ui/react-checkbox gulp react-icons
  tsconfig-paths typedoc @radix-ui/react-alert-dialog body-parser classnames copy-webpack-plugin tsup
  @supabase/supabase-js dompurify drizzle-kit react-native react-test-renderer terser @vueuse/core file-loader
  simple-git-hooks vaul prettier-plugin-astro publint @eslint/compat @trpc/client @types/uuid eslint-plugin-node
  karma @types/bun minimist oxlint-tsgolint vite-tsconfig-paths webpack-bundle-analyzer puppeteer debug
  eslint-config-standard nx react-i18next @babel/eslint-parser react-day-picker semantic-release @antfu/eslint-config
  eslint-plugin-jsdoc highlight.js @rollup/plugin-terser openai @faker-js/faker tsdown @aws-sdk/client-s3
  @nestjs/platform-express lodash-es bcryptjs katex markdown-it react-redux superjson jquery patch-package undici
  @babel/plugin-transform-runtime redux @modelcontextprotocol/sdk cookie-parser pinia @astrojs/check cheerio
  mini-css-extract-plugin @cloudflare/workers-types @radix-ui/react-collapsible @radix-ui/react-toast @types/eslint
  @vue/test-utils url-loader @types/mocha compression cypress fastify-plugin mongoose webpack-merge @astrojs/sitemap
  @rollup/plugin-babel @rollup/plugin-replace eslint-plugin-simple-import-sort dotenv-cli fuse.js
  @radix-ui/react-slider class-validator less postcss-loader @radix-ui/react-radio-group embla-carousel-react helmet
  jszip @headlessui/react commitizen electron-updater fast-glob @types/js-yaml passport shelljs vue-template-compiler
  @radix-ui/react-progress karma-chrome-launcher react-router @babel/plugin-proposal-class-properties @types/jsdom
  neostandard shadcn @rollup/plugin-typescript @types/pg cssnano morgan prismjs react-resizable-panels bumpp
  cz-conventional-changelog firebase npm-run-all2 release-it better-sqlite3 class-transformer diff
  eslint-config-airbnb qrcode storybook terser-webpack-plugin unist-util-visit winston next-auth tslint unified
  @tanstack/react-table coveralls mermaid mkdirp tstyche @radix-ui/react-hover-card @types/chrome @types/jsonwebtoken
  @types/lodash-es inquirer ora source-map-support @rollup/plugin-json @trpc/react-query vue-i18n @remix-run/react
  del @babel/register @ianvs/prettier-plugin-sort-imports eslint-plugin-n ioredis jiti pretty-quick @remix-run/dev
  @semantic-release/git vitepress @ai-sdk/openai @dnd-kit/core @nestjs/schematics @vitest/browser-playwright
  better-auth cross-spawn eslint-plugin-unused-imports hono stylelint-config-standard @emotion/react
  @types/nodemailer lefthook minimatch rollup-plugin-terser vue-loader @base-ui/react @dnd-kit/sortable
  @radix-ui/react-navigation-menu @radix-ui/react-toggle @tiptap/starter-kit gray-matter lru-cache
  @stylistic/eslint-plugin eslint-plugin-react-refresh tar @radix-ui/react-icons @types/chai cookie
  eslint-plugin-standard fflate http-server isbot nprogress pino postcss-import wait-on @nestjs/cli @octokit/rest
  buffer echarts monaco-editor node-sass qs radix-ui rollup-plugin-visualizer socket.io archiver multer pino-pretty
  rehype-slug vuex @astrojs/mdx conventional-changelog-cli file-saver react-syntax-highlighter remark-math
  @semantic-release/changelog codemirror globby input-otp resend styled-components uglify-js @arethetypeswrong/cli
  @heroicons/react bootstrap crypto-js eslint-config-airbnb-base react-dropzone swr turndown type-fest
  @codemirror/view @radix-ui/react-toggle-group babel-plugin-react-compiler babel-preset-es2015 svelte-preprocess
  @codemirror/state @radix-ui/react-context-menu @types/better-sqlite3 server-only typeorm @astrojs/rss @tiptap/pm
  @vue/compiler-sfc pkg-pr-new @remix-run/node @remix-run/serve @t3-oss/env-nextjs @tanstack/react-virtual ejs
  eslint-plugin-html picocolors remark-parse svgo three tinyglobby unocss @emotion/styled @sveltejs/adapter-auto
  @sveltejs/adapter-static @tauri-apps/cli @types/debug acorn babel-plugin-module-resolver chart.js
  eslint-plugin-unicorn express-session msw prettier-plugin-organize-imports raw-loader @angular/core
  @babel/plugin-transform-modules-commonjs @dnd-kit/utilities @nestjs/swagger @trpc/next
  @types/react-syntax-highlighter @types/sinon daisyui express-rate-limit js-cookie open react-hot-toast
  rehype-autolink-headings start-server-and-test ts-morph @radix-ui/react-aspect-ratio @types/react-test-renderer
  consola eslint-plugin-astro eslint-plugin-import-x eslint-plugin-tailwindcss jose passport-jwt pdfjs-dist
  @nestjs/config @stripe/stripe-js @types/cors @types/yargs @typescript/native-preview babel-preset-env bcrypt
`)
export const GO_POPULAR = words(`
  golang.org/x/sys golang.org/x/net golang.org/x/text golang.org/x/crypto github.com/stretchr/testify
  golang.org/x/sync gopkg.in/yaml.v3 github.com/mattn/go-isatty github.com/google/uuid google.golang.org/protobuf
  github.com/davecgh/go-spew github.com/pkg/errors github.com/spf13/pflag github.com/pmezard/go-difflib
  github.com/cespare/xxhash golang.org/x/tools golang.org/x/time golang.org/x/term github.com/mattn/go-colorable
  golang.org/x/mod google.golang.org/grpc golang.org/x/oauth2 github.com/klauspost/compress github.com/spf13/cobra
  github.com/go-logr/logr github.com/google/go-cmp github.com/sirupsen/logrus github.com/fsnotify/fsnotify
  github.com/prometheus/client_golang golang.org/x/exp github.com/inconshreveable/mousetrap
  github.com/json-iterator/go go.yaml.in/yaml github.com/mattn/go-runewidth github.com/prometheus/client_model
  github.com/prometheus/common github.com/prometheus/procfs go.opentelemetry.io/otel github.com/modern-go/reflect2
  go.opentelemetry.io/otel/trace github.com/modern-go/concurrent github.com/beorn7/perks
  google.golang.org/genproto/googleapis/rpc github.com/fatih/color github.com/go-logr/stdr github.com/golang/protobuf
  go.opentelemetry.io/otel/metric gopkg.in/yaml.v2 github.com/gorilla/websocket github.com/felixge/httpsnoop
  github.com/pelletier/go-toml github.com/munnerz/goautoneg github.com/golang-jwt/jwt go.uber.org/multierr
  go.opentelemetry.io/auto/sdk go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
  github.com/dustin/go-humanize github.com/spf13/cast google.golang.org/genproto/googleapis/api
  github.com/cenkalti/backoff github.com/rivo/uniseg github.com/gogo/protobuf go.uber.org/zap
  github.com/Microsoft/go-winio github.com/klauspost/cpuid github.com/spf13/afero go.opentelemetry.io/otel/sdk
  sigs.k8s.io/yaml github.com/go-openapi/jsonpointer google.golang.org/genproto github.com/hashicorp/golang-lru
  github.com/opencontainers/go-digest github.com/russross/blackfriday github.com/aws/aws-sdk-go-v2
  github.com/mitchellh/go-homedir github.com/mitchellh/mapstructure cloud.google.com/go/compute/metadata
  github.com/aws/smithy-go github.com/aws/aws-sdk-go-v2/credentials k8s.io/apimachinery
  github.com/aws/aws-sdk-go-v2/internal/configsources github.com/aws/aws-sdk-go-v2/internal/endpoints
  github.com/go-openapi/swag github.com/go-viper/mapstructure github.com/opencontainers/image-spec
  github.com/Masterminds/semver google.golang.org/api github.com/aws/aws-sdk-go-v2/config
  github.com/aws/aws-sdk-go-v2/service/internal/presigned-url github.com/spf13/viper k8s.io/klog
  github.com/aws/aws-sdk-go-v2/feature/ec2/imds github.com/aws/aws-sdk-go-v2/service/sso
  github.com/aws/aws-sdk-go-v2/service/sts github.com/go-openapi/jsonreference github.com/grpc-ecosystem/grpc-gateway
  github.com/hashicorp/go-multierror go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc
  k8s.io/client-go github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding
  github.com/aws/aws-sdk-go-v2/service/ssooidc github.com/googleapis/gax-go k8s.io/utils github.com/go-jose/go-jose
  github.com/googleapis/enterprise-certificate-proxy github.com/BurntSushi/toml github.com/golang/groupcache
  github.com/google/s2a-go gopkg.in/inf.v0 github.com/hashicorp/errwrap gopkg.in/ini.v1 k8s.io/api
  github.com/stretchr/objx github.com/golang/snappy github.com/docker/go-units github.com/x448/float16
  github.com/mailru/easyjson github.com/fxamacker/cbor go.opentelemetry.io/proto/otlp cloud.google.com/go/auth
  github.com/cpuguy83/go-md2man github.com/go-ole/go-ole github.com/subosito/gotenv go.uber.org/atomic
  github.com/lucasb-eyer/go-colorful sigs.k8s.io/structured-merge-diff github.com/lib/pq
  github.com/go-sql-driver/mysql github.com/gorilla/mux k8s.io/kube-openapi github.com/google/go-querystring
  github.com/kylelemons/godebug sigs.k8s.io/json dario.cat/mergo github.com/hashicorp/go-cleanhttp
  github.com/rogpeppe/go-internal github.com/tidwall/gjson github.com/tidwall/pretty github.com/tidwall/match
  cloud.google.com/go/auth/oauth2adapt github.com/docker/go-connections cloud.google.com/go github.com/goccy/go-json
  github.com/emicklei/go-restful github.com/aws/aws-sdk-go-v2/internal/v4a github.com/shirou/gopsutil cel.dev/expr
  github.com/miekg/dns go.opentelemetry.io/otel/sdk/metric github.com/pierrec/lz4 github.com/clipperhouse/uax29
  github.com/moby/term go.opentelemetry.io/otel/exporters/otlp/otlptrace github.com/google/pprof
  github.com/google/btree github.com/Azure/go-ansiterm github.com/distribution/reference
  github.com/hashicorp/go-version github.com/josharian/intern github.com/pkg/browser
  github.com/aws/aws-sdk-go-v2/service/signin github.com/coreos/go-systemd github.com/dlclark/regexp2
  github.com/google/gnostic-models github.com/mattn/go-sqlite3 github.com/yusufpapurcu/wmi filippo.io/edwards25519
  github.com/andybalholm/brotli github.com/tklauser/go-sysconf github.com/hashicorp/hcl
  github.com/magiconair/properties cloud.google.com/go/iam github.com/tklauser/numcpus
  github.com/sagikazarmark/locafero github.com/shopspring/decimal github.com/gabriel-vasile/mimetype
  github.com/leodido/go-urn go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc
  github.com/go-playground/locales github.com/go-playground/universal-translator github.com/mitchellh/copystructure
  github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream github.com/kr/pretty gopkg.in/evanphx/json-patch.v4
  github.com/blang/semver github.com/planetscale/vtprotobuf github.com/robfig/cron github.com/containerd/errdefs
  github.com/go-playground/validator github.com/mitchellh/reflectwalk github.com/onsi/ginkgo
  github.com/remyoudompheng/bigfft github.com/urfave/cli github.com/cloudflare/circl github.com/onsi/gomega
  github.com/power-devops/perfstat modernc.org/mathutil sigs.k8s.io/randfill github.com/jmespath/go-jmespath
  github.com/sergi/go-diff
`)

// '@scope/tên' → ['@scope', 'tên']; không scope → ['', tên].
const splitScope = (s) => {
  const i = s.startsWith('@') ? s.indexOf('/') : -1
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : ['', s]
}
const POPULAR = {
  npm: NPM_POPULAR.map((n) => [n.toLowerCase(), n]),
  go: GO_POPULAR.map((n) => [n.toLowerCase(), n]),
}

// Khoảng cách chỉnh sửa (thêm/bớt/đổi 1 ký tự), hoán đổi hai ký tự kề nhau tính 1 (lodahs ↔ lodash).
export function distance(a, b) {
  const m = a.length
  const n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[m][n]
}

// Tên ngắn dễ trùng hợp (chalk ~ chai) ⇒ chặt hơn: ≤4 ký tự không so; 5–7 lệch ≤1; ≥8 lệch ≤2.
const maxDistance = (len) => (len <= 4 ? 0 : len <= 7 ? 1 : 2)

// Tên phổ biến GẦN NHẤT (khác tên đang xét) hoặc undefined. Đúng tên phổ biến ⇒ undefined (nó chính là hàng thật).
// Cùng scope (@types/ms ~ @types/ws) thì chỉ so phần sau scope bằng độ dài của nó; khác scope (@typse/node) so cả chuỗi.
export function nearPopular(eco, name) {
  const list = POPULAR[eco]
  if (!list) return undefined
  const n = (eco === 'go' ? name.replace(/\/v\d+$/, '') : name).toLowerCase()
  if (list.some(([lower]) => lower === n)) return undefined
  const [scope, rest] = splitScope(n)
  let best
  let bestD = Infinity
  for (const [lower, original] of list) {
    const [pScope, pRest] = splitScope(lower)
    const [a, b] = scope && scope === pScope ? [rest, pRest] : [n, lower]
    const max = maxDistance(a.length)
    if (Math.abs(a.length - b.length) > max) continue
    const d = distance(a, b)
    if (d <= max && d < bestD) { best = original; bestD = d }
  }
  return best
}

// ---------- phiên bản (semver tối thiểu: đủ để biết bản nào sẽ được cài) ----------
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.+-]*)?$/
const parseV = (v) => {
  const m = SEMVER.exec(v)
  return m && { n: [+m[1], +m[2], +m[3]], pre: m[4] }
}
const cmpNum = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const cmpV = (a, b) => cmpNum(a.n, b.n) || (a.pre === b.pre ? 0 : !a.pre ? 1 : !b.pre ? -1 : a.pre < b.pre ? -1 : 1)
const RANGE = /^([\^~]?)\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/

// Bản mà `npm install` sẽ chọn cho `spec`: đúng bản / ^ / ~ / 1.x / tag. Khoảng phức tạp (>=, ||, " - ") ⇒ latest (xấp xỉ).
// Không bản nào khớp ⇒ null (AI ghi bản không có thật).
export function resolveVersion(spec, versions, tags = {}) {
  const s = String(spec ?? '').trim()
  if (s === '' || s === '*' || s === 'x' || s === 'X') return tags.latest ?? null
  const exact = s.replace(/^[=v]+/, '')
  if (parseV(exact)) return versions.includes(exact) ? exact : null
  if (Object.hasOwn(tags, s)) return tags[s]
  const m = RANGE.exec(s)
  if (!m) return tags.latest ?? null
  const parts = []
  for (const p of m.slice(2)) {
    if (p === undefined || /[xX*]/.test(p)) break
    parts.push(+p)
  }
  if (!parts.length) return tags.latest ?? null
  let idx
  if (m[1] === '^') {
    idx = parts.findIndex((x) => x !== 0)
    if (idx < 0) idx = parts.length - 1
  } else if (m[1] === '~') idx = parts.length === 1 ? 0 : 1
  else idx = parts.length - 1
  const lower = [parts[0], parts[1] ?? 0, parts[2] ?? 0]
  const upper = [0, 0, 0]
  for (let i = 0; i < idx; i++) upper[i] = parts[i]
  upper[idx] = parts[idx] + 1
  let best = null
  let bestV
  for (const v of versions) {
    const p = parseV(v)
    if (!p || p.pre || cmpNum(p.n, lower) < 0 || cmpNum(p.n, upper) >= 0) continue
    if (!bestV || cmpV(p, bestV) > 0) { best = v; bestV = p }
  }
  return best
}

// ---------- đọc package.json / go.mod ----------
const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const LOCAL_SPEC = /^(?:file|link|workspace|portal):|^\.{0,2}\//
const GIT_SPEC = /^(?:git(?:\+[a-z]+)?:|ssh:|git@|github:|gitlab:|bitbucket:|gist:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/i
const ALIAS_SPEC = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@(.*))?$/

function npmEntry(dep, spec) {
  if (typeof spec !== 'string') return null
  const s = spec.trim()
  if (LOCAL_SPEC.test(s)) return null // thư mục trong máy, không qua registry
  const alias = ALIAS_SPEC.exec(s)
  if (alias) return { name: alias[1], version: alias[2] || 'latest' }
  if (GIT_SPEC.test(s)) return { name: dep, version: s, source: 'git' }
  if (/^https?:/i.test(s)) return { name: dep, version: s, source: 'url' }
  return { name: dep, version: s }
}

// Chỉ 4 khối dependencies/devDependencies/peerDependencies/optionalDependencies (overrides, scripts… không phải thư viện thêm vào).
function parsePackageJson(text) {
  const json = JSON.parse(text)
  const out = new Map()
  for (const section of NPM_SECTIONS) {
    const block = json?.[section]
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [dep, spec] of Object.entries(block)) {
      const e = npmEntry(dep, spec)
      if (e && !out.has(e.name)) out.set(e.name, e)
    }
  }
  return [...out.values()]
}

// `require` (khối hoặc một dòng); bỏ `// indirect` (go tự thêm khi kéo module khác — osv-scanner lo phần chuỗi phụ thuộc),
// bỏ replace/exclude/retract. Giữ nguyên hậu tố /vN trong tên (đường dẫn proxy cần).
export function parseGoMod(text) {
  const out = []
  let inRequire = false
  let inOther = false
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (inRequire || inOther) {
      if (line.startsWith(')')) { inRequire = inOther = false; continue }
      if (inRequire) addGoRequire(out, line)
      continue
    }
    if (/^require\s*\(/.test(line)) inRequire = true
    else if (/^(?:replace|exclude|retract|tool|godebug|ignore)\s*\(/.test(line)) inOther = true
    else if (/^require\s/.test(line)) addGoRequire(out, line.replace(/^require\s+/, ''))
  }
  return out
}
function addGoRequire(out, line) {
  if (!line || line.startsWith('//')) return
  const [spec, comment = ''] = line.split('//')
  if (/^\s*indirect\b/.test(comment)) return
  const m = /^"?([^\s"]+)"?\s+(v\S+)/.exec(spec.trim())
  if (m) out.push({ name: m[1], version: m[2] })
}

// ---------- git ----------
function git(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, windowsHide: true })
  if (r.error) throw new Error(`không chạy được git (${r.error.code ?? r.error.message})`)
  return r
}
const gitOrThrow = (repo, args, what) => {
  const r = git(repo, args)
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || '').trim().split('\n')[0] || `git thoát mã ${r.status}`}`)
  return r.stdout
}
const treeOf = (repo, ref) => {
  if (ref.startsWith('-')) throw new Error(`mốc git không hợp lệ "${ref}"`)
  const r = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`])
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`không tìm thấy mốc git "${ref}" trong ${repo}`)
  return r.stdout.trim()
}
const MANIFEST = { 'package.json': 'npm', 'go.mod': 'go' }
const manifestEco = (file) => {
  const parts = file.split('/')
  if (parts.includes('node_modules') || parts.includes('vendor')) return null
  return MANIFEST[parts.at(-1)] ?? null
}
const parseManifest = (eco, text) => (eco === 'npm' ? parsePackageJson(text) : parseGoMod(text))
const blobAt = (repo, treeish, file) => {
  const r = git(repo, ['cat-file', 'blob', treeish === ':' ? `:${file}` : `${treeish}:${file}`])
  return r.status === 0 ? r.stdout : null
}

/**
 * Package/module mới giữa `base` và `head` trong repo git `repo` (so cả repo: tên đã dùng ở workspace khác không tính mới).
 * base null/'' = repo trống (mọi thứ đều mới). head ':' = bản đã `git add` (cổng commit).
 * Trả [{ eco: 'npm'|'go', name, version, file, source?: 'git'|'url' }]. Mốc git/repo không đọc được hoặc package.json mới hỏng ⇒ ném
 * Error có lời rõ (không trả mảng rỗng như thể sạch); package.json hỏng ở bản gốc ⇒ coi như chưa có gì.
 */
export function newPackages(base, head, repo = '.') {
  repo = path.resolve(repo)
  const top = git(repo, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0) throw new Error(`không đọc được repo git ở ${repo}: ${(top.stderr || '').trim().split('\n')[0]}`)
  const emptyTree = git(repo, ['hash-object', '-t', 'tree', '--stdin'], '').stdout.trim()
  const baseTree = base ? treeOf(repo, base) : emptyTree
  const staged = head === ':'
  const headTree = staged ? ':' : treeOf(repo, head)

  const diffArgs = ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=ACMR']
  if (staged) diffArgs.push('--cached', baseTree)
  else diffArgs.push(baseTree, headTree)
  const changed = gitOrThrow(repo, diffArgs, 'git diff').split('\0').filter((f) => f && manifestEco(f))
  if (!changed.length) return []

  // Tên đã có ở BẤT KỲ package.json/go.mod nào của bản gốc (chỉ đọc hệ có file đổi).
  const known = { npm: new Set(), go: new Set() }
  const ecos = new Set(changed.map(manifestEco))
  if (base) {
    for (const file of gitOrThrow(repo, ['ls-tree', '-r', '--name-only', '-z', baseTree], 'git ls-tree').split('\0')) {
      const eco = file && manifestEco(file)
      const text = ecos.has(eco) && blobAt(repo, baseTree, file)
      if (!text) continue
      try { for (const e of parseManifest(eco, text)) known[eco].add(e.name) } catch { /* bản gốc hỏng ⇒ chưa có gì */ }
    }
  }

  const found = new Map()
  for (const file of changed) {
    const eco = manifestEco(file)
    const text = blobAt(repo, headTree, file)
    if (text === null) continue
    let entries
    try { entries = parseManifest(eco, text) } catch (e) { throw new Error(`${file} hỏng, không đọc được (${e.message})`) }
    for (const e of entries) {
      const k = `${eco}:${e.name}`
      if (!known[eco].has(e.name) && !found.has(k)) found.set(k, { eco, ...e, file })
    }
  }
  return [...found.values()]
}

// ---------- mạng ----------
// Một request có hạn chót cứng (cả đọc thân) — không phụ thuộc fetch có tôn trọng signal hay không.
async function request(fetchFn, url, init, timeoutMs) {
  const ctl = new AbortController()
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new Error('timeout')) }, timeoutMs)
  })
  expired.catch(() => {})
  try {
    const res = await Promise.race([fetchFn(url, { ...init, signal: ctl.signal }), expired])
    const text = await Promise.race([res.text(), expired])
    return { status: res.status, text }
  } catch (e) {
    return { status: 0, error: e?.message === 'timeout' ? 'hết thời gian chờ' : 'không kết nối được' }
  } finally {
    clearTimeout(timer)
  }
}
const why = (what, r) => `${what}: ${r.error ?? `máy chủ trả ${r.status}`}`
const parseJson = (text) => { try { return JSON.parse(text) } catch { return undefined } }
const ageOf = (ms, now) => Math.max(0, Math.floor((now - ms) / DAY))

const NPM_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i
const GO_PATH = /^[A-Za-z0-9][\w.~-]*(?:\/[\w.~-]+)*$/
const goV = (v) => parseV(v.replace(/^v/, ''))
const goEscape = (p) => p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)

async function queryOsv(res, ctx, ecosystem, version) {
  const r = await ctx.get(OSV_QUERY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package: { name: res.name, ecosystem }, version }),
  })
  const doc = r.status === 200 ? parseJson(r.text) : undefined
  if (doc === undefined) { res.unknown.push(why('OSV (cơ sở dữ liệu lỗ hổng)', r.status === 200 ? { error: 'dữ liệu không đọc được' } : r)); return }
  const vulns = Array.isArray(doc?.vulns) ? doc.vulns : []
  for (const v of vulns) {
    res.vulns.push({ id: String(v.id), summary: String(v.summary ?? v.details ?? '').slice(0, 200), severity: v.database_specific?.severity })
  }
  if (vulns.length) {
    const ids = res.vulns.slice(0, 5).map((v) => v.id).join(', ')
    res.problems.push(`có lỗ hổng/mã độc đã biết (${ids}${vulns.length > 5 ? `, +${vulns.length - 5}` : ''})`)
  }
}

async function vetNpm(res, ctx) {
  if (!NPM_NAME.test(res.name) || res.name.length > 214) { res.exists = false; res.problems.push(`"${res.name}" không phải tên package hợp lệ`); return }
  if (res.source) { // git/URL/tarball: không qua registry nên không kiểm được ⇒ bad, trừ mục "tên@nguồn" user đã duyệt (flow.json trustedDepSources): đổi nguồn là phải duyệt lại
    if (!ctx.trusted.has(`${res.name}@${res.version}`)) res.problems.push('nguồn ngoài kho chính thức, chưa kiểm chứng')
    return
  }
  const r = await ctx.get(`${NPM_REGISTRY}${res.name.replace('/', '%2F')}`, { headers: { accept: 'application/json' } })
  if (r.status === 404) { res.exists = false; res.problems.push(`"${res.name}" không có trên npm (có thể là tên AI bịa)`); return }
  const doc = r.status === 200 ? parseJson(r.text) : undefined
  if (!doc || typeof doc !== 'object') { res.unknown.push(why('npm registry', r.status === 200 ? { error: 'dữ liệu không đọc được' } : r)); return }
  const versions = Object.keys(doc.versions ?? {})
  if (!versions.length) { res.exists = false; res.problems.push(`"${res.name}" đã bị gỡ khỏi npm (không còn phiên bản nào)`); return }
  res.exists = true
  const created = Date.parse(doc.time?.created)
  if (Number.isFinite(created)) res.ageDays = ageOf(created, ctx.now)
  else res.unknown.push('npm không cho biết ngày tạo package')
  res.resolved = resolveVersion(res.version, versions, doc['dist-tags'] ?? {})
  if (res.resolved === null) { res.problems.push(`không có phiên bản nào khớp "${res.version}" trên npm`); return }
  await queryOsv(res, ctx, 'npm', res.resolved)
}

async function vetGo(res, ctx) {
  if (!GO_PATH.test(res.name) || res.name.split('/').some((s) => s === '.' || s === '..')) {
    res.exists = false
    res.problems.push(`"${res.name}" không phải đường dẫn module hợp lệ`)
    return
  }
  const base = `${GO_PROXY}${goEscape(res.name)}`
  const list = await ctx.get(`${base}/@v/list`)
  if (list.status === 404 || list.status === 410) {
    res.exists = false
    res.problems.push(`"${res.name}" không có trên proxy.golang.org (có thể là tên AI bịa)`)
    return
  }
  let tagged = []
  if (list.status === 200) {
    res.exists = true
    tagged = list.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => goV(l))
    tagged.sort((a, b) => cmpV(goV(a), goV(b)))
    // Tuổi = ngày đăng của bản có thẻ cũ nhất còn tải được (thẻ cũ có thể đã bị gỡ ⇒ thử vài bản kế); không có thẻ nào
    // (chỉ pseudo-version) ⇒ bản đang dùng (cận dưới của tuổi module). Mạng đứt (status 0) ⇒ dừng, không thử tiếp.
    const tries = [...tagged.slice(0, 3), res.version].filter(Boolean)
    let last
    for (const v of tries) {
      last = await ctx.get(`${base}/@v/${goEscape(v)}.info`)
      const time = last.status === 200 ? Date.parse(parseJson(last.text)?.Time) : NaN
      if (Number.isFinite(time)) { res.ageDays = ageOf(time, ctx.now); break }
      if (last.status === 0) break
    }
    if (res.ageDays === null) res.unknown.push(last ? why('proxy.golang.org (ngày đăng)', last.status === 200 ? { error: 'dữ liệu không đọc được' } : last) : 'module chưa có bản nào để tính tuổi')
  } else res.unknown.push(why('proxy.golang.org', list))
  const version = res.version || tagged.at(-1)
  if (!version) { res.unknown.push('không biết phiên bản để tra lỗ hổng'); return }
  res.resolved = version
  await queryOsv(res, ctx, 'Go', version.replace(/^v/, '').replace(/\+incompatible$/, ''))
}

/**
 * Kiểm một package. pkg = { eco: 'npm'|'go', name, version, source? }. opts = { fetch (tiêm khi test), minAgeDays=7, timeoutMs≤8000, now (ms),
 *   trustedSources?: string[] (mục "tên@nguồn" của package nguồn git/URL mà user đã duyệt — flow.json "trustedDepSources", vd "pkg@git+https://host/pkg.git#<sha>";
 *   nguồn phải y hệt chuỗi trong package.json, tên khớp mà nguồn khác ⇒ vẫn bad) }.
 * Trả { ...pkg, status: 'ok'|'bad'|'unknown', exists: true|false|null, ageDays: number|null, nearPopular?: string,
 *   resolved: string|null, vulns: [{id, summary, severity?}], problems: string[], unknown: string[] }.
 * 'bad' = có vấn đề chắc chắn (problems, lời đời thường; gồm nguồn git/URL chưa được duyệt); 'unknown' = không có vấn đề nào chắc chắn nhưng có bước không kiểm được
 * (unknown, thường do mạng) — KHÔNG chặn nhưng phải báo; 'ok' = kiểm đủ, sạch. Không bao giờ ném.
 */
export async function vet(pkg, opts = {}) {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const minAge = opts.minAgeDays ?? DEFAULT_MIN_AGE_DAYS
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || MAX_TIMEOUT_MS, 1), MAX_TIMEOUT_MS)
  const res = { ...pkg, status: 'unknown', exists: null, ageDays: null, nearPopular: undefined, resolved: null, vulns: [], problems: [], unknown: [] }
  const trusted = new Set(Array.isArray(opts.trustedSources) ? opts.trustedSources.filter((n) => typeof n === 'string') : [])
  const ctx = { now: opts.now ?? Date.now(), trusted, get: (url, init) => request(fetchFn, url, init, timeoutMs) }
  try {
    res.nearPopular = nearPopular(pkg.eco, pkg.name)
    if (pkg.eco === 'npm') await vetNpm(res, ctx)
    else if (pkg.eco === 'go') await vetGo(res, ctx)
    else res.unknown.push(`chưa hỗ trợ hệ "${pkg.eco}"`)
    if (res.ageDays !== null && res.ageDays < minAge) res.problems.push(`mới đăng ${res.ageDays} ngày (cần từ ${minAge} ngày trở lên)`)
    if (res.nearPopular) res.problems.push(`tên giống package phổ biến "${res.nearPopular}" (dễ là gõ nhầm hoặc tên giả)`)
  } catch (e) {
    res.unknown.push(`lỗi nội bộ khi kiểm: ${e?.message ?? e}`)
  }
  res.status = res.problems.length ? 'bad' : res.unknown.length ? 'unknown' : 'ok'
  return res
}

/** Kiểm nhiều package, tối đa `concurrency` (mặc định 4) request song song; giữ nguyên thứ tự. */
export async function vetAll(pkgs, opts = {}) {
  const out = new Array(pkgs.length)
  let next = 0
  const worker = async () => {
    while (next < pkgs.length) {
      const i = next++
      out[i] = await vet(pkgs[i], opts)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, pkgs.length) }, worker))
  return out
}
