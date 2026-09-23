// src/ui/state/selectionState.ts - canonical Workbench selection independent of filtered DOM

/**
 * Installs a selection-state adapter around ListView without changing its visual
 * behavior. The DOM remains the source for the currently visible export subset,
 * while this set is the source of truth for selection persistence/recovery.
 */
export function installSelectionState(List: any): void {
    if (!List || List.__selectionStateInstalled) return;
    List.__selectionStateInstalled = true;

    const selectedIds = new Set<string>();
    const originalRender = List.render?.bind(List);
    const originalGetSelectedIds = List.getSelectedIds?.bind(List);
    const originalSelectAll = List.selectAll?.bind(List);
    const originalDeselectAll = List.deselectAll?.bind(List);
    const originalSelectUnexported = List.selectUnexported?.bind(List);
    const originalSelectNeedsUpdate = List.selectNeedsUpdate?.bind(List);
    const originalSelectByIds = List.selectByIds?.bind(List);

    const replace = (ids?: Iterable<string> | null) => {
        selectedIds.clear();
        if (!ids) return;
        for (const id of ids) {
            if (id != null && String(id)) selectedIds.add(String(id));
        }
    };

    const syncVisibleRows = () => {
        if (typeof document === 'undefined') return;
        document.querySelectorAll('#list .item').forEach((item) => {
            const el = item as HTMLElement;
            const id = el.dataset?.chatId;
            const cb = el.querySelector('input[type=checkbox]') as HTMLInputElement | null;
            if (!id || !cb) return;
            if (cb.checked) selectedIds.add(id);
            else selectedIds.delete(id);
        });
    };

    List.render = (...args: any[]) => {
        const override = args[2];
        if (override instanceof Set) replace(override);
        const result = originalRender?.(...args);
        // On the initial render ListView applies the canonical default-selection
        // policy. Capture it once; subsequent filtered renders receive our set.
        if (!(override instanceof Set) && selectedIds.size === 0 && originalGetSelectedIds) {
            replace(originalGetSelectedIds());
        }
        return result;
    };

    List.getSelectedIds = (): Set<string> => new Set(selectedIds);

    List.selectAll = (...args: any[]) => {
        const result = originalSelectAll?.(...args);
        syncVisibleRows();
        return result;
    };
    List.deselectAll = (...args: any[]) => {
        const result = originalDeselectAll?.(...args);
        syncVisibleRows();
        return result;
    };
    List.selectUnexported = (...args: any[]) => {
        const result = originalSelectUnexported?.(...args);
        syncVisibleRows();
        return result;
    };
    List.selectNeedsUpdate = (...args: any[]) => {
        const result = originalSelectNeedsUpdate?.(...args);
        syncVisibleRows();
        return result;
    };
    List.selectByIds = (ids: Set<string> | string[], ...args: any[]) => {
        replace(ids || []);
        return originalSelectByIds?.(ids, ...args);
    };

    if (typeof document !== 'undefined') {
        // Keep canonical state synchronized with user checkbox/row toggles.
        document.addEventListener('change', (event: Event) => {
            const target = event.target as HTMLInputElement | null;
            if (!target?.matches?.('#list input[type=checkbox]')) return;
            const item = target.closest('.item') as HTMLElement | null;
            const id = item?.dataset?.chatId;
            if (!id) return;
            if (target.checked) selectedIds.add(id);
            else selectedIds.delete(id);
        });

        // Account/workspace selection must never leak into another slot.
        document.addEventListener('change', (event: Event) => {
            const target = event.target as HTMLSelectElement | null;
            if (target?.id === 'accountSlotSelect') selectedIds.clear();
        });
    }

    List.__clearSelectionState = () => selectedIds.clear();
}

export default installSelectionState;
