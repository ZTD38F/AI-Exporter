"""Bound local acceptance tab lifetimes without touching pre-existing pages."""
import time
from urllib.parse import urlsplit

from scripts.cdp_client import CDPConnection, get_browser_ws_url, get_tabs


# Match the shared Tally form path for either source; is_feedback intentionally ignores query parameters.
FEEDBACK_URL = 'https://tally.so/r/Y56ZBB'


def is_feedback(url):
    parsed = urlsplit(url)
    expected = urlsplit(FEEDBACK_URL)
    return (parsed.scheme, parsed.netloc, parsed.path) == (expected.scheme, expected.netloc, expected.path)


def uninstall_extension(browser, ext_id, port):
    """Perform a real uninstall, then close only its newly opened feedback page."""
    before = {tab['id'] for tab in get_tabs(port)}
    result = browser.call('Extensions.uninstall', {'id': ext_id})
    if result.get('error'):
        return result
    deadline = time.monotonic() + 2
    while True:
        for tab in get_tabs(port):
            if tab['id'] not in before and tab.get('type') == 'page' and is_feedback(tab.get('url', '')):
                browser.call('Target.closeTarget', {'targetId': tab['id']})
                return result
        if time.monotonic() >= deadline:
            return result
        time.sleep(0.1)


class TestTabScope:
    """Reclaim new test surfaces on success and failure; retain original tabs."""
    def __init__(self, port):
        self.port = port
        self.before = {tab['id'] for tab in get_tabs(port)}

    def close(self, ext_id=None):
        browser = CDPConnection(get_browser_ws_url(self.port))
        try:
            # Target closure and onInstalled page creation are asynchronous.
            # Drain late pages as well as those present at the first snapshot.
            deadline = time.monotonic() + 2
            while True:
                for tab in get_tabs(self.port):
                    if tab['id'] in self.before or tab.get('type') != 'page':
                        continue
                    url = urlsplit(tab.get('url', ''))
                    provider = url.scheme == 'https' and url.hostname in (
                        'gemini.google.com', 'bard.google.com', 'chatgpt.com', 'chat.openai.com', 'claude.ai')
                    workbench = url.scheme == 'chrome-extension' and url.netloc == ext_id and url.path in (
                        '/src/ui/options/options.html', '/src/ui/popup/popup.html')
                    if provider or workbench or is_feedback(tab.get('url', '')):
                        result = browser.call('Target.closeTarget', {'targetId': tab['id']})
                        if result.get('error'):
                            raise RuntimeError(result['error'])
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.1)
        finally:
            browser.close()
