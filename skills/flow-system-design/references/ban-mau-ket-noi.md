# Bản mẫu: kết nối với bên ngoài và client cài trên máy

Dùng ở bước 4 của `flow-system-design`.

## Mục lục

- API cho bên ngoài gọi
- Nhận webhook
- Gửi webhook ra ngoài
- Đồng bộ offline (app máy tính)
- Tự cập nhật app máy tính
- Extension gọi server
- Phiên bản API cho client cũ
- Nhập dữ liệu/kết nối dịch vụ khác qua OAuth
- Báo lỗi tự động/crash report

Cách dùng: nhận ra loại ⇒ hỏi các câu lúc viết SPEC (`flow-spec`) ⇒ "Làm ngay" thành `AC-nn` kèm bài kiểm ⇒ "Chừa chỗ" vào mục kiến
trúc của plan ⇒ "Chưa làm" vào lộ trình theo ngưỡng. Giá và giới hạn gói: tra trang giá chính thức lúc thiết kế, không ghi ở đây.

## API cho bên ngoài gọi

Nhận ra khi: "cho đối tác gọi", "API công khai", "tích hợp Zapier/Make", "khách tự lấy dữ liệu bằng code", "cấp API key".

Hỏi user (lúc viết SPEC):
- Ai được dùng API? → khuyên: chỉ gói trả phí hoặc đối tác được duyệt.
- Mỗi khách gọi tối đa bao nhiêu? → khuyên: 60 lần/phút và 10.000 lần/ngày; quá thì báo rõ, không âm thầm chặn.
- Khoá API bị lộ thì khách làm gì? → khuyên: tự bấm thu hồi và tạo khoá mới trong trang cài đặt.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | API key (khoá bí mật cấp cho khách) sinh ngẫu nhiên, chỉ hiện một lần, lưu dạng băm, có tiền tố nhận diện; kiểm quyền từng đối tượng (lỗi số 1 của API: đổi ID là xem được của người khác); rate limit theo khoá — Rate Limiting binding đếm gần đúng, hạn mức gắn với tiền thì đếm trong DB hoặc Durable Object | Bảng `khoa_api(id, tenant, bam, pham_vi, het_han, thu_hoi_luc, dung_cuoi)` | OAuth cho app bên thứ ba thay mặt nhiều khách — khi có đối tác xây app trên API của mình |
| Chi phí | Trần cỡ trang, trần cỡ request; endpoint nặng có hạn mức riêng | — | Tính tiền theo lượt gọi — khi có khách xin gói theo mức dùng |
| Chịu tải | Idempotency key cho POST tạo/tốn tiền: lưu kết quả lần đầu, lần thử lại trả đúng kết quả đó; cùng khoá khác tham số ⇒ báo lỗi | Trả header `Retry-After` khi 429; tiền tố `/v1` từ ngày đầu | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Chỉ trả trường cho phép (DTO — khuôn dữ liệu riêng cho API), không trả nguyên hàng DB; không nhận khoá trong URL (lọt vào log, lịch sử) | — | — |
| Theo dõi sự cố | Log mỗi request theo ID khoá (không log khoá); đếm 4xx/5xx theo khoá | Trang "Lần dùng cuối" cho khách | — |

Bài kiểm bắt buộc:
- Khoá của tenant A đọc đơn của tenant B ⇒ 404.
- Lần gọi thứ 61 trong 1 phút ⇒ 429 kèm `Retry-After`.
- POST cùng `Idempotency-Key` 2 lần ⇒ một bản ghi, hai phản hồi giống hệt.

Hay sai:
- Lưu khoá thô trong DB ⇒ lộ DB là lộ mọi khoá.
- API trả nguyên hàng DB ⇒ lộ trường nội bộ, khó đổi schema.
- Không có tiền tố phiên bản ⇒ đổi gì cũng phá tích hợp của khách.

## Nhận webhook

Nhận ra khi: "Stripe/Lemon Squeezy báo về", "thanh toán xong thì…", "webhook", "dịch vụ kia gọi lại", "callback".

