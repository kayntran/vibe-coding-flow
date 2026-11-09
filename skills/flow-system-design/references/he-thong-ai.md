# Tính năng gọi model AI

Dùng ở bước 4–8 của `flow-system-design`.

## Mục lục
- Lớp gateway
- Model dự phòng và rate limit nhà cung cấp
- Trần token và chi phí
- Cache câu trả lời
- Streaming và huỷ
- Prompt: phiên bản và eval
- RAG — khi nào cần, khi nào chưa
- Agent hành động thay người dùng
- OWASP LLM Top 10 2025 thành luật thiết kế
- Khi nào CHƯA cần
- Nguồn

AI là khoản tiền đội nhanh nhất và là điểm vào người lạ lợi dụng được. Mọi luật dưới đây phục vụ ba câu: ai trả tiền mỗi lần
gọi, khi model hỏng thì người dùng thấy gì, model có làm được việc gì nguy hiểm không.

## Lớp gateway

Mọi lời gọi model đi qua **một chỗ** — không gọi SDK nhà cung cấp rải rác trong code.
- Cách 1: Cloudflare AI Gateway (cổng trung gian đứng trước nhà cung cấp): có rate limit sẵn (vượt thì trả 429), một chỗ xem log.
- Cách 2: một hàm bọc trong app (`callModel(task, input, userId)`): kiểm trần, chọn model, ghi số token, đo thời gian, gọi dự phòng.
- Mặc định kit: hàm bọc **và** (nếu dùng Workers) đặt AI Gateway phía sau. Hàm bọc là "chừa chỗ" rẻ nhất: đổi nhà cung cấp,
  thêm cache, thêm trần chỉ sửa một file.
- Ghi mỗi lần gọi: `userId`, `tenantId`, `task`, model, token vào/ra, chi phí ước tính, ms, kết quả. Không ghi nguyên prompt
  có dữ liệu riêng.

## Model dự phòng và rate limit nhà cung cấp

- Nhà cung cấp có giới hạn request/phút và token/phút theo tài khoản; vượt ⇒ 429. Đây là trần **chung cho mọi người dùng**
  của app ⇒ một người spam làm cả app "tạm bận".
- Chuỗi dự phòng: model chính → model rẻ/khác nhà cung cấp → thông báo "tạm bận, thử lại sau 1 phút". Ghi rõ trong DESIGN.md
  model dự phòng kém hơn ở đâu (chất lượng, ngôn ngữ).
- Chỉ chuyển dự phòng với lỗi tạm (429, 5xx, timeout); lỗi nội dung bị từ chối thì không đổi model để "lách".
- Rate limit của mình đặt **thấp hơn** trần nhà cung cấp và theo từng người dùng, để không ai một mình chạm trần chung.
- Tính năng nền gọi AI hàng loạt (tóm tắt mọi tài liệu) đi qua queue với tốc độ cố định, không bắn song song tối đa.

## Trần token và chi phí

- **Làm ngay:** trần theo người dùng/ngày (số lần gọi và token hoặc tiền), trần toàn app/ngày; chạm trần ⇒ ngừng, báo rõ
  "Hết lượt hôm nay", không âm thầm tiêu tiếp. Kiểm ở server, đếm nguyên tử (hai request đồng thời không lọt quá trần).
- Trần cỡ đầu vào (ký tự/token, số file đính kèm) và `max_tokens` đầu ra cho mỗi `task`.
- Ước lượng phí tháng: người dùng hoạt động/ngày × lượt gọi/người × (token vào × giá vào + token ra × giá ra) × 30. Giá: tra bảng
  số liệu có ngày hoặc trang nhà cung cấp, ghi ngày tra.
- Khách vãng lai/không đăng nhập: không gọi AI, hoặc trần rất thấp + Turnstile (chống bot).
- Hỏi user: "Một người dùng miễn phí được hỏi AI bao nhiêu lần một ngày?" → khuyên: 20 lần, gói trả tiền nhiều hơn.

## Cache câu trả lời

- Cần khi cùng một đầu vào lặp lại nhiều (tóm tắt cùng một bài, câu hỏi FAQ, dịch cùng đoạn). Khoá cache = băm của
  (model, phiên bản prompt, đầu vào đã chuẩn hoá); có tenant ID nếu nội dung riêng.
- CHƯA cần khi mỗi đầu vào gần như duy nhất (chat cá nhân) — tỉ lệ trúng thấp, chỉ thêm rủi ro lộ chéo.
- Đổi phiên bản prompt ⇒ khoá cache đổi theo. Không cache câu trả lời có dữ liệu người khác.
- Cache theo nghĩa (so gần giống bằng embedding): chưa cần ở MVP (kinh nghiệm).

## Streaming và huỷ

- Câu trả lời dài hơn vài giây ⇒ streaming (trả dần từng phần) để người dùng thấy chữ chạy, không tưởng app treo.
- Có nút **Dừng**; người dùng đóng tab/huỷ ⇒ ngắt lời gọi tới nhà cung cấp để không trả tiền phần không ai đọc.
- Đếm token của phần đã stream cả khi bị huỷ.
- Việc chạy quá lâu cho một request (tạo báo cáo dài) ⇒ chuyển sang việc nền + báo khi xong, không giữ kết nối.
- Workers: kết nối dài tính theo thời gian chạy, xem giới hạn CPU/thời gian trong bảng số liệu có ngày.

