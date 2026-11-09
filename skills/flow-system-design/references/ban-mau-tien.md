# Bản mẫu: tiền, gói và phần thưởng

Dùng ở bước 4 của `flow-system-design` (bản mẫu theo loại tính năng), câu hỏi hành vi đem hỏi lúc `flow-spec`.

## Mục lục
- Thanh toán một lần
- Gói định kỳ
- Dùng thử, nâng/hạ gói, huỷ, hoàn tiền, tranh chấp
- Điểm thưởng và mã giảm giá
- Giới thiệu bạn bè (referral)
- Khoá bản quyền cho app máy tính và extension trả phí
- Marketplace chia tiền cho người bán (mặc định để ngoài phạm vi)

Số mặc định trong bảng (14 ngày, 3 máy…) là kinh nghiệm, không phải số đo — chỉnh theo app. Phí cổng thanh toán: tra trang giá chính thức lúc thiết kế.
Luật chung cả nhóm: **cổng thanh toán là nguồn sự thật**, app chỉ mở quyền theo webhook đã kiểm chữ ký + đối soát; không bao giờ theo trang "thanh toán thành công" hay dữ liệu từ trình duyệt.

## Thanh toán một lần
Nhận ra khi: "mua", "thanh toán", "checkout", "trả tiền một lần", "bán khoá học/ebook/template".

Hỏi user (lúc viết SPEC):
- Khách trả tiền xong mà đóng tab trước khi về trang cảm ơn thì vẫn có hàng chứ? → khuyên: có — giao hàng theo xác nhận từ cổng thanh toán, không theo trang cảm ơn.
- Ai lo thuế/hoá đơn cho khách nước ngoài? → khuyên: bán toàn cầu một mình thì dùng cổng kiểu "bán hộ" (merchant of record, vd Lemon Squeezy) để cổng lo thuế; xác nhận lại với kế toán.
- Hoàn tiền trong bao lâu? → khuyên: 14 ngày, ghi rõ trên trang mua.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Giá lấy ở server theo mã sản phẩm, không nhận giá từ trình duyệt; kiểm chữ ký webhook trên thân thô (chưa parse), so sánh hằng thời gian, giữ cửa sổ thời gian chống phát lại (đừng đặt 0); route webhook miễn CSRF nhưng chỉ nhận đúng chữ ký | — | Chống gian lận thẻ riêng — cần khi tỉ lệ tranh chấp tăng; dùng công cụ có sẵn của cổng trước |
| Chi phí | Phí cổng mỗi giao dịch vào ước lượng bước 3 | — | — |
| Chịu tải | Webhook trả 2xx ngay, việc nặng (gửi thư, mở quyền) qua hàng đợi | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Giao hàng idempotent (làm lại không ra kết quả đôi): lưu event ID đã xử lý, bỏ qua trùng; khoá chống trùng khi tạo phiên thanh toán; bảng `orders` có trạng thái rõ (chờ, đã trả, đã hoàn, tranh chấp); không lưu số thẻ — để cổng giữ | Cột `provider_payment_id`, `refunded_at` | — |
| Theo dõi sự cố | Việc đối soát định kỳ: kéo giao dịch từ cổng so với `orders` (Lemon Squeezy chỉ gửi lại webhook trong vài phút, Stripe tới 3 ngày ⇒ lỡ là mất nếu không đối soát); cảnh báo webhook sai chữ ký hoặc lỗi liên tục | — | — |

Bài kiểm bắt buộc:
- Gửi cùng một webhook hai lần ⇒ giao hàng một lần.
- Webhook sai chữ ký hoặc quá cửa sổ thời gian ⇒ bị từ chối, dữ liệu không đổi.
- Mở trang "thành công" mà chưa có webhook ⇒ chưa mở quyền.

Hay sai:
- Mở hàng khi trình duyệt quay về trang "success".
- Parse JSON rồi mới kiểm chữ ký ⇒ chữ ký luôn sai, rồi "tạm tắt kiểm cho chạy".

## Gói định kỳ
Nhận ra khi: "gói tháng", "subscription", "bản Pro", "trả theo năm", "gia hạn tự động".

