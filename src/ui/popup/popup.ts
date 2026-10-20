import { GeminiUtils, cleanTitle } from '../../core/utils/utils.js';
import { StorageService } from '../../core/storage/storageService.js';
import { ensureStorageReady } from '../../core/storage/schemaMigration.js';
import { __resolveModule } from '../../core/utils/moduleOverrides.js';
import { FormatStore } from '../../core/storage/formatStore.js';
import { ChatFormatter } from '../../core/engine/chatFormatter.js';
import {
    isGeminiUrl,
    detectSlotFromUrl,
    extractConversationIdFromUrl,
    buildExportFileName
} from '../../core/utils/pathUtils.js';
import { $, getI18n } from '../uiCommon.js';
import { sendTypedMessage } from '../../core/utils/messaging.js';
import { ProgressView } from '../views/progressView.js';
import { STORAGE_KEYS } from '../../core/utils/constants.js';

const getStorage = () => __resolveModule('StorageService', StorageService);

let _activeConvId: string | null = null;
let _activeSlot: string = 'u0';
let _activeChatTitle: string = '';
let _activeFormat = 'markdown';

function updateFormatTabsUI(targetFormat: string, isDev?: boolean): void {
    _activeFormat = targetFormat || 'markdown';
    const tabBtns = document.querySelectorAll('#formatTabs .tab-btn') as NodeListOf<HTMLButtonElement>;
    tabBtns.forEach(btn => {
        const val = btn.getAttribute('data-value');
        if (val === _activeFormat) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
        if (val === 'json_raw') {
            btn.style.display = isDev ? '' : 'none';
        }
    });
    $('formatTabs')?.classList.toggle('has-dev', !!isDev);
    const activeLabel = $('activeFormatLabel');
    if (activeLabel) {
        const activeBtn = document.querySelector(`#formatTabs .tab-btn[data-value="${_activeFormat}"]`) as HTMLButtonElement | null;
        activeLabel.textContent = activeBtn?.textContent?.trim() || _activeFormat;
    }
    const formatSelect = $('format') as HTMLSelectElement | null;
    if (formatSelect && formatSelect.value !== _activeFormat) {
        formatSelect.value = _activeFormat;
    }
}

const log = (msg: string): void => {
    try {
        if (typeof console !== 'undefined') console.log('[GemExporter:popup]', msg);
        const el = document.getElementById('log');
        if (el) {
            el.style.display = '';
            const line = document.createElement('div');
            line.textContent = msg;
            el.appendChild(line);
            el.scrollTop = el.scrollHeight;
        }
    } catch {}
};

function updateUiForTabState(isGemini: boolean): void {
    const btnCurrent = $('btnCurrent') as HTMLButtonElement | null;
    const notGeminiNotice = $('notGeminiNotice');
    const currentChatContent = $('currentChatContent');
    const countBadge = $('countBadge');
    const i18n = getI18n();

    if (!isGemini) {
        const notGeminiTip = i18n.t('popupNotGemini');
        if (btnCurrent) {
            btnCurrent.disabled = true;
            btnCurrent.title = notGeminiTip;
        }
        if (notGeminiNotice) notGeminiNotice.style.display = '';
        if (currentChatContent) currentChatContent.style.display = 'none';
        if (countBadge) countBadge.classList.add('inactive');
    } else {
        if (btnCurrent) {
            btnCurrent.disabled = false;
            btnCurrent.title = '';
        }
        if (notGeminiNotice) notGeminiNotice.style.display = 'none';
        if (currentChatContent) currentChatContent.style.display = '';
        if (countBadge) countBadge.classList.remove('inactive');
    }
}

