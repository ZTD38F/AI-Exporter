# UI v2

Implements the frozen [UI design](https://app.notion.com/p/3fb5d4d759e181cdad0fc2f778766999).

Popup exports the trusted current key. Options maintains an account-scoped read
mirror and explicit selection, calling Application for Scan, Export, Takeout,
Settings and two record-cleanup actions. Clearing scan records explicitly removes
the selected account’s local Index, Detail, Coverage and export history after confirmation.
Accounts, downloaded files, directory handles and other accounts’ data remain.
Scan and export stop controls appear below their shared progress bar in a sticky panel.
Options subscribes to Runtime committed-data invalidations from local and remote extension
contexts. List reads and rendering run asynchronously; scan progress callbacks only update
progress. Producers never wait for UI reads, and observer failures cannot fail a commit.

Installation Tour consumes `?startTour=1` immediately; it has no persistent flag.
Its first step offers Gemini, ChatGPT, Claude and Grok. Next stays disabled until a live
source resolves to a verified registered account, which becomes the workbench selection.
Platform connection actions live in this step, accessible again through Tutorial.
An existing connection enables Next without skipping the platform choices.
Connection checks run once on entry and after explicit connection/sign-in actions;
the Tour does not poll provider session endpoints.
Version Spotlight is recorded on actual display (once per upgrade, never on fresh install); Takeout acknowledgment follows dismissal. The Content Badge owns its account-scoped count display and Pull: it refreshes
after account recognition or change, when a hidden page becomes visible, and
approximately every 60 seconds while visible. Background only serves the existing
read-only count IPC; there is no index-commit push or second count store.

Formatting, Skip, delivery and ExportRecords belong to Application and its
upstream modules. Browser multiple-file output automatically becomes ZIP; the UI
does not choose packaging. Scan resolves a verified online account through Runtime.

The Options sidebar displays **Browser download** and **Save to local folder**
as two always-visible radio choices. The local folder card has two aligned rows
for folder authorization and **Live Save**. When browser download is selected,
both controls are disabled and grayed out; background Live Save also pauses.
The chosen destination persists as Application `exportDelivery` Settings. Returning
to the local folder resumes the saved Live Save preference if Markdown is selected
and folder permission is valid. Switching to other formats pauses without
discarding the enabled preference.

`node scripts/test-ui.cjs` runs whole-project TypeScript, UI unit tests and UI
browser specs. Those specs mock owner ports. `tests/e2e/production_v2.spec.ts`
separately loads the built extension and exercises real Application/Storage,
downloads, PDF sandbox, passive capture and Background Live Save with fixture
network responses. Both are Tier 1, without a live Google account.

Theme preference is stored with Global Settings (`theme: 'dark' | 'light'`); existing installations
default to the original Dark UI. Popup and Options share the switch and Light palette.
The content Badge applies the preference to itself without changing Gemini's page theme.
