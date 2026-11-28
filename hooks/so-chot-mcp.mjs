// so-chot-mcp: máy chủ MCP (stdio, JSON-RPC 2.0 theo dòng) để Antigravity (agy) dùng CÙNG sổ chốt với Claude: bọc hooks/lib/so-chot.mjs, không có kho riêng.
// Năm công cụ, tên và trường y như mod so-chot của Claude: ghi_chot · tim_chot · ghi_y_tuong · da_xem · ghi_so (thêm trường tuỳ chọn `du_an`).
// Đăng ký ở ~/.gemini/config/mcp_config.json (install.mjs làm): {"mcpServers":{"so-chot":{"command":"node","args":["<~/.claude>/hooks/so-chot-mcp.mjs"]}}}
//
// Dự án nào? WORKSPACE của phiên = biến SO_CHOT_PROJECT_ROOT, danh sách SO_CHOT_ALLOWED_ROOTS (người dùng tự đặt), `roots/list` (nếu client khai capability roots),
//   thư mục đang đứng của tiến trình (nếu là dự án thật: git, hoặc đã có .claude/so-chot / docs/specs).
//   Không truyền du_an ⇒ lấy SO_CHOT_PROJECT_ROOT → roots/list → thư mục đứng; không phải dự án ⇒ báo lỗi, không lặng lẽ tạo sổ ở chỗ lạ.
//   Có du_an (đường dẫn tuyệt đối, AI điền từ thư mục làm việc của nó) ⇒ CHỈ nhận khi đường dẫn THẬT của nó nằm trong workspace của phiên hoặc trong một worktree của
//   chính repo đó; ngoài ra ⇒ lỗi, để chỉ dẫn lạ trong repo A không đọc/ghi được sổ của dự án B. Không biết workspace nào ⇒ không nhận du_an.
//   Gốc repo / worktree được lib chuẩn hoá (noi-so): worktree mà sổ bị git bỏ qua ⇒ sổ ở thư mục chính; dự án khác ⇒ sổ khác, không chung nhau.
//   Sổ THẬT bị đọc/ghi (gốc repo cha mà lib leo lên, thư mục chính của worktree) cũng phải nằm trong vùng của phiên: phiên chỉ mở apps/web của một monorepo
//   ⇒ lỗi chứ không đụng sổ ở gốc (cấp quyền bằng SO_CHOT_ALLOWED_ROOTS); ghi_so cũng không leo ra ngoài vùng để tìm docs/specs.
//   roots/list được nhớ tới khi client báo notifications/roots/list_changed.
// git chạy bằng đường dẫn tuyệt đối (lib/git-bin.mjs), không chạy git.exe nằm trong thư mục dự án.
// Lỗi nghiệp vụ trả về dạng kết quả công cụ `isError:true` (AI đọc được lý do); lỗi giao thức là lỗi JSON-RPC chuẩn (-32700/-32600/-32601/-32602).
// stdout CHỈ chứa thông điệp giao thức; không in gì khác.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { runGit } from './lib/git-bin.mjs'
import * as soChot from './lib/so-chot.mjs'

const SERVER = { name: 'so-chot', title: 'Sổ chốt của kit', version: '1.0.0' }
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const ROOTS_TIMEOUT_MS = 3000
const AI_QUYET = ['ban', 'ban-gat', 'tu-chon-khi-vang']
const LOAI_Y = ['tinh-nang', 'cai-tien']
const DU_AN = { type: 'string', description: 'Gốc dự án (đường dẫn tuyệt đối của thư mục bạn đang làm việc). Chỉ nhận thư mục nằm trong workspace của phiên (hoặc worktree của repo đó); bỏ trống thì dùng workspace của phiên.' }

