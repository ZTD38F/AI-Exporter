"""Fail-closed checks for the real-profile harness; no browser/account needed."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/test_upgrade_profile.mjs'


class UpgradeHarnessGuards(unittest.TestCase):
    def run_harness(self, *args):
        return subprocess.run(['node', str(SCRIPT), *map(str, args)], cwd=ROOT,
                              text=True, capture_output=True, timeout=20)

    def test_missing_package_identity_cannot_return_success(self):
        result = self.run_harness()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Usage:', result.stderr)

    def test_original_profile_directory_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / 'baseline.json'
            marker.write_text('immutable original')
            result = self.run_harness('--old-zip', 'missing-old.zip', '--candidate-zip',
                                      'missing-new.zip', '--output-dir', root)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(), 'immutable original')
            self.assertEqual(list(root.iterdir()), [marker])

    def test_unverified_old_package_fails_with_diagnostic_without_creating_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'fake-v1.7.0.zip'
            old.write_bytes(b'Unverified release bytes')
            output = root / 'new-run'
            result = self.run_harness('--old-zip', old, '--candidate-zip', old, '--output-dir', output)
            self.assertNotEqual(result.returncode, 0)
            report = json.loads((output / 'report.json').read_text())
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(report['stages'][0]['status'], 'failed')
            self.assertIn('verified official v1.7.0', report['error'])
            self.assertFalse((output / 'profile').exists())


    def test_five_category_upgrade_oracle_rejects_wrong_identity_and_out_of_scope_migration(self):
        code = """
import assert from 'node:assert/strict';
import {migrationFacts,assertPersistedBaseline,upgradeOutcome} from './scripts/upgrade_baseline.mjs';
assert.throws(()=>migrationFacts({local:{gemini_conversations:[{id:'a'}]},databases:{}}),/Unsupported v1 baseline schema/);
assert.equal(upgradeOutcome([{status:'passed'},{status:'not_applicable'}]),'failed');
assert.equal(upgradeOutcome([{status:'passed'}]),'passed');
const id='10000000-0000-4000-8000-000000000001';
const account={id,providerId:'gemini',providerAccountId:'subject'};
const index={key:{accountId:id,conversationId:'chat'},title:'Old',titleSource:'provider',updatedAt:'0'};
const before={local:{['conversations_'+id]:[index],['exported_'+id]:{chat:{exportedAt:1000,format:'pdf',status:'ok'}},gemini_dev_mode:false,live_save_config:{enabledDisk:true}},databases:{gemini_exporter_domain:{version:1,stores:{accounts:[account],conversations:[{messages:['must not migrate']}]}}}};
before.databases.gemini_exporter_idb={version:1,stores:{handles:[{directoryHandleSnapshot:true,kind:'directory',name:'Selected'}]},keys:{handles:['export_dir_handle']}};
const facts=migrationFacts(before);
const after=structuredClone(before);after.local.gemini_exporter_v2_initialized=true;
after.local.gemini_exporter_v2_settings=facts.settings;
after.databases.gemini_exporter_v2={version:1,stores:{accounts:facts.accounts,indexes:facts.indexes,exportRecords:facts.exportRecords,directoryHandles:facts.directoryHandles,details:[],coverage:[]}};
await assertPersistedBaseline(before,after);
for(const change of [
 a=>{delete a.local.gemini_exporter_v2_initialized;},
 a=>{a.databases.gemini_exporter_v2.stores.indexes[0].key.accountId='other';},
 a=>{a.databases.gemini_exporter_v2.stores.details.push({messages:['old body']});},
 a=>{a.databases.gemini_exporter_v2.stores.coverage.push({range:null});},
 a=>{a.databases.gemini_exporter_v2.stores.resourceBytes=[];},
 a=>{a.databases.gemini_exporter_v2.stores.exportRecords[0].value.status='partial';},
 a=>{a.local.gemini_exporter_v2_settings.developerMode=true;},
 a=>{delete a.local['conversations_'+id];},
 a=>{a.databases.gemini_exporter_v2.stores.directoryHandles[0].name='Other';},
]) { const wrong=structuredClone(after);change(wrong);await assert.rejects(()=>assertPersistedBaseline(before,wrong)); }
"""
        result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=ROOT,
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
