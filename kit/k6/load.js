// Mẫu đo tải k6 cho skill flow-scale. Chép vào dự án, chỉnh PATHS rồi chạy:
//   k6 run -e BASE_URL=https://app-staging.example.workers.dev -e VUS=20 -e DURATION=60s load.js
// Thoát mã 99 = trượt ngưỡng (báo "chưa đạt", không nới ngưỡng cho xanh). k6 là công cụ ngoài (AGPL), không nhúng vào app.
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '')
const VUS = Number(__ENV.VUS || 5)            // số người dùng ảo cùng lúc
const DURATION = __ENV.DURATION || '30s'
const THINK = Number(__ENV.THINK || 1)        // giây "nghĩ" giữa hai thao tác của một người
// Việc người dùng hay làm nhất, theo thứ tự. Chỉnh theo app; chỉ GET trừ khi bản thử có dữ liệu mẫu riêng.
// Mỗi mục là đường dẫn bắt đầu bằng "/" (vd "/,/gia?trang=1"); setup() từ chối mục có thể đổi địa chỉ đích.
const PATHS = (__ENV.PATHS || '/').split(',').map((p) => p.trim())
const EXPECT = __ENV.EXPECT || ''             // chữ phải có trong trang (rỗng = chỉ kiểm mã 200)

// Giới hạn của gói miễn phí hiện ra dưới dạng 429 / 1015 (chặn tốc độ) / 1102 (vượt CPU): đếm riêng để dừng sớm.
const limited = new Counter('limited_responses')

// Chuyển hướng (3xx): k6 mặc định tự đi theo tới 10 lần ⇒ bản thử trả 302 sang bản thật là tải dội thẳng vào bản thật,
// qua mặt chốt host bên dưới. maxRedirects: 0 = không đi theo; 3xx thành lỗi check (xem default). Mỗi yêu cầu cũng tự mang redirects: 0
// vì cờ --max-redirects / biến K6_MAX_REDIRECTS ghi đè được options nhưng không ghi đè được tham số từng yêu cầu.
export const options = {
  vus: VUS,
  duration: DURATION,
  maxRedirects: 0,
  thresholds: {
    // Ngưỡng mặc định của kit — chỉ đổi khi user đổi.
    http_req_failed: [
      'rate<0.01',
      { threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '10s' }, // lỗi > 10% ⇒ dừng đo ngay
    ],
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    checks: ['rate>0.99'], // checks chỉ tính khi có dòng này
    limited_responses: [{ threshold: 'count<1', abortOnFail: true }], // chạm trần gói miễn phí ⇒ dừng ngay
  },
}

