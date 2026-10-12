// XANH: ghi log rồi ném lại, hoặc xử lý cụ thể.
export function load(text: string) {
  try {
    return JSON.parse(text)
  } catch (e) {
    console.error('JSON hỏng', e)
    throw e
  }
}

export const pending = fetch('/x').catch((e) => {
  console.error(e)
})