Hỏi user (lúc viết SPEC):
- Thông báo từ bên kia tới trễ vài phút thì người dùng thấy gì? → khuyên: màn "Đang xác nhận thanh toán…", tự cập nhật khi tới.
- Bên kia không báo về (mất tin) thì sao? → khuyên: app tự đối soát với bên kia mỗi giờ.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Kiểm chữ ký HMAC trên THÂN THÔ (đọc text trước khi parse JSON), so sánh hằng thời gian; kiểm mốc thời gian trong chữ ký chống replay (kẻ xấu gửi lại tin cũ; Stripe mặc định cửa sổ 5 phút, đừng đặt 0); route không cần đăng nhập, miễn CSRF, nhưng chỉ tin chữ ký | Đọc được 2 secret cùng lúc để xoay khoá không gián đoạn | — |
| Chi phí | Chỉ đăng ký loại sự kiện cần dùng | — | — |
| Chịu tải | Trả 2xx NHANH ngay sau khi kiểm chữ ký và lưu sự kiện; xử lý trong Queue (đầu tháng gia hạn hàng loạt sẽ dồn); khử trùng bằng bảng `su_kien_da_nhan(id unique)`; không tin thứ tự tới — cần trạng thái mới nhất thì gọi API bên kia lấy lại | Bảng lưu sự kiện thô để chạy lại khi sửa lỗi xử lý | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Không log nguyên thân nếu có dữ liệu cá nhân; không log secret | — | — |
| Theo dõi sự cố | Job đối soát: Lemon Squeezy chỉ thử lại vài phút, Stripe thử lại nhiều ngày — bên nào cũng cần đối soát; cảnh báo khi lỗi chữ ký tăng hoặc có đơn mà 24 giờ không nhận sự kiện nào | — | — |

Bài kiểm bắt buộc:
- Webhook bị sửa 1 byte thân ⇒ 400, không xử lý.
- Cùng một sự kiện gửi 2 lần ⇒ xử lý đúng 1 lần (một lần mở quyền, một email).
- Sự kiện có mốc thời gian 10 phút trước ⇒ bị từ chối.

Hay sai:
- Parse JSON rồi stringify lại để kiểm chữ ký ⇒ chữ ký luôn sai, rồi "tạm tắt kiểm cho chạy".
- Làm việc nặng trước khi trả 200 ⇒ bên kia hết giờ chờ, gửi lại ⇒ xử lý trùng.
- Tin trang chuyển hướng "Thanh toán thành công" thay cho webhook ⇒ người dùng đóng tab là mất đơn.

## Gửi webhook ra ngoài

Nhận ra khi: "báo sang hệ thống của khách khi có đơn", "khách nhập URL nhận thông báo", "tích hợp Slack/Discord", "gọi sang hệ thống khác khi…".

Hỏi user (lúc viết SPEC):
- Hệ thống của khách sập thì giữ tin bao lâu? → khuyên: thử lại trong 24 giờ rồi dừng, gửi email báo khách.
- Khách có cần nút "Gửi lại"? → khuyên: có, trong trang nhật ký webhook.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Chống SSRF (kẻ xấu nhập địa chỉ nội bộ để server mình gọi vào): chỉ `https`; phân giải tên miền rồi chặn localhost, dải nội bộ, link-local, địa chỉ metadata cloud — kiểm mọi IP trả về, ở CẢ lúc lưu và lúc gửi (chống DNS rebinding: tên miền đổi IP sau khi kiểm); tắt đi theo chuyển hướng; timeout ngắn; chỉ đọc một đoạn đầu phản hồi. Backend trên VPS chung mạng với DB là chỗ nguy hiểm nhất | — | Allow-list đích cố định — khi chỉ có vài đối tác (làm được sớm thì làm) |
| Chi phí | Trần số endpoint mỗi khách; trần số lần thử lại | — | — |
| Chịu tải | Gửi qua Queue, thử lại lùi mũ (chờ lâu dần) có trần; mỗi sự kiện có ID ổn định để khách tự khử trùng | Bảng `webhook_gui(id, endpoint, trang_thai, so_lan, lan_toi)`; tự tắt endpoint lỗi liên tục | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Ký HMAC từng tin bằng secret riêng của mỗi endpoint, kèm mốc thời gian; gửi tối thiểu dữ liệu (hoặc chỉ ID để khách gọi API lấy chi tiết) | — | — |
| Theo dõi sự cố | Nhật ký gửi (mã trả về, thời gian) cho khách xem | — | — |

