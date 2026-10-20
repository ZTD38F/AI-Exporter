export interface UserProfileInfo {
    email?: string;
    name?: string;
    gaiaId?: string;
    accountId?: string;
}

const EMAIL_REGEX = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/;

export function extractEmailFromText(text?: string | null): string | null {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(EMAIL_REGEX);
    return m ? m[0].toLowerCase() : null;
}

export function extractNameFromLabel(label: string, email: string): string {
    if (!label) return '';
    // Strip common localized prefixes like "Google Account:", "Google 帐号：", "Google 帳號："
    const clean = label.replace(/^(?:Google\s*Account|Google\s*帐号|Google\s*帳號|Google-Konto|Compte Google|Cuenta de Google)[:：\s]*/i, '').trim();
    const lines = clean.split('\n');
    if (lines.length > 1 && lines[0].trim()) {
        const candidate = lines[0].trim();
        if (!candidate.includes('@')) return candidate;
    }
    const parenMatch = clean.match(/^([^(]+)\s*\(/);
    if (parenMatch && parenMatch[1].trim()) {
        const candidate = parenMatch[1].trim();
        if (!candidate.includes('@')) return candidate;
    }
    const atIdx = clean.indexOf(email);
    if (atIdx > 0) {
        const candidate = clean.slice(0, atIdx).trim().replace(/[-(（:：\s]+$/, '');
        if (candidate) return candidate;
    }
    return '';
}

export function sniffUserProfileFromDom(doc?: Document): UserProfileInfo | null {
    const documentObj = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentObj) return null;

    let email: string | undefined;
    let name: string | undefined;
    let gaiaId: string | undefined;

    const selector = 'a[aria-label], button[aria-label], a[href*="accounts.google.com"], [data-email], [data-identifier], img[alt]';
    try {
        const elements = documentObj.querySelectorAll(selector);
        for (const el of elements) {
            const dataEmail = el.getAttribute('data-email') || el.getAttribute('data-identifier');
            if (dataEmail) {
                const e = extractEmailFromText(dataEmail);
                if (e) {
                    email = e;
                    break;
                }
            }
            const label = el.getAttribute('aria-label') || el.getAttribute('alt') || '';
            const foundEmail = extractEmailFromText(label);
            if (foundEmail) {
                email = foundEmail;
                const parsedName = extractNameFromLabel(label, foundEmail);
                if (parsedName) name = parsedName;
                break;
            }
        }
    } catch {
        /* ignore DOM query errors */
    }

    // Gaia ID from Google Wiz global data (oTI7oc) if accessible
    try {
        const win = (documentObj.defaultView || (typeof window !== 'undefined' ? window : null)) as any;
        const wiz = win?._WIZ_global_data || win?.WIZ_global_data || win?.__WIZ_global_data;
        if (wiz && typeof wiz === 'object') {
            const oTI7oc = wiz['oTI7oc'];
            if (oTI7oc && typeof oTI7oc === 'string') {
                gaiaId = oTI7oc;
            }
        }
    } catch {
        /* ignore */
    }

    if (!email && !gaiaId) {
        return null;
    }

    const accountId = email || gaiaId || undefined;

    return {
        email,
        name: name || (email ? email.split('@')[0] : undefined),
        gaiaId,
        accountId
    };
}
