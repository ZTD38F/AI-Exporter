"""Counterexamples for the existing Tier 2 cases; no Google/network required."""
import base64
import copy
import hashlib
import io
import json
import os
import re
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.framework.assertions import (
    CDPAssertions, assert_archive_targets, assert_scan_result, assert_turn_content, assert_incremental_scan_result, assert_full_scan_coverage, assert_passive_coverage, assert_activity_sync_result, assert_followup_scan_result,
)
from scripts.framework.actions import CDPActions
from scripts.framework.cases.base import TestContext, DAGRunner, FeatureTestCase
from scripts.framework.cases.chat import read_initial_export_markdown, read_verified_export_baseline
from scripts.framework.cases.export import ImagenMultimodalCase
from scripts.framework.cases.export import (
    LiveSaveNewChatCase, HtmlExportDownloadCase, PdfExportDownloadCase,
    FastSkipExportedCase, StaleTabImageExportCase, select_format_targets,
)
from scripts.framework.cases.takeout import validate_takeout_records, TakeoutZipImportCase
from scripts.framework.cases.workbench import LanguageToggleCase
from scripts.framework.cases.sync import wait_for_prior_scan
from scripts.framework.driver.platform_driver import TurnResult
from scripts.framework.driver.gemini_driver import GeminiPlatformDriver
from scripts.framework.features import FeatureDomain, FeatureRegistry, TestStatus
from scripts.framework.scenario_provider import OnlineScenarioProvider
from scripts.framework.image_evidence import assert_image_files, assert_zip_images, image_pixels, capture_webpage_images
from tests.helpers.export_spec_asserter import ExportSpecificationAsserter

CID = '0123456789abcdef'
OTHER = 'abcdef0123456789'
REPLY = 'The measured pressure is bounded by the conservation law and the calibrated sensor readings.'
EVIDENCE = [{'prompt': 'Explain **pressure** and mass_balance.', 'response': REPLY, 'has_images': False}]


class OnboardingConnectionContracts(unittest.TestCase):
    def test_native_permission_prompt_can_take_longer_than_fifteen_seconds(self):
        cdp = MagicMock()
        cdp.eval.side_effect = [
            {'active': True, 'needsConnection': True, 'ready': True}, True,
            {'active': True, 'finished': True}, {'active': False, 'url': 'chrome-extension://test/src/ui/options/options.html'}, None,
        ]
        with patch('scripts.framework.actions.get_tabs', return_value=[{
            'url': 'chrome-extension://test/src/ui/options/options.html', 'webSocketDebuggerUrl': 'ws://options'}]), \
             patch('scripts.framework.actions.CDPConnection', return_value=cdp), \
             patch('scripts.framework.actions.time.monotonic', side_effect=[0, 0, 0, 20, 21]), \
             patch('scripts.framework.actions.time.sleep'):
            self.assertTrue(CDPActions.verify_onboarding_tour(ext_id='test'))

    def test_tour_uses_the_selected_platform_connection_once_then_completes(self):
        for provider in ['gemini', 'chatgpt', 'claude']:
            with self.subTest(provider=provider):
                cdp = MagicMock()
                cdp.eval.side_effect = [
                    {'active': True, 'needsConnection': True, 'ready': False},
                    {'active': True, 'needsConnection': True, 'ready': True}, True,
                    {'active': True, 'finished': True}, {'active': False, 'url': 'chrome-extension://test/src/ui/options/options.html'}, None,
                ]
                with patch('scripts.framework.actions.get_tabs', return_value=[{
                    'url': 'chrome-extension://test/src/ui/options/options.html', 'webSocketDebuggerUrl': 'ws://options'}]), \
                     patch('scripts.framework.actions.CDPConnection', return_value=cdp), \
                     patch('scripts.framework.actions.time.sleep'):
                    self.assertTrue(CDPActions.verify_onboarding_tour(ext_id='test', provider_id=provider))
                attempts = [call for call in cdp.eval.call_args_list if call.kwargs.get('user_gesture')]
                self.assertEqual(len(attempts), 2)
                self.assertIn('btnAuthorizePlatforms', attempts[0].args[0])
                self.assertIn(f'input.value === "{provider}"', attempts[0].args[0])
                cdp.close.assert_called_once()

    def test_unconnected_tour_fails_without_repeated_connection_attempts(self):
        cdp = MagicMock()
        cdp.eval.side_effect = lambda _expression, **kwargs: True if kwargs.get('user_gesture') else {
            'active': True, 'needsConnection': True, 'ready': True}
        with patch('scripts.framework.actions.get_tabs', return_value=[{
            'url': 'chrome-extension://test/src/ui/options/options.html', 'webSocketDebuggerUrl': 'ws://options'}]), \
             patch('scripts.framework.actions.CDPConnection', return_value=cdp), \
             patch('scripts.framework.actions.time.sleep'):
            self.assertFalse(CDPActions.verify_onboarding_tour(ext_id='test', provider_id='claude'))
        self.assertEqual(sum(bool(call.kwargs.get('user_gesture')) for call in cdp.eval.call_args_list), 1)

    def test_disappearing_or_replaced_tour_cannot_pass_before_final_button(self):
        cdp = MagicMock()
        cdp.eval.side_effect = [{'active': True}, {'active': False, 'url': 'chrome-extension://test/src/ui/options/options.html'}]
        with patch('scripts.framework.actions.get_tabs', return_value=[{
            'url': 'chrome-extension://test/src/ui/options/options.html', 'webSocketDebuggerUrl': 'ws://options'}]), \
             patch('scripts.framework.actions.CDPConnection', return_value=cdp), \
             patch('scripts.framework.actions.time.sleep'):
            self.assertFalse(CDPActions.verify_onboarding_tour(ext_id='test'))


class SelectionActionContracts(unittest.TestCase):
    def test_late_guidance_cannot_turn_clear_into_select_all(self):
        for selected in ([False, False], [True, False], [True, True]):
            for action, expected in ((CDPActions.toggle_select_none, 0), (CDPActions.toggle_select_all, 2)):
                with self.subTest(selected=selected, action=action.__name__):
                    cdp = MagicMock()
                    def evaluate(expression):
                        # Model the real capture-phase guard: the first outside click
                        # dismisses guidance without activating its target checkbox.
                        script = '''
                            let selected = ''' + json.dumps(selected) + ''';
                            let guidance = true;
                            const checkbox = {
                                disabled: false,
                                get checked() { return selected.every(Boolean); },
                                get indeterminate() { return selected.some(Boolean) && !this.checked; },
                                click() { if (guidance) { guidance = false; return; }
                                    selected = selected.map(() => !this.checked); }
                            };
                            const document = {
                                getElementById: () => guidance ? {click() {guidance = false;}} : null,
                                querySelector: () => checkbox,
                                querySelectorAll: () => selected.filter(Boolean)
                            };
                            process.stdout.write(JSON.stringify(eval(''' + json.dumps(expression) + ''')));
                        '''
                        return json.loads(subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True).stdout)
                    cdp.eval.side_effect = evaluate
                    self.assertEqual(action(cdp), expected)

    def test_failed_clear_evaluation_is_not_silently_treated_as_zero(self):
        cdp = MagicMock(); cdp.eval.return_value = None
        with self.assertRaisesRegex(RuntimeError, 'selection was not cleared'):
            CDPActions.toggle_select_none(cdp)


class LanguageToggleContracts(unittest.TestCase):
    def test_all_selected_labels_pass_and_selection_changes_fail(self):
        for selected_after, expected in [([CID], True), ([], False)]:
            ctx = MagicMock()
            with patch.object(CDPActions, 'switch_workbench_language', side_effect=['Clear selection', '清空选择']), \
                 patch.object(CDPAssertions, 'assert_selection_state', side_effect=[
                     {'selected': [CID]}, {'selected': selected_after}, {'selected': [CID]}]):
                self.assertEqual(LanguageToggleCase().execute(ctx)[0], expected)

    def test_language_helper_reports_failed_evaluation_instead_of_returning_error_object(self):
        cdp = MagicMock()
        cdp.eval.return_value = {}
        with patch('scripts.framework.actions.install_probe'):
            with self.assertRaisesRegex(RuntimeError, 'verified UI text'):
                CDPActions.switch_workbench_language(cdp, 'en')


def document(evidence=EVIDENCE, cid=CID):
    body = f'---\nid: "{cid}"\n---\n# Conversation\n'
    for t in evidence:
        prompt = re.sub(r'([\\`*_\[\]#~$])', r'\\\1', t['prompt'])
        body += f"\n## 👤 You\n\n{prompt}\n\n## 🤖 Assistant\n\n{t['response']}\n"
    return body


def scan_evidence():
    return {'started': True, 'finished': True, 'response': {
        'status': 'complete', 'pagesFetched': 2, 'conversationsFetched': 40}}


class V2MarkdownFormatContracts(unittest.TestCase):
    """Keep Tier 2 file assertions aligned with the real L4 renderer."""

    def test_v2_frontmatter_does_not_require_export_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            checker = ExportSpecificationAsserter(directory)
            content = ('---\ntitle: "Real v2 export"\nid: "' + CID
                       + '"\nprovider: "gemini"\ndate: "2026-10-19T00:00:00.000Z"'
                       + '\nupdated: "2026-10-19T01:00:00.000Z"\ntags:\n  - gemini-export'
                       + '\n---\n\n# Real v2 export\n')
            checker.assert_frontmatter(content, 'v2.md')
            self.assertEqual(checker.errors, [])
            for invalid in (
                content.replace(f'id: "{CID}"\n', ''),
                content.replace('2026-10-19T01:00:00.000Z', 'invalid-time'),
            ):
                rejected = ExportSpecificationAsserter(directory)
                rejected.assert_frontmatter(invalid, 'v2.md')
                self.assertTrue(rejected.errors)

    def test_v2_both_locales_preserve_role_and_answer_validation(self):
        turn = [{'prompt': 'Describe the model', 'response': 'Finished result.', 'has_images': False}]
        english = '## 👤 You\n\nDescribe the model\n\n## 🤖 Assistant\n\nFinished result.\n'
        chinese = '## 👤 你\n\nDescribe the model\n\n## 🤖 助手\n\nFinished result.\n'
        for content in (english, chinese):
            with self.subTest(content=content):
                self.assertTrue(assert_turn_content(content, turn)[0])
                with tempfile.TemporaryDirectory() as directory:
                    checker = ExportSpecificationAsserter(directory)
                    checker.assert_turn_flow(content, 'v2.md', min_turns=1)
                    self.assertEqual(checker.errors, [])
                self.assertFalse(assert_turn_content(content.replace('Finished result.', 'Different result.'), turn)[0])

    def test_image_ownership_parses_both_v2_role_locales(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory) / 'assets'
            assets.mkdir()
            (assets / 'user.png').write_bytes(b'original image' * 100)
            (assets / 'generated.png').write_bytes(b'model generated image' * 100)
            for user, assistant in (('You', 'Assistant'), ('你', '助手')):
                with self.subTest(locale=user):
                    content = (f'## 👤 {user}\n\n![user](assets/user.png)\n\n'
                               f'## 🤖 {assistant}\n\n![Generated Image](assets/generated.png)\n')
                    checker = ExportSpecificationAsserter(directory)
                    checker.assert_multi_turn_uploads('v2.md', content, expected_count=1)
                    checker.assert_ai_generated_images('v2.md', content, min_images=1)
                    self.assertEqual(checker.errors, [])


