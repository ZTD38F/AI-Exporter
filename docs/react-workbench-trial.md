# React workbench trial

This branch evaluates React in the Options conversation list and task panel,
with a separate export-session controller. It is an experiment, not a completed
migration of the workbench.

## Ownership

- `views/listView.ts` is the migration boundary. It takes the existing
  `ConversationViewState`, builds typed row facts, handles selection intent, and
  updates the existing external selection summary/select-all/export controls.
- `views/conversationList.tsx` declares the list, rows, source-generation notes,
  export badges and attachment details. React exclusively owns `#list` children.
  Keys include both account and conversation IDs. Native details and checkbox
  nodes survive ordinary refreshes; another account gets a new identity.
- `ResourceAuthorization` owns its permission query and click feedback. Its
  effect cancels a late query result after unmount. Permission requests start
  directly in the user's click; granting access does not trigger an export.
- Application, Domain, Storage, Background, content capture and export workflows
  retain their existing APIs. React does not own persisted business facts.

The adapter uses `flushSync` because existing workbench/guidance code reads the
DOM immediately after rendering. This is a deliberate transitional boundary,
not a pattern for future React components. Page cleanup unmounts the root. Explicit `conversation-selection-change`
notifications bridge React row/title selections to the existing tutorial, which
previously observed native checkbox change events only.
Selection remains in the existing store rather than being copied into React
state. Foreground task state remains owned by `options.ts`, with an explicit
contract described below; React receives it as presentation input.

## Visible changes

Selected rows have a subtle accent background and leading edge. Keyboard focus
outlines the row. The existing background transition respects reduced motion.
Layout, export status meaning, filtering, account isolation and explicit
selection behavior are preserved.

## Tooling

React and React DOM are production dependencies, with matching type packages
and automatic JSX compilation through the existing esbuild/TypeScript setup.
No Vite, CDN, permission increase or CSP relaxation is required. No Stageshow
runtime or simulated cursor is included.

Dependency-direction and circular-dependency scans, incremental impact analysis,
and the strict typed UI lint include TSX. Packaging excludes TSX source along
with TS source. React/Scheduler MIT notices are included in the shipped notices.

## Measured tradeoff

Compared with baseline `6783e02a077b2b1275ffe6500212a619be4589ed` using
the same production build settings:

| Production bundle | Before (bytes) | After (bytes) | Increase |
| --- | ---: | ---: | ---: |
| `dist/ui/options.js` | 1,958,873 | 2,183,165 | 224,292 (~219 KiB) |
| Same file, gzip | 645,200 | 714,464 | 69,264 (~68 KiB) |

The shared tutorial adjustment adds 47 bytes (18 gzip) to Popup; React is not
bundled there. All other generated JS bundles are byte-identical. Gzip is a comparison of script
compression, not a measurement of the complete extension archive. The first
React region pays the framework's initial cost. Startup time and large-list
performance have not been benchmarked.

The original list renderer was 202 lines; the adapter (66) and components (142)
now total 208. The additional contracts are `ConversationRowFacts` and
`ConversationListProps`; the new permission state is local to its control.
The manually maintained DOM cache, row construction and DOM-equality diff are
removed. The benefit is explicit ownership and lifecycle handling, not a
substantial reduction in line count.

## Try it

Run `npm ci` and `npm run build` in this worktree. Load this directory as an
unpacked extension in a separate test Chrome profile, then open its Options.
The shipping manifest is unchanged.

The session's `temp/react-preview/` contains a standalone interactive mock
preview and screenshot. Its banner identifies example data and simulated sync,
export and permissions. Serve it with:

```sh
python3 -m http.server 4178 --bind 127.0.0.1 --directory temp/react-preview
```

The preview is local test evidence, ignored by Git and excluded from release.
Real extension behavior is covered separately by the existing Tier 1 browser
suite. No live-account Tier 2 or pure-visual Tier 3 acceptance is claimed.

## Phase 2: task and export-session boundaries

The second phase separates task lifecycle, export observations and rendering:

