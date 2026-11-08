import { STEPS, PLATFORM_STEPS, AUTHORIZATION_STEP } from './tourSteps.js';
import { text } from '../shared/settings.js';
import { mountPlatformAuthorization } from '../shared/platformAuthorization.js';
import { ACTIVE_SOURCE_PLATFORMS, type SourcePlatform } from '../../shared/platformHosts.js';
import { hasPlatformAccess, requestPlatformAuthorization, activatePlatformAccess, openPlatformSignIn, findAuthorizedAccount, observePlatformAccess } from '../../runtime/capabilities/platformAuthorization.js';
import { listAccounts } from '../../runtime/api/accountRegistry.js';
import { resolveScanTarget } from '../../runtime/capabilities/tabService.js';
let root: HTMLElement | null = null;
let stepIndex = 0;
let mode: 'tour' | 'platforms' | 'spotlight' | 'takeout' | 'authorization' | null = null;
let cleanupStep: (() => void) | undefined;
let cleanupOverlay: (() => void) | undefined;
let onDismiss: (() => void) | undefined;
let relayout: (() => void) | undefined;
let afterTutorial: (() => void) | undefined;
let authorizationReady = false;
let onConnected: ((accountId: string) => Promise<void>) | undefined;
let prepareLiveSave: (() => Promise<void>) | undefined;

export function consumeTourIntent(): boolean {
    const url = new URL(location.href);
    const start = url.searchParams.get('startTour') === '1';
    if (url.searchParams.has('startTour')) { url.searchParams.delete('startTour'); history.replaceState(history.state, '', url); }
    return start;
}
function destroy(): void {
    afterTutorial = undefined;
    delete document.body.dataset.guidedSelection;
    cleanupStep?.(); cleanupStep = undefined;
    cleanupOverlay?.(); cleanupOverlay = undefined;
    root?.remove(); root = null; mode = null; onDismiss = undefined; relayout = undefined;
    authorizationReady = false; onConnected = undefined; prepareLiveSave = undefined;
}
function close(): void {
    const callback = onDismiss;
    const deferred = mode === 'tour' ? afterTutorial : undefined;
    destroy(); callback?.(); deferred?.();
}
const finishTour = async (): Promise<void> => { close(); };
const skipTour = finishTour;
const dismissFeatureSpotlight = async (): Promise<void> => { close(); };
const isActive = (): boolean => root !== null;
const isLiveSaveStep = (): boolean => mode === 'tour' && STEPS[stepIndex]?.id === 'live_save';
function modalOpen(): boolean { return isActive() || !!document.querySelector('dialog[open], [aria-modal="true"]'); }


type Placement = 'top' | 'bottom' | 'left' | 'right';

