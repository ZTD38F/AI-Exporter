#!/usr/bin/env bash
set -euo pipefail

# Ubuntu's AppArmor restriction blocks downloaded Chromium binaries from
# creating the user namespace required by the browser sandbox.
# Restrict the exception to this ephemeral GitHub runner's Playwright cache.
if [[ "$(uname -s)" != "Linux" ]]; then
  exit 0
fi
if [[ "${GITHUB_ACTIONS:-}" != "true" || "$HOME" != "/home/runner" ]]; then
  echo "Playwright AppArmor provisioning is restricted to GitHub-hosted Ubuntu runners." >&2
  exit 1
fi

policy=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [[ ! -f "$policy" || "$(cat "$policy")" != "1" ]]; then
  echo "AppArmor does not restrict unprivileged user namespaces on this runner."
  exit 0
fi

sudo tee /etc/apparmor.d/gemini-exporter-playwright >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile gemini-exporter-playwright-chromium /home/runner/.cache/ms-playwright/chromium-*/**/chrome flags=(unconfined) {
  userns,
}

profile gemini-exporter-playwright-headless /home/runner/.cache/ms-playwright/chromium_headless_shell-*/**/chrome-headless-shell flags=(unconfined) {
  userns,
}
PROFILE

sudo apparmor_parser -r /etc/apparmor.d/gemini-exporter-playwright
echo "Chromium user namespaces allowed for the Playwright test browser binaries only."
