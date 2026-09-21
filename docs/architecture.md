# 🛡️ Gemini Exporter — Architecture & Engineering Guide

This document contains in-depth engineering documentation, internal subsystem architecture, and testing specifications for contributors and developers.

---

## 🏛️ Modular Subsystem Architecture

Gemini Exporter enforces a strict 4-tier modular architecture across Chrome MV3 boundaries and domain responsibilities:

```
src/
  background/                  Extension Service Worker Subsystem
    background.js              MV3 Service Worker, keepalive heartbeat & session routing

  content/                     Injected Gemini Content Script Subsystem
    content.js                 In-page DOM observation & sync coordinator
    content.css                Sync status floating UI & badge styles
    bootstrap.js               Page token & credential bootstrap
    hookCredentials.js         MAIN world sandboxed network interceptor & credential bridge
    domScraper.js              Live document fallback DOM scraper
    assetFetcher.js            Media, images, and blob streaming fetcher

  core/                        Pure Domain Logic & Engine (Decoupled from DOM)
    api/
      geminiClient.js          batchexecute RPC client, HTTP 400 auto-retry & token refresh
      geminiParser.js          Protocol parsing, turns, attachments & title extraction
    engine/
      exportEngine.js          Event-driven AsyncQueue export coordinator & streaming
      takeoutEngine.js         Google Takeout archive parser & isolated offline media pool
      chatFormatter.js         Markdown, JSON, OpenAI schema formatters
      writers/
        zipWriter.js           JSZip in-memory zip packaging writer
        fsWriter.js            FileSystem Access API directory tree writer
    storage/
      storageService.js        Multi-account slot chrome.storage abstraction
      formatStore.js           Export format validation & persistence
    utils/
      utils.js                 Single Source of Truth: path sanitization, title arbitration, sorting
      constants.js             Enums, format definitions, storage keys
      tabService.js            Tab query, routing, and message failover
      i18n.js                  Bilingual dictionary & translation engine

  ui/                          User Interface Subsystem
    options/                   Workbench markup & options coordinator
    popup/                     Browser action popup markup & coordinator
    tour/                      Interactive onboarding tour guide & styling
    state/
      conversationsStore.js    Reactive conversation state & slot manager
    views/
      listView.js              Virtual conversation list & selection renderer
      logView.js               Diagnostic console log view
      accountView.js           Multi-account slot selector dropdown
      dialogView.js            Session recovery banner & modal dialogs
    controllers/
      exportController.js      Export execution & progress orchestration
      syncController.js        Incremental & deep history scan coordinator
      takeoutController.js     Takeout ZIP import & conflict resolution
      dirHandleController.js   FileSystem Access API IndexedDB persistence
```

---

## ⚙️ Key Engineering Invariants

1. **Zero DOM Dependencies in Core**:
   Core parsing (`geminiParser.js`), formatting (`chatFormatter.js`), path sanitization (`utils.js`), and sorting arbitration have zero DOM dependencies, running identically in Node.js unit tests, Web Workers, and extension pages.
2. **Strict UI Separation of Concerns**:
   - `state`: handles reactive local storage synchronization.
   - `views`: handles isolated HTML rendering and DOM event attachment.
   - `controllers`: orchestrates workflows and asynchronous operations.
   - `options.js`: acts as a lightweight coordinator.
3. **Single Source of Truth (SSoT)**:
   All path sanitization (`sanitizeRelativePath`), filename normalization, sorting arbitration (`compareConversations`), and title resolution reside exclusively in `src/core/utils/utils.js`.
4. **Sandboxed Credential Bridge**:
   `hookCredentials.js` runs in the host page's `MAIN` world, sandboxing all interceptions so that extension errors never affect native Google Gemini operations.
5. **Event-Driven Async Pipeline (`AsyncQueue`)**:
   Replaces busy polling with an event-driven `AsyncQueue` worker pool for CPU-efficient concurrent attachment downloading.
6. **MV3 Keepalive Resilience**:
   Dispatches lightweight keepalive heartbeats during long batch exports and deep scans to prevent Chrome from suspending the service worker mid-session.

---

## 🧪 Two-Tier Testing Architecture

The project adopts a rigorous two-tier testing methodology:

### Tier 1: Fast & Headless CI Gate
- **Execution Command**: `npm test` (corresponding to `npm run type-check && python3 tests/run_tests.py && node build.js && playwright test`)
- **Coverage**:
  - TypeScript strict type checking (`tsc --noEmit`).
  - 22 Python-based unit tests for core parsers, formatters, and utilities.
  - Dual-target esbuild bundling check (`dist/` and `src/`).
  - 23 headless Playwright E2E browser tests across 11 test spec files.
- **Runtime**: ~18–50 seconds, 100% self-contained without external network or real Google credentials.

### Tier 2: Live Debug Staging Harness
- **Execution Command**: `npm run test:live` (or `python3 scripts/test_live_chat_and_export.py`)
- **Environment**: Connects to an active Chrome instance with remote debugging port 9222 (`./scripts/open_test_chrome.sh`).
- **Dynamic Dataset Freshness Gate**: Enforces a strict 2-minute dataset freshness gate during automated collaborative development to prevent stale test data reuse.
- **Full Specification Asserter**: Automatically verifies downloaded export ZIPs against the 6-dimension export specification (`tests/helpers/export_spec_asserter.py`).
