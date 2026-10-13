package main

import (
	"os"
	"os/exec"
	"syscall"
)

type App struct{}

// ĐỎ: hàm viết hoa đầu = Wails đưa ra cho giao diện web gọi; mã web ghi file / chạy lệnh tuỳ ý.
func (a *App) SaveFile(path string, data string) error {
	return os.WriteFile(path, []byte(data), 0o644)
}

func (a *App) Run(cmd string) ([]byte, error) {
	return exec.Command(cmd).Output()
}

// Wails v3: service đăng ký bằng application.NewService(&FileService{}); mọi method viết hoa đều gọi được từ JS.
type FileService struct{}

// ĐỎ: đổi tên / xoá / tạo thư mục / đổi quyền theo đường dẫn do giao diện gửi.
func (s *FileService) Move(from string, to string) error {
	return os.Rename(from, to)
}

func (s *FileService) Wipe(dir string) error {
	return os.RemoveAll(dir)
}

func (s *FileService) MakeDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

func (s *FileService) Open(mode os.FileMode, path string) error {
	return os.Chmod(path, mode)
}

// ĐỎ: chạy chương trình bằng cách khác ngoài exec.Command.
func (s *FileService) Launch(path string) error {
	_, err := os.StartProcess(path, nil, &os.ProcAttr{})
	return err
}

func (s *FileService) Replace(path string) error {
	return syscall.Exec(path, nil, nil)
}
