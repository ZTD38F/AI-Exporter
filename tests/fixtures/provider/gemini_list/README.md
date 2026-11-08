# Gemini Recent List capture

Captured on 2026-10-23 (America/Los_Angeles) using the project's persistent
`~/.gemini-exporter-test-profile` and Chrome CDP. This is an offline fixture;
tests do not connect to Google or need credentials.

`recent.json` contains 23 paired MaZiqc requests/responses: 458 unique
conversations, 31 rows on the first page, 20 on pages 2–22, and 7 on the
last page. The final response is `[null, null, rows]`: a nonempty natural
terminal, not a fabricated empty page or a provider-limit error.

Pages 1–17 were captured while scrolling Gemini's real history sidebar.
When the webpage stopped loading additional pages, pages 18–23 were fetched
in the same profile using its current request template and the previous
response's cursor. Each packet records its acquisition method. No prompts
were sent and no cloud conversations were changed.

Authentication fields, headers and URL queries were omitted. Conversation
IDs, titles, opaque strings and cursors use stable replacements across pages.
All array slots, nulls, numeric fields, timestamps, RPC tags and frame counts
are retained. Length prefixes were recalculated after sanitization using the
captured per-frame overhead. Per-page provenance includes hashes of both the
original response and sanitized response. Original private captures are not
committed.

Use `geminiListPage()` for ordinary List input, `geminiListPage(22)` when a
natural terminal is required, and `geminiListPages()` for the complete chain.
Do not repeat page 0 to simulate pagination: its cursor and IDs repeat.
Dedicated malformed, historic-layout, empty, ordering and error fixtures
remain in `providers/gemini.ts`. This corpus does not establish the pinned,
Detail or Delete RPC contracts.

Additional Detail and empty Pinned evidence is documented in
[`../gemini_rpc/README.md`](../gemini_rpc/README.md). State-transition tests now
use `geminiListRow()` / `geminiListVariant()` to change only the required fields
of the captured Recent layout; those are explicit derived fixtures.
