import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { elementById, requiredElement } from '../../shared/elements.js';
import type { ConversationViewState } from '../state/conversationsStore.js';
import { text, isDeveloperMode } from '../../shared/settings.js';
import { ConversationList } from './conversationList.js';

// Only this adapter touches the legacy workbench's DOM and mutable selection.
// React exclusively owns #list's descendants; Application owns all export facts.
const roots = new WeakMap<HTMLElement, Root>();

export function unmountList(): void {
    const list = elementById('list');
    roots.get(list)?.unmount();
    roots.delete(list);
}

export function renderList(state: ConversationViewState, disabled: boolean, preparedKeys?: ReadonlySet<string>, failedKeys?: ReadonlySet<string>): void {
    const list = elementById('list');
    let root = roots.get(list);
    if (!root) { root = createRoot(list); roots.set(list, root); }
    const provider = state.accounts.find(account => account.id === state.accountId)?.providerId;
    const rows = state.visible().map(index => ({
        index,
        record: state.records[index.key.conversationId],
        selected: state.selected.has(index.key.conversationId),
        prepared: preparedKeys?.has(index.key.conversationId) ?? false,
        failed: failedKeys?.has(index.key.conversationId) ?? false,
    }));
    // Existing workbench code and guidance read the DOM immediately after render.
    // Keep that synchronous contract at the migration boundary only.
    flushSync(() => root.render(createElement(ConversationList, {
        rows, disabled, provider, developerMode: isDeveloperMode(),
        onSelect: (id: string, selected: boolean) => {
            if (disabled) return;
            if (selected) {
                if (document.body.dataset.guidedSelection === 'true') state.selected.clear();
                state.selected.add(id);
            } else state.selected.delete(id);
            renderList(state, disabled, preparedKeys, failedKeys);
            // The legacy tour observes selection intent, including row-title clicks.
            list.dispatchEvent(new Event('conversation-selection-change'));
        },
    })));
    updateStat(state);
}

function updateStat(state: ConversationViewState): void {
    const visible = state.visible();
    const selectedVisible = visible.filter(row => state.selected.has(row.key.conversationId)).length;
    const selectAll = requiredElement('input', 'btnSelectAll');
    selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    selectAll.disabled = visible.length === 0 || document.body.dataset.foregroundBusy === 'true';
    const label = selectAll.checked
        ? text('Clear selection', '清空选择')
        : text('Select all visible conversations', '全选当前可见会话');
    selectAll.setAttribute('aria-label', label);
    selectAll.title = label;
    const total = state.indexes.length;
    elementById('selectedStat').textContent =
        text(`${state.selected.size} of ${total} selected`, `已选 ${state.selected.size} / ${total}`);
    const button = requiredElement('button', 'btnExport');
    button.disabled = !state.selected.size || document.body.dataset.foregroundBusy === 'true';
}
