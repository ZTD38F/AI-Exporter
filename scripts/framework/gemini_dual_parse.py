"""Test-only capture of the native replies used by the actual Gemini export.

The caller acquires current Detail through Application before exporting, so cached
Domain cannot silently leave the audit without native evidence.
"""
import json
import re
import subprocess
from pathlib import Path


INSTALL_CAPTURE = r"""(() => {
    if (window.__geminiDualCapture) throw new Error('Gemini capture already installed');
    const original = window.fetch;
    const state = {original, replies:{}, pending:[], errors:[]};
    window.__geminiDualCapture = state;
    window.fetch = function(...args) {
        const result = original.apply(this, args);
        let request;
        try {
            const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
            if (url.origin !== 'https://gemini.google.com' || !url.pathname.endsWith('/batchexecute')) return result;
            const fReq = new URLSearchParams(args[1]?.body).get('f.req');
            const calls = JSON.parse(fReq)[0];
            const detail = calls.filter(call => call[0] === 'hNvQHb');
            if (detail.length !== 1) return result;
            request = JSON.parse(detail[0][1]);
            if (typeof request[0] !== 'string') return result;
        } catch { return result; }
        const id = request[0].replace(/^c_/, '');
        // Clone immediately, before the client can consume the original Response.
        state.pending.push(result.then(response => {
            if (!response.ok) throw new Error('Detail HTTP ' + response.status);
            return response.clone().text();
        }).then(text => {
            (state.replies[id] ||= []).push({requestCursor:request[2] ?? null, text});
        }).catch(error => {state.errors.push({id,error:String(error)});}));
        return result;
    };
    return true;
})()"""


def install_capture(cdp):
    if cdp.eval(INSTALL_CAPTURE) is not True:
        raise RuntimeError('Failed to install Gemini native export capture')


def finish_capture(cdp, directory, expected_ids):
    """Drain response clones, persist exact RPC pages, restore fetch on every exit."""
    directory = Path(directory)
    selected = list(dict.fromkeys(cid.removeprefix('c_') for cid in expected_ids))
    missing = []
    try:
        state = cdp.eval("""(async () => {
            const state = window.__geminiDualCapture;
            if (!state) throw new Error('Gemini capture not installed');
            await Promise.all(state.pending);
            return {replies:state.replies, errors:state.errors};
        })()""", await_promise=True)
        if not isinstance(state, dict):
            raise RuntimeError('Missing native capture result')
        directory.mkdir(parents=True, exist_ok=True)
        for previous in directory.glob('*.json'):
            previous.unlink()
        for cid in selected:
            if not re.fullmatch(r'[A-Za-z0-9_-]+', cid):
                raise ValueError('Invalid Gemini conversation ID in capture')
            pages = state.get('replies', {}).get(cid, [])
            if (not pages or any(not isinstance(p, dict) or not isinstance(p.get('text'), str) or not p['text'] for p in pages)
                    or any(error.get('id') == cid for error in state.get('errors', []))):
                missing.append(cid)
                continue
            (directory / f'{cid}.json').write_text(json.dumps({
                'schemaVersion': 1, 'source': 'raw_rpc_pages', 'conversationId': cid, 'pages': pages,
            }, ensure_ascii=False, indent=2), encoding='utf-8')
        manifest = {'expected': selected, 'missingNative': missing, 'errors': state.get('errors', [])}
        (directory.parent / 'capture.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        return manifest
    finally:
        cdp.eval("""(() => {
            const state = window.__geminiDualCapture;
            if (state) window.fetch = state.original;
            delete window.__geminiDualCapture;
        })()""")


def run_check(repo_root, source, destination):
    command = ['node', '-r', str(Path(repo_root) / 'tests/ts_register.js'),
               str(Path(repo_root) / 'scripts/check_gemini_dual_parse.ts'),
               '--input', str(source), '--output', str(destination)]
    result = subprocess.run(command, cwd=repo_root, capture_output=True, text=True, timeout=180)
    summary_file = Path(destination) / 'summary.json'
    if not summary_file.is_file():
        raise RuntimeError(f'Gemini dual parse produced no report: {result.stderr[-1500:]}')
    summary = json.loads(summary_file.read_text(encoding='utf-8'))
    if result.returncode not in (0, 1):
        raise RuntimeError(f'Gemini dual parse execution failed: {result.stderr[-1500:]}')
    return result.returncode == 0 and summary.get('passed') is True, summary
