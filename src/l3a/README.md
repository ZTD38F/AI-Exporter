# Storage v2

`storageService.ts` exports the frozen passive persistence API from the
[Storage design](https://app.notion.com/p/3fb5d4d759e1816dbc65c1cd23854e00).

One IndexedDB (`gemini_exporter_v2`, version 1) holds six stores and only the
unique `accounts.providerIdentity` index. The public surface has 23 functions,
including the narrowly scoped atomic Account admission port for L2. User cleanup
atomically deletes Coverage + ExportRecord or ExportRecord alone, while retaining
Account, Index and Detail. Raw partial Settings use one
Chrome Storage key, and Patch uses an extension-origin Web Lock. Writes resolve after physical transaction completion;
missing values return null/empty collections and IO errors reject. No memory
fallback, resource bytes or persistent task state is stored here.

L2 owns identity, Index merging, Detail selection and Coverage admission.
Application owns defaults, Skip, export records and user record cleanup. Runtime
owns extension-origin execution and permissions. The independent Migration module
owns its completion marker; normal Storage never reads or writes upgrade state.

`python3 tests/run_tests.py --filter storage_v2` runs the storage contract suite.
The complete `npm test` additionally covers Application cleanup retention,
cross-context Registry behavior and real browser storage/directory-handle export.
See [Domain type boundaries](../../docs/domain-type-boundaries.md) for
persistence validation and [module-unit isolation](../../docs/v2-unit-isolation.md)
for the distinction between isolated unit tests and integration coverage.
