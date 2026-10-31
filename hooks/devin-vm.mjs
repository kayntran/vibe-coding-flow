#!/usr/bin/env node
// devin-vm: chạy thử app trên MÁY ẢO DEVIN (Ubuntu/Windows/macOS) thay vì máy user. Spec: docs/specs/2026-10-31-may-ao-devin (SPEC + PLAN).
// Tên KHÔNG được khớp mẫu file test mặc định của `node --test` (*-test.mjs …). Logic ở lib/devin.mjs; file này chỉ đọc đối số, gọi lõi, in kết quả.
//
//   node hooks/devin-vm.mjs where  [--dir D] [--need nhãn,nhãn]           chọn nơi chạy ⇒ JSON {runner:"devin"|"local", os, reason, login?}
//   node hooks/devin-vm.mjs up     [--dir D] [--os O] [--audio]           đánh thức hoặc tạo máy ⇒ JSON {id, os, created, woke}
//   node hooks/devin-vm.mjs run    [--dir D] [--os O] [--env K,K|@config] [--timeout giây] -- <lệnh>   chạy trong thư mục code trên máy ảo, trả mã thoát
//       LƯU Ý: devin.exe chạy ssh trong ConPTY của Windows ⇒ đầu ra DÒNG DÀI bị bẻ dòng + chèn mã ESC (đo: base64 11 KB về hỏng). Đừng parse dữ liệu từ
//       stdout của `run` trừ dòng đánh dấu ngắn (≤ ~100 ký tự); dữ liệu lớn/nhị phân (ảnh, log, file) ⇒ dùng `get`.
//   node hooks/devin-vm.mjs sync   [--dir D] [--os O] [--full] [--setup]  chép code đang làm lên máy ảo, kiểm khớp ⇒ JSON {ok, mode, head, tree}
//   node hooks/devin-vm.mjs put <file-máy-bạn> <đường-dẫn-máy-ảo>  ·  get <đường-dẫn-máy-ảo> <file-máy-bạn>
//       get: server tĩnh tạm trên máy ảo (127.0.0.1, cổng ngẫu nhiên, cần python3/python) + `devin forward` nền ⇒ tải bằng HTTP, kiểm sha256 + kích thước, rồi dọn hết
//   node hooks/devin-vm.mjs forward [--dir D] [--os O] <cổng|L:R>  ·  forward --stop     chuyển cổng máy ảo ⇒ localhost (nền)
//       Cổng máy bạn đã có tiến trình khác nghe ⇒ lỗi. Kèm tiến trình nền ping giữ máy thức (máy tạo qua API ngủ sau ~5 phút không có TIN NHẮN; ssh/forward/app
//       đang chạy không tính): mỗi 4 phút một tin nhắn qua MCP, tự thoát khi hết forward · máy ngủ · 6 giờ; `forward --stop` / `sleep` / `rm` diệt nó.
//       run / sync / gui / job cũng ping (lần ping cuối > 3 phút; job và run/sync dài thì cứ 4 phút), KHÔNG ping máy đang ngủ.
//   node hooks/devin-vm.mjs gui    [--dir D] [--cwd C] (--cmd "<dòng lệnh>" | -- <exe> [đối số…])   Windows: mở app GUI trên màn hình thật của máy ảo (tác vụ hẹn giờ Interactive)
//       --cmd chạy `cmd.exe /c <dòng lệnh>` (dựng trong node: Git Bash đổi "/c" thành "C:/" nếu gõ `-- cmd.exe /c …`). Thiếu --cwd ⇒ thư mục kho trên máy ảo, không phải System32.
//   node hooks/devin-vm.mjs sleep  [--dir D] [--os O] [--force]           cho ngủ và CHỜ tới suspended (≤ 60 s); còn job khác của dự án đang giữ máy ⇒ từ chối (--force bỏ qua)
//   node hooks/devin-vm.mjs status [--dir D] [--os O] [--all]             trạng thái máy của dự án / mọi máy trong sổ
//   node hooks/devin-vm.mjs rm     [--dir D] [--os O]                     xoá hẳn máy ảo + gỡ khỏi sổ
//   node hooks/devin-vm.mjs job    [--dir D] [--os O] [--need nhãn] -- <lệnh máy bạn>   where ⇒ up + sync + chạy lệnh (có DEVIN_VM_ID/OS) ⇒ luôn cho máy ngủ
//       Mỗi (dự án, os) một máy dùng chung: job giữ lease độc quyền; job thứ hai của cùng dự án chờ (≤ 20 phút) rồi mới up/sync, quá hạn ⇒ chạy máy bạn.
//
// Lệnh máy đọc (where, up, status, sync, sleep, rm, forward, gui, put, get) in JSON MỘT dòng ra stdout; lời tiến trình ra stderr. `run` in thẳng đầu ra của máy ảo.
// Exit: 0 ổn · 1 lỗi · 2 dùng sai · 3 Devin không dùng được (chưa đăng nhập, hết hạn mức, lỗi mạng) ⇒ người gọi chạy trên máy user.
// Mỗi lệnh ghi một dòng vào hooks/devin-vm.log (giờ, lệnh, mã máy, ms, mã thoát; không ghi nội dung lệnh); `up` và `job` thêm hai cột cuối = % hạn mức NGÀY
// lúc bắt đầu và lúc xong ("-" nếu chưa biết). Hạn mức ngày còn dưới 20% (biến DEVIN_VM_MIN_DAILY đổi ngưỡng) ⇒ `where` trả máy bạn và `up` từ chối bật máy;
// `status` cho thấy "quota":{daily,weekly,resetAt}. Tắt nhanh: DEVIN_VM=off hoặc .claude/devin.json {"off":true}.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DevinUnavailable, OSES, ToolError, UsageError, appendLog, getFile, guiLaunch, makeCtx, putFile, removeVm, runJob, runKeepalive, runProject, scrub,
  sleepProject, startForward, statusOf, stopForward, syncProject, up, where,
} from './lib/devin.mjs'

