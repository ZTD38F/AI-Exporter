Captured Gemini RPC citation fixtures, 2026-10-15:

- `live-file-citations.json`: turn field 12, paragraph (wire field 13) and list items with inline file citations (field 31). `test_config.json` is a test attachment. The cited quote is metadata, not additional body prose.
- `live-optics-table-citations.json`: one captured table containing a composite cited cell. Uploaded filename replaced with `fixture-optics.jpg`; body and annotation offsets unchanged.
- `live-source-attributions.json`: structured JWST report with six source annotations at style field 3. Source spans overlap bold formatting.
- `live-source-table.json`: corresponding candidate field 2. Public URLs, titles, source IDs and index lists retained; snippets/quoted metadata replaced and favicon/account/transport data omitted.

Source attribution IDs resolve only inside their own candidate. A source annotation without an unambiguous table entry must reject adaptation, not drop attribution. Tests supply unrelated fallback Markdown so content assertions cannot pass through fallback.

- `live-blockquote.json`: native blockquote at wire field 16, captured during the final live export audit. The independently rendered webpage uses `<blockquote><p><b>…</b></p></blockquote>` for this node. No account/transport metadata retained.

- `live-combined-file-citations.json`: field 31 with `[cite: 1, 2]` and two ordered source records, captured from a real report. Generated filenames replaced with `first-diagram.jpg` and `second-diagram.jpg`; source metadata is not body prose.
