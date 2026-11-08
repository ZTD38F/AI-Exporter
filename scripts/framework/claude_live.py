"""Claude CDP operations. Source APIs are read once at scenario boundaries, never polled."""
import json
import os
import shutil
import re
import subprocess
import time
import zipfile
from pathlib import Path

from scripts.framework.claude_quota import QUOTA_EXPRESSION
from scripts.cdp_client import CDPConnection, get_tabs, get_browser_ws_url
from scripts.framework.actions import CDPActions
from scripts.framework.browser_acceptance import BrowserAcceptance
from scripts.framework.live_utils import wait_for
from scripts.framework.scenario_provider import OnlineScenarioProvider
from scripts.framework.v2_probe import snapshot, install_probe

ROOT_MESSAGE = '00000000-0000-4000-8000-000000000000'


def current_branch(raw):
    nodes = {m['uuid']: m for m in raw['chat_messages']}
    if len(nodes) != len(raw['chat_messages']):
        raise ValueError('Duplicate Claude message UUID')
    current, seen, result = raw.get('current_leaf_message_uuid'), set(), []
    if not current:
        raise ValueError('Missing Claude current leaf')
    while current and current != ROOT_MESSAGE:
        if current in seen or current not in nodes:
            raise ValueError('Cyclic or missing Claude branch parent')
        seen.add(current)
        message = nodes[current]
        result.append(message)
        current = message.get('parent_message_uuid')
    return list(reversed(result))


def message_text(message):
    blocks = message.get('content', [])
    return ''.join(b.get('text', '') for b in blocks if b.get('type') == 'text') if blocks else message.get('text', '')


def completed_branch(raw):
    messages = current_branch(raw)
    if not messages or messages[0].get('sender') != 'human':
        raise ValueError('Claude source has no initial human turn')
    for index, message in enumerate(messages):
        if message.get('sender') != ('human' if index % 2 == 0 else 'assistant'):
            raise ValueError('Unexpected Claude role sequence')
        if message.get('truncated'):
            raise ValueError('Claude source message is truncated')
        if message.get('sender') == 'assistant':
            if message.get('stop_reason') != 'end_turn':
                raise ValueError(f"Claude source contains an incomplete reply: {message.get('uuid')} (stop_reason={message.get('stop_reason')})")
            if any(not b.get('stop_timestamp') for b in message.get('content', [])):
                raise ValueError('Claude source contains an unfinished content block')
    if len(messages) % 2:
        raise ValueError('Claude source ends before an assistant reply')
    return messages


