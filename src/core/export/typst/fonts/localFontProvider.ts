// Resolves CJK and Latin fonts from the OS via window.queryLocalFonts() to avoid
// bundling multi-megabyte CJK font files in the extension package.

export interface LocalFontEntry {
    readonly family: string;
    readonly fullName: string;
    readonly postscriptName: string;
    readonly style: string;
    blob(): Promise<Blob>;
}

export interface ResolvedLocalFont {
    readonly family: string;
    readonly postscriptName: string;
    readonly style: string;
    readonly source: 'local';
    getBytes(): Promise<Uint8Array>;
}

export interface FontProviderDiagnostic {
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
}

export interface LocalFontResolution {
    readonly fonts: readonly ResolvedLocalFont[];
    readonly diagnostics: readonly FontProviderDiagnostic[];
    readonly fallbackChain: readonly string[];
    readonly localFontsAvailable: boolean;
}

export interface LocalFontRequest {
    cjk?: readonly string[];
    latin?: readonly string[];
    limit?: number;
}

export const CJK_FONT_STACK: readonly string[] = [
    'Noto Sans CJK SC',
    'Noto Sans CJK',
    'PingFang SC',
    'PingFang TC',
    'PingFang HK',
    'Microsoft YaHei',
    'Microsoft JhengHei',
    'Source Han Sans SC',
    'Noto Sans SC',
    'SimSun',
    'SimHei',
    'Meiryo',
    'Hiragino Sans GB',
];

export const LATIN_FONT_STACK: readonly string[] = [
    'SF Pro Text',
    'SF Pro Display',
    'Helvetica Neue',
    'Helvetica',
    'Arial',
    'Inter',
    'Noto Sans',
    'DejaVu Sans',
];

export interface LocalFontCandidate {
    readonly family: string;
    readonly postscriptName: string;
    readonly style: string;
    readonly requestedIndex: number;
    readonly requestedFamily: string;
    readonly entry: LocalFontEntry;
}

function normalizeFontName(name: string): string {
    return name.toLowerCase().replace(/[\s\-_]/g, '');
}

function styleRank(style: string): number {
    const s = style.toLowerCase();
    const bold = s.includes('bold') || s.includes('black') || s.includes('heavy');
    const italic = s.includes('italic') || s.includes('oblique');
    if (!bold && !italic) return 0;
    if (!bold && italic) return 1;
    if (bold && !italic) return 2;
    if (bold && italic) return 3;
    return 4;
}

function entryMatchesRequest(entry: LocalFontEntry, requested: string): boolean {
    const want = normalizeFontName(requested);
    if (normalizeFontName(entry.family) === want) return true;
    // Match the PostScript family stem rather than a prefix so "Noto Sans" does not claim "NotoSansCJKsc-Regular".
    return postscriptFamilyStem(normalizeFontName(entry.postscriptName)) === want;
}

// Style tokens stripped when a PostScript name has no '-' separator (e.g. "ArialBold" -> "arial").
const PS_STYLE_SUFFIXES: readonly string[] = [
    'bolditalic', 'extrabold', 'semibold', 'demibold', 'extralight',
    'bold', 'italic', 'oblique', 'regular', 'light', 'medium',
    'black', 'heavy', 'thin', 'book', 'roman', 'mt',
];

function postscriptFamilyStem(ps: string): string {
    const dash = ps.lastIndexOf('-');
    if (dash > 0) return ps.slice(0, dash);
    for (const suffix of PS_STYLE_SUFFIXES) {
        if (ps.length > suffix.length && ps.endsWith(suffix)) {
            return ps.slice(0, ps.length - suffix.length);
        }
    }
    return ps;
}

/**
 * @param claimed Shared index set mutated in place so a font file claimed by an
 *   earlier stack (e.g. CJK) is not returned again for Latin.
 */
export function rankLocalFontCandidates(
    entries: readonly LocalFontEntry[],
    requested: readonly string[],
    claimed?: Set<number>,
): LocalFontCandidate[] {
    const used = claimed ?? new Set<number>();
    const out: LocalFontCandidate[] = [];
    requested.forEach((family, requestedIndex) => {
        const matched: Array<{ entry: LocalFontEntry; index: number }> = [];
        entries.forEach((entry, index) => {
            if (!used.has(index) && entryMatchesRequest(entry, family)) {
                matched.push({ entry, index });
            }
        });
        matched.sort(
            (a, b) =>
                styleRank(a.entry.style) - styleRank(b.entry.style) ||
                (a.entry.postscriptName < b.entry.postscriptName ? -1 : a.entry.postscriptName > b.entry.postscriptName ? 1 : 0),
        );
        for (const { entry, index } of matched) {
            used.add(index);
            out.push({
                family: entry.family,
                postscriptName: entry.postscriptName,
                style: entry.style,
                requestedIndex,
                requestedFamily: family,
                entry,
            });
        }
    });
    return out;
}

