// Review code bằng model ngoài Codex: Grok 4.7 (Grok CLI) hoặc Gemini 3.8 Flash (agy). Chỉ đọc.
// Dùng: node ~/.claude/hooks/review-ext.mjs --model grok|flash --wt <worktree> --out <file.json>
//         [--brief review-brief.md|review-brief-security.md] [--base main] [--note "<nhánh làm gì>"] [--timeout <giây>]
// Ghi <out> đúng schema review-schema.json (+ "reviewer"). Exit: 0 xong · 1 lỗi/hết giờ/không ra JSON ⇒ dùng dự phòng.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { GROK_ENV } from "./grok.mjs";

export { GROK_ENV };

const KIT = join(homedir(), ".claude");
const INLINE_LIMIT = 24000; // prompt dài hơn ⇒ diff ra file riêng (giới hạn dòng lệnh Windows ~32K ký tự)
const LOCKFILES = ["*.lock", "package-lock.json", "pnpm-lock.yaml", "go.sum"].map((p) => `:(exclude,glob)**/${p}`);

export function parseArgs(argv) {
  const o = { brief: "review-brief.md", base: "main", note: "", timeout: 1500 };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  o.timeout = Number(o.timeout);
  return o;
}

// Lấy object JSON cân ngoặc đầu tiên có mảng "findings" (model hay in thêm chữ trước/sau, hoặc in JSON hai lần).
export function extractReview(text) {
  for (let a = text.indexOf("{"); a !== -1; a = text.indexOf("{", a + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let e = a; e < text.length; e++) {
      const c = text[e];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const j = JSON.parse(text.slice(a, e + 1));
          if (Array.isArray(j.findings)) return j;
        } catch {}
        break;
      }
    }
  }
  return null;
}

export function buildPrompt({ brief, schema, base, note, diff, diffFile }) {
  const head = `${brief}

Phạm vi: git diff ${base}...HEAD (bỏ qua file sinh tự động, lockfile). ${note}
Chỉ đọc: không sửa/tạo file, không commit. Được đọc thêm file khác trong repo khi cần (chỗ gọi, registry dùng chung).
Trả lời DUY NHẤT một JSON hợp lệ theo schema sau (không markdown, không chữ khác), bỏ qua khuôn markdown ở trên:
${schema}
`;
  return diffFile
    ? `${head}\nDiff đã chạy sẵn, nằm ở file: ${diffFile} — đọc file đó trước.`
    : `${head}\nDiff (đã chạy sẵn git diff ${base}...HEAD):\n${diff}`;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!["grok", "flash"].includes(o.model) || !o.wt || !o.out) {
    console.error("Thiếu/sai: --model grok|flash --wt <worktree> --out <file.json>");
    process.exit(1);
  }
  const wt = resolve(o.wt), out = resolve(o.out);
  mkdirSync(dirname(out), { recursive: true });
  const git = spawnSync("git", ["-C", wt, "diff", `${o.base}...HEAD`, "--", ".", ...LOCKFILES], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (git.status !== 0) { console.error(`git diff lỗi: ${git.stderr}`); process.exit(1); }
  if (!git.stdout.trim()) { console.error("Diff rỗng — không có gì để review."); process.exit(1); }

  const parts = {
    brief: readFileSync(join(KIT, "workers", basename(o.brief)), "utf8"),
    schema: readFileSync(join(KIT, "workers", "review-schema.json"), "utf8"),
    base: o.base, note: o.note, diff: git.stdout,
  };
  let prompt = buildPrompt(parts);
  const stem = out.replace(/\.json$/i, "");
  if (prompt.length > INLINE_LIMIT) {
    writeFileSync(`${stem}.diff`, git.stdout);
    prompt = buildPrompt({ ...parts, diffFile: `${stem}.diff` });
  }

  const env = { ...process.env, GIT_PAGER: "cat", PAGER: "cat" };
  let cmd, args, cwd = wt;
  if (o.model === "grok") {
    writeFileSync(`${stem}.prompt.txt`, prompt);
    Object.assign(env, GROK_ENV);
    cmd = "grok";
    // Chỉ cấp công cụ đọc (không shell, không ghi, không agent con). KHÔNG dùng --permission-mode dontAsk: bị từ chối
    // một lệnh là Grok bỏ cả lượt, in đúng một câu dẫn rồi thoát (đã dính 2026-10-01).
    args = ["--prompt-file", `${stem}.prompt.txt`, "--cwd", wt, "-m", "grok-4.7", "--effort", "high",
      "--disable-web-search", "--tools", "read_file,grep,list_dir", "--disallowed-tools", "Agent"];
  } else {
    cmd = "agy";
    args = ["-p", prompt, "--model", "gemini-3.8-flash-high", "--mode", "plan",
      "--print-timeout", `${Math.max(1, Math.floor(o.timeout / 60) - 1)}m`, "--add-dir", dirname(out)];
  }
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: o.timeout * 1000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  const secs = Math.round((Date.now() - t0) / 1000);
  writeFileSync(`${stem}.raw.txt`, `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`);
  const review = extractReview(r.stdout ?? "");
  if (!review) {
    if (/usage limit|rate limit|quota|exhausted/i.test(`${r.stdout}${r.stderr}`)) {
      console.error(`${o.model}: HẾT LƯỢT dùng (gói miễn phí/quota) ⇒ dùng model dự phòng.`);
      process.exit(1);
    }
    console.error(`${o.model}: không ra JSON review (exit=${r.status}, ${r.error?.code ?? ""} ${secs}s). Xem ${stem}.raw.txt`);
    process.exit(1);
  }
  review.reviewer = o.model === "grok" ? "grok-4.7 high" : "gemini-3.8-flash-high";
  writeFileSync(out, JSON.stringify(review, null, 2));
  console.log(`${review.reviewer}: ${review.findings.length} finding, ${secs}s → ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
