// git-bin: tìm git bằng ĐƯỜNG DẪN TUYỆT ĐỐI rồi mới chạy, không chạy theo tên. Lý do: Windows tìm chương trình trong thư mục làm việc của tiến trình con TRƯỚC PATH
// (khi tiến trình cha không đặt NoDefaultCurrentDirectoryInExePath), nên `spawnSync('git', …, { cwd: <dự án> })` chạy nhầm git.exe do repo lạ mang theo, bằng quyền của user.
// Chỉ nhận mục PATH tuyệt đối (bỏ ".", "bin", mục rỗng), rồi thư mục cài quen cố định; không bao giờ lấy thư mục làm việc. Không thấy git ⇒ runGit trả kết quả lỗi (không ném).
// env.VIBE_FLOW_PATH_ONLY=1 (kiểm thử): chỉ tìm trên PATH, bỏ thư mục cài quen — cùng quy ước với hooks/lib/models.mjs findExe.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WIN = process.platform === 'win32'
const hits = new Map()

function usable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (!WIN) fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Đường dẫn tuyệt đối tới git, hoặc null. Theo thứ tự PATH (mục tuyệt đối), rồi thư mục cài quen. env: mặc định process.env. */
export function gitBin(env = process.env) {
  const pathVar = String(env.PATH ?? env.Path ?? '')
  const only = Boolean(env.VIBE_FLOW_PATH_ONLY)
  const key = `${pathVar}\0${only}`
  const hit = hits.get(key)
  if (hit && usable(hit)) return hit
  const dirs = pathVar.split(path.delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter((d) => d && path.isAbsolute(d))
  if (!only) {
    if (WIN) {
      for (const v of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) if (env[v]) dirs.push(path.join(env[v], 'Git', 'cmd'))
      if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'))
    } else {
      dirs.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/bin')
    }
  }
  const name = WIN ? 'git.exe' : 'git'
  for (const d of dirs) {
    const f = path.join(d, name)
    if (usable(f)) { hits.set(key, f); return f }
  }
  return null
}

const NOT_FOUND = () => ({ status: null, signal: null, stdout: '', stderr: '', pid: 0, output: null, error: Object.assign(new Error('git không có trên PATH'), { code: 'ENOENT' }) })

/** spawnSync(git tuyệt đối, args, opts). opts.env (nếu có) cũng dùng để tìm git. Không có git ⇒ { status: null, error } thay vì ném. */
export function runGit(args, opts = {}) {
  const bin = gitBin(opts.env ?? process.env)
  return bin ? spawnSync(bin, args, opts) : NOT_FOUND()
}