// >>> host-guard (hooks/lib/k6-load.test.mjs đọc khối này từ file: giữ nó tự đủ — không import, không __ENV)
// Chốt an toàn: chỉ đo máy mình (localhost) hoặc địa chỉ có NHÃN PHỤ staging|stg|test|dev|preview (vd staging.shop.com, app-staging.shop.workers.dev).
// Không tính đuôi miền, tên miền chính, và tên project/tài khoản của workers.dev / pages.dev — nên shop.workers.dev, abc.pages.dev, myshop.dev đều là "bản thật".
const SAFE_LABEL = /(^|-)(staging|stg|test|dev|preview)(-|$)/
const hostOf = (url) => {
  const rest = String(url || '').trim().replace(/^[a-z][a-z0-9+.\-]*:\/\//i, '')
  const authority = rest.split(/[\/\\?#]/)[0]
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1) // bỏ "user:pw@": host thật là phần sau @ cuối
  const host = afterUser.charAt(0) === '[' ? afterUser.slice(0, afterUser.indexOf(']') + 1) : afterUser.replace(/:\d*$/, '')
  return host.toLowerCase().replace(/\.+$/, '')
}
const hostLooksSafe = (url) => {
  const host = hostOf(url)
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true
  const labels = host.split('.')
  const last = labels[labels.length - 1]
  const prev = labels[labels.length - 2] || ''
  // số nhãn cuối KHÔNG xét: đuôi + tên miền chính (shop.com); workers.dev/pages.dev thêm tên project/tài khoản; co.uk, com.vn… thêm một nhãn
  const skip = /\.(workers|pages)\.dev$/.test(host) || (last.length === 2 && /^(co|com|net|org|gov|edu|ac)$/.test(prev)) ? 3 : 2
  return labels.slice(0, Math.max(labels.length - skip, 0)).some((label) => SAFE_LABEL.test(label))
}
// PATHS được ghép thẳng vào BASE_URL ⇒ mỗi mục phải là đường dẫn thật: bắt đầu bằng đúng một "/", không "@" (BASE_URL@host-khác đổi host đích),
// không "\" (có bộ phân tích coi như "/"), không khoảng trắng hay ký tự điều khiển. Trả lý do sai hoặc null.
const pathProblem = (p) => {
  const s = String(p)
  if (s.charAt(0) !== '/') return 'phải bắt đầu bằng "/"'
  if (s.charAt(1) === '/') return 'không được bắt đầu bằng "//"'
  if (/[@\\]/.test(s)) return 'không được chứa "@" hoặc "\\"'
  if (/[\u0000- \u007f]/.test(s)) return 'không được chứa khoảng trắng hay ký tự điều khiển'
  return null
}
// Ghép đường dẫn vào địa chỉ rồi host có đổi không (cùng hàm hostOf ở trên) — lớp kiểm thứ hai sau pathProblem.
const hostDrift = (base, p) => hostOf(`${base}${p}`) !== hostOf(base)
// <<< host-guard

export function setup() {
  if (!BASE_URL) throw new Error('Thiếu BASE_URL (địa chỉ BẢN THỬ riêng).')
  // Địa chỉ không qua chốt ⇒ phải tự xác nhận là bản thử bằng ALLOW_HOST=1.
  if (!hostLooksSafe(BASE_URL) && __ENV.ALLOW_HOST !== '1') {
    throw new Error(`"${hostOf(BASE_URL)}" không giống bản thử (cần nhãn staging|stg|test|dev|preview ở phần tên phụ, vd app-staging.<tên>.workers.dev). Không đo bản thật. Đúng là bản thử thì thêm -e ALLOW_HOST=1.`)
  }
  // Chốt host chỉ xét BASE_URL; PATHS không được lách sang host khác (kể cả khi đã ALLOW_HOST=1).
  for (const p of PATHS) {
    const problem = pathProblem(p)
    if (problem) throw new Error(`PATHS ${JSON.stringify(p).slice(0, 80)} bị từ chối: ${problem}. Mỗi mục là đường dẫn bắt đầu bằng "/", vd -e PATHS=/,/gia.`)
    if (hostDrift(BASE_URL, p)) throw new Error(`PATHS ${JSON.stringify(p).slice(0, 80)} bị từ chối: ghép vào BASE_URL thì địa chỉ đích đổi từ "${hostOf(BASE_URL)}" sang "${hostOf(`${BASE_URL}${p}`)}". Không đo.`)
  }
}

let warnedRedirect = false // mỗi người dùng ảo cảnh báo chuyển hướng một lần, không tràn log

export default function () {
  for (const p of PATHS) {
    // redirects: 0 ⇒ không đi theo 3xx (xem options.maxRedirects)
    const res = http.get(`${BASE_URL}${p}`, { redirects: 0 })
    if (res.status === 429 || res.status === 1015 || res.body && /error code: 1(015|102)/.test(String(res.body))) {
      limited.add(1)
    }
    const redirected = res.status >= 300 && res.status < 400
    if (redirected && !warnedRedirect) {
      warnedRedirect = true
      const to = String((res.headers && (res.headers.Location || res.headers.location)) || '').slice(0, 80)
      console.warn(`BASE_URL trả chuyển hướng ${res.status} sang "${to}" — k6 không đi theo (tránh dội tải sang địa chỉ khác, nhất là bản thật). Đặt BASE_URL đúng địa chỉ cuối của bản thử.`)
    }
    check(res, {
      'trả 200': (r) => r.status === 200,
      'không bị chuyển hướng (3xx)': (r) => r.status < 300 || r.status >= 400,
      'có nội dung đúng': (r) => !EXPECT || String(r.body).includes(EXPECT),
    })
    sleep(THINK)
  }
}