/** Render the original main Tour card and highlight, retaining v2's physical click cutout. */
function overlay(
    target: HTMLElement | null | (() => HTMLElement | null), title: string, description: string | HTMLElement, interactive: boolean,
    related: HTMLElement[] | (() => HTMLElement[]) = [], placement: Placement = 'bottom', badgeText?: string, hint?: string, centered = false,
): HTMLElement {
    cleanupStep?.(); cleanupStep = undefined;
    cleanupOverlay?.(); cleanupOverlay = undefined;
    root?.remove();
    const previousFocus = document.activeElement;
    const currentTarget = () => typeof target === 'function' ? target() : target;
    const currentRelated = () => typeof related === 'function' ? related() : related;
    currentTarget()?.scrollIntoView({ block: 'center', inline: 'nearest' });
    const container = document.createElement('div');
    root = container;
    container.className = 'tour-overlay-container';

    const spotlight = document.createElement('div');
    spotlight.className = 'tour-spotlight';
    const popover = document.createElement('div');
    popover.className = 'tour-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'true');
    popover.tabIndex = -1;

    const header = document.createElement('div');
    header.className = 'tour-header';
    const badge = document.createElement('span');
    badge.className = mode === 'spotlight' || mode === 'platforms' ? 'tour-step-badge tour-feature-badge' : 'tour-step-badge';
    badge.textContent = badgeText ?? (String(stepIndex + 1) + ' / ' + String(STEPS.length));
    const closeButton = button(header, '×', close, 'tourCloseBtn', 'tour-close-btn');
    closeButton.title = text('Close (ESC)', '关闭（ESC）');
    header.prepend(badge);

    const heading = document.createElement('h2');
    heading.className = 'tour-title';
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'tour-content';
    if (typeof description === 'string') body.textContent = description;
    else body.append(description);
    popover.append(header, heading, body);
    if (hint) {
        const hintBox = document.createElement('div');
        hintBox.className = 'tour-action-hint';
        hintBox.textContent = hint;
        popover.append(hintBox);
    }
    container.append(spotlight, popover);
    document.body.append(container);

    const backdrop: HTMLElement[] = [];
    const layout = () => {
        backdrop.forEach(el => el.remove());
        backdrop.length = 0;
        const candidate = currentTarget();
        const visible = candidate && candidate.isConnected && candidate.getClientRects().length ? candidate : null;
        const w = window.innerWidth, h = window.innerHeight;
        const pad = 6;
        const bounds = [visible, ...currentRelated()].filter((item): item is HTMLElement =>
            !!item && item.isConnected && !!item.getClientRects().length).map(item => item.getBoundingClientRect());
        // The border and click cutout share the same padded, viewport-clipped bounds.
        const region = bounds.length ? {
            top: Math.max(0, Math.min(...bounds.map(item => item.top)) - pad),
            left: Math.max(0, Math.min(...bounds.map(item => item.left)) - pad),
            right: Math.min(w, Math.max(...bounds.map(item => item.right)) + pad),
            bottom: Math.min(h, Math.max(...bounds.map(item => item.bottom)) + pad),
        } : null;
        const rect = region && region.right > region.left && region.bottom > region.top ? region : null;
        if (rect) {
            spotlight.classList.remove('tour-spotlight-hidden');
            Object.assign(spotlight.style, {
                left: rect.left + 'px',
                top: rect.top + 'px',
                width: (rect.right - rect.left) + 'px',
                height: (rect.bottom - rect.top) + 'px',
            });
        } else {
            spotlight.classList.add('tour-spotlight-hidden');
        }

        // Only the highlighted UI and explicit related controls are physically clickable.
        const hole = interactive ? rect : null;
        const panel = document.createElement('div');
        panel.className = 'tour-backdrop';
        Object.assign(panel.style, { left: '0px', top: '0px', width: w + 'px', height: h + 'px' });
        if (hole) {
            const { left, top, right, bottom } = hole;
            const radius = Math.min(parseFloat(getComputedStyle(spotlight).borderTopLeftRadius),
                (right - left) / 2, (bottom - top) / 2);
            // One rounded cutout controls both paint and hit testing, matching the border.
            panel.style.clipPath = `path(evenodd, "M0 0H${w}V${h}H0Z ` +
                `M${left + radius} ${top}H${right - radius}A${radius} ${radius} 0 0 1 ${right} ${top + radius}` +
                `V${bottom - radius}A${radius} ${radius} 0 0 1 ${right - radius} ${bottom}` +
                `H${left + radius}A${radius} ${radius} 0 0 1 ${left} ${bottom - radius}` +
                `V${top + radius}A${radius} ${radius} 0 0 1 ${left + radius} ${top}Z")`;
        }
        panel.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (mode !== 'tour') close(); });
        container.prepend(panel);
        backdrop.push(panel);

        // Respect the original per-step right/left/bottom placements; avoid collision.
        const width = popover.offsetWidth, height = popover.offsetHeight;
        let x = (w - width) / 2, y = (h - height) / 2;
        if (rect && !centered) {
            const gap = 16, margin = 16;
            const available: Placement[] = [placement, 'right', 'left', 'bottom', 'top'];
            for (const side of [...new Set(available)]) {
                if (side === 'right' && rect.right + width + gap + margin <= w) {
                    x = rect.right + gap; y = rect.top - 10; break;
                }
                if (side === 'left' && rect.left - width - gap >= margin) {
                    x = rect.left - width - gap; y = rect.top - 10; break;
                }
                if (side === 'bottom' && rect.bottom + height + gap + margin <= h) {
                    x = rect.left; y = rect.bottom + gap; break;
                }
                if (side === 'top' && rect.top - height - gap >= margin) {
                    x = rect.left; y = rect.top - height - gap; break;
                }
            }
        }
        // CSS viewport bounds apply immediately, even before the resize handler runs.
        popover.style.left = `clamp(12px, ${x}px, calc(100vw - ${width}px - 12px))`;
        popover.style.top = `clamp(12px, ${y}px, calc(100vh - ${height}px - 12px))`;
        popover.style.transform = 'none';
    };
    const guard = (event: MouseEvent) => {
        const node = event.target;
        // Internal Blob deliveries are programmatic actions, not clicks on the workbench.
        if (!event.isTrusted && node instanceof HTMLAnchorElement && node.hasAttribute('download')
            && node.href.startsWith(`blob:${location.origin}/`)) return;
        if (node instanceof Node && (popover.contains(node) || node instanceof Element && !!node.closest('.tour-coach-card') && container.contains(node) || interactive && [currentTarget(), ...currentRelated()].some(item => item?.contains(node)))) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (mode !== 'tour') close();
    };
    const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener('click', guard, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    const frame = requestAnimationFrame(layout);
    // Options re-renders rows with replaceChildren() while a scan completes.
    // Follow the live row without binding to a detached DOM node.
    const list = mode === 'tour' && STEPS[stepIndex]?.id === 'select' ? document.getElementById('list') : null;
    const folderControls = mode === 'tour' && STEPS[stepIndex]?.id === 'live_save' ? document.getElementById('localFolderControls') : null;
    const observer = list || folderControls ? new MutationObserver(layout) : null;
    if (list) observer?.observe(list, { childList: true });
    if (folderControls) observer?.observe(folderControls, { attributes: true, attributeFilter: ['data-authorized'] });
    const sizeObserver = new ResizeObserver(layout);
    sizeObserver.observe(popover);
    // Observe preceding content too: the target may move without changing size.
    const leftCard = document.querySelector('.card-left');
    if (leftCard) {
        sizeObserver.observe(leftCard);
        for (const child of leftCard.children) sizeObserver.observe(child);
    }
    // Scan status and controls can change workbench layout without a window resize.
    const workbenchList = document.getElementById('list');
    if (workbenchList) sizeObserver.observe(workbenchList);
    cleanupOverlay = () => {
        observer?.disconnect();
        sizeObserver.disconnect();
        cancelAnimationFrame(frame);
        document.removeEventListener('click', guard, true);
        document.removeEventListener('keydown', keydown, true);
        window.removeEventListener('resize', layout);
        window.removeEventListener('scroll', layout, true);
        if (previousFocus instanceof HTMLElement || previousFocus instanceof SVGElement) previousFocus.focus();
    };
    relayout = layout;
    layout();
    popover.focus();
    return popover;
}
function button(
    parent: HTMLElement, label: string, action: () => void, id?: string, className?: string,
): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (id) btn.id = id;
    if (className) btn.className = className;
    btn.addEventListener('click', action);
    parent.append(btn);
    return btn;
}
function footer(popover: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tour-footer';
    popover.append(el);
    return el;
}

