#!/usr/bin/env python3
"""Focused Tier 2 rate-limit diagnostic, not the full lifecycle acceptance suite."""
import json
import argparse
import shutil
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.framework import chatgpt_live
from scripts.framework.pipeline import ProcessLock
from scripts.framework.scenario_provider import OnlineScenarioProvider


class RateLimitObserved(RuntimeError):
    pass


def run(resume_from=None):
    output = ROOT / 'tests/output' / ('chatgpt_429_' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    output.mkdir(parents=True)
    report = {'scope': '429 diagnostic only', 'startedAt': datetime.now(timezone.utc).isoformat(), 'phases': []}
    observer_log = (output / 'observer.log').open('w')
    observer = subprocess.Popen(['node', 'scripts/chatgpt_network_audit.cjs', '9222', str(output)], cwd=ROOT, stdout=observer_log, stderr=subprocess.STDOUT)
    runner = chatgpt_live.ChatGPTLiveRunner(output_dir=output, delay=6)
    if resume_from:
        previous = Path(resume_from).resolve()
        report['resumedFrom'] = str(previous)
        runner.dataset = json.loads((previous/'dataset.json').read_text())
        for saved in previous.glob('*.source.json'):
            shutil.copyfile(saved, output/saved.name)
    original_wait = chatgpt_live.wait_for

    def check():
        if observer.poll() is not None:
            raise RuntimeError('Network observer stopped; cannot make a measured claim')
        if (output / 'first-429.json').exists():
            if runner.options:
                runner.options.eval("const cancel=document.getElementById('btnCancel');if(cancel&&cancel.style.display!=='none')cancel.click();if(document.body.dataset.scanning==='true')document.getElementById('btnSyncAll')?.click()")
            raise RateLimitObserved('First HTTP 429 captured; further test load stopped')

    def measured_wait(operation, timeout=90, interval=.5):
        def measured():
            check()
            value = operation()
            check()
            return value
        return original_wait(measured, timeout, interval)

    def phase(name, operation):
        check()
        entry = {'name': name, 'startedAt': datetime.now(timezone.utc).isoformat()}
        report['phases'].append(entry)
        print('[429 diagnostic] ' + name, flush=True)
        try:
            value = operation()
            check()
            entry['status'] = 'completed'
            return value
        finally:
            entry.setdefault('status', 'stopped' if (output/'first-429.json').exists() else 'incomplete')
            entry['finishedAt'] = datetime.now(timezone.utc).isoformat()
            (output/'diagnostic.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))

    try:
        original_wait(lambda: (output/'observer-ready').exists() or observer.poll() is not None, 30)
        check()
        chatgpt_live.wait_for = measured_wait
        with ProcessLock():
            phase('connection', runner.prepare)
            def baseline():
                for _ in range(30):
                    check()
                    time.sleep(1)
            phase('idle_baseline_30s', baseline)
            if runner.dataset is None:
                provider = OnlineScenarioProvider()
                runner.dataset = [provider.pop_scenario(min_turns=5), provider.pop_scenario(min_turns=8)]
            (output/'dataset.json').write_text(json.dumps(runner.dataset, ensure_ascii=False, indent=2))
            phase('complex_chat_5_plus_8', runner.generate)
            phase('workbench_scan', runner.sync)
            phase('four_format_export', runner.exports)
            report['outcome'] = 'no_429_observed_in_completed_diagnostic'
    except RateLimitObserved as error:
        report['outcome'] = '429_observed'
        report['stoppedReason'] = str(error)
        report['first429'] = json.loads((output/'first-429.json').read_text())
        print(str(error), flush=True)
    except Exception as error:
        import traceback
        traceback.print_exc()
        report['outcome'] = 'diagnostic_incomplete'
        report['error'] = str(error)
    finally:
        # Allow the already received error response to finish, without issuing load.
        time.sleep(2)
        observer.terminate()
        observer.wait(timeout=10)
        observer_log.close()
        chatgpt_live.wait_for = original_wait
        rows = [json.loads(line) for line in (output/'network.jsonl').read_text().splitlines()] if (output/'network.jsonl').exists() else []
        requests = [r for r in rows if r['event'] == 'request']
        responses = [r for r in rows if r['event'] == 'response']
        report['requestCount'] = len(requests)
        report['responseStatuses'] = dict(Counter(str(r['status']) for r in responses))
        report['endpoints'] = [dict(method=method, url=url, count=count) for (method, url), count in Counter((r['method'], r['url']) for r in requests).items()]
        report['rateLimitResponses'] = [r for r in rows if r['event'] in ['rate_limit_body', 'response'] and (r.get('status') == 429 or r['event'] == 'rate_limit_body')]
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        (output/'diagnostic.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        runner.save_report()
        for connection in [runner.options, runner.chat, runner.browser]:
            if connection:
                connection.close()
        print('Evidence: ' + str(output), flush=True)
        print(json.dumps({key: report.get(key) for key in ['outcome', 'requestCount', 'responseStatuses']}, ensure_ascii=False), flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resume-from', type=Path, help='Continue the exact reserved scenario prefix after a harness failure')
    run(parser.parse_args().resume_from)
