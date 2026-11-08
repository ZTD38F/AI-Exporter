# Loominary Grok components

- Repository: https://github.com/Laumss/loominary
- Revision: 5ae077b5bc010d80289a851621514397cf95422b
- License: MIT, Copyright (c) 2025 Yalums (full text in LICENSE).

`grokParser.js` is copied from `src/utils/fileParser/grokParser.js`.
`normalizeResponses.js` is extracted from `src/grok.js`, getConversation steps 3–4.
`helpers.js` contains only MessageBuilder constructor/build and finalizeDisplayText,
plus shims for date presentation and unused configuration. No upstream UI/storage
runtime is imported. Source timestamps remain raw until the Domain boundary.

Local adaptations:
- Escape backslashes as well as brackets in citation titles before Markdown conversion.
- The shared composer renders attachment IDs once; omit upstream display placeholders.
- Normalize responses without discarding partial messages or model/reasoning fields.
- Carry adapter-provided generation metadata and accept URL-only captured images; binary acquisition is task-owned in this project.
- `wireCompatibility.ts` bridges current generated-image cards and UUID-only files
  plus asset metadata to the upstream schema; it is verified against live Grok data.
- Account verification, source validation, paging, cancellation, snapshot consistency,
  Domain/AST conversion and completeness reporting belong to the local adapter.
- DOM image acquisition uses upstream selectors and full-size preview URLs, but
  requires an exact response container; no last-message ownership guessing.
- Do not replace the existing export renderers with upstream display code.

When updating, compare these files with the pinned revision and run Grok source,
provider, export, permissions and release-package tests plus the full npm test gate.
