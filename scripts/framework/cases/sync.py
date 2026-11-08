"""Real-account sync checks shared by the existing full Tier 2 lifecycle."""
import json
import os
import time

from scripts.framework.v2_probe import install_probe, snapshot
from scripts.framework.actions import CDPActions
from scripts.framework.assertions import assert_full_scan_coverage, assert_passive_coverage, assert_activity_sync_result


def read_sync_state(cdp):
    return snapshot(cdp) or {}


def save_sync_evidence(ctx, name, evidence):
    with open(os.path.join(ctx.output_dir, name + '.json'), 'w', encoding='utf-8') as output:
        json.dump(evidence, output, ensure_ascii=False, indent=2)
    ctx.shared_data[name] = evidence


def clear_scan_records(cdp):
    install_probe(cdp)
    cdp.eval('globalThis.__tier2V2.resetScanCoverage()', await_promise=True)


def wait_for_prior_scan(cdp, timeout=330):
    """The onboarding tour starts a real scan; wait before clearing scan records."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cdp.eval("document.body.dataset.busy === 'false'") is True:
            return
        time.sleep(0.5)
    raise RuntimeError('Prior onboarding scan did not settle before passive coverage reset')


def select_source_account(cdp_opt, cdp_gemini=None, source_tab_id=None):
    """Choose the source tab's actual Registry UUID through the normal UI contract."""
    install_probe(cdp_opt)
    source_url = cdp_gemini.eval('location.href') if cdp_gemini else None
    tab_match = f't.id === {int(source_tab_id)}' if source_tab_id is not None else 't.url === ' + json.dumps(source_url)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        selected = cdp_opt.eval("""(async () => {
            const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
            const tab = tabs.find(t => %s);
            if (tab?.id == null) return false;
            const binding = await chrome.tabs.sendMessage(tab.id, { action: 'getAccountContext' });
            const id = binding?.ok && binding.accountContext?.accountId;
            if (!id) return false;
            const account = await globalThis.__tier2V2.getAccount(id);
            if (account?.providerId !== 'gemini' || account.providerAccountId === 'default') return false;
            window.dispatchEvent(new Event('focus'));
            await new Promise(resolve => setTimeout(resolve, 100));
            const selector = document.querySelector('#accountIdSelect');
            if (!selector || !Array.from(selector.options).some(option => option.value === id)) return false;
            selector.value = id;
            selector.dispatchEvent(new Event('change', { bubbles: true }));
            return selector.value === id;
        })()""" % tab_match, await_promise=True)
        if selected:
            return
        time.sleep(0.5)
    raise RuntimeError('Could not select the source tab Registry account')


def prepare_activity_baseline(ctx, cdp_gemini):
    """Observe genuine webpage RPCs, then establish a full pre-chat baseline."""
    cdp_opt = ctx.connect_options()
    cdp_gemini.call('Page.enable')
    observer = cdp_gemini.call('Page.addScriptToEvaluateOnNewDocument', {'source': """
        window.__tier2PassivePages = [];
        window.addEventListener('message', event => {
            const p = event.data?.payload;
            if (event.source === window && event.origin === location.origin && event.data?.type === 'GEMINI_NETWORK_BATCHEXECUTE' && p?.listRequest?.streamId === 'recent') {
                window.__tier2PassivePages.push({ ...p.listRequest, requestedAt: p.requestedAt,
                    accountObservation: p.requestAccountObservation, truncated: p.truncated });
            }
        });
    """})
    script_id = observer.get('result', {}).get('identifier')
    if not script_id:
        cdp_opt.close()
        raise RuntimeError('Could not install passive RPC evidence listener: ' + str(observer))
    try:
        select_source_account(cdp_opt, cdp_gemini)
        wait_for_prior_scan(cdp_opt)
        clear_scan_records(cdp_opt)
        empty = read_sync_state(cdp_opt)
        if empty.get('coverage') is not None:
            raise RuntimeError('Passive fixture did not clear coverage')
        cdp_gemini.call('Page.reload', {'ignoreCache': True})
        deadline = time.monotonic() + 35
        passive = {}
        observations = []
        while time.monotonic() < deadline:
            passive = read_sync_state(cdp_opt)
            raw_observations = cdp_gemini.eval('window.__tier2PassivePages || []') or []
            # Resolve captured Provider evidence through the actual Registry, not email/slot.
            accounts = cdp_opt.eval("""(async () => {
                const accounts = await globalThis.__tier2V2.listAccounts('gemini');
                return accounts.map(a => ({ id: a.id, providerId: a.providerId, providerAccountId: a.providerAccountId }));
            })()""", await_promise=True) or []
            observations = []
            for item in raw_observations:
                identity = item.pop('accountObservation', None) or {}
                account = next((a for a in accounts if a['providerId'] == identity.get('providerId')
                                and a['providerAccountId'] == identity.get('providerAccountId')), None)
                observations.append({**item, 'accountId': account['id'] if account else None})
            ok, message = assert_passive_coverage(empty, passive, observations)
            if ok:
                break
            # Native sidebar navigation requests further real pages if initial
            # RPCs preceded account readiness. No RPC response is synthesized.
            cdp_gemini.eval("""(() => {
                const open = document.querySelector('button[aria-label*="Open sidebar"], button[aria-label*="展开侧边栏"]');
                if (open) open.click();
                const items = document.querySelectorAll('gem-nav-list-item, a[href*="/app/"]');
                items[items.length - 1]?.scrollIntoView({ block: 'end' });
            })()""")
            time.sleep(0.5)
        save_sync_evidence(ctx, 'passive_sync_coverage', {'before': empty, 'after': passive, 'observations': observations})
        if not ok:
            raise RuntimeError(message)
        print('      ✓ 网页自然加载建立 Coverage，未点击 Sync All')
        # Reload creates a new content instance. Passive request attribution is
        # not proof that its current active route is ready for Application RPCs.
        select_source_account(cdp_opt, cdp_gemini)
        clear_scan_records(cdp_opt)
        full = CDPActions.trigger_deep_scan(cdp_opt)
        state = read_sync_state(cdp_opt)
        ok, message = assert_full_scan_coverage(full, state.get('coverage') or {})
        baseline = {'scan': full, 'state': state}
        save_sync_evidence(ctx, 'pre_chat_sync_baseline', baseline)
        if not ok:
            raise RuntimeError('Pre-chat full baseline failed: ' + message)
        recent = state.get('coverage') or {}
        print('      ✓ 发帖前完整遍历基线: ' + message
              + '; persisted Recent range=' + str(recent.get('range')))
        return baseline
    finally:
        if script_id:
            cdp_gemini.call('Page.removeScriptToEvaluateOnNewDocument', {'identifier': script_id})
        cdp_opt.close()


def verify_activity_sync(ctx, baseline, target_ids, name):
    cdp_opt = ctx.connect_options()
    try:
        before = read_sync_state(cdp_opt)
        scan = CDPActions.trigger_deep_scan(cdp_opt)
        after = read_sync_state(cdp_opt)
        result = {'baseline': baseline, 'before': before, 'scan': scan, 'after': after, 'targetIds': target_ids}
        save_sync_evidence(ctx, name, result)
        ok, message = assert_activity_sync_result(baseline, before, scan, after, target_ids)
        if not ok:
            raise RuntimeError(message)
        print('      ✓ ' + message)
        return result
    finally:
        cdp_opt.close()
