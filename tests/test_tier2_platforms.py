"""Contract tests for plugin orchestration; no browser, network or scenario consumption."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.framework.platforms import load_plugins
from scripts.framework.platforms.core import (
    PlatformPlugins, PlatformSession, RunConfig, Tier2Runner, feature_spec, resolve_plan,
)
from scripts.framework.cases.base import DAGRunner, FeatureTestCase
from scripts.framework.features import FeatureDomain, FeatureRegistry


class Case(FeatureTestCase):
    def __init__(self, key, action, prerequisites=()):
        super().__init__(key, FeatureDomain.PAGE_CHAT, key, key, prerequisites=list(prerequisites))
        self.action = action

    def execute(self, ctx):
        return self.action(), 'test evidence', None


class Plugin:
    capabilities = ('chat',)
    accepted_options = ()

    def __init__(self, key, fail=False, prepare_fail=False, cleanup_fail=False):
        self.id, self.events = key, []
        self.fail, self.prepare_fail, self.cleanup_fail = fail, prepare_fail, cleanup_fail

    def dag(self):
        dag = DAGRunner()
        def first():
            self.events.append('first')
            return not self.fail
        def second():
            self.events.append('second')
            return True
        dag.register(Case('first', first))
        dag.register(Case('second', second, ('first',)))
        return dag

    def features(self):
        return [feature_spec(c) for c in self.dag().get_execution_order()]

    def open(self, config):
        self.config = config
        Path(config.output_dir).mkdir(parents=True, exist_ok=True)
        def prepare():
            self.events.append('prepare')
            if self.prepare_fail:
                raise RuntimeError('prepare failed')
        def close():
            self.events.append('close')
            if self.cleanup_fail:
                raise RuntimeError('cleanup failed')
        return PlatformSession(self.dag(), SimpleNamespace(registry=FeatureRegistry(standard=False)),
                               prepare, close, target_ids=['second'] if config.target_features else None)


class PlatformsTest(unittest.TestCase):
    def test_claude_evidence_identity_uses_canonical_uuids_before_browser_calls(self):
        from scripts.framework.claude_live import ClaudeLiveRunner
        runner = object.__new__(ClaudeLiveRunner)
        runner.rate_limited = False
        runner.org = '11111111-1111-4111-8111-111111111111'
        runner.chat = Mock()
        for invalid in ('-' * 36, '111111111-111-4111-8111-111111111111'):
            with self.assertRaisesRegex(ValueError, 'Invalid Claude evidence identity'):
                runner.source(invalid)
        runner.org = '-' * 36
        with self.assertRaisesRegex(ValueError, 'Invalid Claude evidence identity'):
            runner.source('22222222-2222-4222-8222-222222222222')
        runner.chat.call.assert_not_called()

    def test_chatgpt_account_detail_check_follows_physical_hydration(self):
        from scripts.framework.platforms.chatgpt import build_dag
        order = [case.feature_id for case in build_dag().get_execution_order()]
        self.assertLess(order.index('initial_export_baseline'), order.index('account_boundary'))


    def test_native_conversation_load_error_does_not_reload(self):
        from scripts.framework.chatgpt_live import ChatGPTLiveRunner
        chat = Mock()
        chat.eval.return_value = {'path': '/c/one', 'failed': True}
        runtime = SimpleNamespace(chat=chat, webpage=Mock())
        with patch('scripts.framework.chatgpt_live.time.sleep') as sleep:
            with self.assertRaisesRegex(ValueError, 'automatic reload disabled'):
                ChatGPTLiveRunner.open_conversation(runtime, 'one')
        sleep.assert_not_called()
        chat.call.assert_called_once_with('Page.navigate', {'url': 'https://chatgpt.com/c/one'})
        runtime.webpage.assert_not_called()

    def test_local_required_hosts_never_change_release_manifest_or_reuse_stale_assets(self):
        from scripts.framework.chatgpt_acceptance import ChatGPTAcceptance
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = (Path(__file__).resolve().parents[1]/'manifest.json').read_text()
            (root/'manifest.json').write_text(source)
            for name in ('src', 'dist', 'lib', 'icons', '_locales'):
                (root/name).mkdir()
                (root/name/'asset').write_text('first-build')
            runtime = SimpleNamespace(root=root, report={})
            with patch.dict('os.environ', {}, clear=True):
                ChatGPTAcceptance.prepare_extension(runtime)
                staged = json.loads((runtime.extension_root/'manifest.json').read_text())
                for host in ('https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://images.openai.com/*'):
                    self.assertIn(host, staged['host_permissions'])
                    self.assertNotIn(host, staged['optional_host_permissions'])
                self.assertEqual((root/'manifest.json').read_text(), source)
                (runtime.extension_root/'stale').write_text('stale')
                (root/'dist/asset').write_text('second-build')
                ChatGPTAcceptance.prepare_extension(runtime)
                self.assertFalse((runtime.extension_root/'stale').exists())
                self.assertEqual((runtime.extension_root/'dist/asset').read_text(), 'second-build')
            with patch.dict('os.environ', {'TIER2_CHATGPT_REQUIRED_HOSTS': '0'}):
                ChatGPTAcceptance.prepare_extension(runtime)
            self.assertEqual(runtime.extension_root, root)
            self.assertEqual((root/'manifest.json').read_text(), source)
            self.assertEqual(runtime.report['testInstallMode'], 'optional-chatgpt-hosts')

    def run_matrix(self, plugins, **kwargs):
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()):
            runner = Tier2Runner(plugins, RunConfig(output_dir=folder, **kwargs))
            passed = runner.run()
            report = json.loads((Path(folder)/'tier2-report.json').read_text())
        return passed, report

    def test_registration_selection_and_third_party(self):
        registry = load_plugins()
        external = Plugin('third_party')
        registry.register(external)
        self.assertEqual([p.id for p in registry.select(['chatgpt,gemini', 'chatgpt'])], ['chatgpt', 'gemini'])
        self.assertEqual(registry.select(['all'])[-1], external)
        for names in (['unknown'], ['all,chatgpt'], [''], []):
            with self.assertRaises(ValueError):
                registry.select(names)
        with self.assertRaises(ValueError):
            registry.register(external)

    def test_external_module_registration(self):
        external = Plugin('third_party')
        module = SimpleNamespace(register=lambda registry: registry.register(external))
        with patch('scripts.framework.platforms.import_module', return_value=module) as imported:
            registry = load_plugins(['custom.tier2'])
        imported.assert_called_once_with('custom.tier2')
        self.assertEqual(registry.select(['third_party']), [external])

    def test_failure_blocks_dependents_but_other_platform_runs_and_artifacts_isolate(self):
        first, second = Plugin('first', fail=True), Plugin('second')
        passed, report = self.run_matrix([first, second])
        self.assertFalse(passed)
        self.assertEqual(first.events, ['prepare', 'first', 'close'])
        self.assertEqual(second.events, ['prepare', 'first', 'second', 'close'])
        self.assertEqual([f['status'] for f in report['platforms']['first']['features']], ['FAIL', 'SKIP'])
        self.assertTrue(report['platforms']['second']['passed'])
        self.assertNotEqual(first.config.output_dir, second.config.output_dir)

    def test_prepare_and_cleanup_failures_cannot_pass(self):
        for kwargs in ({'prepare_fail': True}, {'cleanup_fail': True}):
            plugin = Plugin('third', **kwargs)
            passed, report = self.run_matrix([plugin])
            self.assertFalse(passed)
            self.assertEqual(plugin.events[-1], 'close')
            self.assertFalse(report['platforms']['third']['passed'])

    def test_options_are_scoped_to_plugin(self):
        first, second = Plugin('one'), Plugin('two')
        first.accepted_options = ('archive',)
        passed, _ = self.run_matrix([first, second], options={'one': {'archive': 'input.zip'}})
        self.assertTrue(passed)
        self.assertEqual(first.config.options, {'archive': 'input.zip'})
        self.assertEqual(second.config.options, {})

    def test_preflight_rejects_all_bad_plans_before_any_open(self):
        good, bad = Plugin('good'), Plugin('bad')
        for kwargs in ({'target_features': 'missing'}, {'domain': 'missing'},
                       {'options': {'bad': {'unknown': 1}}}, {'options': {'absent': {}}}):
            with self.assertRaises(ValueError):
                Tier2Runner([good, bad], RunConfig(**kwargs))
            self.assertEqual(good.events, [])
            self.assertEqual(bad.events, [])

    def test_invalid_dependencies_and_cycle_rejected(self):
        for specs in ([{'id': 'a', 'prerequisites': ['missing']}],
                      [{'id': 'a', 'prerequisites': ['b']}, {'id': 'b', 'prerequisites': ['a']}], []):
            with self.assertRaises(ValueError):
                resolve_plan(specs)

    def test_real_plugins_and_dependency_plans_do_not_consume_pool(self):
        with patch('scripts.framework.scenario_provider.OnlineScenarioProvider.pop_scenario',
                   side_effect=AssertionError('Offline plan must not consume scenarios')):
            plugins = load_plugins().select(['all'])
            runner = Tier2Runner(plugins, RunConfig())
            self.assertEqual(len(runner.plan()['gemini']['features']), 25)
            self.assertEqual(len(runner.plan()['chatgpt']['features']), 22)
            targeted = Tier2Runner([plugins[1]], RunConfig(target_features='full_reply_fidelity'))
            active = {f['id'] for f in targeted.plan()['chatgpt']['features'] if f['scheduled']}
            self.assertIn('complex_multiturn', active)
            self.assertIn('physical_four_format_export', active)
            self.assertNotIn('popup_export', active)

    def test_cli_aliases_and_platform_specific_listing(self):
        root = Path(__file__).resolve().parents[1]
        for args in (['--platforms', 'gemini', 'chatgpt', '--plan'],
                     ['--provider', 'chatgpt', '--list-features'],
                     ['--platform', 'gemini,chatgpt', '--list-features']):
            result = subprocess.run([sys.executable, 'scripts/test_live_chat_and_export.py', *args],
                                    cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            if args[1] == 'chatgpt':
                self.assertEqual(set(plan), {'chatgpt'})
                self.assertFalse(any(f['id'].startswith('feat_takeout') for f in plan['chatgpt']['features']))

    def test_preparation_false_and_finalization_failure_block_success(self):
        for hook in ('prepare', 'finalize'):
            plugin = Plugin('third')
            original = plugin.open
            def open_session(config):
                session = original(config)
                if hook == 'prepare':
                    session.prepare = lambda: False
                else:
                    session.finalize = Mock(side_effect=RuntimeError('finalization failed'))
                return session
            plugin.open = open_session
            passed, report = self.run_matrix([plugin])
            self.assertFalse(passed)
            self.assertIn('close', plugin.events)

    def test_runtime_must_match_declared_dependencies_before_browser_preparation(self):
        plugin = Plugin('third')
        original = plugin.open
        def open_session(config):
            session = original(config)
            session.dag.cases['second'].prerequisites = []
            return session
        plugin.open = open_session
        passed, report = self.run_matrix([plugin])
        self.assertFalse(passed)
        self.assertEqual(plugin.events, ['close'])
        self.assertIn('declared plan', report['platforms']['third']['error'])

    def test_target_selection_is_owned_by_framework(self):
        plugin = Plugin('third')
        passed, report = self.run_matrix([plugin], target_features='first')
        self.assertTrue(passed)
        self.assertEqual(plugin.events, ['prepare', 'first', 'close'])
        self.assertEqual(report['scope'], 'targeted')
        statuses = {f['id']: f['status'] for f in report['platforms']['third']['features']}
        self.assertEqual(statuses, {'first': 'PASS', 'second': 'SKIP'})

    def test_failed_open_does_not_stop_other_platform(self):
        first, second = Plugin('one'), Plugin('two')
        first.open = Mock(side_effect=RuntimeError('open failed'))
        passed, report = self.run_matrix([first, second])
        self.assertFalse(passed)
        self.assertEqual(report['platforms']['one']['status'], 'failed')
        self.assertTrue(report['platforms']['two']['passed'])

    def test_chatgpt_adapter_uses_common_dag_and_preserves_failure_evidence(self):
        from scripts.framework.platforms.chatgpt import ChatGPTPlugin
        runtime = SimpleNamespace(report={'gates': {}, 'scan': [{'id': 'id', 'title': 'title'}]},
                                  port=9222, ext_id='test', fresh_options=Mock(), options=Mock(), chat=Mock(), browser=Mock(),
                                  save_report=Mock(), root=Path('/unused'), output=Path('/unused'), chat_ids=['id'])
        def gate(name, operation):
            result = operation()
            runtime.report['gates'][name] = {'status': 'passed', 'detail': result}
            return result
        runtime.gate = gate
        for name in ('prepare', 'generate', 'capture_golden', 'sync', 'confirmed_deletion',
                     'exports', 'popup_export', 'page_badge', 'passive_sidebar', 'account_boundary', 'initial_export',
                     'fast_skip', 'stale_tab_images', 'cleanup_records', 'uninstall_lifecycle'):
            setattr(runtime, name, Mock(return_value={}))
        def lifecycle():
            for key in ('live_disk_save', 'passive_promotion', 'export_record_advancement'):
                runtime.report['gates'][key] = {'status': 'passed'}
        runtime.lifecycle = lifecycle
        # Golden export's mandatory evidence is deliberately absent.
        runtime.golden_exports = Mock(return_value={})
        plugin = ChatGPTPlugin()
        plugin.open = lambda config: ChatGPTPlugin.session(runtime)
        from scripts.framework.cases import workbench
        with contextlib.ExitStack() as stack:
            monitor = stack.enter_context(patch('scripts.chrome_diagnostics.BrowserDiagnostics')).return_value
            monitor.failure = None
            monitor.finish.return_value = {}
            stack.enter_context(patch('scripts.framework.chatgpt_evidence.assert_full_exports', return_value={}))
            for name in ('SearchKeywordCase', 'SearchIdCase', 'SearchClearCase', 'SelectionControlsCase', 'LanguageToggleCase'):
                stack.enter_context(patch.object(getattr(workbench, name), 'execute', return_value=(True, 'evidence', {})))
            passed, report = self.run_matrix([plugin])
        self.assertFalse(passed)
        statuses = {f['id']: f['status'] for f in report['platforms']['chatgpt']['features']}
        self.assertEqual(statuses['full_reply_fidelity'], 'PASS')
        self.assertEqual(statuses['golden_physical_exports'], 'FAIL')
        self.assertEqual(statuses['popup_export'], 'SKIP')
        self.assertFalse(runtime.report['passed'])
        self.assertEqual(runtime.report['gates']['golden_physical_exports']['status'], 'fail')
        for connection in (runtime.options, runtime.chat, runtime.browser):
            connection.close.assert_called_once()

    def test_gemini_adapter_releases_environment_even_if_tracker_fails(self):
        from scripts.framework.platforms.gemini import GeminiPlugin
        runtime = SimpleNamespace(dag=DAGRunner(), ctx=SimpleNamespace(env=Mock()),
            prepare=Mock(), tracker=Mock(), target_ids=None,
            environment_context=SimpleNamespace(active_cdp=object()))
        runtime.tracker.teardown.side_effect = RuntimeError('tracker failed')
        with self.assertRaisesRegex(RuntimeError, 'tracker failed'):
            GeminiPlugin.session(runtime).close()
        runtime.ctx.env.teardown.assert_called_once_with(runtime.environment_context.active_cdp)

    def test_chatgpt_mandatory_subgate_still_blocks_success(self):
        from scripts.framework.platforms.chatgpt import ChatGPTCase
        runtime = SimpleNamespace(report={'gates': {}}, lifecycle=Mock(return_value={}), save_report=Mock(),
                                  gate=lambda name, operation: operation())
        case = ChatGPTCase('lifecycle', 'lifecycle', FeatureDomain.LIFECYCLE,
                           evidence=('live_disk_save', 'passive_promotion'))
        with self.assertRaisesRegex(ValueError, 'Missing mandatory evidence'):
            case.execute(SimpleNamespace(runtime=runtime))


class ChatGPTRequestBudgetTests(unittest.TestCase):
    @staticmethod
    def raw(cid, prompts):
        messages = []
        for i, prompt in enumerate(prompts):
            messages.extend([
                {'id': f'u{i}', 'author': {'role': 'user'}, 'content': {'parts': [prompt]}},
                {'id': f'a{i}', 'author': {'role': 'assistant'}, 'content': {'parts': [f'Answer {i}']},
                 'status': 'finished_successfully', 'end_turn': True},
            ])
        return {'conversation_id': cid, 'current_node': messages[-1]['id'],
                'mapping': {m['id']: {'message': m, 'parent': messages[i-1]['id'] if i else None}
                            for i, m in enumerate(messages)}}

    def runner(self, folder):
        from scripts.framework.chatgpt_live import ChatGPTLiveRunner
        runner = ChatGPTLiveRunner(output_dir=folder, delay=0)
        runner.chat = Mock()
        return runner

    def test_send_saves_settled_dom_and_local_progress_without_source_reads(self):
        from scripts.framework.chatgpt_live import ChatGPTLiveRunner
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            messages = [{'id': 'u', 'role': 'user', 'text': 'Question'},
                        {'id': 'a', 'role': 'assistant', 'text': 'Final answer'}]
            runner.webpage = Mock(side_effect=[[], messages, messages, messages, messages])
            runner.source = Mock(side_effect=AssertionError('Per-turn source HTTP is forbidden'))
            runner.freeze_visible_images = Mock()
            runner.chat.eval.side_effect = lambda expression, **kw: 'one' if 'location.pathname.split' in expression else False if '.some(e=>' in expression else True
            def wait(operation, *args):
                for _ in range(8):
                    result = operation()
                    if result:
                        return result
                raise AssertionError('Did not settle')
            with patch('scripts.framework.chatgpt_live.wait_for', side_effect=wait):
                self.assertEqual(runner.send('Question'), 'one')
            runner.source.assert_not_called()
            runner.freeze_visible_images.assert_called_once_with('one')
            self.assertEqual(json.loads((Path(folder)/'one.progress.json').read_text())['prompts'], ['Question'])
            self.assertEqual(json.loads((Path(folder)/'one.webpage.json').read_text()), messages)
            self.assertFalse((Path(folder)/'one.source.json').exists())

    def test_thirteen_turns_need_two_final_source_reads_and_resume_does_not_repost(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            prompts = {cid: [f'{cid} prompt {i}' for i in range(count)] for cid, count in [('one', 5), ('two', 8)]}
            runner.dataset = [{'turns': values} for values in prompts.values()]
            runner.send = Mock(side_effect=lambda prompt: prompt.split()[0])
            runner.source = Mock(side_effect=lambda cid: self.raw(cid, prompts[cid]))
            result = runner.generate()
            self.assertEqual(result['rounds'], [5, 8])
            self.assertEqual(runner.send.call_count, 13)
            self.assertEqual([call.args[0] for call in runner.source.call_args_list], ['one', 'two'])
            runner.send.reset_mock(); runner.source.reset_mock()
            runner.generate()
            runner.send.assert_not_called()
            self.assertEqual(runner.source.call_count, 2)  # One freshness read each; no second final read.

    def test_final_source_rejects_lost_reordered_or_unfinished_turns_without_overwriting_evidence(self):
        import copy
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            path = Path(folder)/'one.source.json'; path.write_text('previous evidence')
            expected = ['First', 'Second']
            incomplete = self.raw('one', expected)
            incomplete['mapping']['a1']['message']['end_turn'] = False
            middle_incomplete = self.raw('one', expected)
            middle_incomplete['mapping']['a0']['message']['end_turn'] = False
            for raw in [self.raw('one', ['First']), self.raw('one', ['Second', 'First']), incomplete, middle_incomplete]:
                runner.source = Mock(return_value=copy.deepcopy(raw))
                with self.assertRaises(ValueError):
                    runner.freeze_source('one', expected_prompts=expected)
                self.assertEqual(path.read_text(), 'previous evidence')
                runner.source.assert_called_once_with('one')

    def test_interrupted_generation_uses_local_progress_but_requires_remote_prefix_verification(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            one = [f'one {i}' for i in range(5)]; two = [f'two {i}' for i in range(8)]
            (Path(folder)/'one.progress.json').write_text(json.dumps({'prompts': one[:2]}))
            runner.dataset = [{'turns': one}, {'turns': two}]
            runner.send = Mock(side_effect=lambda prompt: prompt.split()[0])
            runner.source = Mock(side_effect=[self.raw('one', one[:2]), self.raw('one', one), self.raw('two', two)])
            runner.generate()
            self.assertEqual(runner.send.call_count, 11)
            self.assertEqual(runner.source.call_count, 3)  # Resume validation plus final reads after new turns.
            self.assertNotIn('one 0', [call.args[0] for call in runner.send.call_args_list])

    def test_429_stops_after_one_request_without_sleep_or_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.chat.call.side_effect = [
                {'result': {'frameTree': {'frame': {'id': 'frame'}}}},
                {'result': {'executionContextId': 7}},
                {'result': {'result': {'value': {'sourceError': 429, 'retryAfter': '60'}}}},
            ]
            with patch('scripts.framework.chatgpt_live.time.sleep') as sleep:
                with self.assertRaisesRegex(ValueError, 'HTTP 429.*Retry-After=60'):
                    runner.source('one')
                sleep.assert_not_called()
            self.assertEqual([call.args[0] for call in runner.chat.call.call_args_list].count('Runtime.evaluate'), 1)

    def test_loaded_image_evidence_is_frozen_once_per_visible_message_without_source(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.source = Mock(side_effect=AssertionError('No API reads for image detection'))
            runner.chat.eval.side_effect = [['image-one group-one'], ['image-one group-one'], ['image-one group-one', 'image-two group-two']]
            with patch('scripts.framework.chatgpt_live.capture_webpage_images', side_effect=[
                    [{'turn': 'image-one group-one', 'pixels': [1]}],
                    [{'turn': 'image-two group-two', 'pixels': [2]}]]) as capture:
                for _ in range(3):
                    runner.freeze_visible_images('one')
            self.assertEqual(capture.call_count, 2)
            self.assertEqual(capture.call_args.kwargs['message_ids'], ['group-two', 'image-two'])
            self.assertEqual(len(json.loads((Path(folder)/'one.image-webpage-evidence.json').read_text())), 2)
            runner.source.assert_not_called()


from test_tier2_claude import ClaudeTier2Tests
from test_chrome_diagnostics import TestChromeDiagnostics


if __name__ == '__main__':
    unittest.main()
