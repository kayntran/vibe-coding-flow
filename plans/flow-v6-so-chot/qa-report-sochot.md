# QA thực tế — flow v6 sổ chốt (nhánh feat/flow-v6-so-chot, commit adb8257)

Cách làm: repo git tạm trong %TEMP%\sochotqa-*, HOME/USERPROFILE trỏ thư mục tạm (cache hook ghi vào đó; ~/.claude thật không có file mới).
Không sửa mã nguồn. Không chạy server. Đã xoá repo tạm cuối phiên.
Công cụ: `node hooks/lib/so-chot.mjs <cmd>` và `node hooks/session-start.mjs` (stdin {"cwd","source"}).

## Bảng kết quả

| # | Kịch bản | Kết quả | Bằng chứng rút gọn |
|---|---|---|---|
| 1 | 2 worktree cùng ghi (cùng phút, cùng tiêu đề VN) rồi merge | ĐẠT | 2 file `chung/m9a8w1wu-…` và `chung/40xz7glo-…`, cùng `luc: 2026-10-02 19:45`, mã khác nhau; `git merge` exit 0, `git ls-files -u` rỗng. Làm 2 vòng (kể cả repo chưa có .gitattributes/INDEX, cả hai nhánh cùng tạo mới): vẫn không xung đột. Hook sau merge: "Luật chung (5)" đủ cả hai, không trùng; INDEX lẫn (2 dòng stamp, header đếm cũ) vẫn nạp đúng + dòng cảnh báo "INDEX lệch nguồn". `ghi` kế tiếp ⇒ INDEX sạch 1 stamp. |
| 2 | Phiên mới: nhánh tính năng / main / detached / compact | ĐẠT | Repo nặng (80 luật chung, 50 quyết định tính năng, 30 ⚠️, 30 ý tưởng, progress 28 KB, nhắc MCP): LEN 7.587 (≤ 8.500). Thứ tự: tiến độ 1.998 → lời dẫn 179 → Luật chung 2.799 (còn 64) → Tính năng 1.831 (còn 40) → ⚠️ 561 (5 dòng + đếm 30) → Roadmap 72 → MCP 133. Cắt đều có "(còn N …; tra bằng rg -i …)"; có mod ⇒ tên công cụ `mcp__so-chot__tim_chot`. feat/f01 ⇒ tính năng feat01; feat/f02 ⇒ feat02 (⚠️ của nó nằm trong khẩu phần tính năng, không lặp); main và detached ⇒ không đoán, "tính năng đang làm: không có". source=compact giống startup. `git status` trước/sau hook y hệt. Thêm 6 file hỏng ⇒ LEN 7.922, cảnh báo ≤ 3 dòng + "(+N)". Ngoài git / không có sổ chốt ⇒ output rỗng, không lỗi. |
| 3 | `xong <feature>` rồi mở lại | ĐẠT (1 lỗi nhỏ, xem BUG-1) | progress.md: `Trạng thái: xong` + `Xong ngày: 2026-10-02` (ngày VN); 2 quyết định của feature (✅ và ⚠️) ⇒ `da-cat`; điều `chung` và feature khác nguyên trạng; INDEX phần "Đã cất" có 📦. Hook trên nhánh feat/alpha khi đã xong: không nạp tính năng. Đổi lại "đang làm": nạp "Tính năng đang làm … 📦 …" cả 2 điều. Chạy `xong` lần 2: `{"progress":false,"cat":[],"ghi":[]}`, `git status` sạch. |
| 4 | y-tuong / làm / bỏ / ROADMAP | ĐẠT | IDEAS.md 4 → 5 dòng đúng 1 dòng `- y-e8rfqz · 2026-10-02 · tính năng · …` (tiêu đề có " · ", xuống dòng ⇒ gộp 1 dòng). `lam` ⇒ `- y-e8rfqz · … · → 2026-09-03-gamma`; gọi lại lần 2 ⇒ `ghi:false` không thêm dòng; `bo` ⇒ `- y-tl41tx · … · bỏ`. ROADMAP: "Ý tưởng (6 · 4 chưa làm)" = 6 mã khác nhau, 2 dòng sự kiện không đếm; dòng ý tưởng có "→ spec" / "đã bỏ". Mã sai / spec `../x` / loại sai / rỗng ⇒ exit 1 + 1 dòng lỗi. |
| 5a | pham_vi xấu | ĐẠT | `../x`, `..\x`, `/etc`, `C:\Windows`, `chung/../x`, `spec/..`, `.git`, spec không tồn tại, `CHUNG`, `NUL`, mảng ⇒ đều exit 1 "phạm vi … không hợp lệ", không file nào được tạo. |
| 5b | Tiêu đề dài / ký tự lạ | ĐẠT (1 MINOR) | 16 KB ⇒ tom_tat cắt 200 ký tự; emoji, RTL, `\0`, ESC, "---\nma: hack" (gộp 1 dòng, không phá front matter), nháy kép/backslash, `../../etc/passwd`, `CON: aux<>|?*"`, chỉ ký tự lạ ⇒ slug `quyet-dinh`. Đọc lại bằng `tim` đúng nguyên văn. Xem BUG-3. |
| 5c | File quyết định hỏng | ĐẠT | Cắt dở front matter, file rỗng, nhị phân, trang_thai lạ, pham_vi lệch thư mục, trùng mã (copy file), thay_cho trỏ mã không có, hai bản cùng thay một điều, file bị xoá sau khi có INDEX, file 10 MB, CRLF+BOM: `gen` exit 0, từng dòng cảnh báo trong INDEX, hook không chặn phiên (LEN 1.676). Hai bản cùng thay ⇒ cảnh báo "hỏi user chọn", không tự chọn. `da-xem` giữ CRLF. `huy`/`da-xem` mã không có/trùng/ngắn ⇒ exit 1 một dòng. |
| 5d | Junction/symlink (8c) | ĐẠT | `.claude/so-chot` và `docs/specs/<x>` là junction ra ngoài: `ghi` exit 1; `gen` bỏ qua INDEX + cảnh báo; thư mục ngoài không có file nào bị tạo; quyết định trong junction con không được nạp (grep "NGOÀI REPO" = 0). |

