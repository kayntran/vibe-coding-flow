// XANH: địa chỉ cố định, dựng từ phần cố định, hoặc đã qua hàm kiểm danh sách cho phép.
declare function validateUrl(u: string): string

export async function proxy(req: { query: { url: string } }) {
  const res = await fetch(validateUrl(req.query.url))
  return res.text()
}

export async function fixed() {
  return (await fetch('https://api.example.com/items?query=1')).json()
}

export async function relative(base: URL, path: string) {
  return (await fetch(new URL(path, base))).text()
}
