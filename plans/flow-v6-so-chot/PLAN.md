# PLAN · flow v6 — Sổ chốt, roadmap, ý tưởng

SPEC: `plans/flow-v6-so-chot/SPEC.md` (bản 2, 27 AC) · Research: `research.md` · Cỡ L.

## Kiến trúc

Một bộ thư viện duy nhất đọc/ghi/sinh mọi thứ; hook, mod và skill chỉ gọi nó.

| Phần | Trách nhiệm | Ghi chú |
|---|---|---|
| `hooks/lib/so-chot.mjs` (mới) | Định dạng quyết định, sinh INDEX/ROADMAP, trích đoạn nạp theo khẩu phần, cất kho, ghi ý tưởng, tìm, `.gitattributes`. Hàm thuần + CLI | Nguồn duy nhất của định dạng (AC1, 5, 7–9, 15–21) |
| `hooks/session-start.mjs` | Nạp vào phiên trong trần chung 8.500 ký tự: tiến độ + trích đoạn sổ chốt + 1 dòng roadmap + nhắc MCP | Gọi `excerpt()`/`gen()` của lib (AC10–14, 21, 23) |
| `hooks/lib/legacy-migrate.mjs` (mới) | Chuyển dự án cũ: `plan` (bảng ghép + độ chắc) · `apply` (2 commit) · `verify` | AC25–27 |
| `skills/flow-spec/SKILL.md` | Mẫu progress.md (dòng trỏ sổ chốt), chuẩn thư mục tính năng, rà ý tưởng trùng đầu pha 1 | AC20, 22, 24 |
| `skills/flow-merge/SKILL.md` | Sắp lại thứ tự: gộp → đóng sổ (`xong` + `Xong ngày`) → `so-chot.mjs close <feature>` (cất kho + sinh INDEX/ROADMAP) → commit → push → dọn worktree; chạy lại an toàn | AC15, 22 |
| `hooks/flow-dispatch.mjs` | Chọn sổ theo nhánh qua `openProgress()` của lib (cùng cách với session-start) | AC22b, tính năng anh em |
| `CLAUDE.md` | Luật: quyết định dự án → sổ chốt; ý tưởng → IDEAS.md; memory chỉ sở thích cá nhân | Nguồn sự thật duy nhất |
| Mod `~/.claude/mods/so-chot` (ngoài repo, captain) | Công cụ cho Claude (`ghi_chot`, `tim_chot`, `da_xem`, `ghi_y_tuong`, `ghi_so`), bảng `/chot`, dòng ⚠️ trên ô nhập. Gọi CLI của lib bằng `$.process.run`. BỎ phần tự nạp vào phiên | AC3, 4, 13, 19 |

