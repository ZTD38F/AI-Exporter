# 🏗️ Gemini Exporter — Source Code Architecture & Directory Guide

This document describes the modern directory layout, subsystem boundaries, build artifacts, and development invariants of the `src/` codebase.

For full architectural diagrams, AST logical mapping matrix, sequence diagrams, and testing specifications, refer to [docs/architecture.md](../docs/architecture.md).

---

## 🏛️ Comprehensive Subsystem Layout

Gemini Exporter enforces a strict 4-tier modular architecture across Chrome MV3 boundaries and domain responsibilities, implemented in strict TypeScript:

```
src/
  background/                  Extension Service Worker Subsystem (MV3 Background)
    background.ts              Central message routing, lifecycle initialization, keepalive orchestration
    lifecycle.ts               Install workbench opening, feedback URL, session storage access level
    keepAlive.ts               Heartbeat ping mechanism for lengthy batch export & deep scan tasks
    abortManager.ts            Multi-account slot abort flags persisted in chrome.storage.session
    batchFetcher.ts            Background batchexecute RPC proxy and tab message failover
    liveSaveHandler.ts         Background FileSystemDirectoryHandle disk save executor
    tabAction.ts               Dynamic active icon color/gray status listener

  content/                     Injected Gemini Content Script Subsystem
    content.ts                 ISOLATED world entrypoint & subsystem coordinator (bundled to dist/content/content.js)
    content.css                Floating badge styling & live save UI animation
    hookCredentials.ts         MAIN world network interceptor & credential sniffer (bundled to dist/content/hook.js)
    accountSniffer.ts          Real Google profile sniffer (email, name, gaiaId) from DOM avatar & WIZ data
    messageBridge.ts           Cross-world window.postMessage bridge (MAIN -> ISOLATED)
    liveSaveObserver.ts        Gemini generation completion & DOM mutation debounced observer
    liveSaveCoordinator.ts     Real-time live auto-save coordinator (RPC/DOM -> IndexedDB & Disk)
    syncEngine.ts              Incremental & deep history scan coordinator
    domScraper.ts              DOM fallback scraper when RPC payloads are unavailable
    badgeView.ts               Floating sync & live save feedback badge in Gemini web UI
    assetFetcher.ts            Media, images, and blob streaming fetcher
    bootstrap.ts               Page token & initial credential bootstrap
    cleanupRegistry.ts         Hot reload / re-injection listener cleanup registry
    contentContext.ts          Cancellation tokens, timer registries, dev mode state
    messageRouter.ts           Message routing between background/options and content script
    pageObserver.ts            SPA URL change and sidebar DOM mutation observer

  core/                        Pure Domain Logic & Engine (Strictly Decoupled from DOM)
    provider/                  Universal AI Provider Abstraction Layer
      aiProvider.ts            Universal AI provider interface, capabilities & data contract
      providerRegistry.ts      Provider registry with URL matching & auto-registration
      providerResolver.ts      Active provider resolution & fallback helper
      index.ts                 Provider subsystem barrel export
      gemini/                  Gemini platform adapter
        geminiProvider.ts      batchexecute RPC provider implementation

    api/                       Protocol Communication & Deserialization
      geminiClient.ts          batchexecute RPC client facade (abort, retry, token refresh)
      geminiParser.ts          Protocol parsing, turns, attachments & title extraction facade
      client/                  Granular RPC & Credential Sub-modules
        credentialManager.ts   SNlM0e token, session slot & credential resolution
        pagination.ts          batchexecute pagination & list/detail cursor fetching
        retryPolicy.ts         Exponential backoff, 400 XSRF auto-refresh & 429 backoff
        rpcClient.ts           batchexecute payload construction & envelope parsing
        credStorage.ts         Credential cache storage helper
      parser/                  Granular Wire Format Parsing Sub-modules
        parseList.ts           batchexecute conversation list item extraction
        parseDetail.ts         Multi-turn conversation recursion & schema drift detection
        extractors.ts          Thought blocks, candidate text, citations & title extractors
        attachments.ts         Image, user file, and Deep Research document attachments
        payload.ts             Low-level JSPB payload unpackers

    engine/                    Export, Conversion & Packaging Engines
      exportEngine.ts          Export pipeline coordinator facade (delegates to ExportOrchestrator)
      export/                  Export Execution Sub-modules
        exportOrchestrator.ts  Batch export orchestration & AsyncQueue worker pool
        batchWorker.ts         Individual conversation worker (fetch -> parse)
        parseDrift.ts          Schema drift telemetry & diagnostic warning tracker
        rateLimiter.ts         Adaptive rate limiting & circuit breaker state machine
        progressReporter.ts    Real-time progress, ETA, and throughput calculation
        sessionRecovery.ts     Session recovery persistence & crash resumption
      takeoutEngine.ts         Google Takeout archive parser facade
      takeout/                 Takeout Sub-modules
        takeoutParser.ts       Takeout ZIP archive parser & entry iterator (in-memory JSZip)
        takeoutHtmlParser.ts   Offline HTML stripper & prompt title extractor
        mediaIndex.ts          C2PA metadata timestamp extraction & media pool mapping
        zipBombGuard.ts        ZIP bomb security validation (entry count, archive & uncompressed bounds)
      template/                Standalone HTML Rendering Templates
        htmlTemplate.ts        Shared Canonical HTML styles/scripts and escaping/URL helpers
      chatFormatter.ts         Async Canonical Markdown/HTML facade; synchronous JSON & OpenAI serialization
      liveSaveWriter.ts        Async Canonical Markdown live-save formatting and FileSystem disk writes
      assetPipeline.ts         Media asset downloading & relative-path archive packaging
      writers/                 Pluggable Storage Writers
        writerInterface.ts     Unified Writer abstraction & factory
        zipWriter.ts           JSZip in-memory zip packaging writer (STORE mode for binary media)
        fsWriter.ts            FileSystem Access API directory tree writer

    export/                    Canonical Document Normalization & Rendering
      canonical/               Shared conversation, block/inline, asset & citation document contract
        gemini/                Gemini input normalization; diagnostics/raw evidence stay outside the document
        renderCanonicalHtml.ts HTML renderer
        renderCanonicalMarkdown.ts Markdown serializer using archive-local assets
      typst/                   Canonical to Typst payload and PDF rendering
      pdf/pipeline/            Resource resolution, payload, compile & delivery stages

    storage/                   Storage Abstraction & Persistence Layer
      storageService.ts        Multi-account slot chrome.storage.local abstraction & two-tier storage coordinator
      conversationDetailStore.ts IndexedDB heavy turn & message body detail store for two-tier storage architecture
      liveStorageManager.ts    Live auto-save configuration and FileSystem Directory Handle proxy
      idbHandleStore.ts        FileSystemDirectoryHandle IndexedDB persistence across sessions
      schemaMigration.ts       Storage schema version migration & legacy key upgrade runner
      sessionStore.ts          In-memory and chrome.storage.session recovery cache
      formatStore.ts           Export format preferences & template persistence

    utils/                     Single Source of Truth (SSoT) & Utilities
      utils.ts                 SSoT facade: title arbitration, deduplication, path cleaning
      titleUtils.ts            Multi-tier title arbitration (RPC > Detail > Prompt > Takeout)
      mergeUtils.ts            SSoT merge & deduplication (preserves highest-rank title & timestamps)
      pathUtils.ts             Strict relative path sanitization & filename builders
      chipUtils.ts             Internal chip URL filtering & code chip extraction
      progressUtils.ts         ETA, bitrate, and byte formatting utilities
      tabService.ts            Tab query, routing, and message failover
      messaging.ts             Type-safe chrome.runtime message dispatching
      moduleOverrides.ts       Dependency injection seam for deterministic unit testing
      environment.ts           Local development environment & debug flag detector
      i18n.ts                  Bilingual translation engine (locales/zh.ts, locales/en.ts)
      constants.ts             System constants, storage keys, format enums, version info

    protocol/                  Wire Protocols & Event Contracts
      protocol.ts              Wire RPC identifiers (RPCS.LIST, RPCS.DELETE), deletion anchors
      events.ts                Strongly typed cross-world and internal event interfaces

  types/                       Shared TypeScript Type Contracts
    index.ts                   Central type barrel export
    conversation.ts            Conversation, ChatTurn, ChatMessage & Attachment interfaces
    entrypoints.ts             Module entrypoint & facade type definitions
    errors.ts                  Structured error codes & custom error contracts
    global.d.ts                Ambient global & window declarations
    liveSave.ts                Live auto-save state & configuration types
    messages.ts                Cross-context runtime message discriminated unions
    ui.ts                      Workbench & view state interfaces
    utils.ts                   Utility & title arbitration contract types

  ui/                          User Interface Subsystem
    options/                   Workbench Subsystem
      options.html             Workbench markup
      options.ts               Workbench entrypoint & module coordinator (bundled to dist/ui/options.js)
      optionsContext.ts        Shared options page dependency context
      modules/                 Decomposed Options UI Sub-modules
        optionsInit.ts         Initialization, slot loading & DOM binding
        optionsExport.ts       Export button binding & progress orchestration
        optionsSync.ts         Quick Sync & Deep Scan coordinators
        optionsTakeout.ts      Takeout drag-and-drop & import coordinator
        optionsSettings.ts     Language toggle, dev mode & diagnostic console
    popup/                     Browser Action Popup Subsystem
      popup.html               Popup markup
      popup.ts                 Quick export & options launcher (bundled to dist/ui/popup.js)
    state/
      conversationsStore.ts    Reactive conversation state machine, filter & sort manager
    views/
      listView.ts              Conversation list & selection renderer
      progressView.ts          Batch export & scanning modal progress bar with ETA
      accountView.ts           Multi-account slot selector dropdown
      dialogView.ts            Session recovery banner & confirmation modal dialogs
      logView.ts               Diagnostic console log view
    controllers/
      exportController.ts      Export execution & progress orchestration
      syncController.ts        Incremental & deep history scan coordinator
      takeoutController.ts     Takeout ZIP import & conflict resolution
      dirHandleController.ts   FileSystem Access API picker & permission coordinator
    tour/
      tourGuide.ts             6-step onboarding walkthrough & highlight mask engine
      tourSteps.ts             Step definitions & instructional text
      tourPosition.ts          Tooltip dynamic geometry & anchor position calculations
      tourGuide.css            Onboarding spotlight & callout styling
      featureReleases.ts       Release notes & new feature banners
    utils/
      domI18n.ts               DOM-based i18n renderer & language switch UI bindings (isolated from Core)
    uiCommon.ts                DOM helpers ($) and i18n bridging
```

