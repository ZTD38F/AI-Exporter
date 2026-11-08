"""ChatGPT live staging. Browser interaction and disk evidence, never mocked replies.

Platform-specific browser operations and evidence collection. Scheduling,
dependencies and lifecycle are owned by the platform-neutral Tier 2 framework.
"""
import base64
import json
import re
import subprocess
import time
import traceback
import zipfile
from pathlib import Path

from scripts.cdp_client import CDPConnection, get_tabs, get_browser_ws_url
from scripts.framework.scenario_provider import OnlineScenarioProvider
from scripts.framework.json_archive import validate_json_archive
from scripts.framework.v2_probe import install_probe
from scripts.framework.actions import CDPActions
from scripts.framework.image_evidence import capture_webpage_images, assert_image_files
from scripts.framework.chatgpt_acceptance import ChatGPTAcceptance


from scripts.framework.live_utils import wait_for


def current_branch(raw):
    nodes, visited, result = raw['mapping'], set(), []
    current = raw['current_node']
    while current:
        if current in visited:
            raise ValueError('Cyclic source branch')
        visited.add(current)
        node = nodes[current]
        message = node.get('message')
        if message:
            result.append(message)
        current = node.get('parent')
    return list(reversed(result))


def completed_branch(raw):
    """One final source read must prove the completion of every submitted turn."""
    messages = current_branch(raw)
    users = [i for i, message in enumerate(messages) if message.get('author', {}).get('role') == 'user']
    if not users:
        raise ValueError('Final ChatGPT source has no user turns')
    for boundary in users[1:] + [len(messages)]:
        leaf = messages[boundary-1]
        if leaf.get('author', {}).get('role') != 'assistant' or leaf.get('status') != 'finished_successfully' or not leaf.get('end_turn'):
            raise ValueError('Final ChatGPT source contains an incomplete reply')
    return messages


