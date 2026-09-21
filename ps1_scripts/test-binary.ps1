# ==============================================================================
# Script: ps1_scripts/test-binary.ps1
# Purpose: 在不干扰运行中网关 (9090) 的前提下，在线测试 build/open-mcp-gateway.exe
#          （端口 9191，临时配置副本，结束即杀进程+清理）
# ==============================================================================
#Requires -Version 7.0
param(
    [switch]$DryRun = $true,
    [int]$Port = 9191
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Binary = Join-Path $ProjectRoot 'build/open-mcp-gateway.exe'
$XdgConfig = Join-Path $env:USERPROFILE '.config/open-mcp-gateway/config.json5'
$TmpDir = Join-Path $env:TEMP "open-mcp-gateway-test-$PID"
$TmpConfig = Join-Path $TmpDir 'config.json5'

Write-Host "== 前置检查 =="
foreach ($p in @($Binary, $XdgConfig)) {
    if (-not (Test-Path $p)) { Write-Error "缺少文件: $p"; exit 1 }
}

# 端口占用检查
$occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupied) { Write-Error "端口 $Port 已被占用 (PID $($occupied.OwningProcess))"; exit 1 }

if ($DryRun) {
    Write-Host "[DryRun] 将执行:"
    Write-Host " 1. mkdir $TmpDir; 复制 $XdgConfig -> $TmpConfig，port 改为 $Port"
    Write-Host " 2. env MCP_OPEN_GATEWAY_CONFIG=$TmpConfig 启动 $Binary (后台, 记录 PID)"
    Write-Host " 3. 轮询 GET /health, /servers; 拿 /servers 里第一个 READY 服务, POST /<server>/<tool> 做代理往返"
    Write-Host " 4. Stop-Process 新实例; Remove-Item $TmpDir -Recurse"
    exit 0
}

try {
    # 1. 临时配置
    New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
    (Get-Content $XdgConfig -Raw) -replace 'port:\s*\d+', "port: $Port" | Set-Content $TmpConfig -NoNewline
    if (-not (Select-String -Path $TmpConfig -Pattern "port: $Port" -Quiet)) {
        Write-Error '临时配置端口替换失败'; exit 1
    }

    # 2. 启动新二进制（独立进程，不碰运行中的 9090 实例）
    $env:MCP_OPEN_GATEWAY_CONFIG = $TmpConfig
    $proc = Start-Process -FilePath $Binary -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $TmpDir 'stdout.log') `
        -RedirectStandardError (Join-Path $TmpDir 'stderr.log')
    Write-Host "新实例 PID: $($proc.Id) (端口 $Port)"

    # 3. 等待健康检查就绪（最多 30s）
    $ready = $false
    foreach ($i in 1..30) {
        Start-Sleep -Milliseconds 1000
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($health.status -eq 'ok') { $ready = $true; break }
        } catch {}
    }
    if (-not $ready) { throw '健康检查 30s 内未就绪' }
    Write-Host "/health OK: poolReady=$($health.poolReady) uptime=$([math]::Round($health.uptime,1))s"

    # 4. /servers
    $servers = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/servers" -TimeoutSec 10
    $readyServers = @($servers.servers.PSObject.Properties | Where-Object { $_.Value.state -eq 'READY' })
    Write-Host "/servers: $($readyServers.Count) 个 READY 服务 ($(@($servers.servers.PSObject.Properties).Count) 总)"
    if ($readyServers.Count -eq 0) { throw '无 READY 服务可测' }

    # 5. 至少一个工具代理往返（取第一个 READY 服务的第一个工具，空 body POST）
    $target = $readyServers[0]
    $tool = @($target.Value.tools)[0]
    $url = "http://127.0.0.1:$Port/$($target.Name)/$tool"
    Write-Host "代理往返: POST $url"
    try {
        $resp = Invoke-RestMethod -Uri $url -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 60
        Write-Host "往返 OK (返回字段: $(@($resp.PSObject.Properties).Count) 个)"
    } catch {
        # 工具可能要求参数返回 400 属于"网关代理链路通"的证据，可接受
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 400) {
            Write-Host "往返 OK (网关返回 400 参数校验，链路通)"
        } else { throw }
    }

    Write-Host "`n== 全部断言通过 =="
    exit 0
}
finally {
    if (Get-Variable proc -ErrorAction SilentlyContinue -ValueOnly) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "已终止测试实例 PID $($proc.Id)"
    }
    if (Test-Path $TmpDir) {
        Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "已清理 $TmpDir"
    }
}