const INSTRUCTIONS = [
  'Sổ chốt của dự án (.claude/so-chot/, mỗi quyết định một file, mã 4 ký tự như [k3f9]) dùng chung với Claude.',
  'Khi người dùng duyệt hoặc hai bên thống nhất một quyết định (thiết kế, cách làm, sở thích, phạm vi): gọi ghi_chot.',
  'Sổ chỉ nạp sẵn một phần: cần điều khác thì tim_chot theo từ khoá. Người dùng xác nhận điều ⚠️ đúng: da_xem. Điều <mã> sai: ghi điều mới với thay_cho = mã đó.',
  'Ý tưởng chưa làm ngay: ghi_y_tuong. Đổi pha / bước tiếp theo của việc có sổ tiến độ: ghi_so. Luôn điền du_an = thư mục dự án đang làm.',
  'Không ghi việc vặt hay điều chưa chốt.',
].join(' ')

const codes = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String)

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg) }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---------- định nghĩa công cụ ----------

export const TOOLS = [
  {
    name: 'ghi_chot',
    description: 'Ghi một điều đã chốt vào sổ chốt của dự án (.claude/so-chot): một file có giờ VN, mục lục tự sinh lại. Điều tự chọn khi người dùng vắng được đánh ⚠️ chờ xem lại.',
    inputSchema: {
      type: 'object',
      properties: {
        tom_tat: { type: 'string', description: 'Một dòng dễ hiểu, theo góc nhìn người dùng app' },
        pham_vi: { type: 'string', description: '"chung" (mọi việc) hoặc tên thư mục docs/specs của tính năng' },
        vi_sao: { type: 'string', description: 'Lý do chốt, 1-3 câu' },
        ap_dung: { type: 'string', description: 'Áp dụng thế nào: khi nào, ở đâu, làm gì khác đi' },
        da_can_nhac: { type: 'array', items: { type: 'string' }, description: 'Các phương án khác đã cân nhắc, kèm vì sao không chọn' },
        ai_quyet: { type: 'string', enum: AI_QUYET },
        thay_cho: { type: 'string', description: 'Mã (≥4 ký tự) của điều cũ mà điều này thay thế' },
        lien_quan: { type: 'array', items: { type: 'string' }, description: 'Mã các điều liên quan' },
        du_an: DU_AN,
      },
      required: ['tom_tat', 'vi_sao', 'ai_quyet'],
    },
    run(root, a) {
      if (typeof a.tom_tat !== 'string' || a.tom_tat.trim() === '') fail('Thiếu tom_tat.')
      const ai = a.ai_quyet ?? 'ban'
      if (!AI_QUYET.includes(ai)) fail(`ai_quyet phải là một trong: ${AI_QUYET.join(', ')}.`)
      const thay = codes(a.thay_cho)[0]
      const d = soChot.ghi(root, {
        tom_tat: a.tom_tat,
        pham_vi: a.pham_vi,
        vi_sao: a.vi_sao,
        ap_dung: a.ap_dung,
        da_can_nhac: Array.isArray(a.da_can_nhac) ? a.da_can_nhac.map(String) : [],
        ai_quyet: ai,
        ...(thay ? { thay_cho: thay } : {}),
        lien_quan: codes(a.lien_quan),
      })
      return `Đã ghi [${String(d.ma).slice(0, 4)}] vào .claude/so-chot/${d.file}${thay ? `, điều ${thay} chuyển ↩️ đã thay` : ''}${d.trang_thai === 'cho-xem' ? ' · ⚠️ chờ người dùng xem lại' : ''}.`
    },
  },
  {
    name: 'tim_chot',
    description: 'Tìm trong sổ chốt theo từ khoá (không cần dấu): trả về các dòng khớp kèm mã, giờ, trạng thái và file chi tiết. Mặc định gồm điều đang dùng, ⚠️ và 📦 đã cất; tat_ca=true để gồm cả điều đã thay/đã huỷ.',
    inputSchema: {
      type: 'object',
      properties: { tu_khoa: { type: 'string' }, tat_ca: { type: 'boolean' }, du_an: DU_AN },
      required: ['tu_khoa'],
    },
    run(root, a) {
      const query = String(a.tu_khoa ?? '').trim()
      if (query === '') fail('Thiếu tu_khoa.')
      const hits = soChot.tim(root, query, { lichSu: a.tat_ca === true })
      if (hits.length === 0) return `Sổ chốt không có điều nào khớp "${query}".`
      return [`${hits.length} điều khớp "${query}" (file chi tiết: .claude/so-chot/<đường dẫn>):`, ...hits.map((h) => h.dong)].join('\n')
    },
  },
  {
    name: 'ghi_y_tuong',
    description: 'Lưu một ý tưởng người dùng vừa nảy ra (chưa làm ngay) vào docs/IDEAS.md để sau lấy ra dùng.',
    inputSchema: {
      type: 'object',
      properties: {
        loai: { type: 'string', enum: LOAI_Y, description: 'Tính năng mới hay cải tiến cái đang có' },
        noi_dung: { type: 'string', description: 'Một dòng dễ hiểu, theo góc nhìn người dùng app' },
        du_an: DU_AN,
      },
      required: ['loai', 'noi_dung'],
    },
    run(root, a) {
      if (!LOAI_Y.includes(a.loai)) fail(`loai phải là một trong: ${LOAI_Y.join(', ')}.`)
      if (typeof a.noi_dung !== 'string' || a.noi_dung.trim() === '') fail('Thiếu noi_dung.')
      soChot.ghiYTuong(root, { loai: a.loai, noi_dung: a.noi_dung })
      return 'Đã lưu ý tưởng vào docs/IDEAS.md (roadmap tự cập nhật).'
    },
  },
  {
    name: 'da_xem',
    description: 'Người dùng đã xem và đồng ý một điều đang ⚠️ chờ xem lại: chuyển sang ✅.',
    inputSchema: {
      type: 'object',
      properties: { ma: { type: 'string', description: 'Mã (≥4 ký tự)' }, du_an: DU_AN },
      required: ['ma'],
    },
    run(root, a) {
      const d = soChot.daXem(root, String(a.ma ?? ''))
      return `[${String(d.ma).slice(0, 4)}] chuyển sang ✅ đang dùng.`
    },
  },
  {
    name: 'ghi_so',
    description: 'Cập nhật đầu sổ tiến độ progress.md đang mở: Pha, Trạng thái, Bước tiếp theo. Chỉ truyền trường cần đổi. Báo lỗi nếu dự án không có sổ tiến độ đang mở.',
    inputSchema: {
      type: 'object',
      properties: {
        pha: { type: 'string' },
        trang_thai: { type: 'string', description: '"đang làm" hoặc "xong" (khi đã gộp)' },
        buoc_tiep_theo: { type: 'string' },
        du_an: DU_AN,
      },
    },
    needsScope: true, // lib có thể leo lên gốc repo để tìm docs/specs ⇒ cần biết vùng được phép để không leo ra ngoài (ctx.allow)
    run(root, a, ctx) {
      const d = soChot.ghiSo(root, { pha: a.pha, trang_thai: a.trang_thai, buoc_tiep_theo: a.buoc_tiep_theo }, { branch: soChot.branchOf(root), allow: ctx.allow })
      return `Đã cập nhật ${d.file}: ${d.changed.join(' · ')}`
    },
  },
]

