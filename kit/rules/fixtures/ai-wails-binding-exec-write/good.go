package main

import "os"

type Store struct{}

func (s *Store) SaveNote(id string, text string) error { return nil }

type App struct{ store *Store }

// XANH: hàm bind chỉ gọi lớp lưu trữ đã tự quyết đường dẫn, không nhận đường dẫn hay lệnh từ giao diện.
func (a *App) SaveNote(id string, text string) error {
	return a.store.SaveNote(id, text)
}

// Hàm viết thường không được Wails đưa ra cho giao diện.
func (a *App) writeCache(path string, data []byte) error {
	return os.WriteFile(path, data, 0o644)
}

// Wails v3: service mỏng chỉ nhận mã việc (id), lớp lưu trữ nội bộ tự quyết đường dẫn.
type NoteService struct{ store *Store }

// XANH: không gọi ghi file / chạy lệnh trực tiếp.
func (s *NoteService) Save(id string, text string) error {
	return s.store.SaveNote(id, text)
}

// XANH: hàm viết thường trong service không được lộ ra giao diện.
func (s *NoteService) moveInternal(from string, to string) error {
	return os.Rename(from, to)
}

// XANH: struct không phải App/Service (lớp lưu trữ nội bộ, không đăng ký với Wails) được phép ghi file.
func (s *Store) Export(path string, data []byte) error {
	return os.WriteFile(path, data, 0o644)
}