---

## ⚡ Build System: esbuild Pure Bundle Architecture

Gemini Exporter compiles its TypeScript source tree using `esbuild` (`build.js`) in a single pass:

| Output Bundle Artifact | Source Entrypoint | Execution World | Description |
|---|---|---|---|
| `dist/content/content.js` | `src/content/content.ts` | ISOLATED World | Content script entrypoint, observers, sync engine & badge view |
| `dist/content/hook.js` | `src/content/hookCredentials.ts` | MAIN World | Host page XHR/Fetch network interceptor & credential sniffer |
| `dist/background/background.js` | `src/background/background.ts` | Service Worker | Background worker, lifecycle, keepalive, abort state & batch fetcher |
| `dist/ui/popup.js` | `src/ui/popup/popup.ts` | Extension Page | Popup action center: quick export & workbench launcher |
| `dist/ui/options.js` | `src/ui/options/options.ts` | Extension Page | Workbench dashboard: batch selection, Takeout import, sync & export |

All bundles are generated in `< 30ms` with minification and sourcemaps.

---

## 🛡️ Architectural Rules & Invariants

1. **Zero DOM Dependencies in Core (Zero DOM Baseline & Layered Browser API Policy)**:
   `src/core/` organizes modules by domain responsibility with a strict boundary on browser API usage:
   - **Strict Zero-DOM / Zero-Browser-API Layer (Pure Logic)**: Response parsers (`api/parser/*`), formatters (`chatFormatter.ts`, `template/htmlTemplate.ts`), pure utilities (`titleUtils.ts`, `mergeUtils.ts`, `pathUtils.ts`, `progressUtils.ts`, `chipUtils.ts`), protocol constants (`protocol/*`), and provider interfaces (`aiProvider.ts`). These modules never touch `document`, `HTMLElement`, or `window`, running identically in Node.js unit tests, Service Workers, and UI pages.
   - **Runtime Infrastructure Layer (Standard Browser APIs Allowed, Zero DOM Rendering)**: API client (`api/client/*`), storage (`storage/*`), writers (`writers/*`), tab routing (`tabService.ts`), and export orchestration (`exportOrchestrator.ts`). These may use standard runtime APIs (`fetch`, `chrome.*`, `IndexedDB`, `FileSystem Access API`, plus read-only `querySelectorAll("script")` in `credentialManager.ts` and legacy `(window as any).__gemExporterAborted` fallback in `geminiClient.ts`/`pagination.ts`), but **never perform DOM rendering or mutation**, which belongs exclusively to `src/ui/` (including `src/ui/utils/domI18n.ts`) and `src/content/`.
