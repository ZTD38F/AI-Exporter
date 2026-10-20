import type { TourGuideContract } from '../../types/ui.js';
import { __resolveModule } from '../../core/utils/moduleOverrides.js';
import StorageService from '../../core/storage/storageService.js';
import TabService from '../../core/utils/tabService.js';
import { t } from '../uiCommon.js';
import { STEPS } from './tourSteps.js';
import { positionElements as positionTourElements } from './tourPosition.js';
import { getExtensionVersion } from '../../core/utils/constants.js';
export { STEPS } from './tourSteps.js';

let currentStep = 0;
let isActive = false;
let spotlightMode = false;
let activeSpotlightVersion = '';
let activeSpotlightOptions: any = null;
let overlayEl: HTMLElement | null = null;
let spotlightEl: HTMLElement | null = null;
let popoverEl: HTMLElement | null = null;
let pollTimer: any = null;
let lastTabStatus: any = null;
let activeActionCleanup: (() => void) | null = null;

const getStorage = () => __resolveModule('StorageService', StorageService);
const getTabService = () => __resolveModule('TabService', TabService);

export function clearActionListeners(): void {
    if (typeof activeActionCleanup === 'function') {
        try {
            activeActionCleanup();
        } catch (e) {
            console.warn('[TourGuide] cleanup error:', e);
        }
        activeActionCleanup = null;
    }
}

export function bindStepAction(step: any): void {
    clearActionListeners();
    if (!step || typeof step.setupAction !== 'function') return;

    let triggered = false;
    const advance = () => {
        if (!isActive || triggered) return;
        triggered = true;
        clearActionListeners();
        if (step.isFinal) {
            void finishTour();
        } else {
            void nextStep();
        }
    };

    try {
        activeActionCleanup = step.setupAction(advance);
    } catch (e) {
        console.warn('[TourGuide] setupAction error:', e);
    }
}


function createElements(): void {
    if (typeof document === 'undefined') return;
    if (overlayEl && overlayEl.parentNode) return;

    if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('.tour-overlay-container').forEach(el => {
            try { el.parentNode && el.parentNode.removeChild(el); } catch {}
        });
    }

    overlayEl = document.createElement('div');
    overlayEl.className = 'tour-overlay-container';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');

    spotlightEl = document.createElement('div');
    spotlightEl.className = 'tour-spotlight';

    popoverEl = document.createElement('div');
    popoverEl.className = 'tour-popover';
    popoverEl.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
    });

    overlayEl.appendChild(spotlightEl);
    overlayEl.appendChild(popoverEl);

    overlayEl.addEventListener('click', (e: MouseEvent) => {
        if (popoverEl && popoverEl.contains(e.target as Node)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (spotlightMode) {
            void dismissFeatureSpotlight();
        } else {
            void finishTour();
        }
    });

    document.body.appendChild(overlayEl);

    document.removeEventListener('keydown', handleKeydown as any);
    window.removeEventListener('resize', handleResize);
    document.addEventListener('keydown', handleKeydown as any);
    window.addEventListener('resize', handleResize);
}

function removeElements(): void {
    stopPolling();
    clearActionListeners();
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('.tour-overlay-container').forEach(el => {
            try { el.parentNode && el.parentNode.removeChild(el); } catch {}
        });
    }
    overlayEl = null;
    spotlightEl = null;
    popoverEl = null;
    isActive = false;
    spotlightMode = false;
    activeSpotlightVersion = '';
    activeSpotlightOptions = null;

    if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', handleKeydown as any);
    }
    if (typeof window !== 'undefined') {
        window.removeEventListener('resize', handleResize);
    }
}

function handleKeydown(e: KeyboardEvent): void {
    if (!isActive) return;
    if (e.key === 'Escape') {
        if (spotlightMode) {
            void dismissFeatureSpotlight();
        } else {
            void skipTour();
        }
    } else if (!spotlightMode && e.key === 'ArrowRight' && currentStep < STEPS.length - 1) {
        void nextStep();
    } else if (!spotlightMode && e.key === 'ArrowLeft' && currentStep > 0) {
        void prevStep();
    }
}

