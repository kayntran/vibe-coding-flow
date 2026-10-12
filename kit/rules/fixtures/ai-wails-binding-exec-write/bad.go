package main

import (
	"os"
	"os/exec"
)

type App struct{}

// ĐỎ: hàm viết hoa đầu = Wails đưa ra cho giao diện web gọi; mã web ghi file / chạy lệnh tuỳ ý.
func (a *App) SaveFile(path string, data string) error {
	return os.WriteFile(path, []byte(data), 0o644)
}

func (a *App) Run(cmd string) ([]byte, error) {
	return exec.Command(cmd).Output()
}
