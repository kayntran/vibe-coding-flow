'use client'

import { createClient } from '@supabase/supabase-js'

// XANH: component chạy ở trình duyệt chỉ dùng khoá công khai (anon).
export const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
