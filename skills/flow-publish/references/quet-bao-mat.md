# Quét bảo mật: báo nhầm ZAP và Strix

## Báo nhầm của ZAP

Chỉ miễn qua `docs/security-ignore.json` (`rule`, `reason`, `until` YYYY-MM-DD; hết hạn ⇒ chặn lại).

## Quét Strix (quét bằng AI)

Chạy sau khi user đã gật chi phí và thời gian:
`node ~/.claude/hooks/strix-scan.mjs -t http://localhost:<cổng> --max-budget <USD> --scan-mode quick|standard|deep`.
Thiếu `--max-budget` ⇒ bị từ chối. Không có Docker (exit 3) ⇒ bỏ qua và ghi vào báo cáo: "chưa quét sâu được, lỗi phân
quyền/nghiệp vụ có thể còn sót".
