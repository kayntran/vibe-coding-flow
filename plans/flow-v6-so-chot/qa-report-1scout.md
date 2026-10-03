# QA legacy-migrate trên bản sao 1Scout Marketing

Bản sao (đã migrate xong, để captain tự mở): `C:/Users/Admin/AppData/Local/Temp/qa-1scout-1473/repo` (remote đã gỡ, HOME trỏ `.../qa-1scout-1473/home`).
Dự án thật D:/AI/1Scout Marketing: không đổi (git status 29 dòng trước = sau, không có .claude/so-chot, docs/legacy).
Nhật ký lệnh: `plan-out.json`, `apply1.json`, `apply2.json`, `verify1.json`, `indep.mjs` (script đối chiếu độc lập của QA) cạnh báo cáo này.
Ghi chú môi trường: HOME tạm không có git identity nên lần apply đầu lỗi; QA đặt biến GIT_AUTHOR/COMMITTER (không sửa config) rồi chạy lại.
Nguồn: 154 file .md (115 tracked + 41 chưa tracked, trong đó toàn bộ `.claude/reports/*` bị .gitignore).

## Bảng criteria

| criteria | kết quả | bằng chứng |
|---|---|---|
| AC25 tự ghép + độ chắc, chỉ hỏi dòng không chắc, file lạ ⇒ docs/legacy | PASS có lỗi (xem B2, B3, B6) | plan: 154 dòng, 18 tính năng; cao 137 (46 ghép tính năng + 91 legacy), vừa 15, thấp 2 (can_hoi). Điền "khong-co-nay" ⇒ apply từ chối rõ dòng nào; để trống ⇒ từ chối "chưa trả lời" |
| AC26 2 commit đúng nội dung | PASS | 69af1965 = 113 R (100%) + 41 A; 88c2bbf1 = 309 quyết định + INDEX/ROADMAP + 1 progress.md. Script độc lập: 309/309 ý nguồn nằm trong đúng thư mục phạm vi, 0 sai phạm vi; 2 "thiếu" là dòng tiêu đề bảng bị bỏ có chủ ý |
| AC26 verify | PASS | `{"ok":true,"nguon_y":309,"dich_y":309,"loi":[]}`. Phá thử (sửa chữ, xoá 1, nhân đôi 1) ⇒ verify exit 1, báo đủ 3 loại thieu/nhan_doi/sai_noi_dung |
| AC26 apply lần 2 không đổi | PASS | commit2 null, nhan_lai 309, HEAD không đổi, working tree sạch. Apply lần đầu bị ngắt (thiếu git identity) rồi chạy lại: không bản trùng. plan sau khi đã chuyển ⇒ từ chối rõ ràng |
| so_y 3 file mẫu vs đếm tay | PASS | jev-routing 20/20, image-studio 13/13, tool-search 10/10; "ngoai" 1/2/3 khớp số dòng ngoài ý. Tổng 8 file = 309 |
| AC27 ROADMAP/INDEX | FAIL một phần | Xem B4, B5 |

## Phần 1: kết quả plan
- 18 tính năng, 152 tự ghép (gồm 91 legacy), 2 cần hỏi: `reports/ai-agent-tool-gaps.md`, `reports/ai-agent-tool-gaps-2.md` (gợi ý ai-agent; ứng viên liệt kê ai-agent / ai-agent-tool-search).
- 10 dòng tự ghép đáng ngờ nhất (đối chiếu nội dung):
  1. `plans/plugins-media-tools.md` ⇒ plugins (cao): plan chung Plugins + Media tools phục vụ cả transcribe (T15–T17) — có thể thuộc transcribe.
  2. `plans/screenshots-lightshot.md` ⇒ screenshots (cao): plan Lightshot L1–L10 là hướng riêng, có 3 tính năng screenshots-* nên lẽ ra "vừa".
  3. `plans/ai-agent-core-plan.md` ⇒ ai-agent (cao): "Plan 1/3" nhưng nằm notes/, không thành PLAN.md (PLAN.md đã là ai-agent.plan.md).
  4. `plans/ai-agent-review-14-17.md` ⇒ ai-agent (cao): hợp lý nhưng chỉ nhờ tiền tố.
  5. `plans/image-studio-review-2026-09-23.md` ⇒ image-studio (cao): đúng (trước openrouter 09-24).
  6-8. `reports/ai-agent-gaps-2-recon-*` (3 file) ⇒ ai-agent-gaps-2 (vừa): đúng.
  9-10. `reports/ai-agent-gaps.recon-*` (2 file) ⇒ ai-agent-gaps (vừa): đúng. Cũng ghi: `screenshots-editor.md/.draft.md`, `screenshots-web.md`, `image-studio-openrouter.facts.md` (vừa, đúng).
  Sai thật sự: 2 dòng tool-gaps (B3) và 91 dòng legacy chứa tài liệu của tính năng thật (B2).
