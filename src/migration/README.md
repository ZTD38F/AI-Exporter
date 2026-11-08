# v1 → v2 one-time upgrade

[Design](https://app.notion.com/p/3fb5d4d759e18186b2eaf4041d711b92).
`ensureUpgraded()` copies Accounts, Indexes, convertible ExportRecords, retained
preferences and the directory handle. It never reads bodies or deletes legacy
keys/databases. Storage owns the physical initialized-marker write; only Migration
interprets it. The final marker gates completion; failed calls reject and retry.

Background runs migration before business access, with listeners registered
synchronously. Runtime then fills missing feature baselines from previousVersion
or currentVersion, preserving existing values. Tour is installation URL intent;
neither Tour flags nor the retired ZIP preference are migrated into v2 Settings.

`node -r ./tests/ts_register.js --test tests/upgrade_v1.test.cjs` runs deterministic
fake-indexeddb migration regressions. Runtime tests exercise readiness and lifecycle
against real migration functions. These tests do not establish real profile upgrade
behavior or cloning a historical native handle across browser restarts.

Gemini source-version repair (`gemini_exporter_source_versions_v1`) runs once for
already initialized profiles. Previous builds mixed Takeout activity dates and
RPC update versions without provenance, so existing Gemini Index.updatedAt,
Detail.savedAt and ExportRecord.chatTime are invalidated, while bodies, assets,
titles and export outcomes remain intact. Scan coverage is reset so the next
sync can recover all online versions. Other providers are untouched. The marker
is written only after all repair writes complete; failures retry on next startup.
Legacy v1/v1.7 migration no longer copies update/skip versions. It retains source
creation dates and actual export dates. Takeout now supplies only activityAt for
presentation and sorting, and never updatedAt, savedAt or sourceVersion.
