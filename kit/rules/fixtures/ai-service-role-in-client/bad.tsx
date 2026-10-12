'use client'

import { createClient } from '@supabase/supabase-js'

// ĐỎ: file chạy ở trình duyệt mà đọc khoá service_role.
export const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
