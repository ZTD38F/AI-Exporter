import { elementById, requiredElement } from '../../shared/elements.js';
import { text } from '../../shared/settings.js';

let pending = false;

/** Page-owned confirmation; Escape and Cancel leave every local record intact. */
export function confirmCleanup(scanRecords: boolean, accountName: string): Promise<boolean> {
    const modal = document.getElementsByTagName('dialog').namedItem('cleanupModal');
    if (!modal || pending || document.querySelector('dialog[open], [aria-modal="true"]')) return Promise.resolve(false);
    const title = elementById('cleanupPromptTitle');
    const description = elementById('cleanupPromptText');
    const account = elementById('cleanupPromptAccount');
    const cancel = requiredElement('button', 'btnCleanupCancel');
    const confirm = requiredElement('button', 'btnCleanupConfirm');
    title.textContent = scanRecords ? text('Clear scan records?', '清除扫描记录？') : text('Clear export records?', '清除导出记录？');
    description.textContent = scanRecords
        ? text('Clear all local conversations, scan coverage and export records for this account? Downloaded files and other accounts stay. Sync again to rebuild the list.', '清空当前账号的全部本地对话、扫描覆盖和导出记录？保留已下载文件及其他账号的数据。之后需要重新同步会话。')
        : text('Clear export records? Conversations and files are kept.', '清除导出记录？保留对话和文件。');
    account.textContent = text(`Account: ${accountName}`, `账户：${accountName}`);
    cancel.textContent = text('Cancel', '取消');
    confirm.textContent = text('Clear records', '清除记录');
    modal.returnValue = '';
    pending = true;
    return new Promise(resolve => {
        let accepted = false;
        const dismiss = () => modal.close();
        const accept = () => { accepted = true; modal.close(); };
        const cycleFocus = (event: KeyboardEvent) => {
            if (event.key !== 'Tab') return;
            if (!event.shiftKey && document.activeElement === confirm) {
                event.preventDefault(); cancel.focus();
            } else if (event.shiftKey && document.activeElement === cancel) {
                event.preventDefault(); confirm.focus();
            }
        };
        const finish = () => {
            cancel.removeEventListener('click', dismiss);
            confirm.removeEventListener('click', accept);
            modal.removeEventListener('keydown', cycleFocus);
            pending = false;
            resolve(accepted);
        };
        cancel.addEventListener('click', dismiss);
        confirm.addEventListener('click', accept);
        modal.addEventListener('keydown', cycleFocus);
        modal.addEventListener('close', finish, { once: true });
        modal.showModal();
    });
}
