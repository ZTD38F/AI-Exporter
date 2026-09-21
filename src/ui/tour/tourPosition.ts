// src/ui/tour/tourPosition.ts - Pure positioning for tour popover/spotlight (E.2)
export function positionElements(spotlightEl: HTMLElement | null, popoverEl: HTMLElement | null, step: any): void {
    if (!spotlightEl || !popoverEl || typeof window === 'undefined') return;

    const target = step.getTarget ? step.getTarget() : null;
    if (target && target.isConnected && target.offsetParent !== null) {
        const rect = target.getBoundingClientRect();
        const pad = 6;

        spotlightEl.classList.remove('tour-spotlight-hidden');
        spotlightEl.style.top = Math.max(0, rect.top - pad) + 'px';
        spotlightEl.style.left = Math.max(0, rect.left - pad) + 'px';
        spotlightEl.style.width = (rect.width + pad * 2) + 'px';
        spotlightEl.style.height = (rect.height + pad * 2) + 'px';

        if (typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        const popoverWidth = (popoverEl as HTMLElement).offsetWidth || 360;
        const popoverHeight = (popoverEl as HTMLElement).offsetHeight || 240;
        const gap = 16;
        const placement = step.placement || 'bottom';

        let popTop = 0;
        let popLeft = 0;

        if (placement === 'right') {
            popLeft = rect.right + gap;
            popTop = Math.max(16, Math.min(rect.top - 10, window.innerHeight - popoverHeight - 16));
            if (popLeft + popoverWidth > window.innerWidth - 16) {
                popLeft = Math.max(16, Math.min(rect.left, window.innerWidth - popoverWidth - 16));
                if (rect.top > popoverHeight + gap + 16) {
                    popTop = rect.top - popoverHeight - gap;
                } else {
                    popTop = rect.bottom + gap;
                }
            }
        } else if (placement === 'left') {
            popLeft = rect.left - popoverWidth - gap;
            popTop = Math.max(16, Math.min(rect.top - 10, window.innerHeight - popoverHeight - 16));
            if (popLeft < 16) {
                popLeft = 16;
                popTop = Math.max(16, Math.min(rect.top, window.innerHeight - popoverHeight - 16));
            }
        } else if (placement === 'top') {
            popTop = rect.top - popoverHeight - gap;
            popLeft = Math.max(16, Math.min(rect.left, window.innerWidth - popoverWidth - 16));
            if (popTop < 16) {
                popTop = rect.bottom + gap;
            }
        } else {
            popTop = rect.bottom + gap;
            popLeft = Math.max(16, Math.min(rect.left, window.innerWidth - popoverWidth - 16));
            if (popTop + popoverHeight > window.innerHeight - 16) {
                popTop = Math.max(16, rect.top - popoverHeight - gap);
            }
        }

        const targetSafe = {
            left: rect.left - pad,
            top: rect.top - pad,
            right: rect.right + pad,
            bottom: rect.bottom + pad
        };

        const isOverlapping = !(
            (popLeft + popoverWidth) <= targetSafe.left ||
            popLeft >= targetSafe.right ||
            (popTop + popoverHeight) <= targetSafe.top ||
            popTop >= targetSafe.bottom
        );

        if (isOverlapping) {
            const spaceRight = window.innerWidth - targetSafe.right - 16;
            const spaceLeft = targetSafe.left - 16;
            const spaceTop = targetSafe.top - 16;
            const spaceBottom = window.innerHeight - targetSafe.bottom - 16;

            if (spaceRight >= popoverWidth) {
                popLeft = targetSafe.right + gap;
                popTop = Math.max(16, Math.min(targetSafe.top, window.innerHeight - popoverHeight - 16));
            } else if (spaceLeft >= popoverWidth) {
                popLeft = Math.max(16, targetSafe.left - popoverWidth - gap);
                popTop = Math.max(16, Math.min(targetSafe.top, window.innerHeight - popoverHeight - 16));
            } else if (spaceTop >= popoverHeight) {
                popTop = Math.max(16, targetSafe.top - popoverHeight - gap);
                popLeft = Math.max(16, Math.min(targetSafe.left, window.innerWidth - popoverWidth - 16));
            } else if (spaceBottom >= popoverHeight) {
                popTop = targetSafe.bottom + gap;
                popLeft = Math.max(16, Math.min(targetSafe.left, window.innerWidth - popoverWidth - 16));
            }
        }

        popoverEl.style.top = `${popTop}px`;
        popoverEl.style.left = `${popLeft}px`;
        popoverEl.style.transform = 'none';
    } else {
        spotlightEl.classList.add('tour-spotlight-hidden');
        popoverEl.style.top = '50%';
        popoverEl.style.left = '50%';
        popoverEl.style.transform = 'translate(-50%, -50%)';
    }
}
