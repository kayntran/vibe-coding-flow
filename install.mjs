// Ghép hook của flow vào ~/.claude/settings.json của máy này. Chạy lại nhiều lần vẫn an toàn.
// Dùng: clone repo vào ~/.claude (hoặc chép file vào đó) rồi `node ~/.claude/install.mjs`.
// `backup <ref>` (chạy TRƯỚC checkout): sao lưu file đang có trùng tên với file của kit thành *.before-kit-<thời điểm>.
import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(homedir(), ".claude").replaceAll("\\", "/");

if (process.argv[2] === "backup") {
  const ref = process.argv[3] ?? "origin/main";
  const files = execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", ref], { encoding: "utf8" })
    .split("\n").filter(Boolean);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const saved = files.filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile());
  for (const f of saved) copyFileSync(join(root, f), join(root, `${f}.before-kit-${stamp}`));
  console.log(saved.length ? `Đã sao lưu ${saved.length} file trùng tên (*.before-kit-${stamp}):\n- ${saved.join("\n- ")}` : "Không có file trùng tên, không cần sao lưu.");
  process.exit(0);
}
const settingsPath = join(root, "settings.json");
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.before-install-${Date.now()}`);

const cmd = (script, timeout) => ({ type: "command", command: `node ${root}/hooks/${script}`, timeout });
const wanted = [
  ["UserPromptSubmit", undefined, cmd("reply-vietnamese.mjs", 5)],
  ["PreToolUse", "Edit|Write|NotebookEdit", cmd("flow-gate.mjs edit", 15)],
  ["PreToolUse", "Bash", cmd("flow-gate.mjs bash", 15)],
  ["Stop", undefined, cmd("flow-gate.mjs stop", 15)],
  ["SubagentStop", undefined, cmd("flow-gate.mjs subagent-stop", 15)],
  ["SessionStart", undefined, cmd("session-start.mjs", 10)],
  ["PostToolUse", "mcp__.*", cmd("mcp-usage.mjs log", 5)],
];

settings.hooks ??= {};
for (const [event, matcher, hook] of wanted) {
  const list = (settings.hooks[event] ??= []);
  const script = hook.command.split("/hooks/")[1];
  // Bỏ đúng command cũ của cùng script (đường dẫn máy khác); giữ các hook khác chung entry, entry rỗng thì bỏ.
  settings.hooks[event] = list
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !h.command?.endsWith(`/hooks/${script}`)) }))
    .filter((e) => e.hooks.length > 0);
  settings.hooks[event].push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
}

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`Đã ghép ${wanted.length} hook vào ${settingsPath}`);