async function updateCount(): Promise<void> {
    try {
        let slot = 'u0';
        let isGemini = false;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (tab?.url && isGeminiUrl(tab.url)) {
            isGemini = true;
            slot = detectSlotFromUrl(tab.url);
            _activeSlot = slot;
            _activeConvId = extractConversationIdFromUrl(tab.url);
        } else {
            _activeConvId = null;
        }
        updateUiForTabState(isGemini);

        const currentChatTitleEl = $('currentChatTitle');
        const chatTurnBadgeEl = $('chatTurnBadge');
        const i18n = getI18n();

        if (isGemini && _activeConvId) {
            const list = getStorage() ? await getStorage().getConversations(slot) : [];
            const found = list.find((c: any) => c.id === _activeConvId || c.id === `c_${_activeConvId}`);
            if (found && found.title) {
                _activeChatTitle = cleanTitle(found.title);
            } else if (tab?.title) {
                _activeChatTitle = cleanTitle(tab.title.replace(/ - Gemini$/, ''));
            } else {
                _activeChatTitle = _activeConvId;
            }

            if (currentChatTitleEl) {
                currentChatTitleEl.textContent = _activeChatTitle;
                currentChatTitleEl.title = _activeChatTitle;
            }

            const msgCount = found?.messageCount || found?.messages?.length || 0;
            if (chatTurnBadgeEl) {
                chatTurnBadgeEl.textContent = msgCount > 0
                    ? (i18n.t('chatMessagesCount', msgCount))
                    : (i18n.t('chatNoMessages'));
            }
        } else if (isGemini) {
            if (currentChatTitleEl) {
                currentChatTitleEl.textContent = i18n.t('chatNoMessages');
            }
            if (chatTurnBadgeEl) {
                chatTurnBadgeEl.textContent = i18n.t('chatNoMessages');
            }
        }

        let count = 0;
        const convs = await getStorage().getConversations(slot);
        count = convs.length;
        if (!count) {
            const syncInfo = await getStorage().getLastSync(slot);
            count = syncInfo?.count || 0;
        }
        const badge = $('countBadge');
        if (badge) {
            const text = i18n.t('syncedBadge', count);
            const label = slot === 'u0' ? text : `${text} (${slot.toUpperCase()})`;
            const offlineLabel = i18n.t('badgeOffline');
            badge.textContent = isGemini ? label : `${label} (${offlineLabel})`;
        }
    } catch (e) {
        console.warn('[popup] updateCount err', e);
    }
}

const handleLangChange = async (targetLang: string): Promise<void> => {
    const i18n = getI18n();
    if (i18n && typeof i18n.setLang === 'function') {
        await i18n.setLang(targetLang);
        document.documentElement.lang = targetLang === 'zh' ? 'zh-CN' : 'en';
        if (typeof i18n.applyI18n === 'function') i18n.applyI18n();
        if (typeof i18n.applyLangToggleUI === 'function') i18n.applyLangToggleUI();
        const isDev = document.body.classList.contains('dev-mode');
        updateFormatTabsUI(_activeFormat, isDev);
        await updateCount();
    }
};

