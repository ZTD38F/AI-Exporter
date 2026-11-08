# Grok support

Grok is an experimental, opt-in platform. Connect it from Settings, keep a signed-in
`https://grok.com` tab open, and synchronize conversations before exporting.
Markdown, HTML, JSON and PDF use the existing shared export pipeline.

## Upstream reuse

The Grok response normalizer, citation conversion and attachment parser are adapted
from [Loominary](https://github.com/Laumss/loominary), pinned at
`5ae077b5bc010d80289a851621514397cf95422b` under MIT. The full license ships in
`THIRD_PARTY_NOTICES.md`; component provenance and local changes are recorded in
`src/l1/parsers/grok/vendor/loominary/UPSTREAM.md`.

The local adapter handles permissions, verified account ownership, API paging,
consistent response-tree snapshots, Domain conversion and current generated-image
cards/file metadata. It also converts Grok TeX delimiters outside code blocks.
These integration boundaries are separate from the reused parser.

## Supported behavior and limits

- Optional access to `grok.com` and `assets.grok.com`; authorization activates open tabs.
- Conversation discovery/sync, native-read observation, opt-in live save and confirmed deletion.
- Markdown prose, tables, code, math, source citations, reasoning and downloadable attachments.
- Current generated-image cards retain the image model, prompt and owned image resource.
- DOM images only enrich their exact response container; DOM changes wake native API reads.
- Multiple branches without an authoritative selection retain all responses and report partial.
- Missing bodies, unfinished responses, unresolved files and unsupported tool/cards report partial.
- Grok's private endpoints and DOM may change. Signed-in browser access is required;
  this integration does not use an xAI API key.

## Validation

Grok source/provider tests cover account isolation, pagination, cancellation,
snapshot changes, malformed and partial data, citations, files, generated-image
cards and task-only signed resource URLs. Browser tests cover permission denial
and connect/sync. Release tests check shipped bundles and upstream attribution.
