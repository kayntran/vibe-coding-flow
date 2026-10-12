#!/bin/sh
# vibe-coding-flow: cài hoặc cập nhật bằng MỘT lệnh (macOS, Linux, Git Bash trên Windows):
#   curl -fsSL https://raw.githubusercontent.com/kayntran/vibe-coding-flow/main/install.sh | sh
#
# Làm theo thứ tự: kiểm git + node (thiếu ⇒ in lệnh cài một dòng rồi dừng) → chưa có kit ở ~/.claude thì tải về (sao lưu file
# trùng tên trước khi ghi đè), đã có thì `git pull --ff-only` (không kéo được thì dừng, KHÔNG ép) → node ~/.claude/install.mjs.
# Chạy lại bao nhiêu lần cũng an toàn. Windows PowerShell dùng install.ps1.
# Biến tuỳ chọn (dùng khi thử): VIBE_FLOW_REPO (mặc định repo chính thức), VIBE_FLOW_BRANCH (mặc định main).
# Viết theo POSIX sh. Toàn bộ nằm trong hàm main, chỉ được gọi ở dòng CUỐI: tải dở thì không chạy nửa chừng.

main() {
  repo="${VIBE_FLOW_REPO:-https://github.com/kayntran/vibe-coding-flow.git}"
  branch="${VIBE_FLOW_BRANCH:-main}"
  if [ -z "${HOME:-}" ]; then
    echo "Không tìm thấy thư mục cá nhân (HOME). Mở cửa sổ lệnh bình thường của tài khoản bạn rồi dán lại lệnh cài."
    return 1
  fi
  dir="$HOME/.claude"

  # 1. git + node (Node 18 trở lên)
  os="$(uname -s 2>/dev/null || echo unknown)"
  case "$os" in
    Darwin) git_hint="xcode-select --install"; node_hint="brew install node   (chưa có brew: tải bản LTS ở https://nodejs.org)" ;;
    MINGW*|MSYS*|CYGWIN*) git_hint="winget install --id Git.Git -e"; node_hint="winget install --id OpenJS.NodeJS.LTS -e" ;;
    *) git_hint="sudo apt install -y git   (hoặc dnf/pacman tuỳ máy)"; node_hint="tải bản LTS ở https://nodejs.org" ;;
  esac
  missing=""
  # `git --version` (không chỉ `command -v`): trên macOS chưa cài Command Line Tools, /usr/bin/git là bản giả chạy không được.
  git --version </dev/null >/dev/null 2>&1 || missing="$missing git"
  if command -v node >/dev/null 2>&1; then
    if ! node -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)' </dev/null >/dev/null 2>&1; then
      missing="$missing node(cần bản 18 trở lên)"
    fi
  else
    missing="$missing node"
  fi
  if [ -n "$missing" ]; then
    echo "Máy chưa đủ công cụ:$missing"
    echo "Cài bằng một dòng, rồi đóng cửa sổ lệnh, mở lại và dán lại lệnh cài:"
    case "$missing" in *git*) echo "  git : $git_hint" ;; esac
    case "$missing" in *node*) echo "  node: $node_hint" ;; esac
    return 1
  fi

  # 2. kéo kit về ~/.claude
  if [ -e "$dir/.git" ] && git -C "$dir" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    echo "Kit đã có ở $dir, đang cập nhật..."
    if ! git -C "$dir" pull --ff-only </dev/null; then
      echo "Không cập nhật được (git báo lỗi ở trên). Dừng lại, không ép ghi đè file của bạn."
      echo "Thường do bạn đã sửa/commit riêng trong $dir: xử lý cho khớp rồi chạy lại lệnh cài."
      return 1
    fi
  else
    echo "Cài kit lần đầu vào $dir ..."
    mkdir -p "$dir" || { echo "Không tạo được $dir"; return 1; }
    [ -e "$dir/.git" ] || git -C "$dir" init -q || { echo "git init không chạy được trong $dir"; return 1; }
    git -C "$dir" symbolic-ref HEAD "refs/heads/$branch" || return 1
    if git -C "$dir" remote get-url origin >/dev/null 2>&1; then
      git -C "$dir" remote set-url origin "$repo" || return 1
    else
      git -C "$dir" remote add origin "$repo" || return 1
    fi
    git -C "$dir" fetch -q origin "$branch" </dev/null || { echo "Không tải được kit từ $repo (kiểm tra mạng rồi chạy lại)."; return 1; }
    tmpd="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/vibe-flow-$$")"
    mkdir -p "$tmpd"
    git -C "$dir" show "origin/$branch:install.mjs" > "$tmpd/install.mjs" || { echo "Kit tải về thiếu install.mjs."; rm -rf "$tmpd"; return 1; }
    node "$tmpd/install.mjs" backup "origin/$branch" </dev/null
    status=$?
    rm -rf "$tmpd"
    [ "$status" -eq 0 ] || { echo "Không sao lưu được file trùng tên nên dừng, chưa ghi đè gì."; return 1; }
    git -C "$dir" checkout -q -f -t "origin/$branch" </dev/null || { echo "git checkout lỗi."; return 1; }
  fi

  # 3. ghép cấu hình cho mọi app có trên máy
  node "$dir/install.mjs" </dev/null
}

main "$@"