class ChatGPTLiveRunner(ChatGPTAcceptance):
    def __init__(self, port=9222, output_dir=None, dataset=None, delay=6):
        self.port, self.delay = port, delay
        self.root = Path(__file__).resolve().parents[2]
        self.extension_root = self.root
        self.output = Path(output_dir or self.root/'tests/output/chatgpt_live')
        self.output.mkdir(parents=True, exist_ok=True)
        self.dataset = dataset
        self.golden = json.loads((self.root/'tests/fixtures/chatgpt_tier2_golden.json').read_text())
        self.report = {'provider': 'chatgpt', 'gates': {}, 'records': []}
        self.initial_exports = {}
        self.chat = self.options = self.browser = None

    def save_report(self):
        (self.output/'report.json').write_text(json.dumps(self.report, ensure_ascii=False, indent=2))

    def gate(self, name, operation):
        print(f'[ChatGPT Tier 2] {name}', flush=True)
        try:
            detail = operation()
            self.report['gates'][name] = {'status': 'passed', 'detail': detail}
            self.save_report()
            return detail
        except Exception as error:
            self.report['gates'][name] = {'status': 'failed', 'error': str(error), 'traceback': traceback.format_exc()}
            self.save_report()
            raise

    def prepare(self):
        subprocess.run(['node', 'build.js'], cwd=self.root, check=True)
        self.prepare_extension()
        tabs = get_tabs(self.port)
        target = next((t for t in tabs if t.get('url', '').startswith('https://chatgpt.com/')), None)
        if not target:
            raise ValueError('Open the logged-in ChatGPT test account on this CDP port')
        self.chat = CDPConnection(target['webSocketDebuggerUrl'])
        self.browser = CDPConnection(get_browser_ws_url(self.port))
        self.clean_install()
        result = self.browser.call('Extensions.loadUnpacked', {'path': str(self.extension_root)})
        if 'error' in result:
            raise ValueError(result['error'])
        self.ext_id = result['result']['id']
        # Reload the existing source document after replacing unpacked scripts:
        # its old isolated-world listener belongs to an invalidated extension.
        self.chat.call('Page.reload')
        wait_for(lambda: self.chat.eval("!!document.querySelector('#prompt-textarea,[role=textbox][contenteditable=true]')"))
        url = f'chrome-extension://{self.ext_id}/src/ui/options/options.html'
        # Installation itself opens ?startTour=1. Reuse that tab; creating an
        # exact-URL duplicate races the native onboarding and hides failures.
        target = wait_for(lambda: next((t for t in get_tabs(self.port)
                                       if t.get('url', '').startswith(url)), None), 20)
        self.options = CDPConnection(target['webSocketDebuggerUrl'])
        self.ready()
        if not CDPActions.verify_onboarding_tour(self.port, self.ext_id, provider_id='chatgpt'):
            raise ValueError('Fresh-install onboarding did not complete')
        self.gate('onboarding', lambda: {'physicalTour': True})
        granted = self.options.eval("chrome.permissions.contains({origins:['https://chatgpt.com/*','https://chat.openai.com/*']})", await_promise=True)
        if not granted:
            raise ValueError('ChatGPT site permission missing after onboarding')
        self.ready()
        self.chat.call('Page.reload')
        wait_for(lambda: self.chat.eval("!!document.querySelector('#prompt-textarea,[role=textbox][contenteditable=true]')"))
        account = self.options.eval("document.querySelector('#accountIdSelect option:checked')?.textContent||document.getElementById('accountName').textContent")
        if 'ChatGPT' not in account:
            raise ValueError('Canonical ChatGPT account not selected: ' + account)
        return {'extensionId': self.ext_id, 'accountVerified': True, 'cleanInstall': True}

    def ready(self, timeout=180):
        return wait_for(lambda: self.options.eval("document.body?.dataset.busy==='false'&&!document.getElementById('btnSyncAll')?.disabled"), timeout)

    def source(self, conversation_id=None):
        # Independent evidence reads must not trigger the production MAIN-world
        # hook, otherwise the observer could manufacture passive capture success.
        frame = self.chat.call('Page.getFrameTree')['result']['frameTree']['frame']['id']
        context = self.chat.call('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'tier2-source-evidence'})['result']['executionContextId']
        response = self.chat.call('Runtime.evaluate', {'contextId': context, 'awaitPromise': True, 'returnByValue': True,
            'expression': """(async()=>{
            const id="""+json.dumps(conversation_id)+"""||location.pathname.split('/c/')[1]?.split('/')[0];
            if(!id)return null;
            const s=await(await fetch('/api/auth/session')).json();
            const r=await fetch('/backend-api/conversation/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+s.accessToken}});
            if(!r.ok) return {sourceError:r.status,retryAfter:r.headers.get('retry-after')};
            return await r.json();
        })()"""})
        if response.get('result', {}).get('exceptionDetails'):
            raise ValueError('Independent ChatGPT source request failed')
        value = response.get('result', {}).get('result', {}).get('value')
        if isinstance(value, dict) and value.get('sourceError'):
            if value['sourceError'] == 429:
                raise ValueError('ChatGPT evidence HTTP 429; stopping independent reads; Retry-After='
                                 + str(value.get('retryAfter')))
            raise ValueError('ChatGPT source HTTP '+str(value['sourceError']))
        if value and conversation_id and value.get('conversation_id') != conversation_id:
            raise ValueError('Evidence response identity mismatch')
        if not isinstance(value, dict) or not value.get('mapping') or not value.get('current_node'):
            raise ValueError('Independent ChatGPT source is unavailable')
        return value

    def freeze_source(self, cid, expected_prompts=None):
        raw = self.source(cid)  # One request per completed scenario, never a polling loop.
        messages = completed_branch(raw)
        prompts = [''.join(p for p in m.get('content', {}).get('parts', []) if isinstance(p, str))
                   for m in messages if m.get('author', {}).get('role') == 'user']
        if expected_prompts is not None and prompts != expected_prompts:
            raise ValueError('Final ChatGPT source does not preserve every expected prompt in order')
        (self.output/f'{cid}.source.json').write_text(json.dumps(raw, ensure_ascii=False))
        return raw

    def freeze_visible_images(self, cid):
        # Inspect actual loaded elements, not the source API. The browser's
        # resource cache supplies bytes; this issues no provider HTTP request.
        image_path = self.output/f'{cid}.image-webpage-evidence.json'
        captured = json.loads(image_path.read_text()) if image_path.exists() else []
        known = {mid for image in captured for mid in str(image.get('turn', '')).split()}
        visible = self.chat.eval("""[...(document.querySelector('[role=\"region\"][aria-label=\"对话\"], [role=\"region\"][aria-label=\"Conversation\"]')?.querySelectorAll('img')||[])]
            .filter(img=>!img.closest('.katex,[aria-hidden=\"true\"],[data-user-message-bubble]')&&(img.naturalWidth>128||!img.complete))
            .map(img=>[img.closest('[data-chatgpt-selection-message-id]')?.dataset.chatgptSelectionMessageId,
                       img.closest('[data-chatgpt-search-message-ids]')?.dataset.chatgptSearchMessageIds].filter(Boolean).join(' '))""") or []
        missing = {mid for turn in visible for mid in turn.split() if mid not in known}
        if missing:
            captured += capture_webpage_images(self.chat, cid, timeout=90, provider_id='chatgpt', message_ids=sorted(missing))
            image_path.write_text(json.dumps(captured))

    def webpage(self):
        return self.chat.eval("""(()=>{
            const region=document.querySelector('[role="region"][aria-label="对话"], [role="region"][aria-label="Conversation"]');
            if(!region)return [];
            const items=[...region.querySelectorAll('[data-user-message-bubble], [data-chatgpt-selection-message-id]')];
            return items.map(element=>{
                const user=element.hasAttribute('data-user-message-bubble');
                const source=user?element:element.querySelector('[data-markdown-text-style="assistant-message"]')||element;
                const clone=source.cloneNode(true);
                clone.querySelectorAll('.katex').forEach(math=>{
                    const annotation=math.querySelector('annotation[encoding="application/x-tex"]');
                    math.replaceWith(document.createTextNode(annotation?.textContent||'[MISSING MATH SOURCE]'));
                });
                clone.querySelectorAll('button,svg,style,script,[hidden],[aria-hidden="true"]').forEach(node=>node.remove());
                return {role:user?'user':'assistant',
                    id:element.dataset.chatgptSelectionMessageId||element.closest('[data-chatgpt-search-message-ids]')?.dataset.chatgptSearchMessageIds,
                    text:clone.textContent,html:source.outerHTML};
            });
        })()""")

    def send(self, prompt):
        baseline = self.webpage() or []
        previous_assistants = {m['id'] for m in baseline if m['role'] == 'assistant'}
        # Scope to the actual composer; generated Canvas/code editors are also editable.
        selector = '#prompt-textarea,[role="textbox"][contenteditable="true"][aria-label="询问 ChatGPT"],[role="textbox"][contenteditable="true"][aria-label="Ask anything"]' 
        wait_for(lambda: self.chat.eval(f'!!document.querySelector({json.dumps(selector)})'))
        self.chat.eval(f"""(()=>{{const e=document.querySelector({json.dumps(selector)});e.focus();
            const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);}})()""", user_gesture=True)
        self.chat.call('Input.insertText', {'text': prompt})
        button = "[...document.querySelectorAll('button')].find(e=>['发送','Send prompt','Send message'].includes(e.getAttribute('aria-label'))&&!e.disabled)"
        wait_for(lambda: self.chat.eval(f'!!({button})'))
        self.chat.eval(f'({button}).click()', user_gesture=True)
        previous, stable, settled = None, 0, None
        def finished():
            nonlocal previous, stable, settled
            messages = self.webpage() or []
            users = [m for m in messages if m['role'] == 'user']
            if not users or users[-1]['text'].strip() != prompt.strip():
                return None
            leaf = messages[-1]
            if leaf['role'] != 'assistant' or leaf['id'] in previous_assistants or not leaf['text'].strip():
                return None
            if self.chat.eval("[...document.querySelectorAll('button')].some(e=>e.dataset.testid==='stop-button'||/^(停止|Stop)(生成|流式传输| generating| streaming)?$/i.test(e.getAttribute('aria-label')||''))"):
                return None
            state = json.dumps(leaf, sort_keys=True)
            stable = stable + 1 if state == previous else 0
            previous = state
            if stable >= 3:
                settled = messages
                return True
            return None
        wait_for(finished, 420, 3)
        cid = self.chat.eval("location.pathname.split('/c/')[1].split('/')[0]")
        if not cid or not settled:
            raise ValueError('No independently settled ChatGPT conversation')
        self.freeze_visible_images(cid)
        (self.output/f'{cid}.webpage.json').write_text(json.dumps(settled, ensure_ascii=False, indent=2))
        # Save local progress even before the final source read, so interruption
        # does not require replaying already-sent prompts in another conversation.
        progress_path = self.output/f'{cid}.progress.json'
        progress = json.loads(progress_path.read_text()) if progress_path.exists() else {'prompts': []}
        progress['prompts'].append(prompt)
        progress_path.write_text(json.dumps(progress, ensure_ascii=False))
        record = {'conversationId': cid, 'prompt': prompt, 'webpageResponseId': settled[-1]['id']}
        self.report['records'].append(record)
        self.save_report()
        print(f"  completed webpage reply: {cid}", flush=True)
        time.sleep(self.delay)
        return cid

    def generate(self):
        provider = OnlineScenarioProvider()
        scenarios = self.dataset
        if scenarios is None:
            scenarios = [provider.pop_scenario(min_turns=5), provider.pop_scenario(min_turns=8)]
        if isinstance(scenarios, dict):
            scenarios = scenarios.get('scenarios')
        if not isinstance(scenarios, list) or len(scenarios) != 2 or len(scenarios[0]['turns']) < 5 or len(scenarios[1]['turns']) < 8:
            raise ValueError('ChatGPT Tier 2 requires two full scenarios of at least 5 and 8 turns')
        self.report['scenarios'] = scenarios
        self.save_report()
        ids = []
        for scenario in scenarios:
            prompts = [t if isinstance(t, str) else t['prompt'] for t in scenario['turns']]
            cid, completed = None, 0
            # A retry resumes only an exact prefix of this reserved scenario,
            # re-reading real source. It never consumes/replays another prompt.
            for path in [*self.output.glob('*.source.json'), *self.output.glob('*.progress.json')]:
                saved = json.loads(path.read_text())
                source_prompts = saved['prompts'] if path.name.endswith('.progress.json') else [
                    ''.join(p for p in m.get('content',{}).get('parts',[]) if isinstance(p,str))
                    for m in current_branch(saved) if m.get('author',{}).get('role') == 'user']
                base = source_prompts[:len(prompts)]
                extras = source_prompts[len(prompts):]
                own_revisits = all(p.startswith('Revisit this analysis: construct a concrete counterexample')
                    and re.search(r'Observation stamp: \d+\.$', p) for p in extras)
                if base and base == prompts[:len(base)] and own_revisits:
                    cid = path.name.removesuffix('.source.json').removesuffix('.progress.json')
                    actual = self.source(cid)
                    actual_prompts = [''.join(p for p in m.get('content',{}).get('parts',[]) if isinstance(p,str))
                        for m in current_branch(actual) if m.get('author',{}).get('role') == 'user']
                    if actual_prompts[:len(source_prompts)] != source_prompts or actual_prompts[:len(prompts)] != prompts[:min(len(actual_prompts), len(prompts))]:
                        raise ValueError(f'Resume source changed for {cid}: saved {len(source_prompts)}, actual {len(actual_prompts)} rounds; use a fresh output directory')
                    completed_branch(actual)
                    (self.output/f'{cid}.source.json').write_text(json.dumps(actual, ensure_ascii=False))
                    (self.output/f'{cid}.progress.json').write_text(json.dumps({'prompts': actual_prompts}, ensure_ascii=False))
                    completed = len(actual_prompts)
                    if completed < len(prompts):
                        self.chat.call('Page.navigate', {'url': 'https://chatgpt.com/c/'+cid})
                        wait_for(lambda: self.chat.eval("location.pathname==="+json.dumps('/c/'+cid)))
                    print(f'  verified existing prefix: {cid} / {completed} rounds', flush=True)
                    break
            if not cid:
                self.chat.call('Page.navigate', {'url': 'https://chatgpt.com/'})
            posted = False
            for turn in scenario['turns'][completed:]:
                prompt = turn if isinstance(turn, str) else turn['prompt']
                observed = self.send(prompt)
                if cid and cid != observed:
                    raise ValueError('Conversation changed during multi-turn scenario')
                cid = observed
                posted = True
            if posted:
                self.freeze_source(cid, expected_prompts=prompts)
            ids.append(cid)
        self.chat_ids = ids
        return {'conversationIds': ids, 'rounds': [len(s['turns']) for s in scenarios]}

    def sync(self):
        from scripts.framework.assertions import assert_full_scan_coverage
        from scripts.framework.v2_probe import snapshot
        evidence = CDPActions.trigger_deep_scan(self.options)
        ok, message = assert_full_scan_coverage(evidence, snapshot(self.options, 'chatgpt')['coverage'])
        if not ok:
            raise ValueError(message)
        self.report['scanEvidence'] = evidence
        self.ready()
        rows = self.options.eval("[...document.querySelectorAll('#list .item')].map(e=>({id:e.dataset.chatId,title:e.querySelector('.title').textContent,href:e.querySelector('a.open-link').href}))")
        if any(cid not in [r['id'] for r in rows] for cid in self.chat_ids):
            raise ValueError('Real newly generated conversations missing from scan')
        if any(not r['href'].startswith('https://chatgpt.com/c/') for r in rows):
            raise ValueError('Cross-provider source link')
        self.report['scan'] = rows
        return rows

    def open_conversation(self, cid):
        """Navigate once and fail on a native load error, without reload retries.

        The page can render a composer/region even when its detail fetch failed.
        That shell is not evidence of a loaded conversation.
        """
        self.chat.call('Page.navigate', {'url': 'https://chatgpt.com/c/'+cid})
        def loaded():
            state = self.chat.eval("""({path:location.pathname,
                failed:/无法加载此.*对话|Unable to load conversation|Couldn't load conversation/i.test(document.body?.innerText||'')})""") or {}
            if state.get('path') != '/c/'+cid:
                return None
            if state.get('failed'):
                raise ValueError('Native ChatGPT conversation failed to load; automatic reload disabled: '+cid)
            return bool(self.webpage())
        wait_for(loaded, 90, 1)

    def capture_golden(self):
        # A scene may actually generate an image. Freeze native pixels before
        # export rather than treating its image-only tool message as noise.
        from scripts.framework.chatgpt_evidence import authored_messages
        for scene_id in self.chat_ids:
            raw = json.loads((self.output/f'{scene_id}.source.json').read_text())
            if any(message.get('imagePointers') for message in authored_messages(raw)):
                if not (self.output/f'{scene_id}.image-webpage-evidence.json').is_file():
                    raise ValueError('Missing independent scene image evidence captured during live generation')
        cid = self.golden['image']
        self.open_conversation(cid)
        self.image_evidence = capture_webpage_images(self.chat, cid, timeout=90, provider_id='chatgpt')
        (self.output/'image-webpage-evidence.json').write_text(json.dumps(self.image_evidence))
        for questionnaire in self.golden['questionnaires']:
            cid = questionnaire['id']
            self.open_conversation(cid)
            def visible():
                if self.chat.eval('location.pathname') != '/c/'+cid:
                    return None
                text = self.chat.eval('document.body.innerText') or ''
                return text if all(label in text for label in questionnaire['labels']) else None
            text = wait_for(visible, 90, 1)
            (self.output/f'{cid}.golden-webpage.txt').write_text(text)
        return {'imageCount': len(self.image_evidence), 'questionnaireIds': [q['id'] for q in self.golden['questionnaires']]}

    def golden_exports(self):
        from scripts.framework.chatgpt_evidence import compact
        from scripts.framework.html_evidence import TreeParser
        from scripts.framework.cases.export import PdfExportDownloadCase
        folder = self.output/'downloads'
        docs = {}
        for path in (folder/'json').glob('*.json'):
            document = json.loads(path.read_text())
            docs[document['conversation']['index']['key']['conversationId']] = (path, document)
        image_path, image_document = docs[self.golden['image']]
        resources = image_document['resources']
        entries = [(name, (image_path.parent/name).read_bytes()) for name in resources.values()]
        differences = assert_image_files(self.options, self.image_evidence, entries)
        markdown = (folder/'markdown'/(image_path.stem+'.md')).read_text()
        html = (folder/'html'/(image_path.stem+'.html')).read_text()
        if len(re.findall(r'!\[[^\]]*\]\([^)]+\)', markdown)) != len(entries) or len(re.findall(r'<img\b', html)) != len(entries):
            raise ValueError('Image placement is missing or duplicated')
        image_pdf = PdfExportDownloadCase._extract_pdf_info(str(folder/'pdf'/(image_path.stem+'.pdf')))
        if image_pdf.get('imageXObjectCount') != len(entries):
            raise ValueError('PDF image embedding missing/duplicated')
        self.gate('image_pixels', lambda: {'images': len(entries), 'pixelComparison': differences, 'pdfImageObjects': image_pdf['imageXObjectCount']})
        reports = []
        for quiz in self.golden['questionnaires']:
            path, document = docs[quiz['id']]
            if document['conversation']['detail']['quality']['status'] != quiz['quality']:
                raise ValueError('Questionnaire completeness claim differs from actual evidence')
            md = (folder/'markdown'/(path.stem+'.md')).read_text()
            ht = TreeParser((folder/'html'/(path.stem+'.html')).read_text()).root.text()
            pdf = PdfExportDownloadCase._extract_pdf_info(str(folder/'pdf'/(path.stem+'.pdf')))
            for fmt, text in [('markdown', md), ('html', ht), ('pdf', pdf.get('text', ''))]:
                for label in quiz['labels']:
                    if compact(label) not in compact(text):
                        raise ValueError(f'{quiz["id"]} {fmt}: missing questionnaire label {label}')
                if quiz['quality'] == 'partial' and compact('static snapshot') not in compact(text):
                    raise ValueError(f'{quiz["id"]} {fmt}: missing static snapshot notice')
            reports.append({'id': quiz['id'], 'labels': len(quiz['labels']), 'quality': quiz['quality']})
        self.gate('questionnaires', lambda: reports)
        return reports

    def stored(self, cid):
        install_probe(self.options)
        account_id = self.options.eval("document.getElementById('accountIdSelect').value")
        return self.options.eval('globalThis.__tier2V2.storedConversation('+json.dumps({'accountId': account_id, 'conversationId': cid})+')', await_promise=True)

    def lifecycle(self):
        install_probe(self.options)
        prior = self.options.eval('globalThis.__tier2V2.getSettings()', await_promise=True)
        self.options.eval('(async()=>{globalThis.__tier2PriorDirectory = await globalThis.__tier2V2.getDirectoryHandle()})()', await_promise=True)
        try:
            if not CDPActions.setup_live_save(self.options, True):
                raise ValueError('Live Save setup failed')
            self.options.eval("globalThis.__tier2V2.updateSettings({enabledDisk:true,exportDelivery:'folderWriter',defaultFormat:'markdown',includeAssets:true})", await_promise=True)
            self.chat.call('Page.navigate', {'url': 'https://chatgpt.com/'})
            prompt = OnlineScenarioProvider().pop_ephemeral_query()
            cid = self.send(prompt)
            self.report['ephemeralId'] = cid
            self.save_report()
            def committed():
                state = self.stored(cid)
                return state if state and state.get('index') and state.get('detail') and state.get('exportRecord') else None
            wait_for(committed, 120, 1)
            def disk_contains(conversation_id, expected_prompt):
                flush = CDPActions.flush_live_save_to_disk(self.options, str(self.output))
                files = [Path(p) for p in flush.get('files', []) if p.endswith('.md')]
                for path in files:
                    text = path.read_text()
                    if conversation_id in text and expected_prompt in text:
                        return {'file': str(path), 'bytes': path.stat().st_size}
                return None
            live_file = wait_for(lambda: disk_contains(cid, prompt), 120, 1)
            self.gate('live_disk_save', lambda: live_file)
            older = self.chat_ids[0]
            self.chat.call('Page.navigate', {'url': 'https://chatgpt.com/c/'+older})
            append = ('Revisit this analysis: construct a concrete counterexample that violates one assumption '
                'of the final algorithm, explain the failed invariant in LaTeX, and give a runnable regression '
                'test and a Markdown table comparing the valid and invalid cases. '
                f'Observation stamp: {int(time.time())}.')
            previous_source = json.loads((self.output/f'{older}.source.json').read_text())
            expected = [''.join(p for p in m.get('content', {}).get('parts', []) if isinstance(p, str))
                        for m in current_branch(previous_source) if m.get('author', {}).get('role') == 'user']
            self.send(append)
            self.freeze_source(older, expected_prompts=expected+[append])
            self.assert_export_advancement(older)
            def promoted():
                ids = self.options.eval("[...document.querySelectorAll('#list .item')].map(e=>e.dataset.chatId)")
                return ids if ids and ids[0] == older else None
            order = wait_for(promoted, 120, 1)
            updated_file = wait_for(lambda: disk_contains(older, append), 120, 1)
            self.gate('passive_promotion', lambda: {'withoutSyncOrReload': True, 'firstId': order[0], 'updatedDiskFile': updated_file})
            return {'ephemeralId': cid, 'liveDisk': live_file, 'promotedId': older}
        finally:
            # Restore user settings; the test directory is retained as evidence.
            self.options.eval('globalThis.__tier2V2.setDirectoryHandle(globalThis.__tier2PriorDirectory ?? null)', await_promise=True)
            self.options.eval('delete globalThis.__tier2PriorDirectory')
            self.options.eval('globalThis.__tier2V2.updateSettings('+json.dumps(prior)+')', await_promise=True)

    def click_native(self, expression):
        point = wait_for(lambda: self.chat.eval("(()=>{const e=("+expression+");if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()"))
        for kind in ['mouseMoved', 'mousePressed', 'mouseReleased']:
            self.chat.call('Input.dispatchMouseEvent', {'type': kind, **point,
                **({'button': 'left', 'clickCount': 1} if kind != 'mouseMoved' else {})})

    def confirmed_deletion(self):
        cid = self.report['ephemeralId']
        before = self.stored(cid)
        if not all(before.get(name) for name in ['index', 'detail', 'exportRecord']):
            raise ValueError('Deletion must start with the same-key Index, Detail and ExportRecord')
        retained_ids = self.options.eval("[...document.querySelectorAll('#list .item')].map(e=>e.dataset.chatId).filter(id=>id!=="+json.dumps(cid)+")")
        # Record other-account indexes too; the page operation must be scoped to this account.
        other_before = self.options.eval("(async()=>{const accounts=await __tier2V2.listAccounts();return Promise.all(accounts.filter(a=>a.id!==document.getElementById('accountIdSelect').value).map(async a=>({id:a.id,account:await __tier2V2.getAccount(a.id)})))})()", await_promise=True)
        self.open_conversation(cid)
        # The sidebar contains duplicate hidden mobile triggers. Use the current
        # conversation toolbar and activate its tab through the extension API.
        self.options.eval("(async()=>{const tabs=await chrome.tabs.query({});const t=tabs.find(t=>t.url==="+json.dumps('https://chatgpt.com/c/'+cid)+");if(!t)throw Error('No deletion source tab');await chrome.windows.update(t.windowId,{focused:true});await chrome.tabs.update(t.id,{active:true})})()", await_promise=True)
        opener = "[...document.querySelectorAll('button')].find(e=>['更多','More'].includes(e.getAttribute('aria-label'))&&e.getBoundingClientRect().width>0)"
        # A hydrated composer can precede the toolbar's event handlers. Retry
        # only while the menu is closed, never toggle an already-open menu shut.
        def open_menu():
            if self.chat.eval("!!document.querySelector('[role=menuitem]')"):
                return True
            # Radix menus may ignore pointer input in a background CDP tab.
            # Focus the observed native trigger and use its keyboard activation.
            self.chat.eval('('+opener+').focus()')
            for kind in ['keyDown', 'keyUp']:
                self.chat.call('Input.dispatchKeyEvent', {'type': kind, 'key': ' ', 'code': 'Space', 'windowsVirtualKeyCode': 32})
            return self.chat.eval("!!document.querySelector('[role=menuitem]')")
        wait_for(open_menu, 30, .5)
        self.click_native("[...document.querySelectorAll('[role=menuitem]')].find(e=>['删除','Delete'].includes(e.innerText.trim()))")
        self.click_native("[...document.querySelectorAll('[role=dialog] button,[role=alertdialog] button')].find(e=>['删除','删除聊天','Delete','Delete chat'].includes(e.innerText.trim()))")
        def removed():
            state = self.stored(cid)
            ids = self.options.eval("[...document.querySelectorAll('#list .item')].map(e=>e.dataset.chatId)")
            return state if state and all(state.get(k) is None for k in ['index', 'detail', 'exportRecord']) and cid not in ids else None
        wait_for(removed, 120, 1)
        remaining = self.options.eval("[...document.querySelectorAll('#list .item')].map(e=>e.dataset.chatId)")
        if any(x not in remaining for x in retained_ids):
            raise ValueError('Deleting one ephemeral conversation removed unrelated rows')
        for item in other_before:
            if self.options.eval('__tier2V2.getAccount('+json.dumps(item['id'])+')', await_promise=True) != item['account']:
                raise ValueError('Deletion changed another account')
        self.report['scan'] = [row for row in self.report.get('scan', []) if row['id'] != cid]
        return {'conversationId': cid, 'preexisting': ['index', 'detail', 'exportRecord'],
            'removed': ['index', 'detail', 'exportRecord'], 'withoutWorkbenchReload': True,
            'retainedConversations': len(retained_ids), 'otherAccounts': len(other_before)}

    def popup_export(self):
        cid = self.chat_ids[0]
        self.open_conversation(cid)
        tab_id = self.options.eval("(async()=>{const tabs=await chrome.tabs.query({});const t=tabs.find(t=>t.url==="+json.dumps('https://chatgpt.com/c/'+cid)+");if(!t)throw Error('No source tab');await chrome.windows.update(t.windowId,{focused:true});await chrome.tabs.update(t.id,{active:true});return t.id})()", await_promise=True)
        folder = (self.output/'popup-downloads').resolve(); folder.mkdir(exist_ok=True)
        self.browser.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(folder)})
        popup = None
        target_id = None
        try:
            self.options.eval('chrome.action.openPopup()', await_promise=True, user_gesture=True)
            target = wait_for(lambda: next((t for t in get_tabs(self.port) if t.get('url') == f'chrome-extension://{self.ext_id}/src/ui/popup/popup.html'), None), 30)
            target_id = target['id']; popup = CDPConnection(target['webSocketDebuggerUrl'])
            wait_for(lambda: popup.eval("!!document.getElementById('btnCurrent')&&!document.getElementById('btnCurrent').disabled"), 30)
            popup.eval("document.querySelector('[data-format=markdown]').click()", user_gesture=True)
            wait_for(lambda: popup.eval("!document.getElementById('btnCurrent').disabled&&document.querySelector('[data-format=markdown]').getAttribute('aria-pressed')==='true'"))
            popup.eval("document.getElementById('btnCurrent').click()", user_gesture=True)
            fresh = wait_for(lambda: [p for p in folder.iterdir() if p.is_file() and p.suffix != '.crdownload'], 120)
            wait_for(lambda: popup.eval("!document.getElementById('btnCurrent').disabled"))
            status = popup.eval("document.getElementById('status').textContent")
            if 'Download initiated' not in status and '已发起下载' not in status:
                raise ValueError('Popup export did not acknowledge delivery: '+status)
            texts = []
            for path in fresh:
                if path.suffix == '.zip':
                    with zipfile.ZipFile(path) as z:
                        texts.extend(z.read(n).decode() for n in z.namelist() if n.endswith('.md'))
                elif path.suffix == '.md': texts.append(path.read_text())
            if len(texts) != 1 or cid not in texts[0]:
                raise ValueError('Popup physical export has the wrong conversation')
            source = json.loads((self.output/f'{cid}.source.json').read_text())
            prompt = next(''.join(p for p in m['content']['parts'] if isinstance(p,str)) for m in current_branch(source) if m.get('author',{}).get('role') == 'user')
            if prompt not in texts[0]: raise ValueError('Popup export lacks first prompt')
            return {'conversationId': cid, 'sourceTabId': tab_id, 'status': status, 'files': [str(p) for p in fresh]}
        finally:
            if popup: popup.close()
            if target_id: self.browser.call('Target.closeTarget', {'targetId': target_id})
            self.browser.call('Browser.setDownloadBehavior', {'behavior': 'default'})

    def exports(self):
        folder = (self.output/'downloads').resolve()
        folder.mkdir(exist_ok=True)
        self.browser.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(folder)})
        results = []
        try:
            self.options.eval("if(document.getElementById('skipExported').checked)document.getElementById('skipExported').click();if(!document.getElementById('includeAssets').checked)document.getElementById('includeAssets').click()", user_gesture=True)
            self.ready()
            for fmt in ['markdown', 'html', 'json', 'pdf']:
                self.options.eval("document.getElementById('format').value="+json.dumps(fmt)+";document.getElementById('format').dispatchEvent(new Event('change',{bubbles:true}))", user_gesture=True)
                self.ready()
                self.options.eval("document.getElementById('btnSelectAll').click()", user_gesture=True)
                before = set(folder.iterdir())
                self.options.eval("document.getElementById('btnExport').click()", user_gesture=True)
                self.ready(max(600, len(self.report['scan'])*120))
                fresh = wait_for(lambda: [p for p in folder.iterdir() if p not in before and p.is_file() and p.suffix != '.crdownload'], 60)
                if len(fresh) != 1:
                    raise ValueError('Ambiguous physical download')
                target = folder/(fmt+'.zip')
                fresh[0].replace(target)
                with zipfile.ZipFile(target) as archive:
                    if archive.testzip():
                        raise ValueError('ZIP CRC failure')
                    archive.extractall(folder/fmt)
                results.append({'format': fmt, 'bytes': target.stat().st_size, 'status': self.options.eval("document.getElementById('status').textContent")})
                print('  physical download: '+json.dumps(results[-1], ensure_ascii=False), flush=True)
        finally:
            self.browser.call('Browser.setDownloadBehavior', {'behavior': 'default'})
        valid, summary, details = validate_json_archive(folder/'json.zip', min_conversations=len(self.report['scan']))
        if not valid:
            raise ValueError((summary, details))
        return results

    def run(self):
        """Compatibility entry point; use the shared platform DAG and lifecycle."""
        from scripts.framework.platforms.core import run_session
        from scripts.framework.platforms.chatgpt import ChatGPTPlugin
        return run_session(ChatGPTPlugin.session(self), {})
