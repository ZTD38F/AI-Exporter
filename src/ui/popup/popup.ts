// src/ui/popup/popup.ts - Popup UI controller for Gemini Exporter

import { GeminiUtils } from '../../core/utils/utils.js';
import { I18n } from '../../core/utils/i18n.js';
import { StorageService } from '../../core/storage/storageService.js';
import { FormatStore } from '../../core/storage/formatStore.js';
import { ChatFormatter } from '../../core/engine/chatFormatter.js';

const Storage = (typeof StorageService !== 'undefined')
    ? StorageService
    : ((typeof (globalThis as any).StorageService !== 'undefined')
        ? (globalThis as any).StorageService
        : null);

function $(id: string): HTMLElement | null {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

function log(_msg: string): void {
    // no-op: popup no longer shows log stream; badge + button disabled state is sufficient
    // kept as no-op to avoid touching every caller; callers below are also removed
}

const cleanTitle = (t: any): string =>
    (typeof GeminiUtils !== 'undefined' && typeof GeminiUtils.cleanTitle === 'function'
        ? GeminiUtils.cleanTitle(t)
        : (typeof (globalThis as any).GeminiUtils !== 'undefined' && (globalThis as any).GeminiUtils.cleanTitle
            ? (globalThis as any).GeminiUtils.cleanTitle(t)
            : (t || '').trim()));

const sanitizeFileName = (name: any, fallback: string = 'untitled'): string =>
    (typeof GeminiUtils !== 'undefined' && typeof GeminiUtils.sanitizeFileName === 'function'
        ? GeminiUtils.sanitizeFileName(name, fallback)
        : (typeof (globalThis as any).GeminiUtils !== 'undefined' && (globalThis as any).GeminiUtils.sanitizeFileName
            ? (globalThis as any).GeminiUtils.sanitizeFileName(name, fallback)
            : (name || fallback).trim() || fallback));

const getI18n = (): any => (typeof I18n !== 'undefined' ? I18n : (globalThis as any).I18n);

    function isGeminiUrl(urlStr?: string | null): boolean {
        if (!urlStr || typeof urlStr !== 'string') return false;
        try {
            const u = new URL(urlStr);
            return u.hostname === 'gemini.google.com';
        } catch {
            return false;
        }
    }

    function updateUiForTabState(isGemini: boolean): void {
        const btnCurrent = $('btnCurrent') as HTMLButtonElement | null;
        const formatSelect = $('format') as HTMLSelectElement | null;
        const quickExportLabel = document.querySelector('.card:nth-of-type(2) .label');
        const countBadge = $('countBadge');
        const i18n = getI18n();

        if (!isGemini) {
            if (btnCurrent) {
                btnCurrent.disabled = true;
                btnCurrent.title = typeof i18n !== 'undefined' ? i18n.t('popupNotGemini') : '当前页不是 gemini.google.com';
            }
            if (formatSelect) {
                formatSelect.disabled = true;
            }
            if (quickExportLabel) {
                quickExportLabel.classList.add('disabled');
            }
            if (countBadge) {
                countBadge.classList.add('inactive');
            }
        } else {
            if (btnCurrent) {
                btnCurrent.disabled = false;
                btnCurrent.title = '';
            }
            if (formatSelect) {
                formatSelect.disabled = false;
            }
            if (quickExportLabel) {
                quickExportLabel.classList.remove('disabled');
            }
            if (countBadge) {
                countBadge.classList.remove('inactive');
            }
        }
    }

    // Update synced count badge and tab UI state
    async function updateCount(): Promise<void> {
        try {
            let slot = 'u0';
            let isGemini = false;
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.url && isGeminiUrl(tab.url)) {
                isGemini = true;
                const m = tab.url.match(/\/u\/(\d+)(?:\/|$)/);
                if (m) slot = 'u' + m[1];
            }
            updateUiForTabState(isGemini);

            let count = 0;
            if (Storage) {
                const convs = await Storage.getConversations(slot);
                count = convs.length;
                if (!count) {
                    const syncInfo = await Storage.getLastSync(slot);
                    count = syncInfo?.count || 0;
                }
            } else {
                const convKey = slot === 'u0' ? 'gemini_conversations' : `gemini_conversations_${slot}`;
                const countKey = slot === 'u0' ? 'gemini_last_count' : `gemini_last_count_${slot}`;
                const data: any = await chrome.storage.local.get([convKey, countKey]);
                count = data[convKey]?.length || data[countKey] || 0;
            }
            const badge = $('countBadge');
            if (badge) {
                const i18n = getI18n();
                const text = typeof i18n !== 'undefined' ? i18n.t('syncedBadge', count) : `${count} synced`;
                const label = slot === 'u0' ? text : `${text} (${slot.toUpperCase()})`;
                badge.textContent = isGemini ? label : `${label} (${typeof i18n !== 'undefined' && i18n.getLang?.() === 'zh' ? '离线' : 'offline'})`;
            }
        } catch (e) {
            console.warn('[popup] updateCount err', e);
        }
    }

    // Language switch toggle
    const handleLangChange = async (targetLang: string): Promise<void> => {
        const i18n = getI18n();
        if (typeof i18n !== 'undefined') {
            await i18n.setLang(targetLang);
            updateCount();
        }
    };

    const langToggle = $('langToggle') as HTMLInputElement | null;
    langToggle?.addEventListener('change', async (e: Event) => {
        const target = e.target as HTMLInputElement;
        handleLangChange(target.checked ? 'en' : 'zh');
    });

    $('labelLangZh')?.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const toggle = $('langToggle') as HTMLInputElement | null;
        if (toggle) toggle.checked = false;
        handleLangChange('zh');
    });

    $('labelLangEn')?.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const toggle = $('langToggle') as HTMLInputElement | null;
        if (toggle) toggle.checked = true;
        handleLangChange('en');
    });

    const formatStore = (typeof FormatStore !== 'undefined')
        ? FormatStore
        : (globalThis as any).FormatStore;
    const ALLOWED_FORMATS: string[] = (typeof formatStore !== 'undefined' ? formatStore.ALLOWED_FORMATS : ['markdown', 'json_openai', 'json', 'json_raw']);
    const formatSelect = $('format') as HTMLSelectElement | null;

    if (typeof formatStore !== 'undefined' && formatStore.loadFormat) {
        formatStore.loadFormat().then(({ format }: { format: string }) => {
            if (formatSelect) formatSelect.value = format;
        });
        formatSelect?.addEventListener('change', (e: Event) => {
            const target = e.target as HTMLSelectElement;
            formatStore.saveFormat(target.value);
        });
    } else {
        chrome.storage.local.get(['gemini_export_format'], (data: any) => {
            if (data.gemini_export_format && formatSelect) {
                const v = String(data.gemini_export_format);
                const valid = ALLOWED_FORMATS.includes(v) && Array.from(formatSelect.options).some(o => o.value === v);
                if (valid) {
                    formatSelect.value = v;
                } else {
                    formatSelect.value = 'markdown';
                    chrome.storage.local.set({ gemini_export_format: 'markdown' });
                }
            }
        });
        formatSelect?.addEventListener('change', (e: Event) => {
            const target = e.target as HTMLSelectElement;
            chrome.storage.local.set({ gemini_export_format: target.value });
        });
    }

    // "去工作台选 批量导出" button
    $('btnOptions')?.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // "只导当前页" button
    $('btnCurrent')?.addEventListener('click', async () => {
        const i18n = getI18n();
        const currentFormatSelect = $('format') as HTMLSelectElement | null;
        let format: string = (typeof formatStore !== 'undefined' && formatStore.getCurrentFormat)
            ? formatStore.getCurrentFormat(false, currentFormatSelect?.value)
            : (currentFormatSelect?.value || 'markdown');
        if (typeof formatStore === 'undefined' && !ALLOWED_FORMATS.includes(format)) format = 'markdown';

        void (typeof i18n !== 'undefined' ? i18n.t('popupExporting') : '');
        const progWrap = $('progWrap');
        const bar = $('bar');
        if (progWrap) progWrap.style.display = 'block';
        if (bar) bar.style.width = '10%';

        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs[0];
            if (!tab || !tab.url || !isGeminiUrl(tab.url)) {
                log(typeof i18n !== 'undefined' ? i18n.t('popupNotGemini') : '当前页不是 gemini.google.com，请先打开 Gemini 对话页');
                return;
            }
            const slotMatch = tab.url.match(/\/u\/(\d+)(?:\/|$)/);
            const slot = slotMatch ? ('u' + slotMatch[1]) : 'u0';
            const m = tab.url.match(/\/app\/(c_)?([A-Za-z0-9_-]{8,})/);
            if (!m) {
                log(typeof i18n !== 'undefined' ? i18n.t('popupNoChatId') : '当前页未打开具体对话 (URL 中没找到对话 ID)');
                return;
            }
            const convId = m[2].replace(/^c_/, '');
            log(typeof i18n !== 'undefined' ? i18n.t('popupFoundChat', convId) : `找到对话 ID: ${convId}，正在抓取内容…`);
            if (bar) bar.style.width = '40%';

            chrome.runtime.sendMessage({ action: 'fetchChat', conversationId: convId, accountSlot: slot }, async (res) => {
                if (chrome.runtime.lastError) {
                    log(typeof i18n !== 'undefined' ? i18n.t('popupFetchFailed', chrome.runtime.lastError.message) : ('抓取失败: ' + chrome.runtime.lastError.message));
                    return;
                }
                if (!res || !res.success) {
                    log(typeof i18n !== 'undefined' ? i18n.t('popupFetchFailed', res?.error || '未知错误') : ('抓取失败: ' + (res?.error || '未知错误')));
                    return;
                }
                if (bar) bar.style.width = '80%';
                const chat = res.data || res;
                if (!chat.id) chat.id = convId;
                if (!chat.url) chat.url = `https://gemini.google.com/app/${convId}`;
                chat.title = cleanTitle(chat.title);
                if (!chat.title || chat.title === 'Untitled conversation') {
                    try {
                        const list = Storage ? await Storage.getConversations(slot) : [];
                        const found = list.find((c: any) => c.id === convId || c.id === `c_${convId}`);
                        if (found && found.title) chat.title = cleanTitle(found.title);
                    } catch (e) {
                        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:popup.js]', e);
                    }
                }

                const chatFormatter = (typeof ChatFormatter !== 'undefined')
                    ? ChatFormatter
                    : (globalThis as any).ChatFormatter;
                const formatted = (typeof chatFormatter !== 'undefined')
                    ? chatFormatter.formatContent(chat, format)
                    : { content: JSON.stringify(chat, null, 2), ext: 'json', mime: 'application/json' };
                const content = formatted.content;
                const ext = formatted.ext;
                const mime = formatted.mime;

                const safeTitle = sanitizeFileName(cleanTitle(chat.title || chat.id), 'conversation');
                const fileName = `${safeTitle}_${convId.slice(-6)}.${ext}`;
                const blob = new Blob([content], { type: mime });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 3000);

                if (bar) bar.style.width = '100%';
                log(typeof i18n !== 'undefined' ? i18n.t('popupExported', fileName, chat.messages?.length || 0) : `已导出: ${fileName} (${chat.messages?.length || 0} 条消息)`);

                try {
                    const finalTitle = chat.title || convId;
                    const rec = {
                        title: finalTitle,
                        exportedAt: new Date().toISOString(),
                        messageCount: chat.messages?.length || 0,
                        chatTime: chat.timestamp || Date.now(),
                        status: 'ok'
                    };
                    if (Storage) {
                        await Storage.saveExportRecord(slot, convId, rec);
                        const list = await Storage.getConversations(slot);
                        const normId = (id: any) => String(id || '').replace(/^c_/, '').trim();
                        const item = list.find((c: any) => normId(c.id) === normId(convId));
                        if (item && finalTitle !== convId && item.title !== finalTitle) {
                            item.title = finalTitle;
                            await Storage.setConversations(slot, list);
                        }
                    } else {
                        const expKey = slot === 'u0' ? 'exportedIds' : `gemini_exported_${slot}`;
                        const expData: any = await chrome.storage.local.get([expKey]);
                        const curExp = expData[expKey] || {};
                        curExp[convId] = rec;
                        await chrome.storage.local.set({ [expKey]: curExp });
                    }
                } catch (e) {
                    console.warn('[GemExporter:storage] Storage operation failed:', e);
                }
            });
        } catch (e: any) {
            log(typeof i18n !== 'undefined' ? i18n.t('popupExportError', e?.message) : ('导出异常: ' + e?.message));
            console.error('[popup] export current err', e);
        }
    });

    // Listen for sync updates
    chrome.runtime.onMessage.addListener((msg: any) => {
        const i18n = getI18n();
        if (msg.action === 'syncUpdate') {
            const badge = $('countBadge');
            if (badge) badge.textContent = typeof i18n !== 'undefined' ? i18n.t('syncedBadge', msg.count) : `${msg.count} synced`;
        }
        if (msg.action === 'exportProgress' || msg.action === 'scanProgress') {
            const bar = $('bar');
            const progWrap = $('progWrap');
            if (progWrap) progWrap.style.display = 'block';
            let pct = typeof msg.percent === 'number' ? msg.percent : (msg.total ? Math.floor((msg.done / msg.total) * 100) : 50);
            if (bar) bar.style.width = Math.min(Math.max(pct, 5), 100) + '%';
            if (msg.title) log(msg.title);
        }
    });

    // Init i18n and count
    const i18n = getI18n();
    if (typeof i18n !== 'undefined') {
        i18n.initLanguage().then(() => {
            i18n.applyI18n();
            i18n.applyLangToggleUI();
            i18n.onLanguageChange(() => i18n.applyLangToggleUI());
            updateCount();
        });
    } else {
        updateCount();
    }
    // Event-driven refresh: storage changes + explicit tab updates replace polling
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && (changes.gemini_conversations || changes.gemini_conversations_u0 || changes.gemini_last_count || changes.gemini_last_sync)) {
                updateCount();
            }
        });
    }
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener(() => updateCount());
    }

export {};