function initPopupEvents(): void {
    const langToggle = $('langToggle') as HTMLInputElement | null;
    langToggle?.addEventListener('change', (e: Event) => {
        void handleLangChange((e.target as HTMLInputElement).checked ? 'en' : 'zh');
    });

    $('labelLangZh')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (langToggle) langToggle.checked = false;
        void handleLangChange('zh');
    });

    $('labelLangEn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (langToggle) langToggle.checked = true;
        void handleLangChange('en');
    });

    $('langTogglePill')?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        if (target && (target.id === 'langToggle' || target.id === 'labelLangZh' || target.id === 'labelLangEn')) {
            return;
        }
        const i18n = getI18n();
        const current = i18n && typeof i18n.getLang === 'function' ? i18n.getLang() : 'zh';
        const nextLang = current === 'zh' ? 'en' : 'zh';
        if (langToggle) langToggle.checked = (nextLang === 'en');
        void handleLangChange(nextLang);
    });

    const formatStore = __resolveModule('FormatStore', FormatStore);
    const formatSelect = $('format') as HTMLSelectElement | null;
    if (formatStore && formatStore.loadFormat) {
        void formatStore.loadFormat(formatSelect).then(({ format, isDev }: { format: string; isDev: boolean }) => {
            if (isDev) document.body.classList.add('dev-mode');
            updateFormatTabsUI(format, isDev);
        });
    }

    const tabBtns = document.querySelectorAll('#formatTabs .tab-btn') as NodeListOf<HTMLButtonElement>;
    tabBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const val = btn.getAttribute('data-value');
            if (val) {
                const fStore = __resolveModule('FormatStore', FormatStore);
                if (fStore && typeof fStore.saveFormat === 'function') {
                    await fStore.saveFormat(val);
                }
                const isDev = document.body.classList.contains('dev-mode');
                updateFormatTabsUI(val, isDev);
            }
        });
    });

    formatSelect?.addEventListener('change', (e: Event) => {
        const val = (e.target as HTMLSelectElement).value;
        const fStore = __resolveModule('FormatStore', FormatStore);
        if (fStore && typeof fStore.saveFormat === 'function') {
            void fStore.saveFormat(val);
        }
        const isDev = document.body.classList.contains('dev-mode');
        updateFormatTabsUI(val, isDev);
    });

    $('btnOptions')?.addEventListener('click', () => chrome.runtime.openOptionsPage());

    let __exportingCurrentPage = false;
    $('btnCurrent')?.addEventListener('click', async () => {
        const btnCurrentEl = $('btnCurrent') as HTMLButtonElement | null;
        const i18n = getI18n();
        if (__exportingCurrentPage) {
            log(i18n && typeof i18n.t === 'function' ? i18n.t('popupExportBusy') : '正在导出当前页，请稍候…');
            return;
        }
        __exportingCurrentPage = true;
        if (btnCurrentEl) btnCurrentEl.disabled = true;

        const __releaseExportGuard = (): void => {
            __exportingCurrentPage = false;
            if (btnCurrentEl) btnCurrentEl.disabled = false;
        };

        const currentFormatSelect = $('format') as HTMLSelectElement | null;
        let format: string = _activeFormat || currentFormatSelect?.value || 'markdown';
        ProgressView.show(10);

        try {
            if (!_activeConvId) {
                log(i18n.t('popupNoChatId'));
                __releaseExportGuard();
                return;
            }
            if (format === 'pdf') {
                log(i18n.t('popupPdfUseOptions'));
                __releaseExportGuard();
                return;
            }
            sendTypedMessage({ action: 'fetchChat', conversationId: _activeConvId, accountSlot: _activeSlot }, 40000).then(async (res: any) => {
                try {
                    if (!res || !res.success) {
                        log(i18n.t('popupFetchFailed', res?.error || '未知错误'));
                        return;
                    }

                    ProgressView.update(80);
                    const chat = res.data || res;
                    if (!chat.id) chat.id = _activeConvId;
                    chat.title = cleanTitle(chat.title || _activeChatTitle);

                    let formatted;
                    if (format === 'html') {
                        formatted = await ChatFormatter.formatHtmlCanonical(chat);
                    } else if (format === 'markdown') {
                        formatted = await ChatFormatter.formatMarkdownCanonical(chat);
                    } else {
                        formatted = ChatFormatter.formatContent(chat, format);
                    }
                    const fileName = buildExportFileName(chat.title || chat.id, _activeConvId, formatted.ext);
                    const blob = new Blob([formatted.content], { type: formatted.mime });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileName;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 3000);

                    ProgressView.complete();
                    log(i18n.t('popupExported', fileName, chat.messages?.length || 0));
                } finally {
                    __releaseExportGuard();
                }
            }).catch((err: any) => {
                __releaseExportGuard();
                log(i18n.t('popupFetchFailed', err?.message || String(err)));
            });
        } catch (e: any) {
            __releaseExportGuard();
            log(i18n.t('popupExportError', e?.message));
        }
    });

    chrome.runtime.onMessage.addListener((msg: any) => {
        const i18n = getI18n();
        if (msg.action === 'syncUpdate') {
            const badge = $('countBadge');
            if (badge) badge.textContent = i18n.t('syncedBadge', msg.count);
        }
        if (msg.action === 'exportProgress' || msg.action === 'scanProgress') {
            let pct = typeof msg.percent === 'number' ? msg.percent : (msg.total ? Math.floor((msg.done / msg.total) * 100) : 50);
            ProgressView.update(Math.min(Math.max(pct, 5), 100));
            if (msg.title) log(msg.title);
        }
    });

    const i18n = getI18n();
    i18n.initLanguage().then(async () => {
        i18n.applyI18n();
        i18n.applyLangToggleUI();
        i18n.onLanguageChange(() => i18n.applyLangToggleUI());
        try {
            await ensureStorageReady();
            void updateCount();
        } catch (e) {
            console.warn('[popup] storage not ready', e);
        }
    });

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local') {
                if (changes[STORAGE_KEYS.LANG]) {
                    const newLang = String(changes[STORAGE_KEYS.LANG].newValue || 'zh');
                    const i18nInst = getI18n();
                    if (i18nInst && typeof i18nInst.getLang === 'function' && i18nInst.getLang() !== newLang) {
                        void handleLangChange(newLang);
                    }
                }
                if (changes[STORAGE_KEYS.FORMAT]) {
                    const newFmt = String(changes[STORAGE_KEYS.FORMAT].newValue || 'markdown');
                    const isDev = document.body.classList.contains('dev-mode');
                    updateFormatTabsUI(newFmt, isDev);
                }
                if (changes[STORAGE_KEYS.DEV_MODE]) {
                    const isDev = !!changes[STORAGE_KEYS.DEV_MODE].newValue;
                    if (isDev) document.body.classList.add('dev-mode');
                    else document.body.classList.remove('dev-mode');
                    updateFormatTabsUI(_activeFormat, isDev);
                }
                if (changes.gemini_conversations || changes.gemini_last_count || changes.gemini_last_sync) {
                    void updateCount();
                }
            }
        });
    }
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener(() => updateCount());
    }
}

initPopupEvents();

export {};
