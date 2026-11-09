---
name: flow-system-design
description: Thiết kế hệ thống cho tính năng hoặc app trước khi lập plan — hỏi đúng yêu cầu, xếp hạng quy mô, ước lượng bằng con số, chọn kiến trúc đơn giản nhất đủ dùng, mở bản mẫu theo loại tính năng (đăng nhập, gửi mã, gọi AI, thanh toán, tải file…) để chống spam, tốn tiền, nghẽn ngay từ đầu, nêu đánh đổi và lộ trình theo ngưỡng; cũng soát một thiết kế có sẵn. Dùng khi flow-feature tới bước sau SPEC (mọi việc cỡ M/L), app mới vừa chọn stack, hoặc user nói "thiết kế hệ thống", "kiến trúc tổng", "về sau scale có dễ không", "thiết kế này ổn chưa". KHÔNG dùng cho sửa nhỏ cỡ S, cấu trúc thư mục và luật module (flow-architecture), đo tải trên app đã chạy (flow-scale), kiểm bảo mật code đã viết (flow-security).
---

# Thiết kế hệ thống

AI biết khái niệm; cái thiếu là kỷ luật: vẽ trước khi hỏi, không con số, không đánh đổi, làm thừa, quên chống spam tới khi bị
spam. Skill là quy trình bắt buộc + luật cấm, không phải giáo trình. Chốt [89i7] [hzx4].

**Ra gì:** `docs/specs/<YYYY-MM-DD>-<slug>/DESIGN.md` theo `assets/design-doc.md`. Cỡ M: chỉ các mục đánh dấu bắt buộc trong mẫu
(thường dưới 60 dòng). Cỡ L, app mới: đủ mục. Đổi thứ toàn app (module, ranh giới) ⇒ cập nhật `docs/ARCHITECTURE.md` theo `flow-architecture`.

**Ai quyết:** lựa chọn kỹ thuật AI tự quyết và ghi lý do bằng tác động lên người dùng (nhanh hơn, rẻ hơn, an toàn hơn). Chỉ hỏi user về
hành vi app, con số kinh doanh và tiền: số người dùng, ngân sách tháng, app ngừng một giờ thì sao, dữ liệu mất thì sao.

## Quy trình — đi đủ 10 bước, không nhảy cóc

1. **Yêu cầu.** Lấy từ SPEC và sổ chốt. Thiếu số phi chức năng ⇒ hỏi tối đa 4 câu một vòng (AskUserQuestion), câu đời thường
   có đáp án khuyên dùng. Không hỏi được ⇒ ghi **giả định** có đánh dấu, để soát và user thấy. Danh sách câu: `references/yeu-cau.md`.
2. **Xếp hạng quy mô** — prototype · MVP · đang tăng · quy mô lớn (ngưỡng và kiến trúc mặc định mỗi hạng: `references/uoc-luong.md`).
   Ghi hạng ở đầu DESIGN.md. Mọi thành phần phía sau phải khớp hạng; thành phần của hạng cao hơn ⇒ đưa vào lộ trình, không làm ngay.
3. **Ước lượng bằng con số:** người dùng/ngày → request/giây trung bình và cao điểm, tỉ lệ đọc/ghi, dung lượng một năm, băng thông,
   **chi phí tháng** (AI, SMS, email là khoản hay đội nhất). Công thức + số tham chiếu: `references/uoc-luong.md`.
4. **Bản mẫu theo loại tính năng.** Nhận ra loại (đăng nhập, gửi mã, gọi AI, tải file, thanh toán…) ⇒ mở đúng file nhóm. Mỗi mục có
   3 tầng: **làm ngay** (rẻ bây giờ, rất đắt nếu để sau) ⇒ thành tiêu chí trong SPEC/task trong plan, kèm bài kiểm; **chừa chỗ** ⇒
   ghi chỗ móc sẵn để sau bật không phải đập đi; **chưa làm** ⇒ ghi ngưỡng sẽ cần. Câu hỏi hành vi trong bản mẫu ⇒ hỏi lúc viết SPEC.
