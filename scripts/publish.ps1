<#
.SYNOPSIS
    明天的发布主力脚本：把「本地能做的事」一步做完。

.DESCRIPTION
    两档，边界清晰：

      -OnlyLocal （默认，不联网）
          git add -A → git commit（幂等） → 复跑 publish-checklist.mjs

      -Push
          额外校验 origin / 分支，然后 git push -u origin main

    这个脚本【永远不做】这些事：
      · npm publish          —— 需要登录态，属于用户
      · 调用 gh CLI          —— 本机没装 gh
      · 任何网页操作 / API   —— 没有浏览器自动化
      · --force / --force-with-lease / 改 reflog
        （push 后历史即公开，force 会毁掉已 fork 的分支）

    失败即停：任一步出错立刻中止并说明卡在哪，绝不带着错误继续。

.PARAMETER OnlyLocal
    只做本地提交与自检，不联网。（默认行为，显式写出来便于阅读脚本时理解）

.PARAMETER Push
    在 -OnlyLocal 之后推送到 origin/main。

.EXAMPLE
    .\scripts\publish.ps1
    .\scripts\publish.ps1 -Push
#>
[CmdletBinding()]
param(
    [switch]$OnlyLocal,
    [switch]$Push
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 预置远端地址：仅在 origin 缺失时使用，绝不覆盖已有配置。
$DefaultRemote = 'https://github.com/Wahwayhale/dsh-connect-doubao.git'
$MainBranch = 'main'

# 解析仓库根目录（本脚本位于 <root>/scripts/）。
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = (Get-Location).Path }

function Write-Step  { param([string]$m) Write-Host "`n▶ $m" -ForegroundColor Cyan }
function Write-Ok    { param([string]$m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn2 { param([string]$m) Write-Host "  ! $m" -ForegroundColor Yellow }

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$GitArgs)
    Write-Host "    git $($GitArgs -join ' ')" -ForegroundColor DarkGray

    # `$ErrorActionPreference = 'Stop'` turns ANY native-command stderr into a
    # terminating error, and git writes harmless warnings there — e.g. the
    # "LF will be replaced by CRLF" notice on a fresh index. That aborted an
    # otherwise fine run. So: relax the preference for the call itself and judge
    # success ONLY by the exit code.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git @GitArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        $text = ($out | Out-String).Trim()
        throw "git $($GitArgs -join ' ') 失败（退出码 $code）：`n$text"
    }
    return $out
}

