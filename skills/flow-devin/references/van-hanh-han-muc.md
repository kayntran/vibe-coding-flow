# Vận hành máy ảo: chạy chung, xoá máy, hạn mức

- Hai `job` cùng dự án (vd 2–3 qa-tester song song) dùng chung một máy: job sau tự chờ job trước (≤ 20 phút, quá hạn ⇒ máy
  user). `sleep` báo máy bận ⇒ để job kia tự cho ngủ; `--force` chỉ khi chắc job kia đã chết. Làm từng bước tay (không
  `job`) thì không có giữ chỗ ⇒ đừng chạy song song với job khác của cùng dự án.
- User nói "xoá máy ảo của dự án" ⇒ `rm --dir <repo> [--os <os>]`, kể user rằng code và khoá trên máy đó mất theo.
  Devin bỏ qua lệnh xoá khi máy đang ngủ, nên công cụ tự đánh thức máy trước (~30 s) rồi mới xoá.
- Công cụ tự chọn chế độ rẻ nhất Devin còn cho khi tạo máy (`swe-2-medium` → `lite` → `normal` → mặc định; đổi chế độ thì
  ghi `mode-fallback` vào `devin-vm.log`). Không giao việc cho AI của Devin, không gửi prompt nào khác.
- Phanh hạn mức: hạn mức NGÀY của Devin còn dưới 20% ⇒ `where` trả `runner:"local"` (kèm giờ hồi, giờ Việt Nam) và
  `up` từ chối bật/đánh thức máy, nên `job` tự chạy máy user. Đổi ngưỡng bằng biến `DEVIN_VM_MIN_DAILY`. `status` cho
  thấy `quota` (`daily`/`weekly` %, giờ hồi); không đọc được số thì không chặn. `devin-vm.log` ghi % ngày lúc bắt đầu và
  lúc xong của `up` / `job` để biết mỗi lần chạy tốn bao nhiêu.
- Phí: máy thức trừ hạn mức Devin (~2% ngày / 30 phút), máy ngủ không trừ. Xem máy đang thức: `status --all`. Đo thật
  31/10: một ngày dựng và thử (8 máy, có lúc 3–4 máy thức cùng lúc) tốn 100% hạn mức ngày và 53% hạn mức tuần.
