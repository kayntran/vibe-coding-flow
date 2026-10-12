// ĐỎ: gán chuỗi động (có thể chứa script) vào HTML của trang.
export function show(el: HTMLElement, userHtml: string) {
  el.innerHTML = userHtml
  el.insertAdjacentHTML('beforeend', `<p>${userHtml}</p>`)
}