### Contract (lib `so-chot.mjs`)
```
Decision = { ma: string(4 [a-z0-9]), tom_tat, pham_vi: 'chung'|<thư mục spec>, trang_thai: 'dang-dung'|'cho-xem'|'da-huy'|'da-cat',
             luc: 'YYYY-MM-DD HH:MM' (giờ VN), ai_quyet, thay_cho?: ma, lien_quan?: ma[], sua_luc?, file }
  trạng thái ↩️ không lưu: suy ra khi có quyết định khác `thay_cho` trỏ tới (AC5)
parseDecision(text, file) -> Decision | { loi }      renderDecision(Decision, { vi_sao, ap_dung, da_can_nhac }) -> text
newMa() -> 8 ký tự [a-z0-9] (crypto)                  scan(root) -> { decisions, loi[], fingerprint }
  fingerprint = sha1 của danh sách đã sắp (đường dẫn, size, mtime) của MỌI nguồn: file quyết định, docs/specs/*/progress.md, IDEAS.md
  safePath(root, rel): realpath nằm trong root, lstat bỏ symlink/junction, đọc ≤ 64 KB/file; pham_vi hợp lệ = 'chung' | thư mục docs/specs có thật (AC8c)
  trùng mã (cực hiếm) ⇒ cảnh báo trong phần nạp + INDEX, không tự đổi
render(projectRoot) -> { index, roadmap, roadmapLuuTru }  hàm thuần, không ghi; write(projectRoot) ghi 3 file (chỉ mod + bước gộp gọi)
close(projectRoot, feature): quyết định phạm vi đó dang-dung/cho-xem → da-cat, rồi write(); idempotent (AC15, 22)
  mở lại tính năng ⇒ không đổi file; excerpt nạp cả da-cat khi feature trùng (AC16)
openProgress(projectRoot, branch) -> { feature, file } | null   quét mọi docs/specs/*/progress.md (stat trước), khớp dòng `Nhánh / worktree` với nhánh; không khớp ⇒ null (AC22b)
excerpt(projectRoot, { branch, budget }) -> string   khẩu phần AC10–12; cache kết quả theo fingerprint ở ~/.claude/cache/so-chot/<sha1(root)>.json (ngoài repo)
ghi(projectRoot, input) -> Decision                   tim(projectRoot, query, { lichSu }) -> Decision[]
ghiYTuong(projectRoot, { loai, noi_dung }) -> { ma: 'y-xxxxxx', line }   suKienYTuong(projectRoot, ma, { lam: thư mục spec | bo }) (AC19–20)    ensureGitattributes(projectRoot)  (merge=union cho INDEX.md, ROADMAP*.md, IDEAS.md)
CLI: node so-chot.mjs <gen|excerpt|ghi|tim|y-tuong|da-xem> <projectRoot> [json]   → stdout JSON, exit 0; lỗi ⇒ exit 1 + một dòng
```
Định dạng dòng INDEX: `- [k3f9] 2026-10-02 16:41 · ✅ · [chung] Dùng pnpm thay npm → chung/k3f9-dung-pnpm.md`.
Dòng đầu INDEX/ROADMAP: `<!-- tự sinh bởi so-chot.mjs, đừng sửa tay · stamp: … -->`.

### Khẩu phần nạp (session-start)
tiến độ ≤ 2.000 (tổng các sổ mở, sổ mới nhất trước) · luật `chung` ≤ 3.000 · tính năng đang làm ≤ 2.000 · ⚠️ 5 dòng + 1
dòng đếm · roadmap 1 dòng · lời dẫn ≤ 300 ⇒ tổng ≤ 8.500 (AC10). Tính năng đang làm = `openProgress(root, nhánh hiện tại)`; null ⇒ không nạp khẩu phần tính năng, thay bằng 1 dòng liệt kê các sổ đang mở. Hook CHỈ ĐỌC repo.

## Thư viện
Không thêm phụ thuộc: Node built-in (`fs`, `crypto.randomBytes`, `child_process`), test bằng `node:test` như các hook hiện có.

## ADR
`plans/flow-v6-so-chot/ADR-0001-nguon-su-that.md`: file nhỏ là nguồn sự thật, INDEX/ROADMAP là bản xem tự sinh có
trong git + `merge=union`; trạng thái đổi bằng front matter, không dời file; mã 4 ký tự ngẫu nhiên. (Khó đảo ngược vì
mọi dự án sẽ có dữ liệu theo định dạng này.)

## Làn

