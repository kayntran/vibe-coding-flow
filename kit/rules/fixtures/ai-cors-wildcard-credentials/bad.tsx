// ĐỎ: cho mọi nguồn gọi API mà vẫn gửi kèm cookie đăng nhập.
import cors from 'cors'

export const open = cors({ origin: '*', credentials: true })
