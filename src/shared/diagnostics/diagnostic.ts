import type { JsonValue } from '../utils/jsonTypes.js';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export interface SourceRef {
    providerId: string;
    providerMessageId?: string;
    locator?: string;
    rawRef?: string;
}

/** Observations for logs and reports. Business outcomes must never be inferred from these records. */
export interface Diagnostic {
    severity: DiagnosticSeverity;
    code: string;
    message: string;
    path?: string;
    id?: string;
    sourceRef?: SourceRef;
    details?: JsonValue;
}

/** Diagnostic observers must never change acquisition or admission outcomes. */
export function emitDiagnostic(observer: ((diagnostic: Diagnostic) => void) | undefined, diagnostic: Diagnostic): void {
    try { observer?.(diagnostic); }
    catch (error) { console.warn('[Gemini Exporter] Diagnostic listener failed', error); }
}

/** Keep request routing evidence without signed paths, query parameters or credentials. */
export function diagnosticOrigin(uri: string): string | null {
    try { return new URL(uri).origin; }
    catch { return null; }
}

/** Describe a locator without retaining its path, query, fragment or credentials. */
export function diagnosticUrlShape(uri: string) {
    let scheme: string | null = null;
    try { scheme = new URL(uri).protocol; } catch { /* Relative or malformed locator. */ }
    return { kind: scheme ? 'absolute' : uri.startsWith('//') ? 'network_relative'
        : uri.startsWith('/') ? 'root_relative' : 'relative_or_invalid',
        scheme, length: uri.length, surroundingWhitespace: uri !== uri.trim() };
}
