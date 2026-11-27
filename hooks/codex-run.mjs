#!/usr/bin/env node
// codex-run: gọi `codex <đối số…>` cho việc phụ của kit (soát plan, tìm lỗi…), tự thử lần lượt các tài khoản Codex đã đăng nhập
// trên máy, tài khoản hết lượt ⇒ ghi lại, in một dòng ra stderr, sang tài khoản kế (chốt 0ufuusz3; thư viện lib/codex-accounts.mjs).
//   node ~/.claude/hooks/codex-run.mjs exec --sandbox read-only --vai debugger -C "<repo>" -o "<out.md>" - < prompt.md
//   node ~/.claude/hooks/codex-run.mjs exec … -m <model> …              (cách cũ: tự truyền model, không qua --vai)
//   node ~/.claude/hooks/codex-run.mjs exec … "Câu lệnh ngắn"           (prompt cuối có dấu cách/xuống dòng ⇒ tự chuyển sang stdin)
// --vai <vai>: model + mức effort lấy theo HẠNG của vai (hooks/lib/models.mjs, kit/roles.json). Codex có hạng đó ⇒ `codex exec -m <id> -c model_reasoning_effort=…`.
// Codex thiếu hạng mà Factory có ⇒ chạy `droid exec -m <id> [-r <mức>]` (chỉ đọc: không --auto; prompt qua stdin; thư mục chạy = -C; -o do codex-run ghi) + một dòng
// ra stderr. Chỉ chuyển khi lượt này chỉ đọc (--sandbox read-only) VÀ check('droid') sẵn sàng (chưa cài/chưa đăng nhập ⇒ hạ hạng trong Codex). droid chạy với `--settings` tắt hook
// (droid nạp hook của thư mục chạy không hỏi tin cậy) và env đã lọc khoá. Gọi kiểu cũ có -m thì giữ nguyên, không tự chọn.
// Windows chạy shim codex.cmd qua cmd.exe nên đối số phải "an toàn": -C <thư mục> thành thư mục chạy, -o <file> ghi qua file tạm
// rồi chép sang — đường dẫn có dấu cách vẫn chạy. stdout/stderr in lại nguyên; exit = exit của lượt cuối.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check as checkCli, resolveBin } from './lib/clis.mjs'
import { runWithAccounts } from './lib/codex-accounts.mjs'
import { resolve as resolveModel } from './lib/models.mjs'
import { reviewerEnv, runReviewer, WIN_SANDBOX, writeDroidSettings } from './review-ext.mjs'

const SAFE_ARG = /^[\w.:=/-]+$/
const OUT_FLAGS = new Set(['-o', '--output-last-message'])
const CD_FLAGS = new Set(['-C', '--cd'])
const MODEL_FLAGS = new Set(['-m', '--model'])

/**
 * Tách đối số: { args, cwd, outFile, tmpOut, tmpDir, prompt, vai } — prompt ≠ null ⇒ gửi qua stdin và đối số cuối thành "-"; vai = giá trị --vai (đã bỏ khỏi args).
 * File -o tạm nằm trong thư mục tạo độc quyền (mkdtemp ⇒ không ai đặt sẵn symlink vào tên đó). Thư mục Temp của máy có dấu
 * cách/chữ có dấu (C:\Users\Nguyễn\…) thì cmd.exe không nhận ⇒ tạo thư mục tạm ngay trong thư mục chạy và truyền đường dẫn tương đối.
 */
export function plan(argv, { cwd = process.cwd(), tmp = os.tmpdir(), stdinPrompt = null, winSandbox = WIN_SANDBOX } = {}) {
  const args = []
  let dir = cwd, outFile = null, prompt = stdinPrompt, vai = null
  for (let i = 0; i < argv.length; i++) if (CD_FLAGS.has(argv[i]) && i + 1 < argv.length) dir = path.resolve(cwd, argv[i + 1])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (CD_FLAGS.has(a) && i + 1 < argv.length) { i++; continue }
    if (a === '--vai' && i + 1 < argv.length) { vai = argv[++i]; continue }
    if (OUT_FLAGS.has(a) && i + 1 < argv.length) { outFile = path.resolve(cwd, argv[++i]); args.push('-o', null); continue }
    args.push(a)
  }
  let tmpOut = null, tmpDir = null
  if (outFile) {
    const sys = tmp.replaceAll('\\', '/')
    tmpDir = fs.mkdtempSync(SAFE_ARG.test(sys) ? path.join(tmp, 'codex-run-') : path.join(dir, '.codex-run-'))
    tmpOut = SAFE_ARG.test(sys) ? path.join(tmpDir, 'out.md').replaceAll('\\', '/') : `${path.basename(tmpDir)}/out.md`
    args[args.indexOf(null)] = tmpOut
  }
  const last = args.at(-1)
  if (last !== undefined && last !== '-' && !last.startsWith('-') && !SAFE_ARG.test(last)) {
    prompt = last
    args[args.length - 1] = '-'
  }
  // Windows: sandbox không nâng quyền cho lượt chạy ngầm (xem WIN_SANDBOX ở review-ext.mjs), trừ khi người gọi đã tự đặt.
  if (args[0] === 'exec' && !args.some((x) => typeof x === 'string' && x.startsWith('windows.sandbox'))) args.splice(1, 0, ...winSandbox)
  return { args, cwd: dir, outFile, tmpOut, tmpDir, prompt, vai }
}

