export {};
const test = require('node:test');
const assert = require('node:assert');
const OptionsSettings = require('../src/ui/options/modules/optionsSettings.js');
const LiveStorageManager = require('../src/core/storage/liveStorageManager.js');
const DirHandleController = require('../src/ui/controllers/dirHandleController.js');

test('optionsSettings - initLiveSaveSettings with existing handle enables live save', async () => {
    let savedConfig: any = null;

    const mockElements: Record<string, any> = {
        liveSaveDiskToggle: { checked: false, dataset: {}, addEventListener: function(e: string, fn: Function) { this.onChange = fn; } },
        dirLabel: { textContent: '' },
        liveSaveStatusTag: { textContent: '' }
    };

    const origDoc = (global as any).document;
    (global as any).document = {
        getElementById: (id: string) => mockElements[id] || null
    };

    const origGetLiveConfig = LiveStorageManager.getLiveConfig;
    const origSetLiveConfig = LiveStorageManager.setLiveConfig;
    const origGetDirHandle = DirHandleController.getDirHandle;
    const origRestoreSavedDirHandle = DirHandleController.restoreSavedDirHandle;

    LiveStorageManager.getLiveConfig = async () => ({
        enabledDisk: false,
        format: 'markdown',
        includeAssets: true,
        dirName: 'MyVault',
        lastSavedAt: 1710000000000
    });

    LiveStorageManager.setLiveConfig = async (patch: any) => {
        savedConfig = patch;
        return { ...LiveStorageManager.DEFAULT_LIVE_CONFIG, ...patch };
    };

    DirHandleController.getDirHandle = () => ({
        name: 'MyVault'
    });
    DirHandleController.restoreSavedDirHandle = async () => ({
        name: 'MyVault'
    });

    try {
        await OptionsSettings.initLiveSaveSettings();

        // Check initial restored state
        assert.strictEqual(mockElements.liveSaveDiskToggle.checked, false);
        assert.ok(mockElements.dirLabel.textContent.includes('MyVault'));

        // Toggle Disk Save on
        mockElements.liveSaveDiskToggle.checked = true;
        await mockElements.liveSaveDiskToggle.onChange();
        assert.strictEqual(mockElements.liveSaveDiskToggle.checked, true);
        assert.strictEqual(savedConfig.enabledDisk, true);
        assert.strictEqual(savedConfig.dirName, 'MyVault');

        // Toggle Disk Save off
        mockElements.liveSaveDiskToggle.checked = false;
        await mockElements.liveSaveDiskToggle.onChange();
        assert.strictEqual(savedConfig.enabledDisk, false);
    } finally {
        (global as any).document = origDoc;
        LiveStorageManager.getLiveConfig = origGetLiveConfig;
        LiveStorageManager.setLiveConfig = origSetLiveConfig;
        DirHandleController.getDirHandle = origGetDirHandle;
        DirHandleController.restoreSavedDirHandle = origRestoreSavedDirHandle;
    }
});

test('optionsSettings - toggling live save without handle triggers requestDirHandle and updates dir', async () => {
    let savedConfig: any = null;
    let requestDirCalled = false;

    const mockElements: Record<string, any> = {
        liveSaveDiskToggle: { checked: false, dataset: {}, addEventListener: function(e: string, fn: Function) { this.onChange = fn; } },
        dirLabel: { textContent: '' },
        liveSaveStatusTag: { textContent: '' }
    };

    const origDoc = (global as any).document;
    (global as any).document = {
        getElementById: (id: string) => mockElements[id] || null
    };

    const origGetLiveConfig = LiveStorageManager.getLiveConfig;
    const origSetLiveConfig = LiveStorageManager.setLiveConfig;
    const origGetDirHandle = DirHandleController.getDirHandle;
    const origRestoreSavedDirHandle = DirHandleController.restoreSavedDirHandle;
    const origGetStoredDirHandle = DirHandleController.getStoredDirHandle;
    const origRequestDirHandle = DirHandleController.requestDirHandle;

    LiveStorageManager.getLiveConfig = async () => ({
        enabledDisk: false,
        format: 'markdown',
        includeAssets: true
    });

    LiveStorageManager.setLiveConfig = async (patch: any) => {
        savedConfig = patch;
        return { ...LiveStorageManager.DEFAULT_LIVE_CONFIG, ...patch };
    };

    DirHandleController.getDirHandle = () => null;
    DirHandleController.restoreSavedDirHandle = async () => null;
    DirHandleController.getStoredDirHandle = async () => null;
    DirHandleController.requestDirHandle = async () => {
        requestDirCalled = true;
        return { name: 'ChosenDirectory' };
    };

    try {
        await OptionsSettings.initLiveSaveSettings();

        assert.strictEqual(mockElements.liveSaveDiskToggle.checked, false);

        // Turn on toggle without prior directory -> should prompt requestDirHandle
        mockElements.liveSaveDiskToggle.checked = true;
        await mockElements.liveSaveDiskToggle.onChange();

        assert.strictEqual(requestDirCalled, true);
        assert.strictEqual(mockElements.liveSaveDiskToggle.checked, true);
        assert.ok(mockElements.dirLabel.textContent.includes('ChosenDirectory'));
        assert.strictEqual(savedConfig.enabledDisk, true);
        assert.strictEqual(savedConfig.dirName, 'ChosenDirectory');
    } finally {
        (global as any).document = origDoc;
        LiveStorageManager.getLiveConfig = origGetLiveConfig;
        LiveStorageManager.setLiveConfig = origSetLiveConfig;
        DirHandleController.getDirHandle = origGetDirHandle;
        DirHandleController.restoreSavedDirHandle = origRestoreSavedDirHandle;
        DirHandleController.getStoredDirHandle = origGetStoredDirHandle;
        DirHandleController.requestDirHandle = origRequestDirHandle;
    }
});