class StaleTabHistoryTests(unittest.TestCase):
    def run_case(self, scan, after_scan=None):
        ctx = MagicMock()
        ctx.port = 9222
        ctx.ext_id = 'fixture'
        ctx.shared_data = {'golden_image_evidence': [{'images': [{'fixture': True}]}]}
        ctx.env.reinstall_extension.return_value = 'fixture'
        cdp = ctx.connect_options.return_value
        receivers = {'stale': {'error': 'Receiving end does not exist'},
                     'good': {'reply': {'ok': True}}, 'freshId': 8}
        # If the row is still absent after sync, the original target assertion
        # must fail; the export action must never be used to fake success.
        cdp.eval.side_effect = [7, True, receivers, None, after_scan or receivers, False, None]
        with patch('scripts.framework.cases.export.select_source_account') as select, \
             patch('scripts.framework.cases.export.wait_for_prior_scan') as prior, \
             patch('scripts.framework.cases.export.clear_scan_records') as reset, \
             patch.object(CDPActions, 'trigger_deep_scan', return_value=scan) as sync, \
             patch.object(CDPActions, 'trigger_export_zip') as export:
            result = StaleTabImageExportCase().execute(ctx)
            select.assert_called_once_with(cdp, source_tab_id=8)
            prior.assert_called_once_with(cdp)
            reset.assert_called_once_with(cdp)
            sync.assert_called_once_with(cdp)
            export.assert_not_called()
        return result

    def test_denied_permission_stops_before_url_discovery_or_export(self):
        ctx = MagicMock()
        ctx.shared_data = {'golden_image_evidence': [{'fixture': True}]}
        ctx.env.reinstall_extension.return_value = 'fixture'
        cdp = ctx.connect_options.return_value
        cdp.eval.side_effect = [7, False, None]
        with patch.object(CDPActions, 'trigger_export_zip') as export:
            ok, message, _ = StaleTabImageExportCase().execute(ctx)
            self.assertFalse(ok)
            self.assertIn('站点权限未获授权', message)
            request = cdp.eval.call_args_list[1]
            self.assertIn('chrome.permissions.request', request.args[0])
            self.assertTrue(request.kwargs['user_gesture'])
            export.assert_not_called()

    def test_missing_second_tab_is_a_setup_failure_after_a_real_grant(self):
        ctx = MagicMock()
        ctx.shared_data = {'golden_image_evidence': [{'fixture': True}]}
        ctx.env.reinstall_extension.return_value = 'fixture'
        cdp = ctx.connect_options.return_value
        cdp.eval.side_effect = [7, True, {'error': 'no second Gemini tab', 'tabs': []}, None]
        with patch.object(CDPActions, 'trigger_deep_scan') as scan:
            ok, message, details = StaleTabImageExportCase().execute(ctx)
            self.assertFalse(ok)
            self.assertIn('场景准备失败', message)
            self.assertEqual(details['tabs'], [])
            scan.assert_not_called()

    def test_recent_page_without_older_target_requires_real_sync_and_still_fails_if_target_absent(self):
        ok, message, details = self.run_case(scan_evidence())
        self.assertFalse(ok)
        self.assertIn('未找到指定 Imagen', message)
        self.assertEqual(details['historyScan'], scan_evidence())

    def test_incomplete_sync_cannot_proceed_to_image_export(self):
        evidence = scan_evidence()
        evidence['finished'] = False
        ok, message, _ = self.run_case(evidence)
        self.assertFalse(ok)
        self.assertIn('历史同步未完成', message)

    def test_repaired_stale_tab_requires_verified_account_binding(self):
        healed = {'stale': {'reply': {'ok': True}}, 'good': {'reply': {'ok': True}}}
        ok, message, _ = self.run_case(scan_evidence(), healed)
        self.assertFalse(ok)
        self.assertIn('未绑定所选 Gemini 账号', message)