Hỏi user (lúc viết SPEC):
- Thẻ bị từ chối lúc gia hạn thì người dùng còn dùng được bao lâu? → khuyên: 7 ngày ân hạn kèm nhắc đổi thẻ, sau đó về gói miễn phí, không xoá dữ liệu.
- Gói khác nhau ở những giới hạn nào (số dự án, số thành viên, lượt AI)? → khuyên: 1–2 con số rõ ràng, ghi trong một bảng cấu hình.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Quyền theo gói kiểm ở server mỗi request; không tin cờ `isPro` gửi từ trình duyệt | — | — |
| Chi phí | Giới hạn gói (lượt AI, dung lượng) nối vào hạn mức chung; kiểm gói năm × mức dùng cao nhất vẫn còn lời | — | — |
| Chịu tải | Webhook qua hàng đợi — đầu kỳ gia hạn hàng loạt dồn cùng lúc | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Một nguồn sự thật: bảng `subscriptions` chỉ cập nhật từ webhook + đối soát; lưu `entitlement_until` (quyền tới ngày) và so với giờ hiện tại; mở quyền khi `invoice.paid` **và** trạng thái `active`; thu hồi khi `canceled` hoặc `unpaid`; thứ tự event không được đảm bảo ⇒ khi nhận event thì gọi API lấy trạng thái mới nhất | Bảng gói → quyền (entitlements) tách khỏi tên gói, đổi gói không sửa code | — |
| Theo dõi sự cố | Xử lý `invoice.payment_failed` (báo người dùng) và `past_due` (nhắc đổi thẻ); đối soát hằng ngày | Số liệu doanh thu tháng, tỉ lệ huỷ | — |

Bài kiểm bắt buộc:
- Event cập nhật cũ tới sau event huỷ mới ⇒ trạng thái cuối vẫn là đã huỷ.
- `entitlement_until` đã qua ⇒ API tính năng Pro từ chối, kể cả khi webhook huỷ bị mất.

Hay sai:
- `if (user.plan === 'pro')` rải khắp code ⇒ thêm gói mới là sót chỗ (thêm gói thì chạy `flow-impact`).
- Sắp thứ tự webhook theo thời điểm tạo.

## Dùng thử, nâng/hạ gói, huỷ, hoàn tiền, tranh chấp
Nhận ra khi: "dùng thử 7 ngày", "nâng cấp", "hạ gói", "huỷ gói", "hoàn tiền", "chargeback", "khách khiếu nại với ngân hàng".

Hỏi user (lúc viết SPEC):
- Dùng thử có phải nhập thẻ không? → khuyên: muốn nhiều người thử thì không cần thẻ; muốn ít người mà nghiêm túc thì cần thẻ.
- Hạ gói giữa kỳ có hiệu lực ngay hay cuối kỳ? → khuyên: hạ gói vào cuối kỳ (khỏi hoàn tiền lẻ); nâng gói có hiệu lực ngay, trả phần chênh.
- Huỷ gói mà dữ liệu vượt giới hạn gói miễn phí thì sao? → khuyên: giữ nguyên dữ liệu, chỉ khoá tạo thêm (chỉ xem).

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Mỗi tài khoản/công ty dùng thử một lần (lưu lịch sử dùng thử theo tài khoản và email đã chuẩn hoá); nút huỷ dễ thấy (khó huỷ ⇒ khách khiếu nại ngân hàng — suy luận) | Bước chặn email dùng một lần cho đăng ký dùng thử | Nhận diện thiết bị — cần khi đo được lạm dụng dùng thử |
| Chi phí | Nghe `charge.dispute.created` và `radar.early_fraud_warning.created`: tranh chấp mất phí và tỉ lệ cao có thể bị cổng khoá tài khoản ⇒ cân nhắc chủ động hoàn tiền khi có cảnh báo gian lận sớm (suy luận) | — | — |
| Chịu tải | — | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Nghe `customer.subscription.trial_will_end` (3 ngày trước) để nhắc và kiểm có phương thức thanh toán; `charge.refunded` ⇒ thu hồi quyền/credit đã mua; tính tiền chênh khi nâng/hạ để cổng làm, không tự tính | Bảng `billing_events` lưu nguyên event để tra lại khi tranh chấp | — |
| Theo dõi sự cố | Cảnh báo ngay khi có tranh chấp (có hạn trả lời) | Tỉ lệ dùng thử → trả phí | — |

Bài kiểm bắt buộc:
- Tài khoản đã dùng thử xin dùng thử lần hai ⇒ bị từ chối.
- Nhận `charge.refunded` cho gói credit ⇒ phần credit chưa dùng bị thu hồi và ghi vào sổ cái.

Hay sai:
- Tự tính tiền chênh nâng/hạ gói trong code ⇒ lệch với hoá đơn của cổng.
- Bỏ qua event hoàn tiền/tranh chấp ⇒ khách lấy lại tiền mà vẫn giữ quyền.

## Điểm thưởng và mã giảm giá
Nhận ra khi: "mã giảm giá", "coupon", "voucher", "tích điểm", "đổi điểm lấy quà".