test('optionsSettings - cancelling dir picker rolls back liveSaveDiskToggle to false', async () => {
    let savedConfig: any = null;

    const mockElements: Record<string, any> = {
        liveSaveDiskToggle: { checked: false, dataset: {}, addEventListener: function(e: string, fn: Function) { this.onChange = fn; } },
        dirLabel: { textContent: '' },
        liveSaveStatusTag: { textContent: '' }
    };

    const origDoc = (global as any).document;
    (global as any).document = {
        getElementById: (id: string) => mockElements[id] || null
    };

    const origGetLiveConfig = LiveStorageManager.getLiveConfig;
    const origSetLiveConfig = LiveStorageManager.setLiveConfig;
    const origGetDirHandle = DirHandleController.getDirHandle;
    const origRestoreSavedDirHandle = DirHandleController.restoreSavedDirHandle;
    const origGetStoredDirHandle = DirHandleController.getStoredDirHandle;
    const origRequestDirHandle = DirHandleController.requestDirHandle;

    LiveStorageManager.getLiveConfig = async () => ({
        enabledDisk: false,
        format: 'markdown',
        includeAssets: true
    });

    LiveStorageManager.setLiveConfig = async (patch: any) => {
        savedConfig = patch;
        return { ...LiveStorageManager.DEFAULT_LIVE_CONFIG, ...patch };
    };

    DirHandleController.getDirHandle = () => null;
    DirHandleController.restoreSavedDirHandle = async () => null;
    DirHandleController.getStoredDirHandle = async () => null;
    DirHandleController.requestDirHandle = async () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
    };

    try {
        await OptionsSettings.initLiveSaveSettings();

        // User toggles on, but cancels directory picker
        mockElements.liveSaveDiskToggle.checked = true;
        await mockElements.liveSaveDiskToggle.onChange();

        // Toggle must roll back to false, and enabledDisk must not be true
        assert.strictEqual(mockElements.liveSaveDiskToggle.checked, false);
        assert.strictEqual(savedConfig, null);
    } finally {
        (global as any).document = origDoc;
        LiveStorageManager.getLiveConfig = origGetLiveConfig;
        LiveStorageManager.setLiveConfig = origSetLiveConfig;
        DirHandleController.getDirHandle = origGetDirHandle;
        DirHandleController.restoreSavedDirHandle = origRestoreSavedDirHandle;
        DirHandleController.getStoredDirHandle = origGetStoredDirHandle;
        DirHandleController.requestDirHandle = origRequestDirHandle;
    }
});

test('optionsSettings - initLiveSaveSettings with dirError not_found marks toggle false and warns in dirLabel', async () => {
    const mockElements: Record<string, any> = {
        liveSaveDiskToggle: { checked: true, dataset: {}, addEventListener: function() {} },
        dirLabel: { textContent: '', style: {} },
        liveSaveStatusTag: { textContent: '' }
    };

    const origDoc = (global as any).document;
    (global as any).document = {
        getElementById: (id: string) => mockElements[id] || null
    };

    const origGetLiveConfig = LiveStorageManager.getLiveConfig;
    const origGetDirHandle = DirHandleController.getDirHandle;
    const origRestoreSavedDirHandle = DirHandleController.restoreSavedDirHandle;

    LiveStorageManager.getLiveConfig = async () => ({
        enabledDisk: false,
        format: 'markdown',
        includeAssets: true,
        dirName: 'DeletedVault',
        dirError: 'not_found'
    });

    DirHandleController.getDirHandle = () => null;
    DirHandleController.restoreSavedDirHandle = async () => null;

    try {
        await OptionsSettings.initLiveSaveSettings();

        // Check that toggle is disabled and label warns the user
        assert.strictEqual(mockElements.liveSaveDiskToggle.checked, false);
        assert.ok(mockElements.dirLabel.textContent.includes('删除') || mockElements.dirLabel.textContent.includes('re-select'));
        assert.strictEqual(mockElements.dirLabel.style.color, '#f59e0b');
    } finally {
        (global as any).document = origDoc;
        LiveStorageManager.getLiveConfig = origGetLiveConfig;
        DirHandleController.getDirHandle = origGetDirHandle;
        DirHandleController.restoreSavedDirHandle = origRestoreSavedDirHandle;
    }
});

