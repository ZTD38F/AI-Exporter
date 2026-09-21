# System Architecture & Layering

Gemini Exporter enforces a strict 4-tier modular architecture across Chrome MV3 boundaries and domain responsibilities, fully implemented in TypeScript with strict type checking enabled:

```
src/
  background/                  Extension Service Worker Subsystem
    background.ts              Message routing, session monitoring, tab delegation
                               (Bundled into dist/background/background.js with static ESM imports)

  content/                     Injected Gemini Content Script Subsystem
    content.ts                 ISOLATED world entrypoint & sync coordinator (bundled to dist/content/content.js)
    content.css                Sync status floating UI & badge styles
    contentContext.ts          Cancellation tokens, timer registries, abort signals
    hookCredentials.ts         MAIN world network interceptor & credential bridge (bundled to dist/content/hook.js)
    messageRouter.ts           Message routing between background/options and content script
    pageObserver.ts            DOM mutation observation, URL change detection, history events
    syncEngine.ts              Incremental & deep history sync engine (delegates merge/dedup to utils SSoT)
    domScraper.js              DOM fallback scraper
    assetFetcher.ts            Media, images, and blob streaming fetcher

  core/                        Pure Domain Logic & Engine (Decoupled from DOM)
    api/                       Note: limited DOM access (content script only)
      geminiClient.ts          batchexecute RPC client & abort handling (facade)
      geminiParser.ts          Protocol parsing, turns, attachments & title extraction (facade)
      client/                  Granular RPC & credential sub-modules
        credentialManager.ts   SNlM0e token & session slot credential resolution
        pagination.ts          batchexecute pagination & list/detail fetching
        retryPolicy.ts         Exponential backoff, 400/401/429 HTTP error handling
        rpcClient.ts           batchexecute payload construction & envelope parsing
      parser/                  Granular wire format parsing sub-modules
        attachments.ts         Image, file, code, and document attachment extraction
        extractors.ts          Deep walk, thought candidate, timestamp & title extractors
        parseDetail.ts         Conversation turn recursion & schema drift detection
        parseList.ts           batchexecute conversation list item extraction
    engine/
      exportEngine.ts          Export pipeline coordinator (streaming & recovery facade)
      takeoutEngine.ts         Google Takeout archive parser & offline fallback (facade)
      chatFormatter.ts         Markdown, JSON, OpenAI schema formatters
      assetPipeline.ts         Media asset downloading, C2PA validation & ZIP packaging
      export/                  Export execution sub-modules
        exportOrchestrator.ts  Batch export orchestration & async queue management
        batchWorker.ts         Individual conversation export worker
        rateLimiter.ts         Adaptive rate limiting & circuit breaker state machine
        progressReporter.ts    Real-time export progress calculation & UI notification
        sessionRecovery.ts     Session recovery persistence, diagnostics & index generation
      takeout/                 Takeout sub-modules
        takeoutParser.ts       Takeout ZIP stream parser & HTML stripper
        mediaIndex.ts          C2PA timestamp indexing & media pool mapping
        zipBombGuard.ts        ZIP bomb security validation & entry bounds checking
      writers/
        zipWriter.ts           JSZip in-memory zip packaging writer
        fsWriter.ts            FileSystem Access API directory tree writer
        writerInterface.ts     Unified writer abstraction & factory
    storage/
      storageService.ts        Multi-account slot chrome.storage abstraction
      formatStore.ts           Export format validation & persistence
    protocol/
      protocol.ts              Wire RPC identifiers, limits, deletion anchors & constants
    utils/
      utils.ts                 Single Source of Truth: title arbitration, merge & deduplication
      constants.ts             Enums, format definitions, storage keys
      tabService.ts            Tab query, routing, and message failover
      i18n.ts                  Bilingual dictionary & translation engine
      locales/
        zh.ts                  Chinese localization dictionary
        en.ts                  English localization dictionary

  ui/                          User Interface Subsystem
    options/
      options.html             Options Workbench markup
      options.ts               Workbench coordinator (bundled into dist/ui/options.js)
      modules/                 Decomposed Options UI sub-modules
        optionsInit.ts         Initialization & slot loading
        optionsExport.ts       Export trigger & progress handling
        optionsSync.ts         Sync engine coordinator & slot change binding
        optionsTakeout.ts      Takeout prompt & import workflows
        optionsSettings.ts     Language, dev mode & diagnostics
    popup/
      popup.html               Browser action popup markup
      popup.ts                 Quick export & popup coordinator (bundled into dist/ui/popup.js)
    state/
      conversationsStore.ts    Reactive conversation state & slot manager
    views/
      listView.ts              Virtual conversation list & selection renderer
      logView.ts               Diagnostic console log view
      accountView.ts           Multi-account slot selector dropdown
      dialogView.ts            Session recovery banner & modal view
    controllers/
      exportController.ts      Export execution & progress orchestration
      syncController.ts        Incremental & deep history scan coordinator
      takeoutController.ts     Takeout ZIP import & conflict resolution
      dirHandleController.ts   FileSystem Access API IndexedDB persistence
    tour/
      tourGuide.ts             5-step onboarding walkthrough & highlight engine

  types/                       TypeScript Declarations & Wire Contracts
    index.ts                   Aggregated type exports
    wire.ts                    JSPB wire format types, batchexecute envelopes & type guards
    models.ts                  Core domain entity interfaces (Conversation, Turn, Attachment)
    export.ts                  Export options, progress reporting, session recovery types
    ui.ts                      UI view/controller contracts & store interfaces
    api.ts                     Client credentials, RPC and pagination options
    global.d.ts                Ambient type augmentation (Chrome API polyfills, JSZip)
```