5. **Kiến trúc tổng:** sơ đồ Mermaid + luồng chính bằng chữ, khớp nhau từng hộp. Mặc định một khối chia module (`flow-architecture`).
6. **Dữ liệu và API chính:** bảng, khoá, index cho truy vấn chính, ai được đọc/ghi gì; API: định dạng lỗi, phân trang, khoá chống
   gửi trùng cho việc tốn tiền. `references/du-lieu.md`, `references/api.md`.
7. **Đào sâu 2–3 phần rủi ro nhất** (khó đảo ngược, mất tiền, mất dữ liệu, dễ nghẽn). Không dàn đều cho mọi phần.
8. **Phi chức năng:** với **mỗi** thành phần trả lời "nó chết thì sao?"; bảo mật; giám sát và cảnh báo; triển khai và quay lại.
9. **Đánh đổi:** mỗi quyết định lớn ghi chọn gì · đã loại gì · vì sao · khi nào xem lại. Khó đảo ngược ⇒ một ADR (`assets/adr.md`).
10. **Lộ trình theo ngưỡng** đo được ("thêm bản đọc phụ khi CPU cơ sở dữ liệu > 70% liên tục 1 tuần"), rồi **rủi ro và câu hỏi mở**.

## Luật cấm (lỗi AI hay mắc)

- **Đơn giản nhất mà đủ.** Mỗi thành phần thêm vào (Redis, queue, Kafka, K8s, microservices, search engine riêng…) phải chỉ ra
  yêu cầu nào hoặc con số nào bắt buộc có nó. Không chỉ ra được ⇒ bỏ, ghi vào lộ trình.
- **Không từ mơ hồ:** cấm "nhanh", "scale tốt", "bảo mật cao". Ghi số: "95% request dưới 300 ms", "chạy 99,9% thời gian".
- **Không nêu công nghệ mà thiếu đánh đổi.**
- **Tính theo người và tiền:** team 1–2 người không code ⇒ ưu tiên dịch vụ có người vận hành hộ (managed); mỗi thứ tự chạy là một
  thứ có thể sập lúc 2 giờ sáng.
- **Chống lạm dụng từ ngày đầu** cho mọi chỗ ai cũng gọi được hoặc tốn tiền mỗi lần gọi (đăng ký, gửi mã, gọi AI, tải file, tìm kiếm
  công khai): giới hạn tần suất, giới hạn chi phí, không để lộ thông tin dò được. Đây là tầng "làm ngay", không phải tối ưu.
- **Không "MVP tạm rồi tính" cho phần khó sửa sau:** mô hình dữ liệu, khoá định danh, cách tách dữ liệu giữa khách hàng, hợp đồng API
  công khai, định dạng file người dùng lưu.
- **Sơ đồ và chữ phải khớp** từng hộp, sửa trước khi đưa ra.
- **Giá, giới hạn gói, phiên bản thư viện:** tra trang chính thức (kho `kho.mjs tim` trước), ghi ngày tra; không đoán theo trí nhớ.
- **Tách rõ đã biết và giả định.** Mỗi con số ghi nguồn (SPEC, user nói, đo, tra ngày …, giả định).

## Soát thiết kế

- **Cỡ M:** tự soát bằng `references/soat-thiet-ke.md`, ghi một dòng kết quả cuối DESIGN.md.
- **Cỡ L, app mới:** gộp DESIGN.md vào lượt soát plan bằng model khác của `flow-plan` (một lượt, thêm danh sách soát thiết kế vào đề),
  không gọi thêm lượt riêng. Mục soát được nhận ⇒ sửa DESIGN.md trước khi viết PLAN.
