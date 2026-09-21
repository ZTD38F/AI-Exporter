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
$ProfileDir = Join-Path $env:USERPROFILE ".gemini-exporter-test-profile"

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

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "🚀 Launching Gemini Exporter Isolated Test Browser" -ForegroundColor Cyan
Write-Host "📁 Profile Directory : $ProfileDir" -ForegroundColor Gray
Write-Host "🧩 Extension Source  : $RepoDir" -ForegroundColor Gray
Write-Host "🌐 Remote Debug Port : 9222" -ForegroundColor Gray
Write-Host "💡 Hint: Please log in with a dedicated TEST account (avoid using your primary personal account)." -ForegroundColor Yellow
Write-Host "==================================================" -ForegroundColor Cyan

# 5. Launch Chrome with isolated profile, loaded extension, and remote debugging enabled
$ChromeArgs = @(
    "--user-data-dir=$ProfileDir",
    "--disable-extensions-except=$RepoDir",
    "--load-extension=$RepoDir",
    "--remote-debugging-port=9222",
    "--no-first-run",
    "--no-default-browser-check",
    "https://gemini.google.com"
) + $args

Start-Process -FilePath $ChromeBin -ArgumentList $ChromeArgs
