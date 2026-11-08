import { getSettings, type GlobalSettings } from '../../application/settings/index.js';
import { UI_COPY } from './legacyLabels.js';
export const EXPORT_FORMATS = ['markdown', 'html', 'pdf', 'docx', 'json'] as const satisfies readonly GlobalSettings['defaultFormat'][];
let language = 'en';
let developerMode = false;
export function useSettings(settings: GlobalSettings, applyDocumentLanguage = true): void {
    developerMode = settings.developerMode;
    language = settings.language ?? (typeof navigator !== 'undefined' && navigator.language.startsWith('zh') ? 'zh' : 'en');
    // Never change Gemini's host document theme when invoked by the content Badge.
    if (applyDocumentLanguage && typeof document !== 'undefined') {
        document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
        document.documentElement.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
    }
}
export const text = (en: string, zh: string): string => language === 'zh' ? zh : en;
export const uiLocale = (): string => language === 'zh' ? 'zh-CN' : 'en-US';
export const isDeveloperMode = (): boolean => developerMode;
export function labelThemeToggle(button: HTMLButtonElement, settings?: GlobalSettings): void {
    const light = settings?.theme === 'light';
    const label = light ? text('Switch to dark mode', '切换到深色模式')
        : text('Switch to light mode', '切换到浅色模式');
    button.textContent = light ? '☾' : '☀';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(light));
}
export async function readSettings(): Promise<GlobalSettings> {
    const settings = await getSettings(); useSettings(settings); return settings;
}
export function observeSettings(refresh: () => void): () => void {
    const listener = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
        if (area === 'local' && (changes.gemini_exporter_v2_settings || changes.gemini_suppress_direct_write_prompt)) refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
}
/** Runtime errors are diagnostic facts; only UI translates their user-facing presentation. */
const ERROR_ZH: ReadonlyMap<string, string> = new Map(Object.entries({
    'Open Gemini, log in and refresh the page before scanning.': '请先打开 Gemini 并登录，刷新 Gemini 页面后再同步会话。',
    'Multiple Gemini accounts are open. Select the account to scan.': '当前打开了多个 Gemini 账号，请选择要同步的账号。',
    'Multiple Gemini accounts or ChatGPT accounts are open. Select the account to scan.': '当前打开了多个 Gemini 或 ChatGPT 账号，请选择要同步的账号。',
    'Open Gemini or ChatGPT, log in and connect the account before scanning.': '请打开 Gemini 或 ChatGPT 并登录，再通过“新手引导”连接后同步会话。',
    'Open Gemini, ChatGPT, Claude or Grok and connect an account before scanning.': '请打开 Gemini、ChatGPT、Claude 或 Grok 并登录，再通过“新手引导”连接后同步会话。',
    'Multiple provider accounts are connected. Select the account to scan.': '当前连接了多个平台账号，请选择要同步的账号。',
    'Open Grok, log in and connect the selected account before scanning.': '请打开 Grok 并登录所选账号，然后重试同步。',
    'Open Claude, log in and connect the selected account before scanning.': '请打开 Claude 并登录所选账号，然后重试同步。',
    'Open ChatGPT, log in and connect the selected account before scanning.': '请打开 ChatGPT 并登录所选账号，然后重试同步。',
    'Select a Gemini account before importing Takeout': '导入 Takeout 前，请先选择 Gemini 账号。',
    'Select a ChatGPT account before importing OpenAI ZIP': '导入 OpenAI ZIP 前，请先选择 ChatGPT 账户。',
    'OpenAI ZIP belongs to a different ChatGPT user': '此 OpenAI ZIP 属于另一个 ChatGPT 用户，请选择对应账户。',
    'OpenAI ZIP does not contain conversations.json': '此 ZIP 不含 conversations.json，请选择 OpenAI 官方数据导出包。',
    'Unsupported OpenAI export manifest': '不支持此 OpenAI 导出清单格式。',
    'OpenAI export manifest references missing files': 'OpenAI 导出清单引用了压缩包中不存在的文件。',
    'ZIP reader unavailable; cannot parse the archive.': 'ZIP 读取器不可用，无法解析压缩包。',
    'Directory picker unavailable': '当前浏览器无法打开文件夹选择器。',
    'Directory permission not granted': '尚未获得文件夹访问权限。',
    'Folder permission denied': '文件夹访问权限被拒绝。',
    'Authorize a folder first': '请先授权文件夹。',
    'No trusted current conversation': '无法确认当前对话。',
    'Takeout requires an account UUID': '导入 Takeout 时缺少账号信息。',
    'Takeout requires an existing Gemini account': '导入 Takeout 前，需要选择已有的 Gemini 账号。',
    'Unsupported Takeout structure': '不支持此 Takeout 压缩包的结构。'
}));
export function errorText(error: unknown): string {
    if (error instanceof DOMException && error.name === 'AbortError')
        return text('Operation cancelled. You can try again.', '操作已取消，可以重试。');
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'JSZip 库未加载，无法解析 ZIP')
        return text('ZIP reader unavailable; cannot parse the archive.', message);
    const translation = ERROR_ZH.get(message);
    if (translation) return text(message, translation);
    // Unexpected diagnostics remain available in the logs, not leaked as untranslated UI.
    return text('Operation failed. Please retry; details are available in the logs or diagnostic report.', '操作失败，请重试；详情请查看日志或诊断报告。');
}
/** Translate static UI nodes only; dynamic titles, messages, paths and logs are rendered by their views. */
export function labelPage(): void {
    document.querySelectorAll<HTMLElement>('[data-en][data-zh], [data-ui-en][data-ui-zh]').forEach(el => {
        el.textContent = text(el.dataset.en ?? el.dataset.uiEn ?? '', el.dataset.zh ?? el.dataset.uiZh ?? '');
    });
    const copy = new Map(Object.entries(UI_COPY[language === 'zh' ? 'zh' : 'en']));
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
        if (el.id === 'currentChatTitle' || el.id === 'chatTurnBadge' || el.id === 'dirLabel' || el.id === 'log') continue;
        const label = copy.get(el.dataset.i18n ?? '');
        if (label) el.textContent = label;
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
        const label = copy.get(el.dataset.i18nTitle ?? '');
        if (label) el.title = label;
    }
    for (const el of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
        const label = copy.get(el.dataset.i18nPlaceholder ?? '');
        if (label) el.placeholder = label;
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
        const label = copy.get(el.dataset.i18nAriaLabel ?? '');
        if (label) el.setAttribute('aria-label', label);
    }
}
