import type { CanonicalConversationBundle } from './conversation.js';
import type { Diagnostic } from './diagnostics.js';

export interface RawEvidenceWriter {
    put(kind: string, data: unknown): Promise<string>;
}

export interface NormalizationContext {
    providerId: string;
    accountId: string;
    observedAt: string;
    rawEvidence?: RawEvidenceWriter;
}

export interface NormalizationResult {
    bundle: CanonicalConversationBundle;
    diagnostics: Diagnostic[];
}

export interface ProviderNormalizer<TRaw> {
    readonly providerId: string;
    normalize(raw: TRaw, context: NormalizationContext): Promise<NormalizationResult>;
}
