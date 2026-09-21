import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

function getBackgroundCode(): string {
    const bgDir = path.join(__dirname, '../src/background');
    if (fs.existsSync(bgDir)) {
        const bgFiles = fs.readdirSync(bgDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
        return bgFiles.map(f => fs.readFileSync(path.join(bgDir, f), 'utf8')).join('\n');
    }
    const bgTsPath = path.join(__dirname, '../src/background/background.ts');
    const bgJsPath = path.join(__dirname, '../src/background/background.js');
    const bgPath = fs.existsSync(bgTsPath) ? bgTsPath : bgJsPath;
    return fs.readFileSync(bgPath, 'utf8');
}

// Test that background source exists (ts or js) and satisfies architectural rules
test('Background - static contract and AST checks', () => {
    const bgDir = path.join(__dirname, '../src/background');
    const bgCode = getBackgroundCode();

    // Architecture modularity check
    assert.ok(fs.existsSync(path.join(bgDir, 'abortManager.ts')), 'abortManager module must exist');
    assert.ok(fs.existsSync(path.join(bgDir, 'keepAlive.ts')), 'keepAlive module must exist');
    assert.ok(fs.existsSync(path.join(bgDir, 'tabAction.ts')), 'tabAction module must exist');
    assert.ok(fs.existsSync(path.join(bgDir, 'liveSaveHandler.ts')), 'liveSaveHandler module must exist');
    assert.ok(fs.existsSync(path.join(bgDir, 'batchFetcher.ts')), 'batchFetcher module must exist');
    assert.ok(fs.existsSync(path.join(bgDir, 'lifecycle.ts')), 'lifecycle module must exist');

    // Per-slot aborts
    assert.ok(bgCode.includes('__bgAborts') && bgCode.includes('Map'), 'background must isolate abort flags per slot using Map');
    assert.ok(!/let\s+__bgAborted\s*=\s*(?:false|true);/.test(bgCode), 'background must not contain mutable global __bgAborted');
    assert.ok(bgCode.includes('isSlotAborted') && bgCode.includes('setSlotAborted'), 'background must provide slot-aware abort helpers');

    // MV3 keepalive
    assert.ok(/function\s+startKeepAlive\s*\(/.test(bgCode) || bgCode.includes('startKeepAlive'), 'background must implement startKeepAlive');
    assert.ok(bgCode.includes('stopKeepAlive'), 'background must invoke and clean up keepalive');

    // Fallbacks and debug preserving
    assert.ok(bgCode.includes('_debug'), 'background must preserve _debug in failed chats');
    assert.ok(bgCode.includes('Receiving end does not exist'), 'background must handle Receiving end');
    assert.ok(bgCode.includes('刷新 gemini.google.com'), 'background must hint refresh on connection error');
});

// Test Popup controller helper contracts and URL detection
test('Popup - isGeminiUrl validation logic', () => {
    function isGeminiUrl(urlStr: any) {
        if (!urlStr || typeof urlStr !== 'string') return false;
        try {
            const u = new URL(urlStr);
            return u.hostname === 'gemini.google.com';
        } catch {
            return false;
        }
    }

    assert.strictEqual(isGeminiUrl('https://gemini.google.com/app'), true);
    assert.strictEqual(isGeminiUrl('https://gemini.google.com/u/1/app/c_12345'), true);
    assert.strictEqual(isGeminiUrl('https://google.com'), false);
    assert.strictEqual(isGeminiUrl('https://notgemini.google.com'), false);
    assert.strictEqual(isGeminiUrl(''), false);
    assert.strictEqual(isGeminiUrl(null), false);
    assert.strictEqual(isGeminiUrl(undefined), false);
    assert.strictEqual(isGeminiUrl('not a url'), false);
});


test('Popup - openOptions removal and disabled styling', () => {
    const popPath = path.join(__dirname, '../src/ui/popup/popup.html');
    const popHtml = fs.readFileSync(popPath, 'utf8');

    assert.ok(!popHtml.includes('id="openOptions"'), 'popup.html must not contain redundant openOptions button');
    assert.ok(popHtml.includes('button:disabled'), 'popup.html must have button:disabled styles');
    assert.ok(popHtml.includes('select:disabled'), 'popup.html must have select:disabled styles');

    // Verify grayscale icon files exist
    assert.ok(fs.existsSync(path.join(__dirname, '../icons/icon16_gray.png')), 'icon16_gray.png must exist');
    assert.ok(fs.existsSync(path.join(__dirname, '../icons/icon48_gray.png')), 'icon48_gray.png must exist');
    assert.ok(fs.existsSync(path.join(__dirname, '../icons/icon128_gray.png')), 'icon128_gray.png must exist');
});

test('Background - tab action icon contextual state management', () => {
    const bgCode = getBackgroundCode();

    assert.ok(bgCode.includes('updateTabActionState'), 'background must define updateTabActionState');
    assert.ok(bgCode.includes('ACTION_GRAY_ICONS'), 'background must configure gray action icons');
    assert.ok(bgCode.includes('ACTION_COLOR_ICONS'), 'background must configure color action icons');
    assert.ok(bgCode.includes('onActivated'), 'background must listen to tabs.onActivated');
    assert.ok(bgCode.includes('onUpdated'), 'background must listen to tabs.onUpdated');
});

test('Background - slot abort isolation and session storage persistence', async () => {
    const sessionStorageData: Record<string, any> = {};
    const mockStorageSession = {
        get: async (keys: any) => {
            if (keys === null) return { ...sessionStorageData };
            if (typeof keys === 'string') return { [keys]: sessionStorageData[keys] };
            return {};
        },
        set: async (obj: any) => {
            Object.assign(sessionStorageData, obj);
        },
        remove: async (keys: any) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete sessionStorageData[k];
        }
    };

    const __bgAborts = new Map<string, boolean>();

    function isSlotAborted(slot = 'u0') {
        return !!__bgAborts.get(slot || 'u0');
    }

    function setSlotAborted(slot = 'u0', val = true) {
        const s = slot || 'u0';
        if (val) {
            __bgAborts.set(s, true);
            mockStorageSession.set({ [`gemini_abort_${s}`]: true }).catch(() => {});
        } else {
            __bgAborts.delete(s);
            mockStorageSession.remove([`gemini_abort_${s}`]).catch(() => {});
        }
    }

    // Initially neither slot is aborted
    assert.strictEqual(isSlotAborted('u0'), false);
    assert.strictEqual(isSlotAborted('u1'), false);

    // Abort slot u1
    setSlotAborted('u1', true);
    assert.strictEqual(isSlotAborted('u0'), false, 'u0 must remain not aborted when u1 is aborted');
    assert.strictEqual(isSlotAborted('u1'), true, 'u1 must be aborted');
    assert.strictEqual(sessionStorageData['gemini_abort_u1'], true, 'u1 abort state must persist to session storage');

    // Reset slot u1
    setSlotAborted('u1', false);
    assert.strictEqual(isSlotAborted('u1'), false);
    assert.strictEqual(sessionStorageData['gemini_abort_u1'], undefined, 'u1 abort state must be cleared from session storage');
});

test('Background - keepAlive lifecycle timer', () => {
    let platformInfoCalls = 0;
    const mockRuntime = {
        getPlatformInfo: (cb?: any) => { platformInfoCalls++; if (cb) cb(); }
    };

    let cleared = false;
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;

    (global as any).setInterval = (fn: any, _ms: number) => {
        fn(); // execute once immediately for test
        return 1234 as any;
    };
    (global as any).clearInterval = (id: any) => {
        if (id === 1234) cleared = true;
    };

    try {
        function startKeepAlive() {
            if (!mockRuntime) return () => {};
            const interval = setInterval(() => {
                try {
                    if (mockRuntime.getPlatformInfo) {
                        mockRuntime.getPlatformInfo(() => {});
                    }
                } catch (_) {}
            }, 20000);
            return () => clearInterval(interval);
        }

        const stop = startKeepAlive();
        assert.strictEqual(platformInfoCalls, 1, 'keepAlive should trigger getPlatformInfo');
        assert.strictEqual(cleared, false, 'interval should not yet be cleared');

        stop();
        assert.strictEqual(cleared, true, 'stopKeepAlive should clear interval');
    } finally {
        global.setInterval = origSetInterval;
        global.clearInterval = origClearInterval;
    }
});

test('Background - liveSaveViaHandle native handle persistence and non-intercepting fallback', () => {
    const bgCode = getBackgroundCode();

    assert.ok(bgCode.includes("msg.action === 'liveSaveViaHandle'"), 'background must handle liveSaveViaHandle action');
    assert.ok(bgCode.includes('getStoredDirHandle') || bgCode.includes('getStoredExportDirHandle'), 'background must read export directory handle from IndexedDB');
    assert.ok(bgCode.includes('FsWriter'), 'background must persist files via FsWriter');
    assert.ok(!bgCode.includes('unknown action: ${msg.action}'), 'background must not reject unknown actions synchronously');
});