class SettledEvidenceTests(unittest.TestCase):
    def test_append_freeze_preserves_stream_history_and_records_all_final_turns(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = TestContext(output_dir=directory)
            record = {'chat_id': CID}
            ctx.record_turn(record, TurnResult(True, 'First prompt', 'Stream capture', chat_id=CID))
            driver = MagicMock()
            first = {'prompt': 'First prompt', 'response': 'Final first answer', 'has_images': False, 'code_blocks': [], 'execution_blocks': [], 'pdf_segments': [{'kind': 'text', 'text': 'Final first answer'}]}
            last = {'prompt': 'Append prompt', 'response': 'Final appended answer', 'has_images': False, 'code_blocks': [], 'execution_blocks': [], 'pdf_segments': [{'kind': 'text', 'text': 'Final appended answer'}]}
            driver.settled_conversation_evidence.side_effect = [[first], [first, last]]
            ctx.freeze_turn_evidence(driver, record)
            ctx.record_turn(record, TurnResult(True, 'Append prompt', 'Transient append', chat_id=CID))
            ctx.freeze_turn_evidence(driver, record)
            self.assertEqual(record['turn_evidence'], [first, last])
            self.assertEqual([t['response'] for t in record['stream_turn_evidence']], ['Stream capture', 'Transient append'])
            driver.settled_conversation_evidence.assert_called_with(CID, ['First prompt', 'Append prompt'])
            saved = json.loads((Path(directory)/f'{CID}_turn_evidence.json').read_text())
            self.assertEqual(saved, record)

    def test_invalid_freeze_does_not_replace_stream_or_write_file(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = TestContext(output_dir=directory)
            stream = {'prompt': 'Actual attachment prompt', 'response': 'Stream'}
            record = {'chat_id': CID, 'turn_evidence': [stream]}
            driver = MagicMock()
            driver.settled_conversation_evidence.return_value = [{
                'prompt': stream['prompt'], 'response': 'Complete answer',
                'has_images': False, 'code_blocks': [], 'execution_blocks': [],
                'pdf_segments': [{'kind': 'text', 'text': 'Truncated'}],
            }]
            with self.assertRaisesRegex(ValueError, 'segments'):
                ctx.freeze_turn_evidence(driver, record)
            self.assertEqual(record['turn_evidence'], [stream])
            self.assertFalse((Path(directory) / f'{CID}_turn_evidence.json').exists())

    def state(self):
        return {'chat_id': CID, 'streaming': False, 'turns': [
            {'prompt': 'Explain pressure.', 'response': REPLY, 'has_images': False, 'code_blocks': ['if ready:\n    run()']}]}

    def test_late_rendering_is_preserved_before_independent_page_rehydration(self):
        final = self.state()
        streaming = copy.deepcopy(final); streaming['streaming'] = True
        transient = copy.deepcopy(final); transient['turns'][0]['response'] = 'Unfinished rendering'
        cdp = MagicMock(); hydrated = copy.deepcopy(final); hydrated['turns'][0]['response'] = 'Correct persisted formula'
        cdp.eval.side_effect = [streaming, transient, final, final, final, hydrated, hydrated, hydrated]
        with patch('scripts.framework.driver.gemini_driver.time.sleep'):
            driver = GeminiPlatformDriver(cdp)
            result = driver.settled_conversation_evidence(CID, ['Explain pressure.'])
        self.assertEqual(driver.last_in_place_evidence, final['turns'])
        self.assertEqual(result, hydrated['turns'])
        self.assertEqual(cdp.eval.call_count, 8)
        cdp.call.assert_called_once_with('Page.reload', {'ignoreCache': True})

    def test_other_conversation_evidence_is_rejected(self):
        cdp = MagicMock(); state = self.state(); state['chat_id'] = OTHER; cdp.eval.return_value = state
        with self.assertRaises(RuntimeError):
            GeminiPlatformDriver(cdp).settled_conversation_evidence(CID, ['Explain pressure.'])

    def test_image_capture_failure_is_deferred_to_artifact_acceptance(self):
        state = self.state(); state['turns'][0].update(response='', has_images=True)
        cdp = MagicMock(); cdp.eval.return_value = state
        with patch('scripts.framework.driver.gemini_driver.time.sleep'), \
             patch('scripts.framework.image_evidence.capture_webpage_images', side_effect=ValueError('image unavailable')):
            turns = GeminiPlatformDriver(cdp).settled_conversation_evidence(CID, ['Explain pressure.'])
        self.assertEqual(turns[0]['image_evidence_error'], 'image unavailable')
        self.assertTrue(turns[0]['has_images'])

    def test_missing_turns_changed_prompts_and_empty_answers_cannot_settle(self):
        for change in ('missing', 'prompt', 'empty'):
            with self.subTest(change=change):
                state = self.state()
                if change == 'missing': state['turns'] = []
                elif change == 'prompt': state['turns'][0]['prompt'] = 'A different sent prompt'
                else: state['turns'][0]['response'] = ''
                cdp = MagicMock(); cdp.eval.return_value = state
                with patch('scripts.framework.driver.gemini_driver.time.sleep'), \
                     patch('scripts.framework.driver.gemini_driver.time.monotonic', side_effect=[0, 0, 2]):
                    with self.assertRaises(RuntimeError):
                        GeminiPlatformDriver(cdp).settled_conversation_evidence(CID, ['Explain pressure.'], timeout=1)


class DiskContentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.md = self.root / f'Chat_{CID[-6:]}.md'
        self.md.write_text(document())

    def tearDown(self):
        self.temp.cleanup()

    def check(self, evidence=EVIDENCE, baseline=None):
        return CDPAssertions.assert_real_disk_live_save(
            str(self.root), [CID], turn_evidence={CID: evidence},
            baselines={CID: baseline} if baseline is not None else None)[0]

    def test_actual_complete_reply_passes_and_missing_last_turn_fails(self):
        newer = EVIDENCE + [{'prompt': 'Give one capacity planning recommendation.',
                             'response': 'Reserve enough headroom for peak traffic and verify it with representative load measurements.',
                             'has_images': False}]
        before = document()
        self.assertFalse(self.check(newer, before))  # old, nonempty file
        self.md.write_text(document(newer))
        self.assertTrue(self.check(newer, before))
        self.assertFalse(self.check(newer, document(newer)))

    def test_original_turns_must_survive_append(self):
        newer = EVIDENCE + [{'prompt': 'Append a summary.', 'response': REPLY + ' Final recommendation.', 'has_images': False}]
        self.md.write_text(document(newer))
        self.assertFalse(self.check(newer, document().replace(REPLY, 'Original content that has been lost.')))

    def test_prompt_or_old_response_cannot_impersonate_last_model_answer(self):
        bad = document().replace(REPLY, 'No actual answer was persisted.')
        self.md.write_text(bad.replace(EVIDENCE[0]['prompt'], EVIDENCE[0]['prompt'] + REPLY))
        self.assertFalse(self.check())
        self.md.write_text(document().replace('## 🤖 Assistant', '## 👤 You'))
        self.assertFalse(self.check())

    def test_full_identity_and_uniqueness_are_required(self):
        self.md.write_text(document(cid='different' + CID[-6:]))
        self.assertFalse(self.check())
        self.md.write_text(document())
        (self.root / f'Other_{CID[-6:]}.md').write_text(document())
        self.assertFalse(self.check())

    def test_markdown_spaces_and_escaping_are_normalized(self):
        self.md.write_text(document().replace('mass_balance', 'mass\\_balance').replace(REPLY, '**' + REPLY.replace(' ', '\n') + '**'))
        self.assertTrue(self.check())

    def test_empty_nontext_reply_does_not_pass_without_image_entity(self):
        image = [{'prompt': 'Draw a diagram.', 'response': '', 'has_images': True}]
        self.md.write_text(document(image))
        self.assertFalse(self.check(image))
        self.md.write_text(document(image).replace('## 🤖 Assistant\n\n', '## 🤖 Assistant\n\n![Image](assets/diagram.png)'))
        self.assertFalse(self.check(image))
        (self.root / 'assets').mkdir()
        (self.root / 'assets/diagram.png').write_bytes(b'nonempty image bytes')
        self.assertFalse(self.check(image))  # Nonempty bytes cannot prove a matching image.
        self.md.write_text(self.md.read_text() + '\nFabricated extra answer text.\n')
        self.assertFalse(self.check(image))
        self.md.write_text(document(image).replace('## 🤖 Assistant\n\n', '## 🤖 Assistant\n\n![Image](assets/diagram.png)'))
        image[0]['has_images'] = False
        self.assertFalse(self.check(image))

    def test_flush_failure_cannot_pass_using_old_file(self):
        ctx = MagicMock(output_dir=str(self.root))
        ctx.chat_records = [{'chat_id': OTHER}, {'chat_id': CID, 'turn_evidence': EVIDENCE}]
        with patch.object(CDPActions, 'flush_live_save_to_disk', return_value={'ok': False, 'error': 'read failed'}):
            self.assertFalse(LiveSaveNewChatCase().execute(ctx)[0])

    def test_opfs_mtime_is_preserved_in_physical_copy(self):
        cdp = MagicMock()
        cdp.eval.return_value = {'ok': True, 'files': [{'path': 'old.md', 'text': 'old content', 'mtime': 100000}]}
        self.assertTrue(CDPActions.flush_live_save_to_disk(cdp, str(self.root))['ok'])
        self.assertEqual((self.root / 'gemini_export/old.md').stat().st_mtime, 100)



    def test_zip_download_is_routed_on_the_live_export_connection(self):
        cdp = MagicMock()
        cdp.call.return_value = {'id': 1, 'result': {}}
        path = self.root / 'gemini_export_fresh.zip'
        def export_now(script, *args, **kwargs):
            if "return !!btn" in script:
                return True
            if "btn.click();" in script:
                path.write_bytes(b'fresh ZIP bytes')
                return {'clicked': True}
        cdp.eval.side_effect = export_now
        with patch('scripts.framework.actions.time.sleep'), \
             patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}):
            result = CDPActions.trigger_export_zip(cdp, str(self.root), max_wait=1)
        self.assertEqual(result, str(path))
        cdp.call.assert_called_once_with('Browser.setDownloadBehavior', {
            'behavior': 'allow', 'downloadPath': str(self.root), 'eventsEnabled': True})

    def test_standalone_export_rejects_a_separate_attachment_zip(self):
        cdp = MagicMock()
        cdp.call.return_value = {'result': {}}
        markdown = self.root / 'Conversation_123456.md'
        attachments = self.root / 'attachments_123456.zip'
        def export_now(script, *args, **kwargs):
            if 'return !!btn' in script:
                return True
            if 'btn.click();' in script:
                markdown.write_text('Actual conversation body')
                with zipfile.ZipFile(attachments, 'w') as archive:
                    archive.writestr('assets/image.png', b'image bytes')
                os.utime(attachments, (time.time() + 1, time.time() + 1))
                return {'clicked': True}
        cdp.eval.side_effect = export_now
        with patch('scripts.framework.actions.time.sleep'), \
             patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}) as controls:
            self.assertIsNone(CDPActions.trigger_export_zip(cdp, str(self.root), max_wait=1, allow_standalone=True))
        controls.assert_called_once_with(cdp, None, False, include_assets=True)

    def test_split_deliveries_fail_without_merging_or_changing_downloaded_bytes(self):
        cdp = MagicMock()
        cdp.call.return_value = {'result': {}}
        body = self.root / 'conversations_123456.zip'
        attachments = self.root / 'attachments_123456.zip'
        def export_now(script, *args, **kwargs):
            if 'return !!btn' in script:
                return True
            if 'btn.click();' in script:
                with zipfile.ZipFile(body, 'w') as archive:
                    archive.writestr('Chat_123456.md', b'initial body')
                with zipfile.ZipFile(attachments, 'w') as archive:
                    archive.writestr('Chat_123456.md', b'final correction')
                    archive.writestr('assets/image.png', b'actual downloaded bytes')
                return {'clicked': True}
        cdp.eval.side_effect = export_now
        with patch('scripts.framework.actions.time.sleep'), \
             patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}):
            result = CDPActions.trigger_export_zip(cdp, str(self.root), max_wait=1)
        self.assertIsNone(result)
        with zipfile.ZipFile(body) as archive:
            self.assertEqual(archive.read('Chat_123456.md'), b'initial body')
        with zipfile.ZipFile(attachments) as archive:
            self.assertEqual(archive.read('Chat_123456.md'), b'final correction')
            self.assertEqual(archive.read('assets/image.png'), b'actual downloaded bytes')
        self.assertFalse((self.root / 'verification_deliveries').exists())

    def test_export_idle_wait_observes_cleanup_and_trigger_refuses_a_missed_click(self):
        cdp = MagicMock()
        cdp.eval.side_effect = [False, False, True]
        with patch('scripts.framework.actions.time.sleep'):
            self.assertTrue(CDPActions.wait_for_export_idle(cdp, max_wait=1))
        self.assertEqual(cdp.eval.call_count, 3)
        cdp.reset_mock()
        cdp.call.return_value = {'result': {}}
        cdp.eval.side_effect = [True, {'clicked': False}]
        with patch('scripts.framework.actions.time.sleep') as sleep, \
             patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}):
            self.assertIsNone(CDPActions.trigger_export_zip(cdp, str(self.root), max_wait=1))
        sleep.assert_not_called()  # Never enter the download wait after a missed click.

    def test_cdp_download_directory_configuration_failure(self):
        # A stale ZIP must never be reused if the configured CDP download route is denied.
        (self.root / 'gemini_export_old.zip').write_bytes(b'old ZIP bytes')
        cdp_message_only = MagicMock()
        cdp_message_only.call.return_value = {'error': {'message': 'denied'}}
        self.assertIsNone(CDPActions.trigger_export_zip(cdp_message_only, str(self.root), max_wait=1))
        cdp_message_only.eval.assert_not_called()
        # 1. 模拟 CDP 返回错误响应
        cdp_err = MagicMock()
        cdp_err.call.return_value = {'error': {'code': -32000, 'message': 'Browser.setDownloadBehavior denied'}}
        self.assertIsNone(CDPActions.trigger_export_zip(cdp_err, str(self.root), max_wait=1))
        cdp_err.eval.assert_not_called()

        # 2. 模拟 CDP 调用抛出连接或协议异常
        cdp_exc = MagicMock()
        cdp_exc.call.side_effect = RuntimeError("WebSocket connection dropped")
        self.assertIsNone(CDPActions.trigger_export_zip(cdp_exc, str(self.root), max_wait=1))
        cdp_exc.eval.assert_not_called()


    def test_role_headings_inside_code_are_not_turns(self):
        evidence = [{'prompt': EVIDENCE[0]['prompt'], 'response': '## 👤 You\n' + REPLY}]
        text = document().replace(REPLY, '```markdown\n## 👤 You\n```\n' + REPLY)
        self.assertTrue(assert_turn_content(text, evidence)[0])

    def test_user_prompt_punctuation_and_escapes_are_required(self):
        evidence = [{'prompt': r'Use f(\$)=1 and **literal** text.', 'response': REPLY}]
        exported = document(evidence)
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        for changed in (exported.replace(r'\\\$', r'\$'), exported.replace('=1', '+1'),
                        exported.replace(r'\*\*literal\*\*', 'literal')):
            self.assertFalse(assert_turn_content(changed, evidence)[0])

    def test_hidden_thinking_content_is_excluded_from_authored_body(self):
        authored_response = '系统在受扰动后将沿极限环收敛，其李雅普诺夫指数满足严格负定。'
        hidden_thinking = '思考过程：首先推导雅可比矩阵特征值，然后验证迹与行列式符号。'
        evidence_with_thinking = [{'prompt': '分析系统稳定性。', 'response': hidden_thinking + authored_response}]
        evidence_clean = [{'prompt': '分析系统稳定性。', 'response': authored_response}]
        exported = f"""## 👤 You
分析系统稳定性。
## 🤖 Assistant
{authored_response}
"""
        ok, msg = assert_turn_content(exported, evidence_with_thinking)
        self.assertFalse(ok)
        self.assertIn("全文不匹配", msg)
        self.assertTrue(assert_turn_content(exported, evidence_clean)[0])

    def test_inline_and_block_latex_semantic_comparison(self):
        inline_formula = r"E = mc^2"
        block_formula = r"\int_{-\infty}^{+\infty} e^{-x^2} dx = \sqrt{\pi}"
        evidence = [{'prompt': '给出核心物理与数学公式。',
                     'response': f"行内能量公式{inline_formula}。高斯积分块级公式如下：{block_formula}证明完毕。"}]
        exported = f"""## 👤 You
给出核心物理与数学公式。
## 🤖 Assistant
行内能量公式 ${inline_formula}$。高斯积分块级公式如下：

$$
{block_formula}
$$

证明完毕。
"""
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace("mc^2", "mc^3"), evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace(r"\sqrt{\pi}", r"\pi"), evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace(f"$$\n{block_formula}\n$$", ""), evidence)[0])

    def test_code_block_exact_preservation_and_comparison(self):
        code = "def solve_matrix(a, b):\n    # First step\n    if a is None:\n        return b\n\n    return a @ b"
        evidence = [{'prompt': '给出矩阵求解函数。',
                     'response': f"代码实现如下：{code}调用结束。",
                     'code_blocks': [code]}]
        exported = f"""## 👤 You
给出矩阵求解函数。
## 🤖 Assistant
代码实现如下：
```python
{code}
```
调用结束。
"""
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace("        return b", "    return b"), evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace("\n\n    return a @ b", "\n    return a @ b"), evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace("        return b", "\treturn b"), evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace("    # First step\n", "    # First step "), evidence)[0])

    def test_short_actual_answer_requires_its_whole_body(self):
        evidence = [{'prompt': '给一句建议', 'response': '以真实负载验证容量上限。', 'has_images': False}]
        self.assertTrue(assert_turn_content(document(evidence), evidence)[0])
        self.assertFalse(assert_turn_content(document(evidence).replace('以真实负载验证容量上限。', '验证容量。'), evidence)[0])

    def test_long_answer_middle_omission_fails(self):
        head = "首段引言与背景：阐述物理场耦合与偏微分方程初边值条件。" * 15
        middle = "核心中间推导步骤：构造格林函数并完成边界积分奇异性消除计算。" * 20
        tail = "尾部终局结论与数值验证：相对误差小于万分之一，理论与仿真一致。" * 15
        full_response = head + middle + tail
        evidence = [{'prompt': '给出完整长篇场论推导。', 'response': full_response}]
        exported_full = f"## 👤 You\n给出完整长篇场论推导。\n## 🤖 Assistant\n{full_response}\n"
        self.assertTrue(assert_turn_content(exported_full, evidence)[0])
        # 中段核心推导缺失（即使头尾片段存在），必须严格报错失败
        exported_omitted = exported_full.replace(middle, "")
        ok, msg = assert_turn_content(exported_omitted, evidence)
        self.assertFalse(ok)
        self.assertIn("全文不匹配", msg)

    def test_long_answer_tail_truncation_fails(self):
        head = "引言与参数设置概述。" * 20
        middle = "流体动力学纳维-斯托克斯方程渐近展开与二阶摄动求解。" * 20
        tail = "终态收敛性与边界层厚度渐近解结论。" * 10
        full_response = head + middle + tail
        evidence = [{'prompt': '推导渐近展开。', 'response': full_response}]
        exported_full = f"## 👤 You\n推导渐近展开。\n## 🤖 Assistant\n{full_response}\n"
        self.assertTrue(assert_turn_content(exported_full, evidence)[0])
        # 尾部截断必须严格报错失败
        exported_truncated = exported_full.replace(tail, "")
        ok, msg = assert_turn_content(exported_truncated, evidence)
        self.assertFalse(ok)
        self.assertIn("全文不匹配", msg)

    def test_source_math_code_tables_and_numbered_lists_match_in_full(self):
        response = "波速v = \\frac{c}{\\sqrt{\\varepsilon_r}}。完整代码print('ok')\nvalue = '<br>'计算结论甲乙"
        evidence = [{'prompt': '推导并给出完整代码', 'response': response}]
        exported = """## 👤 You
推导并给出完整代码
## 🤖 Assistant
波速 $v = \\frac{c}{\\sqrt{\\varepsilon_r}}$。
1. 完整代码
```python
print('ok')
value = '<br>'
```
2. 计算结论

| 甲<br>乙 |
| --- |
"""
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        for modified in (exported.replace('frac', 'sqrt'), exported.replace('v =', 'v +'),
                         exported.replace("print('ok')", "print('wrong')"),
                         exported.replace("value = '<br>'", "value + '<br>'"),
                         exported.replace('甲<br>乙', '甲')):
            self.assertFalse(assert_turn_content(modified, evidence)[0])

    def test_gemini_bold_and_source_chip_presentation_preserves_authored_body(self):
        response = "保存鱼类(Fish)和叶片(Leaf)的结构。完整结论print('[[1]]')value = 2 ** 3"
        evidence = [{'prompt': 'Explain the diagram.', 'response': response}]
        exported = """## 👤 You
Explain the diagram.
## 🤖 Assistant
保存**鱼类(Fish)和叶片(Leaf)**的结构。[\\[1\\]]完整结论
```python
print('[[1]]')
value = 2 ** 3
```

> 🌐 **Sources:**
> [1] [Example](https://example.com/source)
"""
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        for changed in (exported.replace('完整结论', ''), exported.replace('2 ** 3', '2 * 3'),
                        exported.replace("print('[[1]]')", "print('[]')")):
            self.assertFalse(assert_turn_content(changed, evidence)[0])

    def test_authored_source_like_text_and_unpaired_operators_are_preserved(self):
        response = "The literal marker is [[1]]; write 2 ** 3 in prose."
        evidence = [{'prompt': 'Explain literals.', 'response': response}]
        self.assertTrue(assert_turn_content(document(evidence), evidence)[0])
        self.assertFalse(assert_turn_content(document(evidence).replace('[[1]]', ''), evidence)[0])
        self.assertFalse(assert_turn_content(document(evidence).replace('**', '*'), evidence)[0])

    def test_visible_literal_bold_delimiters_require_physical_source(self):
        response = '本表所有数值均为**【虚构示例】**（用于解释）。结论准确。'
        evidence = [{'prompt': 'Explain the table.', 'response': response}]
        exported = document(evidence).replace('**', r'\*\*')
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        for changed in (exported.replace(r'\*\*', ''), exported.replace(r'\*\*', r'\*'),
                        exported.replace(r'\*\*【', '【'), exported.replace(r'】\*\*', '】'),
                        exported.replace('（', ''), exported.replace('结论准确。', ''),
                        exported.replace('虚构示例', '真实数据')):
            self.assertFalse(assert_turn_content(changed, evidence)[0])
        rendered = [{'prompt': 'Explain the table.', 'response': response.replace('**', '')}]
        self.assertTrue(assert_turn_content(exported.replace(r'\*\*', '**'), rendered)[0])

    def test_bold_spanning_math_and_code_keeps_literal_operators(self):
        response = r'真实分布 P 与模型 Q。示例 2**3。集合 |\Sigma|。'
        evidence = [{'prompt': 'Explain.', 'response': response}]
        body = r'**真实分布 $P$ 与模型 $Q$**。示例 **`2**3`**。集合 $\vert{}\Sigma\vert{}$。'
        exported = document(evidence).replace(response, body)
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        for changed in (exported.replace('2**3', '2*3'), exported.replace('Sigma', 'Lambda'),
                        exported.replace('与模型', '')):
            self.assertFalse(assert_turn_content(changed, evidence)[0])

    def test_math_alias_normalization_never_changes_literal_code(self):
        code = r'print("\vert{}")'
        evidence = [{'prompt': 'Show code.', 'response': code, 'code_blocks': [code]}]
        exported = document(evidence).replace(code, f'```python\n{code}\n```')
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace(r'\vert{}', '|'), evidence)[0])

    def test_norm_bars_cannot_be_replaced_by_absolute_value_bars(self):
        formula = r'\|x\|_2 + |D(a,b,c)|'
        evidence = [{'prompt': 'Explain norms.', 'response': formula}]
        exported = document(evidence).replace(formula, f'${formula}$')
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace(r'\|x\|', '|x|'), evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace('|D(a,b,c)|', r'\|D(a,b,c)\|'), evidence)[0])

    def test_norm_alias_canonicalization_only_applies_to_math(self):
        evidence = [{'prompt': 'Explain.', 'response': r'\|x\|_2'}]
        exported = document(evidence).replace(r'\|x\|_2', r'$\Vert{}x\Vert{}_2$')
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace('Vert', 'vert'), evidence)[0])
        literal = r'print("\Vert{}")'
        code_evidence = [{'prompt': 'Explain.', 'response': literal, 'code_blocks': [literal]}]
        code_export = document(code_evidence).replace(literal, f'```python\n{literal}\n```')
        self.assertTrue(assert_turn_content(code_export, code_evidence)[0])
        self.assertFalse(assert_turn_content(code_export.replace(r'\Vert{}', r'\|'), code_evidence)[0])

    def test_only_generated_trailing_source_metadata_is_excluded(self):
        evidence = [{'prompt': 'Explain the result.', 'response': 'Complete explanation.Final conclusion.'}]
        exported = "## 👤 You\nExplain the result.\n## 🤖 Assistant\nComplete explanation.[\\[1\\]]Final conclusion.\n\n> 🌐 **Sources:**\n> [1] [Article](https://example.com/article)\n"
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace('Final conclusion.', ''), evidence)[0])
        # Similar source prose inside the body and literal source footers in code
        # are authored content, rather than metadata to discard.
        for body in ('> 🌐 **Sources:**\n> [1] Article\n\nAfter the quoted sources.',
                     '```text\n🌐 Sources:\n[1] Article\n```'):
            expected = [{'prompt': 'Explain the result.', 'response': '🌐 Sources:[1] Article' + ('After the quoted sources.' if body.startswith('>') else '')}]
            self.assertTrue(assert_turn_content('## 👤 You\nExplain the result.\n## 🤖 Assistant\n'+body, expected)[0])

    def test_math_row_spacing_and_image_tile_labels_are_metadata_but_resources_are_required(self):
        formula = r'\begin{cases}a=1\\b=2\end{cases}'
        code = "if ready:\n    result = r'\\\\[2ex]'"
        evidence = [{'prompt': 'Explain the result.', 'response': 'Equation'+formula+'Program'+code+'Conclusion',
                     'has_images': True, 'code_blocks': [code]}]
        displayed = formula.replace('\\\\', '\\\\[2ex]')
        body = f'Equation\n$$\n{displayed}\n$$\nProgram\n```python\n{code}\n```\nConclusion\n\n![diagram.png](assets/diagram.png)\n\ndiagram.png\n'
        exported = document(evidence).replace(evidence[0]['response'], body)
        self.md.write_text(exported)
        self.assertFalse(self.check(evidence))  # metadata normalization cannot hide a missing asset
        (self.root/'assets').mkdir()
        (self.root/'assets/diagram.png').write_bytes(b'nonempty image bytes')
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        self.assertFalse(self.check(evidence))  # Text normalization cannot waive image comparison.
        for changed in (exported.replace('a=1', 'a=2'), exported.replace("result = r'\\\\[2ex]'", "result = r'\\\\[4ex]'"),
                        exported.replace('Conclusion', '')):
            self.assertFalse(assert_turn_content(changed, evidence)[0])

    def test_execution_records_are_separate_and_require_exact_independent_dom_evidence(self):
        code = 'if ready:\n    run()\n\n\nfinish()'
        evidence = [{'prompt': 'Run and explain.', 'response': 'Final answer', 'code_blocks': [],
                     'execution_blocks': [{'code': code, 'stdout': 'result: 7\nsecond line'}]}]
        exported = document(evidence).replace('Final answer', f'```python?code_reference&code_event_index=1\n{code}\n```\n\n```text?code_stdout&code_event_index=1\nresult: 7\nsecond line\n```\n\nFinal answer')
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        for changed in (exported.replace('    run()', '  run()'), exported.replace('result: 7', 'result: 8'),
                        exported.replace('Final answer', ''), exported.replace('\n\n\nfinish()', '\n\nfinish()')):
            self.assertFalse(assert_turn_content(changed, evidence)[0])
        no_execution_evidence = copy.deepcopy(evidence); no_execution_evidence[0]['execution_blocks'] = []
        self.assertFalse(assert_turn_content(exported, no_execution_evidence)[0])
        self.assertFalse(assert_turn_content(document(evidence), evidence)[0])

    def test_silent_execution_requires_exact_dom_source_and_cannot_hide_lost_stdout(self):
        code = '# This program intentionally emits no output.'
        evidence = [{'prompt': 'Execute.', 'response': 'Done.', 'code_blocks': [],
                     'execution_blocks': [{'code': code, 'stdout': ''}]}]
        exported = document(evidence).replace('Done.', f'```python?code_reference&code_event_index=1\n{code}\n```\n\nDone.')
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        for changed in (exported.replace(code, '# different'), document(evidence), exported.replace('Done.', '')):
            self.assertFalse(assert_turn_content(changed, evidence)[0])
        has_output = copy.deepcopy(evidence)
        has_output[0]['execution_blocks'][0]['stdout'] = 'actual output'
        self.assertFalse(assert_turn_content(exported, has_output)[0])
        with self.assertRaises(subprocess.CalledProcessError):
            assert_turn_content(exported.replace('code_reference', 'code_stdout'), evidence)

    def test_execution_marker_inside_regular_code_is_authored_content(self):
        code = 'python?code_reference&code_event_index=1\nWas this visual helpful?'
        evidence = [{'prompt': 'Show the literal marker.', 'response': code, 'code_blocks': [code]}]
        exported = document(evidence).replace(code, f'```text\n{code}\n```')
        self.assertTrue(assert_turn_content(exported, evidence)[0])
        self.assertFalse(assert_turn_content(exported.replace('Was this visual helpful?', ''), evidence)[0])

