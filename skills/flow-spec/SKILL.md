---
name: flow-spec
description: Từ ý tưởng tới plan đã duyệt — phỏng vấn, research repo/thư viện có sẵn song song, viết SPEC, dò edge case, plan kỹ thuật + ADR + chia làn song song, review plan bằng model khác, mở sổ tiến độ. Dùng khi user nói kiểu "tôi có ý tưởng…", "làm tính năng…", "thêm chức năng…", "muốn app làm được…", "xây module…", hoặc việc đụng schema/nhiều module (cỡ M/L), trước khi sửa code. KHÔNG dùng cho sửa nhỏ tả được bằng một câu (cỡ S), sửa bug (dùng debugger), hay câu hỏi thuần.
---

# Flow — từ ý tưởng tới plan đã duyệt

Cỡ S (tả diff bằng một câu, 1–2 file) ⇒ KHÔNG dùng skill này; vào worktree làm luôn.

## Thư mục tính năng (cỡ M/L)

Mọi tài liệu của một tính năng nằm trong `docs/specs/<YYYY-MM-DD>-<slug>/`: `SPEC.md` · `PLAN.md` · `progress.md` ·
`research.md` · `notes/` (ghi chú phụ). Không rải ở chỗ khác. ADR khó đảo ngược đặt cạnh (xem Pha 2).

## Pha 1 — Phỏng vấn + research (song song)

0. **Rà ý tưởng trùng:** đọc `docs/IDEAS.md` (nếu có), tìm ý tưởng trùng với việc sắp làm. Chỉ coi là một khi khớp
   chắc chắn; mơ hồ ⇒ hỏi user. Làm ý tưởng nào ⇒ ghi thêm dòng trỏ về đúng mã đó:
   `node ~/.claude/hooks/lib/so-chot.mjs y-tuong <projectRoot> '{"ma":"y-xxxxxx","lam":"<YYYY-MM-DD>-<slug>"}'`.