Tổng: 5/5 kịch bản đạt, 3 bug (0 BLOCKER, 0 MAJOR, 3 MINOR).

## Bug

### BUG-1 (MINOR) — Mở lại tính năng rồi đóng lần nữa giữ "Xong ngày" cũ
Tái hiện: tính năng đã `xong` (có `Xong ngày: 2026-09-15`) → người dùng đổi `Trạng thái: đang làm` (mở lại) → `so-chot.mjs xong <root> <spec>`.
Mong đợi: `Xong ngày` = ngày đóng lần này. Thực tế: `Trạng thái: xong`, `Xong ngày: 2026-09-15` (cũ), vì `xong()` chỉ thêm dòng khi chưa có (so-chot.mjs ~dòng 761). ROADMAP "Đã xong" hiện sai ngày/sai thứ tự.
Đề xuất spec đỏ (node:test):
```js
test('xong sau khi mở lại cập nhật Xong ngày', () => {
  // progress: "Trạng thái: đang làm\nXong ngày: 2026-09-15\n" ; xong(root, f, { now: Date.parse('2026-10-02T03:00:00Z') })
  assert.match(read(root, 'docs/specs/F/progress.md'), /Xong ngày: 2026-10-02/)
})
```

### BUG-2 (MINOR) — Header đếm trong INDEX/ROADMAP sau merge=union sai mà không có cảnh báo
Tái hiện: 2 nhánh cùng ghi + gen, merge. INDEX có "Còn hiệu lực (6)" nhưng 7 dòng; ROADMAP "Ý tưởng (3 · 3 chưa làm)" nhưng liệt kê 4. Cảnh báo "INDEX lệch" chỉ có khi danh sách dòng khác, nên đôi khi im. Tự lành ở lần ghi kế tiếp; hook tính từ nguồn nên phần nạp vẫn đúng ⇒ chỉ ảnh hưởng người đọc file thô. Đề xuất: so cả header đếm trong kiểm lệch, hoặc chấp nhận.

### BUG-3 (MINOR) — Ký tự điều khiển hướng chữ (U+202E…) và thân quyết định không giới hạn
`oneLine` chỉ bỏ ký tự C0; U+202E (đảo chiều chữ) đi thẳng vào dòng "Luật chung" nạp vào phiên (`[izsa] 😀🇻🇳 אבג ‮ đảo …`). `vi_sao` 200 KB ghi nguyên (file 200 KB, hook chỉ đọc 64 KB nên vô hại). Đề xuất bỏ U+200E/F, U+202A–E, U+2066–9 trong `oneLine` và cắt `vi_sao`/`ap_dung` ở ~8 KB.
```js
test('oneLine bỏ ký tự đổi chiều chữ', () => assert.equal(oneLine('a\u202eb'), 'ab'))
```

## Ghi chú không phải bug
- ⚠️ trong phạm vi một tính năng bị `xong` cất 📦 luôn (đúng AC15) ⇒ điều chờ xem lại biến mất khỏi danh sách ⚠️ mà người dùng chưa xem. Nên để captain cân nhắc.
- `ghi` với JSON `null` báo "Cannot read properties of null" (vẫn exit 1, một dòng) — chữ lỗi không thân thiện.
- Nhắc MCP 30 ngày luôn in kể cả khi dự án không có sổ chốt (đúng thiết kế, tách khỏi AC14).
- Hook ở main/detached nạp 1 hoặc 2 sổ tiến độ sửa gần nhất (đúng thiết kế); sổ lớn bị cắt với "…(đã cắt, đọc đủ ở file trên)".

## Không test được
- Chuyển 1Scout Marketing (`legacy-migrate plan/apply`): ngoài phạm vi brief này.
- Claude desktop thật nhận additionalContext, `claude -p` thật: chỉ gọi hook trực tiếp qua stdin.
- Symlink (không phải junction) trên Windows: không có quyền tạo; chỉ thử junction.
- ROADMAP > 20 mục đã xong sang ROADMAP-luu-tru.md (AC18): ngoài 5 kịch bản.
