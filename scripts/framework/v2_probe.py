"""Load test-only v2 owner probes into Options; no production compatibility globals."""
import functools
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@functools.lru_cache(maxsize=1)
def probe_bundle():
    result = subprocess.run(['node', '-e', """
        require('esbuild').build({entryPoints:['scripts/framework/v2_probe.ts'],bundle:true,
            write:false,format:'iife',platform:'browser',conditions:['worker','browser'],
            define:{__EXT_VERSION__:JSON.stringify('2.0.0')},logLevel:'silent'})
        .then(r=>process.stdout.write(r.outputFiles[0].text)).catch(e=>{console.error(e);process.exitCode=1});
    """], cwd=ROOT, check=True, capture_output=True, text=True)
    return result.stdout


def install_probe(cdp):
    if cdp.eval('!!globalThis.__tier2V2') is not True:
        cdp.eval(probe_bundle())


def snapshot(cdp, provider_id="gemini"):
    install_probe(cdp)
    import json
    return cdp.eval('globalThis.__tier2V2.snapshot('+json.dumps(provider_id)+')', await_promise=True)
