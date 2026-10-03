# SPEC · flow v6 — Sổ chốt, roadmap và ý tưởng theo kiểu memory

Ngày: 2026-10-02 · Cỡ: L · Repo: vibe-coding-flow (`~/.claude`) · Áp dụng thử: `D:/AI/1Scout Marketing`
Bản 2: đã sửa theo review của Codex gpt-6.1-sol + Gemini 3.8 Flash (research.md, review ngày 2026-10-02).

## Mục tiêu
Mỗi dự án có **sổ chốt** (quyết định đã duyệt), **roadmap** và **danh sách ý tưởng** nằm cùng code, đọc nhanh như
memory của Claude: mục lục một dòng mỗi mục, chi tiết đọc khi cần, có giờ để người dùng đọc lại và sửa. Phiên mới chỉ
nạp phần cần thiết trong một trần cố định, không phình theo thời gian, không bao giờ để người dùng gặp xung đột git.

## Người dùng
Người vibe-code không viết code, dùng Claude desktop là chính, chạy nhiều phiên/worktree song song, hay nảy ý tưởng
giữa chừng và hay hỏi "đã chốt gì / đang tới đâu".

## User story
- Tôi đọc lại sổ chốt theo thời gian để phát hiện điều chốt sai ý và sửa bằng một câu nói.
- Mở phiên mới (hoặc sau khi phiên tự dọn), Claude đã biết luật chung và quyết định của việc đang làm, không hỏi lại.
- Đang làm mà nảy ý tưởng, tôi chỉ cần nói, ý tưởng tự vào danh sách để sau này lấy ra làm.
- Xong một tính năng, các quyết định riêng của nó tự cất; làm lại tính năng đó thì chúng tự quay lại.

## Nguyên tắc
1. **Nguồn sự thật là file nhỏ** (mỗi quyết định một file; mỗi tính năng một thư mục). **Mục lục là bản xem tự sinh**
   (INDEX.md, ROADMAP.md), không sửa tay.
2. **Không dời file để đổi trạng thái** — chỉ đổi trường `trang_thai`. Không xoá: sai thì thay, bỏ thì huỷ.
3. **Hook nạp, mod ghi.** Hook SessionStart là nơi duy nhất nạp vào phiên (chạy cả khi không có mod); mod so-chot lo ghi,
   tìm, giao diện. Cả hai dùng chung một định dạng và một bộ sinh mục lục.
4. **Một trần chung** cho mọi thứ nạp sẵn, chia khẩu phần; cắt thì luôn nói đã cắt gì và tra bằng gì.
5. **Người dùng không bao giờ phải xử lý xung đột git** của mục lục / danh sách ý tưởng.

## Đã chốt với người dùng (2026-10-02)
- Sổ chốt lưu cùng code, đưa lên git; cấu trúc như memory; giờ VN; trạng thái ✅ đang dùng · ⚠️ chờ xem lại ·
  ↩️ đã thay · ✖ đã huỷ · 📦 đã cất; phạm vi `chung` hoặc thư mục spec của tính năng.
- Tính năng xong (= đã gộp) ⇒ tự cất các điều phạm vi tính năng (không hỏi); điều `chung` không bao giờ tự cất.
- ROADMAP tự cập nhật; ý tưởng tự ghi khi người dùng nói ra; việc cỡ S không lên ROADMAP.
- 1Scout Marketing: tự chuyển mọi quyết định cũ, đánh ⚠️; gom file plan cũ theo tính năng, chỉ hỏi dòng không chắc.
- Sổ chốt là nguồn duy nhất cho quyết định dự án; memory của Claude chỉ giữ sở thích cá nhân xuyên dự án.

## Cấu trúc
```
<dự án>/
  .claude/so-chot/
    chung/<mã>-<slug>.md                 quyết định dùng mọi việc
    <thư-mục-tính-năng>/<mã>-<slug>.md   quyết định của một tính năng
    INDEX.md                             tự sinh, một dòng mỗi quyết định còn hiệu lực + phần đã cất/đã thay ở cuối
  docs/specs/<YYYY-MM-DD>-<slug>/        SPEC.md · PLAN.md · progress.md · research.md · notes/
  docs/ROADMAP.md                        tự sinh: Đang làm · Cần xem lại · Đã xong (20 gần nhất) · Ý tưởng (đếm + 20 mới nhất)
  docs/ROADMAP-luu-tru.md                tự sinh: phần Đã xong cũ hơn
  docs/IDEAS.md                          chỉ ghi thêm dòng: "- <ngày> · <loại> · <ý tưởng> [· → <thư mục spec>]"
  docs/legacy/                           tài liệu cũ không thuộc tính năng nào
  .gitattributes                         INDEX.md, ROADMAP*.md, IDEAS.md: merge=union
```
Mã quyết định: 8 ký tự ngẫu nhiên `[a-z0-9]` (xác suất trùng không đáng kể kể cả giữa các nhánh), màn hình hiện 4 ký
tự đầu (vd `k3f9`); gõ tiền tố trùng nhiều mã thì hỏi lại. Mã ý tưởng: `y-` + 6 ký tự.
Bản sửa theo review plan (Codex): hook SessionStart CHỈ ĐỌC repo (không ghi file nào vào repo); cache đặt ngoài repo
(`~/.claude/cache/so-chot/`); INDEX/ROADMAP chỉ được ghi lại khi mod ghi quyết định hoặc ở bước gộp (rồi commit).
Tính năng đang làm của phiên = tính năng có progress.md ghi đúng nhánh git hiện tại; không xác định được thì không đoán.

