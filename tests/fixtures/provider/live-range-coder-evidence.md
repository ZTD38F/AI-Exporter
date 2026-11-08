# Captured inline-code wire coverage

`live-range-coder.json` is the complete `turn[3][12]` structured body (143 root
nodes) of a technical range-coding report captured during Tier 2 on 2026-10-15.
It excludes the outer RPC envelope, account details, and request/conversation IDs.

The independently supplied Markdown response contains:

```markdown
While exact rational arithmetic (`fractions.Fraction`) provides an analytical model for formal proofs, **it cannot be used as a production data compression format.**
```

The corresponding wire text has no backticks. Its annotation for character range
`[33, 51)` is `[33, 51, [[null, null, null, null, 3]]]`. Other occurrences of wire
style flag 3 mark `low`, `range`, `run_length`, and hexadecimal literals in prose
and nested lists. This is the evidence for mapping wire style flag 3 to the
existing internal inline-code annotation type 7; the enum values are distinct.

`gemini_structured_coverage.test.ts` supplies unrelated Markdown to the native RPC
parser, so decoding rejection or adapter rejection cannot silently pass by
producing the same output through fallback. It also verifies nested list/table
coverage using independent strings and keeps unknown flags/containers rejected.

This fixture does not establish the semantics of wire field 13 with embedded
file citations. Such containers remain unsupported and emit a shape-only
`GEMINI_STRUCTURED_FALLBACK` warning rather than being silently discarded.


`structured_rpc/live-imagen-panel.json` preserves a second captured wire shape:
`[[[imagePanelNode]], []]`, with only field 9 populated in the node. Live image
URLs, signed tokens, filenames and generation prompts have been replaced with
fixture values; array shapes, MIME types and dimension evidence are retained.
Field 9 contains the generated image files and image-generation prompt metadata.
The decoder retains this resource panel in attachment evidence and delegates
image binding to the existing resource pipeline. An empty envelope trailer is
supported; unknown nonempty trailers, ambiguous nodes and panels without a
recognized generated image file continue to reject.
