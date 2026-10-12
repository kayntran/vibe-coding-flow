// ĐỎ: nhét chuỗi động chưa lọc vào dangerouslySetInnerHTML.
export function Post({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
