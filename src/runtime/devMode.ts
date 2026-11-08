declare global {
    var __gemExporterDevMode: boolean | undefined;
    var __gemExporterVerboseLog: boolean | undefined;
    var __gemExporterLogAll: boolean | undefined;
}

export function isDevMode(): boolean {
    if (globalThis.__gemExporterDevMode || globalThis.__gemExporterVerboseLog || globalThis.__gemExporterLogAll) return true;
    return false;
}

