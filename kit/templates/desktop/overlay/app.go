package main

import "context"

// App là phần DUY NHẤT của Go lộ ra giao diện web: mọi hàm viết hoa đầu đều gọi được từ JavaScript.
// Hiện chưa có hàm nào (màn đầu chỉ hiện tên app). Khi thêm: chỉ hàm nghiệp vụ nhận tham số hẹp (mã, số), gọi xuống internal/<miền>/transport.
// KHÔNG nhận đường dẫn file hay lệnh từ giao diện, KHÔNG ghi file / chạy lệnh trong hàm này (luật ai-wails-binding-exec-write).
type App struct {
	ctx context.Context
}

// NewApp tạo App; main.go gọi hàm này rồi đưa App vào Bind.
func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}