| Owner | Responsibility |
| --- | --- |
| `options.ts` | Start user actions, hold the foreground task, connect selection/settings and refresh persisted facts |
| `state/foregroundTask.ts` | Legal task/feedback states; controller only on an active task |
| `controllers/exportSession.ts` | Per-run counters, backoff timer, diagnostics and Application callback lifetime |
| `state/exportIssues.ts` | Pure diagnostic grouping with type-only dependencies |
| `views/taskPanel.tsx` | Progress, cancel/status/scan messages and failure details |
| Application / Domain / Storage | Existing export execution, business rules and persisted facts |

The independent `busy`, `action` and `controller` variables become one
`ForegroundTask`. Export transitions through running, optionally cancelling,
refreshing, then idle. Import and cleanup cannot have a cancelling state.
Conflicting operations remain locked until the final refresh completes, including
refresh failures. Cancellation aborts once and stops further progress text from
overwriting cancellation feedback. A single `TaskFeedback` union replaces
separate competing status/progress values.

`runExportSession` has no DOM or React dependency. It observes the unchanged
Application export API, counts prepared/delivered/downloaded items, maintains
bounded diagnostic evidence, and disposes its backoff timer on completion or
failure. Its lifetime guard rejects retained callbacks after the session settles,
so an old export cannot paint over a new one. The existing issue collector moves
out of the view without changing its grouping rules. These are UI observations,
not new persisted business facts or a second export engine.

React exclusively owns the children of `#taskProgressPanel` and the failure
card in `#exportFailureHost` through a portal. Existing IDs, layout and tutorial
integration are retained. Stable detail keys preserve expansion through progress
and language changes. Retry is unavailable until the foreground task is idle.
Progress exposes accessible progressbar values. The adapter deliberately retains
`flushSync` for existing synchronous workbench/tutorial reads and unmounts on
page cleanup. Legacy translation does not mutate React-managed children.

New contracts are `ForegroundTaskStatus`, `ForegroundTask`, `TaskFeedback`,
`UiMessage`, `ExportSessionOptions` and `TaskPanelProps`. `ExportRunDiagnostic`
and issue models move with their responsibilities. The main added helpers are
`runExportSession` and `mountTaskPanel`, plus two rendering components. The
session-local lifetime flag and counters are not copied into React state.
The extra phase branches distinguish cancellation and final refresh explicitly.

Compared with phase 1, `options.ts` decreases from 939 to 845 lines. Across that
file, `exportFailures.ts`, and the five new production TS/TSX files, the total
increases from 1,071 to 1,187 lines (+116). This buys tested task ownership and
callback lifetime isolation; it is not a code-size reduction. Static negative
type tests reject illegal task states, and architecture tests keep the controller
independent of views/React and the state models free of runtime dependencies.

Using the same production build and Python gzip settings as phase 1, Options
grows from 2,183,165 to 2,186,424 bytes (+3,259); gzip grows from 714,464 to
715,759 bytes (+1,295). All other JS bundles have unchanged raw/gzip sizes.

Selection, settings persistence, permission/font initiation and tutorial/rating
integration still live in the existing page orchestration. Sync retains its
independent controller and can overlap foreground work under existing rules;
React only presents its status. Further migration should follow these ownership
boundaries before expanding into Popup. Startup and large-list performance still
need measurement before considering a full migration.

## Phase 1 validation

- Full `npm test` passed: zero-any/typed boundary lint, whole-project type
  checking, the complete unit suite, production build, bundled-font checks and
  all 211 Playwright E2E tests (3.1 minutes for the E2E phase).
- Focused list/tutorial regression: 110 tests passed. Added cases cover focused
  checkbox/details retention during reorder, permission-query lifecycle, and
  same-ID account isolation. The existing title-click tutorial regression caught
  the native-event assumption and passes with the explicit selection bridge.
- `python3 tests/test_impact_analyzer.py`: all 6 tests passed, including TSX
  import resolution and transitive dependency coverage.
- `node build.js --pack`: verified ZIP has no TS/TSX source, the unchanged
  manifest bytes, and the React/Scheduler license notice. The verified archive
  is retained locally as `temp/react-trial.zip`.
