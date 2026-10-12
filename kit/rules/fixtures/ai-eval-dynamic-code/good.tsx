// XANH: đọc dữ liệu bằng JSON.parse, chọn hành động bằng bảng tra; chữ eval chỉ nằm trong chuỗi.
export function run(text: string) {
  return JSON.parse(text)
}

const actions: Record<string, (n: number) => number> = { double: (n) => n * 2 }
export const act = (name: string, n: number) => actions[name]?.(n)

export const note = 'đừng dùng eval'
