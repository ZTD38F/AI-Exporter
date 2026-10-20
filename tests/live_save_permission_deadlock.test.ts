export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    handleLiveSaveViaHandle
} = require('../src/background/liveSaveHandler.js');
const idbStore = require('../src/core/storage/idbHandleStore.js');
const liveStorage = require('../src/core/storage/liveStorageManager.js');
const { StorageService } = require('../src/core/storage/storageService.js');
const DirHandleController = require('../src/ui/controllers/dirHandleController.js');

test('liveSavePermissionDeadlock - handleLiveSaveViaHandle returns permission_prompt_needed when handle queryPermission is prompt', async () => {
    let savedLiveConfig: any = null;
    const origSetLiveConfig = liveStorage.setLiveConfig;
    liveStorage.setLiveConfig = async (patch: any) => {
        savedLiveConfig = patch;
    };

    const origGetStored = idbStore.getStoredDirHandle;
    idbStore.getStoredDirHandle = async () => ({
        name: 'MyVault',
        queryPermission: async () => 'prompt' // degraded by browser restart
    });

    try {
        const payload = {
            chat: { title: 'Test Chat', messages: [{ role: 'user', content: 'Hi' }] },
            safeTitle: 'Test Chat',
            nid: 'chat_test_1'
        };

        const res = await handleLiveSaveViaHandle(payload);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error, 'permission_prompt_needed');
        assert.ok(savedLiveConfig);
        assert.strictEqual(savedLiveConfig.dirError, 'permission_prompt_needed');
    } finally {
        idbStore.getStoredDirHandle = origGetStored;
        liveStorage.setLiveConfig = origSetLiveConfig;
    }
});

test('liveSavePermissionDeadlock - dirHandleController preserves pending handle on prompt and enables reauthorization', async () => {
    let clearedHandle = false;
    let savedHandle: any = null;

    const origGetStored = idbStore.getStoredDirHandle;
    const origSaveStored = idbStore.saveStoredDirHandle;

    let permissionState = 'prompt';
    const mockDegradedHandle = {
        name: 'Vault_Obsidian',
        queryPermission: async () => permissionState,
        requestPermission: async () => {
            permissionState = 'granted';
            return 'granted';
        },
        keys: async function* () {
            yield 'file.txt';
        }
    };

    idbStore.getStoredDirHandle = async () => mockDegradedHandle;
    idbStore.saveStoredDirHandle = async (h: any) => {
        if (h === null) clearedHandle = true;
        savedHandle = h;
        return true;
    };

    try {
        // Step 1: restoreSavedDirHandle while permission is 'prompt'
        const restored = await DirHandleController.restoreSavedDirHandle();
        assert.strictEqual(restored, null, 'Cannot use handle directly when permission is prompt');
        assert.strictEqual(clearedHandle, false, 'Handle must NOT be wiped from IndexedDB when directory physically exists!');

        // Step 2: pendingPermissionHandle is retained
        const pending = DirHandleController.getPendingPermissionHandle();
        assert.ok(pending, 'Pending permission handle must be preserved');
        assert.strictEqual(pending.name, 'Vault_Obsidian');

        // Step 3: user triggers reauthorization via user click
        const reauthOk = await DirHandleController.reauthorizeDirHandle();
        assert.strictEqual(reauthOk, true, 'reauthorizeDirHandle must succeed when user grants permission');

        // Step 4: handle is now active and pending is cleared
        const active = DirHandleController.getDirHandle();
        assert.ok(active);
        assert.strictEqual(active.name, 'Vault_Obsidian');
        assert.strictEqual(DirHandleController.getPendingPermissionHandle(), null);
    } finally {
        idbStore.getStoredDirHandle = origGetStored;
        idbStore.saveStoredDirHandle = origSaveStored;
    }
});
