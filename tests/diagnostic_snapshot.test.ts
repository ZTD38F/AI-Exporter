// tests/diagnostic_snapshot.test.ts - Unit tests for Full Sanitized State Mirror and Flight Recorder
export {};
const test = require('node:test');
const assert = require('node:assert');

const { FlightRecorder } = require('../src/core/diagnostics/flightRecorder.js');
const {
    maskTitle,
    explainStateDerivation,
    buildDiagnosticSnapshot
} = require('../src/core/diagnostics/diagnosticSnapshot.js');

test('flightRecorder: records events and automatically sanitizes sensitive fields', () => {
    FlightRecorder.clear();
    assert.strictEqual(FlightRecorder.getEntries().length, 0);

    FlightRecorder.record('workbench', 'button_click', { button: 'btnExport', safeNumber: 42 });
    FlightRecorder.record('storage', 'token_saved', {
        SNlM0e: 'super-secret-token',
        userCredential: 'secret-auth-key',
        authHeader: 'Bearer eyJhbGciOi...',
        apiKey: 'secret-key-1234',
        password: 'my-password',
        normalKey: 'visible-data'
    });

    const entries = FlightRecorder.getEntries();
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].subsystem, 'workbench');
    assert.strictEqual(entries[0].action, 'button_click');
    assert.strictEqual(entries[0].details.button, 'btnExport');
    assert.strictEqual(entries[0].details.safeNumber, 42);

    // Verify sensitive tokens are redacted
    assert.strictEqual(entries[1].details.SNlM0e, '[REDACTED]');
    assert.strictEqual(entries[1].details.userCredential, '[REDACTED]');
    assert.strictEqual(entries[1].details.authHeader, '[REDACTED]');
    assert.strictEqual(entries[1].details.apiKey, '[REDACTED]');
    assert.strictEqual(entries[1].details.password, '[REDACTED]');
    assert.strictEqual(entries[1].details.normalKey, 'visible-data');

    // Verify in-memory buffer itself is eagerly redacted (zero raw sensitive tokens in memory)
    assert.strictEqual((FlightRecorder as any)._events[1].details.SNlM0e, '[REDACTED]', 'Internal in-memory event must be eagerly redacted');
});

test('maskTitle: masks titles safely while preserving structural metadata for debugging', () => {
    assert.strictEqual(maskTitle(null).maskedTitle, '[empty]');
    assert.strictEqual(maskTitle('').maskedTitle, '[empty]');
    assert.strictEqual(maskTitle('Hi').maskedTitle, '***');
    assert.strictEqual(maskTitle('Hi').titleLength, 2);

    const mMedium = maskTitle('Quantum Computing');
    assert.ok(mMedium.maskedTitle.startsWith('Qu***'));
    assert.ok(mMedium.maskedTitle.includes('[len:17]'));
    assert.strictEqual(mMedium.titleLength, 17);
});

test('explainStateDerivation: produces human-actionable diagnosis reasons', () => {
    const t0 = 1700000000000;
    const chat = { id: 'c1', timestamp: t0, updatedAt: t0, messageCount: 2 };

    // Unexported
    const rUnexp = explainStateDerivation(chat, null);
    assert.ok(rUnexp.includes('No export record'));

    // Partial
    const rPartial = explainStateDerivation(chat, { status: 'partial' });
    assert.ok(rPartial.includes('partial'));

    // Exported clean
    const rClean = explainStateDerivation(chat, { exportedAt: new Date(t0 + 5000).toISOString(), chatTime: t0 });
    assert.ok(rClean.includes('clean and up to date'));

    // Updated
    const rUpdated = explainStateDerivation({ ...chat, updatedAt: t0 + 60000 }, { exportedAt: new Date(t0 + 5000).toISOString(), chatTime: t0 });
    assert.ok(rUpdated.includes('advanced past export record'));
});

test('buildDiagnosticSnapshot: builds complete, sanitized state mirror without credential leaks', async () => {
    const t0 = 1700000000000;
    const mockConversations = [
        { id: 'chat_001', title: 'Private Discussion on Project X', timestamp: t0, updatedAt: t0, messageCount: 5 },
        { id: 'chat_002', title: 'Physics Research', timestamp: t0, updatedAt: t0 + 50000, messageCount: 3 }
    ];
    const mockExportedIds = {
        'chat_001': { exportedAt: new Date(t0 + 5000).toISOString(), chatTime: t0, messageCount: 5, status: 'ok' },
        'chat_002': { exportedAt: new Date(t0 + 5000).toISOString(), chatTime: t0, messageCount: 2, status: 'ok' }
    };

    const origChrome = (globalThis as any).chrome;
    try {
        (globalThis as any).chrome = {
            storage: {
                local: {
                    get: async () => ({
                        gemini_account_slots: { u0: { name: 'Account 1' } },
                        gemini_last_sync_diagnostics: { hitGoogleLimit: false, pagesScanned: 3 },
                        gemini_last_export_session: { status: 'completed', total: 2 },
                        gemini_dev_mode: true
                    })
                }
            }
        };

        const snapshot = await buildDiagnosticSnapshot({
            slot: 'u0',
            conversations: mockConversations,
            exportedIds: mockExportedIds,
            workbenchLogs: [{ time: '12:00:00', level: 'info', msg: 'Started export' }]
        });

        assert.strictEqual(snapshot.diagnosticVersion, '2.0.0');
        assert.strictEqual(snapshot.environment.currentSlot, 'u0');
        assert.strictEqual(snapshot.environment.isDevMode, true);
        assert.strictEqual(snapshot.storageOverview.totalConversations, 2);
        assert.strictEqual(snapshot.storageOverview.totalExportedRecords, 2);

        // Verify conversations mirror
        assert.strictEqual(snapshot.conversationsStateMirror.length, 2);
        const item1 = snapshot.conversationsStateMirror[0];
        assert.strictEqual(item1.id, 'chat_001');
        assert.ok(!item1.maskedTitle.includes('Private Discussion on Project X'), 'Title must be desensitized');
        assert.ok(item1.maskedTitle.includes('Pr***'));
        assert.strictEqual(item1.derivedState.state, 'exported_ok');
        assert.strictEqual(item1.derivedState.needsIncrementalExport, false);

        const item2 = snapshot.conversationsStateMirror[1];
        assert.strictEqual(item2.id, 'chat_002');
        assert.strictEqual(item2.derivedState.state, 'updated');
        assert.strictEqual(item2.derivedState.needsIncrementalExport, true);
        assert.ok(item2.derivedState.explanation.includes('advanced past export record'));

        // Verify sync & flight recorder
        assert.ok(snapshot.syncDiagnostics);
        assert.strictEqual(snapshot.syncDiagnostics.pagesScanned, 3);
        assert.ok(Array.isArray(snapshot.flightRecorder));
        assert.ok(Array.isArray(snapshot.workbenchLogs));
        assert.strictEqual(snapshot.workbenchLogs!.length, 1);
    } finally {
        (globalThis as any).chrome = origChrome;
    }
});
