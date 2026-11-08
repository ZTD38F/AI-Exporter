"""Local-only Chrome evidence. Never restarts or terminates a browser."""
import json
import os
from pathlib import Path
import shutil
import threading
import time
import urllib.request
from datetime import datetime, timezone


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def browser_version(port):
    # Ignore proxy environment variables for the local debugging endpoint.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{port}/json/version', timeout=2) as response:
        version = json.load(response)
    if not version.get('webSocketDebuggerUrl') or not version.get('Browser'):
        raise RuntimeError('Port does not expose a Chrome browser endpoint')
    return version


class BrowserDiagnostics:
    """Latch endpoint loss/replacement so later recovery cannot turn a run green."""
    def __init__(self, port, output_dir):
        self.port = port
        self.output = Path(output_dir) / 'chrome-diagnostics' / str(time.time_ns())
        self.started = time.time()
        self.stage = 'connection'
        self.failure = None
        self.stop_event = threading.Event()
        self.thread = None
        self.version = None
        self.launch_metadata = None
        self.lock = threading.RLock()

    def event(self, event, **fields):
        self.output.mkdir(parents=True, exist_ok=True)
        with self.lock, (self.output / 'events.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(dict(time=timestamp(), event=event, stage=self.stage,
                                         **fields), ensure_ascii=False) + '\n')

    def start(self):
        self.output.mkdir(parents=True, exist_ok=True)
        self.version = browser_version(self.port)
        (self.output / 'browser.json').write_text(json.dumps(self.version, indent=2), encoding='utf-8')
        profile = Path(os.environ.get('GEMINI_EXPORTER_TEST_PROFILE',
                                      str(Path.home() / '.gemini-exporter-test-profile')))
        try:
            metadata = json.loads((profile / 'chrome-launch.json').read_text(encoding='utf-8'))
            if metadata.get('browser', {}).get('webSocketDebuggerUrl') == self.version['webSocketDebuggerUrl']:
                self.launch_metadata = metadata
        except (OSError, ValueError, KeyError) as error:
            self.event('launcher_evidence_unavailable', error=str(error))
        self.event('connected', port=self.port)
        self.thread = threading.Thread(target=self._watch, daemon=True)
        self.thread.start()

    def check(self):
        with self.lock:
            if self.failure:
                raise RuntimeError(self.failure)
        try:
            current = browser_version(self.port)
            if current['webSocketDebuggerUrl'] != self.version['webSocketDebuggerUrl']:
                raise RuntimeError('Chrome browser instance was replaced')
        except Exception as error:
            with self.lock:
                if not self.failure:
                    self.failure = f'Chrome connection lost or replaced during {self.stage}: {error}'
                    self.event('browser_failure', error=self.failure)
            raise RuntimeError(self.failure) from error

    def _watch(self):
        while not self.stop_event.wait(1):
            try:
                self.check()
            except Exception:
                return

    def checkpoint(self, stage):
        self.stage = stage
        self.event('stage')
        self.check()

    def finish(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)
        # Use the identity captured at start, even if a later launch overwrites the profile pointer.
        if self.launch_metadata:
            try:
                launch = Path(self.launch_metadata['log_dir'])
                for name in ('launch.json', 'chrome.log', 'stderr.log'):
                    if (launch / name).is_file():
                        shutil.copy2(launch / name, self.output / name)
            except (OSError, ValueError, KeyError) as error:
                self.event('launcher_evidence_unavailable', error=str(error))
        # Reports may be emitted after teardown. Do not mislabel unrelated reports as causal.
        reports = Path.home() / 'Library/Logs/DiagnosticReports'
        candidates = []
        if reports.is_dir():
            for source in reports.glob('Google Chrome*.ips'):
                try:
                    if source.stat().st_mtime >= self.started:
                        target = self.output / 'crash-report-candidates' / source.name
                        target.parent.mkdir(exist_ok=True)
                        shutil.copy2(source, target)
                        candidates.append(source.name)
                except OSError as error:
                    self.event('crash_report_copy_error', error=str(error))
        self.event('finished', failure=self.failure, crash_report_candidates=candidates)
        return {'directory': str(self.output.resolve()), 'failure': self.failure,
                'crash_report_candidates': candidates}
