// ĐỎ: nuốt lỗi (catch trống, catch chỉ có comment, .catch(() => {})).
export function load(text: string) {
  try {
    return JSON.parse(text)
  } catch {
  }
}

export function load2(text: string) {
  try {
    return JSON.parse(text)
  } catch (e) {
    // bỏ qua
  }
}

export const pending = fetch('/x').catch(() => {})
