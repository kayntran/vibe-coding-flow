# vibe-coding-flow: cai hoac cap nhat bang MOT lenh, dan vao Windows PowerShell (5.1 tro len):
#   irm https://raw.githubusercontent.com/kayntran/vibe-coding-flow/main/install.ps1 | iex
# Tu CMD:  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/kayntran/vibe-coding-flow/main/install.ps1 | iex"
#
# Lam theo thu tu: kiem git + node (thieu => in lenh cai mot dong roi dung) -> chua co kit o ~\.claude thi tai ve (sao luu file
# trung ten truoc khi ghi de), da co thi `git pull --ff-only` (khong keo duoc thi dung, KHONG ep) -> node ~\.claude\install.mjs.
# Chay lai bao nhieu lan cung an toan. macOS/Linux/Git Bash dung install.sh.
# Bien tuy chon (dung khi thu): VIBE_FLOW_REPO (mac dinh repo chinh thuc), VIBE_FLOW_BRANCH (mac dinh main).
#
# File nay CHI DUNG ky tu ASCII (viet tieng Viet khong dau): Windows PowerShell 5.1 doc file .ps1 khong co BOM theo bang ma ANSI,
# chu co dau (vd "d" gach ngang) se thanh dau nhay thong minh va lam vo chuoi lenh khi chay bang -File. Phan chu co dau
# do install.mjs (Node, UTF-8) in ra.
# Viet cho PowerShell 5.1: khong dung && / || / ?: / ?? (chi co o PowerShell 7).
# Chay qua `irm | iex` thi KHONG duoc `exit` (se dong cua so cua nguoi dung): chi `exit` khi chay bang -File (co $PSCommandPath).
# Lenh git/node goi truc tiep, khong qua duong ong, de chu cua install.mjs hien dung tren man hinh.

function Install-VibeFlow {
  $repo = $env:VIBE_FLOW_REPO
  if (-not $repo) { $repo = 'https://github.com/kayntran/vibe-coding-flow.git' }
  $branch = $env:VIBE_FLOW_BRANCH
  if (-not $branch) { $branch = 'main' }
  $userHome = $env:USERPROFILE
  if (-not $userHome) { $userHome = $HOME }
  $dir = Join-Path $userHome '.claude'

  # 1. git + node (Node 18 tro len)
  $missing = @()
  $needGit = -not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)
  $needNode = -not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)
  if ($needGit) { $missing += 'git' }
  if ($needNode) {
    $missing += 'node'
  } else {
    $nodeMajor = 0
    $nodeVersion = & node -p 'process.versions.node'
    if ($nodeVersion) { $nodeMajor = [int](([string]$nodeVersion).Split('.')[0]) }
    if ($nodeMajor -lt 18) { $needNode = $true; $missing += 'node (can ban 18 tro len)' }
  }
  if ($missing.Count -gt 0) {
    Write-Host ('May chua du cong cu: ' + ($missing -join ', '))
    Write-Host 'Cai bang mot dong, roi dong cua so PowerShell, mo lai va dan lai lenh cai:'
    if ($needGit) { Write-Host '  git : winget install --id Git.Git -e' }
    if ($needNode) { Write-Host '  node: winget install --id OpenJS.NodeJS.LTS -e' }
    Write-Host '(Khong co winget: tai o https://git-scm.com va https://nodejs.org)'
    $global:LASTEXITCODE = 1
    return
  }

  # 2. keo kit ve ~\.claude
  $hasCommit = $false
  if (Test-Path -LiteralPath (Join-Path $dir '.git')) {
    & git -C $dir rev-parse --verify -q HEAD *> $null
    if ($LASTEXITCODE -eq 0) { $hasCommit = $true }
  }
  if ($hasCommit) {
    Write-Host ('Kit da co o ' + $dir + ', dang cap nhat...')
    & git -C $dir pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Khong cap nhat duoc (git bao loi o tren). Dung lai, khong ep ghi de file cua ban.'
      Write-Host ('Thuong do ban da sua/commit rieng trong ' + $dir + ': xu ly cho khop roi chay lai lenh cai.')
      $global:LASTEXITCODE = 1
      return
    }
  } else {
    Write-Host ('Cai kit lan dau vao ' + $dir + ' ...')
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $dir '.git'))) {
      & git -C $dir init -q
      if ($LASTEXITCODE -ne 0) { Write-Host ('git init khong chay duoc trong ' + $dir); $global:LASTEXITCODE = 1; return }
    }
    & git -C $dir symbolic-ref HEAD ('refs/heads/' + $branch)
    if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 1; return }
    & git -C $dir remote get-url origin *> $null
    if ($LASTEXITCODE -eq 0) { & git -C $dir remote set-url origin $repo } else { & git -C $dir remote add origin $repo }
    if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 1; return }
    & git -C $dir fetch -q origin $branch
    if ($LASTEXITCODE -ne 0) {
      Write-Host ('Khong tai duoc kit tu ' + $repo + ' (kiem tra mang roi chay lai).')
      $global:LASTEXITCODE = 1
      return
    }
    # Lay install.mjs cua kit ra file tam bang Start-Process (ghi thang byte, khong qua bo giai ma chu cua PowerShell 5.1).
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('vibe-flow-install-' + [Guid]::NewGuid().ToString('N') + '.mjs')
    $show = Start-Process -FilePath git -ArgumentList @('-C', ('"' + $dir + '"'), 'show', ('origin/' + $branch + ':install.mjs')) -RedirectStandardOutput $tmp -NoNewWindow -Wait -PassThru
    if ($show.ExitCode -ne 0) {
      Write-Host 'Kit tai ve thieu install.mjs.'
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      $global:LASTEXITCODE = 1
      return
    }
    & node $tmp backup ('origin/' + $branch)
    $backupExit = $LASTEXITCODE
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    if ($backupExit -ne 0) {
      Write-Host 'Khong sao luu duoc file trung ten nen dung, chua ghi de gi.'
      $global:LASTEXITCODE = 1
      return
    }
    & git -C $dir checkout -q -f -t ('origin/' + $branch)
    if ($LASTEXITCODE -ne 0) { Write-Host 'git checkout loi.'; $global:LASTEXITCODE = 1; return }
  }

  # 3. ghep cau hinh cho moi app co tren may
  & node (Join-Path $dir 'install.mjs')
}

Install-VibeFlow
if ($PSCommandPath -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
