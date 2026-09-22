# AI Exporter — Multi-Provider Architecture & Migration Plan

Status: canonical design contract for evolving the Gemini-only extension into **AI Exporter** with Gemini + ChatGPT.

## 1. Product goal

AI Exporter is a browser-first, privacy-first archival/export system for multiple AI services.

Initial providers:
- Google Gemini
- ChatGPT

Future providers must be addable without coupling provider-specific auth, wire formats, pagination, asset logic or schema drift handling into shared core/UI code.

The priority order is:

1. correctness;
2. explicit completeness evidence;
3. recoverability;
4. least-privilege security;
5. stability under provider changes;
6. performance;
7. UI convenience.

## 2. Non-negotiable invariants

1. **Never claim COMPLETE from file creation alone.**
2. **Inventory first.** Supported remote scopes must terminate normally before provider/account completeness is asserted.
3. **Raw provider payload is authoritative.** Markdown/normalized JSON is derived and regenerable.
4. **Unknown data must never disappear silently.** Preserve raw shape and emit drift diagnostics.
5. **Provider/account/workspace isolation.** IDs are never globally unique.
6. **Secrets are ephemeral.** No bearer/session credential in storage.local, logs, exports, fixtures or Git history.
7. **Read-only provider contracts.** No delete/archive/rename/share/edit operations in exporter adapters.
8. **Retries are bounded.** Rate limit and auth failures become explicit states.
9. **Resume is idempotent.**
10. **Gemini regression is unacceptable during migration.**

## 3. Repository strategy

`ZTD38F/AI-Exporter` becomes the canonical product repository.

`ZTD38F/ChatGPT-Export` must not be deleted or blindly copied into the extension. During migration it remains:

- the reference implementation of the ChatGPT web contract;
- the source of inventory/completeness/security invariants;
- a comparison oracle for browser-vs-server captures;
- a server fallback until extension parity is proven.

Only after live parity should it be archived or renamed as a legacy/server reference.

## 4. Why a literal repo merge is wrong

The projects solve the same archival problem in different runtimes:

- ChatGPT-Export: Python/FastAPI, durable filesystem, SQLite, imported bearer session.
- AI-Exporter: TypeScript/Chrome MV3, authenticated browser tabs, browser storage, ZIP/File System Access.

The correct merge is **semantic**:
- port contracts;
- port inventory rules;
- port pagination safety;
- port asset discovery;
- port validation/completeness semantics;
- port redaction/security rules;

but reimplement transport, persistence and lifecycle for MV3.

## 5. Target architecture

```text
src/
  core/
    domain/
      provider.ts
      inventory.ts
      conversation.ts
      asset.ts
      artifact.ts
      integrity.ts
    engine/
      inventoryEngine.ts
      captureEngine.ts
      assetEngine.ts
      integrityEngine.ts
      exportCoordinator.ts
    storage/
      runJournal.ts
      providerStore.ts
      fileHandleStore.ts
    writers/
      folderWriter.ts
      zipWriter.ts
      manifestWriter.ts

  providers/
    registry.ts
    gemini/
      provider.ts
      auth.ts
      inventory.ts
      conversation.ts
      assets.ts
      live.ts
      officialImport.ts
      wire/...
    chatgpt/
      provider.ts
      auth.ts
      transport.ts
      inventory.ts
      pagination.ts
      conversation.ts
      graphNormalizer.ts
      assets.ts
      officialImport.ts
      live.ts
      contract.ts

  runtime/
    background/
    content/
    page/

  ui/
    ...
```

This can be reached incrementally through compatibility facades; no big-bang move is required.

## 6. Provider contract v2

Do not use one giant interface. Split provider capabilities.

### ProviderDescriptor
- id
- display name
- host patterns
- optional host permissions
- capabilities
- provider contract version

### AuthAdapter
- readiness check
- acquire/refresh ephemeral session context
- discover account/workspace scopes
- redact auth diagnostics

### InventoryAdapter
- enumerate conversations per supported scope
- enumerate provider collections
- return explicit termination evidence

