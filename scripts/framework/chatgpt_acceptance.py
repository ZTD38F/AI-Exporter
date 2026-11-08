"""Full live acceptance operations supplementing ChatGPT source/export evidence."""
import hashlib
import json
import os
import shutil
import time
import zipfile
from pathlib import Path

from scripts.cdp_client import CDPConnection, get_tabs
from scripts.framework.actions import CDPActions
from scripts.framework.v2_probe import install_probe, snapshot


from scripts.framework.browser_acceptance import BrowserAcceptance


class ChatGPTAcceptance(BrowserAcceptance):
    def prepare_extension(self):
        """Default local-only install flavor; never edit the shipping manifest."""
        self.extension_root = self.root
        if os.environ.get('TIER2_CHATGPT_REQUIRED_HOSTS') == '0':
            self.report['testInstallMode'] = 'optional-chatgpt-hosts'
            return
        target = self.root/'temp/tier2-chatgpt-required-hosts'
        shutil.rmtree(target, ignore_errors=True)
        target.mkdir(parents=True)
        for name in ('src', 'dist', 'lib', 'icons', '_locales'):
            shutil.copytree(self.root/name, target/name)
        manifest = json.loads((self.root/'manifest.json').read_text())
        hosts = ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://images.openai.com/*']
        manifest['host_permissions'] = list(dict.fromkeys(manifest.get('host_permissions', [])+hosts))
        manifest['optional_host_permissions'] = [host for host in manifest.get('optional_host_permissions', []) if host not in hosts]
        (target/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
        self.extension_root = target
        self.report['testInstallMode'] = 'required-chatgpt-hosts'


    def passive_sidebar(self):
        """Native first page, without Sync or an injected list request."""
        from scripts.framework.chatgpt_live import wait_for
        self.chat.call('Page.reload')
        def captured():
            visible = self.chat.eval("[...document.querySelectorAll('a[href^=\"/c/\"]')].map(e=>e.getAttribute('href').split('/')[2])") or []
            if len(set(visible)) < 2:
                return None
            state = snapshot(self.options, 'chatgpt')
            ids = {row['key']['conversationId'] for row in state['rows']}
            return {'sidebarIds': visible, 'storedIds': sorted(ids), 'coverage': state['coverage']} if set(visible) <= ids else None
        evidence = wait_for(captured, 60, 1)
        if evidence['coverage'] is not None:
            raise ValueError('Passive first page falsely established full scan coverage')
        (self.output/'passive-sidebar.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
        return evidence

    def page_badge(self):
        from scripts.framework.chatgpt_live import wait_for
        result = wait_for(lambda: self.chat.eval("(()=>{const e=document.getElementById('geminiExportBadge');if(!e)return null;const r=e.getBoundingClientRect();return r.width>0&&r.height>0?{width:r.width,height:r.height}:null})()"), 45)
        return result


    def assert_export_advancement(self, cid):
        # Live export may have already advanced; either the live record or the
        # current source must be strictly newer than the independently saved baseline.
        state = self.stored(cid)
        before = self.initial_exports[cid]
        if state['index']['updatedAt'] <= before['chatTime']:
            raise ValueError('Passive source update did not advance beyond initial physical export')
        self.gate('export_record_advancement', lambda: {'before': before, 'after': state['exportRecord'],
                                                       'sourceUpdatedAt': state['index']['updatedAt']})

    def account_boundary(self):
        state = snapshot(self.options, 'chatgpt')
        if state['account']['providerId'] != 'chatgpt' or not state['rows']:
            raise ValueError('Missing canonical ChatGPT account or rows')
        cid = self.chat_ids[0]
        stored = self.stored(cid)
        if any(row['key']['accountId'] != state['accountId'] for row in state['rows']):
            raise ValueError('Cross-account index leaked')
        accounts = self.options.eval('__tier2V2.listAccounts()', await_promise=True)
        other_ids = [a['id'] for a in accounts if a['id'] != state['accountId']]
        for aid in other_ids:
            other = self.options.eval('__tier2V2.storedConversation('+json.dumps({'accountId': aid, 'conversationId': cid})+')', await_promise=True)
            if any(other.values()):
                raise ValueError('Same conversation ID leaked into another account')
        if not stored.get('detail'):
            raise ValueError('Current-account Detail missing')
        return {'accountId': state['accountId'], 'rows': len(state['rows']), 'otherAccounts': len(other_ids)}

    def fast_skip(self):
        from scripts.framework.chatgpt_live import wait_for
        self.export_selected([row['id'] for row in self.report['scan']], self.output/'skip-baseline')
        CDPActions.configure_export_controls(self.options, 'markdown', True)
        install_probe(self.options)
        eligible = self.options.eval("__tier2V2.skipEligibleIds('chatgpt')", await_promise=True)
        if len(eligible) < 6:
            raise ValueError('Insufficient physically exported unchanged conversations for Skip audit')
        self.select_ids(eligible)
        folder = self.output/'skip-evidence'
        folder.mkdir(exist_ok=True)
        self.browser.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(folder)})
        before = {cid: self.stored(cid)['exportRecord'] for cid in eligible}
        previous = self.options.eval("document.getElementById('status').textContent")
        self.options.eval("document.getElementById('btnExport').click()", user_gesture=True)
        wait_for(lambda: self.options.eval("document.body.dataset.busy==='false'&&document.getElementById('status').textContent!=="+json.dumps(previous)), 30)
        if any(folder.iterdir()):
            raise ValueError('All-skipped export still downloaded data')
        if any(self.stored(cid)['exportRecord'] != before[cid] for cid in eligible):
            raise ValueError('All-skipped export changed export records')
        from scripts.framework.chatgpt_live import current_branch
        self.chat.call('Page.navigate', {'url': 'https://chatgpt.com/'})
        from scripts.framework.scenario_provider import OnlineScenarioProvider
        prompt = OnlineScenarioProvider().pop_ephemeral_query()
        cid = self.send(prompt)
        wait_for(lambda: self.stored(cid).get('detail'), 60)
        self.select_ids([eligible[0], cid])
        path = CDPActions.trigger_export_zip(self.options, str(folder), max_wait=120,
            skip_exported=True, format_type='markdown', allow_standalone=True)
        if not path:
            raise ValueError('Partial Skip did not deliver the new conversation')
        path = Path(path)
        if path.suffix == '.zip':
            with zipfile.ZipFile(path) as archive:
                texts = [archive.read(n).decode() for n in archive.namelist() if n.endswith('.md')]
        else:
            texts = [path.read_text()]
        if len(texts) != 1 or cid not in texts[0] or prompt not in texts[0]:
            raise ValueError('Partial Skip exported the wrong set or lost actual prompt')
        if self.stored(eligible[0])['exportRecord'] != before[eligible[0]]:
            raise ValueError('Partial Skip rewrote the unchanged conversation receipt')
        if not self.stored(cid).get('exportRecord'):
            raise ValueError('Partial Skip failed to commit the delivered receipt')
        return {'skipped': len(eligible), 'allSkipNoPhysicalDownload': True,
                'partialSkipFile': str(path), 'newId': cid}

    def stale_tab_images(self):
        from scripts.framework.chatgpt_live import wait_for
        from scripts.framework.image_evidence import assert_image_files
        stale_url = 'https://chatgpt.com/?tier2-stale='+str(int(time.time()))
        target_id = self.browser.call('Target.createTarget', {'url': stale_url})['result']['targetId']
        stale = None
        try:
            target = wait_for(lambda: next((t for t in get_tabs(self.port) if t['id'] == target_id), None))
            stale = CDPConnection(target['webSocketDebuggerUrl'])
            wait_for(lambda: stale.eval("!!document.getElementById('prompt-textarea')"), 30)
            # Replace extension contexts, preserving the local test install's permissions.
            result = self.browser.call('Extensions.loadUnpacked', {'path': str(self.extension_root)})
            if result.get('error'):
                raise ValueError(result['error'])
            self.options.close()
            self.options = self.fresh_options()
            self.options.call('Page.reload')
            self.ready()
            self.chat.call('Page.reload')
            wait_for(lambda: self.chat.eval("!!document.getElementById('geminiExportBadge')"), 45)
            setup = self.options.eval("(async()=>{\n                const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});\n                const stale=tabs.find(t=>t.url===STALE_URL);\n                const fresh=tabs.find(t=>t.id!==stale.id);\n                const ping=id=>new Promise(resolve=>chrome.tabs.sendMessage(id,{action:'ping'},reply=>resolve({reply,error:chrome.runtime.lastError?.message||''})));\n                await chrome.tabs.update(stale.id,{active:true});\n                return {stale:await ping(stale.id),fresh:await ping(fresh.id)};\n            })()".replace('STALE_URL', json.dumps(stale_url)), await_promise=True)
            if 'Receiving end does not exist' not in setup.get('stale', {}).get('error', '') or not setup.get('fresh', {}).get('reply', {}).get('ok'):
                raise ValueError('Did not establish a receiver-less active tab and a valid alternate: '+str(setup))
            path = self.export_selected([self.golden['image']], self.output/'stale-tab')
            with zipfile.ZipFile(path) as archive:
                images = [(name, archive.read(name)) for name in archive.namelist()
                          if Path(name).suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')]
            comparison = assert_image_files(self.options, self.image_evidence, images)
            return {'tabs': setup, 'file': str(path), 'imagePixels': comparison}
        finally:
            if stale:
                stale.close()
            self.browser.call('Target.closeTarget', {'targetId': target_id})

    def cleanup_records(self):
        from scripts.framework.chatgpt_live import wait_for
        before = snapshot(self.options, 'chatgpt')
        if not before['rows'] or not before['records']:
            raise ValueError('Cleanup requires physical local facts and export records')
        # Exercise the actual confirmation and its cancel path before accepting.
        self.options.eval("document.getElementById('btnClearScan').click()", user_gesture=True)
        wait_for(lambda: self.options.eval("document.getElementById('cleanupModal').open"), 10)
        self.options.eval("document.getElementById('btnCleanupCancel').click()", user_gesture=True)
        wait_for(lambda: self.options.eval("!document.getElementById('cleanupModal').open"), 10)
        if snapshot(self.options, 'chatgpt')['rows'] != before['rows']:
            raise ValueError('Cancel mutated local facts')
        self.options.eval("document.getElementById('btnClearScan').click()", user_gesture=True)
        wait_for(lambda: self.options.eval("document.getElementById('cleanupModal').open"), 10)
        self.options.eval("document.getElementById('btnCleanupConfirm').click()", user_gesture=True)
        wait_for(lambda: not snapshot(self.options, 'chatgpt')['rows'], 30)
        after = snapshot(self.options, 'chatgpt')
        if after['records'] or after['coverage'] is not None:
            raise ValueError('Explicit account cleanup retained records/coverage')
        for row in before['rows']:
            if any(self.stored(row['key']['conversationId']).values()):
                raise ValueError('Explicit cleanup retained same-key local facts')
        self.sync()
        if not set(self.chat_ids).issubset({r['id'] for r in self.report['scan']}):
            raise ValueError('Real rescan failed to recover retained remote conversations')
        return {'cleared': len(before['rows']), 'cancelPreservedData': True, 'rescanRecovered': True}
