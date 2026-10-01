# Spec hook v5 (2026-10-01) — ép các bước hay bị bỏ sót

Chung: Node ESM, không dependency, Windows + git bash. Hook (không phải CLI) lỗi nội bộ ⇒ CHO QUA + log. Docs:
https://code.claude.com/docs/en/hooks. Brief giao worker có thêm khoá `plan=<đường PLAN.md> lane=<tên> base=<nhánh mốc>`.

## Làn A — `hooks/flow-gate.mjs` (+ test)

1. **Dấu test xanh.**
   - CLI `stamp test -- <lệnh…>`: chạy lệnh trong cwd (Windows: `shell: true`), in output ra màn hình đồng thời ghi
     `gatesDir/test-<pid>.log`; exit 0 ⇒ ghi `gatesDir/test-<pid>.json` `{cmd, ts, durationMs}`; exit ≠ 0 ⇒ không ghi dấu,
     thoát với cùng mã. pid = patchId(main, HEAD) như dấu review.
   - Cổng `git merge` vào nhánh chính đòi thêm dấu test (cạnh review, qa). Repo có `.claude/flow.json` `{"tests":"none"}`
     ⇒ không đòi. Lý do chặn liệt kê "test" khi thiếu, kèm lệnh mẫu `node ~/.claude/hooks/flow-gate.mjs stamp test -- <lệnh test đủ bộ>`.
   - Stop nudge và `status` tính cả test.
2. **Chặn lệnh phá huỷ trên nhánh chính** (deny):
   - `git push` có `--force`/`-f`/`--force-with-lease`/`--force-if-includes`, hoặc refspec bắt đầu `+`, mà đích là nhánh
     chính (refspec `main`/`master`, `HEAD` khi đang ở nhánh chính, `--all`/`--mirror`).
   - `git reset --hard` khi repo là thư mục chính (không phải linked worktree) và đang ở nhánh chính.
   - `git branch -D`/`-d -f` xoá nhánh chính; `git checkout -- .`/`git restore .`/`git clean -f*` ở thư mục chính.
3. **Hỏi lại khi push nhánh chính** — `git push` (không force) mà gửi nhánh chính: nếu quét secret sạch thì trả
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Sắp push <n> commit lên <remote>/<main>:\n<git log --oneline base..main, tối đa 15 dòng>"}}`.
   Secret ⇒ deny như cũ (deny thắng ask). Không phải nhánh chính ⇒ giữ hành vi cũ.
4. **Audit phạm vi khi worker nộp** — chế độ `subagent-stop`, agent `coder`/`coder-lite`, receipt KHÔNG phải
   `needs_context`/`blocked`, `stop_hook_active` false: lấy brief = tin nhắn user đầu tiên trong `agent_transcript_path`;
   có `plan=` và `lane=` ⇒ chạy `node <thư mục hook>/lane-check.mjs audit <plan> <lane> --worktree <cwd của input>
   --branch HEAD --base <base= hoặc main>`. Exit 1 ⇒ block, lý do = output OUTSIDE + "gỡ thay đổi ngoài scope, hoặc trả
   return=needs_context kèm tên file". Exit 2/lỗi ⇒ cho qua + log. Không có plan=/lane= ⇒ cho qua.
- Test cho từng mục; toàn bộ test cũ phải xanh.

## Làn B — `hooks/flow-dispatch.mjs` (mới, + test)

1. Chế độ `agent` — PreToolUse matcher `Agent|Task`; đọc `tool_input.subagent_type`, `tool_input.prompt`:
   - `coder`/`coder-lite` có `lane=` trong prompt: thiếu `plan=` ⇒ deny "brief có lane= phải kèm plan=<PLAN.md>". Có
     `plan=` ⇒ chạy `lane-check.mjs plan <plan>` (cwd = cwd của input); exit 1 ⇒ deny với output; exit 2 ⇒ deny với lỗi
     (bảng làn hỏng). Không có `lane=` ⇒ cho qua.
   - `qa-tester`: prompt không khớp `/\b(PORT_BASE|port)\s*=\s*\d{2,5}\b/i` ⇒ deny "brief qa-tester phải có
     PORT_BASE=<n> (node ~/.claude/hooks/wt-env.mjs alloc <worktree>) hoặc port=<n> của app đã chạy sẵn".
   - Agent khác ⇒ cho qua.
2. Chế độ `stop` — Stop, `stop_hook_active` false: cwd trong git repo có `docs/specs/*/progress.md` chưa "xong" (cùng
   luật đọc như session-start: lstat, ≤50 thư mục, đọc ≤64KB); commit HEAD mới hơn mtime sổ đó và chưa nhắc cho HEAD
   này (marker `gatesDir/progress-nudged-<HEAD>`) ⇒ block một lần: "Có commit mới mà sổ <đường> chưa cập nhật: ghi
   pha/làn/bước tiếp theo rồi mới kết thúc." Ghi marker trước khi in.
- Test: coder có lane+plan sạch ⇒ qua · bảng OVERLAP ⇒ deny · lane thiếu plan ⇒ deny · qa-tester thiếu port ⇒ deny, có
  `PORT_BASE=4120` ⇒ qua · `port=9245` ⇒ qua · agent khác ⇒ qua · input hỏng ⇒ qua · stop nhắc một lần rồi thôi · sổ
  "xong" ⇒ không nhắc · ngoài repo ⇒ không in.
