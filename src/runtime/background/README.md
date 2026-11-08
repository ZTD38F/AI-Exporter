# Browser Runtime v2

Runtime owns Chrome contexts, thin IPC, account-bound Tab routing, hooks,
permissions, installation and teardown. L1 acquires data, L2 admits it, Storage
persists it and Application runs Scan/Export.

Content ports are `getAccountContext`, `ping`, `getFileBlob`, `getImageBlob`.
Background exposes readiness, account-bound Registry admission, Domain ingestion, local Index
count, restricted Badge position updates, Live Save and navigation. Content requests persistence at the extension
origin; extension pages call the owner APIs directly after readiness.

`resolveScanTarget(preferredAccountId?)` probes Content and verifies UUIDs against
the Registry. A matching preference wins; otherwise exactly one unique online
account is required. Duplicate tabs are deduplicated. Default/unknown/ambiguous
accounts fail explicitly. Scan never opens or refreshes a tab as a side effect.

Passive Detail admission triggers Live Save only when L2 reports changed=true.
Content sends a ConversationKey; Background verifies the sender, Settings and
folder permission, then runs Application Markdown Folder export with Skip disabled.
No body, bytes or directory handle is serialized through Chrome JSON IPC.
Existing conservative completion observations remain covered by Runtime tests;
Live Save uses the committed Detail change, not an alternate completion writer.

MAIN fetch/XHR capture resolves relative URLs before passing source facts to the
isolated world. Runtime observes SPA URL changes without triggering Scan; Badge owns its own visible-state Index count polling, independently of L1 Index commits.
Readiness awaits the one-time migration. Install opens Options with `?startTour=1`;
updates preserve the feature baseline or initialize it from valid previousVersion
(and otherwise currentVersion). Tour has no stored flag.

`tests/browser_runtime_v2.test.ts` covers Runtime contracts and failure ordering.
`tests/e2e/production_v2.spec.ts` uses the real built extension, fixture responses,
extension-origin IndexedDB and a stored native directory handle to exercise
capture, routing, Badge and Background Live Save. `npm test` is the full Tier 1 gate.
Real Google compatibility, browser restart/worker suspension and native user folder
permissions require separate live validation and are not established here.