async function goToStep(index: number): Promise<void> {
    if (mode !== 'tour' && mode !== 'platforms') return;
    if (mode === 'tour') document.body.dataset.guidedSelection = 'true';
    const steps = mode === 'platforms' ? PLATFORM_STEPS : STEPS;
    const length = steps.length;
    if (index >= length) { close(); return; }
    const nextIndex = Math.max(0, index);
    const returning = nextIndex < stepIndex;
    if (steps[nextIndex].id === 'live_save' && prepareLiveSave) {
        const previousRoot = root;
        try { await prepareLiveSave(); } catch { return; }
        if (mode !== 'tour' || root !== previousRoot) return;
    }
    stepIndex = nextIndex;
    const step = steps[stepIndex];
    if (step === AUTHORIZATION_STEP) {
        const { popover, bar } = platformAuthorizationPage();
        popover.classList.add('tour-authorization-menu');
        authorizationReady = false;
        const next = button(bar, text('Next', '下一步'), () => { void nextStep(); }, 'tourNextBtn', 'tour-nav-btn primary');
        next.disabled = true;
        const stopAuthorization = mountAuthorization(popover, bar, ready => {
            if (mode !== 'tour' || steps[stepIndex] !== step || !popover.isConnected) return;
            authorizationReady = ready;
            next.disabled = !ready;
        }, () => {
            if (mode !== 'tour' || steps[stepIndex] !== step || !popover.isConnected) return;
            authorizationReady = true;
            void nextStep();
        });
        const stopCoaching = mountAuthorizationCoaching(popover);
        cleanupStep = () => { stopCoaching(); stopAuthorization(); };
        relayout?.();
        return;
    }
    const relatedId = step.id === 'live_save' ? 'btnSetDir' : step.id === 'export' ? 'btnCancel' : undefined;
    const related = relatedId
        ? [document.getElementById(relatedId)].filter((item): item is HTMLElement => item instanceof HTMLElement)
        : [];
    // Detection and selector explanation are the two parts of the account lesson.
    const tourPage = stepIndex + 1 - Number(stepIndex > STEPS.findIndex(item => item.id === 'identify_account'));
    const popover = overlay(step.target, step.title(), step.description(), true,
        () => step.id === 'live_save' && document.querySelector('#localFolderControls[data-authorized="true"]') ? [] : related, step.placement, mode === 'platforms' ? `✨ v2.1.0 · ${stepIndex + 1} / ${length}` : `${tourPage} / ${length - 1}`, step.hint?.());
    const navFooter = footer(popover);
    if (stepIndex < length - 1 && step.id !== 'identify_account')
        button(navFooter, text('Skip', '跳过'), close, 'tourSkipBtn', 'tour-skip-btn');
    const nav = document.createElement('div');
    nav.className = 'tour-nav-btns';
    navFooter.append(nav);
    if (stepIndex > 0) button(nav, text('Back', '上一步'), () => { void prevStep(); },
        'tourPrevBtn', 'tour-nav-btn');
    const nextButton = button(nav, stepIndex === length - 1 ? text('Start using', '开始使用') : text('Next', '下一步'),
        () => { void nextStep(); }, 'tourNextBtn', 'tour-nav-btn primary');
    relayout?.();

    let advanced = false;
    const advance = () => {
        if (advanced || (mode !== 'tour' && mode !== 'platforms') || steps[stepIndex] !== step) return;
        advanced = true;
        void nextStep();
    };
    cleanupStep = step.setupAction?.(advance);
    if (step.id === 'identify_account') {
        nextButton.disabled = true;
        cleanupStep = mountAccountDiscovery(popover, navFooter, nextButton, !returning);
    }

}
/** A user action owns this completion; cached state cannot start it. */
function beginStepAction(id: 'sync' | 'export' | 'format' | 'live_save'): ((ready: boolean) => void) | undefined {
    if (mode !== 'tour' || STEPS[stepIndex]?.id !== id || !root) return;
    const card = root;
    const next = card.querySelector('#tourNextBtn');
    if (!(next instanceof HTMLButtonElement)) return;
    next.disabled = true;
    return ready => {
        if (root !== card) return;
        next.disabled = false;
        if (ready) void nextStep();
    };
}
const beginScan = () => beginStepAction('sync');
const beginExport = () => beginStepAction('export');
const beginFormatSelection = () => beginStepAction('format');
const beginLiveSave = () => beginStepAction('live_save');
async function nextStep(): Promise<void> {
    if (mode === 'tour' && (STEPS[stepIndex]?.id === 'connect' && !authorizationReady
        || STEPS[stepIndex]?.id !== 'connect' && root?.querySelector<HTMLButtonElement>('#tourNextBtn')?.disabled)) return;
    await goToStep(stepIndex + 1);
}
async function prevStep(): Promise<void> { await goToStep(stepIndex - 1); }
async function startTour(connected?: (accountId: string) => Promise<void>,
    liveSaveSetup?: () => Promise<void>): Promise<void> {
    if (modalOpen()) return;
    destroy(); mode = 'tour'; document.body.dataset.guidedSelection = 'true'; onConnected = connected; prepareLiveSave = liveSaveSetup;
    await goToStep(0);
}

