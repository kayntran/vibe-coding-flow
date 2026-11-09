# Bản mẫu: tài khoản, đăng nhập và quyền

Dùng ở bước 4 của `flow-system-design` (bản mẫu theo loại tính năng), câu hỏi hành vi đem hỏi lúc `flow-spec`.

## Mục lục
- Đăng ký và đăng nhập bằng mật khẩu
- Quên và đổi mật khẩu
- Đổi email hoặc số điện thoại
- Đăng nhập không mật khẩu (magic link, mã email, passkey)
- Đăng nhập Google và OAuth
- Xác thực 2 lớp
- Phiên và thiết bị
- Vai trò và phân quyền
- Nhiều công ty dùng chung một app (multi-tenant)
- Mời thành viên và chia sẻ bằng link
- Xoá tài khoản và xuất dữ liệu
- API key cá nhân của người dùng

Số mặc định trong bảng (5 lần, 15 phút, 90 ngày…) là kinh nghiệm, không phải số đo — chỉnh theo app. Giá, hạn mức gói: tra bảng số liệu có ngày.

## Đăng ký và đăng nhập bằng mật khẩu
Nhận ra khi: "đăng ký", "đăng nhập", "tạo tài khoản", "login", "mỗi người một tài khoản".

Hỏi user (lúc viết SPEC):
- Ai cũng tự đăng ký được, hay chỉ người bạn mời? → khuyên: app cho công chúng thì tự đăng ký; app nội bộ thì chỉ người được mời (bớt hẳn spam đăng ký).
- Người mới phải bấm link xác nhận email rồi mới dùng, hay dùng ngay? → khuyên: xem và thử ngay, nhưng việc tốn tiền (gọi AI, gửi SMS, tải file lớn) chỉ mở sau khi xác nhận email.
- Đăng nhập sai nhiều lần thì app nên làm gì? → khuyên: chậm dần rồi bắt chờ vài phút, gửi email báo chủ tài khoản; không khoá cứng tới khi admin mở.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Giới hạn lần thử theo IP **và** theo tài khoản, cả cửa sổ ngắn lẫn dài; tăng dần độ trễ hoặc khoá tạm tự gỡ, luôn còn đường vào qua quên mật khẩu (kẻ xấu không khoá được người khác); cùng một câu báo, mã trạng thái, thời gian phản hồi cho sai mật khẩu / không có tài khoản / email đã đăng ký (chống dò tài khoản); mật khẩu ≥ 15 ký tự khi chưa có 2 lớp (≥ 8 khi có), cho dài ít nhất 64, cho dán, không ép ký hiệu, kiểm với danh sách mật khẩu lộ | Một hàm kiểm nghi ngờ đứng trước bước xác minh để sau gắn Turnstile (ô "tôi không phải robot" của Cloudflare) chỉ hiện khi nghi ngờ; bước kiểm tên miền email để sau chặn email dùng một lần; bảng `identities` tách khỏi `users` để sau thêm Google, passkey, 2 lớp | Chấm điểm rủi ro thiết bị, hệ chống gian lận riêng — cần khi log thấy đợt dò mật khẩu thật (hàng nghìn lần sai/giờ từ nhiều IP) |
| Chi phí | Email xác nhận đi qua cùng giới hạn (gửi lại tối đa vài lần/giờ cho một địa chỉ); việc tốn tiền khoá tới khi email được xác nhận | — | — |
| Chịu tải | Dùng thư viện đăng nhập có sẵn (Supabase Auth khi dùng Supabase) thay vì tự viết; tự băm trên Workers thì Argon2id/scrypt tốn CPU, đối chiếu trần CPU mỗi request của gói | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Băm bằng Argon2id (không có thì scrypt; bcrypt chỉ cho hệ cũ), không lưu hay ghi log mật khẩu thô; khoá người dùng là ID nội bộ, email chỉ là thuộc tính | Cột `email_verified_at`, `deleted_at` từ migration đầu | — |
| Theo dõi sự cố | Log có cấu trúc mỗi lần đăng nhập thành/bại (ai, IP, kết quả — không có mật khẩu) | Bộ đếm tỉ lệ đăng nhập sai/giờ để sau gắn cảnh báo | Bảng điều khiển riêng — cần khi vài nghìn lượt đăng nhập/ngày |

