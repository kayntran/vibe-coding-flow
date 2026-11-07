# Mẫu PLAN.md và sổ tiến độ

## Kiến trúc: bắt buộc 9 dòng

Mỗi dòng một câu trả lời, thiếu dòng nào là plan chưa đạt:

1. Ranh giới module, ai được gọi ai.
2. Hợp đồng giữa module (kiểu/schema, ai sở hữu).
3. Dữ liệu: bảng thuộc module nào, ai được ghi, xoá/đổi có sao lưu không.
4. Lỗi và biên: parse tại biên, lỗi nào người dùng thấy.
5. Tăng trưởng: thứ gì vỡ đầu tiên ở 10x người dùng, đường nâng cấp.
6. Quan sát: độ trễ, lưu lượng, lỗi, bão hoà; ai được báo khi hỏng.
7. Quyền, riêng tư.
8. Chi phí trần.
9. Đường quay lại (rollback).

Không "MVP tạm" cho dữ liệu, hợp đồng, ranh giới.

## Các phần khác

- **Mã nối:** mỗi task ghi tiêu chí nó phủ (`AC-xx → task → kết quả`); báo cáo QA, review đánh dấu theo mã đó.
- **Chọn thư viện:** dựa research.md, ghi lý do.
- **ADR** cho quyết định khó đảo ngược (DB, giao thức, cấu trúc module, phụ thuộc lớn): `docs/adr/NNNN-<tên>.md` = Bối cảnh, Quyết định, Hệ quả,
  Trạng thái. ADR đã Accepted không sửa; đổi ý thì viết ADR mới.
- **Dễ mở rộng, tự kiểm:** tách theo trách nhiệm, không theo layer; không abstraction cho thứ dùng một lần; không phụ thuộc vòng; điểm mở rộng có
  thật trong roadmap, không đoán. Một ranh giới có biến thể thật thì đi thử biến thể kế tiếp qua thiết kế: rủi ro thành task thường, không dựng
  khung cho biến thể chưa có.

## Làn song song: bảng máy đọc được

Mục `## Làn` trong PLAN.md, đúng tên cột:

```
| lane | worker | files | ops | depends_on | accept |
|---|---|---|---|---|---|
| A | coder | shared/types.ts | new | - | pnpm test types |
| B | coder | web/src/api/** | extend | A | pnpm -C web test api |
| C | coder-lite | web/src/i18n/** | extend | A | pnpm -C web test i18n |
```

- `files`: glob ngăn bởi phẩy. `ops`: replace, extend, rename, delete, new. `depends_on`: làn phải xong trước (`-` = không).
- Contract/type dùng chung là một làn riêng không phụ thuộc ai (wave 1); các làn dùng nó `depends_on` làn đó.
- File nóng (lockfile, migration, config gốc, i18n chung, registry) thuộc đúng một làn hoặc captain gom cuối.
- Mỗi task có test của nó; mỗi làn có `accept`.
- Kiểm bằng máy trước khi soát plan: `node ~/.claude/hooks/lane-check.mjs plan <PLAN.md>` báo làn trùng file (`OVERLAP`), file nóng hai chủ (`HOT`),
  phụ thuộc sai/vòng, rồi in các **wave**. Hai làn cùng đụng một symbol thì git không thấy được: soát cột `ops`, gộp hai làn hoặc cho chạy nối tiếp.
- Chạy song song có đáng không: theo mục "Khi nào KHÔNG song song" trong skill `flow-team`.

## Plan sống

Cuối PLAN.md luôn có 4 mục, cập nhật trong lúc làm:

- `## Phát hiện bất ngờ`: kèm bằng chứng (lệnh và kết quả).
- `## Nhật ký quyết định`.
- `## Thay đổi plan`: mỗi dòng `ngày giờ | task | đổi gì | vì sao | người dùng thấy khác không | ai quyết`.
- `## Kết quả`: khi xong.

**Tự sửa plan và ghi nhật ký, không hỏi:** đổi thứ tự hoặc chia nhỏ task, tên file/hàm, chọn thư viện trong danh sách cho phép, thêm bước kiểm, chỉnh tiêu
chí kỹ thuật mà điều người dùng thấy không đổi.

**Dừng hỏi user (câu đời thường):** đổi điều người dùng thấy, thêm/bỏ tính năng, xoá/đổi dữ liệu, thêm thứ tốn tiền, quyền/bảo mật, đổi kiến trúc lớn hoặc
mục tiêu đã chốt, hai lần sửa liền một task không qua kiểm.

Làm ra sai ý: quay về plan, sửa cụ thể hơn rồi làm lại phần đó, không vá chồng.

## Sổ tiến độ: `progress.md` cạnh SPEC.md

Ngắn, tối đa 40 dòng:

```
# Tiến độ: <chủ đề>
Trạng thái: đang làm            ← đổi thành "xong" khi đã gộp; hook bỏ qua sổ đã xong
Bước tiếp theo: <một câu, đủ cụ thể để làm ngay>   ← để ở đầu: hook chỉ nạp 2.000 ký tự đầu
Đang chờ user gật: <việc gì, hoặc "không">
Pha: <số + tên>
Nhánh / worktree: <tên nhánh, đường worktree>
Đã chốt: xem .claude/so-chot/INDEX.md (phạm vi chung + <YYYY-MM-DD>-<slug>) — quyết định mới ghi vào sổ chốt, không chép vào đây
Làn:
- [x] A <tên> — <worker> — gộp ở <commit>
- [ ] B <tên> — <worker> — <đang làm / chờ gì>
Finding còn mở: <id/tóm tắt hoặc "không">
```

Ghi quyết định: `mcp__so-chot__ghi_chot`, hoặc `node ~/.claude/hooks/lib/so-chot.mjs ghi <projectRoot> <json>`.
