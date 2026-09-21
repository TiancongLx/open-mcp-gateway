#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

Write-Host '=== BUN VERSION ==='
bun --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '=== INSTALL ==='
bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '=== TSC ==='
bunx tsc --noEmit
$tscExit = $LASTEXITCODE
Write-Host "TSC_EXIT=$tscExit"

Write-Host '=== TEST ==='
bun test
$testExit = $LASTEXITCODE
Write-Host "TEST_EXIT=$testExit"

Write-Host "FINAL: tsc=$tscExit test=$testExit"
if ($tscExit -ne 0 -or $testExit -ne 0) { exit 1 }
exit 0
