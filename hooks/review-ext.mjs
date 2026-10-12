// Review code / soát plan bằng model ngoài, chỉ đọc: Grok 4.7 high 256k (Cursor CLI) · Gemini Flash (agy) · Codex (Sol, vai security/code) · Opus (agy).
// Dùng: node ~/.claude/hooks/review-ext.mjs --model grok|flash|codex|opus --wt <worktree> --out <file.json>
//         [--brief review-brief.md|review-brief-security.md] [--role <vai>] [--base main] [--note "<nhánh làm gì>"] [--timeout <giây>]
// Ghi <out> đúng schema review-schema.json (+ "reviewer"). Wrapper chỉ chạy MỘT model; thứ tự model do skill quyết.
// Exit: 0 xong · 1 lỗi/chưa sẵn sàng/hết giờ/không ra JSON ⇒ dùng dự phòng · 3 KHÔNG GỬI vì còn secret/dữ liệu riêng (model ngoài chưa nhận gì), hoặc kết quả trả về chứa khoá (không ghi gì).
//
// Model: codex/opus/flash lấy từ hooks/lib/models.mjs resolve(host, vai) — codex: security-reviewer (brief bảo mật) | code-reviewer;
// opus: plan-reviewer (agy); flash: sensitive-reviewer (agy); --role ghi đè. Grok chạy qua Cursor, không có trong kit/roles.json ⇒ giữ model cố định.
// Trước khi gọi: hooks/lib/clis.mjs check() — CLI chưa cài/chưa đăng nhập ⇒ exit 1 kèm lời của clis.
//
// Hợp đồng gửi sạch (AC-28), cả ba tầng đều phải qua mới gọi model:
//  1. diff: bỏ hunk của file nhạy cảm/dữ liệu riêng (isSensitiveFile, isPrivateData + glob `private` trong .claude/flow.json, thêm .mcp.json và Note/);
//     scanDiff quét CẢ dòng xoá; còn secret ⇒ exit 3.
//  2. prompt: scanText lại toàn bộ chữ sắp gửi (brief + --note + diff) trước khi ghi ra đâu cả; còn secret ⇒ exit 3.
//  3. workspace: reviewer KHÔNG thấy worktree thật mà thấy thư mục tạm dựng từ `git archive HEAD` (bỏ file nhạy cảm/dữ liệu riêng/liên kết/file quá lớn),
//     scanDir({outbound:true}) phải sạch (file nhị phân quét không được thì bị xoá khỏi workspace); xoá sau khi xong (kể cả khi lỗi).
//  4. kết quả: output của reviewer (raw + JSON) quét scanText trước khi ghi file; có khoá ⇒ exit 3, không ghi gì (prompt injection).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, basename, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { GROK_ENV } from "./grok.mjs";
import { check as checkCli, classifyFailure, resolveBin } from "./lib/clis.mjs";
import { resolve as resolveModel } from "./lib/models.mjs";
import { staleHint } from "./lib/updates.mjs";
import { scanDiff, scanText, scanDir, isSensitiveFile, isPrivateData, unquoteGitPath, diffSectionPaths } from "./lib/secrets.mjs";

