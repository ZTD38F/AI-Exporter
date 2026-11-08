import { fixtureAccount } from './helpers/domainFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacyConversationIndex } from './helpers/recordFixture/parseIndex.js';
import { parseGeminiIndexObservation } from '../src/l1/parsers/gemini/parseIndexObservation.js';

test('historical aliases cannot become current Gemini metadata or cloud evidence', () => {
    const raw = { id: 'c_boundary123', title: 'Current title', titleSource: 'dom',
        titles: { rpc: 'Historical authoritative title', takeout: 'Historical offline title' },
        timestamp: '1700000000', chatTime: 1700000010000, lastSeen: 1900000000000,
        href: 'https://example.com/historical', source: 'takeout-import', isTakeoutOnly: true,
        cloudAvailability: 'available', messageCount: 6 };
    const legacy = parseLegacyConversationIndex(raw, fixtureAccount());
    assert.equal(legacy.title, 'Historical authoritative title');
    assert.equal(legacy.titleSource, 'provider');
    assert.equal(legacy.updatedAt, 1700000000000);
    assert.equal(Reflect.get(legacy ?? {}, 'url'), undefined);
    assert.equal(Reflect.get(legacy ?? {}, 'hasTakeoutImport'), undefined);
    assert.equal(Reflect.get(legacy ?? {}, 'messageCount'), undefined);

    const current = parseGeminiIndexObservation(raw, 'dom').fields;
    assert.equal(current.title, 'Current title');
    assert.equal(current.titleSource, 'provider');
    assert.equal(current.updatedAt, undefined);
    assert.equal(Reflect.get(current ?? {}, 'url'), undefined);
    assert.equal(Reflect.get(current ?? {}, 'hasTakeoutImport'), undefined);
    assert.equal(Reflect.get(current ?? {}, 'cloudAvailability'), undefined);
    assert.equal(Reflect.get(current ?? {}, 'messageCount'), undefined);
    assert.equal(Reflect.get(parseGeminiIndexObservation(raw, 'rpc-list').fields ?? {}, 'messageCount'), undefined);
});

test('current metadata treats numeric strings as milliseconds without historical seconds inference', () => {
    const raw = { id: 'time-boundary', title: 'Title', updatedAt: '1700000000', createdAt: '1700000000' };
    assert.equal(parseLegacyConversationIndex(raw, fixtureAccount()).updatedAt, 1700000000000);
    const current = parseGeminiIndexObservation(raw, 'dom').fields;
    assert.equal(current.updatedAt, 1700000000);
    assert.equal(current.createdAt, 1700000000);
    assert.throws(() => parseGeminiIndexObservation({ id: 123 }, 'dom'), TypeError);
});
