// Bọc strix cho flow: chỉ cho quét thư mục cục bộ hoặc app ở localhost; tắt telemetry; mặc định dùng gói ChatGPT.
// Dùng: node ~/.claude/hooks/strix-scan.mjs -t <thư mục|http://localhost:port> --max-budget <USD> [cờ strix khác…]
// Kết quả nằm ở <cwd>/strix_runs/. Exit: 0 sạch · 2 có lỗ hổng · 1 lỗi · 3 bị wrapper từ chối.
// Wrapper từ chối (exit 3) khi: target không phải máy này · thiếu --max-budget (trần chi phí BẮT BUỘC) · không có Docker chạy được
// ("chưa quét sâu được — cần Docker": Strix chạy trong container; ghi câu đó vào báo cáo phát hành). Trước khi chạy in ước tính chi phí.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Ước tính theo research.md §3 (docs.strix.ai không công bố giá; số lấy từ nguồn phụ). Strix mặc định deep.
export const SCAN_MODES = { quick: ["$0,5–5", "vài phút"], standard: ["$2–8", "30–60 phút"], deep: ["$5–20+", "1–4 giờ"] };

const isLocal = (t, exists, realpath) => {
  if (!t) return false; // --target-list: không kiểm được từng dòng ⇒ từ chối
  if (/^https?:\/\//i.test(t)) {
    try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(t).hostname); } catch { return false; }
  }
  // Thư mục/file trên máy này; từ chối đường mạng (\\server\share, //server/share, ổ mạng map sang UNC).
  if (/^[\\/]{2}/.test(t) || !exists(t)) return false;
  try { return !/^[\\/]{2}/.test(realpath(t)); } catch { return false; }
};

const flagValue = (args, name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return { present: true, value: args[i + 1] };
    if (args[i].startsWith(`${name}=`)) return { present: true, value: args[i].slice(name.length + 1) };
  }
  return { present: false };
};

const dockerHint = (platform) =>
  platform === "win32" ? "winget install -e --id Docker.DockerDesktop"
    : platform === "darwin" ? "brew install --cask docker"
      : "https://docs.docker.com/engine/install/";

// deps tiêm để test: { spawn, exists, realpath, env, home, platform, err(dòng) }. Trả mã thoát.
export function main(args = process.argv.slice(2), deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? realpathSync.native;
  const env0 = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const err = deps.err ?? ((s) => console.error(s));

  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-t" || args[i] === "--target") targets.push(args[i + 1]);
    else if (args[i].startsWith("--target=")) targets.push(args[i].slice(9));
    else if (args[i] === "--target-list") targets.push(null);
  }

  const bad = targets.filter((t) => !isLocal(t, exists, realpath));
  if (!targets.length || bad.length) {
    err(`strix-scan từ chối: chỉ quét thư mục trên máy hoặc http(s)://localhost|127.0.0.1. Không hợp lệ: ${bad.map(String).join(", ") || "(thiếu -t)"}`);
    return 3;
  }

  const budget = flagValue(args, "--max-budget");
  if (!budget.present || !/^\d+(\.\d+)?$/.test(budget.value ?? "") || Number(budget.value) <= 0) {
    err(budget.present
      ? `strix-scan từ chối: --max-budget phải là số USD > 0, nhận "${budget.value ?? ""}".`
      : "strix-scan từ chối: thiếu --max-budget <USD> (trần chi phí bắt buộc, vd --max-budget 5).");
    return 3;
  }

  const probe = spawn("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (probe.error || probe.status !== 0) {
    err("chưa quét sâu được — cần Docker (Strix chạy trong container). "
      + `Cài: ${dockerHint(platform)} · đã cài thì mở Docker Desktop cho nó chạy rồi quét lại. ZAP (zap-scan.mjs) vẫn quét thường; ghi "chưa quét sâu" vào báo cáo phát hành.`);
    return 3;
  }

  const mode = flagValue(args, "--scan-mode");
  const modeName = mode.present ? mode.value : "deep";
  const [cost, time] = SCAN_MODES[modeName] ?? [];
  const llm = env0.STRIX_LLM || "chatgpt/gpt-6.1-sol";
  err(cost
    ? `Ước tính chi phí Strix (mode ${modeName}): ~${cost} · thời gian ${time}. Tài liệu Strix không công bố giá; số lấy từ báo cáo cộng đồng.`
    : `Ước tính chi phí Strix: không rõ cho mode "${modeName}" (bảng chỉ có quick|standard|deep).`);
  if (!mode.present) err("Chưa nêu --scan-mode ⇒ Strix mặc định deep (1–4 giờ); thêm --scan-mode quick nếu muốn nhanh và rẻ.");
  err(`Trần đã đặt: $${budget.value} (--max-budget; Strix có thể vượt nhẹ).${llm.startsWith("chatgpt/") ? " Gói ChatGPT không tính theo token nhưng tốn hạn mức." : ""}`);

  const bin = [join(home, ".local", "bin", "strix.exe"), join(home, ".local", "bin", "strix")].find(exists) ?? "strix";
  // PYTHONUTF8/PYTHONIOENCODING: console Windows mặc định cp1252, Strix in báo cáo tiếng Việt sẽ crash (đã dính 2026-10-01).
  const env = {
    ...env0, STRIX_TELEMETRY: "0", STRIX_LLM: llm,
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  };
  const r = spawn(bin, ["-n", ...args], { stdio: "inherit", env });
  return r.status ?? 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