/** Two explanations accompany the actual authorization menu, without opening a second modal. */
function mountAuthorizationCoaching(menu: HTMLElement): () => void {
    const container = root;
    if (!container) return () => {};
    const card = (id: string, title: string, description: string) => {
        const box = document.createElement('section');
        box.id = id;
        box.className = 'tour-coach-card';
        const heading = document.createElement('h3');
        heading.textContent = title;
        const copy = document.createElement('p');
        copy.textContent = description;
        box.append(heading, copy);
        return box;
    };
    const why = card('tourAuthorizationWhy', text('Allow access to your conversations', '授权读取对话数据'),
        text('Choose the platforms you use in this menu. We need your permission to read their conversation and attachment data. Authorize at least one platform to continue.',
            '请在高亮菜单中选择需要使用的平台。我们需要你授权后才能读取对应网站的对话和附件数据。至少授权一个平台，才能进入下一步。'));
    const more = card('tourAuthorizationMore', text('Add more sites later', '以后可以授权更多网站'),
        text('Use the highlighted Site access button in the top right whenever you want to authorize more platforms.',
            '以后需要使用其他平台时，可以随时点击右上角高亮的「网站授权」按钮，授权更多网站。'));
    menu.setAttribute('aria-describedby', `${why.id} ${more.id}`);
    const layout = () => {
        const compact = innerWidth < 1100;
        menu.classList.toggle('tour-authorization-compact', compact);
        if (compact) {
            if (why.parentNode !== menu) {
                const content = menu.querySelector('.tour-content');
                content?.after(why, more);
            }
            for (const box of [why, more]) { box.style.left = ''; box.style.top = ''; }
        } else {
            if (why.parentNode !== container) container.append(why, more);
            const bounds = menu.getBoundingClientRect();
            why.style.left = Math.max(12, bounds.left - 272) + 'px';
            why.style.top = Math.max(12, bounds.top) + 'px';
            const button = document.getElementById('btnPlatformPermissions')?.getBoundingClientRect();
            more.style.left = Math.min(innerWidth - 272, Math.max(bounds.right + 16, button?.left ?? bounds.right + 16)) + 'px';
            more.style.top = Math.max(12, (button?.bottom ?? 40) + 16) + 'px';
        }
    };
    const observer = new ResizeObserver(layout);
    observer.observe(menu);
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    layout();
    return () => { observer.disconnect(); window.removeEventListener('resize', layout); window.removeEventListener('scroll', layout, true); why.remove(); more.remove(); };
}