2. **Strict UI Separation of Concerns**:
   - `state/`: Unidirectional data flow and reactive conversation state machine;
   - `views/`: Stateless DOM template generation, list rendering, and event bubble binding;
   - `controllers/`: Business workflow orchestration and asynchronous execution;
   - `options.ts` / `popup.ts`: Pure entrypoint mount and sub-module coordinators.
3. **Single Source of Truth (SSoT) & Title Anti-Degradation**:
   Path sanitization (`pathUtils.ts`), title arbitration (`titleUtils.ts`), and list merging (`mergeUtils.ts`) reside exclusively in `src/core/utils/`. No module may roll its own regexes for title cleaning or sorting. Strict priority: `RPC 权威标题 > 详情提取标题 > 提问前缀临时标题 > Takeout 离线导入标题`.
4. **Sandboxed Interceptors Guard**:
   Code injected into `MAIN` world (`hookCredentials.ts`) runs in a fail-safe sandbox: any unexpected exception is swallowed silently to guarantee zero degradation of native Google Gemini functionality.
5. **Event-Driven AsyncQueue & Controlled Polling Boundary**:
   All batch exports and downloads are driven by `AsyncQueue` worker pools (default concurrency: 3) combined with `RateLimiter` exponential backoff state machines to intelligently avoid HTTP 429 rate limits.
