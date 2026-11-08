/** Passive persistence only. Business decisions and browser IPC belong to callers. */
export { getAccount, listAccounts, insertAccountIfAbsent, admitAccountAtomically, putAccount } from './accountRegistryStore.js';
export { getIndex, listIndexes, putIndexes, getDetail, updateIndexesAtomically, updateConversationAtomically, deleteStoredConversation } from './conversationStore.js';
export { getCoverage, updateCoverageAtomically, clearStoredAccountScanRecords, clearStoredAccountCoverage } from './scanCoverageStore.js';
export { getExportRecord, listExportRecords, putExportRecord, clearStoredAccountExportRecords } from './exportRecordStore.js';
export { getStoredSettings, patchStoredSettings } from './settingsStore.js';
export { getDirectoryHandle, setDirectoryHandle } from './idbHandleStore.js';
export { getSourceCooldown, extendSourceCooldown } from './sourceCooldownStore.js';
