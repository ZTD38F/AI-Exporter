# Gemini Detail and Pinned capture

Captured 2026-10-24 UTC with the dedicated `.gemini-exporter-test-profile`
Chrome profile. Both are authenticated, read-only HTTP 200 responses from Google;
no prompts were sent and no conversation was renamed, pinned or deleted.

- Detail: a request using the webpage's live transport template and the
  repository's hNvQHb argument layout, targeting the first Recent conversation.
  The response contains seven turns (14 messages), actual timestamps and no
  continuation cursor. This was an explicit read-only replay, not a naturally
  observed webpage Detail request.
- Pinned: replay of the webpage MaZiqc request with filter `[1,null,1]`.
  The account had no pinned conversations: its actual inner payload is `[]`.
  This proves the empty pinned contract only, not a populated pinned layout.

`detail-and-pinned.json` retains paired requests/responses, capture method and
original/sanitized response hashes. Authentication fields, headers and URL query
parameters are omitted. IDs are mapped consistently; the conversation ID matches
the first Recent capture. Text letters/digits are masked, retaining punctuation,
Markdown delimiters and whitespace. URLs become `example.test` placeholders.
Array slots, nulls, numbers, timestamps and frame order are preserved. Length
prefixes are recalculated with each captured frame's original overhead.
The original wording and opaque string contents are not preserved and should not
be asserted by content-specific tests. Private originals remain git-ignored.

Use `geminiRpcPacket('detail' | 'pinned')` for unmodified captured packets.
Use `geminiListRow()` and `geminiListVariant()` for explicit List state variants:
only IDs, titles, timestamps, row selection and cursors are changed, preserving
all other captured slots and framing. Such variants are derived test inputs,
not evidence that the corresponding state transition happened on Google.

Content-specific, legacy, malformed, quota, retry, candidate-selection and
resource fixtures remain dedicated. A normal captured packet cannot establish
those exceptional contracts. Delete RPCs and populated Pinned responses were
not captured in this phase.