Hỏi user (lúc viết SPEC):
- Mỗi mã dùng được tổng bao nhiêu lần, mỗi người mấy lần? → khuyên: đặt cả tổng lượt lẫn lượt/người; mặc định 1 lần/người.
- Điểm có hết hạn, đổi ra tiền mặt được không? → khuyên: hết hạn sau 12 tháng; không đổi ra tiền (tránh thành ví điện tử, rủi ro pháp lý).

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Mã riêng cho từng người đủ dài, ngẫu nhiên (không kiểu `SALE10` đoán được); giới hạn số lần thử mã sai/người (chống dò mã); điều kiện áp mã kiểm ở server | — | — |
| Chi phí | Ngân sách tối đa mỗi chương trình (số lượt hoặc số tiền); giá sau giảm không xuống dưới 0; không cộng dồn mã trừ khi cho phép rõ | — | — |
| Chịu tải | Trừ lượt mã bằng cập nhật có điều kiện trong giao dịch (khoá cấp nghiệp vụ) ⇒ 100 người bấm cùng lúc khi mã còn 1 lượt thì chỉ 1 người được | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Sổ cái điểm (mỗi lần cộng/trừ một dòng, lý do, nguồn), không chỉ cột số dư; hoàn tiền đơn ⇒ thu hồi điểm đã tặng | Cột `expires_at` cho từng lô điểm | — |
| Theo dõi sự cố | Cảnh báo một mã bị dùng nhanh bất thường (mã lọt lên mạng) | — | — |

Bài kiểm bắt buộc:
- Mã còn 1 lượt, 10 request đồng thời ⇒ đúng 1 đơn được giảm.
- Cùng người dùng lại mã "1 lần mỗi người" ⇒ bị từ chối.

Hay sai:
- Kiểm "còn lượt" ở một bước rồi trừ ở bước khác ⇒ chạy đua, mã bị dùng vượt.
- Tính giá sau giảm ở trình duyệt.

## Giới thiệu bạn bè (referral)
Nhận ra khi: "mời bạn nhận thưởng", "giới thiệu bạn bè", "mã giới thiệu", "affiliate".

Hỏi user (lúc viết SPEC):
- Thưởng khi bạn được mời đăng ký hay khi bạn đó trả tiền? → khuyên: khi trả tiền lần đầu và đã qua hạn hoàn tiền — thưởng lúc đăng ký là bị cày bằng tài khoản ảo ngay.
- Thưởng bằng gì? → khuyên: credit hoặc tháng dùng miễn phí, không phải tiền mặt.
- Một người được thưởng tối đa bao nhiêu lần? → khuyên: có trần (vd 10 lần/năm).

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Chỉ thưởng khi người được mời trả tiền thật và qua hạn hoàn tiền; chặn tự giới thiệu (cùng email chuẩn hoá, cùng phương thức thanh toán nếu cổng cho biết); trần thưởng/người | Bước chặn email dùng một lần | Chấm điểm gian lận giới thiệu — cần khi chi thưởng thành khoản đáng kể |
| Chi phí | Ngân sách thưởng tối đa/tháng | — | — |
| Chịu tải | — | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Lưu `referred_by` ngay lúc đăng ký (gán lại sau rất khó); thưởng ghi vào sổ cái credit; hoàn tiền/tranh chấp ⇒ thu hồi thưởng | — | — |
| Theo dõi sự cố | Danh sách người giới thiệu nhiều bất thường | — | — |

Bài kiểm bắt buộc:
- Người được mời hoàn tiền trong hạn ⇒ người mời không nhận thưởng.
- Dùng mã của chính mình bằng email thứ hai cùng phương thức thanh toán ⇒ không thưởng.

Hay sai:
- Thưởng ngay khi đăng ký ⇒ bot tạo hàng nghìn tài khoản.
- Trả hoa hồng bằng tiền mặt tự chuyển khoản ⇒ thành nghĩa vụ trả tiền và thuế; muốn affiliate thì dùng chương trình có sẵn của cổng thanh toán (suy luận).

## Khoá bản quyền cho app máy tính và extension trả phí
Nhận ra khi: "license key", "kích hoạt bản quyền", "bán app máy tính", "extension trả phí", "giới hạn số máy".