### ConversationAdapter
- fetch raw provider conversation
- validate minimum contract
- normalize known content
- preserve unknown content diagnostics

### AssetAdapter
- extract stable asset references
- resolve/download assets
- deduplicate by strong identity
- hash/size/MIME verification

### OfficialImportAdapter
- ingest provider official export archives
- preserve source evidence
- reconcile with live data without blind overwrite

### LiveAdapter (optional)
- observe new/updated/deleted items
- must never be required for a complete full scan

## 7. Provider-neutral domain model

### ProviderScope
```text
providerId
accountKey
workspaceKey
remoteAccountIdFingerprint
name
rawMetadata
```

Never expose raw account/workspace IDs as public folder names.

### ConversationRef
```text
providerId
scopeKey
conversationId
title
createdAt
updatedAt
memberships[]
remoteVersionMarker
```

### RawConversationCapture
```text
providerId
scopeKey
conversationId
raw
rawSha256
capturedAt
contractVersion
```

### NormalizedConversation

Readable/portable representation only. It never replaces raw provider data.

For ChatGPT it must explicitly distinguish:
- full raw mapping graph;
- active branch;
- alternate branches/regenerations;
- unknown nodes/content types.

Flattening only current_node -> parent chain is not archival completeness.

## 8. Integrity states

Object states:

```text
DISCOVERED
FETCHED
RAW_VERIFIED
NORMALIZED
ASSETS_VERIFIED
VERIFIED
PARTIAL
FAILED
AUTH_REQUIRED
```

Run states:

```text
COMPLETE
PARTIAL
AUTH_REQUIRED
FAILED
INTERRUPTED
```

## 9. ChatGPT browser authentication design

Preferred path:

1. user explicitly enables ChatGPT;
2. request `https://chatgpt.com/*` as optional host permission;
3. detect an authenticated ChatGPT tab;
4. obtain `/api/auth/session` from authenticated browser context;
5. keep access token only in memory;
6. if MV3 service-worker restart resilience is required, use `chrome.storage.session` only;
7. keep session storage inaccessible to content scripts;
8. never write token to local storage, IndexedDB, export files, diagnostics or console.

Refresh behavior:
- 401 -> reacquire session once, then AUTH_REQUIRED;
- 403 -> explicit provider/auth-contract/anti-abuse failure, no infinite retry;
- 429 -> global provider cooldown + bounded backoff + Retry-After;
- network/5xx -> bounded retries with jitter.

Forbidden shortcuts:
- no chrome.cookies permission unless proven unavoidable;
- no password collection;
- no persistent bearer storage;
- no bearer tokens through window.postMessage;
- no arbitrary URL fetch proxy.

## 10. ChatGPT inventory parity contract

Before ChatGPT support may be called **full-account capable**, the browser provider must cover:

1. workspace/account discovery;
2. main conversations;
3. archived conversations;
4. Projects;
5. conversations inside each Project;
6. shared conversation inventory/detail where accessible;
7. account artifacts exposed to the user;
8. custom GPT inventory;
9. project/GPT file descriptors and resolvable assets.

Membership is separate from conversation content.

The same conversation discovered from multiple scopes must be stored once with multiple membership records.

## 11. Pagination requirements

Offset chains must detect:
- repeated page IDs/hash;
- premature empty page while total says more exist;
- offset stalls;
- page safety limit;
- duplicate items across pages.

Cursor chains must detect:
- repeated cursor;
- cursor cycle;
- invalid cursor type;
- missing expected items shape;
- page safety limit.

Abnormal termination => PARTIAL, never COMPLETE.

## 12. ChatGPT conversation graph rules

ChatGPT conversations are graphs/trees, not simple arrays.

Archive `raw.mapping` verbatim.

Derived views may expose:
- active path to current_node;
- alternate assistant regenerations;
- edited/branched user turns;
- tool/system nodes;
- model/tool metadata.

Do not discard a node because it has no ordinary text.

Unknown content types must be counted and surfaced in integrity diagnostics.

## 13. Assets

