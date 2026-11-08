import { PLATFORM_HOSTS, ACTIVE_SOURCE_PLATFORMS as platforms, type SourcePlatform } from '../../shared/platformHosts.js';
import { activatePlatformAccess, findAuthorizedAccount, hasPlatformAccess,
    observePlatformAccess, requestPlatformAuthorization } from '../../runtime/capabilities/platformAuthorization.js';
import { text } from './settings.js';

const names: Record<SourcePlatform, string> = { gemini: 'Gemini', chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' };

/** Shared by onboarding and the standalone site-access dialog. Selection never revokes access. */
export function mountPlatformAuthorization(host: HTMLElement, options: {
    ready?: (authorized: boolean) => void;
    connected?: (accountId: string) => Promise<void>;
    selectedPlatforms?: readonly SourcePlatform[];
    platforms?: readonly SourcePlatform[];
    granted?: (platforms: readonly SourcePlatform[]) => void;
    allAuthorized?: () => void;
} = {}): () => void {
    const targets = options.platforms ?? platforms;
    let active = true;
    let busy = false;
    let revision = 0;
    let authorized: SourcePlatform[] = [];
    const box = document.createElement('div');
    box.className = 'platform-authorization';
    const authorize = document.createElement('button');
    authorize.type = 'button';
    authorize.className = 'tour-action-btn';
    authorize.id = 'btnAuthorizePlatforms';
    authorize.textContent = text('Authorize', '授权');
    const list = document.createElement('fieldset');
    list.className = 'platform-permission-list';
    const legend = document.createElement('legend');
    legend.textContent = text('Platforms needing access', '尚未授权的平台');
    list.append(legend);
    // A granted platform is never a selectable request target, even during refresh.
    const selection = () => rows.filter(row => !row.row.hidden && row.input.checked).map(row => row.platform);
    const updateButton = () => { authorize.disabled = busy || !selection().length; };
    const rows = targets.map(platform => {
        const row = document.createElement('div');
        row.className = 'platform-permission-row';
        row.dataset.platform = platform;
        const label = document.createElement('label');
        label.className = 'platform-permission-choice';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = platform;
        input.checked = options.selectedPlatforms ? options.selectedPlatforms.includes(platform) : true;
        input.addEventListener('change', updateButton);
        const name = document.createElement('span');
        name.textContent = names[platform];
        const state = document.createElement('span');
        state.className = 'platform-permission-state';
        label.append(input, name);
        const heading = document.createElement('div');
        heading.className = 'platform-permission-heading';
        heading.append(label, state);
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = text('Conversation and attachment sites', '会话与附件网站');
        const sites = document.createElement('ul');
        for (const origin of [...PLATFORM_HOSTS[platform].pages, ...PLATFORM_HOSTS[platform].attachments]) {
            const site = document.createElement('li');
            site.textContent = origin.replace('https://', '').replace('/*', '');
            sites.append(site);
        }
        details.append(summary, sites);
        row.append(heading, details);
        list.append(row);
        return { platform, row, input, state };
    });
    const hint = document.createElement('p');
    hint.className = 'platform-permission-hint';
    hint.textContent = text('Only unconnected platforms are shown. Select which ones to authorize.',
        '仅显示尚未授权的平台，请选择需要授权的平台。');
    const status = document.createElement('div');
    status.className = 'tour-status-indicator';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    box.append(authorize, list, hint, status);
    host.append(box);
    // Avoid flashing already-granted choices before the first async permission read.
    list.hidden = true;
    authorize.hidden = true;
    hint.hidden = true;
    const refresh = async () => {
        const current = ++revision;
        const granted = await Promise.all(targets.map(hasPlatformAccess));
        if (!active || current !== revision) return;
        authorized = targets.filter((_, index) => granted[index]);
        for (const { platform, row, state } of rows) {
            row.hidden = authorized.includes(platform);
            state.textContent = text('Not authorized', '未授权');
            state.dataset.authorized = 'false';
        }
        const remaining = authorized.length < targets.length;
        list.hidden = !remaining;
        authorize.hidden = !remaining;
        hint.hidden = !remaining;
        const completeText = options.platforms ? text(
            'Website access is granted. Open the platform and sign in to the selected account, then retry sync.',
            '网站访问权限已授予。请打开平台并登录所选账号，然后重试同步。') : text('All supported platforms have website access.', '所有支持的平台均已获得网站访问权限。');
        if (!remaining) status.textContent = completeText;
        else if (status.textContent === completeText) status.textContent = '';
        updateButton();
        options.ready?.(!busy && authorized.length > 0);
        if (!busy && !remaining) options.allAuthorized?.();
    };
    authorize.addEventListener('click', () => {
        const selected = selection();
        if (!active || busy || !selected.length) return;
        // One native prompt for the union, started synchronously in this click.
        const request = requestPlatformAuthorization(selected);
        busy = true;
        list.disabled = true;
        updateButton();
        options.ready?.(false);
        status.textContent = text('Waiting for Chrome permission…', '正在等待 Chrome 授权…');
        void (async () => {
            const granted = await request;
            if (!active) return;
            if (!granted) {
                status.textContent = text('Access was not granted. You can change the selection and try again.',
                    '未获得授权。可以调整所选平台后重试。');
                return;
            }
            const activated = await activatePlatformAccess(selected);
            if (!active) return;
            status.textContent = activated
                ? text('Selected platforms authorized. Sign in on their websites when needed.', '所选平台已授权。需要时请在对应网站登录。')
                : text('Access granted. Reload the platform page to activate it.', '权限已授予。请刷新平台页面以启用。');
            options.granted?.(selected);
            // Account endpoints may be slow or rate limited. Their result never holds the authorization UI open.
            if (active && options.connected) void findAuthorizedAccount(selected).then(async accountId => {
                if (active && accountId) await options.connected?.(accountId);
            }).catch(() => {});
        })().catch(() => {
            if (active) status.textContent = text('Could not finish setup. Check access below and try again.', '未能完成设置，请检查下方授权状态后重试。');
        }).finally(() => {
            busy = false;
            if (!active) return;
            list.disabled = false;
            updateButton();
            void refresh();
        });
    });
    const changed = () => { void refresh(); };
    const stopObserving = observePlatformAccess(changed);
    window.addEventListener('focus', changed);
    void refresh();
    return () => {
        active = false;
        stopObserving();
        window.removeEventListener('focus', changed);
        box.remove();
    };
}
