import { listAccounts } from '../../../runtime/api/accountRegistry.js';
import { listIndexes, listExportRecords } from '../../../l3a/storageService.js';
import type { Account } from '../../../l2/accountRegistry.js';
import { compareConversationIndexes } from '../../../l2/conversationIndex.js';
import type { DomainConversationIndex } from '../../../l2/conversationIndex.js';
import type { ExportRecord } from '../../../application/export/types.js';

/** Options-only read mirror and explicit selection. No Domain writes or Skip decisions. */
export class ConversationViewState {
    accounts: Account[] = [];
    accountId: string | null = null;
    indexes: DomainConversationIndex[] = [];
    records: Record<string, ExportRecord> = {};
    selected = new Set<string>();
    search = '';
    filter = 'all';
    private revision = 0;
    private activeRefreshes = 0;
    constructor(private readonly reads = { listAccounts, listIndexes, listExportRecords }) {}
    selectAccount(id: string | null): void {
        if (id === this.accountId) return;
        this.revision++;
        this.accountId = id;
        this.indexes = []; this.records = {}; this.selected.clear();
    }
    /** Return whether committed view facts changed; stale reads never request a repaint. */
    async refresh(changedAccountId?: string): Promise<boolean> {
        const isolated = this.activeRefreshes++ === 0;
        try {
            const revision = ++this.revision;
            const accounts = await this.reads.listAccounts();
            if (revision !== this.revision) return false;
            const id = accounts.some(a => a.id === this.accountId) ? this.accountId : accounts[0]?.id ?? null;
            const accountsChanged = JSON.stringify(accounts) !== JSON.stringify(this.accounts);
            // An unrelated account can still be added/renamed. A concurrent read
            // must be replaced with a full read, so its current-account updates aren't lost.
            if (isolated && changedAccountId !== undefined && changedAccountId !== id && id === this.accountId) {
                this.accounts = accounts;
                return accountsChanged;
            }
            const accountChanged = id !== this.accountId;
            const [indexes, records] = id
                ? await Promise.all([this.reads.listIndexes(id), this.reads.listExportRecords(id)]) : [[], {}];
            if (revision !== this.revision) return false;
            // These read models contain JSON facts only. Key/order differences may cause
            // an extra paint, but can never suppress a changed title/time/export outcome.
            const changed = accountsChanged || accountChanged
                || JSON.stringify(indexes) !== JSON.stringify(this.indexes)
                || JSON.stringify(records) !== JSON.stringify(this.records);
            if (accountChanged) { this.accountId = id; this.selected.clear(); }
            this.accounts = accounts;
            this.indexes = indexes; this.records = records;
            const available = new Set(indexes.map(row => row.key.conversationId));
            for (const id of this.selected) if (!available.has(id)) this.selected.delete(id);
            return changed;
        } finally { this.activeRefreshes--; }
    }
    visible(): DomainConversationIndex[] {
        const query = this.search.trim().toLowerCase();
        return this.indexes.filter(row => {
            const record = this.records[row.key.conversationId];
            const matches = this.filter === 'all'
                || this.filter === 'no_record' && !record
                || this.filter === 'has_record' && !!record;
            return matches && (!query || `${row.title ?? ''} ${row.key.conversationId}`.toLowerCase().includes(query));
        }).sort(compareConversationIndexes);
    }
    keys() {
        return this.indexes.filter(row => this.selected.has(row.key.conversationId)).map(row => ({ ...row.key }));
    }
    selectVisible(): void { this.selected = new Set(this.visible().map(row => row.key.conversationId)); }
}
