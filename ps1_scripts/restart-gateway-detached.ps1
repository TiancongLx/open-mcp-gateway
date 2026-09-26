#Requires -Version 7.0
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 网关脱离式重启（迁移铁律：工具桥即网关进程树，必须经 schtasks 自任务执行，
# 勿在工具会话内同步杀进程——会连坐自杀）。用法：
#   schtasks /Create /TN omg-restart /TR "pwsh -NoProfile -ExecutionPolicy Bypass -File <本文件>" /RU root /IT /SC ONCE /SD 2020/01/01 /ST 00:00 /F
#   schtasks /Run /TN omg-restart

$repo = 'C:/Users/root/_Repositories/open-webui-third-party/open-mcp-gateway'

# 停旧：按 9090 端口监听者定位（勿按命令行过滤——脚本文本自匹配会误杀）
Get-NetTCPConnection -LocalPort 9090 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    & taskkill.exe /PID $_.OwningProcess /T /F 2>&1 | Out-Null
}
Start-Sleep -Seconds 1

# 起新（脱离式，脚本退出后进程继续存活）
Start-Process -FilePath 'C:\Users\root\scoop\shims\bun.exe' `
    -ArgumentList 'run', './src/index.ts' `
    -WorkingDirectory $repo `
    -WindowStyle Hidden

# 等待就绪探针
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:9090/health' -TimeoutSec 2 -NoProxy
        if ($r.status -eq 'ok') {
            Write-Host '[restart] gateway healthy'
            exit 0
        }
    } catch {
        # 尚未就绪，继续等待
    }
}
Write-Error '[restart] gateway not healthy after 10s'
exit 1
