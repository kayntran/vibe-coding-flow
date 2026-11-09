# Mẫu brief và receipt

Brief tự đủ (worker không đọc được hội thoại), < 800 ký tự, chỉ phần riêng của việc (quy ước chung nằm sẵn trong
body agent). Spec dài ⇒ ghi file rồi trỏ đường dẫn.

```
outcome=<một kết quả kiểm được>
scope=<path được sửa; còn lại chỉ đọc>
constraints=<điều cấm quan trọng>
accept=<lệnh chính xác, xanh = xong>
plan=<PLAN.md> lane=<tên> base=<nhánh mốc>     ← khi giao làn song song (hook kiểm bảng làn, audit lúc nộp)
PORT_BASE=<n>                                  ← khi worker chạy app (hook chặn qa-tester thiếu port)
```

Receipt: `return=done|done_with_concerns|needs_context|blocked; paths=…; checks=<output accept có số thật>; blocker=…; stop`
(`test-runner`: `return=green|red|blocked`).