6. **MV3 Service Worker Keepalive Resilience**:
   Regular lightweight heartbeat pings keep the MV3 Service Worker alive during lengthy deep scans and multi-megabyte media packaging tasks, preventing unexpected background worker termination by Chromium.
7. **Two-Tier Storage & Quota Isolation**:
   `chrome.storage.local` strictly stores lightweight conversation metadata index (`id`, `title`, `timestamp`, `updatedAt`, `snippet`, `count`), maintaining memory well below Chrome's 10MB quota ceiling. Heavy conversation turns, full messages, and media references are persisted in IndexedDB via `conversationDetailStore.ts`, completely eliminating storage quota exhaustion and data truncation.
8. **Headless FileSystem Permission Resilience**:
   When Service Worker executes in headless background and directory handle permissions drop to `prompt` upon browser restart (where Chromium forbids headless permission prompting), the system safely returns `permission_prompt_needed` and records `dirError` in live config, allowing 1-click reauthorization via user gesture (`reauthorizeDirHandle()`).
9. **Multi-Account Strict Isolation & Zero Token Stealing**:
   The multi-account subsystem is anchored to real Google Profiles (email, name, Gaia ID) sniffed via `accountSniffer.ts`. Each account slot maintains an isolated credential and conversation namespace with zero cross-slot token borrowing. Cross-tab dispatching strictly matches the active account slot, rejecting dispatch if no matching tab is found.