function handleResize(): void {
    if (!isActive) return;
    positionElements(STEPS[currentStep]);
}

function positionElements(step: any): void {
    const targetStep = spotlightMode && step.spotlightTarget
        ? { ...step, getTarget: step.spotlightTarget }
        : step;
    return positionTourElements(spotlightEl, popoverEl, targetStep);
}

async function checkCurrentTabStatus(): Promise<{ status: string; error?: string }> {
    const tabService = getTabService();
    if (!tabService || !tabService.checkGeminiStatus) {
        return { status: 'CONNECTED' };
    }
    try {
        return await tabService.checkGeminiStatus();
    } catch (e: any) {
        return { status: 'ERROR', error: e.message };
    }
}

function startPollingTabStatus(): void {
    stopPolling();
    pollTimer = setInterval(async () => {
        if (!isActive || currentStep !== 0) {
            stopPolling();
            return;
        }
        const status = await checkCurrentTabStatus();
        if (!isActive || currentStep !== 0) {
            return;
        }
        const prevStatus = lastTabStatus;
        if (status.status !== lastTabStatus) {
            lastTabStatus = status.status;
            void updateStepContent(STEPS[0]);

            if ((prevStatus === 'NO_TAB' || prevStatus === 'NEED_REFRESH') && status.status === 'CONNECTED') {
                setTimeout(() => {
                    if (isActive && currentStep === 0) {
                        void nextStep();
                    }
                }, 800);
            }
        }
    }, 1500);
}