Bài kiểm bắt buộc:
- Sai mật khẩu lần thứ 6 trong 15 phút cho cùng tài khoản, mỗi lần một IP khác ⇒ bị từ chối hoặc bắt chờ; chủ tài khoản vẫn đặt lại mật khẩu được.
- Đăng nhập bằng email không tồn tại và bằng email thật sai mật khẩu ⇒ thân phản hồi và mã trạng thái giống hệt.
- Đăng ký với một mật khẩu có trong danh sách lộ ⇒ bị từ chối.

Hay sai:
- Tự băm bằng SHA-256/MD5 hoặc lưu thô "tạm thời".
- Chỉ đếm theo IP (kẻ dò xoay hàng nghìn IP vẫn lọt), hoặc khoá cứng vĩnh viễn (kẻ xấu cố tình khoá người khác).

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html · https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md · https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html

## Quên và đổi mật khẩu
Nhận ra khi: "quên mật khẩu", "đặt lại mật khẩu", "đổi mật khẩu", "reset password".

Hỏi user (lúc viết SPEC):
- Đặt lại mật khẩu xong, các máy khác đang đăng nhập có bị đăng xuất không? → khuyên: có, đăng xuất hết trừ máy vừa đặt lại, kèm email báo.
- Link đặt lại dùng được bao lâu? → khuyên: 30 phút, dùng một lần.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Câu báo và thời gian phản hồi giống nhau dù email có tài khoản hay không ("nếu email có tài khoản, bạn sẽ nhận link"); giới hạn số lần xin link theo email và theo IP; không khoá hay sửa gì trên tài khoản cho tới khi có token hợp lệ; đặt lại qua link thì token hợp lệ thay cho mật khẩu cũ (không hỏi mật khẩu cũ); chỉ khi đã đăng nhập và tự đổi mật khẩu mới phải nhập mật khẩu cũ; không dùng câu hỏi bảo mật | Móc Turnstile ở form quên mật khẩu, bật khi bị ngập | — |
| Chi phí | Giới hạn trên cũng là trần hoá đơn email/SMS khi bị bơm yêu cầu | — | — |
| Chịu tải | Gửi email qua hàng đợi để thời gian phản hồi không lộ email có thật hay không | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Token từ bộ sinh ngẫu nhiên an toàn, đủ dài, gắn một người dùng; chỉ lưu bản băm; hạn ngắn, dùng một lần; không để token lọt vào log hay công cụ phân tích (URL hay bị ghi log) | Bảng `password_reset_tokens` riêng có `expires_at`, `used_at` thay vì một cột trên `users` | — |
| Theo dõi sự cố | Log sự kiện "đã đặt lại mật khẩu"; email báo chủ tài khoản (không kèm mật khẩu) | Bộ đếm số yêu cầu reset/giờ | Cảnh báo tự động — cần khi số yêu cầu/giờ gấp nhiều lần ngày thường |

Bài kiểm bắt buộc:
- Dùng lại link đặt lại lần thứ hai, hoặc link quá hạn ⇒ bị từ chối; link hợp lệ ⇒ đặt được mật khẩu mới mà không cần mật khẩu cũ.
- Đặt lại mật khẩu ⇒ phiên cũ trên máy khác gọi API bị 401.
- Xin reset cho email không tồn tại ⇒ phản hồi giống hệt email thật, không có email nào được gửi.

Hay sai:
- Báo "email này chưa đăng ký" ⇒ kẻ xấu dò ra danh sách khách hàng.
- Lưu token thô trong DB, hoặc token đoán được (dựa thời gian, ID tăng dần).

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html · https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md · https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html

## Đổi email hoặc số điện thoại
Nhận ra khi: "đổi email", "đổi số điện thoại", "cập nhật thông tin liên hệ".