Requirements:
- deduplicate by stable file ID first, then strong URL/pointer identity;
- preserve descriptors separately from binary;
- SHA-256 every binary;
- record size/MIME;
- redact signed URLs from persistent diagnostics;
- never send ChatGPT bearer token to third-party signed asset hosts;
- required unresolved asset => containing object PARTIAL unless an official-export copy verifies the same asset.

Host permission strategy:
1. same-origin resolver/download when available;
2. narrow proven provider CDN origins;
3. runtime optional origin permission only when necessary.

Do not add broad required `https://*/*` access.

## 14. Official export import

Generalize Gemini Takeout handling into `OfficialImportAdapter`.

### Gemini
Google Takeout remains the official/offline complement.

### ChatGPT
Support OpenAI data export ZIPs, including:
- `conversations.json`;
- numbered `conversations-*.json` files;
- included files/assets;
- account/conversation metadata when present.

Import rules:
- schema is not assumed static;
- index files first;
- preserve original source evidence;
- merge by stable IDs/timestamps;
- live + official data may complement each other;
- conflicts are recorded, never silently overwritten.

## 15. Large export strategy

A full ChatGPT backup may be much larger than a selected Gemini export.

### Full backup
**Folder-first** using File System Access API and durable completion markers.

Suggested layout:

```text
AI-Exporter/
  manifest.json
  runs/<run-id>/validation.json
  providers/
    gemini/<scope>/...
    chatgpt/<workspace>/
      account/
      conversations/<id>/
        raw.json
        normalized.json
        conversation.md
        membership.json
        assets/
        complete.json
      projects/
      shared/
      gpts/
```

### ZIP
ZIP remains for selected/smaller exports.

Do not make JSZip in-memory Blob generation the default for huge account backups. Implement a streaming writer or enforce a tested size/memory bound first.

## 16. Run journal / resume

Introduce provider-neutral durable run journal in IndexedDB.

Each item records:
- provider/scope/object key;
- discovered remote version marker;
- state;
- raw hash;
- expected/resolved asset counts;
- final verification status;
- last safe checkpoint.

On restart:
- stale RUNNING -> INTERRUPTED;
- reacquire provider auth;
- rerun inventory;
- skip only objects with matching remote marker + valid completion marker/hash;
- never auto-delete historical local backups simply because remote inventory no longer lists them.

## 17. Integrity manifest

Every run must record:
- extension/build identity;
- provider contract versions;
- started/finished timestamps;
- scopes discovered;
- inventory termination evidence;
- expected/discovered/verified counts;
- raw conversation hashes;
- unique asset expected/verified/failed counts;
- schema-drift/unknown-content counts;
- incomplete reasons;
- final run status.

COMPLETE means provider-contract completeness, not byte-for-byte equivalence with the provider's legal/official data export.

## 18. UI migration

Home screen uses provider cards:

- Google Gemini — connected/not connected + account slot(s)
- ChatGPT — permission/not logged in/connected + workspace(s)

Modes:
- Selected conversations
- Provider history
- Full provider backup
- Official export import

Provider-specific options appear only in provider-specific advanced sections.

UI must be capability-driven.

## 19. Manifest/permission migration

Gemini permissions remain required initially.

ChatGPT should use `optional_host_permissions`, requested only when the user enables ChatGPT.

Any new permission requires matching:
- privacy policy update;
- store disclosure;
- permission-flow E2E test.

## 20. Required failure matrix

### Authentication
- not logged in;
- expired access token;
- browser restart clears ephemeral token;
- workspace switch mid-run;
- 401 after partial progress;
- 403/anti-abuse response;
- multiple ChatGPT tabs.

### Inventory
- multiple main pages;
- archived-only chat;
- project-only chat;
- duplicate chat across scopes;
- repeated page;
- cursor cycle;
- premature empty page;
- inconsistent server total;
- page limit hit.

### Conversation graph
- linear chat;
- assistant regeneration branch;
- edited user branch;
- missing current_node;
- orphan node;
- unknown content type;
- tool/system-only node;
- malformed timestamp/title.