class ScanAndImportTests(unittest.TestCase):
    account = '10000000-0000-4000-8000-000000000001'

    def coverage(self, head=100, tail=10):
        return {'range': {'head': {'id': CID, 'time': head}, 'tail': {'id': OTHER, 'time': tail}}}

    def activity_fixture(self):
        initial = {'accountId': self.account, 'coverage': self.coverage(),
                   'rows': [{'key': {'accountId': self.account, 'conversationId': CID}, 'title':'First', 'titleSource':'provider', 'updatedAt':100},
                            {'key': {'accountId': self.account, 'conversationId': OTHER}, 'title':'Other', 'titleSource':'provider', 'updatedAt':10}], 'exportIds':[CID]}
        after = copy.deepcopy(initial)
        after['coverage'] = self.coverage(120)
        after['rows'][0]['updatedAt'] = 120
        after['rows'][1]['updatedAt'] = 110
        scan = scan_evidence()
        scan['response']['status'] = 'up_to_date'
        full = scan_evidence()
        full['response']['pagesFetched'] = 8
        return {'state':initial, 'scan':full}, copy.deepcopy(initial), scan, after

    def test_full_scan_requires_real_result_and_v2_recent_row(self):
        self.assertTrue(assert_full_scan_coverage(scan_evidence(), self.coverage())[0])
        self.assertTrue(assert_full_scan_coverage(scan_evidence(), {'range':None})[0])
        for status in ('provider_limit','max_pages','error','aborted','up_to_date'):
            evidence = scan_evidence(); evidence['response']['status'] = status
            self.assertFalse(assert_full_scan_coverage(evidence, self.coverage())[0])
        for broken in (None, {}, {'version':4,'range':None}, self.coverage(5), {'range':{'head':{'id':'h','time':float('nan')},'tail':{'id':'t','time':1}}}):
            self.assertFalse(assert_full_scan_coverage(scan_evidence(), broken)[0])

    def test_incremental_requires_boundary_result_and_preserves_tail(self):
        baseline, before, scan, after = self.activity_fixture()
        self.assertTrue(assert_incremental_scan_result(scan,before['coverage'],after['coverage'])[0])
        for value in ({'range':None}, self.coverage(90), self.coverage(120,20)):
            self.assertFalse(assert_incremental_scan_result(scan,before['coverage'],value)[0])
        self.assertFalse(assert_incremental_scan_result(scan_evidence(),before['coverage'],after['coverage'])[0])
        self.assertTrue(assert_followup_scan_result(scan_evidence(),{'range':None},{'range':None})[0])

    def test_activity_requires_same_uuid_targets_and_retained_archives(self):
        baseline, before, scan, after = self.activity_fixture()
        self.assertTrue(assert_activity_sync_result(baseline,before,scan,after,[CID,OTHER])[0])
        for change in ('account','target','time','record','archive'):
            state = copy.deepcopy(after)
            if change == 'account': state['accountId'] = 'default'
            if change == 'target': state['rows'] = state['rows'][:1]
            if change == 'time': state['rows'][0]['updatedAt'] = 100
            if change == 'record': state['exportIds'] = []
            if change == 'archive': state['rows'].append({'key':{'accountId':self.account,'conversationId':'new'}}); baseline['state']['rows'].append({'key':{'accountId':self.account,'conversationId':'archived'}})
            if change == 'head': state['coverage']['range']['head']['time'] = 101
            self.assertFalse(assert_activity_sync_result(baseline,before,scan,state,[CID,OTHER])[0],change)

    def test_passive_requires_matching_observation_and_committed_endpoints(self):
        before = {'accountId':self.account,'coverage':None}
        after = {'accountId':self.account,'coverage':self.coverage(), 'rows':[{'key':{'accountId':self.account,'conversationId':CID}},{'key':{'accountId':self.account,'conversationId':OTHER}}]}
        observed = [{'streamId':'recent','accountId':self.account,'requestedAt':1,'truncated':False}]
        self.assertTrue(assert_passive_coverage(before,after,observed)[0])
        partial = {**after, 'coverage': {'range': None}}
        self.assertTrue(assert_passive_coverage(before,partial,observed)[0])
        for pages in ([],[{**observed[0],'accountId':'default'}],[{**observed[0],'truncated':True}]):
            self.assertFalse(assert_passive_coverage(before,after,pages)[0])
        after['rows'] = after['rows'][:1]
        self.assertFalse(assert_passive_coverage(before,after,observed)[0])

    def test_passive_setup_waits_for_onboarding_scan_to_settle(self):
        from scripts.framework.cases.sync import wait_for_prior_scan
        cdp = MagicMock(); cdp.eval.side_effect = [False,False,True]
        with patch('scripts.framework.cases.sync.time.sleep') as sleep:
            wait_for_prior_scan(cdp)
        self.assertEqual(sleep.call_count,2)

    def test_complete_fast_scan_passes_without_sampling_busy_state(self):
        cdp = MagicMock(); cdp.eval.side_effect = [{'clicked':True},scan_evidence(),None]
        self.assertTrue(assert_scan_result(CDPActions.trigger_deep_scan(cdp))[0])

    def test_idle_unstarted_failed_and_partial_scans_fail(self):
        for change in ('started','finished','error','status','pages','entries'):
            evidence = scan_evidence()
            if change in ('started','finished'): evidence[change] = False
            elif change == 'error': evidence['error'] = 'network'
            elif change == 'status': evidence['response']['status'] = 'provider_limit'
            elif change == 'pages': evidence['response']['pagesFetched'] = 0
            else: evidence['response']['conversationsFetched'] = -1
            self.assertFalse(assert_scan_result(evidence)[0],change)
        cdp = MagicMock(); cdp.eval.return_value = {'error':'missing button'}
        self.assertFalse(assert_scan_result(CDPActions.trigger_deep_scan(cdp))[0])

    def test_click_without_bound_handler_does_not_pass(self):
        cdp = MagicMock(); cdp.eval.side_effect = [{'clicked':True},{'started':False},None]
        with patch('scripts.framework.actions.time.monotonic', side_effect=[0,0,4]):
            result = CDPActions.trigger_deep_scan(cdp,max_wait=3)
        self.assertFalse(assert_scan_result(result)[0])

    def test_all_matched_titles_must_upgrade(self):
        cdp = MagicMock()
        first = {'key':{'conversationId':CID},'title':'Online','titleSource':'provider'}
        second = {'key':{'conversationId':OTHER},'title':'Offline','titleSource':'derived'}
        with patch('scripts.framework.assertions.snapshot', return_value={'rows':[first,second]}):
            self.assertFalse(CDPAssertions.assert_title_upgraded(cdp,[CID,OTHER])[0])
            self.assertTrue(CDPAssertions.assert_title_upgraded(cdp,[CID])[0])
    def takeout_fixture(self):
        key = {'accountId': self.account, 'conversationId': CID}
        index = {'key': key, 'title': 'Prompt', 'titleSource': 'derived'}
        messages = [{'role': role, 'content': [{'type': 'paragraph', 'children': [{'type': 'text', 'text': text}]}]}
                    for role, text in [('user', 'Prompt'), ('assistant', 'Answer')]]
        detail = {'key': key, 'messages': messages, 'assets': [], 'quality': {'status': 'partial'}}
        source = {CID: {'index': {k: v for k, v in index.items() if k != 'key'},
                        'detail': {k: copy.deepcopy(v) for k, v in detail.items() if k != 'key'}}}
        return {'id': CID, 'ok': True, 'account': {'id': self.account, 'providerId': 'gemini', 'providerAccountId':'gaia'},
                'summary': copy.deepcopy(index), 'domain': {'index': index, 'detail': detail}, 'resources': []}, source

    def validate_takeout(self, record, source, media=None):
        return validate_takeout_records([CID], media or {}, [record], source, self.account)[0]

    def test_takeout_activity_time_is_current_schema_without_an_online_version(self):
        record, source = self.takeout_fixture()
        record['domain']['index']['activityAt'] = 1788374039661
        record['summary']['activityAt'] = 1788374039661
        self.assertTrue(self.validate_takeout(record, source))
        self.assertNotIn('updatedAt', record['domain']['index'])
        for invalid in ('yesterday', float('nan'), True):
            record['domain']['index']['activityAt'] = invalid
            record['summary']['activityAt'] = invalid
            self.assertFalse(self.validate_takeout(record, source))

    def test_takeout_current_keys_and_readable_asset_bytes_required(self):
        record, source = self.takeout_fixture()
        asset = {'id':'image', 'kind':'image', 'sourceUri':'Takeout/image.png'}
        record['domain']['detail']['assets'] = [asset]
        record['resources'] = [{'assetId':'image', 'sourcePath':'Takeout/image.png', 'bytes':base64.b64encode(b'image bytes').decode()}]
        media = {'Takeout/image.png': hashlib.sha256(b'image bytes').hexdigest()}
        self.assertTrue(self.validate_takeout(record, source, media))
        self.assertFalse(validate_takeout_records([CID], media, [], source, self.account)[0])
        for change in ('detail-key','index-key','account','resources','bytes','asset-id','summary','messages','old-index','old-message','old-asset','empty-generation','old-generation'):
            broken = copy.deepcopy(record)
            if change == 'detail-key': broken['domain']['detail']['key'] = {'accountId':self.account,'conversationId':OTHER}
            if change == 'index-key': broken['domain']['index']['key'] = {'accountId':'u0','conversationId':CID}
            if change == 'account': broken['account']['id'] = 'u0'
            if change == 'resources': broken['resources'] = []
            if change == 'bytes': broken['resources'][0]['bytes'] = ''
            if change == 'asset-id': broken['resources'][0]['assetId'] = 'unrelated'
            if change == 'summary': broken['summary'] = {'title':'Prompt','hasTakeoutImport':True}
            if change == 'messages': broken['domain']['detail']['messages'] = []
            if change == 'old-index': broken['domain']['index']['titleSource'] = 'takeout'
            if change == 'old-message': broken['domain']['detail']['messages'][1]['generation'] = {'mediaKind':'image','outputCount':1}
            if change == 'old-asset': broken['domain']['detail']['assets'][0]['localName'] = 'export.png'
            if change == 'empty-generation': broken['domain']['detail']['assets'][0]['generation'] = {}
            if change == 'old-generation': broken['domain']['detail']['assets'][0]['generation'] = {'mediaKind':'image','outputCount':1}
            self.assertFalse(self.validate_takeout(broken, source, media), change)
        self.assertFalse(validate_takeout_records([CID], media, [record,record], source, self.account)[0])
        self.assertFalse(self.validate_takeout(record, {}, media))

    def test_takeout_image_reply_uses_current_asset_relationship_not_message_generation(self):
        record, source = self.takeout_fixture()
        detail = record['domain']['detail']
        detail['messages'][1]['content'] = []
        detail['messages'][1]['generation'] = {'mediaKind':'image','outputCount':1}
        self.assertFalse(self.validate_takeout(record,source))
        del detail['messages'][1]['generation']
        detail['assets'] = [{'id':'image','kind':'image','generation':{'imageCount':1,'prompt':'Draw'}}]
        self.assertFalse(self.validate_takeout(record,source), 'metadata does not prove an owned reply')
        detail['messages'][1]['attachmentIds'] = ['image']
        self.assertTrue(self.validate_takeout(record,source))
        detail['messages'][1]['attachmentIds'] = ['foreign']
        self.assertFalse(self.validate_takeout(record,source))

    def test_takeout_empty_source_assistant_does_not_require_invented_content(self):
        record, source = self.takeout_fixture()
        source[CID]['detail']['messages'][1]['content'] = []
        record['domain']['detail']['messages'][1]['content'] = []
        self.assertTrue(self.validate_takeout(record, source))
        # Authored source content must still survive the import.
        source[CID]['detail']['messages'][1]['content'] = [{'type': 'paragraph', 'children': [{'type': 'text', 'text': 'Known answer'}]}]
        self.assertFalse(self.validate_takeout(record, source))
        source[CID]['detail']['messages'][1]['content'] = [{'type': 'image', 'assetId': 'lost-image'}]
        source[CID]['detail']['assets'] = [{'id': 'lost-image', 'kind': 'image'}]
        self.assertFalse(self.validate_takeout(record, source))

    def test_takeout_unresolved_generation_notice_does_not_invent_assistant_message(self):
        record, source = self.takeout_fixture()
        source[CID]['detail']['messages'] = source[CID]['detail']['messages'][:1]
        record['domain']['detail']['messages'] = record['domain']['detail']['messages'][:1]
        self.assertTrue(self.validate_takeout(record,source))
        source[CID]['detail']['messages'] = []
        self.assertFalse(self.validate_takeout(record,source))

    def test_takeout_action_reads_current_localized_completion_status_without_hiding_failure(self):
        with tempfile.NamedTemporaryFile(suffix='.zip') as archive:
            for status, expected in [('Imported 6 conversations (ok)', 'ok'),
                                     ('Imported 6 conversations (partial)', 'partial'),
                                     ('已提交 6 条对话（完成）', 'ok'),
                                     ('已提交 6 条对话（部分完成）', 'partial'),
                                     ('已提交 6 条对话（未知）', None), ('Import failed', None)]:
                with self.subTest(status=status), patch('scripts.framework.actions.install_probe'):
                    cdp = MagicMock()
                    cdp.eval.side_effect = [True, {'busy': False, 'status': status},
                                            {'ids': [], 'mediaDigests': {}, 'resources': {}, 'sourceFacts': {}}]
                    result = CDPActions.import_takeout_zip(cdp, archive.name)
                    self.assertEqual(result['success'], expected is not None)
                    if expected:
                        self.assertEqual((result['imported'], result['status']), (6, expected))
                    else:
                        self.assertEqual(result['error'], status)

    def test_takeout_case_checks_current_import_result_and_preserves_account(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'takeout.zip'
            with zipfile.ZipFile(path, 'w') as zf:
                zf.writestr('Takeout/MyActivity.html', f'<a href="https://gemini.google.com/app/{CID}">Chat</a>')
            ctx = MagicMock(takeout_zip=str(path)); ctx.shared_data = {}
            cdp = ctx.connect_options.return_value
            record, source = self.takeout_fixture()
            cdp.eval.return_value = [record]
            result = {'success':True,'importedIds':[CID],'status':'partial','imported':1,'sourceFacts':source}
            with patch.object(CDPActions,'import_takeout_zip',return_value=result), \
                 patch('scripts.framework.cases.takeout.snapshot',return_value={'accountId':self.account}):
                self.assertTrue(TakeoutZipImportCase().execute(ctx)[0])
                result['imported'] = 0
                self.assertFalse(TakeoutZipImportCase().execute(ctx)[0])
                result['imported'] = 1; cdp.eval.return_value = []
                self.assertFalse(TakeoutZipImportCase().execute(ctx)[0])
            cdp.eval.return_value = [record]
            with patch.object(CDPActions,'import_takeout_zip',return_value=result), \
                 patch('scripts.framework.cases.takeout.snapshot',side_effect=[{'accountId':self.account},{'accountId':'other'}]):
                self.assertFalse(TakeoutZipImportCase().execute(ctx)[0])

    def test_coverage_activity_time_is_independent_of_optional_index_time(self):
        baseline,before,scan,after = self.activity_fixture()
        after['coverage']['range']['head']['time'] = 101
        self.assertTrue(assert_activity_sync_result(baseline,before,scan,after,[CID,OTHER])[0])
        after['rows'][0] = {'id':CID,'title':'Old flat row','titleSource':'rpc','updatedAt':120}
        self.assertFalse(assert_activity_sync_result(baseline,before,scan,after,[CID,OTHER])[0])

    def test_confirmed_deletion_requires_same_account_removal_and_ui_notification(self):
        key = {'accountId':self.account,'conversationId':CID}
        result = {'sameAccount':True,'removed':True,'othersRetained':True,'inDom':False}
        cdp = MagicMock()
        cdp.eval.side_effect = lambda script, **kw: True if script == '!!globalThis.__tier2V2' else result
        with patch('scripts.framework.assertions.time.sleep'):
            self.assertTrue(CDPAssertions.assert_confirmed_deleted(cdp,key,[OTHER],timeout=.001)[0])
            for field in ('sameAccount','removed','othersRetained','inDom'):
                result[field] = not result[field]
                self.assertFalse(CDPAssertions.assert_confirmed_deleted(cdp,key,[OTHER],timeout=.001)[0],field)
                result[field] = not result[field]
        self.assertIn('storedConversation(key)',cdp.eval.call_args.args[0])
        self.assertIn(self.account,cdp.eval.call_args.args[0])


class ImageOutcomeTests(unittest.TestCase):
    def pixels(self, value=100, width=1024, height=512):
        return {'width': width, 'height': height, 'pixels': [value] * (64 * 64 * 3)}

    def test_loaded_blob_is_read_from_displayed_element_without_refetch(self):
        cdp = MagicMock()
        cdp.eval.side_effect = [{'chatId': CID, 'images': [{'turn': 1, 'src': 'blob:revoked', 'loaded': True}]}, self.pixels()]
        result = capture_webpage_images(cdp, CID)
        self.assertEqual(result, [dict(turn=1, **self.pixels())])
        self.assertNotIn('fetch(', cdp.eval.call_args.args[0])

    def test_broken_target_image_refreshes_page_once_and_still_requires_pixels(self):
        cdp = MagicMock()
        broken = {'chatId': CID, 'images': [{'turn': 0, 'src': 'blob:broken', 'failed': True}]}
        loaded = {'chatId': CID, 'images': [{'turn': 0, 'src': 'blob:loaded', 'loaded': True}]}
        cdp.eval.side_effect = [broken, loaded, self.pixels()]
        with patch('scripts.framework.image_evidence.time.sleep'):
            self.assertEqual(capture_webpage_images(cdp, CID), [dict(turn=0, **self.pixels())])
        self.assertEqual([call.args for call in cdp.call.call_args_list if call.args[0] == 'Page.reload'],
                         [('Page.reload', {'ignoreCache': True})])

    def test_persistently_broken_image_fails_after_one_refresh(self):
        cdp = MagicMock()
        cdp.eval.return_value = {'chatId': CID, 'images': [{'turn': 0, 'src': 'blob:broken', 'failed': True}]}
        with patch('scripts.framework.image_evidence.time.monotonic', side_effect=[0, 0, .5, 2]), \
             patch('scripts.framework.image_evidence.time.sleep'):
            with self.assertRaises(ValueError): capture_webpage_images(cdp, CID, timeout=1)
        self.assertEqual(sum(call.args[0] == 'Page.reload' for call in cdp.call.call_args_list), 1)
        self.assertEqual(cdp.eval.call_count, 2)

    def test_remote_pixels_come_from_browser_resource_cache(self):
        cdp = MagicMock()
        cdp.eval.return_value = {'chatId': CID, 'images': [{'turn': 0, 'src': 'https://example.com/image.jpg', 'loaded': True}]}
        cdp.call.side_effect = [{}, {'result': {'frameTree': {'frame': {'id': 'frame'}}}},
                                {'result': {'base64Encoded': True, 'content': base64.b64encode(b'cached image').decode()}}]
        with patch('scripts.framework.image_evidence.image_pixels', return_value=self.pixels()) as decode:
            self.assertEqual(capture_webpage_images(cdp, CID)[0]['turn'], 0)
        decode.assert_called_once_with(cdp, b'cached image', 'application/octet-stream')

    def test_other_chat_or_unloaded_image_cannot_supply_pixel_evidence(self):
        for chat_id, loaded in ((OTHER, True), (CID, False)):
            cdp = MagicMock(); cdp.eval.return_value = {
                'chatId': chat_id, 'images': [{'turn': 0, 'src': 'blob:image', 'loaded': loaded}]}
            with patch('scripts.framework.image_evidence.time.monotonic', side_effect=[0, 0, 2]), \
                 patch('scripts.framework.image_evidence.time.sleep'):
                with self.assertRaises(ValueError): capture_webpage_images(cdp, CID, timeout=1)
            self.assertEqual(cdp.call.call_count, 1)  # Page.enable only; never decode foreign/incomplete images.

    def test_preview_and_original_may_differ_in_size_and_compression(self):
        with patch('scripts.framework.image_evidence.image_pixels', return_value=self.pixels(101, 2048, 1024)):
            errors = assert_image_files(None, [self.pixels()], [('image.jpg', b'original')])
        self.assertLess(errors[0], .01)

    def test_wrong_picture_or_aspect_ratio_and_missing_extra_images_fail(self):
        for actual, entries in ((self.pixels(200), [('a.png', b'wrong')]),
                                (self.pixels(100, 500, 500), [('a.png', b'wrong')]),
                                (self.pixels(), []),
                                (self.pixels(), [('a.png', b'one'), ('b.png', b'extra')])):
            with self.subTest(entries=entries), patch('scripts.framework.image_evidence.image_pixels', return_value=actual):
                with self.assertRaises(ValueError):
                    assert_image_files(None, [self.pixels()], entries)

    def test_same_file_cannot_satisfy_two_different_web_images(self):
        with patch('scripts.framework.image_evidence.image_pixels', return_value=self.pixels(100)):
            with self.assertRaises(ValueError):
                assert_image_files(None, [self.pixels(100), self.pixels(200)],
                                   [('a.png', b'duplicate'), ('b.png', b'duplicate')])

    def test_image_order_matches_webpage_order(self):
        with patch('scripts.framework.image_evidence.image_pixels', side_effect=[self.pixels(200), self.pixels(100)]):
            with self.assertRaises(ValueError):
                assert_image_files(None, [self.pixels(100), self.pixels(200)],
                                   [('second.png', b'second'), ('first.png', b'first')])

    def test_corrupt_or_undecodable_image_fails(self):
        cdp = MagicMock(); cdp.eval.return_value = None
        with self.assertRaises(ValueError): image_pixels(cdp, b'not an image', 'image/png')

    def archive_check(self, body, evidence, asset=True, cid=CID):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'export.zip'
            with zipfile.ZipFile(archive, 'w') as zf:
                zf.writestr(f'gemini_export/Chat_{CID[-6:]}.md', document(body, cid))
                if asset: zf.writestr('gemini_export/assets/image.png', b'physical bytes')
            with patch('scripts.framework.image_evidence.image_pixels', return_value=self.pixels()):
                return assert_zip_images(None, archive, CID, evidence)

    def test_physical_zip_requires_per_turn_image_references_files_and_identity(self):
        body = [{'prompt': 'One', 'response': '![Image](assets/image.png)'}]
        evidence = [{'images': [self.pixels()]}]
        self.assertEqual(self.archive_check(body, evidence), [0])
        for changed, asset, cid in (([{'prompt': 'One', 'response': '[File](assets/image.png)'}], True, CID),
                                    (body, False, CID), (body, True, OTHER),
                                    ([{'prompt': 'One', 'response': '![Image](https://example.com/a.png)'}], True, CID)):
            with self.subTest(changed=changed, asset=asset, cid=cid):
                with self.assertRaises((ValueError, KeyError)):
                    self.archive_check(changed, evidence, asset, cid)

    def test_image_in_wrong_reply_or_missing_reply_is_rejected(self):
        body = [{'prompt': 'One', 'response': 'No image'},
                {'prompt': 'Two', 'response': '![Image](assets/image.png)'}]
        evidence = [{'images': [self.pixels()]}, {'images': []}]
        with self.assertRaises(ValueError): self.archive_check(body, evidence)
        with self.assertRaises(ValueError): self.archive_check(body[:1], evidence)

    def test_live_disk_images_require_independent_pixels_and_decoder(self):
        evidence = [{'prompt': 'One', 'response': '', 'has_images': True, 'images': [self.pixels()]}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'assets').mkdir()
            (root/'assets/image.png').write_bytes(b'physical bytes')
            (root/f'Chat_{CID[-6:]}.md').write_text(document([{'prompt': 'One', 'response': '![Image](assets/image.png)'}]))
            def check(turns, decoder):
                return CDPAssertions.assert_real_disk_live_save(directory, [CID], turn_evidence={CID: turns}, image_cdp=decoder)[0]
            with patch('scripts.framework.image_evidence.image_pixels', return_value=self.pixels()):
                self.assertTrue(check(evidence, MagicMock()))
                self.assertFalse(check(evidence, None))
                self.assertFalse(check([{**evidence[0], 'images': []}], MagicMock()))
            with patch('scripts.framework.image_evidence.image_pixels', return_value=self.pixels(200)):
                self.assertFalse(check(evidence, MagicMock()))


class V2SingleConversationDeliveryTests(unittest.TestCase):
    """v2 physically delivers a bare .md unless other files require a ZIP."""

    def test_initial_baseline_accepts_standalone_md_and_zip_with_assets(self):
        content = document(cid=CID)
        with tempfile.TemporaryDirectory() as directory:
            for suffix in ('.md', '.zip'):
                with self.subTest(delivery=suffix):
                    path = Path(directory) / f'Chat_{CID[-6:]}{suffix}'
                    if suffix == '.zip':
                        with zipfile.ZipFile(path, 'w') as archive:
                            archive.writestr(f'Chat_{CID[-6:]}.md', content)
                            archive.writestr('assets/photo.png', b'original photo')
                    else:
                        path.write_text(content, encoding='utf-8')
                    baseline = read_initial_export_markdown(str(path), 'c_' + CID)
                    self.assertEqual(baseline, content)
                    self.assertTrue(assert_turn_content(baseline, EVIDENCE)[0])

    def test_initial_baseline_rejects_wrong_target_and_missing_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            wrong_file = directory / f'Chat_{OTHER[-6:]}.md'
            wrong_file.write_text(document(cid=CID), encoding='utf-8')
            with self.assertRaises(ValueError):
                read_initial_export_markdown(str(wrong_file), CID)
            mismatched_id = directory / f'Chat_{CID[-6:]}.md'
            mismatched_id.write_text(document(cid=OTHER), encoding='utf-8')
            with self.assertRaises(ValueError):
                read_initial_export_markdown(str(mismatched_id), CID)
            archive_path = directory / 'ambiguous.zip'
            with zipfile.ZipFile(archive_path, 'w') as archive:
                archive.writestr(f'first/Chat_{CID[-6:]}.md', document(cid=CID))
                archive.writestr(f'second/Chat_{CID[-6:]}.md', document(cid=CID))
            with self.assertRaises(ValueError):
                read_initial_export_markdown(str(archive_path), CID)
            unrelated = directory / 'unexpected.html'
            unrelated.write_text(document(cid=CID), encoding='utf-8')
            with self.assertRaises(ValueError):
                read_initial_export_markdown(str(unrelated), CID)


class CoverageTests(unittest.TestCase):
    def test_missing_required_scenario_is_not_consumed_as_generic(self):
        with tempfile.TemporaryDirectory() as directory:
            pool, archive = Path(directory) / 'pool.json', Path(directory) / 'archive.json'
            pool.write_text(json.dumps([{'id': 'text', 'features': ['code'], 'turns': ['one', 'two']}]))
            OnlineScenarioProvider.reset()
            provider = OnlineScenarioProvider(str(pool), str(archive))
            try:
                with self.assertRaises(RuntimeError): provider.pop_scenario(['imagen'])
                self.assertEqual(len(json.loads(pool.read_text())), 1)
                self.assertFalse(archive.exists())
            finally:
                OnlineScenarioProvider.reset()

    def test_scenarios_need_no_forced_modality_and_page_images_cannot_pass_export(self):
        ctx = TestContext(dataset=[{'turns': ['one', 'two']}, {'turns': ['one', 'two']}])
        self.assertEqual(len(ctx.ensure_scenarios()), 2)
        ctx.chat_records = [{'chat_id': CID, 'turn_evidence': [{'has_images': True}]}]
        self.assertFalse(ImagenMultimodalCase().execute(ctx)[0])

    def test_actual_turn_identity_is_bound_to_context(self):
        ctx = TestContext()
        record = {'chat_id': CID}
        with self.assertRaises(RuntimeError): ctx.record_turn(record, TurnResult(True, 'Prompt', REPLY, chat_id=OTHER))
        ctx.record_turn(record, TurnResult(True, 'Actual prompt', REPLY, chat_id=CID))
        self.assertEqual(record['turn_evidence'][0]['prompt'], 'Actual prompt')

    def test_export_zip_must_contain_required_ids_and_exclude_exported(self):
        self.assertTrue(assert_archive_targets([f'Chat_{CID[-6:]}.html'], [CID], '.html')[0])
        self.assertFalse(assert_archive_targets([f'Chat_{OTHER[-6:]}.html'], [CID], '.html')[0])
        self.assertFalse(assert_archive_targets([f'Chat_{CID[-6:]}.md', f'Old_{OTHER[-6:]}.md'], [CID], '.md', [OTHER])[0])
        self.assertTrue(assert_archive_targets([f'Chat_{CID[-6:]}.md', 'files/report.md',
                                               f'files/attachment_{OTHER[-6:]}.md'], [CID], '.md', [OTHER])[0])
        self.assertFalse(assert_archive_targets([f'files/Chat_{CID[-6:]}.md'], [CID], '.md')[0])

    def test_missing_format_target_fails_before_download(self):
        ctx = MagicMock()
        ctx.chat_records = [{'chat_id': CID}]
        ctx.connect_options.return_value.eval.return_value = {'matched': [OTHER], 'missing': [CID]}
        with patch.object(CDPActions, 'wait_for_export_idle', return_value=True), \
             patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}):
            with self.assertRaises(RuntimeError): select_format_targets(ctx.connect_options(), ctx, 'html')

    def test_html_and_pdf_cases_reject_wrong_archive_targets(self):
        for case, extension in ((HtmlExportDownloadCase(), '.html'), (PdfExportDownloadCase(), '.pdf')):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'export.zip'
                with zipfile.ZipFile(path, 'w') as zf: zf.writestr(f'Wrong_{OTHER[-6:]}{extension}', 'nonempty content')
                ctx = MagicMock(output_dir=directory)
                ctx.chat_records = [{'chat_id': CID}]
                with patch('scripts.framework.cases.export.select_format_targets', return_value={'matched': [CID]}), \
                     patch.object(CDPActions, 'trigger_export_zip', return_value=str(path)), \
                     patch.object(CDPActions, 'clear_search_workbench'):
                    self.assertFalse(case.execute(ctx)[0])

    def test_html_pdf_restore_markdown_format_on_failure(self):
        # FAIL 路径也必须走 finally 恢复默认 markdown，避免污染后序用例的格式状态
        for case, extension in ((HtmlExportDownloadCase(), '.html'), (PdfExportDownloadCase(), '.pdf')):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'export.zip'
                with zipfile.ZipFile(path, 'w') as zf: zf.writestr(f'Wrong_{OTHER[-6:]}{extension}', 'nonempty content')
                ctx = MagicMock(output_dir=directory)
                ctx.chat_records = [{'chat_id': CID}]
                cdp = ctx.connect_options.return_value
                with patch('scripts.framework.cases.export.select_format_targets', return_value={'matched': [CID]}), \
                     patch.object(CDPActions, 'trigger_export_zip', return_value=str(path)), \
                     patch.object(CDPActions, 'clear_search_workbench'):
                    self.assertFalse(case.execute(ctx)[0])
                scripts = [str(call.args[0]) for call in cdp.eval.call_args_list]
                self.assertTrue(any('markdown' in s for s in scripts),
                                f"{extension} FAIL 后必须恢复 markdown 格式")

    def test_zip_export_resets_skip_exported_switch(self):
        # 与 FastSkip 解耦后，ZIP 用例启动时必须关闭残留 skip 开关（脚本级断言，不跑真实导出）
        from scripts.framework.cases.export import ZipExportDownloadCase
        with tempfile.TemporaryDirectory() as directory:
            ctx = MagicMock(output_dir=directory)
            ctx.chat_records = []
            cdp = ctx.connect_options.return_value
            cdp.eval.return_value = {}
            with patch.object(CDPActions, 'wait_for_export_idle', return_value=True), \
                 patch.object(CDPActions, 'clear_search_workbench'), \
                 patch.object(CDPActions, 'trigger_export_zip'):
                ZipExportDownloadCase().execute(ctx)
            scripts = [str(call.args[0]) for call in cdp.eval.call_args_list]
            self.assertTrue(any('skipExported' in s and 'checked = false' in s for s in scripts),
                            "ZIP 启动时必须显式关闭 skipExported")

    def test_partial_skip_requires_both_states_and_exact_zip_contents(self):
        for partial, zip_ids, expected in (({'exportedId': OTHER}, [CID], False),
                                         ({'exportedId': OTHER, 'unexportedId': CID, 'unexportedSourceVerified': False}, [CID], False),
                                         ({'exportedId': OTHER, 'unexportedId': CID, 'unexportedSourceVerified': True}, [CID, OTHER], False),
                                         ({'exportedId': OTHER, 'unexportedId': CID, 'unexportedSourceVerified': True}, [CID], True)):
            with self.subTest(partial=partial, zip_ids=zip_ids), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'partial.zip'
                with zipfile.ZipFile(path, 'w') as zf:
                    for cid in zip_ids: zf.writestr(f'Chat_{cid[-6:]}.md', document(cid=cid))
                ctx = MagicMock(output_dir=directory)
                ctx.connect_options.return_value.eval.side_effect = [
                    {'count': 6, 'log': 'old'}, True, {'busy': False, 'log': 'Delivery initiated: 0; Skipped: 6; Conversation export failed: 0'}, partial]
                with patch('scripts.framework.cases.export.install_probe'), \
                     patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}), \
                     patch.object(CDPActions, 'clear_search_workbench'), \
                     patch.object(CDPActions, 'trigger_export_zip', return_value=str(path)):
                    self.assertEqual(FastSkipExportedCase().execute(ctx)[0], expected)

    def test_all_skipped_rejects_any_unexpected_physical_download(self):
        for extension in ('.md', '.zip', '.html', '.pdf'):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as directory:
                ctx = MagicMock(output_dir=directory)
                cdp = ctx.connect_options.return_value
                unexpected = Path(directory) / ('unexpected' + extension)

                def respond(script, **_kwargs):
                    if 'const exported = items.filter' in script:
                        return {'count': 6, 'log': 'before'}
                    if 'btn.click()' in script:
                        return True
                    if 'busy: !!document.getElementById' in script:
                        unexpected.write_bytes(b'export must not run')
                        return {'busy': False, 'log':
                                'Delivery initiated: 0; Skipped: 6; Conversation export failed: 0'}
                    raise AssertionError('Full-skip test continued into partial export')

                cdp.eval.side_effect = respond
                with patch('scripts.framework.cases.export.install_probe'), \
                     patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}), \
                     patch.object(CDPActions, 'clear_search_workbench'):
                    ok, message, _ = FastSkipExportedCase().execute(ctx)
                self.assertFalse(ok)
                self.assertIn('全量跳过异常生成文件', message)
                self.assertIn(unexpected.name, message)

    def test_all_skipped_current_chinese_summary_advances_to_partial_export(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = MagicMock(output_dir=directory)
            ctx.connect_options.return_value.eval.side_effect = [
                {'count': 6, 'log': 'old'}, True,
                {'busy': False, 'log': '成功下载 0 条会话; 跳过 6'},
                {'exportedId': OTHER}]
            with patch('scripts.framework.cases.export.install_probe'), \
                 patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}), \
                 patch.object(CDPActions, 'clear_search_workbench'):
                ok, message, _ = FastSkipExportedCase().execute(ctx)
            self.assertFalse(ok)
            self.assertIn('部分跳过需要', message, 'current Chinese summary must complete the all-skipped stage')

    def test_all_skipped_does_not_accept_stale_summary_or_partial_delivery(self):
        for previous, current in (
            ('Delivery initiated: 0; Skipped: 6; Conversation export failed: 0',
             'Delivery initiated: 0; Skipped: 6; Conversation export failed: 0'),
            ('old', 'Delivery initiated: 0; Other incomplete conversations: 1; Skipped: 6; Conversation export failed: 0'),
            ('old', 'Delivery initiated: 0; Skipped: 6; Conversation export failed: 0; Cancelled'),
        ):
            with self.subTest(current=current), tempfile.TemporaryDirectory() as directory:
                ctx = MagicMock(output_dir=directory)
                ctx.connect_options.return_value.eval.side_effect = [
                    {'count': 6, 'log': previous}, True, {'busy': False, 'log': current}]
                with patch('scripts.framework.cases.export.install_probe'), \
                     patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}), \
                     patch.object(CDPActions, 'clear_search_workbench'), \
                     patch('scripts.framework.cases.export.time.monotonic', side_effect=[0, 0, 7, 7]), \
                     patch('scripts.framework.cases.export.time.sleep'):
                    ok, message, _ = FastSkipExportedCase().execute(ctx)
                self.assertFalse(ok)
                self.assertIn('没有本次导出', message)

    def test_all_skipped_probe_rejects_zero_skips_and_failed_exports(self):
        for result in ('Delivery initiated: 0; Skipped: 0; Conversation export failed: 0',
                       'Delivery initiated: 0; Skipped: 5; Conversation export failed: 1'):
            with tempfile.TemporaryDirectory() as directory:
                ctx = MagicMock(output_dir=directory)
                ctx.connect_options.return_value.eval.side_effect = [
                    {'count':6,'log':'old'},True,{'busy':False,'log':result}]
                with patch('scripts.framework.cases.export.install_probe'), \
                     patch('scripts.framework.actions.ExtensionActions.configure_export_controls', return_value={'ok': True}), \
                     patch.object(CDPActions,'clear_search_workbench'):
                    self.assertFalse(FastSkipExportedCase().execute(ctx)[0])

    def test_report_never_calls_skip_or_noncritical_failure_all_passed(self):
        registry = FeatureRegistry()
        for feature in registry.all_features(): registry.record_result(feature.id, TestStatus.PASS)
        self.assertIn('ALL PASSED', registry.generate_matrix_report())
        registry.record_result('feat_uninstall_lifecycle', TestStatus.SKIP)
        self.assertNotIn('ALL PASSED', registry.generate_matrix_report())
        registry.record_result('feat_uninstall_lifecycle', TestStatus.FAIL)
        self.assertNotIn('ALL PASSED', registry.generate_matrix_report())

    def test_critical_failure_and_dependent_skip_fail_runner(self):
        class Case(FeatureTestCase):
            def execute(self, ctx): return False, 'Injected failure', None
        dag = DAGRunner()
        dag.register(Case('critical', FeatureDomain.TAKEOUT, 'critical', 'critical'))
        dag.register(Case('dependent', FeatureDomain.TAKEOUT, 'dependent', 'dependent', prerequisites=['critical']))
        ctx = TestContext()
        with patch('sys.stdout', new=io.StringIO()): self.assertFalse(dag.run(ctx))
        self.assertEqual(ctx.registry.get_result('dependent').status, TestStatus.SKIP)