export function bestCandidateForFamily(
    candidates: readonly LocalFontCandidate[],
    requestedFamily: string,
): LocalFontCandidate | undefined {
    return candidates.find((c) => c.requestedFamily === requestedFamily);
}

export type LocalFontQueryReason = 'api-unavailable' | 'permission-denied' | 'query-failed';

export type LocalFontQueryResult =
    | { ok: true; fonts: LocalFontEntry[] }
    | { ok: false; reason: LocalFontQueryReason; detail: string };

type QueryLocalFontsFn = () => Promise<LocalFontEntry[]>;

function getQueryLocalFontsFn(): QueryLocalFontsFn | undefined {
    const g = globalThis as unknown as {
        window?: { queryLocalFonts?: unknown };
        queryLocalFonts?: unknown;
    };
    const fn = g.window?.queryLocalFonts ?? g.queryLocalFonts;
    return typeof fn === 'function' ? (fn as QueryLocalFontsFn) : undefined;
}

function classifyQueryError(err: unknown): { reason: LocalFontQueryReason; detail: string } {
    const name = (err as { name?: string } | null)?.name ?? '';
    const message = err instanceof Error ? err.message : String(err);
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return { reason: 'permission-denied', detail: `Local Font Access denied/blocked (${name}): ${message}` };
    }
    return { reason: 'query-failed', detail: `queryLocalFonts() failed (${name || 'unknown'}): ${message}` };
}

let localFontsCache: LocalFontEntry[] | null = null;
const CACHE_KEY = '__geminiLocalFontsCache';

export function getCachedLocalFonts(): LocalFontEntry[] | null {
    if (localFontsCache && localFontsCache.length > 0) return localFontsCache;
    const globalCache = (globalThis as any)?.[CACHE_KEY];
    if (Array.isArray(globalCache) && globalCache.length > 0) {
        localFontsCache = globalCache;
        return globalCache;
    }
    return null;
}

export function clearLocalFontCache(): void {
    localFontsCache = null;
    try {
        delete (globalThis as any)?.[CACHE_KEY];
    } catch {
        try {
            (globalThis as any)[CACHE_KEY] = undefined;
        } catch {}
    }
}

function setCachedLocalFonts(fonts: LocalFontEntry[]): void {
    localFontsCache = fonts;
    try {
        (globalThis as any)[CACHE_KEY] = fonts;
    } catch {
        // Ignore cross-context write restriction
    }
}

/**
 * Warm the local font cache within a user gesture (e.g. click in Options UI),
 * so subsequent export pipeline operations can reuse the cached fonts.
 */
export async function warmLocalFontCache(): Promise<void> {
    if (getCachedLocalFonts()) return;
    const fn = getQueryLocalFontsFn();
    if (!fn) return;
    try {
        const fonts = await fn();
        const arr = Array.isArray(fonts) ? fonts : [];
        if (arr.length > 0) {
            setCachedLocalFonts(arr);
        }
    } catch {}
}

export async function queryLocalFontsProvider(): Promise<LocalFontQueryResult> {
    const cached = getCachedLocalFonts();
    if (cached && cached.length > 0) {
        return { ok: true, fonts: cached };
    }
    const fn = getQueryLocalFontsFn();
    if (!fn) {
        return {
            ok: false,
            reason: 'api-unavailable',
            detail: 'window.queryLocalFonts is not defined in this browser (Local Font Access API unsupported or insecure context).',
        };
    }
    try {
        const fonts = await fn();
        const arr = Array.isArray(fonts) ? fonts : [];
        if (arr.length > 0) {
            setCachedLocalFonts(arr);
        }
        return { ok: true, fonts: arr };
    } catch (err) {
        const { reason, detail } = classifyQueryError(err);
        return { ok: false, reason, detail };
    }
}