function stopPolling(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

async function updateStepContent(step: any): Promise<void> {
    if (!popoverEl) return;

    if (spotlightMode) {
        const badgeLabel = t('tourFeatureBadge') || 'NEW FEATURE';
        const rawTitle = t(step.spotlightTitleKey || step.titleKey);
        const titleHtml = rawTitle.replace(/^(步骤|Step)\s*\d+\/\d+:\s*/i, '');
        const bodyHtml = `<div class="tour-content">${t(step.spotlightDescKey || step.descKey)}</div>`;
        const hintKey = step.spotlightHintKey || step.hintKey;
        const hintHtml = hintKey ? `<div class="tour-action-hint">${t(hintKey)}</div>` : '';

        const actionBtnLabel = activeSpotlightOptions?.actionLabelKey
            ? t(activeSpotlightOptions.actionLabelKey)
            : t(step.spotlightActionLabelKey || 'tourBtnEnableNow');

        popoverEl.innerHTML = `
            <div class="tour-header">
                <span class="tour-step-badge tour-feature-badge">✨ ${badgeLabel} v${activeSpotlightVersion}</span>
                <button class="tour-close-btn" id="tourCloseBtn" title="${t('tourCloseTip') || 'Close (ESC)'}">✕</button>
            </div>
            <div class="tour-title">${titleHtml}</div>
            ${bodyHtml}
            ${hintHtml}
            <div class="tour-footer">
                <button class="tour-skip-btn" id="tourSpotlightDismissBtn">${t('tourBtnDismiss')}</button>
                <div class="tour-nav-btns">
                    <button class="tour-nav-btn primary" id="tourSpotlightActionBtn">
                        ${actionBtnLabel}
                    </button>
                </div>
            </div>
        `;

        document.getElementById('tourCloseBtn')?.addEventListener('click', () => dismissFeatureSpotlight());
        document.getElementById('tourSpotlightDismissBtn')?.addEventListener('click', () => dismissFeatureSpotlight());
        document.getElementById('tourSpotlightActionBtn')?.addEventListener('click', async () => {
            if (activeSpotlightOptions && typeof activeSpotlightOptions.onAction === 'function') {
                try {
                    await activeSpotlightOptions.onAction();
                } catch (e) {
                    console.warn('[TourGuide] spotlight onAction error:', e);
                }
            } else if (step.id === 'export') {
                await dismissFeatureSpotlight();
                const format = document.getElementById('format');
                format?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                format?.focus();
                return;
            } else if (step.id === 'live_save') {
                const diskToggle = document.getElementById('liveSaveDiskToggle') as HTMLInputElement | null;
                if (diskToggle && !diskToggle.checked) {
                    diskToggle.click();
                }
                const dirBox = document.getElementById('dirBox');
                if (dirBox) {
                    dirBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
            await dismissFeatureSpotlight();
        });

        positionElements(step);
        return;
    }

    const isFinal = !!step.isFinal;
    const stepNum = currentStep + 1;
    const totalSteps = STEPS.length;

    let titleHtml = t(step.titleKey);
    let bodyHtml = '';

    if (step.isDynamicConnect) {
        const status = await checkCurrentTabStatus();
        lastTabStatus = status.status;

        if (status.status === 'NO_TAB') {
            bodyHtml = `
                <div class="tour-content">${t('tourStep1NoTab')}</div>
                <div class="tour-action-box">
                    <div class="tour-status-indicator tour-status-warn warn">⚠️ ${t('tourStep1NoTabStatus') || t('notSynced')}</div>
                    <button id="tourBtnOpenGemini" class="tour-action-btn">
                        ${t('tourStep1BtnOpen')}
                    </button>
                </div>
            `;
        } else if (status.status === 'NEED_REFRESH') {
            bodyHtml = `
                <div class="tour-content">${t('tourStep1NeedRefresh')}</div>
                <div class="tour-action-box">
                    <div class="tour-status-indicator tour-status-warn warn">⚠️ ${t('tourStep1NeedRefreshStatus') || t('tourStep1NeedRefresh')}</div>
                    <button id="tourBtnReloadGemini" class="tour-action-btn secondary">
                        ${t('tourStep1BtnRefresh')}
                    </button>
                </div>
            `;
        } else if (status.status === 'CONNECTED') {
            bodyHtml = `
                <div class="tour-content">${t('tourStep1ConnectedDesc') || t('tourStep1Connected')}</div>
                <div class="tour-action-box">
                    <div class="tour-status-indicator tour-status-ok ok">✅ ${t('tourStep1Connected')}</div>
                </div>
            `;
        } else {
            bodyHtml = `
                <div class="tour-content">${t('tourStep1ErrorDesc') || status.error || t('tourStep1NeedRefresh')}</div>
                <div class="tour-action-box">
                    <div class="tour-status-indicator tour-status-warn warn">⚠️ ${t('tourStep1ErrorStatus') || 'Connection error'}</div>
                    <button id="tourBtnReloadGemini" class="tour-action-btn secondary">
                        ${t('tourStep1BtnRefresh')}
                    </button>
                </div>
            `;
        }
    } else {
        bodyHtml = `<div class="tour-content">${t(step.descKey)}</div>`;
    }

    let hintHtml = '';
    if (step.hintKey) {
        hintHtml = `<div class="tour-action-hint">${t(step.hintKey)}</div>`;
    }

    if (!popoverEl || !isActive) return;

    popoverEl.innerHTML = `
        <div class="tour-header">
            <span class="tour-step-badge">${stepNum} / ${totalSteps}</span>
            <button class="tour-close-btn" id="tourCloseBtn" title="${t('tourCloseTip') || 'Close (ESC)'}">✕</button>
        </div>
        <div class="tour-title">${titleHtml}</div>
        ${bodyHtml}
        ${hintHtml}
        <div class="tour-footer">
            <button class="tour-skip-btn" id="tourSkipBtn">${t('tourBtnSkip')}</button>
            <div class="tour-nav-btns">
                ${currentStep > 0 ? `<button class="tour-nav-btn" id="tourPrevBtn">${t('tourBtnPrev')}</button>` : ''}
                <button class="tour-nav-btn primary" id="tourNextBtn">
                    ${isFinal ? t('tourBtnDone') : t('tourBtnNext')}
                </button>
            </div>
        </div>
    `;

    document.getElementById('tourCloseBtn')?.addEventListener('click', skipTour);
    document.getElementById('tourSkipBtn')?.addEventListener('click', skipTour);
    document.getElementById('tourPrevBtn')?.addEventListener('click', prevStep);
    document.getElementById('tourNextBtn')?.addEventListener('click', () => {
        if (isFinal) {
            void finishTour();
        } else {
            void nextStep();
        }
    });

    document.getElementById('tourBtnOpenGemini')?.addEventListener('click', async () => {
        const tabService = getTabService();
        if (tabService && tabService.openGeminiPage) {
            await tabService.openGeminiPage();
        } else if (typeof window !== 'undefined') {
            window.open('https://gemini.google.com/app', '_blank');
        }
        startPollingTabStatus();
    });

    document.getElementById('tourBtnReloadGemini')?.addEventListener('click', async () => {
        const tabService = getTabService();
        if (tabService && tabService.reloadGeminiTab) {
            await tabService.reloadGeminiTab();
        }
        startPollingTabStatus();
    });

    positionElements(step);
}

export async function goToStep(stepIndex: number): Promise<void> {
    if (stepIndex < 0 || stepIndex >= STEPS.length) return;
    currentStep = stepIndex;

    createElements();
    isActive = true;

    const step = STEPS[currentStep];
    if (step.isDynamicConnect) {
        startPollingTabStatus();
    } else {
        stopPolling();
    }

    await updateStepContent(step);
    bindStepAction(step);
}

export async function nextStep(): Promise<void> {
    if (currentStep < STEPS.length - 1) {
        return await goToStep(currentStep + 1);
    } else {
        return await finishTour();
    }
}

export async function prevStep(): Promise<void> {
    if (currentStep > 0) {
        return await goToStep(currentStep - 1);
    }
}

export async function finishTour(): Promise<void> {
    const storage = getStorage();
    if (storage) {
        if (storage.setTourCompleted) {
            await storage.setTourCompleted(true);
        }
        if (storage.setLastSeenFeatureVersion) {
            const currentVer = getExtensionVersion();
            await storage.setLastSeenFeatureVersion(currentVer);
        }
    }
    spotlightMode = false;
    removeElements();
}

export const skipTour = finishTour;


export async function startFeatureSpotlight(
    stepId: string,
    version: string,
    options?: { onAction?: () => void | Promise<void>; actionLabelKey?: string }
): Promise<void> {
    spotlightMode = true;
    activeSpotlightVersion = version;
    activeSpotlightOptions = options || null;

    createElements();
    isActive = true;

    const stepIndex = STEPS.findIndex((s: any) => s.id === stepId);
    currentStep = stepIndex >= 0 ? stepIndex : 0;
    const step = STEPS[currentStep];

    stopPolling();
    clearActionListeners();
    await updateStepContent(step);
    if (step.id !== 'export') bindStepAction(step);
}

export async function dismissFeatureSpotlight(): Promise<void> {
    const storage = getStorage();
    if (storage && storage.setLastSeenFeatureVersion && activeSpotlightVersion) {
        await storage.setLastSeenFeatureVersion(activeSpotlightVersion);
    }
    spotlightMode = false;
    activeSpotlightVersion = '';
    activeSpotlightOptions = null;
    removeElements();
}

export async function startTour(stepIndex: number = 0): Promise<void> {
    spotlightMode = false;
    return await goToStep(stepIndex);
}

export const TourGuide: TourGuideContract = {
    startTour,
    startFeatureSpotlight,
    dismissFeatureSpotlight,
    goToStep,
    nextStep,
    prevStep,
    finishTour,
    skipTour,
    isActive: () => isActive,
    getCurrentStep: () => currentStep,
    destroy: removeElements,
    clearActionListeners,
    bindStepAction,
    STEPS
};



export default TourGuide;
