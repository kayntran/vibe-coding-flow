// rule-files: MỘT nguồn trả lời "đường dẫn này có phải file luật không". File luật = file mà sửa nó là đổi cổng gộp / máy kiểm / luật kiến trúc
// của dự án (nới luật), nên mọi đường vòng qua cổng (cổng gộp, luu.mjs quay) phải dùng đúng danh sách này. Spec: docs/specs/2026-10-12-flow-v7-dot3 (PLAN mục 2, [j21n]).
//
// Danh sách = chép đúng chỗ "chống lách ở cổng gộp" của hooks/flow-gate.mjs:
//   - file luật kiến trúc/lint: isRuleFile của lib/arch.mjs (docs/arch.json, docs/arch-baseline.json, .dependency-cruiser*, .go-arch-lint*.y(a)ml, .golangci.*,
//     eslint.config.*, .eslintrc*, eslint-suppressions.json, biome.json(c), sgconfig.y(a)ml — khớp theo tên file ở mọi thư mục con)
//   - kit/rules/**                       (luật SAST của kit)
//   - kit/checkers.json, .claude/flow.json  (bảng checker của kit; cấu hình cổng của dự án)
// Thêm ở đợt 3: .claude/ui.json (máy kiểm giao diện), docs/ui-baseline.json (mốc giao diện), .claude/luu.json (đường dẫn dữ liệu của điểm lưu).
//
// Export:
//   isRuleFile(relPath, { archRuleFiles }) → boolean
//     relPath: đường dẫn tương đối từ gốc dự án (chấp nhận \ và ./ đầu); file chưa tồn tại cũng được (soi tên file trong diff).
//     archRuleFiles: thay phần "luật kiến trúc/lint" — hàm (rel) → boolean, hoặc danh sách đường dẫn (Array/Set). Bỏ trống ⇒ isRuleFile của lib/arch.mjs.
//   KIT_RULES · GATE_CONFIG · EXTRA_RULE_PATHS  (các mẫu ở trên, để cổng nhãn "loại luật" nếu cần)
import { isRuleFile as archIsRuleFile } from './arch.mjs'

export const KIT_RULES = /^kit\/rules\//
export const GATE_CONFIG = /^(kit\/checkers\.json|\.claude\/flow\.json)$/
export const EXTRA_RULE_PATHS = ['.claude/ui.json', 'docs/ui-baseline.json', '.claude/luu.json']

const normRel = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')

function archMatches(rel, archRuleFiles) {
  if (typeof archRuleFiles === 'function') return Boolean(archRuleFiles(rel))
  if (archRuleFiles && typeof archRuleFiles[Symbol.iterator] === 'function') {
    for (const f of archRuleFiles) if (normRel(f) === rel) return true
    return false
  }
  return archIsRuleFile(rel)
}

export function isRuleFile(relPath, { archRuleFiles } = {}) {
  const rel = normRel(relPath)
  if (!rel) return false
  if (KIT_RULES.test(rel) || GATE_CONFIG.test(rel) || EXTRA_RULE_PATHS.includes(rel)) return true
  return archMatches(rel, archRuleFiles)
}
