// ĐỎ: biến công khai (đi thẳng vào mã trình duyệt) lại chứa khoá bí mật.
export const adminKey = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY
export const stripeSecret = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY
