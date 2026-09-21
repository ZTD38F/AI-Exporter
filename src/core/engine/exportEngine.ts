// src/core/engine/exportEngine.ts - Re-export facade delegating to ExportOrchestrator
export type {
    ExportOptions,
    ExportCallbacks,
    ExportResult
} from "./export/exportOrchestrator.js";

import ExportOrchestratorModuleImpl, {
    ExportOrchestrator,
    AsyncQueue,
    ensureSubDir,
    sanitizeFileName,
    sanitizeZipPath,
    getExtensionVersion,
    type ExportOrchestratorModule
} from "./export/exportOrchestrator.js";

export type ExportEngineModule = ExportOrchestratorModule;

declare global {
    var ExportEngine: any;
}

export const ExportEngine = ExportOrchestrator;

export {
    ExportOrchestrator,
    AsyncQueue,
    ensureSubDir,
    sanitizeFileName,
    sanitizeZipPath,
    getExtensionVersion
};

export const ExportEngineModule: ExportEngineModule = {
    ExportOrchestrator,
    AsyncQueue,
    ensureSubDir,
    sanitizeFileName,
    sanitizeZipPath,
    getExtensionVersion
};

(ExportEngineModule as any).ExportEngine = ExportOrchestrator;
(ExportEngineModule as any).default = ExportOrchestrator;

(ExportEngine as any).ExportEngine = ExportOrchestrator;
(ExportEngine as any).AsyncQueue = AsyncQueue;
(ExportEngine as any).sanitizeFileName = sanitizeFileName;
(ExportEngine as any).sanitizeZipPath = sanitizeZipPath;
(ExportEngine as any).getExtensionVersion = getExtensionVersion;
(ExportEngine as any).default = ExportOrchestrator;

if (typeof globalThis !== 'undefined') {
    if (!(globalThis as any).ExportEngine) (globalThis as any).ExportEngine = ExportOrchestrator;
}
if (typeof module === 'object' && module.exports) {
    module.exports = ExportEngineModule;
}
export default ExportOrchestrator;