1. Gửi trong MỘT message:
   - AskUserQuestion: ≤5 câu/vòng, mỗi câu có đáp án khuyến nghị đứng đầu. Hỏi mục tiêu, người dùng, phạm vi,
     ràng buộc, thế nào là "xong".
   - Cỡ M/L: tra kho trước `node ~/.claude/hooks/kho.mjs tim <repo> "<từ khoá>"` — thẻ còn hạn ⇒ dùng lại ("dùng kết
     quả ngày …"), hết hạn ⇒ chỉ tra phần cũ. Chỉ gọi Agent `researcher` KHI CẦN [w99v]: bí ý tưởng/cách làm · không chắc
     đã có ai làm · user đưa repo/link · sắp tự viết khả năng chung lớn. Brief: ý tưởng, stack, ràng buộc licence, đường
     ghi `docs/specs/<YYYY-MM-DD>-<slug>/research.md`; researcher ghi thẻ vào `docs/research/` (hook tự đính thẻ khớp).
   - User đưa repo/link ⇒ đọc kỹ MỘT lần, ghi thẻ repo (`kho.mjs moi repo …`: làm gì, cấu trúc, lấy được phần nào,
     licence, commit đã đọc, chế độ `lay-dung` hoặc `chi-hoc` cho GPL/AGPL/cấm thương mại — chỉ lưu logic bằng lời).
     Lần sau đọc thẻ, chỉ đọc lại repo khi thẻ thiếu hoặc repo đổi nhiều.
   - Không viết lại bánh xe: có sẵn trong dự án → thư viện chuẩn → thư viện/repo licence thoáng → tự viết (ghi lý do).
2. Nhận research ⇒ kể user những gì đáng giá (repo dùng lại được, ý tưởng hay hơn) trước khi chốt spec.
3. Viết `docs/specs/<YYYY-MM-DD>-<slug>/SPEC.md`:
   - Mục tiêu (1–3 câu), người dùng, user story.
   - Acceptance criteria dạng `KHI <tình huống> THÌ HỆ THỐNG PHẢI <hành vi>` — mỗi dòng phải dịch thẳng thành test.
   - Ngoài phạm vi. Yêu cầu phi chức năng (hiệu năng, bảo mật, offline, i18n…) chỉ khi có thật.
   - Chỗ chưa rõ đánh `[CẦN LÀM RÕ]` — còn dấu này thì chưa sang pha 2.
4. **Bản đồ ảnh hưởng:** việc chạm thứ dùng chung (provider, model, gói, cài đặt, tool AI agent…) ⇒ chạy skill
   `flow-impact` — kết quả (làm luôn / để sau / không áp dụng) ghi vào SPEC, test đối chiếu thành task trong PLAN.
5. **Dò edge case (cỡ L):** quét theo từng chiều — dữ liệu biên/rỗng/khổng lồ, Unicode tiếng Việt, đồng thời/bấm
   hai lần, mất mạng/timeout, quyền & người dùng khác, trạng thái dở dang/refresh, thời gian & múi giờ, quy mô dữ liệu,
   bảo mật/input độc, khôi phục sau lỗi, tương thích bản cũ/dữ liệu cũ, truy cập bằng bàn phím/màn hẹp. Lặp tới khi hai
   vòng liên tiếp không thêm gì. Mỗi edge case giữ lại ⇒ một acceptance criteria hoặc một dòng "ngoài phạm vi".
   Có thể giao `researcher` gom thêm edge case người khác từng gặp với bài tương tự.
6. **Cổng 1:** user duyệt SPEC — cổng duy nhất về PHẠM VI (plan kỹ thuật không đưa user duyệt); màn mới / làm lại giao
   diện còn cổng giao diện ở bước 7 trước pha 2. Viết/sửa SPEC xong ⇒ tóm tắt ngắn
   trong chat + chép bản xem vào thư mục mở phiên và mở sẵn (khung xem file không mở được file trong worktree).
7. **Cổng giao diện** (tính năng có màn mới / làm lại giao diện), sau khi SPEC được duyệt, trước pha 2:
   - Trong worktree, dựng ~5 bản demo theo các hướng bố cục/phong cách KHÁC NHAU, ngay trong app của dự án (webapp hoặc
     desktop app chạy local, dùng chính stack + thành phần của dự án, dữ liệu mẫu tiếng Việt). Không dùng widget/artifact
     hay file HTML rời. Dự án chưa có app ⇒ dựng khung app trước (task đầu của plan) rồi mới demo.
   - Thêm thanh chuyển nhỏ nổi trên màn (Bản 1…5, phím ←/→) để bấm qua lại; chỉ bật khi chạy dev (vd `import.meta.env.DEV`,
     cờ build dev) — không bao giờ có trong bản phát hành.
   - Chạy app (`node ~/.claude/hooks/wt-env.mjs alloc <worktree>` lấy port), mở cho user xem, hỏi bằng AskUserQuestion:
     chọn bản nào, cần sửa gì. Sửa theo lời tới khi gật; ghi bản đã chọn vào sổ chốt.
   - Chọn xong ⇒ gỡ các bản còn lại + thanh chuyển; plan làm thật theo bản đã chọn. Sửa giao diện nhỏ (đổi chữ, màu, một
     nút) ⇒ một bản, vẫn mở cho user xem và hỏi.

## Pha 2 — Plan kỹ thuật

**Trước khi viết PLAN — kiểm skill/MCP của thư viện chính** (stack đã biết: dự án có sẵn đọc file cấu hình; dự án mới
ngay sau khi chọn stack): `node ~/.claude/hooks/skills-check.mjs --host claude|codex --dir <repo> --lib <a,b>`.
`installed` + `ok` ⇒ đọc skill/MCP đó khi viết plan · `missing` ⇒ hỏi user MỘT câu đời thường rồi chạy lệnh cài nó in
(chỉ bản chính hãng trong `kit/official.json`; bản cộng đồng: đọc, soát, viết lại thành skill dự án — không cài) ·
`needs-login` ⇒ đưa đúng lệnh đăng nhập · `misconfigured` ⇒ báo một dòng · `unknown` ⇒ thử một lệnh đọc rẻ trước khi
dựa vào. Cài xong cần mở lại phiên ⇒ ghi sổ tiến độ trước. Thư viện thật của dự án (vd `shadcn init`) là task đầu của PLAN.

**Kiến trúc dự án** chưa có `docs/arch.json` (dự án mới hoặc có sẵn) hoặc tính năng thêm module ⇒ skill `flow-architecture`
trước; plan theo đúng `docs/ARCHITECTURE.md`.

Viết `PLAN.md` cạnh SPEC.md, mọi path phải kiểm có thật trong code:
- **Kiến trúc — BẮT BUỘC 9 dòng**, mỗi dòng một câu trả lời (thiếu dòng nào = plan chưa đạt): (1) ranh giới module, ai
  được gọi ai · (2) hợp đồng giữa module (kiểu/schema, ai sở hữu) · (3) dữ liệu: bảng thuộc module nào, ai được ghi,
  xoá/đổi có sao lưu không · (4) lỗi và biên: parse tại biên, lỗi nào người dùng thấy · (5) tăng trưởng: thứ gì vỡ đầu
  tiên ở 10x người dùng + đường nâng cấp · (6) quan sát: độ trễ, lưu lượng, lỗi, bão hoà + ai được báo khi hỏng ·
  (7) quyền/riêng tư · (8) chi phí trần · (9) đường quay lại (rollback). Không "MVP tạm" cho dữ liệu, hợp đồng, ranh giới.
- **Mã nối**: mỗi task ghi AC nó phủ (`AC-xx → task → kết quả`); báo cáo QA/review đánh dấu theo mã đó.
- **Chọn thư viện** dựa research.md, ghi lý do.
- **ADR** cho quyết định khó đảo ngược (DB, giao thức, cấu trúc module, phụ thuộc lớn):
  `docs/adr/NNNN-<tên>.md` = Bối cảnh · Quyết định · Hệ quả · Trạng thái. ADR Accepted không sửa; đổi ý = ADR mới.
- **Dễ mở rộng/bảo trì** — tự kiểm: tách theo trách nhiệm không theo layer; không abstraction cho thứ dùng một
  lần; không phụ thuộc vòng; điểm mở rộng có thật trong roadmap chứ không đoán.
- **Làn song song — bảng máy đọc được** (mục `## Làn` trong PLAN.md, đúng tên cột):

  ```
  | lane | worker | files | ops | depends_on | accept |
  |---|---|---|---|---|---|
  | A | coder | shared/types.ts | new | - | pnpm test types |
  | B | coder | web/src/api/** | extend | A | pnpm -C web test api |
  | C | coder-lite | web/src/i18n/** | extend | A | pnpm -C web test i18n |
  ```
  - `files`: glob ngăn bởi phẩy. `ops`: replace/extend/rename/delete/new. `depends_on`: làn phải xong trước (`-` = không).
  - Contract/type dùng chung là một làn riêng không phụ thuộc ai (wave 1); các làn dùng nó `depends_on` làn đó.
  - File nóng (lockfile, migration, config gốc, i18n chung, registry) thuộc đúng một làn hoặc captain gom cuối.
  - Mỗi task có test của nó; mỗi làn có `accept`.
  - Plan chỉ có **MỘT** bước "review code" (skill `flow-review`), ở cuối, sau khi các làn đã gộp vào nhánh
    tích hợp — không review sau từng giai đoạn/làn.
  - **Kiểm bằng máy, bắt buộc trước khi soát plan:** `node ~/.claude/hooks/lane-check.mjs plan <PLAN.md>` — báo làn trùng file
    (`OVERLAP`), file nóng hai chủ (`HOT`), phụ thuộc sai/vòng, rồi in các **wave**. Exit 1 ⇒ sửa bảng tới khi sạch.
    Hai làn cùng đụng một symbol (vd A `replace` còn B `extend` cùng `PaymentService`) git không thấy được ⇒ captain
    soát cột `ops`, gộp hai làn làm một hoặc cho chạy nối tiếp.
  - Chạy song song có đáng không ⇒ theo mục "Khi nào KHÔNG song song" trong skill `flow-team`.
- **Kế hoạch test**: unit/integration/e2e cần thêm + **QA charter** (từ acceptance criteria: vai, trạng thái đầu,
  dữ liệu, bằng chứng cần có) cho pha 6.
- **Plan sống** — cuối PLAN.md luôn có 4 mục, cập nhật trong lúc làm: `## Phát hiện bất ngờ` (kèm bằng chứng: lệnh +
  kết quả) · `## Nhật ký quyết định` · `## Thay đổi plan` (mỗi dòng: ngày giờ | task | đổi gì | vì sao | người dùng thấy
  khác không | ai quyết) · `## Kết quả` (khi xong). Tự sửa plan + ghi nhật ký, KHÔNG hỏi: đổi thứ tự/chia nhỏ task, tên
  file/hàm, chọn thư viện trong danh sách cho phép, thêm bước kiểm, chỉnh tiêu chí kỹ thuật mà điều người dùng thấy
  không đổi. Dừng hỏi user (câu đời thường): đổi điều người dùng thấy, thêm/bỏ tính năng, xoá/đổi dữ liệu, thêm thứ
  tốn tiền, quyền/bảo mật, đổi kiến trúc lớn hoặc mục tiêu đã chốt, hai lần sửa liền một task không qua kiểm.
  Làm ra sai ý ⇒ quay về plan, sửa cụ thể hơn rồi làm lại phần đó, KHÔNG vá chồng.

## Pha 3 — Soát plan bằng model khác (user KHÔNG duyệt plan kỹ thuật)

User chỉ duyệt thứ họ đánh giá được (SPEC đời thường, bản vẽ); plan kỹ thuật do model khác soát.

**Cỡ S/M:** captain tự soát 4 câu, ghi một dòng kết quả cuối PLAN.md: (1) mọi acceptance criteria của SPEC có task
phủ? (2) tính năng anh em (`flow-impact`) đã vào plan hoặc ghi "để sau"? (3) `lane-check plan` sạch? (4) có quyết định
khó đảo ngược nào thiếu ADR?

**Cỡ L: MỘT lượt soát, mức high, chỉ tìm lỗi thiết kế khó sửa về sau.** Chuỗi model (kiểm `node
~/.claude/hooks/cli-check.mjs <tên>` trước, chưa sẵn sàng thì sang bậc sau):
- Đang ở Claude: **Codex** (`pick codex plan-reviewer`) → **Opus qua agy** (`pick agy plan-reviewer`) → Agent
  `code-reviewer` với `model: "opus"`.
- Đang ở Codex: **Sol high** (`pick codex plan-reviewer`).

```bash
codex exec --sandbox read-only -m "$(node ~/.claude/hooks/models.mjs pick codex plan-reviewer)" \
  -c model_reasoning_effort="high" -C "<gốc repo>" -o "<scratchpad>/plan-review.md" "<ĐỀ>" < /dev/null
# agy: cd vào thư mục trống, agy -p "<ĐỀ, kèm đường dẫn tuyệt đối SPEC/PLAN>" --model "$(node ~/.claude/hooks/models.mjs pick agy plan-reviewer)" --mode plan
```
`<ĐỀ>`: "Review plan: <SPEC.md> và <PLAN.md>. Kiểm chéo SPEC↔PLAN. Chỉ báo lỗi thiết kế KHÓ SỬA SAU khi đã code: sai
kiến trúc/contract, yêu cầu bị sót, tính năng anh em dùng chung registry/danh sách mà plan quên hoặc thiếu test đối
chiếu, làn giao file, rủi ro bảo mật/dữ liệu. KHÔNG báo câu chữ, đặt tên, chi tiết code. CẤM đề xuất thêm tính năng.
Tối đa 7 mục: mức, vấn đề, bằng chứng path:line, hướng sửa." (Bash `run_in_background`, ghi file, luôn `< /dev/null`.)

Hợp nhất: kiểm từng mục vào SPEC/PLAN/code; sửa plan; ghi kết quả (đúng/bác + lý do) cuối PLAN.md ⇒ tóm tắt 2–4 dòng
cho user trong chat (lỗi nặng nhất, đã sửa thế nào) ⇒ mở sổ tiến độ ⇒ thi công theo skill `flow-team`. Không hỏi user
duyệt plan; chỉ hỏi khi phát hiện mới đụng mục tiêu, dữ liệu, bảo mật hoặc kiến trúc lớn đã chốt.

## Sổ tiến độ — `progress.md` cạnh SPEC.md

Hook SessionStart nạp lại sổ đang dở mỗi khi mở phiên mới hoặc nén ngữ cảnh, nên sổ phải đủ để người khác làm tiếp
mà không cần hội thoại cũ. Captain cập nhật mỗi lần đổi pha, xong một làn, hoặc có quyết định mới. Ngắn, ≤ 40 dòng:

```
# Tiến độ: <chủ đề>
Trạng thái: đang làm            ← đổi thành "xong" khi đã gộp; hook bỏ qua sổ đã xong
Bước tiếp theo: <một câu, đủ cụ thể để làm ngay>   ← để ở đầu: hook chỉ nạp 2.000 ký tự đầu
Pha: <số + tên>
Nhánh / worktree: <tên nhánh, đường worktree>
Đã chốt: xem .claude/so-chot/INDEX.md (phạm vi chung + <YYYY-MM-DD>-<slug>) — quyết định mới ghi vào sổ chốt, không chép vào đây
Làn:
- [x] A <tên> — <worker> — gộp ở <commit>
- [ ] B <tên> — <worker> — <đang làm / chờ gì>
Finding còn mở: <id/tóm tắt hoặc "không">
```

Quyết định user vừa duyệt ⇒ ghi sổ chốt (`mcp__so-chot__ghi_chot`, hoặc `node ~/.claude/hooks/lib/so-chot.mjs ghi
<projectRoot> <json>`), không ghi vào progress.md. Sổ kiểu cũ có "Đã chốt:" nhiều dòng vẫn được nạp bình thường.
Bước gộp (skill `flow-merge`) tự ghi `Trạng thái: xong` + `Xong ngày: <YYYY-MM-DD>`.