const USAGE = `dùng: devin-vm.mjs <where|up|run|sync|put|get|forward|gui|sleep|status|rm|job> [tuỳ chọn] [-- lệnh]
  where  [--dir D] [--need nhãn,nhãn]            chọn máy ảo hay máy bạn (JSON)
  up     [--dir D] [--os linux|windows|macos] [--audio]
  run    [--dir D] [--os O] [--env K,K|@config] [--timeout giây] -- <lệnh>
         (đầu ra dòng dài có thể bị bẻ dòng/chèn ESC ⇒ đừng parse dữ liệu từ stdout, chỉ dòng đánh dấu ngắn; dữ liệu lớn ⇒ get)
  sync   [--dir D] [--os O] [--full] [--setup]
  put <file> <đích-máy-ảo> · get <file-máy-ảo> <đích>  [--dir D] [--os O]   (get tải qua cổng chuyển, kiểm sha256)
  forward [--dir D] [--os O] <cổng|L:R> · forward --stop   (kèm ping giữ máy thức; --stop tắt luôn)
  gui    [--dir D] [--cwd C] (--cmd "<dòng lệnh>" | -- <exe> [đối số…])  (Windows; thiếu --cwd ⇒ thư mục kho)
  sleep [--force] | rm [--dir D] [--os O] · status [--dir D] [--os O] [--all]   (sleep từ chối khi job khác đang giữ máy; --force bỏ qua)
  job    [--dir D] [--os O] [--need nhãn] -- <lệnh máy bạn>   (luôn cho máy ngủ khi xong; job cùng dự án chờ nhau)
exit: 0 ổn · 1 lỗi · 2 dùng sai · 3 Devin không dùng được (chạy máy bạn)`

