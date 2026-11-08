# Account identity and storage boundaries

**Current contract:** `src/l2/accountRegistry.ts`, `src/l2/accountAdmission.ts`, `src/l3a/accountRegistryStore.ts`, and `src/l3a/idb.ts`. The provider's website identity and a local account ID are different things.

## Account identity

```ts
interface Account {
    id: string;                // local UUID v4
    providerId: string;        // e.g. gemini, chatgpt, claude, grok
    providerAccountId: string; // provider-specific stable identity
    email?: string;
    displayName?: string;
}
```

The unique identity is `(providerId, providerAccountId)`; the persistent local UUID is the storage and UI partition key. Email/display name can update without changing the UUID and are **not** matching keys. Gemini's `u0`-style slot is request routing, **not** account or storage identity.

Account admission happens in L2 and is serialized by a single `accounts` IndexedDB transaction in L3a:

- A known provider identity reuses its matching Account and UUID.
- With an unknown provider identity (`default`), admission uses the deterministically first existing verified Account for that provider if one exists, otherwise its existing default Account, otherwise creates one. `default` does not carry unverified email/display name.
- A sole default Account may be updated *in place* to the first verified identity, preserving its UUID. A released v1.7 Gemini `legacy-email:` alias can likewise be upgraded to a verified Gaia ID when its email matches. These are narrowly scoped identity transitions, not unrestricted merging.
- A distinct verified subject otherwise receives a new UUID. Provider-specific identities cannot be substituted across Accounts.

## Runtime ownership

| Responsibility | Current owner |
| --- | --- |
| Validation, matching, identity promotion, admission | `src/l2/accountRegistry.ts` and `src/l2/accountAdmission.ts` |
| Atomic registry writes and reads | `src/l3a/accountRegistryStore.ts` |
| Extension API and authenticated sender handling | `src/runtime/api/accountRegistry.ts`, `src/runtime/background/accountRegistryHandler.ts` |
| Source account evidence | Platform-specific L1 client, parser and capture modules |
| Tab/account routing | `src/runtime/capabilities/tabService.ts` and content account context |
| Index/Detail ingestion | L2 admission, then passive L3a persistence |
| Workbench and popup selection | Current Account UUID from Registry |

Request-bound source evidence stays attributed to its captured account even if the tab switches. Active tab and resource operations check the intended UUID. Never use email, a Gemini slot, an ambient tab, or an export filename as a substitute for the Account key.

## Persistent storage

`src/l3a/idb.ts` opens `gemini_exporter_v2` at **IndexedDB version 1** with stores `accounts`, `indexes`, `details`, `coverage`, `exportRecords`, and `directoryHandles`. Index/Detail identity is the tuple `(accountId, conversationId)`; the provider is resolved through the Registry Account. Export records and coverage are similarly account-scoped. Application/L2 decide what to store; L3a does not infer ownership or select fresher content.

The independent one-time profile upgrade lives in `src/migration/upgradeV1.ts` and runs before normal background access. It migrates the supported released v1/v1.7 account/index/export/settings/handle facts without treating legacy conversation bodies as current Domain. See [migration contract](../src/migration/README.md).

## Checks

Use `npm run type-check`, `npm test`, and account/switching/ingestion regression tests after changing Registry, request capture, or storage. Unit fixtures do not prove real multi-account or team-workspace behavior; verify those separately with source accounts. Do not treat a historical green run as verification of the current branch.
