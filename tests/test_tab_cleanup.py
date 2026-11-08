"""Acceptance tab cleanup preserves existing pages and survives delayed feedback."""
import unittest
from unittest.mock import Mock, patch
from scripts.framework.tab_cleanup import TestTabScope, uninstall_extension, is_feedback


def page(identity, url):
    return {'id': identity, 'url': url, 'type': 'page'}


class TabCleanupTests(unittest.TestCase):
    def test_feedback_detection_accepts_both_sources(self):
        self.assertTrue(is_feedback('https://tally.so/r/Y56ZBB?source=extension'))
        self.assertTrue(is_feedback('https://tally.so/r/Y56ZBB?source=uninstall'))
        self.assertFalse(is_feedback('https://tally.so/r/other?source=uninstall'))

    @patch('scripts.framework.tab_cleanup.time.monotonic', side_effect=[0, 3])
    @patch('scripts.framework.tab_cleanup.CDPConnection')
    @patch('scripts.framework.tab_cleanup.get_browser_ws_url', return_value='ws://browser')
    @patch('scripts.framework.tab_cleanup.get_tabs')
    def test_scope_closes_new_test_pages_only(self, tabs, ws, connection, monotonic):
        original = page('original', 'https://gemini.google.com/app/user-chat')
        tabs.return_value = [original]
        scope = TestTabScope(9222)
        tabs.return_value = [original, page('tour', 'chrome-extension://test/src/ui/options/options.html?startTour=1'),
                             page('chat', 'https://gemini.google.com/app/new-chat'),
                             page('other', 'https://example.com'),
                             page('foreign', 'chrome-extension://other/src/ui/options/options.html')]
        connection.return_value.call.return_value = {'result': {'success': True}}
        scope.close("test")
        self.assertEqual(connection.return_value.call.call_args_list,
                         [unittest.mock.call('Target.closeTarget', {'targetId': identity}) for identity in ('tour', 'chat')])
        connection.return_value.close.assert_called_once()

    @patch('scripts.framework.tab_cleanup.time.sleep')
    @patch('scripts.framework.tab_cleanup.time.monotonic', side_effect=[0, 0.1, 3])
    @patch('scripts.framework.tab_cleanup.CDPConnection')
    @patch('scripts.framework.tab_cleanup.get_browser_ws_url', return_value='ws://browser')
    @patch('scripts.framework.tab_cleanup.get_tabs')
    def test_scope_drains_late_install_page(self, tabs, ws, connection, monotonic, sleep):
        tabs.side_effect = [[], [], [page('late', 'chrome-extension://test/src/ui/options/options.html?startTour=1')]]
        connection.return_value.call.return_value = {'result': {'success': True}}
        TestTabScope(9222).close('test')
        connection.return_value.call.assert_called_once_with('Target.closeTarget', {'targetId': 'late'})

    @patch('scripts.framework.tab_cleanup.time.sleep')
    @patch('scripts.framework.tab_cleanup.get_tabs')
    def test_delayed_survey_closed_but_existing_survey_retained(self, tabs, sleep):
        original = page('old-survey', 'https://tally.so/r/Y56ZBB')
        unrelated = page('other-survey', 'https://tally.so/r/other')
        new = page('new-survey', 'https://tally.so/r/Y56ZBB?source=uninstall')
        tabs.side_effect = [[original], [original, unrelated], [original, unrelated, new]]
        browser = Mock()
        browser.call.return_value = {'result': {}}
        uninstall_extension(browser, 'exporter', 9222)
        self.assertEqual(browser.call.call_args_list, [
            unittest.mock.call('Extensions.uninstall', {'id': 'exporter'}),
            unittest.mock.call('Target.closeTarget', {'targetId': 'new-survey'})])

    @patch('scripts.chrome_diagnostics.BrowserDiagnostics')
    @patch('scripts.framework.tab_cleanup.TestTabScope')
    def test_failed_preparation_still_reclaims_tabs(self, scope, diagnostics):
        from types import SimpleNamespace
        from scripts.framework.features import FeatureRegistry
        from scripts.framework.platforms.core import PlatformSession, run_session
        context = SimpleNamespace(port=9222, output_dir='/tmp/test-tabs', ext_id='test',
                                  registry=FeatureRegistry(standard=False))
        diagnostics.return_value.failure = None
        session = PlatformSession(SimpleNamespace(cases={}), context,
                                  Mock(side_effect=RuntimeError('prepare failed')), Mock())
        report = {}
        self.assertFalse(run_session(session, report))
        scope.return_value.close.assert_called_once_with('test')
        session.close.assert_called_once()

    @patch('scripts.framework.tab_cleanup.get_tabs', return_value=[])
    def test_uninstall_failure_does_not_close_pages(self, tabs):
        browser = Mock()
        browser.call.return_value = {'error': {'message': 'failed'}}
        self.assertIn('error', uninstall_extension(browser, 'exporter', 9222))
        browser.call.assert_called_once()