// Mỗi lệnh: cờ nhận giá trị, cờ bật/tắt, số đối số vị trí, có phần sau `--` không.
const SPECS = {
  where: { value: ['dir', 'need'], bool: [], pos: [0, 0] },
  up: { value: ['dir', 'os'], bool: ['audio'], pos: [0, 0] },
  run: { value: ['dir', 'os', 'env', 'timeout'], bool: [], pos: [0, 0], rest: true },
  sync: { value: ['dir', 'os'], bool: ['full', 'setup'], pos: [0, 0] },
  put: { value: ['dir', 'os'], bool: [], pos: [2, 2] },
  get: { value: ['dir', 'os'], bool: [], pos: [2, 2] },
  forward: { value: ['dir', 'os'], bool: ['stop'], pos: [0, 1] },
  gui: { value: ['dir', 'os', 'cwd', 'cmd'], bool: [], pos: [0, 0], rest: true },
  keepalive: { value: ['dir', 'os'], bool: [], pos: [0, 0] }, // ẨN (không ghi trong USAGE): tiến trình nền do `forward` sinh ra
  sleep: { value: ['dir', 'os'], bool: ['force'], pos: [0, 0] },
  status: { value: ['dir', 'os'], bool: ['all'], pos: [0, 0] },
  rm: { value: ['dir', 'os'], bool: [], pos: [0, 0] },
  job: { value: ['dir', 'os', 'need'], bool: [], pos: [0, 0], rest: true },
}

