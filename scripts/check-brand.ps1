[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$BlockedPattern = "即投|Boss Hunter|boss hunter|BossHunter|BOSS Hunter"
$ScanTargets = @(
    "README.md",
    "LOAD_TEST.md",
    "TODO.md",
    "manifest.json",
    "src"
)

$existingTargets = @(
    foreach ($target in $ScanTargets) {
        $path = Join-Path $ProjectRoot $target
        if (Test-Path -LiteralPath $path) {
            $path
        }
    }
)

$hits = @()
foreach ($path in $existingTargets) {
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer) {
        $files = Get-ChildItem -LiteralPath $item.FullName -Recurse -File
    } else {
        $files = @($item)
    }

    foreach ($file in $files) {
        $matches = Select-String -LiteralPath $file.FullName -Pattern $BlockedPattern -Encoding UTF8
        foreach ($match in $matches) {
            $relative = [System.IO.Path]::GetRelativePath($ProjectRoot, $match.Path)
            $hits += "${relative}:$($match.LineNumber):$($match.Line.Trim())"
        }
    }
}

if ($hits.Count -gt 0) {
    Write-Host "旧品牌残留检查失败："
    $hits | ForEach-Object { Write-Host $_ }
    exit 1
}

$manifestPath = Join-Path $ProjectRoot "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$manifest.name -ne "猎职") {
    throw "manifest.name must be 猎职, actual: $($manifest.name)"
}

if ($null -eq $manifest.action -or [string]$manifest.action.default_title -ne "猎职") {
    throw "manifest.action.default_title must be 猎职, actual: $($manifest.action.default_title)"
}

Write-Host "BRAND_CHECK_OK"
