// stack: nhận ra loại dự án (web / extension / go / wails) và trả lời "checker này có áp dụng cho dự án này không".
// Dùng cho hooks/flow-check.mjs (máy kiểm theo stack, AC-43/AC-11). Chỉ đọc file, không chạy gì.
//
//   detect(dir)  → ['web'|'extension'|'go'|'wails', …]   thứ tự cố định theo STACKS; thư mục không có dấu hiệu nào ⇒ []
//   roots(dir)   → { web?, extension?, go?, wails? }     thư mục (tuyệt đối) nơi checker của stack đó chạy
//                  (Wails: web chạy ở frontend/ nếu gốc không có package.json; extension chạy ở thư mục chứa manifest.json)
//   matches(cond, root) → boolean                         ngôn ngữ `detect` trong kit/checkers.json
//   findManifest(dir) → { dir, file, manifest } | null    manifest.json có manifest_version
//   readPackageJson(dir) → object | null · hasDep(pkg, names) → boolean
//
// `detect` trong checker (tất cả khoá trong cùng một object = VÀ; khoá lạ ⇒ ném lỗi để gõ sai không âm thầm thành "áp dụng"):
//   files: [tên…]       có ít nhất một file/thư mục ở root (cho phép * trong tên, vd "eslint.config.*")
//   deps: [tên…]        có trong dependencies/devDependencies/peerDependencies/optionalDependencies của package.json ở root
//   pkgKeys: [khoá…]    package.json có khoá cấp cao nhất (vd "eslintConfig")
//   grep: {file, re}    file ở root tồn tại và nội dung khớp regex `re` (không phân biệt hoa thường)
//   not: {…} · any: [{…}] · all: [{…}]
import fs from 'node:fs'
import path from 'node:path'

export const STACKS = ['web', 'extension', 'go', 'wails']
export const COND_KEYS = ['files', 'deps', 'pkgKeys', 'grep', 'not', 'any', 'all']

// Nơi hay đặt manifest.json của extension (gốc, public/ của Vite/WXT, src/, thư mục build).
const MANIFEST_DIRS = ['.', 'public', 'src', 'extension', 'dist', 'build', '.output/chrome-mv3']
const EXT_FRAMEWORK_DEPS = ['wxt', 'plasmo']

const exists = (p) => { try { fs.statSync(p); return true } catch { return false } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, '') } catch { return null }
}

function readJson(file) {
  const t = readText(file)
  if (t === null) return null
  try { return JSON.parse(t) } catch { return null }
}

export function readPackageJson(dir) {
  const j = readJson(path.join(dir, 'package.json'))
  return j && typeof j === 'object' ? j : null
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
export function hasDep(pkg, names) {
  if (!pkg) return false
  return DEP_FIELDS.some((f) => pkg[f] && typeof pkg[f] === 'object' && names.some((n) => Object.hasOwn(pkg[f], n)))
}

export function findManifest(dir) {
  for (const rel of MANIFEST_DIRS) {
    const d = path.join(dir, ...rel.split('/'))
    const file = path.join(d, 'manifest.json')
    const manifest = readJson(file)
    if (manifest && typeof manifest === 'object' && 'manifest_version' in manifest) return { dir: d, file, manifest }
  }
  return null
}

function isWails(dir) {
  if (isFile(path.join(dir, 'wails.json'))) return true
  const mod = readText(path.join(dir, 'go.mod'))
  return mod !== null && /github\.com\/wailsapp\/wails/.test(mod)
}

function webRoot(dir, wails) {
  if (isFile(path.join(dir, 'package.json'))) return dir
  const fe = path.join(dir, 'frontend')
  if (wails && isFile(path.join(fe, 'package.json'))) return fe
  return null
}

export function roots(dir) {
  const out = {}
  const wails = isWails(dir)
  const web = webRoot(dir, wails)
  if (web) out.web = web
  const ext = findManifest(dir)
  if (ext) out.extension = ext.dir
  else if (hasDep(readPackageJson(dir), EXT_FRAMEWORK_DEPS)) out.extension = dir
  if (isFile(path.join(dir, 'go.mod'))) out.go = dir
  if (wails) out.wails = dir
  return out
}

export function detect(dir) {
  const r = roots(dir)
  return STACKS.filter((s) => s in r)
}

// --- ngôn ngữ detect của checker -------------------------------------------------------------------------------------------------

function fileExists(root, name) {
  if (!name.includes('*')) return exists(path.join(root, name))
  const re = new RegExp(`^${name.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  try { return fs.readdirSync(root).some((f) => re.test(f)) } catch { return false }
}

export function matches(cond, root) {
  if (cond === undefined || cond === null) return true
  if (typeof cond !== 'object' || Array.isArray(cond)) throw new TypeError('detect phải là object')
  for (const k of Object.keys(cond)) if (!COND_KEYS.includes(k)) throw new RangeError(`detect có khoá lạ "${k}" (hợp lệ: ${COND_KEYS.join(', ')})`)
  if (cond.files && !cond.files.some((n) => fileExists(root, n))) return false
  if (cond.deps && !hasDep(readPackageJson(root), cond.deps)) return false
  if (cond.pkgKeys) {
    const pkg = readPackageJson(root)
    if (!pkg || !cond.pkgKeys.some((k) => Object.hasOwn(pkg, k))) return false
  }
  if (cond.grep) {
    const text = readText(path.join(root, cond.grep.file))
    if (text === null || !new RegExp(cond.grep.re, 'i').test(text)) return false
  }
  if (cond.not && matches(cond.not, root)) return false
  if (cond.any && !cond.any.some((c) => matches(c, root))) return false
  if (cond.all && !cond.all.every((c) => matches(c, root))) return false
  return true
}
