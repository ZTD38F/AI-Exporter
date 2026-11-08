import { getSettings, updateSettings } from '../../application/settings/index.js';
import { listAccounts } from '../../runtime/api/accountRegistry.js';
import { listExportRecords } from '../../l3a/storageService.js';
import { REVIEW_URL, DISCORD_URL } from '../../shared/utils/constants.js';
import { text } from './settings.js';

/** Persisted successful records count each conversation once, across formats and accounts. */
export async function showRatingPromptIfEligible(): Promise<void> {
    if (document.getElementById('ratingPrompt') || (await getSettings()).ratingPromptDismissed) return;
    const accounts = await listAccounts();
    const histories = await Promise.all(accounts.map(account => listExportRecords(account.id)));
    const count = histories.reduce((sum, records) => sum + Object.values(records).filter(record => record.status === 'ok').length, 0);
    if (count < 10 || document.getElementById('ratingPrompt') || (await getSettings()).ratingPromptDismissed) return;
    const card = document.createElement('dialog');
    card.id = 'ratingPrompt'; card.className = 'rating-prompt tour-popover';
    card.setAttribute('aria-labelledby', 'ratingPromptTitle');
    card.setAttribute('aria-describedby', 'ratingPromptDescription');
    const header = document.createElement('div'); header.className = 'tour-header';
    const badge = document.createElement('span'); badge.className = 'tour-step-badge';
    badge.textContent = text('Thank you', '感谢支持');
    const dismiss = document.createElement('button');
    dismiss.id = 'ratingPromptDismiss'; dismiss.type = 'button'; dismiss.className = 'tour-close-btn';
    dismiss.textContent = '×'; dismiss.setAttribute('aria-label', text('Close', '关闭'));
    header.append(badge, dismiss);
    const title = document.createElement('h2'); title.className = 'tour-title';
    title.id = 'ratingPromptTitle';
    title.textContent = text('Thank you for using Gemini Exporter!', '感谢使用 Gemini Exporter！');
    const description = document.createElement('p'); description.className = 'tour-content';
    description.id = 'ratingPromptDescription';
    description.textContent = text('If Gemini Exporter has been helpful, please leave a review on the Chrome Web Store. Your review means a lot to us. Join our Discord community for quicker support and feedback.',
        '如果 Gemini Exporter 对你有帮助，欢迎在 Chrome 商店留下评价。你的评价对我们非常重要。也欢迎加入 Discord，与我们交流，获得更及时的反馈。');
    const actions = document.createElement('div'); actions.className = 'tour-footer';
    const discord = document.createElement('a'); discord.className = 'tour-nav-btn';
    discord.id = 'ratingPromptDiscord'; discord.href = DISCORD_URL;
    discord.textContent = text('Join Discord', '加入 Discord');
    const rate = document.createElement('a'); rate.className = 'tour-nav-btn primary';
    rate.id = 'ratingPromptRate'; rate.href = REVIEW_URL;
    rate.textContent = text('Leave a review', '去评价');
    const remember = async () => {
        await updateSettings({ ratingPromptDismissed: true });
        observer.disconnect(); card.close(); card.remove();
    };
    const reportError = (error: unknown) => console.warn('[Rating prompt] Could not save dismissal', error);
    dismiss.addEventListener('click', () => { void remember().catch(reportError); });
    card.addEventListener('cancel', event => {
        event.preventDefault(); void remember().catch(reportError);
    });
    for (const link of [rate, discord]) {
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.addEventListener('click', event => {
            event.preventDefault();
            // Persist before opening a tab, which can close an extension popup.
            void remember().then(() => chrome.tabs.create({ url: link.href })).catch(reportError);
        });
    }
    actions.append(rate, discord); card.append(header, title, description, actions);
    const reveal = () => {
        if (!card.isConnected || document.querySelector('.tour-overlay-container, dialog[open], [aria-modal="true"]')) return;
        observer.disconnect(); card.showModal();
        void updateSettings({ ratingPromptDismissed: true }).catch(reportError);
    };
    const observer = new MutationObserver(reveal);
    document.body.append(card);
    // Wait for the tutorial and queued prompts to finish before taking focus.
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    reveal();
}