export { GROK_ENV };

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // ~/.claude khi đã cài; brief/schema nằm ở KIT/workers
const INLINE_LIMIT = 24000; // prompt dài hơn ⇒ diff ra file riêng (giới hạn dòng lệnh Windows ~32K ký tự)
const LOCKFILES = ["*.lock", "package-lock.json", "pnpm-lock.yaml", "go.sum"].map((p) => `:(exclude,glob)**/${p}`);
const MODELS = ["grok", "flash", "codex", "opus"];
const CLI_OF = { grok: "cursor-agent", flash: "agy", opus: "agy", codex: "codex" };
const HOST_OF = { flash: "agy", opus: "agy", codex: "codex" }; // host trong kit/roles.json (grok qua Cursor: không có)
const IN_DIR = "flow-review-input"; // trong workspace tạm: prompt (grok), diff lớn, schema
const EXTRA_PRIVATE = [".mcp.json", "Note/**"]; // luật kit: reviewer không được đọc (xem review-brief.md); thêm vào glob `private` của dự án
const MAX_FILE_BYTES = 10 * 1024 * 1024; // = mức scanDir chịu quét; file lớn hơn không quét được ⇒ không đưa vào workspace
const MAX_OUTPUT = 64 << 20;
const CURSOR_MODEL = "grok-4.7[context=256k,reasoning_effort=high,fast=false]";
const SAFE_ARG = /^[\w.:=/-]+$/;

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
Chỉ đọc: không sửa/tạo file, không commit. Thư mục làm việc là bản sao HEAD đã lọc (không có .git; file nhạy cảm/dữ liệu riêng đã bị bỏ) — được đọc thêm file khác trong đó khi cần (chỗ gọi, registry dùng chung).
Trả lời DUY NHẤT một JSON hợp lệ theo schema sau (không markdown, không chữ khác), bỏ qua khuôn markdown ở trên:
${schema}
`;
  return diffFile
    ? `${head}\nDiff đã chạy sẵn, nằm ở file: ${diffFile} — đọc file đó trước.`
    : `${head}\nDiff (đã chạy sẵn git diff ${base}...HEAD):\n${diff}`;
}

// ---------- gửi sạch ----------

const asList = (p) => (Array.isArray(p) ? p : typeof p === "string" ? [p] : []);
const outboundCfg = (cfg) => ({ ...cfg, private: [...asList(cfg?.private), ...EXTRA_PRIVATE] });

// .claude/flow.json của dự án (glob `private`). Không có file ⇒ {}. Hỏng ⇒ ném lỗi (không biết glob riêng ⇒ không được gửi).
function loadProjectCfg(wt) {
  let text;
  try { text = readFileSync(join(wt, ".claude", "flow.json"), "utf8"); } catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  const j = JSON.parse(text.replace(/^﻿/, ""));
  return j && typeof j === "object" && !Array.isArray(j) ? j : {};
}

// `git diff -z --name-status -M -C` → các cặp đổi tên/sao chép [{ status: 'R'|'C', from, to }]. Tên THÔ (không nháy C-quote), nên khớp đúng tên trong
// git archive kể cả khi có ", \, tab, xuống dòng. Dạng: "M\0path\0", "R087\0old\0new\0", "C100\0src\0dst\0". Lệch khuôn ⇒ ném (không đoán).
export function parseNameStatusZ(text) {
  const t = text.split("\0");
  if (t.at(-1) === "") t.pop();
  const out = [];
  for (let i = 0; i < t.length; ) {
    const status = t[i++];
    const pair = /^[RC]/.test(status);
    if (!/^[A-Z]\d*$/.test(status) || i + (pair ? 2 : 1) > t.length) throw new Error(`name-status -z lệch khuôn ở "${status.slice(0, 20)}"`);
    if (pair) out.push({ status: status[0], from: t[i], to: t[i + 1] });
    i += pair ? 2 : 1;
  }
  return out;
}

// Tầng 1. diff → { diff đã lọc, dropped: file bị bỏ hunk (kèm đích của đổi tên/sao chép từ file đó), findings: secret còn trong phần giữ lại (kể cả dòng xoá) }.
// Hunk của file bị bỏ không bao giờ được gửi nên secret trong đó không tính. Đường dẫn trong diff có thể bọc nháy C-quote ⇒ luôn giải qua lib/secrets (unquoteGitPath).
// moves = parseNameStatusZ(...) của cùng phạm vi diff: đích của đổi tên/sao chép TỪ file nhạy cảm/dữ liệu riêng luôn bị bỏ (vào dropped + loại mục diff mang đích đó),
// không phụ thuộc diff có còn dòng rename/copy hay không (đích mang nội dung của nguồn, tên mới không còn lộ).
export function sanitizeDiff(diff, projectCfg, { moves = [] } = {}) {
  const cfg = outboundCfg(projectCfg);
  const kept = [], dropped = new Set(), findings = [];
  const movedFromPrivate = new Set(moves.filter((m) => isSensitiveFile(m.from) || isPrivateData(m.from, cfg)).map((m) => m.to));
  for (const to of movedFromPrivate) dropped.add(to);
  for (const sec of diff.split(/^(?=diff --git )/m)) {
    if (!sec) continue;
    const hits = scanDiff(sec, { projectCfg: cfg });
    const fileLevel = hits.filter((h) => h.line === null); // 'file nhạy cảm' | 'dữ liệu riêng' (kể cả đổi tên từ/sang file đó)
    const carriesMoved = diffSectionPaths(sec).filter((p) => movedFromPrivate.has(p));
    if (fileLevel.length || carriesMoved.length) {
      for (const h of fileLevel) dropped.add(h.file);
      // đổi tên/sao chép TỪ file bị bỏ ⇒ đường dẫn đích mang nội dung của nó: cũng vào dropped để workspace loại theo
      const from = unquoteGitPath(/^(?:rename|copy) from ([^\r\n]+)/m.exec(sec)?.[1] ?? "");
      const to = unquoteGitPath(/^(?:rename|copy) to ([^\r\n]+)/m.exec(sec)?.[1] ?? "");
      if (from && to && fileLevel.some((h) => h.file === from)) dropped.add(to);
      continue;
    }
    kept.push(sec);
    findings.push(...hits);
  }
  return { diff: kept.join(""), dropped: [...dropped], findings };
}

function parsePax(data) {
  const out = {};
  for (let p = 0; p < data.length; ) {
    const sp = data.indexOf(0x20, p);
    const len = sp < 0 ? 0 : parseInt(data.subarray(p, sp).toString(), 10);
    if (!(len > 0)) break;
    const rec = data.subarray(sp + 1, p + len - 1).toString("utf8"); // "key=value" (bỏ \n cuối)
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

// Đọc luồng tar do `git archive` sinh (ustar + pax header cho đường dẫn dài). Không cần lệnh `tar` của máy (Windows có thể là GNU hoặc bsdtar,
// xử lý liên kết tượng trưng khác nhau). Mỗi mục: { name, type: '0' file | '2' symlink | '5' thư mục…, data }.
export function* tarEntries(buf) {
  let pax = {};
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return;
    const text = (a, b) => { const s = h.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString("utf8"); };
    const size = parseInt(text(124, 136).trim() || "0", 8);
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const prefix = text(345, 500);
    const name = pax.path ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    if (!Number.isFinite(size) || off + 512 + size > buf.length) throw new Error("luồng tar hỏng hoặc bị cắt cụt");
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { pax = parsePax(data); continue; }
    if (type === "g") continue;
    yield { name, type, data };
    pax = {};
  }
}

// Tầng 3. Dựng workspace cho reviewer từ `git archive HEAD` vào thư mục dest (đã tồn tại, rỗng). Chỉ file thường: bỏ file nhạy cảm/dữ liệu riêng,
// liên kết tượng trưng (có thể trỏ ra ngoài), file quá lớn để quét, và `exclude` (đường dẫn ép bỏ: đích đổi tên/sao chép từ file nhạy cảm — tên mới
// không còn lộ là nhạy cảm nhưng nội dung vẫn thế). Không có .git. → { files, omitted: { private, links, large, skipped } }
export function buildWorkspace(wt, dest, projectCfg, { maxFileBytes = MAX_FILE_BYTES, exclude = [] } = {}) {
  const cfg = outboundCfg(projectCfg);
  // tên thật (git archive) lẫn dạng đã đổi \ → / (đường dẫn kiểu Windows): thà loại dư còn hơn sót
  const forced = new Set(exclude.flatMap((p) => [String(p), String(p).replace(/\\/g, "/").replace(/^\.\//, "")]));
  const a = spawnSync("git", ["-C", wt, "-c", "core.autocrlf=false", "archive", "--format=tar", "HEAD"], { maxBuffer: 1 << 30 });
  if (a.status !== 0) throw new Error(`git archive lỗi: ${a.error?.message ?? String(a.stderr ?? "").trim()}`);
  const omitted = { private: 0, links: 0, large: 0, skipped: 0 };
  let files = 0;
  for (const e of tarEntries(a.stdout)) {
    if (e.type === "1" || e.type === "2") { omitted.links++; continue; }
    if (e.type !== "0") continue; // thư mục (tạo khi cần), submodule rỗng…
    if (isSensitiveFile(e.name) || isPrivateData(e.name, cfg) || forced.has(e.name)) { omitted.private++; continue; }
    if (e.data.length > maxFileBytes) { omitted.large++; continue; }
    const target = join(dest, ...e.name.split("/"));
    const rel = relative(dest, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) { omitted.skipped++; continue; }
    try { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, e.data); files++; } catch { omitted.skipped++; }
  }
  return { files, omitted };
}

const describeHit = (f) => `${f.file ?? "prompt"}${f.line ? `:${f.line}` : ""} (${f.name}${f.removed ? ", dòng xoá" : ""})`;
const refuse = (where, list) =>
  `KHÔNG GỬI — ${where} còn thứ nhạy cảm (${list.length}): ${list.slice(0, 10).map(describeHit).join("; ")}${list.length > 10 ? "; …" : ""}. ` +
  "Xoá/đổi khoá (kể cả dòng đã xoá trong diff) rồi chạy lại; model ngoài chưa nhận gì.";

// ---------- chạy reviewer ----------

function killTree(child, win, env) {
  try {
    if (win) {
      const root = env.SystemRoot || env.windir;
      spawn(root ? join(root, "System32", "taskkill.exe") : "taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      process.kill(-child.pid, "SIGKILL"); // cả nhóm tiến trình (child chạy detached ⇒ làm trưởng nhóm)
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* đã thoát */ }
  }
}

// Chạy `file args…` (không qua shell) với giờ chờ cứng, diệt cả cây tiến trình khi quá giờ. Không bao giờ reject:
// { status, stdout, stderr, timedOut, error: {code,message}|null }. input ≠ null ⇒ ghi vào stdin. Windows .cmd/.bat (shim npm của codex): Node không cho spawn thẳng
// ⇒ cmd.exe /d /s /c với dòng lệnh dựng từ đối số "an toàn" ([\w.:=/-]); đối số lạ hoặc đường dẫn có " % ! bị từ chối (EUNSAFE).
export function runReviewer(file, args, { cwd, env = process.env, input, timeoutMs = 1500 * 1000 } = {}) {
  return new Promise((done) => {
    const win = process.platform === "win32";
    let stdout = "", stderr = "", timedOut = false, settled = false, timer = null;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ status: null, stdout, stderr, timedOut, error: null, ...extra });
    };
    let cmd = file, argv = args;
    const opts = { cwd, env, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true, detached: !win };
    if (win && /\.(?:cmd|bat)$/i.test(file)) {
      if (!args.every((a) => SAFE_ARG.test(a)) || /["%!]/.test(file)) return finish({ error: { code: "EUNSAFE", message: "đối số hoặc đường dẫn không an toàn để chạy qua cmd.exe" } });
      cmd = env.ComSpec || env.COMSPEC || "cmd.exe";
      argv = ["/d", "/s", "/c", `"${[`"${file}"`, ...args].join(" ")}"`]; // cmd /s bỏ cặp nháy ngoài cùng, giữ nháy quanh đường dẫn có dấu cách
      opts.windowsVerbatimArguments = true;
    }
    let child;
    try { child = spawn(cmd, argv, opts); } catch (e) { return finish({ error: { code: e.code ?? "ESPAWN", message: e.message } }); }
    child.on("error", (e) => finish({ error: { code: e.code ?? "ESPAWN", message: e.message } }));
    child.on("close", (status) => finish({ status }));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    if (input != null) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, win, env);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({});
    }, timeoutMs);
  });
}

const defaultRole = (model, brief) =>
  model === "codex" ? (/security/i.test(brief) ? "security-reviewer" : "code-reviewer") : model === "opus" ? "plan-reviewer" : "sensitive-reviewer";

// Lệnh gọi từng model. Mọi đường dẫn đưa cho reviewer đều tương đối với workspace (cwd) — không lộ đường dẫn máy, không dẫn ra ngoài workspace.
function buildCall(model, { ws, prompt, resolved, timeout }) {
  const m = resolved?.model ?? null; // null = không chọn được ⇒ để CLI dùng mặc định (không đoán id)
  if (model === "codex") {
    return {
      cmd: resolveBin("codex") ?? "codex",
      input: prompt, // qua stdin: không dính giới hạn dòng lệnh, không phải quote
      label: `${m ?? "codex (model mặc định)"}${resolved?.effort ? ` ${resolved.effort}` : ""}`,
      args: ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--output-schema", `${IN_DIR}/review-schema.json`,
        ...(m ? ["-m", m] : []), ...(resolved?.effort ? ["-c", `model_reasoning_effort=${resolved.effort}`] : []), "-"],
    };
  }
  if (model === "grok") {
    // Grok 4.7 high 256k qua Cursor CLI (hạn mức gói Cursor Pro). Grok CLI của xAI (gói Grok Build miễn phí) hết lượt 2026-10-03 ⇒ bỏ.
    // Windows: gọi thẳng cursor-agent.ps1 — đi qua .cmd thì prompt nhiều dòng vỡ ở hai lớp dòng lệnh. Prompt đầy đủ nằm trong file, chỉ truyền một câu ngắn.
    // --mode plan = chỉ đọc. context=500k/1m bị CLI từ chối (thử 2026-10-03) — 256k là mức cao nhất tài khoản có.
    const cursorArgs = ["-p", "--output-format", "text", "--mode", "plan", "--trust", "--model", CURSOR_MODEL, "--workspace", ws,
      `Read the file ${IN_DIR}/prompt.txt and do exactly what it asks. Reply with the JSON only.`];
    const label = "grok-4.7 high 256k (Cursor)";
    if (process.platform !== "win32") return { cmd: resolveBin("cursor-agent") ?? "cursor-agent", args: cursorArgs, label };
    const ps1 = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "cursor-agent", "cursor-agent.ps1");
    const root = process.env.SystemRoot ?? process.env.windir;
    return {
      cmd: root ? join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...cursorArgs],
      label,
    };
  }
  return { // flash | opus: agy; mức effort nằm trong id model
    cmd: resolveBin("agy") ?? "agy",
    label: m ?? "agy (model mặc định)",
    args: ["-p", prompt, ...(m ? ["--model", m] : []), "--mode", "plan", "--print-timeout", `${Math.max(1, Math.floor(timeout / 60) - 1)}m`],
  };
}

// ---------- chạy ----------

// CLI ngoài lỗi kiểu "bản cũ" (model không hỗ trợ, cần bản mới hơn, please upgrade…) ⇒ kiểm phiên bản TƯƠI của CLI đó và nói nguyên nhân + đề nghị cập nhật
// bằng một dòng (zzma CN-05). Lỗi khác ⇒ null ngay, không chạm mạng. Không bao giờ ném.
async function staleHintOf(deps, cli, text) {
  try { return await (deps.staleHint ?? staleHint)(cli, text); } catch { return null; }
}

// Biến môi trường truyền cho reviewer (AC-28 tầng 4): bỏ mọi biến tên dạng khoá/mật khẩu của máy (vd khoá Supabase user để ở
// biến môi trường) — reviewer đọc code từ ngoài, bị prompt injection vẫn không in được chúng. Chỉ giữ biến đăng nhập của
// đúng CLI đang gọi (CLI nào đăng nhập bằng tài khoản thì lưu ở cấu hình riêng, không cần env).
const SECRET_ENV = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION/i;
const LOGIN_ENV = {
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  grok: ["CURSOR_API_KEY"],
  flash: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  opus: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};
// Lọc cả theo GIÁ TRỊ: tên vô hại (BUILD_REF, DATABASE_URL) nhưng giá trị là khoá / URL có mật khẩu (postgres://u:p@h) cũng bỏ. scanText chỉ bắt mật khẩu
// URL ≥ 8 ký tự; với biến môi trường thà bỏ dư: mọi URL có dạng user:mật-khẩu@ đều bỏ.
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i;
const leaksByValue = (k, v) => typeof v === "string" && (scanText(`${k}=${v}`).length > 0 || URL_USERINFO.test(v));
export function reviewerEnv(parent, model) {
  const keep = new Set(LOGIN_ENV[model] ?? []);
  return Object.fromEntries(Object.entries(parent).filter(([k, v]) => keep.has(k) || (!SECRET_ENV.test(k) && !leaksByValue(k, v))));
}

// deps (tuỳ chọn, cho test): check(name) · resolve(host, vai) · exec(file, args, {cwd, env, input, timeoutMs}) · tmpRoot · io {out, err}
export async function run(argv, deps = {}) {
  const io = deps.io ?? { out: (s) => console.log(s), err: (s) => console.error(s) };
  const o = parseArgs(argv);
  if (!MODELS.includes(o.model) || !o.wt || !o.out) {
    io.err("Thiếu/sai: --model grok|flash|codex|opus --wt <worktree> --out <file.json> [--role <vai>]");
    return 1;
  }
  try {
    return await review(o, io, deps);
  } catch (e) {
    io.err(`${o.model}: lỗi không mong đợi: ${e.message}`);
    return 1;
  }
}

async function review(o, io, deps) {
  const check = deps.check ?? checkCli;
  const exec = deps.exec ?? runReviewer;
  const wt = resolve(o.wt), out = resolve(o.out), stem = out.replace(/\.json$/i, "");
  const cli = CLI_OF[o.model];

  const st = await check(cli);
  if (!st.ready) {
    io.err(`${st.message}${st.loginCmd ? `. Đăng nhập: ${st.loginCmd}` : ""}${st.installHint ? `. Cài: ${st.installHint}` : ""} ⇒ dùng model dự phòng.`);
    return 1;
  }
  let resolved = null;
  if (HOST_OF[o.model]) {
    try { resolved = (deps.resolve ?? resolveModel)(HOST_OF[o.model], o.role ?? defaultRole(o.model, o.brief)); } catch (e) { io.err(`${o.model}: ${e.message}`); return 1; }
    for (const w of resolved.warnings ?? []) io.err(`! ${w}`);
  }
  mkdirSync(dirname(out), { recursive: true });

  // tầng 1
  let cfg;
  try { cfg = loadProjectCfg(wt); } catch (e) {
    io.err(`${o.model}: KHÔNG GỬI — không đọc được .claude/flow.json (${e.message}) nên không biết glob dữ liệu riêng của dự án. Sửa file rồi chạy lại.`);
    return 3;
  }
  const git = spawnSync("git", ["-C", wt, "-c", "core.quotepath=off", "diff", "-M", "-C", `${o.base}...HEAD`, "--", ".", ...LOCKFILES], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (git.status !== 0) { io.err(`git diff lỗi: ${git.stderr}`); return 1; }
  if (!git.stdout.trim()) { io.err("Diff rỗng — không có gì để review."); return 1; }
  // Danh sách đổi tên/sao chép với tên THÔ (-z, không nháy C-quote), không giới hạn pathspec (nguồn nằm trong lockfile bị loại vẫn ghép được với đích).
  // Không đọc được ⇒ không biết đích nào mang nội dung của file riêng ⇒ KHÔNG GỬI.
  let moves;
  try {
    const ns = spawnSync("git", ["-C", wt, "diff", "-z", "--name-status", "-M", "-C", `${o.base}...HEAD`], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (ns.status !== 0) throw new Error(String(ns.stderr ?? ns.error?.message ?? "").trim() || `exit ${ns.status}`);
    moves = parseNameStatusZ(ns.stdout);
  } catch (e) {
    io.err(`${o.model}: KHÔNG GỬI — không lấy được danh sách đổi tên/sao chép của diff (${e.message}) nên không loại được bản sao của file nhạy cảm/dữ liệu riêng. Model ngoài chưa nhận gì.`);
    return 3;
  }
  const { diff, dropped, findings } = sanitizeDiff(git.stdout, cfg, { moves });
  if (findings.length) { io.err(`${o.model}: ${refuse("diff", findings)}`); return 3; }
  if (dropped.length) io.err(`Bỏ khỏi diff gửi đi (file nhạy cảm/dữ liệu riêng): ${dropped.join(", ")}`);
  if (!diff.trim()) { io.err("Diff chỉ gồm file nhạy cảm/dữ liệu riêng — không có gì được phép gửi để review."); return 1; }

  const parts = {
    brief: readFileSync(join(KIT, "workers", basename(o.brief)), "utf8"),
    schema: readFileSync(join(KIT, "workers", "review-schema.json"), "utf8"),
    base: o.base, note: o.note, diff,
  };
  const ws = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "flow-review-"));
  try {
    // tầng 3
    const built = buildWorkspace(wt, ws, cfg, { exclude: dropped });
    const scanned = scanDir(ws, { outbound: true, projectCfg: outboundCfg(cfg) });
    // file nhị phân (có NUL, không phải UTF-16) quét không được ⇒ không coi là sạch: xoá khỏi workspace (reviewer không cần đọc), không chặn cả lượt
    const binaries = scanned.filter((f) => f.name === "binary");
    for (const f of binaries) rmSync(join(ws, ...f.file.split("/")), { force: true });
    const bad = scanned.filter((f) => f.name !== "binary");
    if (bad.length) { io.err(`${o.model}: ${refuse("workspace", bad)}`); return 3; }
    const { private: nPrivate, links, large, skipped } = built.omitted;
    io.err(`Workspace tạm: ${built.files - binaries.length} file (bỏ ${nPrivate} nhạy cảm/dữ liệu riêng, ${links} liên kết, ${large} quá lớn, ${binaries.length} nhị phân${skipped ? `, ${skipped} không ghi được` : ""}).`);

    // tầng 2
    let prompt = buildPrompt(parts);
    const separate = prompt.length > INLINE_LIMIT;
    if (separate) prompt = buildPrompt({ ...parts, diffFile: `${IN_DIR}/diff.patch` });
    const hits = [...scanText(prompt), ...(separate ? scanText(diff) : [])];
    if (hits.length) { io.err(`${o.model}: ${refuse("prompt (brief/--note/diff)", hits)}`); return 3; }

    mkdirSync(join(ws, IN_DIR));
    writeFileSync(join(ws, IN_DIR, "review-schema.json"), parts.schema);
    if (separate) { writeFileSync(join(ws, IN_DIR, "diff.patch"), diff); writeFileSync(`${stem}.diff`, diff); }
    if (o.model === "grok") writeFileSync(join(ws, IN_DIR, "prompt.txt"), prompt);
    writeFileSync(`${stem}.prompt.txt`, prompt); // bản lưu đúng cái đã gửi

    const call = buildCall(o.model, { ws, prompt, resolved, timeout: o.timeout });
    const env = { ...reviewerEnv(process.env, o.model), GIT_PAGER: "cat", PAGER: "cat" };
    // Gọi từ Git Bash: có MSYSTEM ⇒ Cursor chạy hook Claude (~/.claude/settings.json) bằng bash nhưng bọc lệnh kiểu PowerShell
    // ⇒ hook lỗi cú pháp, chặn mọi lần đọc file (dính 2026-10-03). Bỏ đi để Cursor dùng PowerShell.
    if (o.model === "grok") { delete env.MSYSTEM; delete env.SHELL; }

    const t0 = Date.now();
    const r = await exec(call.cmd, call.args, { cwd: ws, env, input: call.input, timeoutMs: o.timeout * 1000 });
    const secs = Math.round((Date.now() - t0) / 1000);
    const rawText = `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`;
    const result = extractReview(r.stdout ?? "");
    // Kết quả từ model ngoài là đầu vào không tin cậy: bị prompt injection có thể in khoá của máy ra. Quét cả raw lẫn JSON đã giải mã
    // (thoát unicode chỉ lộ sau khi giải mã) TRƯỚC khi ghi bất cứ gì; thấy khoá ⇒ không ghi nội dung.
    const leaked = [...scanText(rawText), ...(result ? scanText(JSON.stringify(result, null, 2)) : [])];
    if (leaked.length) {
      io.err(`${o.model}: kết quả review chứa khoá — có thể bị prompt injection (${[...new Set(leaked.map((f) => f.name))].join(", ")}). Không ghi kết quả; ` +
        "dùng model dự phòng và kiểm tra xem diff/brief có chữ lạ ra lệnh cho reviewer không.");
      return 3;
    }
    writeFileSync(`${stem}.raw.txt`, rawText);
    if (!result) {
      const v = classifyFailure(cli, { code: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, error: r.error });
      if (v.reason === "quota") io.err(`${o.model}: HẾT LƯỢT dùng (gói miễn phí/quota) ⇒ dùng model dự phòng.`);
      else if (v.reason === "not-logged-in") io.err(`${o.model}: ${v.message}. Đăng nhập: ${v.loginCmd} ⇒ dùng model dự phòng.`);
      else io.err(`${o.model}: không ra JSON review (exit=${r.status}, ${r.timedOut ? "ETIMEDOUT" : (r.error?.code ?? "")} ${secs}s). Xem ${stem}.raw.txt`);
      const hint = await staleHintOf(deps, cli, rawText);
      if (hint) io.err(hint);
      return 1;
    }
    result.reviewer = call.label;
    writeFileSync(out, JSON.stringify(result, null, 2));
    io.out(`${result.reviewer}: ${result.findings.length} finding, ${secs}s → ${out}`);
    return 0;
  } finally {
    try { rmSync(ws, { recursive: true, force: true, maxRetries: 3 }); } catch { io.err(`Không xoá được workspace tạm ${ws} (nội dung đã lọc sạch); xoá tay khi rảnh.`); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
