import { t, getLang } from '../../core/utils/i18n.js';

export function setSafeFormattedContent(el: Element, val: string): void {
    el.textContent = '';
    if (!val || typeof val !== 'string') return;
    const parts = val.split(/(<b>.*?<\/b>|<strong>.*?<\/strong>|<i>.*?<\/i>|<em>.*?<\/em>|<br\s*\/?>)/gi);
    for (const part of parts) {
        if (!part) continue;
        const lower = part.toLowerCase();
        if (lower.startsWith('<b>') && lower.endsWith('</b>')) {
            const b = document.createElement('b');
            b.textContent = part.slice(3, -4);
            el.appendChild(b);
        } else if (lower.startsWith('<strong>') && lower.endsWith('</strong>')) {
            const strong = document.createElement('strong');
            strong.textContent = part.slice(8, -9);
            el.appendChild(strong);
        } else if (lower.startsWith('<i>') && lower.endsWith('</i>')) {
            const i = document.createElement('i');
            i.textContent = part.slice(3, -4);
            el.appendChild(i);
        } else if (lower.startsWith('<em>') && lower.endsWith('</em>')) {
            const em = document.createElement('em');
            em.textContent = part.slice(4, -5);
            el.appendChild(em);
        } else if (lower === '<br>' || lower === '<br/>' || lower === '<br />') {
            el.appendChild(document.createElement('br'));
        } else {
            el.appendChild(document.createTextNode(part));
        }
    }
}

export function applyI18n(container?: Element | Document): void {
    const root: any = container || document;

    const applyToElement = (el: any) => {
        if (!el || !el.getAttribute) return;
        const textKey = el.getAttribute('data-i18n');
        if (textKey) {
            const val = t(textKey);
            if (val) el.textContent = val;
        }
        const htmlKey = el.getAttribute('data-i18n-html');
        if (htmlKey) {
            const val = t(htmlKey);
            if (val) setSafeFormattedContent(el, val);
        }
        const titleKey = el.getAttribute('data-i18n-title');
        if (titleKey) {
            const val = t(titleKey);
            if (val) el.title = val;
        }
        const placeholderKey = el.getAttribute('data-i18n-placeholder');
        if (placeholderKey) {
            const val = t(placeholderKey);
            if (val) el.placeholder = val;
        }
    };

    if (root !== document && root.nodeType === 1) {
        applyToElement(root);
    }

    if (root && root.querySelectorAll) {
        root.querySelectorAll('[data-i18n], [data-i18n-html], [data-i18n-title], [data-i18n-placeholder]').forEach(applyToElement);
    }
}

export function applyLangToggleUI(opts: {
    toggle?: HTMLInputElement | null;
    labelZh?: HTMLElement | null;
    labelEn?: HTMLElement | null;
} = {}): void {
    const currentLang = getLang();
    const langToggle = opts.toggle || (document.getElementById('langToggle') as HTMLInputElement | null);
    if (langToggle) {
        langToggle.checked = (currentLang === 'en');
    }
    const labelZh = opts.labelZh || document.getElementById('labelLangZh');
    const labelEn = opts.labelEn || document.getElementById('labelLangEn');
    if (labelZh && labelZh.style) {
        labelZh.style.color = currentLang === 'zh' ? 'var(--text, #f1f3fc)' : 'var(--muted, #8a92b2)';
        labelZh.style.opacity = currentLang === 'zh' ? '1' : '0.6';
    }
    if (labelEn && labelEn.style) {
        labelEn.style.color = currentLang === 'en' ? 'var(--text, #f1f3fc)' : 'var(--muted, #8a92b2)';
        labelEn.style.opacity = currentLang === 'en' ? '1' : '0.6';
    }
}