Hỏi user (lúc viết SPEC):
- Một bản quyền dùng trên mấy máy? → khuyên: 3 máy; người dùng tự gỡ máy cũ trên trang tài khoản.
- Mất mạng thì bản trả phí còn chạy bao lâu? → khuyên: 14 ngày không mạng rồi mới đòi kiểm lại.
- Bị bẻ khoá thì sao? → khuyên: chấp nhận một phần; đừng làm phiền khách thật để chặn người vốn không bao giờ trả.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Server kích hoạt ký một "vé" (chữ ký Ed25519) ghi máy, hạn, gói; app kiểm bằng khoá công khai nhúng sẵn — khoá riêng không bao giờ nằm trong app/extension; giới hạn số máy/bản quyền và số lần kích hoạt/ngày; extension Chrome MV3 cấm tải mã từ xa ⇒ logic kiểm nằm trong gói, tính năng cần chặn chắc thì đặt ở server | Danh sách thu hồi (bản quyền đã hoàn tiền hoặc bị lộ) | Làm rối mã chống bẻ khoá — cần khi đo được mất doanh thu đáng kể |
| Chi phí | — | — | — |
| Chịu tải | App kiểm vé không cần mạng; chỉ gọi server khi kích hoạt và gia hạn vé định kỳ, không gọi mỗi lần mở | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Bảng `licenses` + `activations(license_id, machine_id, last_seen_at)`; mã máy là bản băm, không gửi thông tin cá nhân của máy; hoàn tiền/tranh chấp từ webhook ⇒ thu hồi | Gắn bản quyền với tài khoản để sau chuyển sang đăng nhập | — |
| Theo dõi sự cố | Log kích hoạt; cảnh báo một khoá kích hoạt từ quá nhiều máy hoặc nước (khoá bị đăng lên mạng) | — | — |

Bài kiểm bắt buộc:
- Sửa tay một byte trong vé ⇒ app từ chối.
- Kích hoạt máy thứ 4 khi giới hạn 3 ⇒ bị từ chối, kèm hướng dẫn gỡ máy cũ.
- Hoàn tiền ⇒ lần gia hạn vé kế tiếp bị từ chối.

Hay sai:
- So khoá với một chuỗi cố định trong app, hoặc nhúng khoá bí mật API vào app.
- Đòi có mạng mỗi lần mở ⇒ server sập là mọi khách đã trả tiền mất app.

## Marketplace chia tiền cho người bán (mặc định để ngoài phạm vi)
Nhận ra khi: "người bán đăng hàng", "chia tiền cho người bán", "thu hộ", "hoa hồng sàn", "Stripe Connect".

**Rủi ro pháp lý khác hẳn các mục trên:** app cầm tiền của người khác có thể thành trung gian thanh toán (giấy phép, chống rửa tiền, thuế thay người bán, ai chịu hoàn tiền). Mặc định khuyên **để ngoài phạm vi** lần này và hỏi user; đây không phải tư vấn pháp lý.

Hỏi user (lúc viết SPEC):
- App có cầm tiền của khách rồi trả lại cho người bán không? → khuyên: không — để ngoài phạm vi; bắt buộc có thì chỉ dùng dịch vụ chia tiền của cổng thanh toán (người bán tự xác minh danh tính với cổng) và hỏi luật sư/kế toán trước.
- Bản đầu có thể không chia tiền không (người bán tự nhận tiền, app thu phí đăng tin hoặc gói tháng)? → khuyên: có — đây là đường khuyên dùng.
- Khách khiếu nại hàng lỗi thì ai hoàn tiền? → khuyên: phải trả lời được trước khi làm; chưa trả lời được thì chưa làm chia tiền.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | (Chỉ khi user đã chốt làm) người bán xác minh danh tính qua cổng; giữ tiền tới khi qua hạn hoàn tiền/tranh chấp | — | Ví, rút tiền tự dựng — không làm khi chưa có giấy phép và tư vấn pháp lý |
| Chi phí | Phí cổng và tranh chấp trừ vào hoa hồng, không vào phần của app | — | — |
| Chịu tải | — | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Sổ cái tiền: mỗi bút toán một dòng, không sửa không xoá, sai thì thêm bút toán bù; giấy tờ danh tính người bán để cổng giữ, app không lưu | — | — |
| Theo dõi sự cố | Đối soát hằng ngày sổ cái của app với cổng; cảnh báo khi lệch | — | — |

Bài kiểm bắt buộc:
- Đơn hoàn tiền sau khi đã chia ⇒ sổ cái có bút toán bù, tổng khớp với cổng.
- Người bán chưa xác minh ⇒ không nhận được tiền chuyển.

Hay sai:
- Thu tiền vào tài khoản của mình rồi chuyển khoản tay cho người bán.
- Sửa số dư người bán bằng một câu UPDATE thay vì thêm bút toán.