- Trả lời QA điền: cả 2 file `tool-gaps` ⇒ **ai-agent-gaps**, lý do: decisions của ai-agent-gaps dẫn đúng 2 file này làm bằng chứng khoảng hở, gaps-1.plan cũng dẫn.

## Bug

### B1 MAJOR: kéo 41 file đang bị .gitignore vào lịch sử git
`.gitignore` của dự án ghi `.claude/reports/*` "dùng một lần, captain đọc rồi bỏ" (chỉ giữ README). Commit 1 thêm 41 file đó (`A docs/specs/.../notes`, `docs/legacy/*`) vào git. Cảnh báo của plan chỉ nói "chưa được git theo dõi", không nói là cố ý bỏ qua; không hỏi. Push lên là không rút lại được.
Mong đợi: file bị ignore không tự vào commit (bỏ qua hoặc hỏi). Thực tế: vào commit 69af1965.
Spec đỏ:
```js
test('apply không git add file bị .gitignore', () => {
  const root = makeRepo({ gitignore: '.claude/reports/*\n', files: { '.claude/reports/x.md': '#x' } });
  run('plan', root); run('apply', root);
  assert.equal(git(root, 'ls-files docs/legacy/x.md'), '');
});
```

### B2 MAJOR: tài liệu tính năng tên kiểu `<slug>-decisions.md` / `-plan.md` đi thẳng legacy, độ chắc "cao", không hỏi
91 file vào docs/legacy, trong đó có 6 file quyết định (ai-writer, cde, content-hub, home-widgets, redirect-indexcheck-redesign, wayback-input-redesign: 811 dòng) KHÔNG vào sổ chốt (chỉ 8/14 file decisions được nhập: 309 ý). Cùng tính năng có `-plan`, `-steps`, `-recon`… cũng nằm legacy. Quy ước tool chỉ nhận dấu chấm (`slug.decisions.md`), mà dự án dùng cả hai kiểu.
Mong đợi: nhận `-decisions` / `-plan`, hoặc ít nhất hạ về "vừa/hỏi" và cảnh báo "6 file tên giống decisions nhưng không nhập sổ". Thực tế: im lặng.
Spec đỏ:
```js
test('content-hub-decisions.md vào sổ chốt, không vào legacy', () => {
  const root = makeRepo({ files: { '.claude/plans/content-hub-decisions.md': '- D1 chọn A\n' } });
  run('plan', root); run('apply', root);
  assert.equal(countDecisions(root, 'content-hub'), 1);
});
```

### B3 MAJOR: dòng "cần hỏi" gợi ý sai, thiếu đáp án đúng
tool-gaps(-2) thực chất thuộc `ai-agent-gaps` nhưng ứng viên chỉ có ai-agent và ai-agent-tool-search; đề xuất mặc định ai-agent. Người dùng chỉ biết đáp án nếu tự đọc nội dung.
Mong đợi: ứng viên gồm mọi tính năng chia sẻ token tên (ai-agent-gaps có "gaps" + "tool"…) hoặc dòng nhắc nội dung được file khác dẫn tới (decisions của ai-agent-gaps nhắc tên 2 file này).
Spec đỏ: fixture `x-tool-gaps.md` + `x-gaps.decisions.md` có chữ "x-tool-gaps.md" ⇒ ung_vien chứa "x-gaps".

