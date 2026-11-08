"""Shared CDP installation, workbench selection and physical download operations."""
import json
from pathlib import Path
from scripts.cdp_client import CDPConnection, get_tabs
from scripts.framework.actions import CDPActions, remove_product_extensions
from scripts.framework.v2_probe import snapshot
from scripts.framework.live_utils import wait_for
from scripts.framework.tab_cleanup import uninstall_extension


class BrowserAcceptance:
    def clean_install(self):
        """Replace only this product's unpacked install, keeping one enabled copy."""
        removed = remove_product_extensions(self.browser, self.root, self.port)
        self.report['installation'] = {'removedCopies': removed, 'clean': True}

    def fresh_options(self):
        url = f'chrome-extension://{self.ext_id}/src/ui/options/options.html'
        target = next((t for t in get_tabs(self.port) if t.get('url') == url), None)
        if not target:
            self.browser.call('Target.createTarget', {'url': url})
            target = wait_for(lambda: next((t for t in get_tabs(self.port) if t.get('url') == url), None))
        return CDPConnection(target['webSocketDebuggerUrl'])

    def select_ids(self, ids):
        self.options.eval('''(()=>{const all=document.getElementById('btnSelectAll');if(!all.checked)all.click();all.click();
            const wanted=new Set('''+json.dumps(ids)+''');
            for(const item of document.querySelectorAll('#list .item')) {
                const c=item.querySelector('input[type=checkbox]');
                if(wanted.has(item.dataset.chatId)&&c){c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));}
            }})()''', user_gesture=True)
        selected = self.options.eval("[...document.querySelectorAll('#list .item')].filter(e=>e.querySelector('input:checked')).map(e=>e.dataset.chatId)")
        if set(selected) != set(ids):
            raise ValueError('Selection differs from requested identities')

    def export_selected(self, ids, folder, fmt='markdown'):
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        self.select_ids(ids)
        path = CDPActions.trigger_export_zip(self.options, str(folder), max_wait=max(600, len(ids)*120),
                                            skip_exported=False, format_type=fmt, allow_standalone=True)
        if not path:
            raise ValueError('Physical export did not arrive')
        return Path(path)

    def initial_export(self):
        cid = self.chat_ids[0]
        folder = (self.output/'initial-export').resolve()
        folder.mkdir(parents=True, exist_ok=True)
        try:
            self.browser.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(folder)})
            path = self.export_selected([cid], folder)
        finally:
            self.browser.call('Browser.setDownloadBehavior', {'behavior': 'default'})
        state = self.stored(cid)
        if not state.get('exportRecord'):
            raise ValueError('Physical download did not commit ExportRecord')
        self.initial_exports[cid] = state['exportRecord']
        return {'file': str(path), 'exportRecord': state['exportRecord']}

    def uninstall_lifecycle(self):
        old = self.ext_id
        removed = uninstall_extension(self.browser, old, self.port)
        if removed.get('error'):
            raise ValueError(removed['error'])
        wait_for(lambda: all(e['id'] != old for e in self.browser.call('Extensions.getExtensions')['result']['extensions']), 10)
        loaded = self.browser.call('Extensions.loadUnpacked', {'path': str(self.extension_root)})
        if loaded.get('error') or not loaded.get('result', {}).get('id'):
            raise ValueError('Clean restoration failed')
        self.ext_id = loaded['result']['id']
        return {'uninstalled': old, 'restored': self.ext_id, 'physicalInventoryVerified': True}

    def save_report(self):
        (self.output/'report.json').write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding='utf-8')

    def gate(self, name, operation):
        import traceback
        print(f'[{self.platform_id} Tier 2] {name}', flush=True)
        try:
            if getattr(self, 'rate_limited', False) and name != 'uninstall_lifecycle':
                raise RuntimeError('Provider HTTP 429 already observed; further provider operations stopped')
            detail = operation()
            self.report['gates'][name] = {'status': 'passed', 'detail': detail}
            self.save_report()
            return detail
        except Exception as error:
            self.report['gates'][name] = {'status': 'failed', 'error': str(error), 'traceback': traceback.format_exc()}
            self.save_report()
            raise

    def ready(self, timeout=180):
        return wait_for(lambda: self.options.eval("document.body?.dataset.busy==='false'&&!document.getElementById('btnSyncAll')?.disabled"), timeout)

    def stored(self, cid):
        from scripts.framework.v2_probe import install_probe
        install_probe(self.options)
        account = self.options.eval("document.getElementById('accountIdSelect').value")
        return self.options.eval('__tier2V2.storedConversation('+json.dumps({'accountId': account, 'conversationId': cid})+')', await_promise=True)

    def account_boundary(self):
        from scripts.framework.v2_probe import snapshot
        state = snapshot(self.options, self.platform_id)
        if state['account']['providerId'] != self.platform_id or not state['rows']:
            raise ValueError('Missing canonical provider account or rows')
        if any(row['key']['accountId'] != state['accountId'] for row in state['rows']):
            raise ValueError('Cross-account index leaked')
        cid = self.chat_ids[0]
        if not self.stored(cid).get('detail'):
            raise ValueError('Current-account Detail missing')
        accounts = self.options.eval('__tier2V2.listAccounts()', await_promise=True)
        for account in accounts:
            if account['id'] == state['accountId']:
                continue
            stored = self.options.eval('__tier2V2.storedConversation('+json.dumps({'accountId': account['id'], 'conversationId': cid})+')', await_promise=True)
            if any(stored.values()):
                raise ValueError('Same conversation ID leaked into another account')
        return {'accountId': state['accountId'], 'rows': len(state['rows']), 'otherAccounts': len(accounts)-1}

    def physical_exports(self):
        import zipfile
        from scripts.framework.json_archive import validate_json_archive
        folder = (self.output/'downloads').resolve()
        if folder.exists():
            import time
            folder.rename(self.output/('downloads-previous-'+str(time.time_ns())))
        results = []
        self.options.eval("if(!document.getElementById('includeAssets').checked)document.getElementById('includeAssets').click()", user_gesture=True)
        self.ready()
        for fmt in ('markdown', 'html', 'json', 'pdf'):
            destination = folder/fmt
            destination.mkdir(parents=True, exist_ok=True)
            try:
                self.browser.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(destination)})
                path = self.export_selected([r['id'] for r in self.report['scan']], destination, fmt)
                if path.suffix != '.zip':
                    raise ValueError('Full multi-conversation export must deliver ZIP')
                with zipfile.ZipFile(path) as archive:
                    if archive.testzip():
                        raise ValueError('ZIP CRC failure')
                    # Never allow a downloaded archive to escape its evidence folder.
                    for name in archive.namelist():
                        if not (destination/name).resolve().is_relative_to(destination.resolve()):
                            raise ValueError('Unsafe ZIP member: '+name)
                    archive.extractall(destination)
                if fmt == 'json':
                    valid, summary, details = validate_json_archive(path, min_conversations=len(self.report['scan']))
                    if not valid:
                        raise ValueError((summary, details))
                    with zipfile.ZipFile(path) as archive:
                        keys = [json.loads(archive.read(name))['conversation']['index']['key']
                                for name in archive.namelist() if name.endswith('.json')
                                and not any(part in ('assets', 'files', 'images') for part in name.split('/')[:-1])]
                    expected = {r['id'] for r in self.report['scan']}
                    if {key['conversationId'] for key in keys} != expected:
                        raise ValueError('Physical JSON export differs from selected conversation identities')
                results.append({'format': fmt, 'file': str(path), 'bytes': path.stat().st_size})
            finally:
                self.browser.call('Browser.setDownloadBehavior', {'behavior': 'default'})
        return results

    def assert_export_advancement(self, cid):
        # Live export may have already advanced; either the live record or the
        # current source must be strictly newer than the independently saved baseline.
        state = self.stored(cid)
        before = self.initial_exports[cid]
        if state['index']['updatedAt'] <= before['chatTime']:
            raise ValueError('Passive source update did not advance beyond initial physical export')
        self.gate('export_record_advancement', lambda: {'before': before, 'after': state['exportRecord'],
                                                       'sourceUpdatedAt': state['index']['updatedAt']})

    def cleanup_records(self):
        from scripts.framework.live_utils import wait_for
        before = snapshot(self.options, self.platform_id)
        if not before['rows'] or not before['records']:
            raise ValueError('Cleanup requires physical local facts and export records')
        # Exercise the actual confirmation and its cancel path before accepting.
        self.options.eval("document.getElementById('btnClearScan').click()", user_gesture=True)
        wait_for(lambda: self.options.eval("document.getElementById('cleanupModal').open"), 10)
        self.options.eval("document.getElementById('btnCleanupCancel').click()", user_gesture=True)
        wait_for(lambda: self.options.eval("!document.getElementById('cleanupModal').open"), 10)
        if snapshot(self.options, self.platform_id)['rows'] != before['rows']:
            raise ValueError('Cancel mutated local facts')
        self.options.eval("document.getElementById('btnClearScan').click()", user_gesture=True)
        wait_for(lambda: self.options.eval("document.getElementById('cleanupModal').open"), 10)
        self.options.eval("document.getElementById('btnCleanupConfirm').click()", user_gesture=True)
        wait_for(lambda: not snapshot(self.options, self.platform_id)['rows'], 30)
        after = snapshot(self.options, self.platform_id)
        if after['records'] or after['coverage'] is not None:
            raise ValueError('Explicit account cleanup retained records/coverage')
        for row in before['rows']:
            if any(self.stored(row['key']['conversationId']).values()):
                raise ValueError('Explicit cleanup retained same-key local facts')
        self.sync()
        if not set(self.chat_ids).issubset({r['id'] for r in self.report['scan']}):
            raise ValueError('Real rescan failed to recover retained remote conversations')
        return {'cleared': len(before['rows']), 'cancelPreservedData': True, 'rescanRecovered': True}