class ClaudeLiveRunner(BrowserAcceptance):
    platform_id = 'claude'

    def __init__(self, port=9222, output_dir=None, dataset=None, delay=6, options=None):
        self.port, self.delay, self.dataset = port, delay, dataset
        self.root = Path(__file__).resolve().parents[2]
        self.extension_root = self.root
        self.output = Path(output_dir or self.root/'tests/output/claude_live').resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.config = options or {}
        self.report = {'provider': self.platform_id, 'gates': {}, 'records': [], 'sourceRequests': 0,
                       'modelPolicy': {'family': 'haiku', 'fallback': False}}
        self.chat = self.options = self.browser = None
        self.chat_ids, self.initial_exports = [], {}
        self.org = None
        self.rate_limited = False

    def prepare_extension(self):
        """Required Claude permission applies only to this ignored local install copy."""
        self.extension_root = self.root
        if os.environ.get('TIER2_CLAUDE_REQUIRED_HOSTS') == '0':
            self.report['testInstallMode'] = 'optional-claude-hosts'
            return
        target = self.root/'temp/tier2-claude-required-hosts'
        shutil.rmtree(target, ignore_errors=True)
        target.mkdir(parents=True)
        for name in ('src', 'dist', 'lib', 'icons', '_locales'):
            shutil.copytree(self.root/name, target/name)
        manifest = json.loads((self.root/'manifest.json').read_text())
        hosts = ['https://claude.ai/*']
        manifest['host_permissions'] = list(dict.fromkeys(manifest.get('host_permissions', [])+hosts))
        manifest['optional_host_permissions'] = [host for host in manifest.get('optional_host_permissions', []) if host not in hosts]
        (target/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
        self.extension_root = target
        self.report['testInstallMode'] = 'required-claude-hosts'

    def prepare(self):
        subprocess.run(['node', 'build.js'], cwd=self.root, check=True)
        self.prepare_extension()
        target = next((t for t in get_tabs(self.port) if t.get('url', '').startswith('https://claude.ai/')), None)
        if not target:
            raise ValueError('Open the logged-in Claude test account on this CDP port')
        self.chat = CDPConnection(target['webSocketDebuggerUrl'])
        self.browser = CDPConnection(get_browser_ws_url(self.port))
        self.clean_install()
        loaded = self.browser.call('Extensions.loadUnpacked', {'path': str(self.extension_root)})
        if loaded.get('error'):
            raise ValueError(loaded['error'])
        self.ext_id = loaded['result']['id']
        url = f'chrome-extension://{self.ext_id}/src/ui/options/options.html'
        target = wait_for(lambda: next((t for t in get_tabs(self.port) if t.get('url', '').startswith(url)), None), 20)
        self.options = CDPConnection(target['webSocketDebuggerUrl'])
        self.ready()
        if not CDPActions.verify_onboarding_tour(self.port, self.ext_id, provider_id=self.platform_id):
            raise ValueError('Fresh-install onboarding did not complete')
        self.gate('onboarding', lambda: {'physicalTour': True})
        permission = "chrome.permissions.contains({origins:['https://claude.ai/*']})"
        if not self.options.eval(permission, await_promise=True):
            raise ValueError('Claude site permission missing after onboarding')
        self.ready()
        state = snapshot(self.options, self.platform_id)
        if state['account']['providerId'] != self.platform_id:
            raise ValueError('Canonical Claude account not selected')
        self.org = state['account']['providerAccountId']
        previous_origin = self.chat.eval('performance.timeOrigin')
        self.chat.call('Page.reload')  # Replace invalidated extension document contexts once.
        wait_for(lambda: self.chat.eval('performance.timeOrigin') != previous_origin)
        wait_for(lambda: self.chat.eval("document.readyState==='complete'&&!!document.querySelector('[data-testid=chat-input]')"))
        return {'extensionId': self.ext_id, 'organization': self.org, 'cleanInstall': True}

    def source(self, cid):
        if self.rate_limited:
            raise ValueError('Claude evidence HTTP 429 already observed; further reads stopped')
        uuid = r'[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}'
        if not all(isinstance(value, str) and re.fullmatch(uuid, value, re.I) for value in (cid, self.org)):
            raise ValueError('Invalid Claude evidence identity')
        frame = self.chat.call('Page.getFrameTree')['result']['frameTree']['frame']['id']
        world = self.chat.call('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'tier2-source-evidence'})['result']['executionContextId']
        path = f'/api/organizations/{self.org}/chat_conversations/{cid}?tree=true&rendering_mode=messages&render_all_tools=true'
        self.report['sourceRequests'] += 1
        self.save_report()
        response = self.chat.call('Runtime.evaluate', {'contextId': world, 'awaitPromise': True, 'returnByValue': True,
            'expression': "(async()=>{const r=await fetch("+json.dumps(path)+",{credentials:'include'});return r.ok?await r.json():{sourceError:r.status,retryAfter:r.headers.get('retry-after')};})()"})
        result = response.get('result', {})
        raw = result.get('result', {}).get('value')
        if result.get('exceptionDetails') or not isinstance(raw, dict):
            raise ValueError('Independent Claude source unavailable')
        if raw.get('sourceError'):
            self.rate_limited = raw['sourceError'] == 429
            raise ValueError(f"Claude evidence HTTP {raw['sourceError']}; no retries; Retry-After={raw.get('retryAfter')}")
        if raw.get('uuid') != cid:
            raise ValueError('Claude evidence response identity mismatch')
        return raw

    def freeze_source(self, cid, expected_prompts=None):
        raw = self.source(cid)
        messages = completed_branch(raw)
        prompts = [message_text(m) for m in messages if m['sender'] == 'human']
        if expected_prompts is not None and prompts != expected_prompts:
            raise ValueError('Final Claude source differs from submitted prompts')
        (self.output/f'{cid}.source.json').write_text(json.dumps(raw, ensure_ascii=False), encoding='utf-8')
        return raw

    def webpage(self):
        return self.chat.eval("""[...document.querySelectorAll('[data-testid=user-message],[data-testid=assistant-message]')].map(e=>{
            const clone=e.cloneNode(true);clone.querySelectorAll('.katex').forEach(math=>math.replaceWith(document.createTextNode(math.querySelector('annotation')?.textContent||'[MISSING MATH SOURCE]')));
            clone.querySelectorAll('button,svg,style,script,[aria-hidden=true]').forEach(e=>e.remove());
            return {id:e.dataset.turnKey,role:e.dataset.testid==='user-message'?'user':'assistant',text:clone.textContent,html:e.outerHTML};})""") or []

    def assert_message_quota(self):
        notice = self.chat.eval(QUOTA_EXPRESSION)
        if isinstance(notice, str) and notice:
            self.report['messageQuota'] = {'notice': notice, 'http429Observed': False}
            self.save_report()
            raise ValueError('Claude native message quota exhausted (not HTTP 429): '+notice)

    def ensure_haiku(self):
        """Select an available native Haiku option, never an upgrade or fallback."""
        state_expression = r"""(()=>{const e=document.querySelector('[data-testid=model-selector-dropdown]');
            if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return null;
            const label=e.getAttribute('aria-label')||e.innerText;
            return {label,haiku:/\bhaiku\b/i.test(label)};})()"""
        state = wait_for(lambda: self.chat.eval(state_expression), 30)
        if state['haiku']:
            return {'family': 'haiku', 'label': state['label']}
        try:
            self.chat.eval("""(()=>{const e=document.querySelector('[data-testid=model-selector-dropdown]');
                if(e.getAttribute('aria-expanded')!=='true')e.click();})()""", user_gesture=True)
            wait_for(lambda: self.chat.eval("""(()=>{const b=document.querySelector('[data-testid=model-selector-dropdown]');
                return [...document.querySelectorAll('[role=menu]')].some(e=>e.getAttribute('aria-labelledby')===b?.id);})()"""), 10)
            choices_expression = """[...document.querySelectorAll('[role=menu] [data-model-id]')].map(e=>({
                id:e.dataset.modelId,label:e.innerText,selectable:e.getAttribute('role')==='menuitemradio'
                    &&!e.hasAttribute('data-disabled')&&e.getAttribute('aria-disabled')!=='true'}))"""
            choices = self.chat.eval(choices_expression) or []
            def available(items):
                return next((m for m in items if m['selectable'] and re.search(r'\bhaiku\b', m['id'], re.I)), None)
            selected = available(choices)
            if not selected:
                submenu = self.chat.eval("""(()=>{const b=document.querySelector('[data-testid=model-selector-dropdown]');
                    const menu=[...document.querySelectorAll('[role=menu]')].find(e=>e.getAttribute('aria-labelledby')===b?.id);
                    const e=[...(menu?.querySelectorAll('[role=menuitem][aria-haspopup=menu]')||[])]
                        .find(e=>/^(更多模型|More models)$/i.test(e.innerText.split('\\n')[0].trim()));
                    if(!e)return null;if(e.getAttribute('aria-expanded')!=='true')e.click();return e.id;})()""", user_gesture=True)
                if submenu:
                    wait_for(lambda: self.chat.eval("[...document.querySelectorAll('[role=menu]')].some(e=>e.getAttribute('aria-labelledby')==="+json.dumps(submenu)+")"), 10)
                    choices = self.chat.eval(choices_expression) or []
                    selected = available(choices)
            if not selected:
                self.report['modelSelection'] = {'status': 'blocked', 'family': 'haiku', 'available': choices}
                self.save_report()
                raise ValueError('Claude Haiku is unavailable on this account; refusing another model or an upgrade')
            clicked = self.chat.eval("""(()=>{const e=[...document.querySelectorAll('[role=menu] [role=menuitemradio][data-model-id]')]
                .find(e=>e.dataset.modelId==="""+json.dumps(selected['id'])+"""&&!e.hasAttribute('data-disabled')&&e.getAttribute('aria-disabled')!=='true');
                if(!e)return false;e.scrollIntoView({block:'nearest'});e.click();return true;})()""", user_gesture=True)
            if not clicked:
                raise ValueError('Claude Haiku selection changed; no message sent')
            def verified():
                current = self.chat.eval(state_expression)
                return current if current and current['haiku'] else None
            state = wait_for(verified, 10)
            result = {'family': 'haiku', 'id': selected['id'], 'label': state['label']}
            self.report['modelSelection'] = {'status': 'selected', **result}
            self.save_report()
            return result
        finally:
            self.chat.eval("""(()=>{const e=document.querySelector('[data-testid=model-selector-dropdown]');
                if(e?.getAttribute('aria-expanded')==='true')e.click();})()""", user_gesture=True)

    def send(self, prompt):
        model = self.ensure_haiku()
        self.assert_message_quota()
        previous_ids = {m.get('id') for m in self.webpage() if m['role'] == 'assistant'}
        selector = '[data-testid=chat-input]'
        wait_for(lambda: self.chat.eval('!!document.querySelector('+json.dumps(selector)+')'))
        self.chat.eval("(()=>{const e=document.querySelector('[data-testid=chat-input]');e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r)})()", user_gesture=True)
        self.chat.call('Input.insertText', {'text': prompt})
        def can_send():
            self.assert_message_quota()
            return self.chat.eval("!!document.querySelector('[data-testid=chat-input-send]:not(:disabled)')")
        wait_for(can_send)
        attempt = {'prompt': prompt, 'model': model, 'dispatched': False}
        self.report.setdefault('sendAttempts', []).append(attempt)
        self.save_report()  # A failed/partial reply must not hide the attempted send.
        dispatched = self.chat.eval(r"""(()=>{const model=document.querySelector('[data-testid=model-selector-dropdown]');
            if(!model||!/\bhaiku\b/i.test(model.getAttribute('aria-label')||model.innerText))return false;
            const e=document.querySelector('[data-testid=chat-input-send]:not(:disabled)');if(!e)return false;e.click();return true})()""", user_gesture=True)
        attempt['dispatched'] = dispatched is True
        self.save_report()
        if dispatched is not True:
            raise ValueError('Claude send was not dispatched; refusing to record a reply')
        previous, stable, settled = None, 0, None
        def finished():
            nonlocal previous, stable, settled
            self.assert_message_quota()
            state = self.chat.eval("""({stop:!!document.querySelector('[data-testid=chat-input-stop]'),
                error:document.querySelector('[data-testid=failed-send-status-region]')?.innerText,
                question:!!document.querySelector('[role=checkbox],button[aria-label="提交"],button[aria-label="Submit"]')||/正在提问|Asking a question/.test([...document.querySelectorAll('[data-testid=assistant-message]')].at(-1)?.innerText||'')})""") or {}
            if state.get('question'):
                raise ValueError('Native Claude interaction requires input; refusing to record an unfinished reply')
            if state.get('error'):
                raise ValueError('Claude native send failed: '+state['error'])
            messages = self.webpage()
            users = [m for m in messages if m['role'] == 'user']
            assistants = [m for m in messages if m['role'] == 'assistant']
            if state.get('stop') or state.get('question') or not users or users[-1]['text'].strip() != prompt.strip() or not assistants or messages[-1]['role'] != 'assistant' or assistants[-1].get('id') in previous_ids or not assistants[-1]['text'].strip():
                stable = 0
                return None
            if not assistants[-1].get('id'):
                raise ValueError('Claude reply is missing its native turn identity')
            value = json.dumps(messages, sort_keys=True)
            stable = stable+1 if value == previous else 0
            previous = value
            if stable >= 3:
                settled = messages
                return True
            return None
        wait_for(finished, 420, 3)
        cid = self.chat.eval("location.pathname.split('/chat/')[1]?.split('/')[0]")
        if not cid or not settled:
            raise ValueError('No independently settled Claude conversation')
        (self.output/f'{cid}.webpage.json').write_text(json.dumps(settled, ensure_ascii=False), encoding='utf-8')
        path = self.output/f'{cid}.progress.json'
        progress = json.loads(path.read_text()) if path.exists() else {'prompts': []}
        progress['prompts'].append(prompt)
        path.write_text(json.dumps(progress, ensure_ascii=False), encoding='utf-8')
        self.report['records'].append({'conversationId': cid, 'prompt': prompt})
        self.save_report()
        time.sleep(self.delay)
        return cid

    def generate(self):
        self.assert_message_quota()
        reservation = self.output/'scenarios.json'
        if reservation.exists():
            scenarios = json.loads(reservation.read_text())
            if self.dataset is not None and scenarios != (self.dataset.get('scenarios') if isinstance(self.dataset, dict) else self.dataset):
                raise ValueError('Resume dataset changed; use a fresh output directory')
        else:
            scenarios = self.dataset
            if scenarios is None:
                provider = OnlineScenarioProvider()
                scenarios = [provider.pop_scenario(min_turns=5), provider.pop_scenario(min_turns=8)]
            if isinstance(scenarios, dict):
                scenarios = scenarios.get('scenarios')
        if not isinstance(scenarios, list) or len(scenarios) != 2 or any(len(s.get('turns', [])) < minimum for s, minimum in zip(scenarios, (5, 8))):
            raise ValueError('Claude Tier 2 requires two full scenarios of at least 5 and 8 turns')
        reservation.write_text(json.dumps(scenarios, ensure_ascii=False), encoding='utf-8')
        self.report['scenarios'] = scenarios
        for scenario in scenarios:
            prompts = [t if isinstance(t, str) else t['prompt'] for t in scenario['turns']]
            cid, completed = None, 0
            for path in self.output.glob('*.progress.json'):
                saved = json.loads(path.read_text())['prompts']
                if saved and saved == prompts[:len(saved)]:
                    cid = path.name.removesuffix('.progress.json')
                    raw = self.source(cid)  # Exactly one independent read when resuming.
                    try:
                        completed_branch(raw)
                    except ValueError:
                        (self.output/f'{cid}.incomplete.source.json').write_text(json.dumps(raw, ensure_ascii=False), encoding='utf-8')
                        raise
                    actual = [message_text(m) for m in completed_branch(raw) if m['sender'] == 'human']
                    if actual[:len(saved)] != saved or actual != prompts[:len(actual)]:
                        raise ValueError('Resume source changed; refusing to replay prompts')
                    completed = len(actual)
                    path.write_text(json.dumps({'prompts': actual}, ensure_ascii=False), encoding='utf-8')
                    (self.output/f'{cid}.source.json').write_text(json.dumps(raw, ensure_ascii=False), encoding='utf-8')
                    break
            if completed < len(prompts):
                self.chat.call('Page.navigate', {'url': 'https://claude.ai/chat/'+cid if cid else 'https://claude.ai/new'})
            posted = False
            for prompt in prompts[completed:]:
                observed = self.send(prompt)
                if cid and cid != observed:
                    raise ValueError('Claude conversation changed during scenario')
                cid, posted = observed, True
            if posted:
                self.freeze_source(cid, prompts)
            self.chat_ids.append(cid)
        return {'conversationIds': self.chat_ids, 'rounds': [len(s['turns']) for s in scenarios]}

    def page_badge(self):
        return wait_for(lambda: self.chat.eval("(()=>{const e=document.getElementById('geminiExportBadge');const r=e?.getBoundingClientRect();return r?.width&&r?.height?{width:r.width,height:r.height}:null})()"), 15)

    def passive_sidebar(self):
        def captured():
            visible = self.chat.eval("[...document.querySelectorAll('a[href^=\"/chat/\"]')].map(e=>e.getAttribute('href').split('/')[2])") or []
            state = snapshot(self.options, self.platform_id)
            ids = {r['key']['conversationId'] for r in state['rows']}
            return {'sidebarIds': visible, 'storedIds': sorted(ids)} if len(set(visible)) >= 2 and set(visible) <= ids else None
        return wait_for(captured, 20, 1)

    def sync(self):
        self.report['scanEvidence'] = CDPActions.trigger_deep_scan(self.options)
        self.ready()
        rows = self.options.eval("[...document.querySelectorAll('#list .item')].map(e=>({id:e.dataset.chatId,title:e.querySelector('.title').textContent,href:e.querySelector('a.open-link').href}))")
        self.report['scan'] = rows
        self.save_report()
        if not self.report['scanEvidence'].get('started') or not self.report['scanEvidence'].get('finished'):
            raise ValueError('Claude scan did not complete its list request')
        if not rows or not set(self.chat_ids) <= {r['id'] for r in rows}:
            raise ValueError('Claude scan missed freshly generated conversations')
        if any(r['href'] != 'https://claude.ai/chat/'+r['id'] for r in rows):
            raise ValueError('Cross-provider source link')
        return rows

    def scan_coverage(self):
        from scripts.framework.assertions import assert_full_scan_coverage
        ok, message = assert_full_scan_coverage(self.report['scanEvidence'], snapshot(self.options, self.platform_id)['coverage'])
        if not ok:
            raise ValueError(message)
        return {'sourceExhaustionVerified': True}

    def assert_full_exports(self):
        from scripts.framework.claude_evidence import assert_full_exports
        return assert_full_exports(self.root, self.output, self.chat_ids)

    def lifecycle(self):
        install_probe(self.options)
        prior = self.options.eval('globalThis.__tier2V2.getSettings()', await_promise=True)
        self.options.eval('(async()=>{globalThis.__tier2PriorDirectory = await globalThis.__tier2V2.getDirectoryHandle()})()', await_promise=True)
        try:
            if not CDPActions.setup_live_save(self.options, True):
                raise ValueError('Live Save setup failed')
            self.options.eval("globalThis.__tier2V2.updateSettings({enabledDisk:true,exportDelivery:'folderWriter',defaultFormat:'markdown',includeAssets:true})", await_promise=True)
            self.chat.call('Page.navigate', {'url': 'https://claude.ai/new'})
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
            self.chat.call('Page.navigate', {'url': 'https://claude.ai/chat/'+older})
            append = ('Revisit this analysis: construct a concrete counterexample that violates one assumption '
                'of the final algorithm, explain the failed invariant in LaTeX, and give a runnable regression '
                'test and a Markdown table comparing the valid and invalid cases. '
                f'Observation stamp: {int(time.time())}.')
            previous_source = json.loads((self.output/f'{older}.source.json').read_text())
            expected = [message_text(m) for m in current_branch(previous_source) if m['sender'] == 'human']
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
        # CDP pointer events can be silently dropped by an occluded Chrome on
        # macOS. Activate the actual native DOM control, as other Tier 2 cases do.
        wait_for(lambda: self.chat.eval("(()=>{const e=("+expression+");if(!e||e.disabled||!e.getBoundingClientRect().width)return false;e.click();return true})()", user_gesture=True))

    def popup_export(self):
        cid = self.chat_ids[0]
        self.open_conversation(cid)
        tab_id = self.options.eval("(async()=>{const tabs=await chrome.tabs.query({});const t=tabs.find(t=>t.url==="+json.dumps('https://claude.ai/chat/'+cid)+");if(!t)throw Error('No source tab');await chrome.windows.update(t.windowId,{focused:true});await chrome.tabs.update(t.id,{active:true});return t.id})()", await_promise=True)
        folder = (self.output/'popup-downloads').resolve(); folder.mkdir(exist_ok=True)
        before_files = set(folder.iterdir())
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
            def downloaded():
                files = [p for p in folder.iterdir() if p not in before_files and p.is_file() and p.suffix != '.crdownload']
                if files:
                    return files
                state = popup.eval("({idle:!document.getElementById('btnCurrent').disabled,status:document.getElementById('status').textContent})")
                if state and state['idle'] and ('Export failed' in state['status'] or '导出失败' in state['status']):
                    raise ValueError('Popup export failed before delivery: '+state['status'])
                return None
            fresh = wait_for(downloaded, 120)
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
            prompt = next(message_text(m) for m in current_branch(source) if m['sender'] == 'human')
            if prompt not in texts[0]: raise ValueError('Popup export lacks first prompt')
            return {'conversationId': cid, 'sourceTabId': tab_id, 'status': status, 'files': [str(p) for p in fresh]}
        finally:
            if popup: popup.close()
            if target_id: self.browser.call('Target.closeTarget', {'targetId': target_id})
            self.browser.call('Browser.setDownloadBehavior', {'behavior': 'default'})

    def open_conversation(self, cid):
        previous_origin = self.chat.eval('performance.timeOrigin')
        self.chat.call('Page.navigate', {'url': 'https://claude.ai/chat/'+cid})
        checkpoint = self.output/f'{cid}.progress.json'
        expected = json.loads(checkpoint.read_text())['prompts'][0] if checkpoint.exists() else None
        def loaded():
            if not self.chat.eval("performance.timeOrigin!=="+json.dumps(previous_origin)
                    +"&&document.readyState==='complete'&&location.pathname==="+json.dumps('/chat/'+cid)):
                return None
            messages = self.webpage()
            if expected and not any(m['role'] == 'user' and m['text'].strip() == expected.strip() for m in messages):
                return None
            return messages
        wait_for(loaded)

    def capture_golden(self):
        path = Path(self.config.get('golden', self.root/'tests/fixtures/claude_tier2_golden.json'))
        self.golden = json.loads(path.read_text())
        ids = self.golden['conversationIds']
        if not ids or len(set(ids)) != len(ids):
            raise ValueError('Golden conversations must be nonempty and unique')
        observed = set()
        for cid in ids:
            raw = self.freeze_source(cid)
            self.open_conversation(cid)
            first_prompt = next(message_text(m) for m in completed_branch(raw) if m['sender'] == 'human')
            def loaded():
                messages = self.webpage()
                return messages if any(m['role'] == 'user' and m['text'].strip() == first_prompt.strip() for m in messages) else None
            visible = wait_for(loaded)
            (self.output/f'{cid}.webpage.json').write_text(json.dumps(visible, ensure_ascii=False), encoding='utf-8')
            observed.update(b.get('name', '').lower() for m in completed_branch(raw) for b in m.get('content', []) if b.get('type') == 'tool_use')
        if not {'askuserquestion', 'write', 'artifact'} <= observed:
            raise ValueError('Golden source must cover native questionnaire and Write → Artifact')
        return {'conversationIds': ids, 'tools': sorted(observed)}

    def golden_exports(self):
        from scripts.framework.claude_evidence import assert_full_exports
        return assert_full_exports(self.root, self.output, self.golden['conversationIds'])

    def confirmed_deletion(self):
        cid = self.report['ephemeralId']
        if not all(self.stored(cid).get(k) for k in ('index', 'detail', 'exportRecord')):
            raise ValueError('Deletion requires same-key Index, Detail and ExportRecord')
        before = snapshot(self.options, self.platform_id)
        other_before = self.options.eval("(async()=>{const a=await __tier2V2.listAccounts();return Promise.all(a.filter(a=>a.id!==document.getElementById('accountIdSelect').value).map(async a=>({id:a.id,account:await __tier2V2.getAccount(a.id)})))})()", await_promise=True)
        self.open_conversation(cid)
        # Native quota upsells can cover read-only UI even without a send.
        # Dismiss only the non-purchase action in that specific quota dialog.
        dismiss = """(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(e=>/消息限额|message limit|usage limit/i.test(e.innerText));
            const b=[...(d?.querySelectorAll('button')||[])].find(e=>/^(以后再说|暂时不用|Not now|Maybe later)$/i.test(e.innerText.trim()));
            if(!b)return false;b.click();return true})()"""
        if self.chat.eval(dismiss, user_gesture=True):
            wait_for(lambda: self.chat.eval("![...document.querySelectorAll('[role=dialog]')].some(e=>/消息限额|message limit|usage limit/i.test(e.innerText))"), 10)
        # Only the current-conversation header menu is safe. A global button
        # search can open another sidebar conversation's destructive menu.
        self.click_native("(()=>{const heading=[...document.querySelectorAll('h2')].find(e=>e.querySelector('button'));return [...(heading?.parentElement?.querySelectorAll('button[aria-haspopup=menu]')||[])].find(e=>/更多选项|More options/i.test(e.getAttribute('aria-label')||'')&&e.getBoundingClientRect().width>0)})()")
        self.click_native("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.innerText.split(/\\n/).some(t=>/^(删除|Delete)$/.test(t.trim())))")
        self.click_native("[...document.querySelectorAll('[role=dialog] button,[role=alertdialog] button')].find(e=>/^(删除|删除对话|Delete|Delete chat)$/.test(e.innerText.trim()))")
        def removed():
            state = self.stored(cid)
            current = snapshot(self.options, self.platform_id)
            return bool(state) and all(state.get(k) is None for k in ('index', 'detail', 'exportRecord')) and cid not in {r['key']['conversationId'] for r in current['rows']}
        wait_for(removed, 120, 1)
        after = snapshot(self.options, self.platform_id)
        if [r for r in before['rows'] if r['key']['conversationId'] != cid] != after['rows']:
            raise ValueError('Deletion modified unrelated conversations')
        for account in other_before:
            if self.options.eval('__tier2V2.getAccount('+json.dumps(account['id'])+')', await_promise=True) != account['account']:
                raise ValueError('Deletion changed another account')
        self.report['scan'] = [r for r in self.report['scan'] if r['id'] != cid]
        return {'conversationId': cid, 'sameKeyRemoved': True, 'withoutSyncOrReload': True}

    def fast_skip(self):
        CDPActions.configure_export_controls(self.options, 'markdown', True)
        install_probe(self.options)
        eligible = self.options.eval("__tier2V2.skipEligibleIds('claude')", await_promise=True)
        if len(eligible) < 2 or not set(self.chat_ids) <= set(eligible):
            raise ValueError('Missing physically exported scenario receipts for Skip audit')
        self.select_ids(eligible)
        folder = self.output/'skip-evidence'
        folder.mkdir(exist_ok=True)
        before_files = set(folder.iterdir())
        before = {cid: self.stored(cid)['exportRecord'] for cid in eligible}
        previous = self.options.eval("document.getElementById('status').textContent")
        try:
            self.browser.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(folder)})
            self.options.eval("document.getElementById('btnExport').click()", user_gesture=True)
            wait_for(lambda: self.options.eval("document.body.dataset.busy==='false'&&document.getElementById('status').textContent!=="+json.dumps(previous)), 30)
            if set(folder.iterdir()) != before_files or any(self.stored(cid)['exportRecord'] != before[cid] for cid in eligible):
                raise ValueError('All-skipped export delivered data or rewrote receipts')
        finally:
            self.browser.call('Browser.setDownloadBehavior', {'behavior': 'default'})
        return {'skipped': len(eligible), 'noDownload': True, 'receiptsUnchanged': True}