Hỏi user (lúc viết SPEC):
- Đổi email có phải xác nhận ở email mới và báo về email cũ không? → khuyên: có cả hai; thư về email cũ kèm nút "không phải tôi".
- Sau khi đổi, chủ cũ còn kêu "không phải tôi" được bao lâu? → khuyên: 7 ngày; bấm trong thời gian này thì hoàn tác và khoá phiên lạ.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Bắt nhập lại mật khẩu (hoặc 2 lớp) trước khi đổi — đây là đường chiếm tài khoản; email/số mới chỉ có hiệu lực sau khi xác nhận; báo về địa chỉ cũ; giới hạn số lần đổi/ngày | Trạng thái chờ (`pending_email`) riêng, không ghi đè `email` tới khi xác nhận | Hỗ trợ duyệt tay — cần khi đã có ca chiếm tài khoản thật |
| Chi phí | Đổi số điện thoại gửi mã SMS ⇒ áp đúng giới hạn của loại SMS/OTP (bước 4 trong SKILL.md, nhóm gửi đi) | — | — |
| Chịu tải | — | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Email mới đã thuộc tài khoản khác thì câu báo vẫn chung chung ("đã gửi link xác nhận"); giữ lịch sử đổi để hoàn tác | Bảng `contact_changes` (cũ, mới, lúc nào, hoàn tác chưa) | — |
| Theo dõi sự cố | Log audit mỗi lần đổi (ai, IP, giá trị đã che bớt) | — | — |

Bài kiểm bắt buộc:
- Gọi API đổi email không kèm mật khẩu hiện tại ⇒ bị từ chối.
- Đổi email, chưa bấm link xác nhận ⇒ đăng nhập bằng email mới thất bại, email cũ vẫn dùng được và đã nhận thư báo.

Hay sai:
- Ghi đè email ngay khi gõ ⇒ gõ nhầm là mất tài khoản; kẻ có phiên tạm chiếm luôn.
- Dùng email làm khoá liên kết giữa các bảng ⇒ đổi email là vỡ dữ liệu.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html (thời gian chờ hoàn tác là suy luận)

## Đăng nhập không mật khẩu (magic link, mã email, passkey)
Nhận ra khi: "magic link", "đăng nhập bằng mã gửi email", "không cần mật khẩu", "passkey", "vân tay", "Face ID".

Hỏi user (lúc viết SPEC):
- Người dùng vào từ máy riêng hay máy dùng chung (máy công ty, quán net)? → khuyên: máy riêng ⇒ passkey, mã email làm dự phòng; máy chung ⇒ mã 6 số qua email, phiên ngắn.
- Mở thư trên điện thoại trong khi đang đăng nhập trên máy tính thì sao? → khuyên: gửi mã 6 số để gõ tay (kèm link), để đăng nhập đúng máy đang chờ.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Giới hạn số lần gửi mã/link theo email và theo IP; giới hạn lần nhập sai (5 lần thì huỷ mã); hạn 10–15 phút, dùng một lần; câu báo giống nhau dù email có tài khoản hay không | Turnstile chỉ hiện khi một IP xin mã liên tục | — |
| Chi phí | Mỗi lần đăng nhập là một email ⇒ cộng vào ước lượng email tháng ở bước 3; không lấy SMS làm mặc định (tốn tiền mỗi tin, bị bơm) | — | — |
| Chịu tải | — | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Chỉ lưu bản băm của mã/token; passkey: lưu khoá công khai + tên thiết bị, cho một người nhiều passkey | Bảng `credentials` nhiều-một với người dùng | — |
| Theo dõi sự cố | Log gửi mã và đăng nhập; email báo khi có passkey mới được thêm | — | Theo dõi tỉ lệ thư rơi vào spam — cần khi người dùng than "không nhận được mã" |

Bài kiểm bắt buộc:
- Nhập sai mã lần thứ 6 ⇒ mã bị huỷ, mã đúng gõ sau đó cũng không vào được.
- Bấm cùng một link đăng nhập lần hai ⇒ bị từ chối.

