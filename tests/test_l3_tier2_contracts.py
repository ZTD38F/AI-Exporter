"""Offline regression checks of Tier 2's real Storage -> Domain -> Composer probe."""
import copy
import json
from pathlib import Path
import subprocess
import unittest
from scripts.framework.l3_contracts import assert_l3_contracts

ROOT = Path(__file__).resolve().parents[1]


class L3Tier2Contracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        code = r"""
const {indexStorage}=require('./tests/helpers/indexStorage.ts');
const {fixtureAccount}=require('./tests/helpers/domainFixture.ts');
const {validateParserDomain}=require('./src/l2/runtimeValidation.ts');
const storage=require('./src/l3a/storageService.ts');
const env=indexStorage();
(async()=>{try{
 const account=fixtureAccount('gemini'),key={accountId:account.id,conversationId:'same'};
 globalThis.document={compatMode:'CSS1Compat',getElementById:()=>({value:account.id})};
 const probe=require('./scripts/framework/v2_probe.ts');
 const domain=validateParserDomain({index:{key,title:'Two\nlines',titleSource:'provider',createdAt:0},detail:{key,quality:{status:'partial'},savedAt:123,assets:[{id:'image',kind:'image',name:'original.png'},{id:'unowned',kind:'file'}],messages:[
 {role:'assistant',timestamp:0,citations:[{id:'same',title:'Offline'},{id:'unreferenced',url:'https://example.test'}],reasoning:[{type:'paragraph',children:[{type:'citationRef',citationId:'same',label:'[99]'}]}],content:[{type:'image',assetId:'image'}]},
 {role:'assistant',reasoning:[],citations:[{id:'same'}],content:[{type:'paragraph',children:[{type:'citationRef',citationId:'same'}]}]}
 ]}});
 await storage.putAccount(account);
 await storage.updateConversationAtomically(key,()=>({...domain,result:undefined}));
 process.stdout.write(JSON.stringify(await probe.l3Contracts(['same'])));
 }finally{env.restore();}})().catch(e=>{console.error(e);process.exitCode=1});
"""
        result = subprocess.run(['node', '-r', './tests/ts_register.js', '-e', code], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.evidence = json.loads(result.stdout)

    def test_actual_current_ports_match_frozen_schema(self):
        assert_l3_contracts(self.evidence, ['same'])

    def test_rejects_schema_and_cross_module_contract_regressions(self):
        def store(e):
            return e['layout']['stores'][0]
        def row(e):
            return e['documents'][0]
        def doc(e):
            return row(e)['document']
        mutations = [
            lambda e: e['layout'].update(version=2),
            lambda e: e['layout']['stores'].append({'name': 'resourceBytes'}),
            lambda e: store(e).update(keyPath='providerAccountId'),
            lambda e: store(e)['indexes'][0].update(unique=False),
            lambda e: row(e)['key'].update(accountId='other'),
            lambda e: doc(e)['metadata'].update(updatedAt=123),
            lambda e: doc(e).update(schemaVersion=1),
            lambda e: doc(e)['messages'][0].update(id='m1'),
            lambda e: doc(e)['messages'][0]['blocks'][0].pop('title'),
            lambda e: doc(e)['messages'][1]['blocks'].insert(0, {'type': 'disclosure', 'title': 'Empty', 'kind': 'reasoning', 'blocks': []}),
            lambda e: doc(e)['messages'][1]['sources'][0].update(number=1),
            lambda e: doc(e)['messages'][0]['blocks'][0]['blocks'][0]['children'][0].update(label='[1]'),
            lambda e: row(e).update(referencedIds=['unowned']),
            lambda e: row(e).update(imageIds=[]),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                evidence = copy.deepcopy(self.evidence)
                mutation(evidence)
                with self.assertRaises((AssertionError, KeyError)):
                    assert_l3_contracts(evidence, ['same'])
        with self.assertRaises(AssertionError):
            assert_l3_contracts(self.evidence, ['missing'])


if __name__ == '__main__':
    unittest.main()