/** Open a permitted site in the background and detect until this lesson ends. */
function mountAccountDiscovery(popover: HTMLElement, before: HTMLElement, next: HTMLButtonElement, advanceOnDetection: boolean): () => void {
    const host = document.createElement('div');
    host.className = 'tour-action-box';
    popover.insertBefore(host, before);
    const status = document.createElement('p');
    status.className = 'tour-status-indicator';
    status.setAttribute('role', 'status');
    host.append(status);
    const choices = document.createElement('div');
    choices.className = 'tour-platform-choices';
    host.prepend(choices);
    const names: Record<SourcePlatform, string> = { gemini: 'Gemini', chatgpt: 'ChatGPT', grok: 'Grok', claude: 'Claude' };
    let active = true;
    let checking = false;
    let userInteracted = false;
    let refreshPending = false;
    let backgroundDetection: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
        if (!active) return;
        if (checking) { refreshPending = true; return; }
        checking = true;
        retry.disabled = true;
        status.textContent = text('Checking for accounts…', '正在识别账号…');
        try {
            const access = await Promise.all(ACTIVE_SOURCE_PLATFORMS.map(hasPlatformAccess));
            if (!active) return;
            const authorized = ACTIVE_SOURCE_PLATFORMS.filter((_, i) => access[i]);
            if (!authorized.length) { void goToStep(0); return; }
            choices.replaceChildren();
            for (const platform of authorized) button(choices, text(`Connect ${names[platform]}`, `连接 ${names[platform]}`), () => {
                userInteracted = true;
                void (async () => {
                    if (!await hasPlatformAccess(platform) || !active) { await refresh(); return; }
                    await openPlatformSignIn(platform, false);
                    if (!active) return;
                    status.textContent = text('Connecting your account. If needed, sign in on the platform tab and check again.', '正在连接账号；如尚未登录，请前往平台页面登录后重新检测。');
                    if (backgroundDetection === undefined) backgroundDetection = setInterval(() => { void refresh(); }, 1500);
                    void refresh();
                })().catch(() => { if (active) status.textContent = text('Could not open the platform. Please try again.', '未能打开平台，请重试。'); });
            }, `btnConnectPlatform-${platform}`, 'tour-action-btn secondary');
            const accounts = (await listAccounts()).filter(account => account.providerAccountId !== 'default'
                && authorized.some(platform => platform === account.providerId));
            const selector = document.getElementById('accountIdSelect');
            const known = accounts.find(account => selector instanceof HTMLSelectElement && account.id === selector.value) ?? accounts[0];
            let accountId: string | null = known?.id ?? await findAuthorizedAccount(authorized);
            // A stored identity is not proof that this account can scan now.
            if (accountId) {
                try { if (await resolveScanTarget(accountId) !== accountId) accountId = null; }
                catch { accountId = null; }
            }
            if (!active || refreshPending) return;
            if (accountId) {
                await onConnected?.(accountId);
                if (active && !refreshPending) {
                    next.disabled = false;
                    if (advanceOnDetection && userInteracted) void goToStep(STEPS.findIndex(step => step.id === 'accounts'));
                    else status.textContent = text('An account is connected. Connect another platform or choose Next.', '已连接账号。你可以继续连接其他平台，或点击「下一步」。');
                }
            } else {
                next.disabled = true;
                status.textContent = text('No account identified yet. Connect an authorized platform and sign in, then check again.',
                    '尚未识别到账号。请连接已授权的平台并登录，然后点击重新检测。');
            }
        } catch {
            if (active) next.disabled = true;
            if (active) status.textContent = text('Account detection failed. You can retry after signing in.', '账号识别失败，请登录平台后重试。');
        } finally {
            checking = false;
            if (active) {
                retry.disabled = false;
                if (refreshPending) { refreshPending = false; void refresh(); }
            }
        }
    };
    const retry = button(host, text('Check again', '重新检测'), () => { userInteracted = true; void refresh(); }, 'btnDetectAccount', 'tour-nav-btn');
    const returned = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    const stopPermissions = observePlatformAccess(returned);
    void refresh();
    return () => { active = false; clearInterval(backgroundDetection); stopPermissions(); window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', returned); host.remove(); };
}

