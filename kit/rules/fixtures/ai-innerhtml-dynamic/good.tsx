// XANH: chữ thường dùng textContent; HTML cố định hoặc đã lọc DOMPurify thì được.
import DOMPurify from 'dompurify'

export function show(el: HTMLElement, userHtml: string, text: string) {
  el.textContent = text
  el.innerHTML = '<b>Xong</b>'
  el.innerHTML = DOMPurify.sanitize(userHtml)
}