Hay sai:
- Mã 6 số không giới hạn lần nhập ⇒ dò hết được trong vài phút.
- Đăng nhập ngay khi link được mở (GET) ⇒ bộ quét link của hộp thư công ty bấm trước làm hỏng link; nên mở trang có nút xác nhận (suy luận).

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html (chưa có nguồn riêng cho magic link/passkey)

## Đăng nhập Google và OAuth
Nhận ra khi: "đăng nhập bằng Google", "Sign in with Apple/GitHub", "SSO", "OAuth".

Hỏi user (lúc viết SPEC):
- Ai đó đã có tài khoản email + mật khẩu, sau bấm "Đăng nhập Google" cùng email thì gộp hay tách? → khuyên: gộp chỉ khi email tài khoản cũ đã xác nhận; chưa xác nhận thì bắt đăng nhập kiểu cũ trước rồi mới liên kết.
- Ai cũng vào được hay chỉ nhân viên một công ty? → khuyên: app công khai ⇒ ai cũng được; app nội bộ ⇒ chỉ đúng tổ chức Google Workspace của bạn.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Luồng authorization code + PKCE; `state`/`nonce` gắn với phiên trình duyệt; chỉ chuyển hướng về địa chỉ trong danh sách cố định, không lấy từ query; xin quyền (scope) ít nhất; không dùng implicit hay password grant | — | — |
| Chi phí | — | — | — |
| Chịu tải | Cache khoá công khai của Google theo `Cache-Control`, không tải mỗi request | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Kiểm chữ ký ID token, `aud` đúng client ID của mình, `iss`, `exp`; dùng `sub` làm định danh, không dùng email; app nội bộ kiểm `hd`, không chỉ đuôi email | Bảng `identities(provider, subject, user_id)` để thêm Apple, GitHub | SSO doanh nghiệp (SAML) — cần khi khách doanh nghiệp đòi trong hợp đồng |
| Theo dõi sự cố | Log liên kết / huỷ liên kết nhà cung cấp | — | — |

Bài kiểm bắt buộc:
- ID token có `aud` của app khác ⇒ bị từ chối.
- Callback với `state` không khớp phiên ⇒ bị từ chối.
- Tài khoản mật khẩu có email X chưa xác nhận; đăng nhập Google bằng X ⇒ không tự gộp.

Hay sai:
- Tìm người dùng theo email trả về từ Google ⇒ chiếm tài khoản qua email chưa xác nhận.
- Tự viết luồng OAuth thay vì dùng tính năng có sẵn của thư viện đăng nhập.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html · https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

## Xác thực 2 lớp
Nhận ra khi: "2FA", "xác thực hai bước", "mã từ app Authenticator", "bảo mật thêm cho admin".

Hỏi user (lúc viết SPEC):
- Bắt buộc 2 lớp cho ai? → khuyên: bắt buộc cho quản trị viên và tài khoản đụng tiền; tuỳ chọn cho người dùng thường.
- Mất điện thoại thì lấy lại tài khoản thế nào? → khuyên: 10 mã dự phòng đưa lúc bật; hết mã thì liên hệ hỗ trợ, có thời gian chờ.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Giới hạn lần nhập sai mã 2 lớp, đếm riêng với mật khẩu; hỏi lại 2 lớp trước thao tác nhạy cảm (đổi email, xoá tài khoản, rút tiền); tắt 2 lớp cũng phải qua 2 lớp | Một hàm "hỏi thêm bước" để sau bật khi thiết bị/IP lạ | Hỏi theo mức rủi ro — cần khi đã có đợt dò mật khẩu |
| Chi phí | Ưu tiên app Authenticator (TOTP — mã đổi mỗi 30 giây) hoặc passkey; SMS làm lớp 2 chỉ khi bắt buộc (tốn tiền mỗi lần, bị bơm) | — | — |
| Chịu tải | — | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Bí mật TOTP mã hoá khi lưu; mã dự phòng lưu bản băm, dùng một lần | Bảng `mfa_factors` (một người nhiều cách) | — |
| Theo dõi sự cố | Email báo khi bật/tắt 2 lớp và khi dùng mã dự phòng | — | — |

