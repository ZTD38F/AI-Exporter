<#
.SYNOPSIS
    Launch an isolated Google Chrome instance with remote debugging port 9222 and auto-loaded Gemini Exporter extension.
.DESCRIPTION
    Zero-personal-info script: dynamically resolves the user profile directory and repository root.
    Never exposes or hardcodes personal usernames, machine paths, or private data.
#>

$ErrorActionPreference = "Stop"

# 1. Dynamically resolve repository root (parent of scripts/)
$ScriptDir = $PSScriptRoot
$RepoDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path

# 2. Dynamically resolve isolated test profile directory in user's home (outside the git repo)
$ProfileDir = if ($env:GEMINI_EXPORTER_TEST_PROFILE) { $env:GEMINI_EXPORTER_TEST_PROFILE } else { Join-Path $env:USERPROFILE ".gemini-exporter-test-profile" }

# 3. Search standard Chrome installation locations on Windows
$CandidatePaths = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
)

$ChromeBin = $null
foreach ($Path in $CandidatePaths) {
    if ($Path -and (Test-Path -LiteralPath $Path)) {
        $ChromeBin = $Path
        break
    }
}

if (-not $ChromeBin) {
    $Command = Get-Command "chrome.exe" -ErrorAction SilentlyContinue
    if ($Command) {
        $ChromeBin = $Command.Source
    }
}

if (-not $ChromeBin) {
    Write-Error "[ERROR] Google Chrome was not found in standard paths. Please verify Google Chrome is installed."
    exit 1
}

# 4. Ensure profile directory exists
if (-not (Test-Path -LiteralPath $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}

# 4b. Ensure production bundles are fresh
Write-Host "🔨 Building extension bundles (node build.js)..." -ForegroundColor Cyan
Push-Location $RepoDir
try {
    node build.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "🚀 Launching Gemini Exporter Isolated Test Browser" -ForegroundColor Cyan
Write-Host "📁 Profile Directory : $ProfileDir" -ForegroundColor Gray
Write-Host "🧩 Extension Source  : $RepoDir" -ForegroundColor Gray
Write-Host "🌐 Remote Debug Port : 9222" -ForegroundColor Gray
Write-Host "💡 Default: background, no desktop windows. Use --headed for manual test-account login, quit Chrome, then relaunch normally." -ForegroundColor Yellow
Write-Host "==================================================" -ForegroundColor Cyan

# Use the same diagnostic launcher as macOS/Linux. Do not kill existing Chrome.
& python (Join-Path $ScriptDir "launch_test_chrome.py") --chrome $ChromeBin --profile $ProfileDir --repo $RepoDir -- "--disable-extensions-except=$RepoDir" "https://gemini.google.com" @args
exit $LASTEXITCODE
