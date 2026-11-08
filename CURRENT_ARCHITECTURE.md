# Current architecture

This file describes **the implementation on main**, not a roadmap or a record of past refactors. The source tree and [module map](src/README.md) are authoritative for file/module ownership. Do not classify an adapter as dead merely because it is experimental or absent from the Chrome Web Store release.

## Platform status

| Platform | Current source integration | Release/acceptance scope |
| --- | --- | --- |
| Gemini | Native request/sniffer parsing, account-aware sync, Takeout import, Live Save, local export | Primary Chrome extension product |
| ChatGPT | Opt-in account/workspace-aware source adapters and official export-ZIP import | Experimental source integration; requires separate authenticated validation |
| Claude | Opt-in organization-aware source adapters, selected-branch/tool/attachment handling | Experimental; [known limitations](docs/claude-support.md) |
| Grok | Opt-in source adapters and source-resource handling | Experimental; [known limitations](docs/grok-support.md) |

All platforms have separate optional site access in [manifest.json](manifest.json). `src/l1/client/`, `src/l1/sniffer/` and `src/l1/parsers/` contain concrete provider implementations; runtime/UI access is permission- and account-scoped. Test declarations and source code do not alone establish live full-platform parity.

## Core boundaries

```text
provider page, native RPC or imported archive
   -> L1 capture / transport / parser / resource acquisition
   -> L2 Account + ConversationKey + Index/Detail Domain admission
   -> L3a passive IndexedDB / directory-handle persistence
   -> Application export/sync workflows
   -> L3b format-neutral DocumentAst
   -> L4 HTML / Markdown / Typst-PDF / DOCX rendering and delivery
```

JSON is a Domain serialization rather than a Document AST renderer.

- **L1:** Validates external input and source ownership. Provider-specific transport and decoding stay upstream of Domain.
- **L2:** Defines account and conversation identity, admission, quality, reference closure, source versions and coverage. An Index/Detail is scoped to the Registry UUID, not Gemini slot labels or email.
- **L3a:** Implements typed passive storage only. It does not choose fresh data or reinterpret source payloads.
- **L3b:** Composes a format-neutral reading structure from trusted Domain; it owns structure but not physical layout, acquired bytes or destinations.
- **L4:** Prepares format resources, renders, packages and delivers files. Bytes and output paths never become Domain identity.
- **Runtime, Application and UI:** Own Chrome IPC, source permissions, task lifecycle, user actions, selection and reporting.
- **Migration:** `src/migration/upgradeV1.ts` retains the one-time, nondestructive released-v1/v1.7 profile upgrade. Normal production parsing does not import legacy record fixtures.

The precise contracts are in [Account Registry](docs/account-registry.md), [Domain type boundaries](docs/domain-type-boundaries.md), and [Document AST](docs/architecture/document-ast.md). Renderer-specific DOCX behavior is [documented separately](docs/architecture/docx-export.md). [Source architecture](src/README.md) lists the current module paths.

## Privacy and validation

The extension processes exports on the user device without developer telemetry or a hosted chat backup service. Optional source websites are contacted through the authenticated browser session; local file and attachment handling remain user-initiated or enabled through Live Save.

`npm test` is the offline TypeScript/unit/build/Playwright gate. [Tier 2](docs/tier2-platform-plugins.md) uses a separately authenticated browser and real exported files. A green previous run or a subset of features is not a current complete Tier 2 pass. The [module unit-test isolation rules](docs/v2-unit-isolation.md) distinguish isolated module tests from cross-layer integration suites.

Update this page whenever a **current contract** changes; do not append dated task logs, PR chronologies, benchmarks or archived acceptance reports here.
