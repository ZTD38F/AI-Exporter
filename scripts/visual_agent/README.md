# Tier 3 visual test workflow

Use the isolated Chrome debugging endpoint (9222), never a personal browser profile.
The explorer sees screenshots only and operates through the seven visual CLI primitives.
The host prepares the browser; the explorer must not read DOM or application source.

## CLI target arguments and extension identity

Shared `--target`, `--port`, and `--json` arguments work before or after the
subcommand. For example, `cli.py --target popup --json screenshot` and
`cli.py screenshot --target popup --json` observe the same requested target.
An explicitly requested target must never silently become the last active page.

Discovery recognizes exact Exporter entrypoints, including the production
`dist/background/background.js` worker. Unrelated extensions are never fallback
candidates; ambiguous Exporter installations fail explicitly. Clean reinstallation
uses the ID returned by Chrome for the requested workspace path and stops on identity
or uninstall failure, rather than claiming a clean install after a failed removal.

## Fresh install / disconnected onboarding

Stop the previous isolated debugging browser before switching profiles. Preserve its profile
and database for the historical-conversation regression. Start a separate, empty profile:

```bash
GEMINI_EXPORTER_TEST_PROFILE=/absolute/path/to/new-test-profile bash scripts/open_test_chrome.sh --no-gemini
```

Do not open Gemini during preparation. Verify the target inventory contains no Gemini
page. Let the extension installation open its own onboarding Options page. Capture and
verify step 1. The explorer must click the visible “Open Gemini” action itself, verify
the real connection and automatic step advancement, and then continue the guide. Manually
clicking Next is not evidence of a successful connection. If connecting requires a
login, report that prerequisite; do not count later steps as proof of step 1. Use a fresh,
context-free visual explorer and save screenshots, a scorecard, and an HTML report.

For a complete first-connect test without an interactive login prerequisite, clone the
signed-in isolated test profile while Chrome is closed, preserve its login cookies, and
cleanly reinstall the extension only in the clone. Start that clone with `--no-gemini` as
well. The explorer must still perform the first Open Gemini action and verify connection.
Never uninstall or clear the original history profile just to repeat onboarding.

## Page and screenshot readiness

Requested targets are matched to the selected extension and exact page path. An unavailable
target must time out explicitly, never fall back to another website or to Options when Popup
was requested. A Popup opened as a tab does not prove real toolbar-popup context binding.

PNG dimensions must equal the coordinates' viewport. The screenshot primitive retries
resize/compositor races with a bounded limit and fails if they persist. Do not act on an
image that failed this check. The CDP screenshot contains page-rendered pixels, not every browser/OS surface. A native
select picker can be open while absent from this image. CDP keyboard events also do not
reliably reach that picker. Changing `fromSurface` or enabling emulated focus does not
establish native-menu coverage. Native menus and OS file pickers require a separately
authorized native screenshot/input driver through the visual interface. Until it is
verified, report the path as blocked; do not inject JavaScript, use DOM selectors, or
replace the product control solely to manufacture a passing visual test. Keyboard
selection is a separate path and does not prove mouse-based menu expansion works.

The format selector now uses CSS `appearance: base-select` on engines that support
it, following the user's UI redesign request. Its themed picker is rendered in the
page top layer; the format-picker E2E check records actual viewport screenshots and
exercises pointer selection, keyboard selection, Escape and outside dismissal. Older
engines retain the native fallback and its capture limitation. This does not unblock
OS file dialogs or constitute a completed live Tier 3 run.

## Downloads and export checks

Use `click --wait-download --timeout 60` on the actual export button. It keeps routing alive
and waits for a newly written, nonempty, stable supported export file, without `.crdownload`.
A single conversation without delivered attachments can produce `.md`, `.json`, `.html`, or
`.pdf` directly; a ZIP is not always expected. ZIP candidates must also be valid archives.
`wait-on --condition download_complete --min-mtime <timestamp>` supports either form;
`zip_downloaded` remains a ZIP-only compatibility alias.

