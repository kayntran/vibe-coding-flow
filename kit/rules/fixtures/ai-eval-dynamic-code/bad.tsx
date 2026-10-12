// ĐỎ: chạy chuỗi như mã lệnh.
export function run(code: string) {
  return eval(code)
}

export const make = (body: string) => new Function('x', body)
