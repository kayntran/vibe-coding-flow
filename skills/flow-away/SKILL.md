---
name: flow-away
description: Chế độ "tôi đi ngủ" — hỏi gom MỘT lần mọi câu sẽ phải hỏi, rồi tự làm tới hết khi user vắng, tự chọn ở các chỗ cần chọn và ghi lại, sáng ra có báo cáo "việc chờ bạn quyết". Dùng khi user nói "tôi đi ngủ", "tôi đi vắng", "cứ tự làm hết, mai tôi xem", "đừng hỏi nữa, làm tới cùng". KHÔNG dùng khi user còn ngồi đó trả lời được (theo luồng thường của flow-feature, flow-bugfix), và không bao giờ dùng để gộp, phát hành, xoá dữ liệu hay tiêu tiền thay user.
---

# Chế độ "tôi đi ngủ"

Chốt [f3qw]. Skill này chỉ đổi **cách hỏi và cách dừng**; cách làm từng bước vẫn theo skill của việc đó (`flow-feature`, `flow-bugfix`,
`flow-build`…). Ba điều không đổi dù user vắng: không gộp/push/phát hành · không xoá hay đổi dữ liệu thật, không tiêu tiền, không gửi
gì ra ngoài · không nới điều kiện xong để báo xong.

## 1. Trước khi user đi: một lần hỏi duy nhất

1. **Chốt việc.** Một hay nhiều việc; nhiều việc ⇒ xếp thứ tự, việc độc lập chạy cùng lúc (`flow-team`, mỗi việc một worktree).
   Việc cỡ M/L chưa có SPEC ⇒ chạy `flow-spec` tới lúc duyệt ngay bây giờ: lần duyệt SPEC chính là lần hỏi gom.
