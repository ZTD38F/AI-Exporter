import { inStore } from '../../src/l3a/idb.js';

// Compile-only regression: tsconfig includes tests/**/*; this function is never called.
function verifyStoreWriteContracts(): void {
    void inStore('accounts', 'readwrite', store => {
        const account = { id: '10000000-0000-4000-8000-000000000001',
            providerId: 'gemini', providerAccountId: '123' };
        store.put(account);
        store.add(account);

        // @ts-expect-error Account storage rejects primitives.
        store.put('invalid');
        // @ts-expect-error Account storage requires a complete Account.
        store.add({ id: 'incomplete' });
    });

    void inStore('exportRecords', 'readwrite', store => {
        store.put({ accountId: 'a', conversationId: 'c',
            value: { exportedAt: 1, format: 'markdown', status: 'ok' } });
        // @ts-expect-error ExportRecord storage requires a typed value field.
        store.add({ accountId: 'a', conversationId: 'c' });
    });

    void inStore('directoryHandles', 'readwrite', store => {
        store.put(null, 'default');
        // @ts-expect-error DirectoryHandle storage rejects Account objects.
        store.put({ id: 'x', providerId: 'gemini', providerAccountId: '123' }, 'default');
    });
}