### B4 MAJOR: sau khi chuyển, chỉ dẫn của dự án và 225 dòng trong 77 file trỏ đường cũ
`.claude/CLAUDE.md:10` "Mở phiên mới → đọc `.claude/plans/HANDOFF.md`" ⇒ file đã chuyển sang docs/legacy/HANDOFF.md. `.claude/rules/worktree-flow.md:15` và ROADMAP gốc cũng nhắc `.claude/plans/`. Trong docs/ còn 225 dòng trỏ `.claude/plans|reports/` cũ (vd plan ghi "quyết định ở `.claude/plans/plugins.decisions.md`"). Phiên mới sẽ không tìm được HANDOFF.
Mong đợi: plan cảnh báo danh sách chỗ trỏ cũ (hoặc để HANDOFF.md tại chỗ). Thực tế: không cảnh báo.
Spec đỏ: sau apply, `grep -r ".claude/plans/HANDOFF.md" CLAUDE.md` rỗng hoặc plan.canh_bao chứa "HANDOFF".

### B5 MAJOR (AC27, người không biết code): INDEX.md khó đọc
- 309 dòng phẳng, xếp theo mã ngẫu nhiên (0469, 0qdt, 194u…), trộn lẫn mọi tính năng; không nhóm theo tính năng/ngày.
- Mọi dòng đều "⚠️" và cùng giờ giả (221 dòng "2026-10-02 07:39", 88 dòng "2026-09-26 22:19" = giờ commit hàng loạt, không phải ngày chốt thật; quyết định T40 ghi "2026-09-23" trong chữ nhưng cột ngày 09-26).
- Mỗi dòng đuôi `→ 2026-…/xxxx-ten-dai.md` (309/309) và 76 dòng có code/đường dẫn trong backtick; 65 dòng cắt cụt "…" giữa câu.
- Lẫn ghi chú không phải quyết định: bảng đo (local-image: "Mac mini M4 16GB, Metal · 4252 s · swap 9,8GB", "như cũ · ~4,8GB · 361MB · 236 s · —" mất tiêu đề cột nên vô nghĩa), "Tiến độ…", "PLAN ĐÃ KÝ".
- Chỉ một dòng hướng dẫn đầu trang — tốt, ngắn.
Đề xuất: nhóm theo tính năng (tên tiếng người), bỏ cột đường dẫn, bỏ giờ phút, gộp "chưa xem" thành một dòng đếm theo tính năng thay vì liệt kê 309 dòng.
Spec đỏ: INDEX.md không chứa `→ ` + đường dẫn file; dòng được nhóm dưới tiêu đề tính năng.

### B6 MINOR: ROADMAP.md
- "Đang làm (0)", "Cần xem lại (19)": 18 dòng chỉ là slug + lý do máy ("chưa có progress.md", "không rõ trạng thái trong progress.md"); không tên tính năng dễ hiểu, không biết cái nào quan trọng. Người dùng không làm được gì từ danh sách này. Dòng cuối "309 quyết định ⚠️ chờ xem lại" lẫn vào danh sách tính năng.
- Trùng tên với `ROADMAP.md` gốc viết tay của dự án (đề xuất, có "Đã có 11 tool") ⇒ hai roadmap; cái mới "tự sinh, đừng sửa tay".
- `docs/ROADMAP-luu-tru.md` ra file rỗng "(chưa có)".
- Tên thư mục/ngày lấy theo giờ commit hàng loạt: local-image ký 2026-09-26 nhưng thư mục `2026-10-02-local-image`; plugins ký 09-20 nhưng 10-02; ai-agent-gaps-1 (10-02) đứng sau gaps-2 (09-29): thứ tự sai.

### B7 MINOR: lỗi thiếu git identity khó đọc
`lỗi: git commit -q -m lỗi: Author identity unknown *** Please tell me who you are…` (câu bị dính, tiếng Anh, cắt cụt). Nên nói một câu tiếng Việt + lệnh `git config user.name`. Trạng thái sau lỗi: 154 thay đổi đã staged, chưa commit; chạy lại được (đã thử).

### B8 MINOR: phụ
- Sửa `.gitattributes` của dự án (thêm 4 dòng merge=union, gồm `docs/IDEAS.md` chưa tồn tại) mà không báo trước.
- `reports/README.md` thành `docs/legacy/README.md` (tên dễ nhầm); quy tắc ignore `!.claude/reports/README.md` mất tác dụng.
- Chỉ 1/5 file progress.md được thêm dòng "Sổ chốt" (đúng chỉ khi có sổ; nhưng không báo trong output vì sao 4 file kia không).

## Không test được
- Cạnh tranh hai tiến trình apply cùng lúc, repo có working tree bẩn trước apply: không thử (rủi ro, ngoài phạm vi).
- Hành vi hook/phiên Claude Code sau migrate (đọc sổ chốt): không chạy.
