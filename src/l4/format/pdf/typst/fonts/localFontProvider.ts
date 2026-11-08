// Resolves optional CJK, Latin, and monospace device fonts via window.queryLocalFonts().
// Bundled text and math fonts keep offline exports readable without this permission.
import type { Diagnostic } from '../../../../../shared/diagnostics/diagnostic.js';

interface LocalFontEntry {
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

export interface LocalFontResolution {
    readonly fonts: readonly ResolvedLocalFont[];
    readonly diagnostics: readonly Diagnostic[];
    readonly fallbackChain: readonly string[];
    readonly localFontsAvailable: boolean;
}

interface LocalFontRequest {
    cjk?: readonly string[];
    latin?: readonly string[];
    mono?: readonly string[];
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

const LATIN_FONT_STACK: readonly string[] = [
    'SF Pro Text',
    'SF Pro Display',
    'Helvetica Neue',
    'Helvetica',
    'Arial',
    'Inter',
    'Noto Sans',
    'DejaVu Sans',
];

/** Matches font-mono in the PDF Typst template; the browser only mounts selected files. */
export const MONO_FONT_STACK: readonly string[] = [
    // Menlo's decomposed marks duplicate ActualText in the vendored Typst PDF writer.
    // Courier New preserves selectable grapheme clusters as well as fixed cell widths.
    'Courier New',
    'DejaVu Sans Mono',
    'SF Mono',
    'Menlo',
    'Monaco',
    'JetBrains Mono',
];

interface LocalFontCandidate {
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
    if (!bold && !italic) {
        return s === 'regular' || s === 'book' || s === 'roman' || s === 'normal' ? 0 : 0.5;
    }
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
        const want = normalizeFontName(family);
        const matched: Array<{ entry: LocalFontEntry; index: number }> = [];
        entries.forEach((entry, index) => {
            if (!used.has(index) && entryMatchesRequest(entry, family)) {
                matched.push({ entry, index });
            }
        });
        matched.sort(
            (a, b) =>
                (Number(normalizeFontName(b.entry.family) === want) - Number(normalizeFontName(a.entry.family) === want)) ||
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

type LocalFontQueryReason = 'api-unavailable' | 'permission-denied' | 'query-failed';

type LocalFontQueryResult =
    | { ok: true; fonts: LocalFontEntry[] }
    | { ok: false; reason: LocalFontQueryReason; detail: string };

type QueryLocalFontsFn = () => Promise<LocalFontEntry[]>;

/** Browser APIs missing from the bundled DOM declarations, scoped to this adapter. */
declare global {
    interface Window { queryLocalFonts?: QueryLocalFontsFn }
    interface Permissions { query(permissionDesc: PermissionDescriptor | { name: 'local-fonts' }): Promise<PermissionStatus> }
    var queryLocalFonts: QueryLocalFontsFn | undefined;
    var __geminiLocalFontsCache: LocalFontEntry[] | undefined;
}

function getQueryLocalFontsFn(): QueryLocalFontsFn | undefined {
    return globalThis.queryLocalFonts;
}

function classifyQueryError(err: unknown): { reason: LocalFontQueryReason; detail: string } {
    const name = err !== null && typeof err === 'object' && 'name' in err && typeof err.name === 'string' ? err.name : '';
    const message = err instanceof Error ? err.message : String(err);
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return { reason: 'permission-denied', detail: `Local Font Access denied/blocked (${name}): ${message}` };
    }
    return { reason: 'query-failed', detail: `queryLocalFonts() failed (${name || 'unknown'}): ${message}` };
}

let localFontsCache: LocalFontEntry[] | null = null;
const CACHE_KEY = '__geminiLocalFontsCache';
const fontCacheHost = globalThis;

export function getCachedLocalFonts(): LocalFontEntry[] | null {
    if (localFontsCache && localFontsCache.length > 0) return localFontsCache;
    const globalCache = fontCacheHost[CACHE_KEY];
    if (Array.isArray(globalCache) && globalCache.length > 0) {
        localFontsCache = globalCache;
        return globalCache;
    }
    return null;
}

export function clearLocalFontCache(): void {
    localFontsCache = null;
    try {
        delete fontCacheHost[CACHE_KEY];
    } catch {
        try {
            fontCacheHost[CACHE_KEY] = undefined;
        } catch {}
    }
}

function setCachedLocalFonts(fonts: LocalFontEntry[]): void {
    localFontsCache = fonts;
    try {
        fontCacheHost[CACHE_KEY] = fonts;
    } catch {
        // Ignore cross-context write restriction
    }
}

/**
 * Warm the local font cache within a user gesture (e.g. click in Options UI),
 * so subsequent export pipeline operations can reuse the cached fonts.
 */
/** Export must not wait on an optional permission prompt. Bundled fonts are
 * sufficient; use device fonts only when access has already been granted. */
async function localFontsGranted(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return true;
    try {
        // Chromium supports this permission; the bundled DOM PermissionName union does not yet.
        const permission = await navigator.permissions.query({ name: 'local-fonts' });
        return permission.state === 'granted';
    } catch { return false; }
}

export async function warmLocalFontCache(): Promise<void> {
    if (getCachedLocalFonts() || !await localFontsGranted()) return;
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
        if (!await localFontsGranted()) return { ok: false, reason: 'permission-denied', detail: 'Optional local font permission is not granted; using bundled fonts.' };
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
export const BUNDLED_TEXT_FALLBACK = 'Noto Sans CJK SC / Noto Sans Mono (bundled, text)';
export const SYSTEM_FALLBACK = 'Typst system default (last resort)';

function toResolved(entry: LocalFontEntry): ResolvedLocalFont {
    const { family, postscriptName, style } = entry;
    return {
        family,
        postscriptName,
        style,
        source: 'local',
        async getBytes(): Promise<Uint8Array> {
            const buf = await (await entry.blob()).arrayBuffer();
            return new Uint8Array(buf);
        },
    };
}

export async function resolveLocalFonts(request: LocalFontRequest = {}): Promise<LocalFontResolution> {
    const cjk = request.cjk ?? CJK_FONT_STACK;
    const latin = request.latin ?? LATIN_FONT_STACK;
    const mono = request.mono ?? MONO_FONT_STACK;
    const limit = request.limit ?? 8;

    const query = await queryLocalFontsProvider();
    if (!query.ok) {
        const code =
            query.reason === 'api-unavailable'
                ? 'TYPST_LOCAL_FONTS_UNAVAILABLE'
                : query.reason === 'permission-denied'
                  ? 'TYPST_LOCAL_FONTS_DENIED'
                  : 'TYPST_LOCAL_FONTS_QUERY_FAILED';
        return {
            fonts: [],
            diagnostics: [
                {
                    severity: 'warning',
                    code,
                    message:
                        `${query.detail} No local fonts will be mounted; the sandbox must compile ` +
                        `with bundled fonts (${BUNDLED_MATH_FALLBACK}; ${BUNDLED_TEXT_FALLBACK}). ` +
                        `Local font access is optional; text remains available offline.`,
                },
            ],
            fallbackChain: [BUNDLED_MATH_FALLBACK, BUNDLED_TEXT_FALLBACK, SYSTEM_FALLBACK],
            localFontsAvailable: false,
        };
    }

    const diagnostics: Diagnostic[] = [];
    const fonts: ResolvedLocalFont[] = [];
    const monoFonts: ResolvedLocalFont[] = [];
    const claimedEntries = new Set<number>();

    const resolveStack = (stack: readonly string[], label: string, selected: ResolvedLocalFont[] = fonts): void => {
        const candidates = rankLocalFontCandidates(query.fonts, stack, claimedEntries);
        for (const family of stack) {
            const best = candidates.find(candidate => candidate.requestedFamily === family);
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
            selected.push(toResolved(best.entry));
        }
    };

    resolveStack(cjk, 'CJK');
    resolveStack(latin, 'Latin');
    resolveStack(mono, 'Mono', monoFonts);

    // At the default 8-font cap the CJK stack can fill the entire budget.
    // Keep one real monospace face if installed, rather than allowing code
    // blocks to silently use proportional body fonts. A caller explicitly
    // requesting limit=1 retains the original prose-first priority.
    const budget = Math.max(0, Math.floor(limit));
    const reserveMono = monoFonts.length > 0 && budget > 0 && (budget > 1 || fonts.length === 0);
    const limited = fonts.slice(0, budget - (reserveMono ? 1 : 0));
    if (reserveMono) limited.push(monoFonts[0]);
    if (limited.length < fonts.length + monoFonts.length) {
        diagnostics.push({
            severity: 'info',
            code: 'TYPST_LOCAL_FONTS_TRUNCATED',
            message: `Resolved ${fonts.length + monoFonts.length} local fonts but limit=${limit} keeps ${limited.length} in CJK/Latin order with a reserved Mono face when available.`,
        });
    }

    const chain = [
        ...limited.map((f) => `${f.family} (local, ${f.postscriptName})`),
        BUNDLED_MATH_FALLBACK,
        BUNDLED_TEXT_FALLBACK,
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
