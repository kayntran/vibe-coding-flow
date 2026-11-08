#!/usr/bin/env node
// paseo: chọn provider/model/mode cho AI phụ chạy thành phiên Paseo (chốt r7eq3pns, 3ak3vbv0). Chỉ đọc cấu hình, không gọi Paseo.
//   on                          exit 0 + "có" khi phiên này chạy trong Paseo (biến PASEO_AGENT_ID), exit 1 + "không" khi không
//   pick <vai> [--host claude|codex]   JSON cho mcp__paseo__create_agent:
//        { provider, modelLine?, thinkingOptionId, modeId, agentFile?, account? }
//        provider đủ dạng "<provider>/<model>" khi biết id (Codex); Claude chỉ biết tên dòng (sonnet/opus/haiku) ⇒ provider "claude",
//        modelLine = dòng: AI gọi mcp__paseo__list_models claude một lần, lấy id đầu tiên bắt đầu "claude-<dòng>-" (danh sách mới nhất trước).
//   codex-provider              id provider Paseo của tài khoản Codex còn lượt (sổ ~/.claude/cache/codex-het-luot.json)
//   het-luot <provider> "<chữ lỗi>"  phiên Codex trong Paseo báo hết lượt ⇒ ghi sổ tới giờ mở lại, in provider kế tiếp để mở lại phiên
// Tài khoản Codex ↔ provider Paseo: ~/.paseo/config.json agents.providers — "codex" (CODEX_HOME mặc định ~/.codex) và các mục
// extends:"codex" có env.CODEX_HOME (vd codex-avonyikesie ⇒ ~/.codex-2). Không đọc giá trị khoá nào.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homeKey, label, markSpent, order, readState, statePath } from './lib/codex-accounts.mjs'
import { loadRoles, resolve as resolveModel } from './lib/models.mjs'

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const inPaseo = (env = process.env) => Boolean(env.PASEO_AGENT_ID)

// CODEX_HOME trong config Paseo: mở rộng ~ và %USERPROFILE%/$HOME; còn tương đối ⇒ bỏ (không đoán thư mục).
function expandHome(p, home) {
  const s = String(p).replace(/^~(?=$|[\\/])/, home).replace(/%USERPROFILE%|\$HOME\b|\$\{HOME\}/gi, home)
  return path.isAbsolute(s) ? path.resolve(s) : null
}

/** [{ id, home }] — provider Codex đang bật trong Paseo kèm thư mục tài khoản của nó. */
export function codexProviders({ home = os.homedir(), env = process.env } = {}) {
  const file = path.join(env.PASEO_HOME || path.join(home, '.paseo'), 'config.json')
  let providers = {}
  try { providers = JSON.parse(fs.readFileSync(file, 'utf8'))?.agents?.providers ?? {} } catch {}
  const dirOf = (p) => (p?.env?.CODEX_HOME ? expandHome(p.env.CODEX_HOME, home) : path.join(home, '.codex'))
  const out = []
  if (providers.codex?.enabled !== false && dirOf(providers.codex)) out.push({ id: 'codex', home: dirOf(providers.codex) })
  for (const [id, p] of Object.entries(providers)) {
    if (id !== 'codex' && p?.extends === 'codex' && p?.enabled !== false && dirOf(p)) out.push({ id, home: dirOf(p) })
  }
  return out
}

/** Provider Codex còn lượt: theo thứ tự trong Paseo, bỏ tài khoản đang ghi hết lượt; hết cả ⇒ cái mở lại sớm nhất. */
export function codexProvider({ home = os.homedir(), env = process.env, now = Date.now(), file = statePath(home) } = {}) {
  const list = codexProviders({ home, env })
  if (!list.length) throw new Error('Paseo không có provider Codex nào đang bật')
  const { list: ordered } = order(list.map((p) => p.home), readState(file), now)
  const first = list.find((p) => homeKey(p.home) === homeKey(ordered[0]))
  return { id: first.id, account: label(first.home) }
}

/** Provider trong lệnh có thể kèm model ("codex-b/gpt-x", đúng như `pick` in) ⇒ lấy phần id. */
export const providerId = (s) => String(s ?? '').split('/')[0]

const CODEX_ONLY = new Set(['code-reviewer', 'security-reviewer', 'plan-reviewer'])

export function pick(role, { host, home = os.homedir(), env = process.env, kit = KIT, platform = process.platform } = {}) {
  const roles = loadRoles(path.join(kit, 'kit', 'roles.json'))
  const r = roles.roles?.[role]
  if (!r) throw new Error(`không có vai "${role}" trong kit/roles.json`)
  const h = host ?? (CODEX_ONLY.has(role) && r.models?.codex ? 'codex' : r.models?.claude ? 'claude' : 'codex')
  if (!r.models?.[h]) throw new Error(`vai "${role}" không có model cho ${h}`)
  const m = resolveModel(h, role, { home, env, roles })
  const agentFile = path.join(kit, 'agents', `${role}.md`)
  const base = {
    thinkingOptionId: m.effort ?? undefined,
    // Ghi code ⇒ "auto" (Claude: bộ phân loại duyệt quyền; Codex: quyền mặc định trong workspace). Không dùng Bypass/Full Access:
    // luật chặn của kit vẫn là lớp chính, nhưng không mở thêm quyền khi chưa cần.
    modeId: 'auto',
    ...(fs.existsSync(agentFile) ? { agentFile } : {}),
    ...(m.warnings?.length ? { warnings: m.warnings } : {}),
  }
  if (h === 'codex') {
    // Windows: phiên Codex trong Paseo dùng sandbox "elevated" của user, chưa duyệt UAC thì không đọc được file (chốt 8338)
    // ⇒ viaPaseo:false: chạy ngầm qua review-ext.mjs / codex-run.mjs, không create_agent.
    if (platform === 'win32') return { ...base, viaPaseo: false, use: 'review-ext.mjs --model codex | codex-run.mjs exec' }
    const c = codexProvider({ home, env })
    return { ...base, viaPaseo: true, provider: `${c.id}${m.model ? `/${m.model}` : ''}`, account: c.account }
  }
  return { ...base, viaPaseo: true, provider: 'claude', modelLine: m.model }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, ...rest] = process.argv.slice(2)
  try {
    if (cmd === 'on') {
      const yes = inPaseo()
      console.log(yes ? 'có' : 'không')
      process.exitCode = yes ? 0 : 1
    } else if (cmd === 'pick') {
      const i = rest.indexOf('--host')
      console.log(JSON.stringify(pick(a, i >= 0 ? { host: rest[i + 1] } : {}), null, 2))
    } else if (cmd === 'codex-provider') {
      const c = codexProvider()
      console.log(`${c.id} (tài khoản ${c.account})`)
    } else if (cmd === 'het-luot') {
      const p = codexProviders().find((x) => x.id === providerId(a))
      if (!p) throw new Error(`không có provider Codex "${a}" trong Paseo`)
      const until = markSpent(p.home, rest.join(' '))
      const next = codexProvider()
      console.log(`Codex: tài khoản ${label(p.home)} hết lượt tới ${new Date(until).toLocaleString('vi-VN')} ⇒ dùng ${next.id} (tài khoản ${next.account}).`)
    } else throw new Error('dùng: paseo.mjs on | pick <vai> [--host claude|codex] | codex-provider | het-luot <provider> "<chữ lỗi>"')
  } catch (e) {
    process.stderr.write(`lỗi: ${e.message}\n`)
    process.exitCode = 2
  }
}
