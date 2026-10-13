// Test cho lib/zap.mjs: node --test hooks/lib/zap.test.mjs
// Không chạy ZAP/Java thật: `run` giả (kiểm đối số, ghi báo cáo JSON mẫu vào thư mục tạm), `isFile`/`env`/`platform` giả, `probe` giả.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ReportError, TEMPLATE_FILE, applyIgnores, buildInvocation, buildPlan, checkTools, classifyIgnores, defaultRun, findZap, fixVi, installHints, javaMajor,
  judge, loadIgnores, parseReport, parseTarget, probeTarget, scan, stripYamlComments, yamlStr,
} from './zap.mjs'

const tmpDirs = []
function tmp(prefix = 'zap-test ') { // có dấu cách + tiếng Việt: đường dẫn người dùng thật hay có
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}Việt `))
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const NOW = new Date(2026, 9, 13, 12, 0, 0) // 2026-10-13 giờ máy
const files = (...list) => { const s = new Set(list); return (p) => s.has(p) }

// ---------- báo cáo mẫu (dạng traditional-json của ZAP 2.17) ----------

const alert = (o = {}) => ({
  pluginid: '10038', alertRef: '10038-1', alert: 'CSP', name: 'Content Security Policy (CSP) Header Not Set', riskcode: '2', confidence: '3',
  riskdesc: 'Medium (High)', desc: '<p>CSP is an added layer.</p>', instances: [{ uri: 'http://localhost:3000/', method: 'GET' }], count: '1',
  solution: '<p>Ensure that your web server, application server, load balancer, etc. is configured to set the Content-Security-Policy header.</p>', ...o,
})
const HIGH = alert({ pluginid: '40018', alertRef: '40018', name: 'SQL Injection', riskcode: '3', riskdesc: 'High (Medium)', instances: [{ uri: 'http://localhost:3000/api/a?id=1' }, { uri: 'http://localhost:3000/api/b?id=2' }], solution: '<p>Do not trust client side input.</p>' })
const MEDIUM = alert()
const LOW = alert({ pluginid: '10054', alertRef: '10054-1', name: 'Cookie without SameSite Attribute', riskcode: '1', riskdesc: 'Low (Medium)' })
const INFO = alert({ pluginid: '10109', alertRef: '10109', name: 'Modern Web Application', riskcode: '0', riskdesc: 'Informational (Medium)' })
const report = (alerts, site = 'http://localhost:3000') => JSON.stringify({ '@programName': 'ZAP', '@version': '2.17.0', site: [{ '@name': site, '@host': 'localhost', '@port': '3000', '@ssl': 'false', alerts }] })

// ---------- parseTarget ----------

test('parseTarget: chỉ nhận localhost | 127.0.0.1 | [::1] (http/https), chuẩn hoá địa chỉ', () => {
  for (const t of ['http://localhost:3000', 'http://127.0.0.1:8080/app', 'https://localhost', 'http://[::1]:4140/x', 'HTTP://LOCALHOST:3000', 'http://127.1:3000']) {
    assert.equal(parseTarget(t).ok, true, t)
  }
  assert.equal(parseTarget('http://127.1:3000').origin, 'http://127.0.0.1:3000') // ZAP nhận bản đã chuẩn hoá
  assert.equal(parseTarget('http://[::1]:4140/x').origin, 'http://[::1]:4140')
  for (const t of ['', '   ', undefined, null, 'localhost:3000', 'https://example.com', 'http://localhost.evil.com', 'http://localhost@evil.com/', 'http://user:pw@localhost:3000',
    'http://0.0.0.0:3000', 'http://192.168.1.5', 'http://10.0.0.1:3000', 'file:///C:/x', 'ftp://localhost', 'http://localhost.', 'http://[::2]', 'C:\\app']) {
    assert.equal(parseTarget(t).ok, false, String(t))
  }
})

// ---------- java / zap / công cụ ----------

test('javaMajor: đọc đúng bản từ `java -version`', () => {
  assert.equal(javaMajor('openjdk version "17.0.9" 2023-10-17\nOpenJDK Runtime Environment'), 17)
  assert.equal(javaMajor('java version "1.8.0_392"'), 8)
  assert.equal(javaMajor('openjdk version "21" 2023-09-19'), 21)
  assert.equal(javaMajor('openjdk version "17-ea" 2021-09-14'), 17)
  assert.equal(javaMajor('openjdk 21.0.1 2023-10-17'), 21)
  assert.equal(javaMajor(''), null)
  assert.equal(javaMajor('command not found'), null)
})

const WZ = 'C:\\Program Files\\ZAP\\Zed Attack Proxy\\zap.bat'

test('findZap: ZAP_PATH thắng và là duy nhất; rồi PATH; rồi chỗ cài mặc định từng hệ', () => {
  const win = { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' } }
  assert.equal(findZap({ ...win, isFile: files(WZ) }), WZ)
  assert.equal(findZap({ platform: 'win32', env: { PATH: 'C:\\tools;C:\\other', ProgramFiles: 'C:\\Program Files' }, isFile: files('C:\\other\\zap.bat', WZ) }), 'C:\\other\\zap.bat')
  assert.equal(findZap({ platform: 'win32', env: { Path: 'D:\\z' }, isFile: files('D:\\z\\zap.bat') }), 'D:\\z\\zap.bat') // Windows hay đặt tên Path
  assert.equal(findZap({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Trần\\AppData\\Local' }, isFile: files('C:\\Users\\Trần\\AppData\\Local\\Programs\\ZAP\\Zed Attack Proxy\\zap.bat') }),
    'C:\\Users\\Trần\\AppData\\Local\\Programs\\ZAP\\Zed Attack Proxy\\zap.bat')
  assert.equal(findZap({ ...win, isFile: files() }), null)
  // ZAP_PATH: file, thư mục chứa, hoặc sai ⇒ KHÔNG rơi về chỗ mặc định (lỗi phải hiện)
  assert.equal(findZap({ platform: 'win32', env: { ZAP_PATH: 'E:\\x\\zap.bat' }, isFile: files('E:\\x\\zap.bat', WZ) }), 'E:\\x\\zap.bat')
  assert.equal(findZap({ platform: 'win32', env: { ZAP_PATH: 'E:\\x' }, isFile: files('E:\\x\\zap.bat') }), 'E:\\x\\zap.bat')
  assert.equal(findZap({ platform: 'win32', env: { ZAP_PATH: 'E:\\sai', ProgramFiles: 'C:\\Program Files' }, isFile: files(WZ) }), null)
  assert.equal(findZap({ platform: 'darwin', env: {}, isFile: files('/Applications/ZAP.app/Contents/Java/zap.sh') }), '/Applications/ZAP.app/Contents/Java/zap.sh')
  assert.equal(findZap({ platform: 'linux', env: { PATH: '/usr/bin:/usr/local/bin' }, isFile: files('/usr/bin/zaproxy') }), '/usr/bin/zaproxy')
  assert.equal(findZap({ platform: 'linux', env: {}, isFile: files('/usr/share/zaproxy/zap.sh') }), '/usr/share/zaproxy/zap.sh')
})

const javaRun = (stderr, status = 0, error = null) => {
  const calls = []
  const run = (file, args) => { calls.push([file, ...args]); return { status, stdout: '', stderr, error } }
  return { run, calls }
}

test('checkTools: đủ ZAP + Java 17 ⇒ ok; thiếu ⇒ nói thiếu gì + lệnh cài theo máy', () => {
  const ok = checkTools({ platform: 'win32', env: { ZAP_PATH: WZ }, isFile: files(WZ), run: javaRun('openjdk version "17.0.9"').run })
  assert.deepEqual([ok.ok, ok.zap, ok.java, ok.missing, ok.hints], [true, WZ, 17, [], []])

  const old = checkTools({ platform: 'linux', env: { ZAP_PATH: '/z/zap.sh' }, isFile: files('/z/zap.sh'), run: javaRun('openjdk version "11.0.2"').run })
  assert.equal(old.ok, false)
  assert.match(old.missing.join(), /Java 17\+ \(máy có Java 11\)/)

  const noJava = checkTools({ platform: 'win32', env: { ZAP_PATH: WZ }, isFile: files(WZ), run: javaRun('', null, { code: 'ENOENT' }).run })
  assert.deepEqual(noJava.missing, ['Java 17+'])
  assert.deepEqual(noJava.hints, ['winget install -e --id EclipseAdoptium.Temurin.17.JRE', '(cài xong mở lại cửa sổ lệnh rồi chạy lại)'])

  const noZap = checkTools({ platform: 'win32', env: {}, isFile: files(), run: javaRun('openjdk version "21.0.1"').run })
  assert.deepEqual(noZap.missing, ['ZAP'])
  assert.match(noZap.hints.join('\n'), /winget install -e --id ZAP\.ZAP/)
  assert.doesNotMatch(noZap.hints.join('\n'), /Temurin/)

  const badPath = checkTools({ platform: 'win32', env: { ZAP_PATH: 'E:\\sai' }, isFile: files(WZ), run: javaRun('openjdk version "17"').run })
  assert.match(badPath.missing[0], /ZAP_PATH="E:\\sai"/)

  assert.deepEqual(installHints('darwin', { zap: true, java: true }), ['brew install --cask zap   (đã kèm Java)'])
  assert.deepEqual(installHints('darwin', { zap: false, java: true }), ['brew install --cask temurin@17'])
  assert.match(installHints('linux', { zap: true, java: true }).join('\n'), /openjdk-17-jre[\s\S]*zaproxy\.org/)
})

test('checkTools: macOS ZAP.app kèm Java ⇒ không đòi Java hệ thống; JAVA_HOME được thử trước', () => {
  const MZ = '/Applications/ZAP.app/Contents/Java/zap.sh'
  const j = javaRun('', null, { code: 'ENOENT' })
  const mac = checkTools({ platform: 'darwin', env: { ZAP_PATH: MZ }, isFile: files(MZ), run: j.run })
  assert.equal(mac.ok, true)
  assert.equal(j.calls.length, 0)

  const k = javaRun('openjdk version "17.0.1"')
  checkTools({ platform: 'linux', env: { ZAP_PATH: '/z/zap.sh', JAVA_HOME: '/jdk17' }, isFile: files('/z/zap.sh'), run: k.run })
  assert.deepEqual(k.calls[0], ['/jdk17/bin/java', '-version'])
})

test('checkTools: vừa cài Java, PATH cũ chưa có ⇒ tìm ở chỗ cài mặc định (bản mới nhất) và đưa vào PATH của lệnh ZAP', () => {
  const root = 'C:\\Program Files\\Eclipse Adoptium'
  const J21 = `${root}\\jre-21.0.5-hotspot\\bin\\java.exe`
  const listDir = (d) => (d === root ? ['jre-17.0.20-hotspot', 'jre-21.0.5-hotspot'] : [])
  const calls = []
  const run = (file, args) => { calls.push(file); return file === J21 ? { status: 0, stdout: '', stderr: 'openjdk version "21.0.5"', error: null } : { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } } }
  const env = { ZAP_PATH: WZ, ProgramFiles: 'C:\\Program Files', Path: 'C:\\Windows' }
  const r = checkTools({ platform: 'win32', env, isFile: files(WZ, J21, `${root}\\jre-17.0.20-hotspot\\bin\\java.exe`), run, listDir })
  assert.deepEqual([r.ok, r.java], [true, 21])
  assert.deepEqual(calls, ['java', J21]) // PATH trước, rồi bản mới nhất ở chỗ cài
  assert.equal(r.runEnv.Path, `${root}\\jre-21.0.5-hotspot\\bin;C:\\Windows`)
  assert.equal(r.runEnv.JAVA_HOME, `${root}\\jre-21.0.5-hotspot`)
  assert.equal('PATH' in r.runEnv, false) // không tạo khoá PATH thứ hai cạnh Path

  const onPath = checkTools({ platform: 'win32', env, isFile: files(WZ), run: javaRun('openjdk version "17.0.9"').run, listDir: () => [] })
  assert.equal(onPath.runEnv, env) // Java có sẵn trên PATH ⇒ giữ nguyên env
})

test('buildInvocation: .bat qua cmd.exe có nháy kép; ký tự nguy hiểm bị từ chối; còn lại chạy thẳng mảng tham số', () => {
  const plan = 'C:\\Users\\Trần Văn\\AppData\\Local\\Temp\\zap-plan-1\\plan.yaml'
  const w = buildInvocation(WZ, ['-cmd', '-autorun', plan], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } })
  assert.equal(w.cmd, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(w.argv, ['/d', '/s', '/c', `""${WZ}" -cmd -autorun "${plan}""`]) // cờ để trần, đường dẫn có dấu cách/chữ Việt nháy kép
  assert.equal(w.verbatim, true)
  for (const bad of ['C:\\a"b\\zap.bat', 'C:\\100%\\zap.bat', 'C:\\a!b\\zap.bat']) {
    assert.equal(buildInvocation(bad, [], { platform: 'win32', env: {} }).error.code, 'EUNSAFE', bad)
  }
  assert.equal(buildInvocation(WZ, ['x"y'], { platform: 'win32', env: {} }).error.code, 'EUNSAFE')
  assert.deepEqual(buildInvocation('C:\\jdk\\bin\\java.exe', ['-version'], { platform: 'win32', env: {} }), { cmd: 'C:\\jdk\\bin\\java.exe', argv: ['-version'], verbatim: false })
  assert.deepEqual(buildInvocation('/z/zap.sh', ['-cmd'], { platform: 'linux', env: {} }), { cmd: '/z/zap.sh', argv: ['-cmd'], verbatim: false })
})

// ---------- plan ----------

test('yamlStr: chuỗi nháy kép chỉ ASCII (Java 17 Windows đọc theo bảng mã máy), không mất ký tự', () => {
  const s = 'C:\\Users\\Trần Văn Ạ\\Temp "x"'
  const y = yamlStr(s)
  assert.match(y, /^[\x20-\x7e]*$/)
  assert.equal(JSON.parse(y), s) // phần BMP: cú pháp \uXXXX trùng JSON
  assert.equal(yamlStr('😀'), '"\\U0001f600"')
  assert.equal(yamlStr('a\nb'), '"a\\nb"')
})

test('buildPlan: điền target, phạm vi, thư mục báo cáo; template thật có đủ 4 chỗ + 4 job; thiếu chỗ ⇒ ném', () => {
  const tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8')
  for (const k of ['__TARGET__', '__INCLUDE__', '__REPORT_DIR__', '__REPORT_FILE__']) assert.ok(tpl.includes(`"${k}"`), k)
  for (const j of ['passiveScan-config', 'spider', 'passiveScan-wait', 'report']) assert.match(tpl, new RegExp(`- type: ${j}\\b`))
  assert.match(tpl, /template: traditional-json/)
  assert.doesNotMatch(tpl, /type: (?:activeScan|exitStatus)/) // chỉ thụ động; mức chặn do lib tính

  const target = parseTarget('http://127.0.0.1:4140/app')
  const plan = buildPlan(tpl, { target, reportDir: 'C:\\Báo cáo\\zap', reportFile: 'zap-report' })
  assert.ok(plan.includes('- "http://127.0.0.1:4140/app"'))
  assert.ok(plan.includes('- "http://127\\\\.0\\\\.0\\\\.1:4140.*"')) // regex escape dấu chấm, rồi YAML escape dấu gạch chéo ngược
  assert.ok(plan.includes('reportDir: "C:\\\\B\\u00e1o c\\u00e1o\\\\zap"'))
  assert.ok(plan.includes('reportFile: "zap-report"'))
  assert.doesNotMatch(plan, /__[A-Z_]+__/)
  assert.match(plan, /^[\x0a\x20-\x7e]*$/) // cả plan thuần ASCII (chú thích tiếng Việt của mẫu đã bị bỏ)
  assert.doesNotMatch(plan, /#/)
})

test('stripYamlComments: bỏ chú thích đầu dòng và cuối dòng, giữ # nằm trong chuỗi nháy kép', () => {
  const y = '# đầu\nenv:\n  a: "x # không phải chú thích"   # chú thích\n  b: "q\\" # vẫn trong chuỗi"\n  c: 1\n'
  assert.equal(stripYamlComments(y), 'env:\n  a: "x # không phải chú thích"\n  b: "q\\" # vẫn trong chuỗi"\n  c: 1')
})

test('buildPlan: thiếu chỗ điền trong template ⇒ ném (plan không có phạm vi thì không được chạy)', () => {
  const target = parseTarget('http://localhost:3000')
  assert.throws(() => buildPlan('env: {}\n', { target, reportDir: '/r', reportFile: 'zap-report' }), /thiếu chỗ "__TARGET__"/)
})

// ---------- báo cáo ----------

test('parseReport: đọc mức, URL, lời sửa; riskcode số hay chuỗi đều được; BOM được bỏ', () => {
  const r = parseReport(`\uFEFF${report([HIGH, MEDIUM, LOW, INFO, { ...LOW, pluginid: '1', riskcode: 1, name: 'riskcode số' }])}`)
  assert.equal(r.sites, 1)
  assert.deepEqual(r.alerts.map((a) => a.risk), ['high', 'medium', 'low', 'info', 'low'])
  assert.equal(r.alerts[0].name, 'SQL Injection')
  assert.equal(r.alerts[0].count, 2)
  assert.equal(r.alerts[0].solution, 'Do not trust client side input.') // đã bỏ thẻ HTML
  assert.equal(r.alerts[0].instances[1].uri, 'http://localhost:3000/api/b?id=2')
  // thiếu riskcode ⇒ đọc từ riskdesc
  assert.equal(parseReport(report([{ ...HIGH, riskcode: undefined }])).alerts[0].risk, 'high')
  // site không có cảnh báo vẫn là báo cáo hợp lệ
  assert.deepEqual(parseReport(report([])).alerts, [])
})

test('parseReport: báo cáo hỏng/rỗng/mức lạ ⇒ ReportError (không coi là sạch)', () => {
  for (const [text, re] of [
    ['không phải json', /không phải JSON/], ['{}', /thiếu danh sách "site"/], ['null', /thiếu danh sách "site"/], ['{"site":[]}', /không có trang nào/],
    [report([{ ...HIGH, riskcode: '9', riskdesc: 'Critical' }]), /mức rủi ro lạ/],
  ]) assert.throws(() => parseReport(text), (e) => e instanceof ReportError && re.test(e.message), text.slice(0, 30))
})

// ---------- danh sách miễn ----------

test('classifyIgnores: còn hạn / hết hạn (hết ngày until) / không dùng được', () => {
  const ig = classifyIgnores([
    { rule: '10038', reason: 'CSP đặt ở CDN', until: '2026-10-13' }, // hôm nay: còn hạn
    { rule: '10054', reason: 'cũ', until: '2026-10-12' }, // hôm qua: hết hạn
    { rule: '10020', until: '2026-12-31' }, // thiếu lý do
    { rule: '10021', reason: 'x', until: '2026-13-45' }, // ngày không có thật
    { rule: '10022', reason: 'x', until: '12/31/2026' }, // sai dạng
    { reason: 'x', until: '2026-12-31' }, // thiếu rule
    { rule: '10023', reason: 'x', until: '2026-12-31', url: 5 }, // url sai kiểu
    { rule: '10024', reason: '   ', until: '2026-12-31' }, // lý do trống
    null, 'chuỗi',
  ], NOW)
  assert.deepEqual(ig.active.map((e) => e.rule), ['10038'])
  assert.deepEqual(ig.expired.map((e) => e.rule), ['10054'])
  assert.deepEqual(ig.invalid.map((e) => e.index), [3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(ig.invalid[0].why, 'thiếu reason (lý do)')
})

test('loadIgnores: không có file ⇒ rỗng; hỏng/không phải mảng ⇒ không miễn gì + problem; đọc đúng file mẫu', () => {
  const d = tmp()
  assert.deepEqual(loadIgnores(path.join(d, 'none.json'), NOW), { active: [], expired: [], invalid: [] })
  const write = (name, content) => { const f = path.join(d, name); fs.writeFileSync(f, content); return f }
  assert.match(loadIgnores(write('hong.json', '{ không json'), NOW).problem, /không phải JSON/)
  assert.match(loadIgnores(write('obj.json', '{"rule":"1"}'), NOW).problem, /phải là mảng/)
  assert.match(loadIgnores(d, NOW).problem, /không đọc được/) // thư mục thay vì file
  const ok = loadIgnores(write('ok.json', JSON.stringify([{ rule: '10038', url: 'http://localhost:3000/docs', reason: 'trang tĩnh', until: '2027-01-01' }])), NOW)
  assert.equal(ok.problem, undefined)
  assert.equal(ok.active[0].url, 'http://localhost:3000/docs')
})

test('applyIgnores: khớp theo pluginid | alertRef | tên; có url ⇒ chỉ bỏ các chỗ khớp tiền tố; hết hạn ⇒ tính lại có ghi chú', () => {
  const alerts = parseReport(report([HIGH, MEDIUM, LOW])).alerts
  const ig = (list) => classifyIgnores(list.map((e) => ({ reason: 'lý do', until: '2026-12-31', ...e })), NOW)

  const byId = applyIgnores(alerts, ig([{ rule: '40018' }]))
  assert.deepEqual(byId.kept.map((a) => a.name), [MEDIUM.name, LOW.name])
  assert.deepEqual(byId.ignored.map((i) => [i.rule, i.count]), [['40018', 2]])
  assert.equal(applyIgnores(alerts, ig([{ rule: '10038-1' }])).kept.length, 2) // alertRef
  assert.equal(applyIgnores(alerts, ig([{ rule: 'sql injection' }])).kept.length, 2) // tên, không phân biệt hoa thường
  assert.equal(applyIgnores(alerts, ig([{ rule: '99999' }])).kept.length, 3)

  // url: bỏ một chỗ, còn một chỗ ⇒ lỗi vẫn tính (mức cao vẫn chặn)
  const part = applyIgnores(alerts, ig([{ rule: '40018', url: 'http://localhost:3000/api/a' }]))
  assert.equal(part.kept[0].name, 'SQL Injection')
  assert.deepEqual(part.kept[0].instances.map((i) => i.uri), ['http://localhost:3000/api/b?id=2'])
  assert.equal(part.kept[0].count, 1)
  assert.equal(judge(part.kept).exit, 1)
  // url bao hết các chỗ ⇒ cả lỗi được miễn
  const all = applyIgnores(alerts, ig([{ rule: '40018', url: 'http://localhost:3000/api/' }]))
  assert.equal(all.kept.some((a) => a.name === 'SQL Injection'), false)
  assert.equal(judge(all.kept).exit, 2)

  // hết hạn ⇒ lỗi trở lại + ghi chú
  const exp = applyIgnores(alerts, ig([{ rule: '40018', until: '2026-10-01' }]))
  assert.equal(exp.kept[0].expired.until, '2026-10-01')
  assert.equal(exp.ignored.length, 0)
  assert.equal(judge(exp.kept).exit, 1)
  // mục hết hạn có url không khớp chỗ nào còn lại ⇒ không ghi chú
  assert.equal(applyIgnores(alerts, ig([{ rule: '40018', until: '2026-10-01', url: 'http://localhost:3000/khac' }])).kept[0].expired, undefined)
  // mục còn hạn thắng mục hết hạn cùng rule
  assert.equal(applyIgnores(alerts, ig([{ rule: '40018', until: '2026-10-01' }, { rule: '40018' }])).kept.length, 2)
})

test('judge: High ⇒ 1 · Medium ⇒ 2 · chỉ Low/Info ⇒ 0', () => {
  const r = parseReport(report([HIGH, MEDIUM, LOW, INFO])).alerts
  assert.deepEqual(judge(r), { exit: 1, counts: { high: 1, medium: 1, low: 1, info: 1 } })
  assert.equal(judge(r.filter((a) => a.risk !== 'high')).exit, 2)
  assert.equal(judge(r.filter((a) => a.risk === 'low' || a.risk === 'info')).exit, 0)
  assert.equal(judge([]).exit, 0)
})

// ---------- probeTarget ----------

test('probeTarget: mọi phản hồi HTTP = đang chạy; từ chối kết nối = chưa chạy; lỗi chứng chỉ tự ký = đang chạy', async () => {
  assert.equal((await probeTarget('http://localhost:3000', { fetch: async () => ({ status: 500 }) })).ok, true)
  const refused = await probeTarget('http://localhost:3000', { fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) } })
  assert.deepEqual(refused, { ok: false, detail: 'ECONNREFUSED' })
  const cert = await probeTarget('https://localhost:3000', { fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }) } })
  assert.equal(cert.ok, true)
  const slow = await probeTarget('http://localhost:3000', { timeoutMs: 20, fetch: (_u, o) => new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))) })
  assert.equal(slow.ok, false)
})

// ---------- scan: thế giới giả ----------

const ZAP = '/opt/zaproxy/zap.sh'

// run giả: `java -version` trả bản java; lệnh ZAP ghi báo cáo vào reportDir (hoặc hỏng theo tuỳ chọn). seen = thứ ZAP thấy.
function world(o = {}) {
  const dir = tmp()
  const reportDir = path.join(dir, 'báo cáo')
  const seen = { zap: [], plan: null, planFile: null, reportDirExisted: null }
  const run = (file, args, opts) => {
    if (file !== ZAP) return { status: 0, stdout: '', stderr: `openjdk version "${o.java ?? 17}.0.9"`, error: null }
    seen.zap.push({ file, args, opts })
    seen.planFile = args[2]
    seen.plan = fs.readFileSync(args[2], 'utf8')
    if (o.zapError) return { status: null, stdout: '', stderr: '', error: o.zapError }
    if (o.zapStatus) return { status: o.zapStatus, stdout: 'Job spider started\nERROR something broke\n\u001b[31mred\u001b[0m', stderr: 'Exception in thread main', error: null }
    if (o.report !== undefined) fs.writeFileSync(path.join(reportDir, o.reportName ?? 'zap-report.json'), o.report)
    return { status: 0, stdout: 'done', stderr: '', error: null }
  }
  const ignoreFile = path.join(dir, 'docs', 'security-ignore.json')
  if (o.ignores !== undefined) { fs.mkdirSync(path.dirname(ignoreFile), { recursive: true }); fs.writeFileSync(ignoreFile, typeof o.ignores === 'string' ? o.ignores : JSON.stringify(o.ignores)) }
  const probeCalls = []
  const probe = async (url) => { probeCalls.push(url); return o.probe ?? { ok: true } }
  return {
    dir, reportDir, seen, probeCalls,
    opts: { target: 'http://localhost:3000', reportDir, ignoreFile, now: NOW, platform: 'linux', env: { ZAP_PATH: ZAP }, isFile: files(ZAP), run, probe, tmpdir: dir, ...o.extra },
  }
}

test('scan: target không phải localhost ⇒ exit 3, không gọi gì (java, ZAP, mạng)', async () => {
  const w = world({ report: report([]) })
  let ran = 0
  const r = await scan({ ...w.opts, target: 'https://example.com', run: () => { ran++ }, probe: async () => { ran++ } })
  assert.equal(r.exit, 3)
  assert.equal(r.status, 'refused')
  assert.match(r.lines[0], /zap-scan từ chối: "example\.com" không phải máy này/)
  assert.equal(ran, 0)
})

test('scan: thiếu Java 17 hoặc ZAP ⇒ exit 3 kèm lệnh cài; ZAP không chạy, app không bị gọi', async () => {
  const noJava = world({ java: 11, report: report([]) })
  const a = await scan({ ...noJava.opts, platform: 'win32', env: { ZAP_PATH: 'C:\\z\\zap.bat' }, isFile: files('C:\\z\\zap.bat') })
  assert.equal(a.exit, 3)
  assert.match(a.lines.join('\n'), /thiếu Java 17\+ \(máy có Java 11\)[\s\S]*winget install -e --id EclipseAdoptium\.Temurin\.17\.JRE/)
  assert.equal(noJava.seen.zap.length, 0)
  assert.equal(noJava.probeCalls.length, 0)

  const noZap = world({ report: report([]) })
  const b = await scan({ ...noZap.opts, platform: 'darwin', env: {}, isFile: files() })
  assert.equal(b.exit, 3)
  assert.match(b.lines.join('\n'), /thiếu ZAP[\s\S]*brew install --cask zap/)
})

test('scan: app chưa chạy ⇒ exit 3 (không quét vào địa chỉ chết rồi báo sạch)', async () => {
  const w = world({ report: report([]), probe: { ok: false, detail: 'ECONNREFUSED' } })
  const r = await scan(w.opts)
  assert.equal(r.exit, 3)
  assert.match(r.lines[0], /app chưa chạy ở http:\/\/localhost:3000 \(ECONNREFUSED\)/)
  assert.equal(w.seen.zap.length, 0)
  assert.deepEqual(w.probeCalls, ['http://localhost:3000/'])
})

test('scan: ZAP chạy đúng lệnh, plan có target + thư mục báo cáo (chữ Việt thành \\u), plan tạm được dọn', async () => {
  const w = world({ report: report([]) })
  const r = await scan(w.opts)
  assert.equal(r.exit, 0)
  const [z] = w.seen.zap
  assert.equal(z.file, ZAP)
  assert.deepEqual(z.args.slice(0, 2), ['-cmd', '-autorun'])
  assert.equal(z.opts.cwd, '/opt/zaproxy') // zap.bat|zap.sh tìm jar theo đường tương đối
  assert.ok(w.seen.plan.includes('- "http://localhost:3000/"'))
  assert.ok(w.seen.plan.includes('reportFile: "zap-report"'))
  assert.match(w.seen.plan, /reportDir: ".*b\\u00e1o c\\u00e1o"/)
  assert.equal(fs.existsSync(w.seen.planFile), false)
  assert.equal(fs.existsSync(path.dirname(w.seen.planFile)), false)
})

test('scan: sạch ⇒ 0 (Low/Info không đổi mã, chỉ đếm)', async () => {
  const w = world({ report: report([LOW, INFO]) })
  const r = await scan(w.opts)
  assert.equal(r.exit, 0)
  assert.equal(r.status, 'clean')
  assert.deepEqual(r.counts, { high: 0, medium: 0, low: 1, info: 1, ignored: 0 })
  assert.match(r.lines[0], /^Sạch: không thấy lỗi mức cao hay vừa ở http:\/\/localhost:3000/)
  assert.match(r.lines.join('\n'), /Mức thấp: 1 · thông tin: 1/)
  assert.match(r.lines.at(-1), /^Báo cáo đầy đủ: .*zap-report\.json$/)
})

test('scan: có High ⇒ exit 1 (chặn), kể lỗi bằng lời kèm chỗ và cách sửa; Medium vẫn liệt kê', async () => {
  const w = world({ report: report([HIGH, MEDIUM, LOW]) })
  const r = await scan(w.opts)
  assert.equal(r.exit, 1)
  assert.equal(r.status, 'blocked')
  const text = r.lines.join('\n')
  assert.match(text, /CHẶN phát hành: 1 lỗi mức cao ở http:\/\/localhost:3000\./)
  assert.match(text, /- SQL Injection — 2 chỗ, vd http:\/\/localhost:3000\/api\/a\?id=1\. Sửa: Do not trust client side input\./)
  assert.match(text, /Cảnh báo \(không chặn\): 1 lỗi mức vừa/)
  assert.deepEqual(r.findings.map((f) => [f.name, f.risk, f.count]), [['SQL Injection', 'high', 2], [MEDIUM.name, 'medium', 1]])
})

// ---------- lời sửa tiếng Việt (BUG-7a) ----------

// pluginid thật trong báo cáo ZAP 2.17 mẫu của QA (10202 · 10038 · 10020 · 10010 · 10054 · 10021) + các cảnh báo hay gặp khác.
const FIX_CASES = [
  ['10038', 'Content Security Policy (CSP) Header Not Set', /Content-Security-Policy/],
  ['10020', 'Missing Anti-clickjacking Header', /X-Frame-Options|frame-ancestors/],
  ['10202', 'Absence of Anti-CSRF Tokens', /CSRF/],
  ['10010', 'Cookie No HttpOnly Flag', /HttpOnly/],
  ['10011', 'Cookie Without Secure Flag', /Secure/],
  ['10054', 'Cookie without SameSite Attribute', /SameSite/],
  ['10021', 'X-Content-Type-Options Header Missing', /X-Content-Type-Options/],
  ['10035', 'Strict-Transport-Security Header Not Set', /Strict-Transport-Security/],
  ['10036', 'Server Leaks Version Information via "Server" HTTP Response Header Field', /Server/],
  ['10037', 'Server Leaks Information via "X-Powered-By" HTTP Response Header Field(s)', /X-Powered-By/],
  ['90022', 'Application Error Disclosure', /lỗi/],
  ['10023', 'Information Disclosure - Debug Error Messages', /lỗi/],
]

test('fixVi: cảnh báo hay gặp (theo pluginid) có lời sửa tiếng Việt ngắn, một câu', () => {
  for (const [pluginid, name, re] of FIX_CASES) {
    const s = fixVi({ pluginid, name })
    assert.ok(s, `${pluginid} ${name}`)
    assert.match(s, re, pluginid)
    assert.match(s, /[ảạãăắằẳẵặấầẩẫậđéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i, `${pluginid} phải là tiếng Việt`)
    assert.ok(s.length <= 140, `${pluginid} dài ${s.length}`)
    assert.equal(/[.!?]\s+\S/.test(s), false, `${pluginid} chỉ một câu`)
  }
})

test('fixVi: pluginid lạ nhưng tên cảnh báo quen ⇒ vẫn ra lời Việt; không có trong bảng ⇒ null', () => {
  assert.match(fixVi({ pluginid: '999999', name: 'Content Security Policy (CSP) Header Not Set' }), /Content-Security-Policy/)
  assert.match(fixVi({ pluginid: '', name: 'Cookie No HttpOnly Flag' }), /HttpOnly/)
  assert.equal(fixVi({ pluginid: '40018', name: 'SQL Injection' }), null)
  assert.equal(fixVi({ pluginid: '10109', name: 'Modern Web Application' }), null)
  assert.equal(fixVi({}), null)
})

test('scan: dòng "Sửa:" của cảnh báo có trong bảng in tiếng Việt, không in tiếng Anh của ZAP; cảnh báo ngoài bảng giữ tiếng Anh cắt 140 chữ', async () => {
  const longEn = `Do not trust client side input. ${'Validate every parameter on the server side. '.repeat(8)}`
  const w = world({ report: report([alert(), alert({ pluginid: '40019', alertRef: '40019', name: 'Lỗi chưa có trong bảng', riskcode: '3', riskdesc: 'High (Medium)', solution: `<p>${longEn}</p>` })]) })
  const text = (await scan(w.opts)).lines.join('\n')
  assert.match(text, /- Content Security Policy \(CSP\) Header Not Set — 1 chỗ, vd http:\/\/localhost:3000\/\. Sửa: .*Content-Security-Policy.*[ảạăắấđéếíóốớúứý]/)
  assert.doesNotMatch(text, /Ensure that your web server/)
  const unknown = text.split('\n').find((l) => l.includes('Lỗi chưa có trong bảng'))
  assert.match(unknown, /Sửa: Do not trust client side input\./)
  assert.match(unknown, /…$/)
  assert.ok(unknown.slice(unknown.indexOf('Sửa: ') + 5).length === 140, 'cắt đúng 140 như cũ')
})

test('scan: cảnh báo trong bảng nhưng ZAP không kèm solution ⇒ vẫn có lời sửa Việt', async () => {
  const w = world({ report: report([alert({ solution: '' })]) })
  assert.match((await scan(w.opts)).lines.join('\n'), /Sửa: .*Content-Security-Policy/)
})

test('scan: chỉ Medium ⇒ exit 2 (cảnh báo, không chặn)', async () => {
  const w = world({ report: report([MEDIUM, LOW]) })
  const r = await scan(w.opts)
  assert.equal(r.exit, 2)
  assert.equal(r.status, 'warn')
  assert.match(r.lines[0], /^Cảnh báo \(không chặn\): 1 lỗi mức vừa/)
})

test('scan: danh sách miễn — còn hạn ⇒ bỏ; hết hạn ⇒ chặn lại và nói rõ; mục sai/ file hỏng ⇒ nói rõ, không miễn', async () => {
  const valid = world({ report: report([HIGH]), ignores: [{ rule: '40018', reason: 'báo nhầm: endpoint chỉ đọc', until: '2026-12-31' }] })
  const a = await scan(valid.opts)
  assert.equal(a.exit, 0)
  assert.deepEqual(a.counts, { high: 0, medium: 0, low: 0, info: 0, ignored: 1 })
  assert.match(a.lines.join('\n'), /Đã miễn 2 chỗ theo docs\/security-ignore\.json:\n {2}- SQL Injection \(rule 40018, đến 2026-12-31\) — báo nhầm: endpoint chỉ đọc/)

  const expired = world({ report: report([HIGH]), ignores: [{ rule: '40018', reason: 'tạm', until: '2026-10-12' }] })
  const b = await scan(expired.opts)
  assert.equal(b.exit, 1)
  assert.match(b.lines.join('\n'), /SQL Injection.*\(đã miễn đến 2026-10-12 nhưng hết hạn nên tính lại\)/)

  const invalid = world({ report: report([HIGH]), ignores: [{ rule: '40018', until: '2026-12-31' }] })
  const c = await scan(invalid.opts)
  assert.equal(c.exit, 1)
  assert.match(c.lines.join('\n'), /Mục miễn #1 không dùng được: thiếu reason \(lý do\)/)

  const broken = world({ report: report([HIGH]), ignores: '{ hỏng' })
  const d = await scan(broken.opts)
  assert.equal(d.exit, 1)
  assert.match(d.lines.join('\n'), /docs\/security-ignore\.json không phải JSON hợp lệ — không miễn mục nào/)

  const medOnly = world({ report: report([HIGH, MEDIUM]), ignores: [{ rule: '40018', reason: 'x', until: '2026-12-31' }] })
  assert.equal((await scan(medOnly.opts)).exit, 2) // bỏ High còn Medium ⇒ cảnh báo
})

test('scan: ZAP thoát khác 0 ⇒ exit 1 "quét không chạy xong", KHÔNG đọc báo cáo cũ còn sót, in đuôi log đã làm sạch', async () => {
  const w = world({ zapStatus: 1 })
  fs.mkdirSync(w.reportDir, { recursive: true })
  fs.writeFileSync(path.join(w.reportDir, 'zap-report.json'), report([])) // báo cáo "sạch" của lần trước
  const r = await scan(w.opts)
  assert.equal(r.exit, 1)
  assert.equal(r.status, 'failed')
  assert.match(r.lines[0], /Quét không chạy xong: ZAP thoát mã 1\. Không coi là sạch/)
  assert.match(r.lines.join('\n'), /ERROR something broke/)
  assert.doesNotMatch(r.lines.join('\n'), /\u001b/)
  assert.equal(fs.existsSync(path.join(w.reportDir, 'zap-report.json')), false)
})

test('scan: ZAP xong nhưng không có báo cáo / báo cáo rỗng hoặc hỏng ⇒ exit 1, không phải sạch', async () => {
  const none = await scan(world({}).opts)
  assert.equal(none.exit, 1)
  assert.match(none.lines[0], /không ghi báo cáo JSON/)
  for (const [report_, re] of [['<html>không phải json</html>', /không phải JSON/], ['{"site":[]}', /không có trang nào/]]) {
    const r = await scan(world({ report: report_ }).opts)
    assert.equal(r.exit, 1, report_)
    assert.match(r.lines[0], re)
  }
})

test('scan: ZAP thêm đuôi vào tên báo cáo (zap-report.json.json) vẫn tìm thấy', async () => {
  const r = await scan(world({ report: report([MEDIUM]), reportName: 'zap-report.json.json' }).opts)
  assert.equal(r.exit, 2)
  assert.match(r.reportFile, /zap-report\.json\.json$/)
})

test('scan: spawn lỗi — không thấy file ⇒ 3; hết giờ ⇒ 1; lỗi khác ⇒ 1', async () => {
  const gone = await scan(world({ zapError: Object.assign(new Error('x'), { code: 'ENOENT' }) }).opts)
  assert.equal(gone.exit, 3)
  const slow = world({ zapError: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), extra: { timeoutMs: 120_000 } })
  const t = await scan(slow.opts)
  assert.equal(t.exit, 1)
  assert.match(t.lines[0], /ZAP chạy quá 2 phút nên bị dừng/)
  assert.equal(slow.seen.zap[0].opts.timeoutMs, 120_000)
  const other = await scan(world({ zapError: Object.assign(new Error('EUNSAFE đường dẫn'), { code: 'EUNSAFE' }) }).opts)
  assert.equal(other.exit, 1)
  assert.match(other.lines[0], /EUNSAFE đường dẫn/)
})

test('scan: mẫu plan hỏng/mất ⇒ exit 1 có nói, không ném', async () => {
  const d = tmp()
  const bad = path.join(d, 'bad.yaml')
  fs.writeFileSync(bad, 'env: {}\n')
  const w = world({ report: report([]) })
  const r = await scan({ ...w.opts, templateFile: bad })
  assert.equal(r.exit, 1)
  assert.match(r.lines[0], /mẫu plan thiếu chỗ/)
  const gone = await scan({ ...w.opts, templateFile: path.join(d, 'khong-co.yaml') })
  assert.equal(gone.exit, 1)
  assert.equal(w.seen.zap.length, 0)
})

test('scan: chữ từ báo cáo ZAP có ký tự điều khiển ⇒ bị làm sạch trước khi in; liệt kê tối đa 8 lỗi', async () => {
  const evil = alert({ name: 'Bad\u001b[2Jname', pluginid: '1', instances: [{ uri: 'http://localhost:3000/\u0007x' }] })
  const many = Array.from({ length: 11 }, (_, i) => alert({ pluginid: String(500 + i), alertRef: String(500 + i), name: `Lỗi ${i}`, riskcode: '3', riskdesc: 'High (Low)' }))
  const r = await scan(world({ report: report([evil, ...many]) }).opts)
  const text = r.lines.join('\n')
  assert.doesNotMatch(text, /[\u001b\u0007]/)
  assert.match(text, /…và 3 lỗi khác/)
  assert.equal(r.lines.filter((l) => l.startsWith('  - ')).length, 8 + 1) // 8 mức cao liệt kê + 1 mức vừa
})

// Tiến trình THẬT (không phải ZAP): zap.bat|zap.sh giả đặt trong thư mục có dấu cách + chữ Việt, gọi qua defaultRun (Windows: cmd.exe /d /s /c).
// Kiểm cách dựng dòng lệnh, đối số, đọc plan YAML có \u-escape, ghi báo cáo, mã thoát — tất cả qua spawn thật.
test('scan + defaultRun với zap giả chạy bằng tiến trình thật (đường dẫn dấu cách/chữ Việt, đọc lại plan, ghi báo cáo)', async () => {
  const dir = tmp('zap giả ')
  const fake = path.join(dir, 'fake-zap.mjs')
  fs.writeFileSync(fake, [
    "import fs from 'node:fs'",
    'const args = process.argv.slice(2)',
    "const plan = fs.readFileSync(args[2], 'utf8')",
    "const val = (k) => JSON.parse(plan.split('\\n').find((l) => l.trim().startsWith(k + ': ')).trim().slice(k.length + 2))",
    "const high = { pluginid: '40018', alertRef: '40018', name: 'SQL Injection', riskcode: '3', riskdesc: 'High (Medium)', instances: [{ uri: 'http://localhost:4140/a' }], solution: '<p>Dùng truy vấn tham số hoá.</p>' }",
    "fs.writeFileSync(process.env.FAKE_ZAP_OUT, JSON.stringify({ args, reportDir: val('reportDir'), reportFile: val('reportFile'), target: JSON.parse(plan.split('\\n').find((l) => l.trim().startsWith('- \"http')).trim().slice(2)) }))",
    "fs.writeFileSync(val('reportDir') + '/' + val('reportFile') + '.json', JSON.stringify({ site: [{ '@name': 'http://localhost:4140', alerts: [high] }] }))",
    '',
  ].join('\n'))
  const win = process.platform === 'win32'
  const zap = path.join(dir, win ? 'zap.bat' : 'zap.sh')
  // chcp 65001: .bat đọc theo bảng mã OEM, đường dẫn chữ Việt trong file phải đọc là UTF-8
  const body = win ? `@echo off\r\nchcp 65001>nul\r\n"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`
  fs.writeFileSync(zap, body, { mode: 0o755 })
  const out = path.join(dir, 'ghi-lại.json')
  const reportDir = path.join(dir, 'báo cáo')
  const env = { ...process.env, ZAP_PATH: zap, FAKE_ZAP_OUT: out }
  const run = (file, args, o) => (file === zap ? defaultRun(file, args, o) : { status: 0, stdout: '', stderr: 'openjdk version "17.0.9"', error: null }) // Java giả; ZAP là tiến trình thật

  const r = await scan({ target: 'http://localhost:4140', reportDir, ignoreFile: path.join(dir, 'khong-co.json'), env, run, probe: async () => ({ ok: true }), tmpdir: dir, now: NOW })
  assert.equal(r.exit, 1, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /CHẶN phát hành: 1 lỗi mức cao ở http:\/\/localhost:4140\.\n {2}- SQL Injection — 1 chỗ, vd http:\/\/localhost:4140\/a\. Sửa: Dùng truy vấn tham số hoá\./)
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.deepEqual(seen.args.slice(0, 2), ['-cmd', '-autorun'])
  assert.match(seen.args[2], /plan\.yaml$/)
  assert.equal(seen.reportDir, path.resolve(reportDir)) // plan \u-escape đọc lại đúng chữ Việt
  assert.equal(seen.reportFile, 'zap-report')
  assert.equal(seen.target, 'http://localhost:4140/')

  // mã thoát khác 0 của tiến trình thật ⇒ quét không chạy xong
  fs.writeFileSync(fake, 'process.exit(7)\n')
  const bad = await scan({ target: 'http://localhost:4140', reportDir: path.join(dir, 'r2'), ignoreFile: path.join(dir, 'khong-co.json'), env, run, probe: async () => ({ ok: true }), tmpdir: dir, now: NOW })
  assert.equal(bad.exit, 1)
  assert.match(bad.lines[0], /ZAP thoát mã 7/)
})
