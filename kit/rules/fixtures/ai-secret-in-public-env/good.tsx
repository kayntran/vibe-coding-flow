// XANH: khoá công khai (url, anon, publishable) được phép; khoá bí mật không có tiền tố công khai, chỉ đọc ở máy chủ.
export const url = import.meta.env.VITE_SUPABASE_URL
export const anon = import.meta.env.VITE_SUPABASE_ANON_KEY
export const publishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
export const serverOnly = process.env.SUPABASE_SERVICE_ROLE_KEY