- Interactive local mock preview: search, select-all and simulated export
  exercised in Chromium; initial interaction produced no page errors.
- Scenario pool: 20/20; no live scenarios consumed.

Live-account Tier 2 and autonomous visual Tier 3 were not run. The mock preview
is not evidence of either tier.

## Phase 2 validation

- Full `npm test` passed: strict typed-boundary lint, project type check,
  complete unit suite (including the new architecture/lifecycle regressions),
  production build, bundled-font checks and all 211 Playwright E2E tests (3.1m).
- Added regressions prove one abort, cancellation feedback isolation, locks
  through final refresh, rejection of settled-session callbacks, preserved
  failure detail expansion and retry locking. Negative compile tests reject
  invalid foreground-task and feedback values.
- Focused list/progress/legacy/tutorial checks passed (127 tests), followed by
  the new progress/error-summary regressions (18 tests). Architecture checks
  also passed independently.
- The updated local mock was driven through running with an expanded failure,
  cancelling, refreshing and idle; no page errors were observed. Screenshots
  are in `temp/react-preview/task-{running,cancelling,refreshing}.png`.
- `node build.js --pack` passed; the ZIP excludes TS/TSX, retains unchanged
  manifest bytes and contains React/Scheduler notices. The verified local
  archive is `temp/react-task-trial.zip`. `git diff --check` passed.
- Scenario pool remains 20/20; no live scenarios consumed. No Tier 2/3 or
  performance benchmark is claimed.

## Follow-up: live Tier 2 acceptance (2026-11-04)

Full `npm run test:tier2` acceptance passed after repairing the test driver's
selection actions: **24 PASS, 1 WARN, 0 FAIL, 0 SKIP**, 713.6 seconds. All 25
features ran, including clean installation/onboarding, two new 5/8-turn chats,
confirmed deletion and atomic local cleanup, Takeout import/title upgrade,
activity promotion, new/continued live-save, pagination, Markdown/HTML/PDF,
image comparison, skip filtering, stale-tab recovery and uninstall isolation.
Eight exported conversations and their index were checked on disk. HTML/PDF
checks verified all 15 live turns, including the two follow-up questions.

The first run exposed a test-driver assumption from the legacy renderer:
assigning checkbox `.checked` and dispatching `change` did not update React's
controlled selection. The initial single export stayed disabled; later bulk
selection left the earlier select-all intent intact. The first run ended with
11 PASS, 4 FAIL and 10 dependency skips and is not acceptance evidence.
Single-row, format-target, stale-tab and skip-test selection now use checkbox
clicks. No production selection bypass or React-specific test hook was added.
A real browser regression reproduces the original failure, verifies repeat
selection/deselection, removes unrelated bulk targets and checks persistence
through language-triggered rerenders. Existing driver checks passed (122 tests),
and full `npm test` passed with all **212 Playwright tests** after the fix.

An intervening retry failed environment preparation because the fresh install's
onboarding page was absent; no scenarios were consumed. After restoring a
Gemini tab, the final run performed a fresh installation and the complete plan.
All temporary manifest permission changes were restored; the source manifest
has no diff. Four scenarios consumed across the two live runs were replaced
with new mechanics/compiler/optics/matching topics; the pool is validated 20/20.

The WARN is the existing structured/Markdown differential audit: 85/85 replies
captured, 35 matches, 50 differences (27 content/metadata, 23 structure/format),
0 unavailable, 0 errors and 0 incomplete. This audit remains **needs review**;
neither representation is an oracle and equivalence is not established. It is
nonblocking under the current Tier 2 gate and is not a React acceptance failure.
No parser changes were made in this follow-up.

Local evidence (ignored by Git):

- Final machine report: `tests/output/tier2/react-task-retry2/tier2-report.json`
- Differential report: `tests/output/tier2/react-task-retry2/gemini/gemini_dual_parse/report/REPORT.md`
- Final live log: `temp/react-task-tier2-retry2.log`
- First live log: `temp/react-task-tier2.log`
- Full Tier 1 log: `temp/react-tier2-fix-tier1.log`

Tier 3 and performance benchmarks remain unrun.
