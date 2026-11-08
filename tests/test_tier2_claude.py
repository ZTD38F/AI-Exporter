"""Claude Tier 2 contracts: request budgets, source integrity and physical fidelity."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts.framework.claude_live import ClaudeLiveRunner, completed_branch, ROOT_MESSAGE
from scripts.framework.claude_evidence import source_fragments, assert_full_exports, assert_existing_exports, markdown_fact
from scripts.framework.platforms.claude import ClaudePlugin, build_dag
from scripts.framework.platforms.core import resolve_plan


def source(cid, prompts):
    messages = []
    parent = ROOT_MESSAGE
    for i, prompt in enumerate(prompts):
        for role, text in [('human', prompt), ('assistant', 'Answer '+prompt)]:
            mid = f'{i}-{role}'
            messages.append({'uuid': mid, 'sender': role, 'parent_message_uuid': parent,
                             'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': text, 'stop_timestamp': 'done'}]})
            parent = mid
    return {'uuid': cid, 'current_leaf_message_uuid': parent, 'chat_messages': messages}


class ClaudeTier2Tests(unittest.TestCase):
    def runner(self, folder):
        return ClaudeLiveRunner(output_dir=folder, delay=0)

    def test_haiku_selection_checks_existing_model_without_opening_menus(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.chat = Mock()
            runner.chat.eval.return_value = {'label': '模型：Haiku 5.5', 'haiku': True}
            self.assertEqual(runner.ensure_haiku(), {'family': 'haiku', 'label': '模型：Haiku 5.5'})
            runner.chat.eval.assert_called_once()
            runner.chat.call.assert_not_called()

    def test_haiku_selection_uses_available_radio_in_more_models_and_verifies_change(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.chat = Mock()
            chosen, reads = False, 0
            def evaluate(expression, **kwargs):
                nonlocal chosen, reads
                if 'return {label,haiku:' in expression:
                    self.assertNotIn('\b', expression, 'JavaScript word boundaries must not become backspace characters')
                    return {'label': 'Haiku 5.5' if chosen else 'Sonnet 5.5', 'haiku': chosen}
                if 'selectable:' in expression:
                    reads += 1
                    return [] if reads == 1 else [
                        {'id': 'claude-haiku-locked', 'label': 'Haiku Upgrade', 'selectable': False},
                        {'id': 'claude-haiku-5-5', 'label': 'Haiku 5.5', 'selectable': True}]
                if 'return e.id' in expression:
                    return 'more-models'
                if "e.scrollIntoView({block:'nearest'})" in expression:
                    self.assertIn('claude-haiku-5-5', expression)
                    self.assertNotIn('claude-haiku-locked', expression)
                    chosen = True
                return True
            runner.chat.eval.side_effect = evaluate
            self.assertEqual(runner.ensure_haiku()['id'], 'claude-haiku-5-5')
            self.assertEqual(reads, 2)
            self.assertEqual(runner.report['modelSelection']['status'], 'selected')
            runner.chat.call.assert_not_called()

    def test_unavailable_haiku_blocks_send_before_composer_or_source_acquisition(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.chat = Mock()
            def evaluate(expression, **kwargs):
                if 'return {label,haiku:' in expression:
                    return {'label': 'Sonnet 5.5', 'haiku': False}
                if 'selectable:' in expression:
                    return [{'id': 'claude-haiku-5-5', 'label': 'Haiku Upgrade', 'selectable': False}]
                if 'return e.id' in expression:
                    return None
                return True
            runner.chat.eval.side_effect = evaluate
            with self.assertRaisesRegex(ValueError, 'Haiku is unavailable'):
                runner.send('Do not send with Sonnet')
            runner.chat.call.assert_not_called()
            self.assertEqual(runner.report['sourceRequests'], 0)
            self.assertEqual(runner.report['modelSelection']['status'], 'blocked')
            self.assertNotIn('sendAttempts', runner.report)

    def test_registered_full_plan_keeps_failures_independent(self):
        from scripts.framework.platforms import load_plugins
        self.assertEqual([p.id for p in load_plugins().select(['all'])], ['gemini', 'chatgpt', 'claude'])
        specs = resolve_plan(ClaudePlugin().features())
        self.assertEqual(len(specs), 22)
        self.assertTrue(all(s['scheduled'] for s in specs))
        cases = build_dag().cases
        self.assertNotIn('page_badge', cases['complex_multiturn'].prerequisites)
        self.assertNotIn('scan_coverage', cases['physical_four_format_export'].prerequisites)
        self.assertIn('scan_coverage', cases['physical_four_format_export'].after)
        self.assertEqual(cases['passive_lifecycle'].evidence, ('live_disk_save', 'passive_promotion', 'export_record_advancement'))

    def test_branch_ignores_siblings_and_rejects_cycles_missing_parents_and_unfinished_turns(self):
        raw = source('one', ['p'])
        raw['chat_messages'].append({'uuid': 'sibling', 'sender': 'assistant', 'parent_message_uuid': '0-human'})
        self.assertEqual([m['uuid'] for m in completed_branch(raw)], ['0-human', '0-assistant'])
        for mutation, error in [
            (lambda r: r['chat_messages'][0].update(parent_message_uuid='0-assistant'), 'Cyclic'),
            (lambda r: r['chat_messages'][0].update(parent_message_uuid='missing'), 'missing'),
            (lambda r: r['chat_messages'][1].update(stop_reason='tool_use'), 'incomplete'),
            (lambda r: r['chat_messages'][1]['content'][0].update(stop_timestamp=None), 'unfinished'),
            (lambda r: r.update(current_leaf_message_uuid='0-human'), 'before an assistant'),
        ]:
            candidate = source('one', ['p'])
            mutation(candidate)
            with self.assertRaisesRegex(ValueError, error):
                completed_branch(candidate)

    def test_429_has_one_request_no_retry_or_sleep(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.org = '11111111-1111-4111-8111-111111111111'
            runner.chat = Mock()
            runner.chat.call.side_effect = [
                {'result': {'frameTree': {'frame': {'id': 'frame'}}}},
                {'result': {'executionContextId': 7}},
                {'result': {'result': {'value': {'sourceError': 429, 'retryAfter': '30'}}}},
            ]
            with patch('scripts.framework.claude_live.time.sleep') as sleep:
                with self.assertRaisesRegex(ValueError, 'HTTP 429; no retries'):
                    runner.source('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
            self.assertEqual(runner.report['sourceRequests'], 1)
            sleep.assert_not_called()
            requests = [c for c in runner.chat.call.call_args_list if c.args[0] == 'Runtime.evaluate']
            blocked = Mock()
            with self.assertRaisesRegex(RuntimeError, 'further provider operations stopped'):
                runner.gate('scan', blocked)
            blocked.assert_not_called()
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].args[1]['contextId'], 7)

    def test_incomplete_source_never_overwrites_previous_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            path = Path(folder)/'one.source.json'
            path.write_text('previous')
            raw = source('one', ['p'])
            raw['chat_messages'][-1]['stop_reason'] = 'tool_use'
            runner.source = Mock(return_value=raw)
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                runner.freeze_source('one', ['p'])
            self.assertEqual(path.read_text(), 'previous')
            runner.source.assert_called_once_with('one')

    def test_thirteen_turns_only_two_final_source_reads_and_resume_posts_nothing(self):
        dataset = [{'turns': [f'{s}-{i}' for i in range(n)]} for s, n in [('first', 5), ('second', 8)]]
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.dataset, runner.chat = dataset, Mock()
            prompts = {'one': [], 'two': []}
            def send(prompt):
                cid = 'one' if prompt.startswith('first') else 'two'
                prompts[cid].append(prompt)
                (Path(folder)/f'{cid}.progress.json').write_text(json.dumps({'prompts': prompts[cid]}))
                return cid
            runner.send = Mock(side_effect=send)
            runner.source = Mock(side_effect=lambda cid: source(cid, prompts[cid]))
            runner.generate()
            self.assertEqual(runner.send.call_count, 13)
            self.assertEqual(runner.source.call_count, 2)
            resumed = self.runner(folder)
            resumed.chat, resumed.send = Mock(), Mock()
            resumed.source = Mock(side_effect=lambda cid: source(cid, prompts[cid]))
            resumed.generate()
            resumed.send.assert_not_called()
            self.assertEqual(resumed.source.call_count, 2)

    def test_resume_remote_divergence_does_not_repost(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.dataset = [{'turns': [f'{s}{i}' for i in range(n)]} for s,n in [('a',5),('b',8)]]
            (Path(folder)/'one.progress.json').write_text(json.dumps({'prompts': ['a0']}))
            runner.source, runner.send, runner.chat = Mock(return_value=source('one', ['changed'])), Mock(), Mock()
            with self.assertRaisesRegex(ValueError, 'refusing to replay'):
                runner.generate()
            runner.send.assert_not_called()

    def test_native_questionnaire_artifact_and_memory_oracle(self):
        fragments, codes = source_fragments({'content': [
            {'type': 'text', 'text': 'Authored prose'},
            {'type': 'tool_use', 'name': 'AskUserQuestion', 'input': {'questions': [
                {'header': 'OS', 'question': 'Choose OS', 'options': [{'label': 'Linux', 'description': 'A description'}]}]}},
            {'type': 'tool_result', 'name': 'AskUserQuestion', 'content': [{'type': 'text', 'text': 'Selected Linux'}]},
            {'type': 'tool_use', 'name': 'Write', 'input': {'content': '<h1>Artifact</h1>\n'}},
            {'type': 'tool_result', 'name': 'memory_read', 'content': [{'type': 'text', 'text': 'PRIVATE MEMORY'}]},
        ]})
        self.assertEqual(fragments, ['Authored prose', 'OS', 'Choose OS', 'Linux', 'A description', 'Selected Linux'])
        self.assertEqual(codes, ['<h1>Artifact</h1>'])

    def test_physical_oracle_rejects_lost_text_and_changed_code(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            raw = source('one', ['Prompt'])
            raw['chat_messages'][1]['content'][0]['text'] = 'Full answer.\n\n```python\n  print(1)\n```'
            (output/'one.source.json').write_text(json.dumps(raw))
            for fmt in ('json', 'markdown', 'html', 'pdf'):
                (output/'downloads'/fmt).mkdir(parents=True)
            domain = {'quality': {'status': 'complete'}, 'messages': [
                {'id': '0-human', 'role': 'user'}, {'id': '0-assistant', 'role': 'assistant'}]}
            document = {'conversation': {'index': {'key': {'conversationId': 'one'}}, 'detail': domain}}
            (output/'downloads/json/one.json').write_text(json.dumps(document))
            md = output/'downloads/markdown/one.md'
            html = output/'downloads/html/one.html'
            md.write_text('## 👤 User\nPrompt\n## 🤖 Assistant\nFull answer.\n\n```python\n  print(1)\n```')
            html.write_text('<div class="gem-prompt-content">Prompt</div><div class="gem-model-content"><p>Full answer.</p><pre><code>  print(1)</code></pre></div>')
            with patch('scripts.framework.claude_evidence.PdfExportDownloadCase._extract_pdf_info', return_value={'contentRuns': [1], 'pageCount': 1}), patch('scripts.framework.claude_evidence.assert_pdf_turn_content', return_value=(True, 'ok')):
                self.assertEqual(assert_full_exports(root, output, ['one'])[0]['messages'], 2)
                raw['chat_messages'][1]['content'].append(dict(raw['chat_messages'][1]['content'][0]))
                (output/'one.source.json').write_text(json.dumps(raw))
                with self.assertRaisesRegex(ValueError, 'authored fragment'):
                    assert_full_exports(root, output, ['one'])
                raw['chat_messages'][1]['content'].pop()
                (output/'one.source.json').write_text(json.dumps(raw))
                md.write_text(md.read_text().replace('Full answer.', 'answer.'))
                with self.assertRaisesRegex(ValueError, 'authored fragment'):
                    assert_full_exports(root, output, ['one'])
                md.write_text(md.read_text().replace('answer.', 'Full answer.').replace('  print(1)', 'print(1)'))
                with self.assertRaisesRegex(ValueError, 'indentation changed'):
                    assert_full_exports(root, output, ['one'])

    def test_currency_dollars_remain_prose_in_independent_evidence(self):
        fact = markdown_fact(Path(__file__).resolve().parents[1], 'Prices: $5 input / $30 output. Formula: $x^2$.')
        self.assertIn('$5 input / $30 output', fact['text'])
        self.assertEqual([s['text'] for s in fact['segments'] if s['kind'] == 'math'], ['x^2'])

    def test_existing_oracle_checks_interrupted_pending_and_empty_without_weakening_full_gate(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            for fmt in ('json', 'markdown', 'html', 'pdf'):
                (output/'downloads'/fmt).mkdir(parents=True)
            raw = source('one', ['Prompt'])
            raw['chat_messages'][1]['stop_reason'] = 'error'
            def write(quality, roles):
                (output/'one.source.json').write_text(json.dumps(raw))
                document = {'conversation': {'index': {'key': {'conversationId': 'one'}}, 'detail': {
                    'quality': {'status': quality}, 'assets': [], 'messages': [
                        {'id': f'0-{sender}', 'role': role} for sender,role in roles]}}}
                (output/'downloads/json/one.json').write_text(json.dumps(document))
                (output/'downloads/markdown/one.md').write_text(''.join(
                    f'## {"👤 User" if role == "user" else "🤖 Assistant"}\n{("Prompt" if role == "user" else "Answer Prompt")}\n'
                    for _,role in roles))
                (output/'downloads/html/one.html').write_text(''.join(
                    f'<div class="gem-{"prompt" if role == "user" else "model"}-content">{("Prompt" if role == "user" else "Answer Prompt")}</div>'
                    for _,role in roles))
            with patch('scripts.framework.claude_evidence.PdfExportDownloadCase._extract_pdf_info',
                       return_value={'contentRuns': [{'kind':'text','text':'Prompt Answer Prompt'}], 'pageCount':1}), \
                    patch('scripts.framework.claude_evidence.assert_pdf_turn_content', return_value=(True, 'ok')):
                roles = [('human','user'),('assistant','assistant')]
                write('partial', roles)
                self.assertEqual(assert_existing_exports(root, output, ['one'])[0]['quality'], 'partial')
                with self.assertRaisesRegex(ValueError, 'incomplete'):
                    assert_full_exports(root, output, ['one'])
                write('complete', roles)
                with self.assertRaisesRegex(ValueError, 'quality differs'):
                    assert_existing_exports(root, output, ['one'])
                raw['current_leaf_message_uuid'] = None
                raw['chat_messages'] = raw['chat_messages'][:1]
                write('unknown', roles[:1])
                self.assertEqual(assert_existing_exports(root, output, ['one'])[0]['messages'], 1)
                raw['chat_messages'] = []
                write('unknown', [])
                self.assertEqual(assert_existing_exports(root, output, ['one'])[0]['messages'], 0)

    def test_send_saves_dom_progress_without_source_polling_and_rejects_pending_question(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            model = {'family': 'haiku', 'label': 'Haiku 5.5'}
            runner.ensure_haiku = Mock(return_value=model)
            runner.chat = Mock()
            messages = [{'id': 'u', 'role': 'user', 'text': 'Question'}, {'id': 'new', 'role': 'assistant', 'text': 'Answer'}]
            runner.webpage = Mock(side_effect=[[], messages, messages, messages, messages])
            runner.source = Mock(side_effect=AssertionError('Per-turn source API forbidden'))
            runner.chat.eval.side_effect = lambda expression, **kw: ('one' if 'location.pathname.split' in expression
                else {'stop': False, 'question': False} if expression.startswith('({stop:') else True)
            def wait(operation, *args):
                for _ in range(8):
                    result = operation()
                    if result:
                        return result
                raise TimeoutError('did not settle')
            with patch('scripts.framework.claude_live.wait_for', side_effect=wait):
                self.assertEqual(runner.send('Question'), 'one')
            runner.source.assert_not_called()
            self.assertEqual(runner.report['sendAttempts'], [{'prompt': 'Question', 'model': model, 'dispatched': True}])
            self.assertEqual(json.loads((Path(folder)/'one.progress.json').read_text())['prompts'], ['Question'])
            runner.webpage = Mock(return_value=messages)
            runner.chat.eval.side_effect = lambda expression, **kw: {'question': True} if expression.startswith('({stop:') else True
            with patch('scripts.framework.claude_live.wait_for', side_effect=wait):
                with self.assertRaisesRegex(ValueError, 'requires input'):
                    runner.send('Another question')
            self.assertEqual(json.loads((Path(folder)/'one.progress.json').read_text())['prompts'], ['Question'])

    def test_native_quota_fails_before_mutating_composer_without_source_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.ensure_haiku = Mock(return_value={'family': 'haiku', 'label': 'Haiku 5.5'})
            runner.chat = Mock()
            runner.chat.eval.return_value = '您的免费消息额度已用完，将于 02:00 恢复'
            with self.assertRaisesRegex(ValueError, 'quota exhausted \(not HTTP 429\)'):
                runner.send('Do not send')
            runner.chat.call.assert_not_called()
            self.assertEqual(runner.report['sourceRequests'], 0)
            self.assertFalse(runner.report['messageQuota']['http429Observed'])

    def test_missing_nested_lifecycle_evidence_fails_even_when_operation_returns(self):
        from scripts.framework.platforms.claude import ClaudeCase
        from scripts.framework.features import FeatureDomain
        case = ClaudeCase('passive_lifecycle', 'lifecycle', FeatureDomain.LIFECYCLE,
                          evidence=('live_disk_save', 'passive_promotion', 'export_record_advancement'))
        runtime = SimpleNamespace(report={'gates': {}}, lifecycle=lambda: {'returned': True},
                                  gate=lambda name, operation: operation())
        with self.assertRaisesRegex(ValueError, 'Missing mandatory evidence'):
            case.execute(SimpleNamespace(runtime=runtime))

    def test_physical_downloads_cannot_reuse_previous_extracted_files(self):
        import zipfile
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.options, runner.browser, runner.ready = Mock(), Mock(), Mock()
            runner.report['scan'] = [{'id': 'one'}, {'id': 'two'}]
            old = Path(folder)/'downloads/json'
            old.mkdir(parents=True)
            (old/'stale.json').write_text('old evidence')
            def export(ids, destination, fmt):
                path = destination/'export.zip'
                with zipfile.ZipFile(path, 'w') as archive:
                    for cid in ['one', 'wrong']:
                        key = {'accountId': 'account', 'conversationId': cid}
                        document = {'format': 'gemini-exporter-domain', 'version': 1, 'account': {'id': 'account'},
                                    'conversation': {'index': {'key': key}, 'detail': {'key': key, 'messages': [], 'assets': []}}, 'resources': {}}
                        archive.writestr(cid+'.json' if fmt == 'json' else cid+'.txt', json.dumps(document))
                return path
            runner.export_selected = export
            with self.assertRaisesRegex(ValueError, 'selected conversation identities'):
                runner.physical_exports()
            self.assertFalse((Path(folder)/'downloads/json/stale.json').exists())
            self.assertEqual(len(list(Path(folder).glob('downloads-previous-*/json/stale.json'))), 1)

    def test_local_required_hosts_preserve_release_manifest_and_refresh_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = (Path(__file__).resolve().parents[1]/'manifest.json').read_text()
            (root/'manifest.json').write_text(source)
            for name in ('src', 'dist', 'lib', 'icons', '_locales'):
                (root/name).mkdir()
                (root/name/'asset').write_text('first')
            runner = self.runner(root/'output')
            runner.root = root
            with patch.dict('os.environ', {}, clear=True):
                runner.prepare_extension()
                staged = json.loads((runner.extension_root/'manifest.json').read_text())
                self.assertIn('https://claude.ai/*', staged['host_permissions'])
                self.assertNotIn('https://claude.ai/*', staged['optional_host_permissions'])
                self.assertEqual((root/'manifest.json').read_text(), source)
                (root/'src/asset').write_text('new build')
                (runner.extension_root/'dist/stale').write_text('stale')
                runner.prepare_extension()
                self.assertEqual((runner.extension_root/'src/asset').read_text(), 'new build')
                self.assertFalse((runner.extension_root/'dist/stale').exists())
            with patch.dict('os.environ', {'TIER2_CLAUDE_REQUIRED_HOSTS': '0'}):
                runner.prepare_extension()
                self.assertEqual(runner.extension_root, root)
                self.assertEqual(runner.report['testInstallMode'], 'optional-claude-hosts')

    def test_native_reply_identity_survives_virtualized_message_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner(folder)
            runner.ensure_haiku = Mock(return_value={'family': 'haiku', 'label': 'Haiku 5.5'})
            runner.chat = Mock()
            old = [{'id': str(i), 'role': 'assistant', 'text': 'Old'} for i in range(5)]
            visible = [{'role': 'user', 'text': 'Question'}, {'id': 'new-reply', 'role': 'assistant', 'text': 'Final answer'}]
            runner.webpage = Mock(side_effect=[old, visible, visible, visible, visible])
            runner.chat.eval.side_effect = lambda expression, **kw: ('one' if 'location.pathname.split' in expression
                else {'stop': False, 'question': False} if expression.startswith('({stop:') else True)
            def wait(operation, *args):
                for _ in range(8):
                    result = operation()
                    if result:
                        return result
                raise TimeoutError('did not settle')
            with patch('scripts.framework.claude_live.wait_for', side_effect=wait):
                self.assertEqual(runner.send('Question'), 'one')
            self.assertEqual(json.loads((Path(folder)/'one.progress.json').read_text())['prompts'], ['Question'])