### Assets
- duplicate reference;
- expired signed URL;
- no resolver URL;
- MIME mismatch;
- duplicate filenames with different IDs;
- conflicting same-ID metadata;
- generated image;
- uploaded document;
- project/GPT file;
- interrupted download.

### MV3/runtime
- service worker suspension;
- tab closes;
- navigation during auth bootstrap;
- File System Access permission revoked;
- low-memory pressure;
- extension update during resumable job.

### Official export import
- one conversations.json;
- numbered conversation JSON files;
- missing assets;
- duplicates;
- truncated ZIP;
- ZIP bomb/path traversal;
- schema evolution;
- live/offline conflict.

## 21. Testing gates

### Tier 0 — pure contracts
Provider-neutral types/state/integrity/namespacing.

### Tier 1 — synthetic provider fixtures
No network. Full pagination/graph/asset/auth fixtures.

### Tier 2 — headless extension E2E
Permission flow mocks, provider routing, export, resume and failure reporting.

### Tier 3 — live Gemini staging
Existing live suite remains mandatory.

### Tier 4 — live ChatGPT staging
Authenticated test profile; verify physical output on disk.

### Differential parity gate
For the same authorized ChatGPT test account compare:
- browser AI-Exporter inventory;
- ChatGPT-Export server inventory.

Any unexplained scope/ID difference blocks full-account COMPLETE.

## 22. Migration phases

### Phase 0 — freeze golden baseline
Preserve current green Gemini + integrity regression suite.

### Phase 1 — provider-neutral core, Gemini only
- provider v2 contracts/registry;
- provider+scope namespaced storage;
- generic tab routing/UI state;
- existing Gemini behavior behind adapter.

Exit: all Gemini tests and outputs remain green.

### Phase 2 — ChatGPT auth + read-only transport
- optional host permission;
- session bootstrap;
- ephemeral token handling;
- workspace discovery;
- bounded retry/redaction.

No full-export claim yet.

### Phase 3 — ChatGPT inventory parity
- main + archived;
- Projects + project chats;
- shared;
- workspace isolation;
- custom GPT/account artifacts.

Exit: inventory termination evidence + server-exporter differential parity.

### Phase 4 — graph-preserving conversation capture
- raw graph;
- active branch;
- alternate branch index;
- unknown content diagnostics.

### Phase 5 — assets
- pointers/resolvers;
- dedup/hash/redaction;
- project/GPT assets.

### Phase 6 — OpenAI official export import
- numbered JSON support;
- files/assets;
- live/offline reconciliation.

### Phase 7 — unified AI Exporter UI/branding
- provider cards;
- capability workflows;
- full-backup vs selected-export;
- privacy/store docs.

### Phase 8 — large backup/resume hardening
- run journal;
- folder-first resumability;
- bounded/streaming ZIP;
- interruption recovery.

### Phase 9 — parity/release decision
Only after live differential parity:
- call ChatGPT support production-ready;
- decide whether ChatGPT-Export becomes archived/legacy server reference.

## 23. Upstream integration policy

Current upstream already contains an early `AIProvider` abstraction and basic `ChatGPTProvider`.

Use it as scaffolding only.

It is not proof of complete ChatGPT support because the current early adapter is missing important full-account behavior, including:
- archived/project/shared/workspace inventory parity;
- full asset parity;
- account artifact/custom-GPT parity;
- graph-preserving archival semantics;
- strong completeness validation.

Cherry-pick provider-neutral primitives selectively, then harden them against this contract.

## 24. Definition of done for ChatGPT

ChatGPT support is not done when a ChatGPT tab can export Markdown.

It is done only when:

1. auth is least-privilege and secret-safe;
2. every supported inventory chain has termination evidence;
3. every discovered conversation has raw provider payload preserved;
4. branching graphs are preserved without silent flattening loss;
5. required assets are verified or explicitly failed;
6. workspace/project/shared membership is namespaced and preserved;
7. interrupted runs resume idempotently;
8. official export import complements live data;
9. manifest cannot report COMPLETE while anything required is unresolved;
10. Gemini has zero regression;
11. browser capture agrees with the ChatGPT-Export reference implementation for the same authorized test account, except for documented runtime-specific differences.