try {
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " dsh-connect-doubao 发布脚本" -ForegroundColor Cyan
    Write-Host " 仓库: $RepoRoot" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan

    # ---------------------------------------------------------------
    Write-Step '0/4 校验前置条件'

    if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
        throw '这不是一个 git 仓库（缺少 .git）。先执行： git init'
    }
    Write-Ok 'git 仓库存在'

    if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
        throw '缺少 package.json —— 目录不对？'
    }
    Write-Ok 'package.json 存在'

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        throw '找不到 node，无法运行 publish-checklist.mjs。请先安装 Node.js。'
    }
    Write-Ok 'node 可用'

    # ---------------------------------------------------------------
    Write-Step '1/4 暂存全部变更'

    # 幂等：重复执行只是把当前工作区状态重新写入暂存区，无副作用。
    $status = Invoke-Git @('status', '--short')
    Invoke-Git @('add', '-A') | Out-Null
    $after = Invoke-Git @('status', '--short')
    $staged = @($after | Where-Object { $_ -match '^\S' }).Count
    Write-Ok "已暂存 $staged 个待提交条目"

    # ---------------------------------------------------------------
    Write-Step '2/4 提交（幂等）'

    # 幂等的关键：先问 git「有没有东西要提交」，而不是直接 commit 然后处理报错。
    # 用户很可能把这条命令跑两遍，第二遍必须安静通过。
    $stagedPaths = @(Invoke-Git @('diff', '--cached', '--name-only'))
    if ($stagedPaths.Count -eq 0) {
        Write-Warn2 '暂存区为空 —— 没有新变更需要提交，跳过 commit。'
        Write-Host '    （这是正常的：重复运行本脚本时就会走到这里）'
    } else {
        $preview = ($stagedPaths | Select-Object -First 12) -join ', '
        if ($stagedPaths.Count -gt 12) { $preview += " … 等 $($stagedPaths.Count) 项" }
        Write-Host "    待提交：$preview" -ForegroundColor DarkGray
        Invoke-Git @('commit', '-m', 'Initial release: DSH Connect Doubao') | Out-Null
        $head = (Invoke-Git @('log', '--oneline', '-1')).Trim()
        Write-Ok "已提交：$head"
    }

    # ---------------------------------------------------------------
    Write-Step '3/4 复跑发布前自检'

    $check = Join-Path $RepoRoot 'scripts\publish-checklist.mjs'
    & node $check
    $checkExit = $LASTEXITCODE
    if ($checkExit -ne 0) {
        throw "发布前自检未通过（退出码 $checkExit）。上面的 FAIL 项就是阻塞点，先修再继续。"
    }
    Write-Ok '自检全绿'

    # ---------------------------------------------------------------
    if ($Push) {
        Write-Step '4/4 推送到 origin'

        # ---- origin ----
        $remotes = @(Invoke-Git @('remote'))
        if ($remotes -notcontains 'origin') {
            Write-Host "    origin 不存在，使用预置地址添加：$DefaultRemote" -ForegroundColor Yellow
            Invoke-Git @('remote', 'add', 'origin', $DefaultRemote) | Out-Null
        } else {
            $originUrl = (Invoke-Git @('remote', 'get-url', 'origin')).Trim()
            Write-Ok "origin = $originUrl"
            if ($originUrl -ne $DefaultRemote) {
                Write-Warn2 "origin 与预置地址不同：$originUrl"
                Write-Host "    （保留你的设置，未做任何修改）" -ForegroundColor DarkGray
            }
        }

        # ---- 分支 ----
        $branch = (Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')).Trim()
        if ($branch -ne $MainBranch) {
            Write-Host "    当前分支 $branch → 重命名为 $MainBranch" -ForegroundColor Yellow
            Invoke-Git @('branch', '-M', $MainBranch) | Out-Null
        }
        Write-Ok "当前分支：$MainBranch"

        # ---- push（永不 force）----
        Invoke-Git @('push', '-u', 'origin', $MainBranch) | Out-Null
        Write-Ok '已推送'
        Write-Host ''
        Write-Host '  ✅ 下一步（需要你在浏览器做，脚本做不了）：' -ForegroundColor Green
        Write-Host '     1) 打开 https://github.com/Wahwayhale/dsh-connect-doubao' -ForegroundColor Green
        Write-Host '     2) 右侧 Topics 点「Add a topic」→ 输入 dsh-plugin → Add' -ForegroundColor Green
        Write-Host '     3) 确认仓库已创建满 24 小时（市场 CI 的硬性要求 R4）' -ForegroundColor Green
    } else {
        Write-Step '4/4 跳过推送'
        Write-Host '  本地已就绪。远端仓库建好后，加 -Push 重跑即可：' -ForegroundColor Yellow
        Write-Host '    .\scripts\publish.ps1 -Push' -ForegroundColor Yellow
    }

    # ---------------------------------------------------------------
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host ' 结论：本地已就绪，可以推进' -ForegroundColor Green
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host ' 现在能不能提 PR？—— 还不能，差两步：' -ForegroundColor Yellow
    Write-Host '   1. 仓库必须【已创建满 24 小时】（市场 CI 硬性规则 R4）' -ForegroundColor Yellow
    Write-Host '      · 今天建仓 → 最早明天提 PR' -ForegroundColor Yellow
    Write-Host '   2. 仓库必须已打 dsh-plugin topic' -ForegroundColor Yellow
    Write-Host ''
    Write-Host ' 完整步骤见 RELEASE-CHECKLIST.md' -ForegroundColor Cyan
    exit 0

} catch {
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Red
    Write-Host ' ✗ 中止 —— 上一步失败，已停止，未继续执行后续动作' -ForegroundColor Red
    Write-Host '============================================================' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ''
    Write-Host ' 没有做任何 --force、没有 push、没有 publish。修复后重跑本脚本即可。' -ForegroundColor DarkYellow
    exit 1
}
