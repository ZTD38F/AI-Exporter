# Claude support (experimental)

Claude is an **opt-in source adapter**. Grant access to `claude.ai`, sign in through the source website, then select the observed Account in the Workbench. Conversations and attachments are interpreted locally into the common Domain model; Markdown, HTML, JSON and PDF use the shared export pipeline. The extension does not forward account credentials or conversation contents to a developer-operated backend.

## Source and license attribution

This is an independent adapter informed by MIT-licensed open-source projects:

- [agoramachina/claude-exporter](https://github.com/agoramachina/claude-exporter) — organization/list/detail endpoint reference (copyright 2025 agoramachina).
- [agarwalvishal/claude-chat-exporter](https://github.com/agarwalvishal/claude-chat-exporter) — selected-branch traversal and typed content reference.
- [glebmish/claude-exporter](https://github.com/glebmish/claude-exporter) — artifacts and attachments comparison.

Their scripts, UI and export logic are not bundled. The complete repository-wide dependency/license list is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Current behavior and limits

- Organization-aware account identity, sidebar/list/detail observations, completed native streams and confirmed deletion receipts use the platform-specific capture boundary. The Workbench uses the same shared Registry, Badge, storage and export owners.
- Native pagination/coverage is admitted only from complete, nonrepeating ordered pages with an explicit terminal source fact; partial sidebar observations must not claim all history is present.
- Selected conversation branches are exported. Alternative branches are not merged into an invented authoritative conversation.
- Text, exposed reasoning, uploaded text extraction and supported tool outputs become static Domain content. Native questions and answer choices become readable paragraphs/lists; exported forms are not interactive.
- Artifact source code and generated-file bytes require explicit captured source/file identity. Incomplete edits, missing source bytes, unrecognized tools or interrupted replies remain partial or unknown rather than silently complete.
- Browser session/authenticated source requests operate through the signed-in Claude tab. No API key or remote exporter backend is required.

Claude's internal endpoints and tool formats may change. A fixture-backed parser pass does not establish binary fidelity, large/team organization correctness or an authenticated full Tier 2 pass. Verify live account identity, list exhaustion, source-to-file fidelity and cleanup before broadening release claims.

## Tests

Use `npm test` for the offline release gates and [Tier 2 platform plugins](tier2-platform-plugins.md) for live validation. The registered `claude` plugin has its own golden-source and four-format physical assertions:

```bash
npm run test:tier2 -- --platform claude --plan
npm run test:tier2 -- --platform claude
npm run test:tier2 -- --platform claude --platform-option claude.golden=/path/golden.json
```

Source access and the browser environment are required for the live commands. A targeted check is not a full-suite pass.