// ---------- chọn dự án ----------

const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

function checkDir(dir) {
  let real
  try {
    if (!path.isAbsolute(dir)) fail('du_an phải là đường dẫn tuyệt đối.')
    real = fs.realpathSync.native(dir)
    if (!fs.statSync(real).isDirectory()) fail(`du_an không phải thư mục: ${dir}`)
  } catch (e) {
    if (e instanceof ToolError) throw e
    fail(`Không mở được thư mục dự án ${dir}.`)
  }
  if (path.parse(real).root === real || sameDir(real, fs.realpathSync.native(os.homedir()))) fail(`du_an không được là gốc ổ đĩa hay thư mục nhà: ${dir}`)
  return real
}

// Có giống thư mục dự án không: có .git, hoặc đã có sổ/specs, hoặc nằm trong một cây làm việc git. (git chạy bằng đường dẫn tuyệt đối: lib/git-bin.mjs)
function looksLikeProject(dir) {
  if (['.git', path.join('.claude', 'so-chot'), path.join('docs', 'specs')].some((rel) => fs.existsSync(path.join(dir, rel)))) return true
  const r = runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true })
  return !r.error && r.status === 0 && r.stdout.trim() === 'true'
}

const lowerOnWin = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
const realDir = (p) => { try { const r = fs.realpathSync.native(p); return fs.statSync(r).isDirectory() ? r : null } catch { return null } }
// p nằm trong root hoặc bằng root (cả hai là đường dẫn THẬT: đã realpath, nên liên kết/junction không lách được).
const within = (root, p) => lowerOnWin(p) === lowerOnWin(root) || lowerOnWin(p).startsWith(lowerOnWin(root) + path.sep)