## Build System: Pure Bundle Architecture

Gemini Exporter uses `esbuild` (`build.js`) configured for a high-performance, single-pass pure bundle strategy:

1. **5 Production Bundles (Chrome MV3 Runtime)**:
   - `src/content/content.ts` -> `dist/content/content.js` (ISOLATED World content script)
   - `src/content/hookCredentials.ts` -> `dist/content/hook.js` (MAIN World interceptor)
   - `src/background/background.ts` -> `dist/background/background.js` (Service Worker bundle with static ESM imports, zero `importScripts`)
   - `src/ui/popup/popup.ts` -> `dist/ui/popup.js` (Popup single-bundle entrypoint)
   - `src/ui/options/options.ts` -> `dist/ui/options.js` (Options single-bundle entrypoint, JSZip externalized)
   All 5 entrypoints are compiled in parallel in ~25ms with sourcemaps and minification enabled.

2. **Source-Level Test Execution**:
   - Node.js unit tests (`tests/*.test.ts`) dynamically load TypeScript sources directly via `tests/ts_register.js` for instant testing without intermediate disk artifacts.
   - Run `node build.js --per-file` if individual unbundled transpiled modules are needed for offline AST inspection.

## Architectural Rules

1. **`core` has zero DOM dependencies except the `api/` layer which runs exclusively in content script context**: Core algorithms (parsing, formatting, title arbitration) run identically in Node.js unit tests, extension service workers, and UI pages.
2. **Strict UI Separation**: `state` handles storage sync, `views` handles HTML rendering, `controllers` orchestrates workflows, and `options.ts` / `popup.ts` act as thin coordinators.
3. **Single Source of Truth (SSoT)**: All string sanitization, filename cleaning, and multi-tier title arbitration & deduplication logic resides exclusively in `src/core/utils/utils.ts` (`resolveTitle`, `mergeConversation`, `deduplicateConversations`).
4. **Wire Format Type Safety**: batchexecute RPC payloads are validated using type guards in `src/types/wire.ts` (`isBatchexecuteChunk`, `isJspbArray`, `isRecord`), guaranteeing type safety across Google wire format evolution.
5. **Two-Tier Test Verification**: All changes are validated by Tier 1 (22 Node.js unit suites + 22 Playwright E2E specs) and Tier 2 live Chrome staging.
