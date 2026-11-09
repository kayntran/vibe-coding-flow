# Gom lần báo xong — tiết kiệm token

Mỗi lần worker/lệnh nền báo xong, phiên chính thức dậy và gửi lại CẢ ngữ cảnh
(đo 2026-10-13 trên kit: 53% lần thức là do báo xong, tốn ~64% chi phí phiên chính; ngữ cảnh lúc thức trung vị ~400k):
- **≥3 việc độc lập chỉ cần kết quả cuối** (test nhiều nền, nhiều lượt review độc lập trên CÙNG một diff đã xanh,
  research nhiều góc, quét nhiều file, nhiều làn code độc lập) ⇒ chạy bằng tool `Workflow`: cả đợt chỉ báo MỘT lần.
  Tool `Workflow` chỉ chạy khi chính user nói rõ "dùng workflow" ⇒ trước đợt đó hỏi user MỘT câu (AskUserQuestion: số
  agent, việc gì, ước "đỡ ~N lượt đọc lại ngữ cảnh"); user đã nói "dùng workflow" trong lượt này thì khỏi hỏi. Không thấy
  tool `Workflow` (cài đặt `enableWorkflows` tắt) ⇒ nói user một dòng, không lặng lẽ giao từng việc. Việc sửa code dùng
  `isolation: 'worktree'` + `agentType: 'coder'` cho từng làn, trả receipt qua `schema`; giữ ≤4 agent viết code cùng lúc
  như trên (đã đo 2026-10-13: 5 làn code một Workflow vẫn chạy được, mỗi làn một worktree). KHÔNG gom các
  bước có thứ tự cổng (test xanh → QA → user duyệt giao diện → review) vào một Workflow, và không dùng Workflow khi giữa
  chừng cần captain quyết hoặc hỏi user (Workflow không nhận ý kiến giữa chừng) — tách thành nhiều Workflow theo chặng.
- Lệnh nền liên quan nhau (test Windows + Mac, build + test) ⇒ gộp vào MỘT lệnh nền in một tổng kết, không hai lệnh.
- Một worker xong gửi HAI tín hiệu (báo cáo + thông báo "completed"): xử lý ở tín hiệu đầu; tín hiệu sau không có gì
  mới ⇒ không gọi tool, không nhắn user.
- Brief luôn đòi receipt ngắn (chi tiết ghi ra file, chỉ báo đường file + vài dòng kết luận).