Bài kiểm bắt buộc:
- Khách nhập `http://127.0.0.1/admin` hoặc tên miền trỏ về `10.0.0.1` ⇒ bị từ chối cả lúc lưu và lúc gửi.
- Endpoint trả 302 tới địa chỉ khác ⇒ không đi theo.
- Endpoint trả 500 liên tục ⇒ thử lại tới trần rồi đánh dấu lỗi, không thử vô hạn.

Hay sai:
- Chỉ kiểm URL lúc khách lưu ⇒ tên miền đổi IP sau đó là lọt.
- Gửi đồng bộ ngay trong request của người dùng ⇒ hệ thống khách chậm làm app mình chậm.
- Không ký tin ⇒ khách không phân biệt được tin thật và tin giả.

## Đồng bộ offline (app máy tính)

Nhận ra khi: "dùng không cần mạng", "mất mạng vẫn làm được", "đồng bộ giữa 2 máy", "có mạng thì tự đẩy lên", "làm việc trên máy bay".

Hỏi user (lúc viết SPEC):
- Hai máy cùng sửa một mục lúc offline thì giữ bản nào? → khuyên: bản sửa sau cùng thắng; bản kia vào mục "Bản xung đột" để người dùng xem lại, không mất.
- Offline tối đa bao lâu vẫn đồng bộ được? → khuyên: 30 ngày; quá thì tải lại từ server và giữ bản trên máy thành bản xung đột.
- Dữ liệu trên máy có cần khoá thêm khi máy bị mất? → khuyên: dựa vào khoá máy của hệ điều hành; chưa tự mã hoá thêm.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Server kiểm lại mọi thay đổi gửi lên như request thường (quyền, cỡ, giá trị); không tin đồng hồ máy khách để quyết quyền | — | — |
| Chi phí | Gửi phần thay đổi theo lô, không gửi cả DB | — | — |
| Chịu tải | ID bản ghi do máy sinh (UUID/ULID), không dùng số tự tăng; cột `phien_ban` tăng mỗi lần sửa; hàng đợi thay đổi trên máy (outbox) có mã thay đổi để server khử trùng; xoá là đánh dấu "bia mộ", không xoá thật cho tới khi mọi máy đã đồng bộ | Cột `thiet_bi_id`; bảng `xung_dot` | Hợp nhất từng trường/CRDT (cấu trúc tự trộn sửa đổi) — khi người dùng thật thường xuyên cùng sửa một tài liệu |
| Dữ liệu (riêng tư, xoá, sao lưu) | SQLite trong thư mục dữ liệu của người dùng; xoá tài khoản ⇒ máy xoá dữ liệu cục bộ lần đồng bộ kế tiếp; bản trên server là bản để sao lưu (`flow-backup`) | Migration dữ liệu cục bộ có số phiên bản | — |
| Theo dõi sự cố | Log lỗi đồng bộ trên máy, gửi kèm báo lỗi tự động (khi người dùng đồng ý) | Màn "Đồng bộ lần cuối lúc …" | — |

Bài kiểm bắt buộc:
- Máy A và B sửa cùng mục lúc offline rồi cùng đồng bộ ⇒ một bản thắng, bản kia nằm trong danh sách xung đột, không mất chữ nào.
- Gửi cùng lô thay đổi 2 lần (mạng chập chờn) ⇒ không nhân đôi bản ghi.
- A xoá mục lúc offline, B sửa mục đó ⇒ kết quả đúng luật đã chốt trong SPEC (có test cho luật này).

Hay sai:
- Dùng ID tự tăng ở cả máy và server ⇒ hai máy tạo trùng ID.
- Xoá thật không để dấu ⇒ máy khác đồng bộ lên làm bản ghi "sống lại".
- Tin đồng hồ máy khách để chọn bản thắng ⇒ máy chỉnh giờ sai thắng mãi.