```bash
python3 scripts/visual_agent/cli.py evaluate-export --file '/path/to/conversation.md' --min 1
python3 scripts/visual_agent/cli.py evaluate-export --file '/path/to/export.zip' --min 1
```

Standalone Markdown uses the same content/frontmatter/turn/asset assertions as packaged
Markdown. JSON, HTML, and PDF need format-specific verification; unsupported input must
return an explicit result, never a BadZipFile traceback or a false pass.

Separate download initiation, persisted export completion, actual file delivery, and asset
completeness. A Markdown file can exist while an image failed. Record HTTP status, UI
attachment details, placeholders, and whether the image still displays on the source page.
HTTP 403 alone does not prove an expired image or a logged-out user. A small export that
finishes before the next screenshot cannot prove busy-state locking or cancellation.

Restore viewport/download overrides at the end and preserve all evidence outside tracked
product files. Do not claim uncovered or blocked items passed.

## Chrome diagnostics (Tier 2 and shared Tier 3 launch)

All three `open_test_chrome` launchers use `scripts/launch_test_chrome.py` and
start unified `--headless=new` Chrome by default. Tier 2 (all platforms) and Tier 3
share this browser: tab activation, extension popups, CDP screenshots and input
remain in Chrome's virtual windows, so they cannot activate a desktop window.
Tier 3 still uses the same screenshot-only perception and seven CLI primitives;
this changes the browser display mode, not the exploration protocol.

For first login or manual debugging, run `./scripts/open_test_chrome.sh --headed`
(or add `--headed` to the PowerShell/CMD launcher). This explicit mode can take
focus. It uses the same persistent test profile. After login, quit that dedicated
Chrome normally and relaunch without `--headed` before running tests. An already
running headed browser cannot be converted in place; the launcher refuses to
replace it. Do not run automated tests against the manual-login instance if you
need uninterrupted desktop focus. `--headed` and `--headless` are mutually exclusive.

Headless Chrome has no window close button. To close it gracefully, connect to
its **browser** WebSocket from `http://127.0.0.1:9222/json/version` and issue CDP
`Browser.close` (only against the dedicated test browser). Normal test teardown
still leaves the browser running to retain the shared session.
The launcher refuses an occupied port 9222 or a profile with a live lock owner; it does
not terminate or replace the existing browser. Launches are detached from the
shell process group and return once CDP is ready. Direct launcher calls accept
`--port` for isolated diagnostics (the standard launchers use 9222). Test teardown only disconnects
its CDP sessions.

Launch evidence lives outside disposable worktrees in
`$GEMINI_EXPORTER_TEST_PROFILE/diagnostics/<launch>/` (default profile:
`~/.gemini-exporter-test-profile`). `launch.json` records PID, UTC start time,
arguments and Chrome version/browser identity; `stderr.log` and `chrome.log`
retain browser output. `chrome-launch.json` in the profile points at the latest
launch. Existing browsers started by older scripts have no retroactive logs.

Tier 2 writes `chrome-diagnostics/<run>/` inside each platform's output directory;
`tier2-report.json` links that directory. Timestamped `events.jsonl` identifies
connection, feature start/completion, and browser failure. A background probe
checks the local browser endpoint every second (two-second request timeout),
and feature boundaries check it again. Endpoint loss or changed browser identity
permanently fails the run, even if a case swallows its transport error or Chrome
is subsequently restarted. No browser restart is attempted. This conservatively
reports **connection loss**, not a proven native crash.

At teardown, launch logs are copied only when their browser identity matches.
New macOS `Google Chrome*.ips` reports are retained under
`crash-report-candidates/`: they are candidates, not proof of association with this
browser. macOS can write a report after teardown; in that case inspect
`~/Library/Logs/DiagnosticReports/` and compare PID and time with `launch.json`.
Logs can contain page URLs and local paths; review them before sharing.
Tier 3 benefits from the shared launch logs; the Tier 2 health monitor does not
alter the visual explorer or its seven CLI primitives.