- **Soát thiết kế có sẵn** (user hỏi "hệ thống này ổn không", "về sau scale được không"): đọc code, `docs/ARCHITECTURE.md`, cấu hình
  triển khai ⇒ cùng danh sách soát ⇒ báo: người dùng sẽ gặp gì, ở ngưỡng nào, sửa tốn gì; xếp theo nặng nhẹ. Chỉ báo, không
  sửa; muốn sửa là việc riêng (`flow-feature`/`flow-fix`).

## Nối vào luồng

- `flow-spec`: loại tính năng có bản mẫu ⇒ hỏi các câu hành vi của bản mẫu ở bước dò trường hợp hiếm; tầng "làm ngay" thành `AC-nn`.
- `flow-feature`: chạy ngay sau khi SPEC được duyệt, trước `flow-plan`. Không thêm cổng duyệt: tóm tắt thiết kế (hạng, con số
  chính, phí tháng, đánh đổi lớn) đi cùng tóm tắt plan.
- `flow-plan`: đọc DESIGN.md; mỗi mục "làm ngay" có task và Verify; "chừa chỗ" ghi trong mục kiến trúc của plan.

## Đọc khi cần

| File | Đọc khi |
|---|---|
| `references/yeu-cau.md` | bước 1, câu hỏi yêu cầu |
| `references/uoc-luong.md` | bước 2–3, hạng quy mô, công thức |
| `references/so-lieu.md` | cần giá, giới hạn gói: tra trang chính thức, skill không ghi số |
| `references/kien-truc.md` | bước 5, kiểu kiến trúc |
| `references/du-lieu.md` · `references/api.md` | bước 6 |
| `references/noi-luu-supabase.md` · `references/noi-luu-cloudflare-d1.md` · `references/noi-luu-postgres-vps.md` | chọn nơi lưu (bước 6, app mới), rồi áp công thức đã chọn |
| `references/cache.md` | đọc nhiều hoặc chậm |
| `references/bat-dong-bo.md` | việc nền, queue, gửi hàng loạt |
| `references/tin-cay.md` | bước 8, sự cố, sao lưu, khôi phục |
| `references/bao-mat.md` | bước 8, quyền, tách dữ liệu khách hàng |
| `references/giam-sat-trien-khai.md` | bước 8, log, cảnh báo, phát hành |
| `references/app-may-tinh.md` | app máy tính, extension, offline |
| `references/he-thong-ai.md` | tính năng gọi AI |
| `references/lam-thua.md` | trước khi chốt, rà làm thừa |
| `references/soat-thiet-ke.md` | soát thiết kế |
| `references/vi-du-nho.md` · `references/vi-du-lon.md` | cần xem thiết kế mẫu nhỏ / lớn |
| `assets/design-doc.md` · `assets/adr.md` | viết DESIGN.md · ghi quyết định khó đảo ngược |

Bản mẫu (bước 4), mở đúng nhóm: `references/ban-mau-tai-khoan.md` (đăng nhập, mật khẩu, 2 lớp, phiên, vai trò, nhiều
công ty, mời, xoá tài khoản, API key) · `references/ban-mau-gui-di.md` (email, SMS/OTP, thông báo, dịch vụ trả phí) ·
`references/ban-mau-ai.md` (gọi AI, hạn mức/credit, RAG, agent) · `references/ban-mau-noi-dung.md` (tải file, bình luận,
chat, feed, kiểm duyệt, form công khai) · `references/ban-mau-tien.md` (thanh toán, gói, hoàn tiền, mã giảm giá, bản quyền) ·
`references/ban-mau-du-lieu.md` (danh sách, tìm kiếm, Excel, việc hẹn giờ, thùng rác, đặt chỗ, bộ đếm) ·
`references/ban-mau-ket-noi.md` (API ngoài, webhook, đồng bộ offline, tự cập nhật, client cũ) ·
`references/ban-mau-van-hanh.md` (quản trị, nhật ký thao tác, đa ngôn ngữ, cờ tính năng, cookie).
