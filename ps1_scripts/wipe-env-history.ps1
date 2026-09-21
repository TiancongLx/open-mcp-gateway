#Requires -Version 7.0
param(
    # 默认干跑：只验证前置条件与输出计划，不执行重写
    [switch]$DryRun = $true,
    # 跳过 force push（本地重写完成后单独确认）
    [switch]$SkipPush
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "== [0] 前置检查 =="
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { Write-Error 'git.exe 不可用'; exit 1 }

$status = git status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0) { exit 1 }
if ($status) { Write-Error "工作区不干净，中止：`n$status"; exit 1 }

$tracked = git ls-files -- .env .env.example
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "当前被跟踪的 env 文件: $($tracked -join ', ')"
if (-not $tracked) { Write-Host '两文件已不在索引中，无需重写'; exit 0 }

if ($DryRun) {
    Write-Host "`n== [DryRun] 将执行以下操作 =="
    Write-Host ' 1. git filter-branch -f --index-filter "git rm --cached --ignore-unmatch .env .env.example" --prune-empty -- --all'
    Write-Host ' 2. 删除 refs/original/*'
    Write-Host ' 3. git reflog expire --expire=now --all'
    Write-Host ' 4. git gc --prune=now --aggressive'
    Write-Host ' 5. 验证 git log --all -- .env .env.example 输出为空'
    if ($SkipPush) { Write-Host ' 6. （-SkipPush）跳过 force push，之后单独确认' }
    else { Write-Host ' 6. git push --force origin main   <- 远程历史全量重写' }
    exit 0
}

Write-Host "`n== [1] filter-branch 重写全部历史 =="
git filter-branch -f --index-filter "git rm --cached --ignore-unmatch .env .env.example" --prune-empty -- --all
if ($LASTEXITCODE -ne 0) { Write-Error 'filter-branch 失败'; exit 1 }

Write-Host "`n== [2] 清理 refs/original =="
$refs = git for-each-ref --format="%(refname)" refs/original
if ($LASTEXITCODE -ne 0) { exit 1 }
foreach ($r in $refs) { git update-ref -d $r }
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "`n== [3] reflog expire + gc =="
git reflog expire --expire=now --all
if ($LASTEXITCODE -ne 0) { exit 1 }
git gc --prune=now --aggressive
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "`n== [4] 验证历史中已无 env 文件 =="
$leak = git log --all --oneline -- .env .env.example
if ($LASTEXITCODE -ne 0) { exit 1 }
if ($leak) {
    Write-Error "验证失败：历史中仍存在引用：`n$leak"
    exit 1
}
Write-Host '验证通过：git log --all -- .env .env.example 输出为空'

if ($SkipPush) {
    Write-Host "`n-SkipPush 生效：跳过 force push。稍后执行: git push --force origin main"
    exit 0
}
Write-Host "`n== [5] force push origin main =="
git push --force origin main
if ($LASTEXITCODE -ne 0) { Write-Error 'force push 失败'; exit 1 }

Write-Host "`n完成。新 HEAD: $(git rev-parse --short HEAD)"
