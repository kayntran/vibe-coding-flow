// ĐỎ: máy chủ gọi thẳng địa chỉ do người dùng gửi lên.
export async function proxy(req: { query: { url: string } }) {
  const res = await fetch(req.query.url)
  return res.text()
}

export async function proxy2(searchParams: URLSearchParams) {
  return (await fetch(searchParams.get('url') as string)).text()
}
