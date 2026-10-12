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