## Tự cập nhật app máy tính

Nhận ra khi: "tự cập nhật", "có bản mới thì báo", "cập nhật trong app", "không phải tải lại file cài", "đẩy bản sửa lỗi cho mọi người".

Hỏi user (lúc viết SPEC):
- Có bản mới thì tự cài hay hỏi? → khuyên: tự tải ngầm, hỏi "Khởi động lại để cập nhật?".
- Có lúc nào ép buộc cập nhật? → khuyên: chỉ khi bản cũ có lỗ bảo mật hoặc server không còn hỗ trợ.
- Có kênh thử nghiệm (beta) cho người thích thử trước? → khuyên: chưa.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Ký bản phát hành bằng Ed25519 (chữ ký số): khoá riêng chỉ ở máy build/CI, khoá công khai nhúng trong app; app kiểm chữ ký TRƯỚC khi thay; manifest phiên bản (file mô tả bản mới) cũng được ký; chỉ tải qua HTTPS; macOS phải ký mã + notarize, Windows ký mã để không bị cảnh báo | Trường `phien_ban_toi_thieu` trong manifest | Kênh beta — khi có trên 100 người tự nguyện thử (kinh nghiệm, không phải số đo) |
| Chi phí | File cài để trên R2 (không tính phí tải ra — tra trang giá chính thức lúc thiết kế) | — | Bản vá chênh lệch (delta) — khi file cài lớn và người dùng than tải lâu |
| Chịu tải | App kiểm bản mới lúc mở và mỗi vài giờ, cộng độ lệch ngẫu nhiên để không dồn cùng phút | Trường `ti_le` trong manifest để phát hành dần theo phần trăm | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Thay file chạy nguyên khối, giữ bản cũ để tự quay về nếu bản mới không khởi động; migration dữ liệu cục bộ chạy lại nhiều lần vẫn đúng | — | — |
| Theo dõi sự cố | App gửi phiên bản đang chạy (ẩn danh); đếm lỗi khởi động sau cập nhật | Dừng phát hành bằng cách trỏ manifest về bản cũ (`flow-rollback`) | — |

Bài kiểm bắt buộc:
- File cập nhật bị sửa 1 byte ⇒ app từ chối cài, giữ nguyên bản cũ.
- Manifest không có chữ ký hợp lệ ⇒ app bỏ qua, không tải.
- Bản mới không khởi động được ⇒ lần mở sau chạy lại bản cũ.

Hay sai:
- Chỉ kiểm checksum đặt cạnh file ⇒ ai chiếm được nơi để file thì thay được cả hai.
- Để khoá riêng trong repo hoặc trong app.
- Dự án còn ở Wails v2 mà làm theo hướng dẫn updater của v3 (v2 chưa thấy updater chính thức) ⇒ kiểm phiên bản Wails trong `go.mod` trước.

## Extension gọi server

Nhận ra khi: "extension Chrome", "tiện ích trình duyệt", "bấm nút trên trang web khác để lưu về app", "đăng nhập trong extension".

Hỏi user (lúc viết SPEC):
- Extension cần đọc trang nào? → khuyên: chỉ trang người dùng đang bấm vào (quyền `activeTab`), không đọc mọi trang.
- Người dùng đăng nhập extension thế nào? → khuyên: đăng nhập trên web của mình, extension nhận phiên từ đó.
- Nội dung trang web có gửi về server không? → khuyên: chỉ phần người dùng chọn, nói rõ trên màn trước khi gửi.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Mọi mã nằm trong gói (MV3 cấm tải mã từ xa, kể cả CDN), không `eval`; server coi extension là client công khai: KHÔNG nhúng secret (ai cũng giải nén được gói), việc cần khoá thì gọi server của mình; token người dùng hạn ngắn, để trong `chrome.storage`; chỉ nhận message từ nguồn mình (kiểm `sender`) | — | — |
| Chi phí | Rate limit theo người dùng ở server (một lỗi vòng lặp ở extension có thể gọi liên tục từ hàng nghìn máy) | — | — |
| Chịu tải | Gom request, không gọi server mỗi lần trang tải | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Chỉ gửi dữ liệu trang khi người dùng bấm; khai đúng mục riêng tư trên Chrome Web Store; xin quyền tối thiểu | — | — |
| Theo dõi sự cố | Header phiên bản extension trên mỗi request để biết bản nào lỗi | — | — |