function mountAuthorization(
    popover: HTMLElement, before: HTMLElement,
    ready?: (authorized: boolean) => void, granted?: () => void,
): () => void {
    const host = document.createElement('div');
    popover.insertBefore(host, before);
    const stop = mountPlatformAuthorization(host, { ready, granted, connected: onConnected });
    return () => { stop(); host.remove(); };
}

/** The existing Site access page. Onboarding adds coaching and replaces only its footer action. */
function platformAuthorizationPage(): { popover: HTMLElement; bar: HTMLElement } {
    const tutorial = mode === 'tour' && STEPS[stepIndex] === AUTHORIZATION_STEP;
    const target = tutorial ? () => document.getElementById('btnPlatformPermissions') : null;
    const popover = overlay(target, AUTHORIZATION_STEP.title(), AUTHORIZATION_STEP.description(), tutorial, [],
        'bottom', text('Site access', '网站授权'), undefined, true);
    return { popover, bar: footer(popover) };
}

/** Reopen the same authorization view without starting or advancing the tutorial. */
function showPlatformAuthorization(connected?: (accountId: string) => Promise<void>): void {
    // Let the highlighted button open its real dialog, then resume the walkthrough.
    const resumeIndex = stepIndex + 1;
    const resume = mode === 'platforms' && PLATFORM_STEPS[stepIndex].id === 'site_access';
    if (modalOpen() && !resume) return;
    destroy(); mode = 'authorization'; onConnected = connected;
    if (resume) onDismiss = () => {
        mode = 'platforms';
        void goToStep(resumeIndex);
    };
    const { popover, bar } = platformAuthorizationPage();
    button(bar, text('Done', '完成'), close, 'platformAuthorizationDone', 'tour-nav-btn');
    cleanupStep = mountAuthorization(popover, bar);
    relayout?.();
}