| lane | worker | files | ops | depends_on | accept |
|---|---|---|---|---|---|
| A | coder | hooks/lib/so-chot.mjs,hooks/lib/so-chot.test.mjs | new | - | node --test hooks/lib/so-chot.test.mjs |
| B | coder | hooks/session-start.mjs,hooks/session-start.test.mjs,hooks/flow-dispatch.mjs,hooks/flow-dispatch.test.mjs | extend | A | node --test hooks/session-start.test.mjs hooks/flow-dispatch.test.mjs |
| C | coder | hooks/lib/legacy-migrate.mjs,hooks/lib/legacy-migrate.test.mjs | new | A | node --test hooks/lib/legacy-migrate.test.mjs |
| D | coder-lite | skills/flow-spec/SKILL.md,skills/flow-merge/SKILL.md,CLAUDE.md,README.md,.gitignore,plans/flow-v6-so-chot/ADR-0001-nguon-su-that.md | extend | A | node --test hooks/*.test.mjs hooks/lib/*.test.mjs |

Sau khi gộp các làn (captain): cập nhật mod so-chot gọi CLI · QA · review một lần (`flow-review`) · hỏi gộp ·
rồi mới chạy `legacy-migrate plan` trên 1Scout Marketing, người dùng duyệt dòng không chắc, `apply`, `verify`.

## Kế hoạch test (mỗi AC một test, repo tạm trong os.tmpdir như session-start.test.mjs)
- A: AC1 định dạng + slug tiếng Việt; AC2 hai thư mục ghi song song rồi gộp bằng git thật (merge=union) không conflict, không trùng mã; AC5 suy ra ↩️ + phát hiện hai bản cùng thay; AC7 file hỏng; AC8 fingerprint đổi khi sửa progress/IDEAS hoặc sửa file không đổi mtime cực đại, cache trúng khi không đổi; AC8b INDEX bị union-merge vẫn nạp đúng từ nguồn + cảnh báo file mất; AC8c pham_vi `../x`, symlink/junction trỏ ra ngoài ⇒ bị bỏ, không ghi ngoài root; trùng mã giả lập ⇒ cảnh báo; AC19 ý tưởng trùng nội dung, sự kiện làm/bỏ nhiều lần, hai nhánh cùng triển khai ⇒ đếm theo mã; AC10–12 khẩu phần với 2.000 quyết định / 300 ⚠️ / 150 luật chung; AC15–17 cất kho, mở lại, tìm gồm 📦; AC18 ROADMAP 20 + lưu trữ; AC19 ý tưởng chỉ ghi thêm; giờ VN.
- B: tổng output ≤ 8.500 ở mọi tổ hợp; progress kiểu cũ (AC23); không có sổ (AC14); source=compact vẫn nạp.
- B: hook không tạo thay đổi nào trong `git status` của repo; hai tính năng mở đồng thời ở hai nhánh ⇒ mỗi phiên nạp đúng tính năng của nhánh mình; tính năng cũ ngoài 50 thư mục vẫn tìm được; flow-dispatch chọn cùng sổ (test đối chiếu).
- C: bảng ghép với tên na ná (`ai-agent` vs `ai-agent-gaps`); 2 commit tách; verify ánh xạ TỪNG quyết định nguồn → đích → phạm vi (bắt bỏ sót, nhân đôi, ghép nhầm phạm vi); nhật ký băm nguồn ⇒ chạy lại sau khi bị ngắt không trùng.
- D: flow-merge mô phỏng trên repo tạm có remote: sau toàn bộ luồng, remote có progress `xong` + quyết định da-cat + INDEX mới, working tree sạch; ngắt giữa chừng rồi chạy lại không trùng.
- D: test cũ vẫn xanh.

## QA charter (pha 6)
Vai: người dùng desktop. Trạng thái đầu: repo git tạm có 2 worktree. Kịch bản: ghi quyết định ở cả hai worktree → gộp
→ không conflict, INDEX đủ; mở phiên mới → đoạn nạp ≤ 8.500, đúng thứ tự khẩu phần; đánh xong tính năng → quyết định 📦,
mở lại → nạp lại; nói ý tưởng → IDEAS.md thêm dòng, không gián đoạn. Bằng chứng: output hook, `git log`, nội dung INDEX/ROADMAP.
1Scout Marketing: chạy `plan` trên bản sao trước, đối chiếu số dòng, rồi mới chạy thật.

## Rủi ro
- Hook chỉ đọc: INDEX trong git có thể cũ/lẫn sau merge tới lần ghi kế tiếp ⇒ phần nạp luôn tính từ nguồn, không từ INDEX.
- `merge=union` có thể để lại dòng trùng/lẫn ⇒ chấp nhận vì `gen` ghi đè lại ở lần nạp kế tiếp.
- Sửa `~/.claude` trực tiếp ảnh hưởng mọi phiên đang chạy ⇒ làm trong worktree, chỉ gộp sau QA + review.

## Review plan (Codex gpt-6.1-sol medium, 2026-10-02)
7 mục, nhận cả 7: fingerprint toàn nguồn + cache ngoài repo; mã 8 ký tự; chọn tính năng theo nhánh (gồm flow-dispatch); thứ tự đóng sổ trước push; hook chỉ đọc + khoá đường dẫn; mã ý tưởng; đối chiếu migration từng quyết định. Tự soát: mọi AC có task phủ; tính năng anh em (flow-dispatch) đã vào làn B; lane-check sạch; ADR-0001 cho định dạng dữ liệu.
