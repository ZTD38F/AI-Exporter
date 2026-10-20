# Gemini Exporter v1.7.0 — pinned upstream source

This folder pins the **complete original upstream Gemini Exporter source code** as a Git submodule at its published `v1.7.0` release. It does **not** replace the existing AI Exporter app runtime or change the product name. The current `main` runtime remains the previously tested Gemini v1.5.1–derived AI Exporter until the migration passes all regression and completeness gates.

- Original Chrome Web Store extension: https://chromewebstore.google.com/detail/gemini-exporter-save-all/ldpbiafkgjlaooeplkiooljccpalpkgf
- Upstream project: https://github.com/OTLFrostA/gemini-exporter
- Git tag: `v1.7.0`; verified source revision `3327ff7f5da448c34f00f0b201ff3456af0b564d` (annotated tag object `da67d64514bce672e2c799d6718ed674f05f5708`).
- Reviewed user-provided production `.crx` manifest version: `1.7.0`.
- Original CRX SHA-256: `6e50d0d2a67f6db378eac8d782a6f69cc60447404a15c6d96c7d549fb6ffda16`.
- CRX3 RSA/SHA-256 signature was validated against the extension ID `ldpbiafkgjlaooeplkiooljccpalpkgf`; cryptographic identity does not itself prove safety.

## How to fetch

`git submodule update --init --recursive vendor/gemini-exporter-1.7.0`

## AI Exporter integration status

The compatible v1.7.0 integration has been prepared and tested in an isolated VPS worktree `feature/gemini-1.7.0-integration` (not merged in this provenance-only change). Preserve our original Gemini UI and provider-neutral ChatGPT groundwork. Multi-provider ChatGPT archive support and automatic ZIP of raw JSON conversations remain future work; track [issue #17](https://github.com/ZTD38F/AI-Exporter/issues/17).

Production upgrade acceptance requires TypeScript, unit/integrity tests, Playwright E2E, and authorized live Gemini export with physical ZIP inspection. Do not advertise ChatGPT 100% complete export based only on the current foundation.
