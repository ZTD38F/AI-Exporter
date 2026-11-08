/** Legacy export destinations are transport context, never Domain facts or identity evidence. */
export interface LegacyResourceHint {
    archivePath?: string;
    fallbackName?: string;
    /** Unresolved legacy body location; retained only for compatibility resource diagnostics. */
    unresolvedReference?: string;
}
export type LegacyResourceHints = Readonly<Record<string, LegacyResourceHint>>;
