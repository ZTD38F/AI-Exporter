import { ConversationsStore } from '../state/conversationsStore.js';
import { ListView } from '../views/listView.js';
import { DialogView } from '../views/dialogView.js';
import { LogView } from '../views/logView.js';
import { AccountView } from '../views/accountView.js';
import { ExportController } from '../controllers/exportController.js';
import { SyncController } from '../controllers/syncController.js';
import { TakeoutController } from '../controllers/takeoutController.js';
import { DirHandleController } from '../controllers/dirHandleController.js';
import { StorageService } from '../../core/storage/storageService.js';
import { FormatStore } from '../../core/storage/formatStore.js';
import { LiveStorageManager } from '../../core/storage/liveStorageManager.js';
import { GeminiUtils } from '../../core/utils/utils.js';
import { GeminiConstants } from '../../core/utils/constants.js';
import { __resolveModule } from '../../core/utils/moduleOverrides.js';
import { GeminiProtocol } from '../../core/protocol/protocol.js';
import { TabService } from '../../core/utils/tabService.js';
import { TakeoutEngine } from '../../core/engine/takeoutEngine.js';
import { TourGuide } from '../tour/tourGuide.js';
import { FsWriter } from '../../core/engine/writers/fsWriter.js';
import { ChatFormatter } from '../../core/engine/chatFormatter.js';
import { ProgressView } from '../views/progressView.js';
import { I18n } from '../../core/utils/i18n.js';
import { getI18n as commonGetI18n } from '../uiCommon.js';

export const getI18n = () => commonGetI18n() || I18n;
export const t = (key: string, ...args: any[]): string => {
    const i18n = getI18n();
    return i18n && typeof i18n.t === 'function' ? i18n.t(key, ...args) : key;
};
export const getLang = (): string => {
    const i18n = getI18n();
    return i18n && typeof i18n.getLang === 'function' ? i18n.getLang() : 'en';
};

export const getStore = () => __resolveModule('ConversationsStore', ConversationsStore);
export const getList = () => __resolveModule('ListView', ListView);
export const getDialogs = () => __resolveModule('DialogView', DialogView);
export const getProgressView = () => __resolveModule('ProgressView', ProgressView);
export const getLogView = () => __resolveModule('LogView', LogView);
export const getAccountView = () => __resolveModule('AccountView', AccountView);
export const getExportCtrl = () => __resolveModule('ExportController', ExportController);
export const getSyncCtrl = () => __resolveModule('SyncController', SyncController);
export const getTakeoutCtrl = () => __resolveModule('TakeoutController', TakeoutController);
export const getDirHandle = () => __resolveModule('DirHandleController', DirHandleController);
export const getStorage = () => __resolveModule('StorageService', StorageService);
export const getFormats = () => __resolveModule('FormatStore', FormatStore);
export const getLiveStorage = () => __resolveModule('LiveStorageManager', LiveStorageManager);
export const getUtils = () => __resolveModule('GeminiUtils', GeminiUtils);
export const getConstants = () => __resolveModule('GeminiConstants', GeminiConstants);
export const getProtocol = () => __resolveModule('GeminiProtocol', GeminiProtocol);
export const getTabService = () => __resolveModule('TabService', TabService);
export const getTakeoutEngine = () => __resolveModule('TakeoutEngine', TakeoutEngine);
export const getTour = () => __resolveModule('TourGuide', TourGuide);
export const getFsWriter = () => __resolveModule('FsWriter', FsWriter);
export const getChatFormatter = () => __resolveModule('ChatFormatter', ChatFormatter);