// Lượt này chỉ đọc? (`--sandbox read-only` / `-s read-only`) — chỉ khi đó mới được chuyển sang droid (mặc định của droid exec là chỉ đọc).
const readOnly = (args) => args.some((a, i) => (a === '--sandbox' || a === '-s') && args[i + 1] === 'read-only')

/**
 * Chọn lệnh chạy -> { bin: 'codex'|'droid', args, input, warnings, homes?, model?, env?, settingsDir? }.
 * Không --vai, hoặc đã có -m (cách cũ) ⇒ giữ nguyên đối số cho codex. Có --vai ⇒ resolve theo hạng của vai; model:null ⇒ để Codex dùng mặc định.
 * resolveFn(host, vai, opts, flags) tiêm được cho test; ném lỗi (vai lạ…) cho người gọi in. fallback:false ⇒ không chuyển sang Factory (hạ hạng trong Codex).
 * Đường Factory: `--settings <file kit tạo trong thư mục tạm riêng>` tắt hook (droid nạp hook từ `.factory/` của thư mục chạy và KHÔNG hỏi tin cậy ⇒ phải tắt, xem
 * review-ext.mjs), env đã lọc khoá của máy (chỉ giữ FACTORY_API_KEY). settingsDir = thư mục tạm cần dọn khi xong.
 */
export function runnerFor(p, { resolveFn = resolveModel, opts = {}, tmp = os.tmpdir(), env = process.env, fallback = true } = {}) {
  const hasModel = p.args.some((a) => MODEL_FLAGS.has(a))
  if (!p.vai || hasModel || p.args[0] !== 'exec') return { bin: 'codex', args: p.args, input: p.prompt, warnings: [] }
  const r = resolveFn('codex', p.vai, opts, { allowFallbackHost: fallback && readOnly(p.args), allAccounts: true })
  if (r.host === 'droid') {
    // Factory: chỉ truyền -r khi mức effort đã biết từ "Model details"; không --cwd (spawn đã chạy ở thư mục -C, tránh đối số lạ qua shim .cmd); không --auto ⇒ chỉ đọc.
    const text = p.prompt == null && p.args.at(-1) && p.args.at(-1) !== '-' && !p.args.at(-1).startsWith('-') ? p.args.at(-1) : null
    // File --settings phải là đối số "an toàn" (SAFE_ARG) kẻo shim .cmd từ chối (EUNSAFE): Temp an toàn ⇒ đường tuyệt đối trong Temp; Temp có dấu cách/chữ có dấu ⇒ thư mục tạm riêng
    // trong cwd + đường tương đối (cùng cách plan() né cho -o).
    const sys = tmp.replaceAll('\\', '/')
    const inTmp = SAFE_ARG.test(sys)
    const settingsDir = fs.mkdtempSync(inTmp ? path.join(tmp, 'codex-run-droid-') : path.join(p.cwd, '.codex-run-droid-'))
    const file = writeDroidSettings(settingsDir)
    const settings = inTmp ? file : `${path.basename(settingsDir)}/droid-settings.json`
    const args = ['exec', '-m', r.model, ...(r.effort ? ['-r', r.effort] : []), '--settings', settings, ...(text ? [text] : [])]
    return { bin: 'droid', args, input: p.prompt, warnings: r.warnings, settingsDir, env: reviewerEnv(env, 'droid') }
  }
  const add = r.model ? ['-m', r.model, ...(r.effort ? ['-c', `model_reasoning_effort=${r.effort}`] : [])] : []
  // homes = các tài khoản Codex có model đã chọn: chỉ thử các tài khoản đó (tài khoản khác không có model ⇒ `-m` sẽ lỗi "model không tồn tại").
  return { bin: 'codex', args: [p.args[0], ...add, ...p.args.slice(1)], input: p.prompt, warnings: r.warnings, homes: r.model && r.homes?.length ? r.homes : null, model: r.model }
}

/**
 * runnerFor + kiểm droid: Codex thiếu hạng mà droid CHƯA cài/CHƯA đăng nhập ⇒ không chọn droid, resolve lại Codex không bật fallback (hạ hạng) và báo nguyên nhân — như review-ext.
 * checkFn(name) tiêm được cho test (mặc định check của lib/clis). Chỉ gọi khi runnerFor thực sự chọn droid.
 */