Bài kiểm bắt buộc:
- Mật khẩu đúng, chưa nhập mã 2 lớp ⇒ gọi API được bảo vệ bị từ chối (phiên "nửa chừng" không có quyền).
- Dùng một mã dự phòng lần hai ⇒ bị từ chối.

Hay sai:
- Bước 2 chỉ chặn ở giao diện, API đã mở ngay sau bước mật khẩu.
- Không có đường khôi phục ⇒ hỗ trợ tắt 2 lớp bằng tay cho ai gọi điện tới (mở cửa cho lừa đảo).

Nguồn: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md · https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html

## Phiên và thiết bị
Nhận ra khi: "đăng xuất mọi nơi", "thiết bị đang đăng nhập", "nhớ đăng nhập", "tự đăng xuất".

Hỏi user (lúc viết SPEC):
- Để yên bao lâu thì tự đăng xuất? → khuyên: app thường giữ đăng nhập 30 ngày nếu vẫn dùng; app đụng tiền/dữ liệu nhạy cảm thì 15–30 phút không dùng.
- Có cần màn "các thiết bị đang đăng nhập" không? → khuyên: có nút "đăng xuất mọi nơi" ngay; danh sách thiết bị để sau.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Cookie `Secure`, `HttpOnly`, `SameSite=Lax` trở lên, tiền tố `__Host-`; cấp ID phiên mới khi đăng nhập và khi đổi quyền; không để token trong localStorage | — | — |
| Chi phí | — | — | — |
| Chịu tải | Tra phiên mỗi request theo khoá chính (một lần đọc rẻ) | — | Cache phiên ngắn hạn trên KV — cần khi tra phiên chiếm phần lớn lượt đọc DB; cache phải ngắn để thu hồi có hiệu lực gần như ngay |
| Dữ liệu (riêng tư, xoá, sao lưu) | Phiên lưu ở server để thu hồi được; hết hạn nhàn rỗi + hết hạn tuyệt đối do server thi hành; đăng xuất là xoá phiên ở server | Cột `user_agent`, `ip`, `last_seen_at` trên `sessions` để sau dựng màn thiết bị | Lịch sử đăng nhập đầy đủ — cần khi có khách doanh nghiệp hoặc ca chiếm tài khoản |
| Theo dõi sự cố | Log tạo/thu hồi phiên; việc hẹn giờ dọn phiên hết hạn | — | — |

Bài kiểm bắt buộc:
- Bấm "đăng xuất mọi nơi" ⇒ cookie cũ chép sang máy khác gọi API bị 401.
- Đăng nhập ⇒ ID phiên sau khác ID phiên trước khi đăng nhập.

Hay sai:
- Đăng xuất chỉ xoá cookie ở trình duyệt, phiên ở server vẫn sống.
- Token tự chứa (JWT) sống nhiều ngày, không có cách thu hồi; dùng loại này thì để hạn ngắn + token làm mới thu hồi được (suy luận).

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html

## Vai trò và phân quyền
Nhận ra khi: "admin", "quản lý", "nhân viên chỉ được xem", "phân quyền", "vai trò".

Hỏi user (lúc viết SPEC):
- Có mấy loại người dùng, mỗi loại được làm gì? → khuyên: bắt đầu 2–3 vai cố định (chủ, thành viên, chỉ xem); vai tự định nghĩa để sau.
- Một người có thể là chủ ở nhóm này, thành viên ở nhóm khác không? → khuyên: có nếu app có nhóm — vai gắn với cặp (người, nhóm), không gắn với người.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Kiểm quyền ở server trên mọi API và mọi đối tượng (đọc, sửa, xoá, xuất), không chỉ ẩn nút; danh sách trường được sửa (allow-list) — gửi thêm `role: "admin"` phải bị bỏ qua; danh tính lấy từ phiên, không từ ID trong URL/body; không có tài khoản admin mặc định | Một hàm kiểm quyền duy nhất (người, việc, đối tượng) mọi chỗ cùng gọi | Quyền theo từng trường, vai tự tạo — cần khi khách đòi quá 3 vai |
| Chi phí | — | — | — |
| Chịu tải | Index cột mà điều kiện quyền/RLS lọc; Supabase: viết `(select auth.uid())` để không tính lại mỗi hàng | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Supabase: bật RLS (quyền theo hàng ngay trong DB) mọi bảng, policy riêng từng thao tác, khoá `service_role` chỉ ở server, view đặt `security_invoker = true`; D1/VPS: mọi truy vấn đi qua lớp dữ liệu có điều kiện chủ sở hữu | Bảng `memberships(user_id, org_id, role)` thay vì cột `role` trên `users` | — |
| Theo dõi sự cố | Log audit đổi vai và thao tác admin; log các lần bị từ chối quyền | Cảnh báo một tài khoản bị từ chối liên tục (đang dò ID) | — |