export function parseArgs(argv) {
  const dd = argv.indexOf('--')
  const head = dd < 0 ? argv : argv.slice(0, dd)
  const rest = dd < 0 ? [] : argv.slice(dd + 1)
  const cmd = head[0]
  if (head.includes('-h') || head.includes('--help') || cmd === 'help') return { help: true }
  const spec = SPECS[cmd]
  if (!spec) throw new UsageError(cmd ? `không có lệnh "${String(cmd).slice(0, 40)}"` : 'thiếu lệnh')
  const flags = { env: [] }
  const pos = []
  for (let i = 1; i < head.length; i++) {
    const a = head[i]
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    if (!m) {
      pos.push(a)
      continue
    }
    const [, name, inline] = m
    if (spec.bool.includes(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} không nhận giá trị`)
      flags[name] = true
    } else if (spec.value.includes(name)) {
      const v = inline ?? head[++i]
      if (v === undefined || (inline === undefined && /^--/.test(v))) throw new UsageError(`--${name} cần một giá trị`)
      if (name === 'env') flags.env.push(...v.split(',').map((x) => x.trim()).filter(Boolean))
      else flags[name] = v
    } else throw new UsageError(`${cmd}: không có cờ --${name}`)
  }
  if (pos.length < spec.pos[0] || pos.length > spec.pos[1]) throw new UsageError(`${cmd}: cần ${spec.pos[0] === spec.pos[1] ? spec.pos[0] : `${spec.pos[0]}–${spec.pos[1]}`} đối số, nhận ${pos.length}`)
  if (cmd === 'gui' && flags.cmd !== undefined && rest.length) throw new UsageError('gui: chọn --cmd "<dòng lệnh>" hoặc phần sau "--", không dùng cả hai')
  if (spec.rest && rest.length === 0 && !(cmd === 'gui' && flags.cmd !== undefined)) throw new UsageError(`${cmd}: thiếu lệnh sau "--"`)
  if (!spec.rest && rest.length) throw new UsageError(`${cmd}: không nhận phần sau "--"`)
  if (flags.os !== undefined && !OSES.includes(flags.os)) throw new UsageError(`--os phải là ${OSES.join('|')}`)
  if (flags.timeout !== undefined && !(Number(flags.timeout) > 0)) throw new UsageError('--timeout cần số giây > 0')
  if (cmd === 'forward' && !flags.stop && pos.length !== 1) throw new UsageError('forward: cần <cổng> hoặc --stop')
  if (cmd === 'forward' && flags.stop && pos.length) throw new UsageError('forward --stop không kèm cổng')
  return { cmd, flags, pos, rest }
}

// Đối số dòng lệnh Windows: bọc nháy kép khi có khoảng trắng/nháy.
const winArg = (a) => (/[\s"]/.test(a) || a === '' ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a)

// deps tiêm để test: { ctx, stdout, stderr }. Trả mã thoát.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? process.stdout
  const errOut = deps.stderr ?? process.stderr
  let p
  try {
    p = parseArgs(argv)
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    errOut.write(`devin-vm: ${e.message}\n${USAGE}\n`)
    return 2
  }
  if (p.help) {
    out.write(`${USAGE}\n`)
    return 0
  }
  const ctx = deps.ctx ?? makeCtx()
  const say = (s) => errOut.write(`devin-vm: ${s}\n`)
  const json = (o) => out.write(`${JSON.stringify(o)}\n`)
  const { flags, pos, rest } = p
  const base = { dir: flags.dir, os: flags.os }
  const t0 = ctx.now()
  let code = 1
  let vmId = '-'
  const quotaLog = {} // % hạn mức ngày lúc đầu / lúc xong (up và job điền; lệnh khác để "-" trong log)
  try {
    switch (p.cmd) {
      case 'where': {
        json(await where(ctx, { dir: flags.dir, need: flags.need }))
        code = 0
        break
      }
      case 'up': {
        const r = await up(ctx, { ...base, audio: flags.audio ? true : undefined, quotaLog, say })
        vmId = r.id
        json(r)
        code = 0
        break
      }
      case 'run': {
        const r = await runProject(ctx, { ...base, command: rest.join(' '), env: flags.env, timeout: flags.timeout ? Number(flags.timeout) * 1000 : undefined, say })
        vmId = r.id
        out.write(r.stdout)
        if (r.stderr) errOut.write(r.stderr)
        code = r.timedOut ? 124 : (r.code ?? 255)
        if (r.timedOut) say('lệnh trên máy ảo quá giờ nên đã dừng')
        else if (r.code === null || r.code === 255) say('mất kết nối ssh tới máy ảo')
        break
      }
      case 'sync': {
        json(await syncProject(ctx, { ...base, full: Boolean(flags.full), setup: Boolean(flags.setup), say }))
        code = 0
        break
      }
      case 'put': {
        json(await putFile(ctx, { ...base, local: pos[0], remote: pos[1], say }))
        code = 0
        break
      }
      case 'get': {
        json(await getFile(ctx, { ...base, remote: pos[0], local: pos[1], say }))
        code = 0
        break
      }
      case 'forward': {
        json(flags.stop ? await stopForward(ctx, base) : await startForward(ctx, { ...base, spec: pos[0], say }))
        code = 0
        break
      }
      case 'gui': {
        const [exe, ...args] = rest
        json(await guiLaunch(ctx, { ...base, exe, args: args.map(winArg).join(' '), cwd: flags.cwd ?? '', cmd: flags.cmd, say }))
        code = 0
        break
      }
      case 'keepalive': {
        const why = await runKeepalive(ctx, { ...base, say })
        say(`keepalive dừng: ${why}`)
        code = 0
        break
      }
      case 'sleep': {
        const r = await sleepProject(ctx, { ...base, force: Boolean(flags.force), say })
        vmId = r.id ?? '-'
        json(r)
        code = r.ok ? 0 : 1
        if (r.busy) say(`máy ${r.id} đang có job khác đang dùng (pid ${r.holder}) nên chưa cho ngủ — job xong sẽ tự cho ngủ; chắc chắn thì chạy lại: sleep --force`)
        else if (!r.ok) say(`máy ${r.id} chưa ngủ sau 60 giây (trạng thái ${r.status}) — chạy lại: sleep`)
        break
      }
      case 'status': {
        json(await statusOf(ctx, { ...base, all: Boolean(flags.all) }))
        code = 0
        break
      }
      case 'rm': {
        const r = await removeVm(ctx, base)
        vmId = r.removed ?? '-'
        json(r)
        code = 0
        break
      }
      case 'job': {
        code = await runJob(ctx, { ...base, need: flags.need, command: rest.join(' '), quotaLog, say })
        break
      }
    }
  } catch (e) {
    if (e instanceof UsageError) {
      errOut.write(`devin-vm: ${e.message}\n${USAGE}\n`)
      code = 2
    } else if (e instanceof DevinUnavailable) {
      errOut.write(`devin-vm: ${e.message}${e.loginCmd ? ` — chạy: ${e.loginCmd}` : ''}\n`)
      code = 3
    } else {
      errOut.write(`devin-vm: ${scrub(e instanceof ToolError ? e.message : `lỗi bất ngờ: ${e?.message ?? e}`)}\n`)
      code = 1
    }
  }
  appendLog(ctx, { cmd: p.cmd, id: vmId, ms: ctx.now() - t0, code, quota: p.cmd === 'up' || p.cmd === 'job' ? quotaLog : undefined })
  return code
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code })
}