export async function pickRunner(p, deps = {}) {
  const { checkFn = checkCli } = deps
  const run = runnerFor(p, deps)
  if (run.bin !== 'droid') return run
  let st
  try { st = await checkFn('droid') } catch (e) { st = { ready: false, message: `không kiểm được droid (${e.message})` } }
  if (st.ready) return run
  fs.rmSync(run.settingsDir, { recursive: true, force: true })
  const next = runnerFor(p, { ...deps, fallback: false })
  next.warnings.unshift(`${st.message}${st.loginCmd ? `. Đăng nhập: ${st.loginCmd}` : ''}${st.installHint ? `. Cài: ${st.installHint}` : ''} ⇒ Codex dùng hạng thấp hơn.`)
  return next
}

/**
 * Chạy `first` (kết quả pickRunner) bằng exec(run) -> kết quả dạng runReviewer; say(chữ) ra stderr. -> { run, r } với run = lệnh của lượt cuối. Dọn mọi thư mục tạm của kit khi xong.
 *  - lượt Factory vẫn EUNSAFE (đối số/đường dẫn lạ qua shim .cmd) ⇒ hạ về Codex hạng thấp hơn + một dòng báo, không chết cả lượt;
 *  - lượt Codex hết lượt ở MỌI tài khoản có model đã chọn ⇒ chọn lại (các tài khoản vừa hết lượt đã bị ghi sổ nên bị loại): model tốt nhất của tài khoản còn lại hoặc Factory,
 *    báo một dòng, chạy lại một lần.
 */
export async function execute(p, first, { deps = {}, exec, say = () => {} } = {}) {
  let run = first
  const dirty = [first.settingsDir]
  try {
    for (const w of run.warnings) say(`! ${w}`)
    let r = await exec(run)
    if (run.bin === 'droid' && r.error?.code === 'EUNSAFE') {
      const next = runnerFor(p, { ...deps, fallback: false })
      dirty.push(next.settingsDir)
      say(`Factory: ${r.error.message} ⇒ Codex dùng hạng thấp hơn.`)
      for (const w of next.warnings) say(`! ${w}`)
      run = next
      r = await exec(run)
    }
    if (r.quota && run.bin === 'codex') {
      let next = null
      try { next = await pickRunner(p, deps) } catch { /* giữ kết quả hết lượt */ }
      if (next) dirty.push(next.settingsDir)
      if (next && (next.bin !== run.bin || JSON.stringify(next.args) !== JSON.stringify(run.args))) {
        say(`Codex: hết lượt ở mọi tài khoản có ${run.model ?? 'model đã chọn'} ⇒ chuyển sang ${next.bin === 'droid' ? `Factory ${next.args[2]}` : (next.model ?? 'model mặc định của Codex')}.`)
        run = next
        r = await exec(run)
      }
    }
    return { run, r }
  } finally {
    for (const d of dirty) if (d) fs.rmSync(d, { recursive: true, force: true })
  }
}

async function main(argv) {
  const stdinPrompt = argv.at(-1) === '-' && !process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : null
  const p = plan(argv, { stdinPrompt })
  let first
  try {
    first = await pickRunner(p)
  } catch (e) {
    process.stderr.write(`codex-run: ${e.message}\n`)
    if (p.tmpDir) fs.rmSync(p.tmpDir, { recursive: true, force: true })
    return 2
  }
  const say = (s) => process.stderr.write(`${s}\n`)
  const exec = (cur) => {
    const bin = resolveBin(cur.bin) ?? cur.bin
    return cur.bin === 'droid'
      ? runReviewer(bin, cur.args, { cwd: p.cwd, env: cur.env, input: cur.input, timeoutMs: 40 * 60 * 1000 }) // Factory: một tài khoản, env đã lọc khoá, không xoay vòng như Codex
      : runWithAccounts((env) => runReviewer(bin, cur.args, { cwd: p.cwd, env, input: cur.input, timeoutMs: 40 * 60 * 1000 }), { say, ...(cur.homes ? { homes: cur.homes } : {}) })
  }
  const { run, r } = await execute(p, first, { exec, say })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.error) process.stderr.write(`codex-run: ${r.error.code}: ${r.error.message}\n`)
  if (p.tmpDir) {
    const made = path.join(p.tmpDir, 'out.md')
    if (run.bin === 'droid' && p.outFile && r.stdout) {
      fs.mkdirSync(path.dirname(p.outFile), { recursive: true })
      fs.writeFileSync(p.outFile, r.stdout)
    } else if (fs.existsSync(made)) {
      fs.mkdirSync(path.dirname(p.outFile), { recursive: true })
      fs.copyFileSync(made, p.outFile)
    }
    fs.rmSync(p.tmpDir, { recursive: true, force: true })
  }
  return r.timedOut ? 124 : (r.status ?? 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
