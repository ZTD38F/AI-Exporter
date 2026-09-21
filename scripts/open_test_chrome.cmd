@echo off
setlocal enabledelayedexpansion

rem Dynamically resolve repository root (parent of scripts/)
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_DIR=%%~fI"

rem Dynamically resolve isolated test profile directory in user's profile (outside repo)
set "PROFILE_DIR=%USERPROFILE%\.gemini-exporter-test-profile"

rem Search standard Chrome installation locations on Windows
set "CHROME_BIN="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_BIN=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_BIN=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_BIN=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if not defined CHROME_BIN (
    for %%X in (chrome.exe) do set "CHROME_BIN=%%~$PATH:X"
)

if not defined CHROME_BIN (
    echo [ERROR] Google Chrome was not found in standard paths.
    exit /b 1
)

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

echo ==================================================
echo [Launch] Gemini Exporter Isolated Test Browser
echo [Profile] %PROFILE_DIR%
echo [ExtDir]  %REPO_DIR%
echo [Port]    9222
echo [Notice]  Please log in with a dedicated TEST account.
echo ==================================================

start "" "%CHROME_BIN%" --user-data-dir="%PROFILE_DIR%" --disable-extensions-except="%REPO_DIR%" --load-extension="%REPO_DIR%" --remote-debugging-port=9222 --no-first-run --no-default-browser-check "https://gemini.google.com" %*