## Prompt: phiên bản và eval

- Prompt là code: nằm trong git, mỗi `task` một prompt có `version`; log mỗi lần gọi ghi `version` đã dùng.
- Đổi prompt hoặc đổi model = phát hành: chạy bộ eval trước.
- Eval (bộ đề kiểm chất lượng): 20–50 đầu vào thật đã ẩn danh + kết quả mong đợi hoặc tiêu chí chấm; gồm ca khó, ca tiếng Việt,
  ca cố tình lừa. Chạy mỗi lần đổi prompt/model; giữ điểm của bản trước để so (con số là kinh nghiệm).
- Đầu ra máy đọc ⇒ yêu cầu định dạng có cấu trúc (JSON theo schema) và **kiểm lại** ở server; sai ⇒ thử lại một lần rồi báo lỗi.

## RAG — khi nào cần, khi nào chưa

RAG (tìm đoạn tài liệu liên quan rồi đưa vào prompt để model trả lời theo tài liệu của mình).
- Chưa cần: tài liệu ngắn vừa một prompt (vài chục trang) ⇒ đưa thẳng vào, có cache prompt nếu nhà cung cấp hỗ trợ; hoặc tìm
  từ khoá thường (full-text của D1/Postgres) đã đủ.
- Cần khi: kho tài liệu lớn hơn nhiều lần cửa sổ ngữ cảnh, cập nhật thường xuyên, cần trích nguồn.
- Thành phần: chia nhỏ (chunk — cắt tài liệu thành đoạn vài trăm token, có chồng lấn nhẹ) → embedding (biến đoạn văn thành
  dãy số để so độ gần nghĩa) → vector DB (kho tìm theo độ gần; trên stack kit: Cloudflare Vectorize hoặc pgvector trong Supabase).
- Luật: mỗi đoạn mang `tenantId` và quyền đọc; lọc quyền **trước** khi đưa vào prompt (LLM08 — điểm yếu vector/embedding).
  Xoá tài liệu ⇒ xoá cả vector. Ghi phiên bản model embedding — đổi model là phải tạo lại toàn bộ vector.

## Agent hành động thay người dùng

Agent (AI được gọi công cụ: gửi email, sửa dữ liệu, mua hàng) khác hẳn AI chỉ trả lời chữ.
- Quyền tối thiểu: mỗi công cụ chỉ làm đúng một việc, trong phạm vi người dùng đang đăng nhập; không đưa khoá quản trị cho agent.
- Kiểm quyền ở **công cụ** (server), không tin model đã tự kiểm.
- Việc không quay lại được (xoá, gửi ra ngoài, tiêu tiền, đổi quyền) ⇒ hiện bản xem trước, người dùng bấm xác nhận nêu tên đối tượng.
- Trần số bước mỗi lượt, trần tiền mỗi lượt; nhật ký mọi lần gọi công cụ.
- Hỏi user: "AI có được tự gửi email cho khách mà không hỏi bạn không?" → khuyên: không, luôn hỏi trước khi gửi.

## OWASP LLM Top 10 2025 thành luật thiết kế

| Mục | Luật |
|---|---|
| LLM01 Prompt injection (chèn lệnh qua dữ liệu đầu vào) | Coi nội dung người dùng, trang web, tài liệu là dữ liệu không đáng tin; không để chúng mở khoá công cụ hay quyền |
| LLM02 Lộ thông tin nhạy cảm | Chỉ đưa vào prompt dữ liệu người đang hỏi được xem; không đưa khoá, dữ liệu tenant khác |
| LLM05 Xử lý đầu ra sai | Đầu ra model không đi thẳng vào SQL, HTML, lệnh hệ thống, URL; kiểm schema, escape khi hiển thị |
| LLM06 Quyền hành động quá mức | Quyền tối thiểu, xác nhận trước việc không quay lại (mục Agent ở trên) |
| LLM10 Tiêu thụ không giới hạn | Trần token, trần tiền theo người dùng và toàn app, rate limit, timeout |

## Khi nào CHƯA cần

- Nhiều nhà cung cấp chạy song song, định tuyến theo giá: tới khi phí AI là khoản lớn nhất và có eval để so.
- Tự host model: tới khi có lý do riêng tư/hợp đồng hoặc khối lượng đủ lớn để rẻ hơn — kèm người vận hành GPU.
- Fine-tune: tới khi prompt + ví dụ + eval đã hết cải thiện.
- Vector DB, agent nhiều bước: tới khi SPEC thật cần (xem RAG và Agent ở trên).

## Nguồn

- https://genai.owasp.org/llm-top-10/
- https://developers.cloudflare.com/ai-gateway/configuration/rate-limiting/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://api-security.owasp.org/editions/2023/en/0x11-t10 (API4 tiêu thụ không giới hạn)
- https://github.com/wendelandrady/production-saas-readiness (hạn mức thi hành ở server kể cả request đồng thời)
- Chưa có nguồn trong bộ nghiên cứu: model dự phòng, cache câu trả lời, streaming và huỷ, phiên bản prompt, cỡ bộ eval,
  cỡ chunk, Vectorize/pgvector, rate limit cụ thể của từng nhà cung cấp AI.
