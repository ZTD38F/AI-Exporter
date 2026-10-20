# Tier2 Markdown resource oracle follow-up

Syntax recognition uses the shared `parseMarkdownAst(source)` primitive with unchanged GFM and math options. Production fallback applies Gemini preprocessing before parsing; Tier2 parses final artifacts directly without provider preprocessing. Python retains exact archive validation and HTML extraction.

## Real replay provenance

`tests/fixtures/canonical/math/tier2_sta_resource_oracle.md` is an unchanged display-math excerpt from conversation `0c171d7f09355a55`, exported at `2026-09-30T08:51:16.653Z`. The complete artifact is retained locally under `tests/output/contract_fixes/initial_live_export/extracted_verify_1790758278/gemini_export/冷冻电镜缺失楔与PSF拉伸推导_355a55.md`.

Original artifact SHA-256: `854feb9914f07179580f389e9ef257b84e02563133be2b903f817b6b4408181e`.

The replay must emit no resource references for this formula; a missing attachment added outside the formula must fail validation.

## Delimiter evidence search

Searched checked-in provenance/structured RPC fixtures, the clean Takeout fixture, retained Tier2 Markdown/HTML outputs and historical renderer-probe artifacts for paired `\(...\)` and `\[...\]`. Text hits inspected were escaped citation labels, escaped ordinary brackets, and JavaScript regular expressions/code. No confirmed raw Gemini mathematical delimiter sample was identified in this available corpus. This is a bounded evidence search, not a claim that Gemini never emits these delimiters. No speculative compatibility rule is admitted in this follow-up; future real raw evidence requires its own minimal fixture and admission review.

## Artifact grammar

Canonical text escapes literal dollars. Canonical inlineMath still emits `$...$` and math blocks emit standalone `$$` fences. Currency assertions use serialized artifacts, rather than interpreting ambiguous handwritten dollar input as an exporter contract.
