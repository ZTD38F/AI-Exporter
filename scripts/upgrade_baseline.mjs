import assert from 'node:assert/strict';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const formats = new Set(['markdown', 'html', 'json', 'pdf']);
const millis = value => {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value)
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  return Number.isSafeInteger(number) && Math.abs(number) <= 8.64e15 ? number : undefined;
};
/** Independent disk oracle: only the five categories in the frozen one-time upgrade contract. */
export function migrationFacts(state) {
  const accounts = state.databases?.gemini_exporter_domain?.stores?.accounts;
  assert.ok(Array.isArray(accounts) && accounts.length > 0,
    'Unsupported v1 baseline schema: upgrade requires a persisted UUID Account registry; u0/u1 slot profiles cannot prove this migration');
  const indexes = [], exportRecords = [];
  for (const account of accounts) {
    assert.match(account.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'v1 Account UUID');
    const rows = state.local[`conversations_${account.id}`] ?? [];
    assert.ok(Array.isArray(rows), 'v1 Index container');
    for (const row of rows) {
      assert.equal(row.key?.accountId, account.id, 'v1 Index ownership');
      const normalized = structuredClone(row);
      for (const name of ['createdAt', 'updatedAt']) if (name in normalized) {
        normalized[name] = millis(row[name]); assert.notEqual(normalized[name], undefined, 'v1 Index source time');
      }
      indexes.push(normalized);
    }
    const records = new Map();
    for (const [id, value] of Object.entries(state.local[`exported_${account.id}`] ?? {})) {
      const conversationId = account.providerId === 'gemini' ? id.replace(/^c_/, '') : id;
      if (!conversationId || conversationId !== conversationId.trim() || !object(value)
          || !['ok', 'partial'].includes(value.status) || !formats.has(value.format) || millis(value.exportedAt) === undefined) continue;
      const record = { exportedAt: millis(value.exportedAt), format: value.format,
        status: value.status === 'partial' || value.hasFailedAssets === true || value.truncated === true
          || value.isTruncated === true || (typeof value.truncateReason === 'string' && value.truncateReason) ? 'partial' : 'ok' };
      if (millis(value.chatTime) !== undefined) record.chatTime = millis(value.chatTime);
      if (!records.has(conversationId) || conversationId === id) records.set(conversationId, record);
    }
    for (const [conversationId, value] of records) exportRecords.push({ accountId: account.id, conversationId, value });
  }
  const local = state.local, settings = {};
  if (formats.has(local.gemini_export_format)) settings.defaultFormat = local.gemini_export_format;
  if (typeof local.gemini_dev_mode === 'boolean') settings.developerMode = local.gemini_dev_mode;
  if (['zh', 'en'].includes(local.gemini_exporter_lang)) settings.language = local.gemini_exporter_lang;
  const position = local.gemini_export_badge_pos;
  if (object(position) && Number.isFinite(position.left) && Number.isFinite(position.top)) settings.badgePosition = position;
  if (typeof local.live_save_config?.enabledDisk === 'boolean') settings.enabledDisk = local.live_save_config.enabledDisk;
  if (typeof local.last_seen_feature_version === 'string' && /^\d+(?:\.\d+){0,3}$/.test(local.last_seen_feature_version)) settings.lastSeenFeatureVersion = local.last_seen_feature_version;
  if (local.has_completed_takeout_prompt === true || local.has_imported_takeout === true) settings.takeoutPromptCompleted = true;
  const handleDB = state.databases?.gemini_exporter_idb;
  if (handleDB?.stores?.handles?.length) assert.ok(Array.isArray(handleDB.keys?.handles), 'Legacy directory key evidence missing');
  const handleKeys = handleDB?.keys?.handles ?? [];
  const handleIndex = handleKeys.indexOf('export_dir_handle');
  const handles = handleIndex < 0 ? [] : [handleDB.stores.handles[handleIndex]];
  return { accounts, indexes, exportRecords, settings, directoryHandles: handles };
}
const canonical = value => JSON.stringify(value, (_, entry) => object(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const sorted = rows => rows.map(canonical).sort();
export async function assertPersistedBaseline(before, after) {
  const facts = migrationFacts(before);
  assert.equal(after.local.gemini_exporter_v2_initialized, true, 'Migration completion marker missing');
  const db = after.databases?.gemini_exporter_v2;
  assert.equal(db?.version, 1, 'L3a v2 physical version');
  assert.deepEqual(Object.keys(db.stores).sort(), ['accounts', 'indexes', 'details', 'coverage', 'exportRecords', 'directoryHandles'].sort(), 'L3a six stores');
  for (const name of ['accounts', 'indexes', 'exportRecords', 'directoryHandles'])
    assert.deepEqual(sorted(db.stores[name]), sorted(facts[name]), `Migrated ${name} lost or changed`);
  if (db.keys?.directoryHandles) assert.deepEqual(db.keys.directoryHandles, facts.directoryHandles.length ? ['default'] : [], 'Directory singleton key');
  assert.deepEqual(db.stores.details, [], 'Migration must not import old bodies');
  assert.deepEqual(db.stores.coverage, [], 'Migration must not import old Coverage');
  assert.deepEqual(after.local.gemini_exporter_v2_settings, facts.settings, 'Mapped Settings mismatch');
  for (const [key, value] of Object.entries(before.local)) assert.deepEqual(after.local[key], value, 'Legacy source changed: ' + key);
  for (const [name, value] of Object.entries(before.databases)) assert.deepEqual(after.databases[name], value, 'Legacy DB changed: ' + name);
}
export function upgradeOutcome(stages) {
  return stages.length > 0 && stages.every(stage => stage.status === 'passed') ? 'passed' : 'failed';
}
