// XANH: chuỗi đã lọc DOMPurify hoặc chuỗi cố định.
import DOMPurify from 'dompurify'

export function Post({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
}

export const Fixed = () => <div dangerouslySetInnerHTML={{ __html: '<b>cố định</b>' }} />
