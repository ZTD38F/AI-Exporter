declare var define: any;
declare function importScripts(...urls: string[]): void;
declare const __EXT_VERSION__: string;

// Core globals are declared via their own module files (declare global) — do not duplicate here to avoid TS2403
declare var JSZip: any;

// UI workbench globals (mixed UMD / ESM transition, used via typeof checks)
declare var ConversationsStore: import('./ui.js').IConversationsStore;
declare var ListView: import('./ui.js').IListView;
declare var LogView: import('./ui.js').ILogView;
declare var DialogView: import('./ui.js').IDialogView;
declare var AccountView: import('./ui.js').IAccountView;
declare var ExportController: import('./ui.js').ExportControllerContract;
declare var SyncController: import('./ui.js').SyncControllerContract;
declare var TakeoutController: import('./ui.js').TakeoutControllerContract;
declare var DirHandleController: import('./ui.js').DirHandleControllerContract;
declare var TourGuide: import('./ui.js').TourGuideContract;
declare var BadgeView: any;
declare var PageObserver: any;
declare var MessageRouter: any;
declare var MessageBridge: any;
declare var SyncEngine: any;
declare var DomScraper: any;
declare var AssetFetcher: any;
declare var OptionsInit: any;
declare var OptionsExport: any;
declare var OptionsSync: any;
declare var OptionsTakeout: any;
declare var OptionsSettings: any;
declare var DefaultApiClient: any;
declare var GeminiAPIClient: any;
declare var DefaultTabService: any;
declare var TabService: import('./utils.js').TabServiceModule;
declare var I18n: any;

interface Window {
    __gemExporterAborted?: boolean;
    __gemExporterActiveClient?: any;
    __gemExporterContentContext?: any;
    __gemExporterDeepScanPromise?: any;
    __gemExporterInjected?: boolean;
    __gemExporterDevMode?: boolean;
    __gemExporterScrollAll?: any;
    __gemExporterExtractAt?: any;
    __gemExporterExtractBl?: any;
    __gemExporterEnsureCreds?: any;
    __gemExporterContentCoord?: any;
}


