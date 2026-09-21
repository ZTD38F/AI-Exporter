#!/usr/bin/env bash
# scripts/open_test_chrome.sh - 一键拉起携带固化登录态与自动加载插件的独立 Chrome 窗口

set -e

PROFILE_DIR="$HOME/.gemini-exporter-test-profile"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 跨平台自动探测 Google Chrome 路径
CHROME_BIN=""
if [ "$(uname)" = "Darwin" ]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [ "$(expr substr $(uname -s) 1 5 2>/dev/null)" = "Linux" ]; then
  for candidate in google-chrome google-chrome-stable chromium-browser chromium; do
    if command -v "$candidate" >/dev/null 2>&1; then
      CHROME_BIN="$(command -v "$candidate")"
      break
    fi
  done
else
  # Windows (Git Bash / MSYS / Cygwin)
  for candidate in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe" \
    "$PROGRAMFILES/Google/Chrome/Application/chrome.exe"; do
    if [ -f "$candidate" ]; then
      CHROME_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$CHROME_BIN" ] || [ ! -f "$CHROME_BIN" ]; then
  echo "❌ 错误: 未在标准路径找到 Google Chrome: $CHROME_BIN"
  exit 1
fi

mkdir -p "$PROFILE_DIR"

echo "=================================================="
echo "🚀 正在启动 Gemini Exporter 专属持久化测试浏览器"
echo "📁 测试 Profile 目录: $PROFILE_DIR"
echo "🧩 自动挂载扩展源码: $REPO_DIR"
echo "💡 提示: 首次打开请在弹出的窗口中登录 Google 账号，后续将永远保持登录与插件就绪状态！"
echo "=================================================="

exec "$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$REPO_DIR" \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  "https://gemini.google.com" "$@"