Bài kiểm bắt buộc:
- Tài khoản A gọi xem/sửa/xoá tài nguyên của B bằng ID thật ⇒ 403 hoặc 404 (test bằng hai tài khoản thật).
- Gửi thêm `role` hoặc `is_admin` khi sửa hồ sơ ⇒ giá trị trong DB không đổi.
- Tài khoản "chỉ xem" gọi API sửa ⇒ bị từ chối.

Hay sai:
- Chỉ ẩn nút trên giao diện, API vẫn nhận lệnh.
- Tin ID khó đoán (UUID) thay cho kiểm quyền — link lộ là lộ dữ liệu.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html · https://api-security.owasp.org/editions/2023/en/0x11-t10 · https://supabase.com/docs/guides/database/postgres/row-level-security

## Nhiều công ty dùng chung một app (multi-tenant)
Nhận ra khi: "nhiều công ty cùng dùng", "mỗi khách một không gian riêng", "workspace", "tổ chức", "SaaS cho doanh nghiệp".

Hỏi user (lúc viết SPEC):
- Một người có thể thuộc nhiều công ty không? → khuyên: có (kế toán dịch vụ, người tư vấn) — làm từ đầu rẻ hơn sửa sau nhiều lần.
- Khách lớn có đòi dữ liệu nằm riêng (DB riêng, vùng riêng) không? → khuyên: chưa; dùng chung một DB có cột công ty, đưa "DB riêng" vào lộ trình.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Mã công ty (tenant ID) lấy từ phiên đã xác minh ở server và kiểm người dùng thật sự thuộc công ty đó; không bao giờ tin mã công ty gửi từ trình duyệt | Cột `plan`, giới hạn theo công ty | Giới hạn tài nguyên theo công ty (đồng thời, hàng đợi riêng) — cần khi một công ty làm chậm công ty khác |
| Chi phí | Ghi mức dùng (AI, email, lưu trữ) theo công ty để biết công ty nào lỗ | — | Giới hạn tần suất theo gói — cần khi có nhiều gói trả phí |
| Chịu tải | Index bắt đầu bằng `tenant_id` cho truy vấn chính | — | Tách DB theo công ty (D1 cho nhiều DB nhỏ) — cần khi một DB gần trần dung lượng hoặc khách đòi tách |
| Dữ liệu (riêng tư, xoá, sao lưu) | Cột `tenant_id` trên mọi bảng thuộc công ty ngay từ migration đầu; Postgres/Supabase: bật và ép RLS, role chạy request không phải superuser/BYPASSRLS, đặt ngữ cảnh công ty theo từng giao dịch (pool kết nối không mang sang request khác); mọi khoá cache có tenant ID | Xoá/xuất theo công ty bằng một điều kiện `tenant_id` | — |
| Theo dõi sự cố | Mọi log có công ty + người thực hiện | Cảnh báo truy cập chéo công ty | — |

Bài kiểm bắt buộc:
- Người công ty A gọi API với ID bản ghi của B, và với tham số công ty = B ⇒ bị từ chối; test chạy bằng đúng role DB của app thật, không phải role quản trị.
- Hai công ty đọc cùng một trang có cache ⇒ mỗi bên chỉ thấy dữ liệu của mình.

