@echo off
setlocal enabledelayedexpansion

rem Dynamically resolve repository root (parent of scripts/)
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_DIR=%%~fI"

rem Dynamically resolve isolated test profile directory in user's profile (outside repo)
set "PROFILE_DIR=%USERPROFILE%\.gemini-exporter-test-profile"
if defined GEMINI_EXPORTER_TEST_PROFILE set "PROFILE_DIR=%GEMINI_EXPORTER_TEST_PROFILE%"

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

pushd "%REPO_DIR%"
node build.js
if errorlevel 1 exit /b 1
popd

echo ==================================================
echo [Launch] Gemini Exporter Isolated Test Browser
echo [Profile] %PROFILE_DIR%
echo [ExtDir]  %REPO_DIR%
echo [Port]    9222
echo [Notice]  Background by default. Use --headed for manual test-account login, quit Chrome, then relaunch normally.
echo ==================================================

python "%SCRIPT_DIR%launch_test_chrome.py" --chrome "%CHROME_BIN%" --profile "%PROFILE_DIR%" --repo "%REPO_DIR%" -- "--disable-extensions-except=%REPO_DIR%" "https://gemini.google.com" %*
exit /b %errorlevel%
