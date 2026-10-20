import type { JsonValue } from './json.js';
import type { SourceRef } from './provenance.js';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
    id: string;
    severity: DiagnosticSeverity;
    code: string;
    message: string;
    path?: string;
    sourceRef?: SourceRef;
    details?: JsonValue;
}