Hay sai:
- Thêm `tenant_id` khi đã có dữ liệu ⇒ phải gán lại mọi hàng, dễ sót hàng lộ.
- Test RLS bằng tài khoản quản trị (bỏ qua RLS) ⇒ test xanh mà bản thật lộ.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html · https://supabase.com/docs/guides/database/postgres/row-level-security · https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html

## Mời thành viên và chia sẻ bằng link
Nhận ra khi: "mời đồng nghiệp", "thêm thành viên", "chia sẻ link", "ai có link đều xem được".

Hỏi user (lúc viết SPEC):
- Link chia sẻ có hết hạn không, chủ có thu hồi được không? → khuyên: hạn tuỳ chọn, luôn có nút thu hồi.
- Lời mời chỉ đúng email được mời dùng, hay ai cầm link cũng vào? → khuyên: lời mời thành viên gắn đúng email; link "ai có link" chỉ cho xem.
- Mỗi người mời được bao nhiêu người/ngày? → khuyên: 20–50/ngày ở gói miễn phí, để tính năng mời không thành công cụ gửi spam.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Giới hạn số lời mời/người/ngày; thư mời không cho người mời tự viết nội dung tuỳ ý (kẻ xấu mượn tên miền của bạn gửi thư lừa đảo); token mời ngẫu nhiên, dùng một lần, có hạn | — | Duyệt nội dung mời — cần khi bị báo spam |
| Chi phí | Mỗi lời mời là một email ⇒ nằm trong giới hạn email | — | — |
| Chịu tải | — | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Link chia sẻ là token ngẫu nhiên riêng, không phải ID bản ghi; lưu bản băm; vẫn kiểm token mỗi lần mở (link lộ thì thu hồi được) | Bảng `share_links` có `permission`, `expires_at`, `revoked_at` | Link có mật khẩu — cần khi khách hỏi |
| Theo dõi sự cố | Log ai tạo/thu hồi link | Đếm lượt mở mỗi link | — |

Bài kiểm bắt buộc:
- Thu hồi link ⇒ mở lại bị từ chối ngay.
- Lời mời gửi cho a@x, người đang đăng nhập b@y bấm ⇒ bị từ chối.
- Mời người thứ 51 trong ngày ⇒ bị từ chối, không gửi email.

Hay sai:
- Link chia sẻ chứa ID tăng dần ⇒ đoán được mọi tài liệu.
- Token mời không hạn, dùng nhiều lần ⇒ link bị chuyển tiếp là ai cũng vào nhóm.

Nguồn: https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html · https://api-security.owasp.org/editions/2023/en/0x11-t10 · https://github.com/wendelandrady/production-saas-readiness (thứ cấp; phần thư mời bị mượn gửi lừa đảo là suy luận)

## Xoá tài khoản và xuất dữ liệu
Nhận ra khi: "xoá tài khoản", "tải dữ liệu của tôi", "GDPR", "quyền riêng tư".

Hỏi user (lúc viết SPEC):
- Bấm xoá tài khoản thì xoá ngay hay chờ? → khuyên: chờ 14–30 ngày (đăng nhập lại là huỷ xoá) rồi xoá hẳn; ghi rõ ngày trên màn xác nhận.
- Thứ người đó đã góp vào nhóm (bình luận, tài liệu chung) thì sao? → khuyên: dữ liệu chung ở lại với tên "Người dùng đã xoá"; dữ liệu riêng xoá hẳn.
- Có hoá đơn/giao dịch phải giữ theo luật kế toán không? → khuyên: có thì giữ bản tối thiểu, tách khỏi thông tin cá nhân khác; hỏi kế toán (đây không phải tư vấn pháp lý).

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Nhập lại mật khẩu/2 lớp trước khi xoá hoặc xuất; giới hạn số lần xuất/ngày | — | — |
| Chi phí | — | — | — |
| Chịu tải | Xuất chạy nền qua hàng đợi, xong gửi link tải có hạn ngắn | — | — |
| Dữ liệu (riêng tư, xoá, sao lưu) | Ghi trong DESIGN.md danh sách mọi nơi chứa dữ liệu người dùng (bảng, file trên R2/Storage, log, dịch vụ ngoài như email, thanh toán); xoá cả file đã tải lên; bản sao lưu và D1 Time Travel tự hết hạn theo thời gian giữ — ghi rõ trong chính sách; file xuất chỉ có dữ liệu của chính người đó | Cột `deleted_at` + việc hẹn giờ xoá hẳn sau thời gian chờ; khoá ngoại có quy tắc xoá rõ ràng | Công cụ duyệt yêu cầu xoá thủ công — cần khi nhiều yêu cầu/tháng |
| Theo dõi sự cố | Log audit "đã xoá tài khoản lúc …" không giữ dữ liệu cá nhân; log mỗi lần xuất | — | — |