class SearchSelectionCounterexamples(unittest.TestCase):
    """搜索/选择反向验证：错误命中、漏选、选中失败必须 FAIL（直接测断言输入输出）。"""

    def cdp(self, snapshot):
        cdp = MagicMock()
        cdp.eval.return_value = snapshot
        return cdp

    def snap(self, items):
        return {"visibleItems": items}

    def item(self, cid, title):
        return {"id": cid, "title": title}

    def test_keyword_mode_rejects_mismatch(self):
        bad = self.snap([self.item("aaa", "Python 性能优化指南"), self.item("bbb", "量子计算的基本原理")])
        ok, msg, _ = CDPAssertions.assert_search_filter(self.cdp(bad), "Python", timeout=0.2)
        self.assertFalse(ok, f"误匹配必须 FAIL: {msg}")
        good = self.snap([self.item("aaa", "Python 性能优化指南"), self.item("ccc", "Python 并发模型")])
        self.assertTrue(CDPAssertions.assert_search_filter(self.cdp(good), "Python", timeout=0.2)[0])
        self.assertFalse(CDPAssertions.assert_search_filter(self.cdp(self.snap([])), "Python", timeout=0.2)[0])

    def test_id_set_mode_rejects_wrong_extra_missing(self):
        cases = [
            ([self.item(OTHER, "t " + CID)], False),  # 错误 ID
            ([self.item(CID, "t " + CID), self.item(OTHER, "t " + CID + " collision")], False),  # 额外命中
            ([], False),  # 遗漏结果
            ([self.item(CID, "t " + CID)], True),  # 正确唯一命中
            ([self.item("c_" + CID, "t " + CID)], True),  # c_ 前缀归一化后一致
        ]
        for i, (items, expected) in enumerate(cases):
            with self.subTest(i=i):
                got = CDPAssertions.assert_search_filter(
                    self.cdp(self.snap(items)), CID, expected_ids=[CID], timeout=0.2)[0]
                self.assertEqual(got, expected)

    def test_id_set_mode_ignores_order(self):
        ids = [CID, OTHER]
        snap = self.snap([self.item(OTHER, "t"), self.item(CID, "t")])
        self.assertTrue(
            CDPAssertions.assert_search_filter(self.cdp(snap), CID, expected_ids=list(reversed(ids)), timeout=0.2)[0])

    def test_id_set_mode_rejects_duplicate_ids(self):
        dup_visible = self.snap([self.item(CID, "t"), self.item(CID, "t")])
        self.assertFalse(
            CDPAssertions.assert_search_filter(self.cdp(dup_visible), CID, expected_ids=[CID], timeout=0.2)[0])
        self.assertFalse(
            CDPAssertions.assert_search_filter(
                self.cdp(self.snap([self.item(CID, "t")])), CID, expected_ids=[CID, CID], timeout=0.2)[0])

    def run_search_id(self, visible_items, select_ret, is_checked):
        from scripts.framework.cases.workbench import SearchIdCase
        cdp = MagicMock()

        def dispatch(script, *a, **k):
            text = str(script)
            if "visibleItems" in text:
                return dict(self.snap(visible_items))
            if "input[type=checkbox]:checked" in text:
                return is_checked
            if "dataset.chatId" in text:
                return CID
            return None
        cdp.eval.side_effect = dispatch
        ctx = MagicMock()
        ctx.shared_data = {}
        ctx.connect_options.return_value = cdp
        with patch.object(CDPActions, "search_workbench", return_value=1), \
             patch.object(CDPActions, "select_workbench_item", return_value=select_ret):
            return SearchIdCase().execute(ctx)

    def test_search_id_case_rejects_failed_selection(self):
        good = [self.item(CID, "t " + CID)]
        self.assertFalse(self.run_search_id(good, False, True)[0])  # 勾选操作失败
        self.assertFalse(self.run_search_id(good, True, False)[0])  # 实际未选中
        self.assertFalse(self.run_search_id([self.item(OTHER, "t " + CID)], True, True)[0])  # 错误命中
        self.assertTrue(self.run_search_id(good, True, True)[0])

    def run_selection(self, none_snapshot, all_snapshot):
        from scripts.framework.cases.workbench import SelectionControlsCase
        ctx = MagicMock()
        ctx.connect_options.return_value = MagicMock()
        with patch.object(CDPActions, "clear_search_workbench", return_value=3), \
             patch.object(CDPActions, "toggle_select_none", return_value=None), \
             patch.object(CDPActions, "toggle_select_all", return_value=None), \
             patch.object(CDPAssertions, "assert_selection_state", side_effect=[none_snapshot, all_snapshot]):
            return SelectionControlsCase().execute(ctx)

    def sel(self, selectable, selected):
        return {"selectable": selectable, "selected": selected}

    def test_selection_controls_rejects_partial_and_residue(self):
        full = self.sel(["a", "b", "c"], ["a", "b", "c"])
        # 全选漏选 → FAIL；取消残留 → FAIL；正确 → PASS
        self.assertFalse(self.run_selection(
            self.sel(["a", "b", "c"], []), self.sel(["a", "b", "c"], ["a", "b"]))[0])
        self.assertFalse(self.run_selection(
            self.sel(["a", "b", "c"], ["a"]), full)[0])
        self.assertTrue(self.run_selection(self.sel(["a", "b", "c"], []), full)[0])
        # 全选后列表为空（可选集合为空）→ FAIL，杜绝空集恒等误通过
        self.assertFalse(self.run_selection(
            self.sel(["a", "b", "c"], []), self.sel([], []))[0])
        # 禁用项不参与：可选集之外的禁用已选项不影响判定
        self.assertTrue(self.run_selection(
            self.sel(["a", "b"], []), self.sel(["a", "b"], ["a", "b"]))[0])


