import { elementById, requiredElement } from '../../shared/elements.js';
import { text } from '../../shared/settings.js';

/** A suggestion, not a gate: show once and let either export destination proceed. */
export function showDirectWritePrompt(count: number, onFolder: () => void, onBrowser: () => void): boolean {
    const modal = document.getElementsByTagName('dialog').namedItem('directWriteModal');
    if (!modal || modal.open || document.querySelector('dialog[open], [aria-modal="true"]')) return false;
    const title = elementById('directWritePromptTitle');
    const description = elementById('directWritePromptText');
    const folder = requiredElement('button', 'btnModalSwitchFolder');
    const browser = requiredElement('button', 'btnModalContinueZip');
    const dismiss = requiredElement('button', 'btnDirectWriteClose');

    title.textContent = text('💡 Large batch export tip', '💡 大批量导出建议');
    description.textContent = text(
        `You selected ${count} conversations. Browser downloads package the batch as a ZIP in memory. For large exports, saving directly to a local folder is usually faster and more reliable.`,
        `本次选中 ${count} 条对话。浏览器下载需要在内存中打包 ZIP。对于大批量导出，保存到本地文件夹通常更快、更稳定。`);
    folder.textContent = text('Save to local folder', '保存到本地文件夹');
    browser.textContent = text('Continue browser download', '继续浏览器下载');
    dismiss.setAttribute('aria-label', text('Close suggestion', '关闭建议'));

    const close = () => modal.close();
    const chooseFolder = () => { close(); onFolder(); };
    const continueBrowser = () => { close(); onBrowser(); };
    const cleanup = () => {
        folder.removeEventListener('click', chooseFolder);
        browser.removeEventListener('click', continueBrowser);
        dismiss.removeEventListener('click', close);
    };
    folder.addEventListener('click', chooseFolder);
    browser.addEventListener('click', continueBrowser);
    dismiss.addEventListener('click', close);
    modal.addEventListener('close', cleanup, { once: true });
    modal.showModal();
    return true;
}