Bài kiểm bắt buộc:
- Xoá tài khoản, qua thời gian chờ ⇒ không còn hàng nào mang `user_id` đó trong bảng cá nhân, file của họ trên kho file không còn.
- File xuất CSV: ô bắt đầu bằng `=`, `+`, `-`, `@` đã được vô hiệu (không thành công thức Excel).

Hay sai:
- Chỉ đặt `deleted_at`, quên file đã tải lên và bản ở dịch vụ ngoài.
- Xoá cứng ngay làm vỡ dữ liệu chung của nhóm.

Nguồn: https://gdpr-info.eu/art-17-gdpr/ · https://github.com/OWASP/ASVS/blob/master/5.0/en/0x23-V14-Data-Protection.md · https://community.owasp.org/attacks/CSV_Injection · https://developers.cloudflare.com/d1/reference/time-travel/ (quyền xuất dữ liệu GDPR Điều 20 chưa có nguồn)

## API key cá nhân của người dùng
Nhận ra khi: "API key", "token cá nhân", "cho người dùng gọi API", "kết nối Zapier", "gọi từ script".

Hỏi user (lúc viết SPEC):
- Key có toàn quyền như chủ tài khoản hay chỉ một phần? → khuyên: cho chọn "chỉ đọc" hoặc "đọc và ghi" khi tạo.
- Key có hết hạn không? → khuyên: mặc định 90 ngày; cho chọn "không hết hạn" kèm cảnh báo.

| Mặt | Làm ngay | Chừa chỗ | Chưa làm (cần khi…) |
|---|---|---|---|
| Lạm dụng/spam | Giới hạn tần suất theo key, riêng với đăng nhập giao diện; key vẫn qua kiểm quyền theo công ty như người dùng | Cột `scopes` (phạm vi) trên key | Chỉ cho gọi từ IP đăng ký — cần khi khách doanh nghiệp đòi |
| Chi phí | Việc tốn tiền gọi bằng key ăn cùng hạn mức/credit của chủ, không có đường vòng không giới hạn | — | — |
| Chịu tải | Tra key theo bản băm có index (một lần đọc/request) | — | Cache tra key — cần khi lượt gọi API chiếm phần lớn lượt đọc DB |
| Dữ liệu (riêng tư, xoá, sao lưu) | Sinh ngẫu nhiên đủ dài, có tiền tố nhận diện (vd `myapp_live_`) để máy quét khoá lộ bắt được; chỉ hiện một lần; lưu bản băm + 4 ký tự cuối; gắn người dùng và công ty; thu hồi được | Cột `expires_at`, `last_used_at` | — |
| Theo dõi sự cố | Log mỗi key: lần dùng cuối, số lần bị từ chối quyền; email khi có key mới | Cảnh báo key bỏ không 90 ngày | — |

Bài kiểm bắt buộc:
- Thu hồi key ⇒ lần gọi kế tiếp bị 401.
- Tìm chuỗi key thô trong DB và log ⇒ không thấy.
- Key "chỉ đọc" gọi API ghi ⇒ 403.

Hay sai:
- Lưu key thô để "hiện lại cho người dùng".
- Bỏ kiểm quyền theo công ty vì "máy gọi thì tin được"; key lộ thì xử lý theo `flow-key-leak`.

Nguồn: https://github.com/wendelandrady/production-saas-readiness (thứ cấp) · https://api-security.owasp.org/editions/2023/en/0x11-t10 · https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html (tiền tố nhận diện là suy luận)
