// Gọi Grok CLI không nạp cấu hình Claude Code/Cursor (MCP, hook, skill, luật, agent). Grok tự nạp mấy thứ đó ⇒ ~70s
// khởi động, MCP lỗi đăng nhập, công cụ web/shell đứng "pending" vô hạn (nguyên nhân treo trước 2026-10-01).
// Dùng: node ~/.claude/hooks/grok.mjs <cờ grok…>   (vd: -p "<câu hỏi>" -m grok-4.7 --effort high --tools web_search,web_fetch)
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GROK_ENV = {
  ...Object.fromEntries(
    ["CLAUDE", "CURSOR"].flatMap((v) => ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS"].map((c) => [`GROK_${v}_${c}_ENABLED`, "0"])),
  ),
  GIT_PAGER: "cat", PAGER: "cat", // git mở pager khi không có terminal ⇒ treo
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = spawnSync("grok", process.argv.slice(2), { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...GROK_ENV } });
  process.exit(r.status ?? 1);
}
