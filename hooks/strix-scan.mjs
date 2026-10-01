// Bọc strix cho flow: chỉ cho quét thư mục cục bộ hoặc app ở localhost; tắt telemetry; mặc định dùng gói ChatGPT.
// Dùng: node ~/.claude/hooks/strix-scan.mjs -t <thư mục|http://localhost:port> [cờ strix khác…]
// Kết quả nằm ở <cwd>/strix_runs/. Exit: 0 sạch · 2 có lỗ hổng · 1 lỗi · 3 bị wrapper từ chối.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-t" || args[i] === "--target") targets.push(args[i + 1]);
  else if (args[i].startsWith("--target=")) targets.push(args[i].slice(9));
  else if (args[i] === "--target-list") targets.push(null);
}

const isLocal = (t) => {
  if (!t) return false; // --target-list: không kiểm được từng dòng ⇒ từ chối
  if (/^https?:\/\//i.test(t)) {
    try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(t).hostname); } catch { return false; }
  }
  // Thư mục/file trên máy này; từ chối đường mạng (\\server\share, //server/share, ổ mạng map sang UNC).
  if (/^[\\/]{2}/.test(t) || !existsSync(t)) return false;
  try { return !/^[\\/]{2}/.test(realpathSync.native(t)); } catch { return false; }
};

const bad = targets.filter((t) => !isLocal(t));
if (!targets.length || bad.length) {
  console.error(`strix-scan từ chối: chỉ quét thư mục trên máy hoặc http(s)://localhost|127.0.0.1. Không hợp lệ: ${bad.map(String).join(", ") || "(thiếu -t)"}`);
  process.exit(3);
}

const bin = [join(homedir(), ".local", "bin", "strix.exe"), join(homedir(), ".local", "bin", "strix")].find(existsSync) ?? "strix";
// PYTHONUTF8/PYTHONIOENCODING: console Windows mặc định cp1252, Strix in báo cáo tiếng Việt sẽ crash (đã dính 2026-10-01).
const env = {
  ...process.env, STRIX_TELEMETRY: "0", STRIX_LLM: process.env.STRIX_LLM || "chatgpt/gpt-6.1-sol",
  PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
};
const r = spawnSync(bin, ["-n", ...args], { stdio: "inherit", env });
process.exit(r.status ?? 1);