// Mọi worktree của repo chứa `root` (git worktree list), dạng đường dẫn thật. Lỗi git / không phải repo ⇒ [].
function worktreesOf(root) {
  const r = runGit(['-c', 'core.quotepath=off', 'worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 })
  if (r.error || r.status !== 0) return []
  return r.stdout.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => realDir(l.slice('worktree '.length))).filter(Boolean)
}

// ---------- giao thức ----------

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const isId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

/**
 * Tạo máy chủ: `send(obj)` ghi một thông điệp ra client; `handle(line)` xử lý một dòng nhận vào (không ném).
 * opts: { cwd, env } (test tiêm giả).
 */
export function createServer({ send, cwd = process.cwd(), env = process.env } = {}) {
  let clientRoots = false
  let rootsCache = null // kết quả roots/list gần nhất (đã realpath); null = chưa hỏi hoặc client báo đã đổi
  let nextId = 1
  const waiting = new Map() // id yêu cầu của máy chủ → { resolve, timer }

  function askRoots() {
    return new Promise((resolve) => {
      const id = `so-chot-${nextId++}`
      const timer = setTimeout(() => { waiting.delete(id); resolve(null) }, ROOTS_TIMEOUT_MS)
      waiting.set(id, { resolve, timer })
      send({ jsonrpc: '2.0', id, method: 'roots/list' })
    })
  }

  // Các thư mục dự án client khai qua roots/list (đường dẫn thật). Không khai roots / lỗi / quá giờ ⇒ [] (không nhớ, lần sau hỏi lại).
  // Trả lời hợp lệ được nhớ cho tới khi client báo notifications/roots/list_changed: mỗi lệnh không phải hỏi lại client một vòng.
  async function clientWorkspaces() {
    if (!clientRoots) return []
    if (rootsCache) return rootsCache
    const res = await askRoots()
    if (!Array.isArray(res?.result?.roots)) return []
    const out = []
    for (const r of res.result.roots) {
      if (typeof r?.uri !== 'string' || !r.uri.startsWith('file:')) continue
      try { const d = realDir(fileURLToPath(r.uri)); if (d && !out.includes(d)) out.push(d) } catch {}
    }
    rootsCache = out
    return out
  }

  // Vùng được phép KHÔNG cần hỏi client: SO_CHOT_PROJECT_ROOT, danh sách SO_CHOT_ALLOWED_ROOTS (người dùng tự đặt, ngăn cách bằng dấu của hệ điều hành),
  // và thư mục đang đứng của máy chủ nếu nó là dự án.
  function configuredWorkspaces() {
    const out = []
    const add = (p) => { const d = typeof p === 'string' && p.trim() ? realDir(p.trim()) : null; if (d && !out.includes(d)) out.push(d) }
    add(env.SO_CHOT_PROJECT_ROOT)
    for (const p of String(env.SO_CHOT_ALLOWED_ROOTS ?? '').split(path.delimiter)) add(p)
    const here = realDir(cwd)
    if (here && looksLikeProject(here)) add(here)
    return out
  }

  async function allWorkspaces(cheap = configuredWorkspaces()) {
    const fromClient = await clientWorkspaces()
    return [...cheap, ...fromClient.filter((r) => !cheap.includes(r))]
  }

  // p (đã realpath) nằm trong một workspace, hoặc trong một worktree CÙNG repo với workspace đó. Worktree là tổ tiên thật sự của workspace
  // (phiên chỉ mở thư mục con apps/web của một repo) thì KHÔNG tính: đó là leo ra ngoài vùng phiên được mở chứ không phải worktree anh em.
  const inScopeOf = (known, p) => known.some((r) => within(r, p)) ||
    known.some((r) => worktreesOf(r).some((w) => within(w, p) && !(within(w, r) && !sameDir(w, r))))

  async function inScope(p) {
    const cheap = configuredWorkspaces()
    if (cheap.some((r) => within(r, p))) return { ok: true, known: cheap }
    const known = await allWorkspaces(cheap)
    return { ok: inScopeOf(known, p), known }
  }

  // Sổ thật sự bị đọc/ghi (gốc repo mà lib leo lên, hoặc thư mục chính khi worktree phụ bị git bỏ qua sổ) cũng phải nằm trong vùng của phiên:
  // trước đây du_an = apps/web (trong workspace) vẫn đọc/ghi được sổ ở gốc repo cha ngoài workspace.
  async function checkEffective(real) {
    const { root, store } = soChot.noiSo(real)
    for (const p of new Set([root, store])) {
      if (sameDir(p, real)) continue
      const { ok, known } = await inScope(p)
      if (!ok) fail(`Sổ chốt của ${real} nằm ở ${p} (gốc repo chứa nó), nằm ngoài thư mục làm việc của phiên (${known.join(', ')}) nên không đọc/ghi: sổ chốt chỉ đọc/ghi trong workspace của phiên. Muốn dùng sổ đó: mở phiên ở gốc repo hoặc đặt SO_CHOT_ALLOWED_ROOTS=${p} trong cấu hình MCP so-chot.`)
    }
  }

  async function projectRoot(args) {
    const given = typeof args.du_an === 'string' ? args.du_an.trim() : ''
    if (given) {
      const real = checkDir(given)
      const { ok, known } = await inScope(real)
      if (ok) { await checkEffective(real); return real }
      if (known.length === 0) {
        fail(`Máy chủ sổ chốt chưa biết thư mục dự án của phiên (agy không khai roots, SO_CHOT_PROJECT_ROOT chưa đặt, thư mục đang đứng ${cwd} không phải dự án) nên không nhận du_an. Đặt SO_CHOT_PROJECT_ROOT=<thư mục dự án> (hoặc SO_CHOT_ALLOWED_ROOTS=<các thư mục được phép>) trong cấu hình MCP so-chot.`)
      }
      fail(`du_an ${real} nằm ngoài thư mục làm việc của phiên (${known.join(', ')}) và không phải worktree của repo đó: sổ chốt chỉ đọc/ghi trong workspace của phiên.`)
    }
    let dir = typeof env.SO_CHOT_PROJECT_ROOT === 'string' ? env.SO_CHOT_PROJECT_ROOT.trim() : ''
    if (!dir) dir = (await clientWorkspaces())[0] ?? ''
    if (!dir) dir = cwd
    const real = checkDir(dir)
    if (!looksLikeProject(real)) {
      fail(`Máy chủ sổ chốt đang đứng ở ${real}, không phải thư mục dự án (không có .git, .claude/so-chot hay docs/specs). Gọi lại với du_an = đường dẫn tuyệt đối của dự án đang làm (cần SO_CHOT_PROJECT_ROOT hoặc roots của agy để máy chủ biết thư mục dự án của phiên).`)
    }
    await checkEffective(real)
    return real
  }

  async function callTool(params) {
    const tool = TOOLS.find((t) => t.name === params?.name)
    if (!tool) return { error: { code: -32602, message: `Công cụ không tồn tại: ${String(params?.name).slice(0, 80)}` } }
    const args = params.arguments ?? {}
    if (!isObj(args)) return { result: { content: [{ type: 'text', text: 'arguments phải là một object.' }], isError: true } }
    try {
      const root = await projectRoot(args)
      // ctx.allow: công cụ có thể leo lên gốc repo (ghi_so) chỉ được leo tới nơi nằm trong vùng của phiên.
      const known = tool.needsScope ? await allWorkspaces() : []
      const text = tool.run(root, args, { allow: (dir) => inScopeOf(known, dir) })
      return { result: { content: [{ type: 'text', text }] } }
    } catch (e) {
      const text = soChot.oneLine(e?.message ?? e, 600) || 'Lỗi không rõ.'
      return { result: { content: [{ type: 'text', text }], isError: true } }
    }
  }

  async function request(msg) {
    const { id, method, params } = msg
    if (method === 'initialize') {
      clientRoots = isObj(params?.capabilities?.roots)
      const want = params?.protocolVersion
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      } }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }
    if (method === 'tools/call') {
      const r = await callTool(params)
      return r.error ? { jsonrpc: '2.0', id, error: r.error } : { jsonrpc: '2.0', id, result: r.result }
    }
    return rpcError(id, -32601, `Method not found: ${String(method).slice(0, 80)}`)
  }

  // → thông điệp trả lời hoặc null (thông báo / phản hồi cho yêu cầu của máy chủ).
  async function one(msg) {
    if (!isObj(msg) || msg.jsonrpc !== '2.0') return rpcError(isObj(msg) && isId(msg.id) ? msg.id : null, -32600, 'Invalid Request')
    if (typeof msg.method !== 'string') {
      if (isId(msg.id) && ('result' in msg || 'error' in msg)) { // phản hồi của client cho roots/list
        const w = waiting.get(msg.id)
        if (w) { clearTimeout(w.timer); waiting.delete(msg.id); w.resolve(msg) }
        return null
      }
      return rpcError(isId(msg.id) ? msg.id : null, -32600, 'Invalid Request')
    }
    if (!isId(msg.id)) { // thông báo (notifications/initialized, …): không trả lời
      if (msg.method === 'notifications/roots/list_changed') rootsCache = null
      return null
    }
    return request(msg)
  }

  async function handle(line) {
    let msg
    try { msg = JSON.parse(line) } catch { send(rpcError(null, -32700, 'Parse error')); return }
    try {
      if (Array.isArray(msg)) {
        if (msg.length === 0) { send(rpcError(null, -32600, 'Invalid Request')); return }
        const out = (await Promise.all(msg.map((m) => one(m)))).filter(Boolean)
        if (out.length) send(out)
        return
      }
      const out = await one(msg)
      if (out) send(out)
    } catch {
      send(rpcError(isObj(msg) && isId(msg.id) ? msg.id : null, -32603, 'Internal error'))
    }
  }

  return { handle }
}

// ---------- chạy ----------

const isMain = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (isMain) {
  const server = createServer({ send: (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`) })
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const running = new Set()
  rl.on('line', (line) => {
    if (!line.trim()) return
    const p = server.handle(line).finally(() => running.delete(p))
    running.add(p)
  })
  // stdin đóng: tiến trình thoát tự nhiên khi các lệnh đang chạy xong và stdout đã ghi hết (không gọi process.exit để khỏi cắt thông điệp).
}
