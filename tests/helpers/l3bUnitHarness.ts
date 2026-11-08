import Module from 'node:module';
import type { Account } from '../../src/l2/accountRegistry.js';
import type { DomainConversationWithDetail } from '../../src/l2/conversation.js';
import type { ReadonlyDomain } from '../../src/l2/runtimeValidation.js';
import type { TableBlock } from '../../src/l2/content/blocks.js';

// Only runtime behavior is mocked. All signatures are checked against actual L2 v2 types.
type L2TablePlacements = typeof import('../../src/l2/content/tableLayout.js').tableCellPlacements;
type TablePlacement = ReturnType<L2TablePlacements> extends Generator<infer P> ? P : never;
type PlacementSpec = Pick<TablePlacement, 'rowIndex' | 'column' | 'colSpan' | 'rowSpan'> & { cellIndex: number };

export function mockAccount(providerId = 'chatgpt', id = '10000000-0000-4000-8000-000000000004'): Account {
    return { id, providerId, providerAccountId: 'fixture-user' };
}

/** Upstream has already admitted these typed Domain facts; L3b does not revalidate them. */
export function givenReadonlyDomain(value: DomainConversationWithDetail): ReadonlyDomain {
    return value;
}

export const mockedL2Calls: {
    accounts: unknown[];
    keys: Array<Parameters<typeof import('../../src/l2/conversationKey.js').sameConversationKey>>;
    tables: Array<Parameters<L2TablePlacements>[0]>;
} = { accounts: [], keys: [], tables: [] };

const placementFixtures = new WeakMap<object, readonly TablePlacement[]>();

/** Script L2's returned placements, rather than reimplementing L2's layout algorithm. */
export function stubTablePlacements(table: TableBlock, specs: readonly PlacementSpec[]): void {
    const rows = [...(table.headerRows ?? []), ...table.rows];
    placementFixtures.set(table, specs.map(({ cellIndex, ...placement }) => {
        const cell = rows[placement.rowIndex]?.cells[cellIndex];
        if (!cell) throw new Error('Unknown mocked L2 table cell');
        return { cell, ...placement };
    }));
}

const readAccount: typeof import('../../src/l2/accountRegistry.js').readAccount = value => {
    mockedL2Calls.accounts.push(value);
    // Return the supplied typed Account; its validation belongs to L2 tests.
    return value as Account;
};

const sameConversationKey: typeof import('../../src/l2/conversationKey.js').sameConversationKey = (left, right) => {
    mockedL2Calls.keys.push([left, right]);
    return left.accountId === right.accountId && left.conversationId === right.conversationId;
};

const tableCellPlacements: L2TablePlacements = function* (table) {
    mockedL2Calls.tables.push(table);
    const fixed = placementFixtures.get(table);
    if (fixed) { yield* fixed; return; }
    // Trivial row-major mock for schema fixtures; rowspan cases explicitly script the results.
    let rowIndex = 0;
    for (const row of [...(table.headerRows ?? []), ...table.rows]) {
        let column = 0;
        for (const cell of row.cells) {
            const colSpan = cell.colSpan ?? 1, rowSpan = cell.rowSpan ?? 1;
            yield { cell, rowIndex, column, colSpan, rowSpan };
            column += colSpan;
        }
        rowIndex++;
    }
};

type Loader = { _load(request: string, parent?: NodeModule | null, isMain?: boolean): unknown };
const loader = Module as unknown as Loader;
const originalLoad = loader._load;
let composer: typeof import('../../src/l3b/compose/composeDomainDocument.js');
loader._load = (request, parent, isMain) => {
    const caller = parent?.filename.replace(/\\/g, '/') ?? '';
    if (caller.includes('/src/l3b/') && request.includes('/l2/')) {
        if (request === '../../l2/accountRegistry.js') return { readAccount };
        if (request === '../../l2/conversationKey.js') return { sameConversationKey };
        if (request === '../../l2/content/tableLayout.js') return { tableCellPlacements };
        throw new Error('Unmocked L2 runtime dependency in L3b unit test: ' + request);
    }
    return originalLoad.call(loader, request, parent, isMain);
};
try {
    // Only actual L3b is loaded; the three external L2 calls resolve to v2-shaped mocks.
    composer = require('../../src/l3b/compose/composeDomainDocument.js') as typeof import('../../src/l3b/compose/composeDomainDocument.js');
} finally {
    loader._load = originalLoad;
}

export const composeDomainDocument = composer.composeDomainDocument;
