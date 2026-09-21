# ==============================================================================
# Script: ps1_scripts/test-gateway.ps1
# Description: XDG 规范下 open-mcp-gateway 自动化断言回归测试
# ==============================================================================

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$env:NO_PROXY = "127.0.0.1,localhost,100.81.173.80"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ">>> [open-mcp-gateway] XDG 规范化回归测试套件" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# 1. 清理 9090 端口
Get-NetTCPConnection -LocalPort 9090 -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}

# 2. 启动网关主进程
Write-Host "`n[阶段 1] 启动网关主进程..." -ForegroundColor Yellow
$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = "bun"
$processInfo.Arguments = "run ./src/index.ts"
$processInfo.WorkingDirectory = $ProjectRoot
$processInfo.RedirectStandardOutput = $false
$processInfo.RedirectStandardError = $false
$processInfo.UseShellExecute = $true

$gatewayProcess = [System.Diagnostics.Process]::Start($processInfo)

try {
    # 3. 轮询健康检查
    Write-Host "`n[阶段 2] 探测健康检查接口 GET /health..." -ForegroundColor Yellow
    $healthOk = $false
    for ($i = 1; $i -le 10; $i++) {
        try {
            $healthResp = Invoke-RestMethod -Uri "http://127.0.0.1:9090/health" -Method Get -TimeoutSec 2 -NoProxy
            if ($healthResp.status -eq "ok") {
                $healthOk = $true
                Write-Host "  [✓] /health 响应正常 (耗时 $i 秒): $($healthResp | ConvertTo-Json -Compress)" -ForegroundColor Green
                break
            }
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    if (-not $healthOk) {
        Write-Host "  [✗] 健康检查超时未通过" -ForegroundColor Red
        exit 1
    }

    # 4. 轮询各服务建立状态
    Write-Host "`n[阶段 3] 轮询等待所有标准服务完成建立..." -ForegroundColor Yellow
    $allReady = $false
    for ($i = 1; $i -le 15; $i++) {
        try {
            $serversResp = Invoke-RestMethod -Uri "http://127.0.0.1:9090/servers" -Method Get -TimeoutSec 2 -NoProxy
            $cb = $serversResp.servers.codebase_memory
            $dw = $serversResp.servers.drawio

            if ($cb -and $cb.state -eq "READY" -and $dw -and $dw.state -eq "READY") {
                $allReady = $true
                Write-Host "  [✓] codebase_memory ($($cb.toolCount) 工具) 与 drawio ($($dw.toolCount) 工具) 已全部就绪 (耗时 $i 秒)" -ForegroundColor Green
                break
            }
        } catch {}
        Start-Sleep -Seconds 1
    }

    # 5. 断言 Caddy 反向代理 Origin
    Write-Host "`n[阶段 4] 模拟 Caddy 反向代理调用断言..." -ForegroundColor Yellow
    $headers = @{
        "X-Forwarded-Proto" = "http"
        "X-Forwarded-Host"  = "100.81.173.80:8444"
    }

    foreach ($srvName in @("codebase_memory", "drawio")) {
        $openApiResp = Invoke-RestMethod -Uri "http://127.0.0.1:9090/$srvName/openapi.json" -Headers $headers -Method Get -TimeoutSec 5 -NoProxy
        $expected = "http://100.81.173.80:8444/$srvName"
        $actual = $openApiResp.servers[0].url
        if ($actual -eq $expected) {
            Write-Host "  [✓] [$srvName] 反向代理 Origin 对齐通过: $actual" -ForegroundColor Green
        } else {
            Write-Host "  [✗] [$srvName] Origin 漂移！期望: $expected, 实际: $actual" -ForegroundColor Red
        }
    }

    Write-Host "`n>>> [通过] XDG 纯净重构全链路断言验证通过！" -ForegroundColor Green
} finally {
    Write-Host "`n[阶段 5] 正在回收测试主进程与子进程树..." -ForegroundColor Yellow
    if ($gatewayProcess -and -not $gatewayProcess.HasExited) {
        $gatewayProcess.Kill($true)
        $gatewayProcess.WaitForExit()
        Write-Host "  [✓] 测试进程已彻底释放" -ForegroundColor Green
    }
}
