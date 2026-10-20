#!/usr/bin/env python3
"""Capture Gemini's live math DOM through the project's existing CDP client.

Usage: python3 tests/live/probes/gemini_renderer_probe/probe.py CASE URL NEEDLE
The script only navigates to an existing conversation. It does not send prompts.
"""
import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
from scripts.cdp_client import CDPConnection, get_tabs, is_gemini_url

INIT = r"""(() => {
  const events = [];
  Object.defineProperty(window, '__geminiRendererProbe', {value: events});
  const calls = [];
  Object.defineProperty(window, '__geminiKatexCalls', {value: calls});
  const timer = setInterval(() => {
    const k = window.katex;
    if (!k) return;
    for (const key of ['render', 'renderToString']) {
      const originalCall = k[key];
      if (typeof originalCall !== 'function' || originalCall.__rendererProbeWrapped) continue;
      const wrapped = function(...args) {
        calls.push({order:calls.length,time:performance.now(),method:key,source:args[0],
          options:key==='render' ? args[2] : args[1],
          target:key==='render' ? {tagName:args[1]?.tagName,className:String(args[1]?.className)} : null,
          stack:new Error().stack});
        return Reflect.apply(originalCall,this,args);
      };
      wrapped.__rendererProbeWrapped=true;
      k[key]=wrapped;
    }
    if (k.render?.__rendererProbeWrapped && k.renderToString?.__rendererProbeWrapped) clearInterval(timer);
  },0);
  const original = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (name === 'data-math') events.push({order: events.length, time: performance.now(),
      value: String(value), tagName: this.tagName, className: String(this.className),
      stack: new Error().stack});
    return Reflect.apply(original, this, arguments);
  };
})();"""

CAPTURE = r"""(() => {
  const needle = __NEEDLE__;
  const all = [...document.querySelectorAll('[data-math], .katex, .katex-display')];
  const nodes = all.filter(el => el.hasAttribute('data-math') || !el.closest('[data-math]'));
  const describe = el => ({tagName: el.tagName, className: String(el.className),
    dataMath: el.getAttribute('data-math'), outerHTML: el.outerHTML,
    ancestors: [...(function*(x){for(let i=0;x && i<6;i++,x=x.parentElement)yield x})(el)]
      .map(x=>({tagName:x.tagName,className:String(x.className),dataMath:x.getAttribute('data-math')})),
    previousSibling: el.parentElement?.previousElementSibling?.outerHTML?.slice(0,3000) || null,
    tableCell: el.closest('td,th')?.outerHTML || null,
    tableRowCellCount: el.closest('tr')?.querySelectorAll('td,th').length || null});
  const relevant = nodes.filter(el => !needle || (el.getAttribute('data-math')||'').includes(needle)
    || (el.closest('p,table,div')?.textContent||'').includes(needle));
  const blocks = relevant.map(el=>el.closest('p,table,li')||el.parentElement).filter(Boolean);
  return {url:location.href,title:document.title,katexGlobal:typeof window.katex,
    nodeCount:nodes.length,mathNodes:relevant.map(describe),
    renderedBlocks:[...new Set(blocks)].map(el=>el.outerHTML),
    resources:performance.getEntriesByType('resource').filter(x=>/\.js(?:$|\?)/.test(x.name)).map(x=>x.name),
    mutations:window.__geminiRendererProbe||[],mathCalls:window.__geminiKatexCalls||[]};
})()"""

def main():
    case, url, needle = sys.argv[1:4]
    if not is_gemini_url(url):
        raise SystemExit('URL must be an official Gemini page')
    tab = next((t for t in get_tabs() if t.get('type') == 'page' and is_gemini_url(t.get('url'))), None)
    if not tab:
        raise SystemExit('No Gemini page on CDP port 9222')
    c = CDPConnection(tab['webSocketDebuggerUrl'])
    c.call('Page.enable')
    c.call('Page.addScriptToEvaluateOnNewDocument', {'source': INIT})
    c.call('Page.navigate', {'url': url})
    deadline = time.time() + 45
    result = None
    while time.time() < deadline:
        time.sleep(2)
        result = c.eval(CAPTURE.replace('__NEEDLE__', json.dumps(needle)))
        if isinstance(result, dict) and result.get('mathNodes') and result.get('mathCalls'):
            break
    if not isinstance(result, dict):
        raise SystemExit('DOM capture failed')
    out = ROOT / 'artifacts/gemini-renderer-probe' / case
    out.mkdir(parents=True, exist_ok=True)
    for name, value in [('dom.json', {k:v for k,v in result.items() if k not in ('resources','mutations','mathCalls','renderedBlocks')}),
                        ('mutation-stacks.json', result['mutations']), ('resources.json', result['resources'])]:
        (out/name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    (out/'rendered.html').write_text('\n'.join(result['renderedBlocks']), encoding='utf-8')
    (out/'math-calls.json').write_text(json.dumps(result['mathCalls'],ensure_ascii=False,indent=2), encoding='utf-8')
    print(json.dumps({'case':case,'url':url,'mathNodes':len(result['mathNodes']),
                      'totalMathNodes':result['nodeCount'],'mutations':len(result['mutations']),
                      'katexGlobal':result['katexGlobal'],'mathCalls':len(result['mathCalls']),
                      'domSha256':hashlib.sha256((out/'dom.json').read_bytes()).hexdigest()},ensure_ascii=False))

if __name__ == '__main__':
    main()