export const BUNDLED_MATH_FALLBACK = 'NewCMMath (bundled, math only)';
export const SYSTEM_FALLBACK = 'Typst system default (last resort)';

function toResolved(entry: LocalFontEntry): ResolvedLocalFont {
    const { family, postscriptName, style } = entry;
    return {
        family,
        postscriptName,
        style,
        source: 'local' as const,
        async getBytes(): Promise<Uint8Array> {
            const buf = await (await entry.blob()).arrayBuffer();
            return new Uint8Array(buf);
        },
    };
}

export async function resolveLocalFonts(request: LocalFontRequest = {}): Promise<LocalFontResolution> {
    const cjk = request.cjk ?? CJK_FONT_STACK;
    const latin = request.latin ?? LATIN_FONT_STACK;
    const limit = request.limit ?? 8;

    const query = await queryLocalFontsProvider();
    if (!query.ok) {
        const code =
            query.reason === 'api-unavailable'
                ? 'TYPST_LOCAL_FONTS_UNAVAILABLE'
                : query.reason === 'permission-denied'
                  ? 'TYPST_LOCAL_FONTS_DENIED'
                  : 'TYPST_LOCAL_FONTS_QUERY_FAILED';
        const severity = query.reason === 'permission-denied' ? 'warning' : 'error';
        return {
            fonts: [],
            diagnostics: [
                {
                    severity,
                    code,
                    message:
                        `${query.detail} No local fonts will be mounted; the sandbox must compile ` +
                        `with bundled fonts only (${BUNDLED_MATH_FALLBACK}). Pagination may differ from ` +
                        `a device with local CJK fonts -- this is a known, reported degradation, not a silent swap.`,
                },
            ],
            fallbackChain: [BUNDLED_MATH_FALLBACK, SYSTEM_FALLBACK],
            localFontsAvailable: false,
        };
    }

    const diagnostics: FontProviderDiagnostic[] = [];
    const fonts: ResolvedLocalFont[] = [];
    const claimedEntries = new Set<number>();

    const resolveStack = (stack: readonly string[], label: string): void => {
        const candidates = rankLocalFontCandidates(query.fonts, stack, claimedEntries);
        for (const family of stack) {
            const best = bestCandidateForFamily(candidates, family);
            if (!best) {
                const wouldMatch = rankLocalFontCandidates(query.fonts, [family]).length > 0;
                diagnostics.push(
                    wouldMatch
                        ? {
                              severity: 'info',
                              code: 'TYPST_LOCAL_FONTS_ALREADY_MOUNTED',
                              message: `Requested ${label} font "${family}" matches an installed font that is already mounted for the other script stack; it is not mounted twice.`,
                          }
                        : {
                              severity: 'warning',
                              code: 'TYPST_LOCAL_FONTS_MISSING',
                              message: `Requested ${label} font "${family}" not found among installed local fonts; it will not be mounted.`,
                          },
                );
                continue;
            }
            if (styleRank(best.style) !== 0) {
                diagnostics.push({
                    severity: 'warning',
                    code: 'TYPST_LOCAL_FONTS_STYLE_FALLBACK',
                    message: `Requested ${label} font "${family}" resolved to non-Regular style "${best.style}" (${best.postscriptName}); pagination is computed against this style, not a silent Regular.`,
                });
            }
            fonts.push(toResolved(best.entry));
        }
    };

    resolveStack(cjk, 'CJK');
    resolveStack(latin, 'Latin');

    const limited = fonts.slice(0, Math.max(0, limit));
    if (limited.length < fonts.length) {
        diagnostics.push({
            severity: 'info',
            code: 'TYPST_LOCAL_FONTS_TRUNCATED',
            message: `Resolved ${fonts.length} local fonts but limit=${limit} keeps the first ${limited.length} in priority order.`,
        });
    }

    const chain = [
        ...limited.map((f) => `${f.family} (local, ${f.postscriptName})`),
        BUNDLED_MATH_FALLBACK,
        SYSTEM_FALLBACK,
    ];

    diagnostics.unshift({
        severity: 'info',
        code: 'TYPST_LOCAL_FONTS_RESOLVED',
        message: `Resolved ${limited.length} local fonts. Effective fallback chain: ${chain.join(' -> ')}.`,
    });

    return {
        fonts: limited,
        diagnostics,
        fallbackChain: chain,
        localFontsAvailable: limited.length > 0,
    };
}