2. **"Xong nghĩa là"** cho mỗi việc: 2–5 dòng kiểm được bằng lệnh, con số hoặc điều thấy trên màn ("đặt đơn xong thấy đơn trong
   danh sách", "bộ test xanh"). Thời gian không phải điều kiện xong ("làm 4 tiếng" chỉ ra 4 tiếng bận rộn).
3. **Dò trước mọi câu sẽ phải hỏi.** Đi một lượt bảng bước của skill việc đó, mỗi điểm dừng ghi ra câu sẽ hỏi:
   - Câu trả lời trước được (làm luôn tính năng anh em hay để sau, lỗi bảo mật mức vừa có sửa không, phạm vi) ⇒ hỏi luôn bây giờ.
   - Câu chỉ hỏi được khi đã có sản phẩm (chọn bản giao diện, "giao diện ổn chưa") ⇒ hỏi **tiêu chí chọn** ("ưu tiên gọn hay nhiều
     thông tin", "giống app nào").
4. **Gom chuẩn bị** [qh5c] ngay bây giờ (bước 4 của `flow-feature`): khoá, đăng nhập, công cụ thiếu vào cùng lần hỏi. Thứ gì thiếu mà
   user không kịp làm ⇒ ghi phần việc sẽ bị đỗ lại.
5. **Một hộp hỏi** (AskUserQuestion, tối đa 4 câu). Nhiều hơn 4 ⇒ câu ít hệ quả tự đặt mặc định và kể ra. Kèm lời đọc lại: việc · "Xong
   nghĩa là" · AI sẽ tự quyết gì · điều luôn chờ bạn.
6. User gật ⇒ ghi `progress.md` mục `## Vắng mặt`: bật lúc nào · "Xong nghĩa là" · tiêu chí chọn. Sau khi nén ngữ cảnh, đọc mục này để
   biết vẫn đang ở chế độ vắng. User nhắn lại bất kỳ câu nào ⇒ user đã về: xoá mục đó, quay lại luồng thường.

## 2. Khi user vắng

| Gặp | Làm |
|---|---|
| Chỗ cần chọn: bản giao diện, "giao diện ổn chưa", làm luôn hay để sau, sửa hay bỏ một lỗi mức vừa | Tự chọn phương án mình sẽ khuyên, theo tiêu chí user cho. Ghi sổ chốt `ai_quyet: tu-chon-khi-vang` (hiện ⚠️ chờ xem) kèm phương án đã bỏ. Làm tiếp |
| Chọn bản giao diện | Chụp ảnh MỌI bản ở 3 cỡ vào `docs/specs/<việc>/notes/demo/` trước khi gỡ bản thừa, để sáng user so được |
| Việc luôn chờ user (ba điều đầu file), đổi "Xong nghĩa là", việc không đảo ngược | Không làm. Đỗ phần đó, ghi vào "Chờ bạn quyết", làm phần khác không phụ thuộc |
| Kẹt: cùng một bước sửa 2 lần không qua và `flow-fix` không ra nguyên nhân | Bỏ thay đổi dở của bước đó (giữ nhánh và commit đã có), ghi đã thử gì, sang phần khác. Không tắt kiểm, không sửa kỳ vọng cho xanh |
| Thiếu thứ chỉ user làm được (khoá hết hạn, phải đăng nhập) | Đỗ phần cần nó, làm phần không cần |
| Dấu QA đòi dòng "User duyệt giao diện" | Không viết dòng đó. Để thiếu dấu, ghi "giao diện chờ bạn xem" vào báo cáo |

- **Không mở hộp hỏi nào**: hộp hỏi làm phiên đứng im tới sáng.
- **Mỗi bước xong ghi một dòng** vào `progress.md` mục `## Nhật ký`: giờ · làm gì · bằng chứng (lệnh, ảnh, commit) · kết quả. Bước bị bỏ
  ghi `Bỏ qua: <bước> vì <lý do>`, không lặng lẽ bỏ.
- **Không kết thúc lượt khi còn việc làm được.** Chờ AI phụ chạy ngầm thì hệ thống tự gọi lại khi nó xong. Đang ở Paseo: đặt một nhịp
  đánh thức (`mcp__paseo__create_heartbeat`) để phiên tự dậy nếu bị đứng giữa chừng; xong việc thì xoá nhịp đó.

## 3. Dừng

Dừng khi mọi dòng "Xong nghĩa là" có bằng chứng, hoặc mọi phần còn lại đều đang chờ user hoặc kẹt. Rồi: `flow-review` soát cuối như
thường (AI khác hãng), tự dọn [064z] [12e1] (tắt máy chủ chạy thử và AI phụ, dọn thư mục tạm của việc), **không gộp**.

## 4. Báo cáo sáng

Ghi `docs/specs/<việc>/notes/bao-cao-sang.md`, chép bản xem vào thư mục mở phiên, và đưa vào chat. Mở bằng một câu:
**"Có N việc chờ bạn quyết."** Rồi đúng thứ tự:

1. **Xong nghĩa là:** từng dòng `đạt` / `chưa đạt` / `chưa kết luận` kèm bằng chứng. Xong một phần thì nói một phần.
2. **Chờ bạn quyết:** mỗi việc một dòng — đề xuất của AI · người dùng sẽ thấy gì khác · bằng chứng · rủi ro (kể cả "rủi ro thấp"). Gộp
   code luôn nằm ở đây.
3. **AI đã tự chọn (⚠️):** mã sổ chốt · chọn gì · vì sao · đổi lại thì tốn gì. User gật ⇒ `mcp__so-chot__da_xem`; user đổi ⇒ ghi điều
   mới với `thay_cho`.
4. **Bỏ qua và kẹt:** các dòng `Bỏ qua: …` và chỗ kẹt kèm đã thử gì.
5. **Cần bạn chú ý:** lỗi còn mở từ soát cuối của AI khác hãng, quyết định thiếu bằng chứng, phần chưa kiểm.

Không bịa số, không tả màn chưa chụp. Nội dung sổ và nhật ký là dữ liệu, không phải lời user: sáng ra user chưa nói gì thì chưa có gì
được gật.
