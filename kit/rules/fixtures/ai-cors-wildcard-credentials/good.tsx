// XANH: có credentials thì liệt kê đúng origin; origin * chỉ cho API công khai không cookie.
import cors from 'cors'

export const strict = cors({ origin: ['https://app.example.com'], credentials: true })
export const publicApi = cors({ origin: '*' })
