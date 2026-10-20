/**
 * tests/test_provenance.test.ts
 *
 * Validates the Test Provenance Classification Manifest (Section 5 & 21, Remediation 1.1).
 * Enforces:
 * 1. Strict P0 Admission Gate: ANY test claiming P0 MUST possess a verifiable
 *    evidence file path on disk and a non-empty originalHash.
 * 2. Manifest structural integrity and valid tier definitions.
 * 3. Every canonical & typst-math test file in tests/ is audited and classified.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '../scripts/parser_migration/test_provenance_manifest.json');

test('Test Provenance Manifest: File existence and structural integrity', () => {
    assert.ok(fs.existsSync(MANIFEST_PATH), 'test_provenance_manifest.json must exist');
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    const data = JSON.parse(raw);

    assert.ok(data.version, 'Manifest must declare version');
    assert.ok(data.classificationDefinitions, 'Manifest must declare classificationDefinitions');
    assert.deepStrictEqual(
        Object.keys(data.classificationDefinitions).sort(),
        ['P0', 'P1', 'P2', 'P3', 'P4'].sort(),
        'Must define all 5 tiers (P0-P4)'
    );

    assert.ok(Array.isArray(data.suites), 'Manifest must declare suites array');
    assert.ok(data.suites.length >= 22, `Expected at least 22 audited suites, got ${data.suites.length}`);
});

const crypto = require('crypto');

test('Test Provenance Manifest: Strict P0 Admission Gate (evidence + cryptographic SHA-256)', () => {
    const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

    for (const suite of data.suites) {
        const tests = suite.tests || [];
        const isP0 = suite.classification === 'P0' || tests.some((t: any) => t.classification === 'P0');
        if (isP0) {
            assert.ok(
                typeof suite.evidence === 'string' && suite.evidence.length > 0,
                `P0 suite '${suite.file}' MUST specify an evidence file path.`
            );
            const evidencePath = path.join(__dirname, '..', suite.evidence);
            assert.ok(
                fs.existsSync(evidencePath),
                `P0 suite '${suite.file}' evidence file must exist on disk: ${suite.evidence}`
            );
            assert.strictEqual(
                typeof suite.originalHash,
                'string',
                `P0 suite '${suite.file}' MUST specify a valid originalHash.`
            );
            assert.strictEqual(
                suite.originalHash.length,
                64,
                `P0 suite '${suite.file}' originalHash must be a 64-character SHA-256 hex string.`
            );
            const fileContent = fs.readFileSync(evidencePath);
            const computedHash = crypto.createHash('sha256').update(fileContent).digest('hex');
            assert.strictEqual(
                computedHash,
                suite.originalHash,
                `Cryptographic SHA-256 mismatch for P0 evidence in '${suite.file}'`
            );
        }
    }
});

test('Test Provenance Manifest: All registered suites and tests have valid classifications', () => {
    const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const validTiers = new Set(['P0', 'P1', 'P2', 'P3', 'P4']);
    const validPolicies = new Set([
        'MUST_PASS_REAL_REGRESSION',
        'VERIFY_AGAINST_STANDARD',
        'PRESERVE_PROJECT_CONTRACT',
        'ROBUSTNESS_NON_BLOCKING',
        'LEGACY_IMPLEMENTATION_SPECIFIC'
    ]);

    const actualCounts: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };

    for (const suite of data.suites) {
        const fullPath = path.join(__dirname, '..', suite.file);
        assert.ok(fs.existsSync(fullPath), `Suite file must exist: ${suite.file}`);
        assert.ok(validTiers.has(suite.classification), `Invalid classification for ${suite.file}: ${suite.classification}`);
        assert.ok(validPolicies.has(suite.policy), `Invalid policy for ${suite.file}: ${suite.policy}`);
        assert.ok(suite.provenanceSource && suite.provenanceSource.length > 10, `Detailed provenanceSource required for ${suite.file}`);
        assert.ok(suite.testCount > 0, `Suite ${suite.file} must declare at least 1 test`);
        assert.strictEqual(suite.tests.length, suite.testCount, `Mismatch in testCount for ${suite.file}`);

        // Validate each test item
        for (const t of suite.tests) {
            assert.strictEqual(typeof t.name, 'string', `Test in ${suite.file} must have a name string`);
            assert.ok(t.name.length > 0, `Test in ${suite.file} must have a non-empty name`);
            assert.ok(validTiers.has(t.classification), `Invalid test classification for '${t.name}' in ${suite.file}: ${t.classification}`);
            if (t.policy) {
                assert.ok(validPolicies.has(t.policy), `Invalid test policy for '${t.name}' in ${suite.file}: ${t.policy}`);
            }
            actualCounts[t.classification] = (actualCounts[t.classification] || 0) + 1;
        }
    }

    assert.deepStrictEqual(
        data.summary.byClassification,
        actualCounts,
        'summary.byClassification must exactly match aggregate test-level counts'
    );
});

test('Test Provenance Manifest: No unclassified canonical or typst test files in tests/', () => {
    const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const registeredFiles = new Set(data.suites.map((s: any) => s.file.replace(/\\/g, '/')));

    const testDir = __dirname;
    const testFiles = fs.readdirSync(testDir);
    const unclassified: string[] = [];

    for (const f of testFiles) {
        if (!f.endsWith('.test.ts')) continue;
        const isCanonical = f.startsWith('canonical-') || f === 'html-canonical-migration.test.ts';
        const isTypst = f.startsWith('typst-');
        if (isCanonical || isTypst) {
            const rel = `tests/${f}`;
            if (!registeredFiles.has(rel)) {
                unclassified.push(rel);
            }
        }
    }

    assert.deepStrictEqual(
        unclassified,
        [],
        `All canonical and typst test files must be audited in the manifest. Unclassified files: ${unclassified.join(', ')}`
    );
});