/** Recover the selected account without silently switching to another signed-in account. */
function showAccountConnection(platform: SourcePlatform, accountId: string, accountLabel: string, retry: () => void): void {
    const resume = mode === 'tour' && STEPS[stepIndex]?.id === 'sync'
        ? { index: stepIndex, connected: onConnected, liveSave: prepareLiveSave } : undefined;
    if (modalOpen() && !resume) return;
    const continueSync = () => {
        if (!resume) { retry(); return; }
        mode = 'tour'; onConnected = resume.connected; prepareLiveSave = resume.liveSave;
        void goToStep(resume.index).then(retry);
    };
    destroy(); mode = 'authorization';
    const names: Record<SourcePlatform, string> = { gemini: 'Gemini', chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' };
    const name = names[platform];
    const connectionTitle = text(`Connect ${name} account`, `连接 ${name} 账号`);
    const popover = overlay(null, connectionTitle,
        text(`Open ${name} and sign in to ${accountLabel}, then return here. If another account is signed in, switch accounts there first.`,
            `请前往 ${name} 登录 ${accountLabel}，然后返回此窗口。如果网页上登录的是其他账号，请先切换账号。`),
        false, [], 'bottom', text('Account connection', '账号连接'));
    const bar = footer(popover);
    const status = document.createElement('p');
    status.className = 'tour-status-indicator';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    popover.insertBefore(status, bar);
    let active = true;
    let access = false;
    let connected = false;
    let navigating = false;
    let checking: Promise<boolean> | undefined;
    let refreshWhenSettled = false;
    const renderAction = () => {
        const heading = popover.querySelector('.tour-title');
        if (heading) heading.textContent = connected ? text('Account connected', '账号已连接') : connectionTitle;
        const instructions = popover.querySelector<HTMLElement>('.tour-content');
        if (instructions) instructions.hidden = connected;
        status.hidden = connected;
        action.textContent = connected ? text('Continue sync', '继续同步') : text(`Go to ${name}`, `前往 ${name}`);
        action.disabled = navigating || !!checking;
    };
    const checkConnection = (): Promise<boolean> => {
        if (!active) return Promise.resolve(false);
        if (checking) return checking;
        connected = false;
        status.textContent = text('Checking account connection…', '正在检查账号连接…');
        checking = (async () => {
            try {
                access = await hasPlatformAccess(platform);
                const target = access ? await resolveScanTarget(accountId) : null;
                if (!active) return false;
                connected = target === accountId;
                status.textContent = connected
                    ? text('Account connected. Continue sync when ready.', '账号已连接，点击“继续同步”即可开始同步。')
                    : text('The selected account is not connected. Sign in on the platform, then return here.', '尚未连接所选账号。请前往平台登录该账号后返回此窗口。');
                return connected;
            } catch {
                if (active) status.textContent = text('Could not verify the selected account. Sign in on the platform, then return here.',
                    '尚未确认所选账号的连接。请前往平台登录该账号后返回此窗口。');
                return false;
            } finally {
                checking = undefined;
                if (active) {
                    renderAction();
                    if (refreshWhenSettled) {
                        refreshWhenSettled = false;
                        void checkConnection();
                    }
                }
            }
        })();
        renderAction();
        return checking;
    };
    const action = button(bar, text(`Go to ${name}`, `前往 ${name}`), () => {
        if (!active || navigating || checking) return;
        if (connected) {
            // Verify again immediately before resuming; a previous visit is not proof of account identity.
            void checkConnection().then(verified => { if (active && verified) { close(); continueSync(); } });
            return;
        }
        // Preserve the user gesture when website access still needs a native prompt.
        const request = access ? Promise.resolve(true) : requestPlatformAuthorization([platform]);
        navigating = true;
        renderAction();
        void (async () => {
            if (!await request) {
                if (active) status.textContent = text('Website access was not granted. Try again to connect this account.', '未获得网站访问权限，请重试以连接该账号。');
                return;
            }
            if (!active) return;
            await activatePlatformAccess([platform]);
            if (!active) return;
            await openPlatformSignIn(platform);
            if (active) status.textContent = text('Sign in to the selected account, then return here.', '请登录所选账号，然后返回此窗口。');
        })().catch(() => {
            if (active) status.textContent = text('Could not open the platform. Please try again.', '未能打开平台，请重试。');
        }).finally(() => {
            navigating = false;
            if (active) renderAction();
        });
    }, 'btnAccountConnection', 'tour-nav-btn primary');
    const returned = () => {
        if (!active || navigating || document.hidden) return;
        if (checking) refreshWhenSettled = true;
        else void checkConnection();
    };
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    cleanupStep = () => {
        active = false;
        window.removeEventListener('focus', returned);
        document.removeEventListener('visibilitychange', returned);
    };
    void checkConnection();
    relayout?.();
}

/** Upgrade-only introduction; the tutorial shares just the account-switching step. */
function showPlatformHighlights(): boolean {
    if (modalOpen()) return false;
    mode = 'platforms';
    void goToStep(0);
    return true;
}
function startFeatureSpotlight(version: string, stepId: string, dismissed: () => void): boolean {
    if (modalOpen()) return false;
    const step = STEPS.find(item => item.id === stepId);
    const target = step?.target();
    if (!step || !target || !target.getClientRects().length) return false;
    mode = 'spotlight';
    const popover = overlay(target, step.title(), step.description(), false, [],
        step.placement, '✨ ' + text('NEW FEATURE', '新功能') + ' v' + version);
    onDismiss = dismissed;
    const bar = footer(popover);
    const nav = document.createElement('div');
    nav.className = 'tour-nav-btns';
    bar.append(nav);
    button(nav, text('Got it', '知道了'), close, 'tourSpotlightDismissBtn', 'tour-nav-btn primary');
    relayout?.();
    return true;
}
/** One-time release notice for users crossing from v1 to 2.0. No feature target. */
function showV2UpgradeSpotlight(openFeedback: () => void): boolean {
    if (modalOpen()) return false;
    mode = 'spotlight';
    const copy = document.createElement('div');
    copy.className = 'tour-upgrade-copy';
    const paragraph = (message: string): HTMLParagraphElement => {
        const p = document.createElement('p');
        p.textContent = message;
        copy.append(p);
        return p;
    };
    paragraph(text(
        "We've rebuilt Gemini Exporter from the ground up for better long-term stability and reliability.",
        '我们从底层重构了 Gemini Exporter，以提升长期稳定性和可靠性。'));
    const notice = paragraph(text(
        'Some scan records may be missing after this upgrade. Your original Gemini chats are safe.',
        '升级后，部分扫描记录可能不再显示。您在 Gemini 中的原始对话不受影响。'));
    const warning = document.createElement('strong');
    warning.textContent = text('Important: ', '重要提示：');
    notice.prepend(warning);
    paragraph(text(
        "To restore them, simply scan again. If that doesn't work, try Clear Scan Records and rescan.",
        '重新扫描即可恢复。如果仍有问题，请先清除扫描记录，然后再次扫描。'));
    paragraph(text(
        'Having trouble? Please let us know through Leave Feedback!',
        '遇到问题？欢迎通过「留言反馈」告诉我们！'));
    const popover = overlay(null,
        text('Gemini Exporter 2.0 is Here!', 'Gemini Exporter 2.0 正式发布！'),
        copy, false, [], 'bottom', '✨ ' + text('MAJOR UPDATE', '重大更新'));
    popover.classList.add('tour-upgrade-popover');
    const bar = footer(popover);
    bar.classList.add('tour-upgrade-footer');
    button(bar, text('Leave Feedback', '留言反馈'),
        () => { close(); openFeedback(); }, 'tourUpgradeFeedbackBtn', 'tour-nav-btn');
    button(bar, text('Got it!', '知道了！'), close, 'tourUpgradeDismissBtn', 'tour-nav-btn primary');
    relayout?.();
    return true;
}
function showTakeoutPrompt(
    count: number, dismissed: () => void, importFile: () => void, openTakeout: () => void,
    shown?: () => void,
): boolean {
    if (mode === 'tour') {
        afterTutorial = () => { showTakeoutPrompt(count, dismissed, importFile, openTakeout, shown); };
        return false;
    }
    if (modalOpen()) return false;
    mode = 'takeout';
    const title = text('💡 Supplement Your History with Google Takeout', '💡 使用 Google Takeout 补充历史记录');
    const description = text(
        'This scan fetched ' + count + ' conversations. Gemini may limit online history. In Google Takeout, select My Activity → Gemini Apps to export conversation activity, then import the original ZIP. Takeout activity entries may not contain full chat details.',
        '本次扫描获取了 ' + count + ' 条对话。Gemini 在线历史可能受限。请在 Google Takeout 中选择“我的活动 → Gemini 应用”导出对话活动记录，再导入原始 ZIP。活动记录可能不包含完整对话内容。');
    const popover = overlay(null, title, description, false, [], 'bottom',
        '💡 ' + text('TAKEOUT', '历史记录'));
    onDismiss = dismissed;
    const bar = footer(popover);
    bar.classList.add('tour-takeout-footer');
    button(bar, text('Got it, don’t show again', '我知道了，不再提示'),
        close, 'tourTakeoutDismissBtn', 'tour-skip-btn');
    const nav = document.createElement('div');
    nav.className = 'tour-nav-btns';
    bar.append(nav);
    button(nav, text('Open Google Takeout', '前往 Google Takeout'), () => {
        close(); openTakeout();
    }, 'tourTakeoutGoWebBtn', 'tour-nav-btn');
    button(nav, text('Import Takeout ZIP', '导入 Takeout ZIP'), () => {
        close(); importFile();
    }, 'tourTakeoutImportBtn', 'tour-nav-btn primary');
    relayout?.();
    shown?.();
    return true;
}
export const TourGuide = { beginScan, beginExport, beginFormatSelection, beginLiveSave, showAccountConnection, showPlatformAuthorization, startTour, goToStep, nextStep, prevStep, finishTour, skipTour,
    startFeatureSpotlight, showPlatformHighlights, showV2UpgradeSpotlight, dismissFeatureSpotlight, showTakeoutPrompt, isActive, isLiveSaveStep, destroy };