Bài kiểm bắt buộc:
- Quét gói đã build ⇒ không có secret, khoá API bên thứ ba, URL script từ xa.
- Trang web lạ gửi message giả lệnh tới extension ⇒ bị bỏ qua.
- Token hết hạn ⇒ extension xin lại hoặc mời đăng nhập, không gọi lặp liên tục.

Hay sai:
- Nhúng khoá AI/khoá dịch vụ trả phí vào extension ⇒ bị lấy dùng, mình trả tiền (`flow-key-leak`).
- Xin quyền `<all_urls>` "cho tiện" ⇒ store duyệt lâu, người dùng sợ.
- Tải script từ CDN ⇒ bị store từ chối.

## Phiên bản API cho client cũ

Nhận ra khi: "đổi API mà extension cũ vẫn chạy", "bản app cũ lỗi sau khi cập nhật server", "bắt người dùng cập nhật", "app máy tính và web dùng chung server".

Hỏi user (lúc viết SPEC):
- Bản cũ được hỗ trợ bao lâu sau khi có bản mới? → khuyên: 90 ngày.
- Hết hỗ trợ thì người dùng thấy gì? → khuyên: màn "Cần cập nhật" có nút tải bản mới; không âm thầm lỗi.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | — | `toi_thieu` cũng dùng để chặn bản có lỗ bảo mật | — |
| Chi phí | — | — | — |
| Chịu tải | Client gửi phiên bản trong mỗi request; server chỉ THÊM trường/endpoint, không đổi nghĩa hay xoá trường đang dùng; thay đổi phá vỡ ⇒ đường mới (`/v2`) chạy song song | Endpoint `GET /phien-ban` trả `toi_thieu` và `khuyen_dung`; màn "Cần cập nhật" có sẵn từ bản ĐẦU TIÊN | Gỡ `/v1` — khi request từ bản cũ dưới 1% trong 30 ngày (kinh nghiệm, không phải số đo) |
| Dữ liệu (riêng tư, xoá, sao lưu) | Đổi schema theo thứ tự mở rộng → chuyển dữ liệu → thu hẹp, để bản cũ và mới cùng chạy; ghi rõ thứ tự deploy server/client | — | — |
| Theo dõi sự cố | Đếm request theo phiên bản client | — | — |

Bài kiểm bắt buộc:
- Test hợp đồng: phản hồi mới vẫn đọc được bằng code của bản client cũ (thêm trường không làm bản cũ lỗi).
- Client có phiên bản dưới `toi_thieu` ⇒ nhận 426 và hiện màn "Cần cập nhật".
- Xoá một trường bản cũ còn dùng ⇒ test hợp đồng đỏ.

Hay sai:
- Bản đầu không có màn "Cần cập nhật" ⇒ về sau không bao giờ ép được người dùng cũ.
- Đổi tên trường và deploy server trước khi bản extension mới được store duyệt (duyệt mất vài ngày).
- Client không gửi phiên bản ⇒ không biết còn bao nhiêu người dùng bản cũ.

## Nhập dữ liệu/kết nối dịch vụ khác qua OAuth

Nhận ra khi: "kết nối Google Drive", "đồng bộ lịch Google", "nhập từ Notion/Sheets", "lấy dữ liệu từ tài khoản X", "liên kết tài khoản".