class GeminiDualParseTests(unittest.TestCase):
    def test_capture_requires_install_and_restores_after_read_failure(self):
        from scripts.framework.gemini_dual_parse import install_capture, finish_capture
        cdp = MagicMock(); cdp.eval.return_value = None
        with self.assertRaises(RuntimeError): install_capture(cdp)
        cdp.eval.return_value = True; install_capture(cdp)
        cdp.eval.side_effect = [RuntimeError('connection lost'),True]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError,'connection lost'): finish_capture(cdp,Path(directory)/'native',[CID])
        self.assertIn('window.fetch = state.original',cdp.eval.call_args.args[0])

    def test_capture_keeps_raw_pages_and_rejects_missing_or_failed_targets(self):
        from scripts.framework.gemini_dual_parse import finish_capture
        pages = [{'requestCursor':None,'text':'exact raw framing'}]
        cdp = MagicMock(); cdp.eval.side_effect = [{'replies':{CID:pages,OTHER:pages},'errors':[{'id':OTHER,'error':'read failed'}]},True]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)/'native'; root.mkdir(); (root/'stale.json').write_text('{}')
            result = finish_capture(cdp,root,[CID,OTHER])
            self.assertEqual(result['missingNative'],[OTHER])
            stored = json.loads((root/f'{CID}.json').read_text())
            self.assertEqual(stored['pages'],pages); self.assertEqual(stored['source'],'raw_rpc_pages')
            self.assertFalse((root/'stale.json').exists())
        self.assertIn('delete window.__geminiDualCapture',cdp.eval.call_args.args[0])

    def test_capture_forwards_original_fetch_promise_response_arguments_and_rejection(self):
        from scripts.framework.gemini_dual_parse import INSTALL_CAPTURE
        script = r"""
        const assert = require('node:assert/strict');
        const { requestGen: geminiDetailRequestGen } = require('./tests/fixtures/providers/geminiDetailRequest.js');
        global.window=global; global.location={href:'chrome-extension://test/options.html'};
        let promise; const seen=[];
        const original=function(...args){seen.push([this,args]);return promise=Promise.resolve(new Response('exact wire'));};
        global.fetch=original; assert.equal(eval(INSTALL),true);
        assert.throws(()=>eval(INSTALL),/already installed/);
        (async()=>{
            const input='https://gemini.google.com/_/BardChatUi/data/batchexecute';
            const init={method:'POST',body:geminiDetailRequestGen('G_TIER2_CAPTURE_NATIVE_REQUEST_01')};
            const returned=fetch(input,init); assert.equal(returned,promise);
            const response=await returned; assert.equal(await response.text(),'exact wire');
            await Promise.all(__geminiDualCapture.pending);
            assert.deepEqual(__geminiDualCapture.replies.target,[{requestCursor:null,text:'exact wire'}]);
            assert.equal(seen[0][0],global);assert.equal(seen[0][1][1],init);
            await fetch('https://example.com/other',init);
            assert.deepEqual(Object.keys(__geminiDualCapture.replies),['target']);
        })().catch(e=>{console.error(e);process.exitCode=1});
        """.replace('INSTALL',json.dumps(INSTALL_CAPTURE))
        result=subprocess.run(['node','-r','./tests/ts_register.js','-e',script],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_additional_case_is_registered_and_missing_or_mismatched_sources_fail(self):
        from scripts.framework.runner import FrameworkRunner
        from scripts.framework.cases.gemini_dual_parse import GeminiDualParseCase
        dag = FrameworkRunner._assemble_dag()
        self.assertIn('feat_gemini_dual_parse', dag.cases)
        case = GeminiDualParseCase()
        self.assertEqual(case.prerequisites, ['feat_zip_export_download'])
        ctx = MagicMock()
        ctx.shared_data = {}
        self.assertFalse(case.execute(ctx)[0])
        ctx.output_dir = '/tmp/dual-fixture'
        ctx.worktree_root = '/tmp/repo'
        ctx.shared_data = {'gemini_dual_capture': {'expected': [CID], 'missingNative': []}}
        counts = {'assistant': 1, 'match': 1, 'different': 0, 'structuredUnavailable': 0, 'errors': 0, 'incomplete': 0}
        summary = {'counts': counts, 'results': [{'conversationId': 'c_' + OTHER}]}
        with patch('scripts.framework.cases.gemini_dual_parse.run_check', return_value=(True, summary)):
            self.assertFalse(case.execute(ctx)[0])
        summary = {'counts': counts, 'results': [{'conversationId': 'c_' + CID}]}
        with patch('scripts.framework.cases.gemini_dual_parse.run_check', return_value=(True, summary)):
            self.assertTrue(case.execute(ctx)[0])
        with patch('scripts.framework.cases.gemini_dual_parse.run_check', return_value=(False, summary)):
            self.assertFalse(case.execute(ctx)[0])
        counts.update(match=0, different=1)
        from scripts.framework.features import TestStatus
        with patch('scripts.framework.cases.gemini_dual_parse.run_check', return_value=(False, summary)):
            completed, message, details = case.execute(ctx)
            self.assertTrue(completed)
            self.assertIn('不阻断', message)
            self.assertEqual(case.success_status(details), TestStatus.WARN)
        for defect in ('structuredUnavailable', 'errors', 'incomplete'):
            with self.subTest(defect=defect):
                counts[defect] = 1
                with patch('scripts.framework.cases.gemini_dual_parse.run_check', return_value=(False, summary)):
                    self.assertFalse(case.execute(ctx)[0])
                counts[defect] = 0



class Tier2AttachmentPresentationTests(unittest.TestCase):
    def test_file_card_labels_are_metadata_but_missing_assets_and_prose_still_fail(self):
        exported = document() + '\n[Generated theory](files/theory.tex)\n'
        self.assertTrue(assert_turn_content(exported, EVIDENCE)[0])
        self.assertFalse(assert_turn_content(document() + '\n[附件不可用: theory.tex]\n', EVIDENCE)[0])
        self.assertFalse(assert_turn_content(exported.replace(REPLY, 'Wrong answer.'), EVIDENCE)[0])
        inline = document().replace(REPLY, REPLY + ' [authored link](https://example.com/theory.tex)')
        self.assertFalse(assert_turn_content(inline, EVIDENCE)[0])


class Tier2LifecycleOrderingTests(unittest.TestCase):
    def test_initial_export_requires_both_physical_content_and_a_committed_record(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ('baseline_' + CID[-6:] + '.md')
            path.write_text(document())
            with patch.object(CDPAssertions, 'assert_badge_status', return_value=(False, 'missing', {})):
                with self.assertRaisesRegex(RuntimeError, 'ExportRecord'):
                    read_verified_export_baseline(MagicMock(), str(path), CID, EVIDENCE)
            with patch.object(CDPAssertions, 'assert_badge_status', return_value=(True, 'committed', {})) as check:
                self.assertEqual(read_verified_export_baseline(MagicMock(), str(path), CID, EVIDENCE), document())
                self.assertEqual(check.call_args.args[1:], (CID, 'exported'))

    def test_destructive_fixture_reset_and_reinstall_follow_record_and_format_checks(self):
        from scripts.framework.runner import FrameworkRunner
        dag = FrameworkRunner._assemble_dag()
        order = [case.feature_id for case in dag.get_execution_order()]
        for before, after in (
            ('feat_live_auto_save_disk_write', 'feat_deep_scan_pagination'),
            ('feat_zip_export_download', 'feat_html_export_download'),
            ('feat_zip_export_download', 'feat_pdf_export_download'),
            ('feat_html_export_download', 'feat_stale_tab_image_export'),
            ('feat_pdf_export_download', 'feat_stale_tab_image_export'),
            ('feat_fast_skip_exported', 'feat_stale_tab_image_export'),
        ):
            self.assertLess(order.index(before), order.index(after), (before, after))


class ScenarioIdentityTests(unittest.TestCase):
    def check_prompt(self, exported, expected, evidence=None):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'export.zip'
            with zipfile.ZipFile(archive, 'w') as zf:
                zf.writestr('target_bbbbbb.md', '---\nid: targetbbbbbb\n---\n' + exported)
            scenario = {'title': 'target', 'chat_id': 'targetbbbbbb', 'turns': [expected]}
            if evidence is not None:
                scenario['turn_evidence'] = evidence
            with patch('scripts.framework.assertions.ExportSpecificationAsserter') as oracle:
                oracle.return_value.run_all_assertions.return_value = True
                return CDPAssertions.assert_exported_zip_spec(
                    str(archive), str(Path(directory) / 'extracted'), expected_scenarios=[scenario])

    def test_full_prompt_comparison_accepts_markdown_escaping_and_rejects_changed_numbers(self):
        prompt = 'For b=[6,12,3], characterize every solution.'
        exported = '## 👤 You\nFor b=\\[6,12,3\\], characterize every solution.\n## 🤖 Assistant\nAnswer.'
        self.assertTrue(self.check_prompt(exported, prompt)[0])
        self.assertFalse(self.check_prompt(exported.replace('12,3', '13,3'), prompt)[0])

    def test_scenario_prompt_must_be_in_the_user_turn_and_full_answer_must_match(self):
        prompt = 'A complete prompt with a distinct suffix.'
        exported = '## 👤 You\nA complete prompt with the wrong suffix.\n## 🤖 Assistant\n' + prompt
        self.assertFalse(self.check_prompt(exported, prompt)[0])
        exported = '## 👤 You\n' + prompt + '\n## 🤖 Assistant\nOnly the end.'
        evidence = [{'prompt': prompt, 'response': 'Essential middle evidence. Only the end.'}]
        self.assertFalse(self.check_prompt(exported, prompt, evidence)[0])

    def test_zip_assertion_never_matches_another_conversation_with_similar_prompts(self):
        import tempfile
        import zipfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'export.zip'
            with zipfile.ZipFile(archive, 'w') as zf:
                zf.writestr('unrelated_aaaaaa.md', '---\nid: otheraaaaaa\n---\nExpected prompt from current test')
                zf.writestr('target_bbbbbb.md', '---\nid: targetbbbbbb\n---\nDifferent actual prompt')
            ok, message, details = CDPAssertions.assert_exported_zip_spec(
                str(archive), str(Path(directory) / 'extracted'),
                expected_scenarios=[{'title': 'target', 'chat_id': 'targetbbbbbb',
                                     'turns': ['Expected prompt from current test']}])
            self.assertFalse(ok)
            self.assertIn('缺失轮次', message)
            self.assertEqual(details['missing'][0][0], 1)


class LongConversationGoldenContracts(unittest.TestCase):
    def check_golden(self, bodies):
        turns = [
            {'prompt': 'Initial question', 'response': 'Initial answer with essential middle evidence and a final conclusion.'},
            {'prompt': 'Middle question', 'response': 'Middle answer'},
            {'prompt': 'Final question', 'response': 'Final answer'},
        ]
        fixture = {'conversationId': CID, 'turns': turns}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / f'Long_{CID[-6:]}.md'
            path.write_text('id: '+CID+'\n'+bodies, encoding='utf-8')
            oracle = ExportSpecificationAsserter(folder)
            oracle.md_files = [str(path)]
            with patch('pathlib.Path.read_text', return_value=json.dumps(fixture)):
                oracle.assert_golden_conversations([{'id': CID, 'turn_evidence_fixture': 'long.json'}])
            return oracle.errors

    @staticmethod
    def markdown():
        return ('## 👤 You\nInitial question\n## 🤖 Assistant\n'
                'Initial answer with essential middle evidence and a final conclusion.\n'
                '## 👤 You\nMiddle question\n## 🤖 Assistant\nMiddle answer\n'
                '## 👤 You\nFinal question\n## 🤖 Assistant\nFinal answer\n')

    def test_complete_ordered_conversation_passes(self):
        self.assertEqual(self.check_golden(self.markdown()), [])

    def test_tail_only_and_missing_middle_round_fail(self):
        text = self.markdown()
        for damaged in (text[text.index('## 👤 You\nFinal'):],
                        text.replace('## 👤 You\nMiddle question\n## 🤖 Assistant\nMiddle answer\n', '')):
            with self.subTest(damaged=damaged):
                self.assertTrue(self.check_golden(damaged))

    def test_answer_middle_loss_fails_even_with_first_and_last_text(self):
        self.assertTrue(self.check_golden(self.markdown().replace('essential middle evidence and ', '')))

    def test_long_conversation_is_required_in_standard_targets(self):
        from scripts.framework.cases.export import DESIGNATED_HISTORICAL_CHATS
        target = next(chat for chat in DESIGNATED_HISTORICAL_CHATS if chat['id'] == 'a714229ffb19b514')
        self.assertFalse(target.get('optional', False))
        self.assertEqual(target['turn_evidence_fixture'], 'gemini_long_conversation.json')

    def test_frozen_webpage_evidence_covers_all_sixty_four_turns(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/gemini_long_conversation.json').read_text())
        self.assertEqual(fixture['conversationId'], 'a714229ffb19b514')
        self.assertEqual(len(fixture['turns']), 64)
        for turn in fixture['turns']:
            self.assertTrue(turn['prompt'].strip())
            self.assertTrue(turn['response'].strip())
            self.assertIsInstance(turn['code_blocks'], list)
            self.assertIsInstance(turn['execution_blocks'], list)

if __name__ == '__main__':
    unittest.main()
