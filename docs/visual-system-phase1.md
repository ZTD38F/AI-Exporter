# Visual system Phase 1

The shared contract is `src/core/export/visualContract.ts`. HTML consumes it directly; the sandbox mounts its serialized JSON for Typst. Print uses native units, while retaining the same content/prose ratio, type hierarchy, and spacing order.

- Content 880px / prose 720px; PDF content166mm and proportionally narrower prose. Paragraphs/headings/lists/quotes use prose; code/table/media/display math retain content measure.
- Five gaps: inline6 < paragraph12 < block18 < section30 < turn40. Print converts gaps to pt; keep-together rules remain separate.
- Title30 > H223 > H318 > body16 > small13 > metadata12. Print typography scales to native print sizes. HTML now renders a visible conversation title.
- Asset presentation is shared by HTML/Markdown/Typst. Preserve readable captions and filenames; suppress opaque IDs, URLs and storage filenames. Existing asset schema has no generated/user provenance, so the fallback is conservative and schema is unchanged.

## Verification and baseline scope

The existing 12 visual fixtures cover prose, long prompts, code, nested lists/quotes, wide/span tables, images, attachments, CJK/math, missing assets and multipage turns. The real Typst WASM checker checks content integrity, page bounds, large blank regions, duplicate runs, image bounds and CJK/math coverage.

The latest real archive (2026-09-30 exported Markdown) was replayed for 8 conversations including Cryo-ET,040ffd,b0c0e2,Python logs,Bell inequalities and file attachments. This is an archive roundtrip, not a new online export from original stored messages. Markdown cannot fully recover original block-level image/file semantics; image duplication and inline-versus-block presentation in the archive are inherited and must not be treated as Phase1 golden evidence. Remote images absent from the archive stay unavailable.

Phase1 parameters are a candidate baseline. A final fresh export from the original stored conversations remains necessary before freezing a production visual golden corpus. No Phase2 work (table redesign,syntax colors,surface/elevation,pagination/schema changes) is included.