Hỏi user (lúc viết SPEC):
- Chỉ đọc hay cả ghi vào dịch vụ kia? → khuyên: chỉ đọc, và chỉ file người dùng chọn.
- Ngắt kết nối thì dữ liệu đã nhập giữ hay xoá? → khuyên: hỏi người dùng lúc ngắt; mặc định giữ.
- Đồng bộ liên tục hay nhập một lần? → khuyên: nhập một lần + nút "Nhập lại"; tự động để sau.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | OAuth luồng authorization code + PKCE; `state` gắn với phiên trình duyệt; redirect URI cố định, không lấy từ query; scope (phạm vi quyền) hẹp nhất — vd Google Drive chỉ file người dùng chọn, không đọc mọi file | — | — |
| Chi phí | Tôn trọng hạn mức API bên kia: gặp 429 thì chờ lâu dần; nhập lớn chạy nền | — | — |
| Chịu tải | Nhập qua Queue, chia trang theo API bên kia | Bảng `ket_noi(nguoi_dung, nha_cung_cap, scope, token_ma_hoa, trang_thai, loi_cuoi)` | Nhận thông báo đẩy từ dịch vụ kia — khi cần đồng bộ gần như ngay lập tức |
| Dữ liệu (riêng tư, xoá, sao lưu) | Refresh token (khoá dùng lâu để xin quyền mới) là bí mật: mã hoá khi lưu, chỉ server đọc, không về client, không log; ngắt kết nối ⇒ gọi thu hồi bên nhà cung cấp rồi xoá token; bị thu hồi phía bên kia ⇒ báo "Kết nối hết hạn — Kết nối lại" | — | — |
| Theo dõi sự cố | Đếm lỗi làm mới token theo nhà cung cấp | — | — |

Bài kiểm bắt buộc:
- Callback OAuth có `state` không khớp phiên ⇒ bị từ chối.
- Bấm "Ngắt kết nối" ⇒ token bị xoá khỏi DB và đã gọi API thu hồi.
- Refresh token không xuất hiện trong bất kỳ phản hồi API hay dòng log nào.

Hay sai:
- Xin scope rộng "cho tiện" ⇒ Google bắt thẩm định lâu, người dùng sợ bấm.
- Lưu token thô trong DB.
- Không xử lý token hết hạn ⇒ nhập lỗi im lặng, người dùng tưởng đã đồng bộ.

## Báo lỗi tự động/crash report

Nhận ra khi: "app văng thì gửi báo lỗi", "biết người dùng gặp lỗi gì", "Sentry", "gửi log cho tôi", "extension lỗi trên máy khách".

Hỏi user (lúc viết SPEC):
- Gửi báo lỗi tự động hay hỏi người dùng? → khuyên: hỏi một lần lúc mở lần đầu ("Gửi báo lỗi ẩn danh?"), có công tắc trong cài đặt.
- Báo lỗi có kèm nội dung người dùng đang làm? → khuyên: không; chỉ thông tin kỹ thuật.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Endpoint nhận báo lỗi là công khai ⇒ rate limit theo thiết bị/IP, trần cỡ, nội dung coi như dữ liệu lạ (escape khi hiện ở trang quản trị) | — | — |
| Chi phí | Gộp lỗi trùng theo dấu vết (fingerprint), lấy mẫu khi một lỗi lặp quá nhiều | — | Dịch vụ ngoài (Sentry…) — khi tự xem không xuể, trên 50 lỗi khác nhau mỗi tuần (kinh nghiệm, không phải số đo) |
| Chịu tải | Gửi ngầm, không chặn app; lỗi lúc offline xếp hàng gửi sau | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Lọc trước khi gửi: không tên người dùng trong đường dẫn, không email, token, nội dung file; ID thiết bị ngẫu nhiên không gắn tài khoản; tự xoá báo lỗi sau 90 ngày | — | — |
| Theo dõi sự cố | Mỗi báo lỗi kèm phiên bản app + hệ điều hành; cảnh báo khi xuất hiện lỗi mới ngay sau một lần phát hành | — | — |

Bài kiểm bắt buộc:
- App văng khi đang mở `C:/Users/Lan/Bi-mat.docx` ⇒ báo lỗi gửi đi không chứa "Lan" lẫn tên file.
- Tắt công tắc báo lỗi ⇒ không có request nào tới endpoint báo lỗi.
- Một máy gửi 1.000 báo lỗi trong 1 phút ⇒ bị chặn sau ngưỡng.

Hay sai:
- Gửi nguyên file log có token, mật khẩu.
- Không hỏi đồng ý trước khi gửi.
- Endpoint không giới hạn ⇒ bị spam làm đầy kho log.
