# Gemini Export 2.1.1 integration - provenance and safety

- Parent, our original code: ZTD38F/AI-Exporter d274e1448231b310a16ceeb9194dbd248ad4e8f1 (v1.7.0). The branch parent preserves all unique original scaffolding and fixes in Git history.
- Imported source: OTLFrostA/gemini-exporter v2.1.1 commit 67c7dc5eb5e4d1cac2a8cf0171bf684b1474b152. Never treat separately uploaded compiled ZIP as source.
- Product scope: Gemini-only, local-first; no own backend, no delete actions, no ChatGPT/Claude/Grok activation or production permissions. Future provider code remains accessible through Git history and source without shipping compiled bundles.
- User-visible Scan full history forces forceFull=true; this disables the trusted incremental stop but cannot bypass provider-side limits. Distinguish complete, up_to_date, partial_limit and error.
- Browser session source; completeness requires independent inventory, detail, resources, ZIP and checkpoint tests. Synthetic scaling is not live Gemini proof.
- Never auto-publish to Chrome Web Store. Manual store upload requires explicit typed confirmation.
- BEFORE MERGE: verify upgrade/migration of real data without affecting installed extension, account isolation, Takeout offline roundtrip and independent real Gemini E2E. No auto-merge while unverified.

## Verification map and unresolved acceptance

| Area | Evidence | State |
| --- | --- | --- |
| Exact upstream source | Git tag v2.1.1 at 67c7dc5eb5e4d1cac2a8cf0171bf684b1474b152 | VERIFIED provenance |
| Original fork parent | Branch retains parent d274e1448231b310a16ceeb9194dbd248ad4e8f1 | VERIFIED Git ancestry |
| 300-local-cap | LIST page size 50, up to 2000 pages, no 300-item bound; tests 299/300/301/350/500/501/1000 in fake IndexedDB | VERIFIED local; provider limit UNKNOWN |
| Large coordinator | Simulated 5000/10000 counts with forceFull | VERIFIED simulated only |
| Partial source boundary | Synthetic explicit provider limit at 300 => partial_limit | VERIFIED simulated only |
| Gemini-only packaging | Optional hosts only Gemini/Google sources; no ChatGPT/Claude/Grok runnable bundles | VERIFIED ZIP |
| Takeout | Shortcut to My Activity / Gemini Apps and disclaimer that activity entries may be partial | IMPLEMENTED, real roundtrip pending |
| User settings and live account migration | Requires independent readback with real v1.7.0 state | UNVERIFIED |
| Real >300 Gemini history | Requires authorized account, source inventory, physical ZIP readback | BLOCKED pending live evidence |
| Browser E2E in root VPS | Chromium sandbox fails as root; use dedicated nonroot CI runner | BLOCKED locally |

### Unique legacy code

Upstream 2.1.1 differs structurally from our v1.7.0 fork: 311 paths in fork parent lack matching paths in upstream, including provider-neutral, ChatGPT, canonical export/parser, and historic test files. These files remain in Git parent history, **not yet semantically ported**. A merge is prohibited until unique required Gemini behavior passes meaningful regression tests (offline Takeout, account isolation, canonical formats, assets).

### Source-side limits

Gemini provider limit (request-scoped BardErrorInfo 1096) cannot be bypassed or relabeled as complete. Full Scan disables only an internal trusted overlap stop. Older history needs authorized supplemental data and explicit completeness evidence, not a larger maxPages.