## Acceptance criteria
Ghi và sửa quyết định
1. KHI ghi một quyết định THÌ HỆ THỐNG PHẢI tạo đúng một file trong thư mục phạm vi của nó, front matter
   `ma, tom_tat, pham_vi, trang_thai, luc, ai_quyet, thay_cho?, lien_quan?, sua_luc?`, thân Vì sao · Áp dụng thế nào · Đã cân nhắc.
2. KHI hai nhánh/worktree cùng ghi quyết định rồi gộp THÌ HỆ THỐNG PHẢI giữ đủ cả hai, không trùng mã, không báo xung đột.
3. KHI hiển thị danh sách THÌ số #N chỉ có nghĩa trong danh sách vừa hiện; mỗi dòng luôn kèm mã cố định.
4. KHI người dùng nói "điều #N sai / đổi thành…" THÌ HỆ THỐNG PHẢI nhắc lại điều đã hiểu (mã + tóm tắt) rồi mới ghi.
5. KHI một quyết định thay quyết định cũ THÌ CHỈ quyết định mới ghi `thay_cho`; trạng thái ↩️ của bản cũ được suy ra khi
   sinh mục lục; KHI hai quyết định cùng thay một bản THÌ HỆ THỐNG PHẢI báo người dùng phân xử, không tự chọn.
6. KHI quyết định do "tự chọn khi vắng" hoặc chuyển từ sổ cũ THÌ HỆ THỐNG PHẢI đánh ⚠️ chờ xem lại.
7. KHI file quyết định hỏng front matter hoặc bị xoá THÌ HỆ THỐNG PHẢI ghi một dòng cảnh báo trong INDEX, không chặn phiên.
Mục lục tự sinh
8. KHI mod ghi quyết định hoặc bước gộp chạy THÌ INDEX.md / ROADMAP PHẢI được sinh lại từ nguồn; KHI mở phiên THÌ hook
   chỉ đọc (dùng cache ngoài repo theo dấu vân tay của toàn bộ nguồn: file quyết định, progress.md, IDEAS.md), không ghi repo.
8b. KHI một file nguồn bị xoá hoặc INDEX trong git lệch với nguồn (vd sau merge=union) THÌ phần nạp vẫn tính từ nguồn
    và ghi một dòng cảnh báo; INDEX được sửa ở lần ghi kế tiếp.
8c. KHI đọc/ghi THÌ mọi đường dẫn PHẢI nằm trong thư mục dự án (realpath), bỏ qua symlink/junction; `pham_vi` chỉ nhận
    `chung` hoặc tên thư mục `YYYY-MM-DD-<slug>` có thật trong docs/specs.
9. KHI gộp nhánh THÌ INDEX.md / ROADMAP*.md / IDEAS.md KHÔNG BAO GIỜ gây xung đột (merge=union); lần nạp kế tiếp sinh lại bản sạch.
Nạp vào phiên (hook SessionStart: startup / resume / clear / compact)
10. KHI mở phiên THÌ tổng phần nạp sẵn PHẢI ≤ 8.500 ký tự, chia khẩu phần: tiến độ ≤ 2.000 · luật `chung` ≤ 3.000 ·
    tính năng đang làm ≤ 2.000 · ⚠️ ≤ 5 dòng + 1 dòng đếm · roadmap 1 dòng · lời dẫn ≤ 300.
11. KHI luật `chung` vượt khẩu phần THÌ HỆ THỐNG PHẢI nạp phần vừa đủ và ghi "(còn N luật chung: cần gộp bớt; tra bằng …)";
    không âm thầm bỏ.
12. KHI phần nạp bị cắt THÌ lời dẫn PHẢI nói đúng công cụ tra (`mcp__so-chot__tim_chot` nếu có mod, nếu không thì
    `rg -i "<từ khoá>" .claude/so-chot`) và PHẢI dặn: trước khi làm việc chạm phạm vi X thì tra quyết định của X.
13. KHI chạy không có mod (claude -p) THÌ hook vẫn nạp như trên; KHI có mod THÌ mod KHÔNG nạp thêm (không trùng).
14. KHI dự án không có sổ chốt / roadmap THÌ không báo lỗi, không nạp gì cho phần đó.
Cất kho và làm lại
15. KHI progress.md của một tính năng chuyển "Trạng thái: xong" (do bước gộp ghi, kèm ngày xong) THÌ các quyết định phạm
    vi tính năng đó PHẢI chuyển `trang_thai: da-cat` (không dời file); điều `chung` và điều tính năng khác không đổi.
16. KHI phiên đang làm đúng tính năng đã cất (progress.md của nó mở lại) THÌ các quyết định 📦 của nó PHẢI được nạp như
    quyết định của tính năng đang làm.
17. KHI tìm kiếm THÌ kết quả PHẢI gồm cả 📦 đã cất (đánh dấu rõ); ↩️/✖ chỉ khi yêu cầu xem lịch sử.
Roadmap và ý tưởng
18. KHI sinh ROADMAP THÌ Đang làm / Đã xong đọc từ `docs/specs/*/progress.md` (trạng thái, ngày xong) và tên thư mục
    (ngày bắt đầu); Đã xong giữ 20 mục mới nhất, phần cũ sang ROADMAP-luu-tru.md; ý tưởng hiện số đếm + 20 mới nhất.
19. KHI người dùng nói ra ý tưởng (tính năng hoặc cải tiến) trong lúc làm THÌ HỆ THỐNG PHẢI ghi thêm một dòng vào IDEAS.md
    (mã y-xxxxxx · ngày · loại · ý tưởng), không gián đoạn việc đang làm, không tra trùng lúc đó; dòng triển khai/bỏ sau
    này trỏ về đúng mã; số ý tưởng = số mã ý tưởng khác nhau (không đếm dòng sự kiện).
20. KHI bắt đầu flow-spec THÌ HỆ THỐNG PHẢI rà ý tưởng trùng (chỉ gộp khi khớp chắc chắn, mơ hồ thì hỏi) và khi làm một
    ý tưởng thì ghi thêm dòng trỏ "→ <thư mục spec>".
21. KHI mở phiên THÌ roadmap chỉ nạp 1 dòng: số đang làm · số ý tưởng · tính năng đang làm.
Mẫu quy trình
22. KHI tạo progress.md mới THÌ mục "Đã chốt:" PHẢI là một dòng trỏ sang sổ chốt; KHI gộp THÌ thứ tự PHẢI là: gộp →
    ghi "Trạng thái: xong" + "Xong ngày" → cất kho + sinh INDEX/ROADMAP → commit → push → dọn worktree; bị ngắt thì
    chạy lại bước đóng sổ không tạo thay đổi trùng.
22b. KHI phiên ở một nhánh THÌ tính năng đang làm là tính năng có progress.md ghi nhánh đó (mọi thư mục docs/specs,
     không giới hạn 50); hook nhắc cập nhật sổ (flow-dispatch) dùng cùng cách chọn.
23. KHI gặp progress.md kiểu cũ có "Đã chốt:" nhiều dòng THÌ hook vẫn nạp được (tương thích ngược).
24. KHI tạo tính năng cỡ M/L THÌ mọi tài liệu của nó PHẢI nằm trong `docs/specs/<YYYY-MM-DD>-<slug>/`.
Chuyển dự án cũ (1Scout Marketing)
25. KHI chạy chuyển đổi THÌ HỆ THỐNG PHẢI tự ghép file → tính năng kèm độ chắc chắn, CHỈ hỏi người dùng các dòng không
    chắc; file không thuộc tính năng nào ⇒ `docs/legacy/`.
26. KHI chuyển THÌ PHẢI tách 2 commit: (a) `git mv` nguyên trạng, (b) chuyển nội dung (`*.decisions.md` ⇒ quyết định ⚠️
    đúng phạm vi, `*.progress.md` ⇒ progress.md); đối chiếu TỪNG quyết định nguồn → quyết định đích → phạm vi (không
    chỉ đếm dòng); nhật ký chuyển đổi ghi băm nguồn để chạy lại (kể cả sau khi bị ngắt) không tạo bản trùng.
27. KHI chuyển xong THÌ ROADMAP sinh từ các thư mục tính năng; tính năng không rõ trạng thái ⇒ mục "Cần xem lại".

## Edge case (đã dò 2 vòng + 2 review)
- Tiêu đề tiếng Việt có dấu / rất dài ⇒ slug ASCII ≤ 6 từ, tom_tat giữ nguyên (AC1).
- Mã ngẫu nhiên trùng (rất hiếm) ⇒ sinh lại khi tạo (AC2).
- Giờ hệ thống khác múi ⇒ luôn ghi giờ VN UTC+7 (AC1).
- 2.000 quyết định ⇒ không quét lại nếu không đổi (AC8); nạp vẫn ≤ trần (AC10).
- Hàng trăm ⚠️ sau chuyển đổi ⇒ chỉ 5 dòng + 1 dòng đếm (AC10).
- Nội dung sổ là dữ liệu repo, không phải lệnh người dùng ⇒ lời dẫn ghi rõ như progress.md hiện nay (AC12).
- Repo chưa có `docs/` ⇒ tạo khi cần.
- Ghép nhầm tính năng khi chuyển ⇒ chỉ dòng chắc chắn mới tự ghép (AC25), có đối chiếu (AC26).

## Ngoài phạm vi
- Codex/Grok/agy tự đọc sổ chốt (không chạy hook Claude Code).
- Giao diện web xem sổ; tự gộp các quyết định trùng ý (đề xuất để người dùng duyệt — để sau).
- Đồng bộ sổ giữa nhiều dự án. Cấu hình Codex nhẹ cho review (ghi vào ý tưởng).
