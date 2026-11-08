# tests/test_framework_environment.py
"""
Unit tests for Tier 2 TestEnvironment (scripts/framework/environment.py).
Validates:
- Unified environment lifecycle initialization (reinstall, tab discovery, viewport, download)
- Gemini and Options tab resolution and WebSocket debugger URL connection
- Viewport standardization (1280x800) and cleanup
- TestContext and VisualPlayground delegation
"""

import os
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.framework.environment import TestEnvironment, EnvironmentContext
from scripts.framework.cases.chat import InpageBadgeCase
from tests.test_tab_cleanup import TabCleanupTests


from scripts.framework.assertions import CDPAssertions


class TestPdfMathAssertion(unittest.TestCase):
    def test_normal_latex_prose_and_code_are_not_renderer_fallbacks(self):
        for text in ("Use LaTeX and state the units of every parameter.",
                     r"LaTeX \frac{1}{2} in a tutorial code example"):
            with self.subTest(text=text):
                self.assertEqual(CDPAssertions.assert_pdf_math_compiled(text), (True, ""))

    def test_real_renderer_fallback_preserves_failure_and_formula_context(self):
        for label in ("Could not typeset this formula; original LaTeX preserved:",
                      "\u65e0\u6cd5\u6392\u7248\u8be5\u516c\u5f0f\uff1b\u4fdd\u7559\u539f\u59cb LaTeX\uff1a"):
            formula = r"\Lambda(X) \gtrso_{D_0}^{D_1} \gamma"
            passed, context = CDPAssertions.assert_pdf_math_compiled(label + formula)
            self.assertFalse(passed)
            self.assertIn(formula, context)

    def test_fallback_label_survives_extraction_whitespace(self):
        self.assertFalse(CDPAssertions.assert_pdf_math_compiled(
            "Couldnottypesetthis\nformula; original LaTeX preserved:" )[0])
        self.assertFalse(CDPAssertions.assert_pdf_math_compiled(
            "\u65e0 \u6cd5\u6392\n\u7248\u8be5\u516c\u5f0f")[0])


class MockCDP:
    def __init__(self, ws_url="ws://127.0.0.1:9222/devtools/page/mock1"):
        self.ws_url = ws_url
        self.calls = []
        self.evals = []
        self.closed = False

    def call(self, method, params=None):
        self.calls.append({"method": method, "params": params or {}})
        if method == "Extensions.loadUnpacked":
            return {"result": {"id": "mock_unpacked_id"}}
        return {}

    def eval(self, expr, await_promise=False):
        self.evals.append(expr)
        return None

    def close(self):
        self.closed = True


class TestFrameworkEnvironment(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.env = TestEnvironment(
            port=9222,
            output_dir=self.temp_dir,
            viewport_size=(1280, 800)
        )

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_environment_initialization_defaults(self):
        self.assertEqual(self.env.port, 9222)
        self.assertEqual(self.env.viewport_size, (1280, 800))
        self.assertEqual(self.env.output_dir, self.temp_dir)
        self.assertTrue(os.path.isdir(self.env.output_dir))
        self.assertIsNone(self.env.ext_id)

    @patch("scripts.framework.environment.CDPActions.reinstall_extension")
    def test_reinstall_extension_updates_ext_id(self, mock_reinstall):
        mock_reinstall.return_value = "new_test_ext_id"
        result = self.env.reinstall_extension()
        self.assertEqual(result, "new_test_ext_id")
        self.assertEqual(self.env.ext_id, "new_test_ext_id")
        self.assertEqual(self.env.get_extension_id(), "new_test_ext_id")
        mock_reinstall.assert_called_once_with(port=9222, repo_path=self.env.repo_path)

    @patch("scripts.framework.environment.get_tabs")
    @patch("scripts.framework.environment.CDPActions.reinstall_extension", return_value=None)
    def test_failed_reinstall_aborts_before_opening_tabs(self, mock_reinstall, mock_get_tabs):
        with self.assertRaisesRegex(RuntimeError, "扩展安装失败"):
            self.env.init_environment(reinstall=True, target_pages=("gemini", "options"),
                                      active_target="options", setup_download=False)
        self.assertIsNone(self.env.ext_id, "a failed reinstall must not report an active extension")
        mock_reinstall.assert_called_once()
        mock_get_tabs.assert_not_called()

    @patch("scripts.framework.environment.get_tabs")
    def test_tab_discovery(self, mock_get_tabs):
        mock_get_tabs.return_value = [
            {"type": "webview", "url": "https://gemini.google.com/glic?hl=zh-CN", "webSocketDebuggerUrl": "ws://mock/glic"},
            {"type": "page", "url": "https://gemini.google.com/app", "webSocketDebuggerUrl": "ws://mock/gemini"},
            {"type": "page", "url": "chrome-extension://test_id/src/ui/options/options.html", "webSocketDebuggerUrl": "ws://mock/options"}
        ]
        self.env.ext_id = "test_id"

        gemini_tab = self.env.get_gemini_tab()
        self.assertIsNotNone(gemini_tab)
        self.assertEqual(gemini_tab["webSocketDebuggerUrl"], "ws://mock/gemini")

        options_tab = self.env.get_options_tab()
        self.assertIsNotNone(options_tab)
        self.assertEqual(options_tab["webSocketDebuggerUrl"], "ws://mock/options")

        # ensure_tab logic resolution
        self.assertEqual(self.env.ensure_tab("gemini")["webSocketDebuggerUrl"], "ws://mock/gemini")
        self.assertEqual(self.env.ensure_tab("chat")["webSocketDebuggerUrl"], "ws://mock/gemini")
        self.assertEqual(self.env.ensure_tab("options")["webSocketDebuggerUrl"], "ws://mock/options")
        self.assertEqual(self.env.ensure_tab("workbench")["webSocketDebuggerUrl"], "ws://mock/options")

    @patch("scripts.framework.environment.get_tabs")
    def test_extension_pages_never_fall_back_to_foreign_tabs(self, mock_get_tabs):
        self.env.ext_id = "current_id"
        for kind in ("options", "popup"):
            with self.subTest(kind=kind):
                path = f"/src/ui/{kind}/{kind}.html"
                mock_get_tabs.return_value = [
                    {"url": f"chrome-extension://old_id{path}"},
                    {"url": f"https://example.com/?next=chrome-extension://current_id{path}"},
                    {"url": f"chrome-extension://current_id{path}.old"},
                    {"type": "service_worker", "url": f"chrome-extension://current_id{path}"},
                ]
                get_tab = getattr(self.env, f"get_{kind}_tab")
                self.assertIsNone(get_tab())
                current = {"type": "page", "url": f"chrome-extension://current_id{path}?test=1#ready",
                           "webSocketDebuggerUrl": "ws://mock/current"}
                mock_get_tabs.return_value.append(current)
                with patch('scripts.framework.environment.CDPConnection') as connection:
                    connection.return_value.eval.return_value = True
                    self.assertIs(get_tab(), current)

    @patch('scripts.framework.environment.CDPConnection')
    @patch('scripts.framework.environment.get_tabs')
    def test_popup_discovery_rejects_standalone_popup_html_tab(self, tabs, connection):
        self.env.ext_id = 'current_id'
        standalone = {'type': 'page', 'url': 'chrome-extension://current_id/src/ui/popup/popup.html',
                      'webSocketDebuggerUrl': 'ws://mock/standalone'}
        popup = dict(standalone, webSocketDebuggerUrl='ws://mock/action')
        tabs.return_value = [standalone, popup]
        first, second = MagicMock(), MagicMock()
        first.eval.return_value, second.eval.return_value = False, True
        connection.side_effect = [first, second]
        self.assertIs(self.env.get_popup_tab(), popup)
        first.close.assert_called_once()
        second.close.assert_called_once()

    @patch("scripts.framework.environment.urllib.request.urlopen")
    @patch("scripts.framework.environment.get_extension_id", return_value=None)
    def test_unknown_extension_does_not_open_relative_pages(self, mock_id, mock_open):
        self.assertIsNone(self.env.ensure_options_tab())
        self.assertIsNone(self.env.ensure_popup_tab())
        mock_open.assert_not_called()

    @patch("scripts.framework.environment.time.sleep")
    @patch("scripts.framework.environment.urllib.request.urlopen")
    @patch("scripts.framework.environment.get_tabs")
    def test_foreign_options_tab_causes_current_extension_page_creation(self, mock_tabs, mock_open, mock_sleep):
        self.env.ext_id = "current_id"
        mock_tabs.return_value = [{"url": "chrome-extension://old_id/src/ui/options/options.html"}]
        created = {"id": "new", "url": "chrome-extension://current_id/src/ui/options/options.html"}
        import json
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(created).encode()
        self.assertEqual(self.env.ensure_options_tab(), created)
        request = mock_open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:9222/json/new?" + created["url"])
        self.assertEqual(request.method, "PUT")

    @patch("scripts.framework.environment.time.sleep")
    @patch("scripts.framework.environment.urllib.request.urlopen")
    @patch("scripts.framework.environment.get_tabs")
    def test_waits_for_install_tour_instead_of_creating_duplicate(self, tabs, open_url, sleep):
        self.env.ext_id = 'current_id'
        self.env._await_install_options = True
        tour = {'id': 'tour', 'type': 'page',
                'url': 'chrome-extension://current_id/src/ui/options/options.html?startTour=1'}
        tabs.side_effect = [[], [], [tour]]
        self.assertEqual(self.env.ensure_options_tab(), tour)
        open_url.assert_not_called()
        self.assertFalse(self.env._await_install_options)

    def test_setup_and_clear_viewport(self):
        mock_cdp = MockCDP()
        self.env.setup_viewport(mock_cdp, (1920, 1080))
        methods = [c["method"] for c in mock_cdp.calls]
        self.assertIn("Emulation.clearDeviceMetricsOverride", methods)
        self.assertIn("Emulation.setDeviceMetricsOverride", methods)
        set_override = next(c for c in mock_cdp.calls if c["method"] == "Emulation.setDeviceMetricsOverride")
        self.assertEqual(set_override["params"]["width"], 1920)
        self.assertEqual(set_override["params"]["height"], 1080)
        self.assertEqual(set_override["params"]["deviceScaleFactor"], 1)
        self.assertEqual(set_override["params"]["mobile"], False)

        # clear viewport
        self.env.clear_viewport(mock_cdp)
        self.assertEqual(mock_cdp.calls[-1]["method"], "Emulation.clearDeviceMetricsOverride")

    @patch("scripts.framework.environment.get_extension_id", return_value="download_test_extension")
    @patch("scripts.framework.environment.get_browser_ws_url")
    @patch("scripts.framework.environment.CDPConnection")
    def test_setup_download_behavior(self, mock_conn, mock_browser_ws, mock_extension_id):
        mock_browser_cdp = MockCDP()
        mock_conn.return_value = mock_browser_cdp
        mock_browser_ws.return_value = "ws://mock/browser"

        page_cdp = MockCDP()
        self.env.setup_download_behavior(output_dir=self.temp_dir, cdp=page_cdp)

        mock_extension_id.assert_called_once_with(9222)
        permission_calls = [c for c in mock_browser_cdp.calls if c["method"] == "Browser.grantPermissions"]
        self.assertEqual(permission_calls, [{"method": "Browser.grantPermissions", "params": {
            "permissions": ["localFonts"], "origin": "chrome-extension://download_test_extension",
        }}])
        browser_calls = [c for c in mock_browser_cdp.calls if c["method"] == "Browser.setDownloadBehavior"]
        self.assertEqual(browser_calls, [{
            "method": "Browser.setDownloadBehavior",
            "params": {"behavior": "allow", "downloadPath": self.temp_dir, "eventsEnabled": True},
        }])

        page_calls = [c for c in page_cdp.calls if c["method"] == "Page.setDownloadBehavior"]
        self.assertEqual(page_calls, [{
            "method": "Page.setDownloadBehavior",
            "params": {"behavior": "allow", "downloadPath": self.temp_dir},
        }])

    @patch("scripts.framework.environment.get_browser_ws_url", return_value=None)
    def test_download_configuration_uses_page_transport_when_browser_websocket_is_unavailable(self, mock_browser_ws):
        page = MockCDP()
        self.env.setup_download_behavior(cdp=page)
        self.assertEqual(self.env.browser_cdp, None)
        self.assertEqual(
            [call["params"]["downloadPath"] for call in page.calls if call["method"] == "Page.setDownloadBehavior"],
            [self.temp_dir],
        )
        self.assertGreaterEqual(mock_browser_ws.call_count, 1, 'browser discovery must have been attempted')

    @patch("scripts.framework.environment.CDPActions.reinstall_extension")
    @patch("scripts.framework.environment.get_tabs")
    @patch("scripts.framework.environment.CDPConnection")
    def test_init_environment_full_pipeline(self, mock_conn, mock_get_tabs, mock_reinstall):
        mock_reinstall.return_value = "pipeline_ext_id"
        mock_get_tabs.return_value = [
            {"url": "https://gemini.google.com/app", "webSocketDebuggerUrl": "ws://mock/gemini"},
            {"url": "chrome-extension://pipeline_ext_id/src/ui/options/options.html", "webSocketDebuggerUrl": "ws://mock/options"}
        ]
        mock_cdp = MockCDP()
        mock_conn.return_value = mock_cdp

        ctx = self.env.init_environment(
            reinstall=True,
            target_pages=("gemini", "options"),
            active_target="options",
            reload_gemini=True,
            setup_viewport=True,
            setup_download=False
        )

        self.assertIsInstance(ctx, EnvironmentContext)
        self.assertEqual(ctx.ext_id, "pipeline_ext_id")
        self.assertIsNotNone(ctx.gemini_tab)
        self.assertIsNotNone(ctx.options_tab)
        self.assertEqual(ctx.active_tab, ctx.options_tab, "active_target=options must select this extension's workbench")
        self.assertIs(ctx.active_cdp, mock_cdp)
        self.assertTrue(any("location.reload()" in expr for expr in mock_cdp.evals),
                        "reinstall+reload_gemini must execute a real CDP reload")
        viewport = [call["params"] for call in mock_cdp.calls
                    if call["method"] == "Emulation.setDeviceMetricsOverride"]
        self.assertEqual(viewport, [{
            "width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": False,
        }])
        self.assertFalse(any("DownloadBehavior" in call["method"] for call in mock_cdp.calls),
                         "setup_download=False must not configure download behavior")
        mock_reinstall.assert_called_once_with(port=9222, repo_path=self.env.repo_path)

    def test_teardown_cleans_viewport_and_closes_connection(self):
        mock_cdp = MockCDP()
        self.env.teardown(mock_cdp)
        self.assertTrue(mock_cdp.closed)
        methods = [c["method"] for c in mock_cdp.calls]
        self.assertIn("Emulation.clearDeviceMetricsOverride", methods)


class InpageBadgeTests(unittest.TestCase):
    @patch('scripts.framework.cases.chat.time.sleep')
    @patch('scripts.framework.cases.chat.time.monotonic', side_effect=[0, 0, 1])
    def test_waits_for_badge_instead_of_failing_during_reload(self, clock, sleep):
        ctx = MagicMock()
        cdp = ctx.connect_gemini.return_value
        cdp.eval.side_effect = [None, False, True]
        self.assertTrue(InpageBadgeCase().execute(ctx)[0])
        self.assertEqual(cdp.eval.call_count, 3)
        cdp.close.assert_called_once()
        self.assertTrue(all('document.querySelector' in call.args[0] for call in cdp.eval.call_args_list))

    @patch('scripts.framework.cases.chat.time.sleep')
    @patch('scripts.framework.cases.chat.time.monotonic', side_effect=[0, 0, 30])
    def test_missing_badge_still_fails_at_deadline(self, clock, sleep):
        ctx = MagicMock()
        ctx.connect_gemini.return_value.eval.return_value = False
        result = InpageBadgeCase().execute(ctx)
        self.assertFalse(result[0])
        self.assertIn('30', result[1])
        ctx.connect_gemini.return_value.close.assert_called_once()


@patch("scripts.framework.tab_cleanup.get_tabs", return_value=[])
@patch("scripts.framework.tab_cleanup.time.monotonic", side_effect=lambda: next(TestWorkspaceReinstall.clock))
@patch("scripts.framework.actions.get_tabs", return_value=[])
class TestWorkspaceReinstall(unittest.TestCase):
    clock = iter(range(100000))
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo_path = self.directory.name
        self.manifest_path = Path(self.repo_path) / 'manifest.json'
        self.original = b'{ "name": "__MSG_extName__", "permissions": ["storage"], "optional_permissions": ["storage", "tabs"], "host_permissions": ["https://existing.test/*"], "optional_host_permissions": ["https://gemini.google.com/*", "https://chatgpt.com/*", "https://claude.ai/*"] }\n'
        locale = Path(self.repo_path) / '_locales' / 'zh_CN'
        locale.mkdir(parents=True)
        (locale / 'messages.json').write_text('{"extName":{"message":"Gemini Exporter"}}')
        self.manifest_path.write_bytes(self.original)

    def tearDown(self):
        self.assertEqual(self.manifest_path.read_bytes(), self.original)

    @patch("subprocess.run")
    @patch("scripts.framework.actions.time.sleep")
    @patch("scripts.framework.actions.get_browser_ws_url", return_value="ws://browser")
    @patch("scripts.framework.actions.CDPConnection")
    @patch("scripts.framework.actions.get_extension_id", return_value="unrelated-extension")
    def test_reinstall_removes_old_worktree_copies_and_preserves_other_products(self, discover, connection, ws, sleep, build, tabs, clock, cleanup_tabs):
        from scripts.framework.actions import CDPActions
        client = connection.return_value
        installed = [
            {'id': 'workspace-id', 'name': 'Gemini Exporter', 'path': self.repo_path},
            {'id': 'stale-id', 'name': 'Gemini Exporter', 'path': '/missing/worktree'},
            {'id': 'unrelated-extension', 'name': 'Other product', 'path': '/elsewhere'},
        ]
        def respond(method, params=None):
            manifest = json.loads(self.manifest_path.read_bytes())
            self.assertNotIn('optional_permissions', manifest)
            self.assertNotIn('optional_host_permissions', manifest)
            self.assertEqual(manifest['permissions'], ['storage', 'tabs'])
            self.assertEqual(manifest['host_permissions'], ['https://existing.test/*',
                'https://gemini.google.com/*', 'https://chatgpt.com/*', 'https://claude.ai/*'])
            if method == 'Extensions.getExtensions':
                return {'result': {'extensions': list(installed)}}
            if method == 'Extensions.uninstall':
                installed[:] = [entry for entry in installed if entry['id'] != params['id']]
                return {'result': {}}
            return {"result": {"id": "workspace-id"}}
        client.call.side_effect = respond
        self.assertEqual(CDPActions.reinstall_extension(repo_path=self.repo_path), "workspace-id")
        self.assertEqual([call.args[1]['id'] for call in client.call.call_args_list
                          if call.args[0] == 'Extensions.uninstall'], ['workspace-id', 'stale-id'])
        self.assertEqual([entry['id'] for entry in installed], ['unrelated-extension'])
        self.assertEqual(sum(c.args[0] == "Extensions.loadUnpacked" for c in client.call.call_args_list), 1)
        discover.assert_not_called()
        client.close.assert_called_once()

    @patch("subprocess.run")
    @patch("scripts.framework.actions.get_browser_ws_url", return_value="ws://browser")
    @patch("scripts.framework.actions.CDPConnection")
    def test_missing_identity_or_uninstall_failure_never_claims_clean_install(self, connection, ws, build, tabs, clock, cleanup_tabs):
        from scripts.framework.actions import CDPActions
        for responses in ([{"error": {"message": "inventory failed"}}],
                          [{"result": {"extensions": [{"id": "workspace-id", "name": "Gemini Exporter"}]}},
                           {"error": {"message": "uninstall failed"}}],
                          [{"result": {"extensions": []}}, {"result": {"extensions": []}},
                           {"error": {"message": "unsupported"}}]):
            client = connection.return_value
            client.reset_mock()
            client.call.side_effect = responses
            if len(responses) == 3:
                self.assertIsNone(CDPActions.reinstall_extension(repo_path=self.repo_path))
            else:
                with self.assertRaises(ValueError):
                    CDPActions.reinstall_extension(repo_path=self.repo_path)
            self.assertEqual(client.call.call_count, len(responses))
            client.close.assert_called_once()

    @patch("subprocess.run")
    @patch("scripts.framework.actions.get_browser_ws_url", return_value="ws://browser")
    @patch("scripts.framework.actions.CDPConnection")
    def test_exception_during_install_restores_manifest(self, connection, ws, build, tabs, clock, cleanup_tabs):
        from scripts.framework.actions import CDPActions
        connection.return_value.call.side_effect = RuntimeError('CDP disconnected')
        with self.assertRaisesRegex(RuntimeError, 'CDP disconnected'):
            CDPActions.reinstall_extension(repo_path=self.repo_path)
        connection.return_value.close.assert_called_once()


class TestExporterIdentity(unittest.TestCase):
    @patch("scripts.cdp_client.get_tabs")
    def test_worker_only_inventory_selects_exporter_over_other_extensions(self, tabs):
        from scripts.cdp_client import get_extension_id
        tabs.return_value = [
            {"url": "chrome-extension://other/background.js"},
            {"url": "chrome-extension://exporter/dist/background/background.js"},
            {"url": "chrome-extension://exporter/src/ui/options/options.html"},
        ]
        self.assertEqual(get_extension_id(), "exporter")

    @patch("scripts.cdp_client.get_tabs")
    def test_no_known_exporter_never_returns_an_unrelated_extension(self, tabs):
        from scripts.cdp_client import get_extension_id
        tabs.return_value = [{"url": "chrome-extension://other/background.js"},
                             {"url": "chrome-extension://other/options.html"},
                             {"url": "chrome-extension://other/unrelated/options.html"}]
        self.assertIsNone(get_extension_id())

    @patch("scripts.cdp_client.get_tabs")
    def test_ambiguous_exporter_inventory_fails_closed(self, tabs):
        from scripts.cdp_client import get_extension_id
        tabs.return_value = [{"url": "chrome-extension://first/dist/background/background.js"},
                             {"url": "chrome-extension://second/src/ui/options/options.html"}]
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            get_extension_id()


class TestUninstallLifecycleIdentity(unittest.TestCase):
    def run_case(self, response, extensions):
        from scripts.framework.cases.test_uninstall_lifecycle import UninstallLifecycleCase
        ctx = MagicMock(); ctx.ext_id = 'workspace-id'; ctx.port = 9222; ctx.worktree_root = '/tmp/exporter'
        owner = 'scripts.framework.cases.test_uninstall_lifecycle.'
        with patch(owner + 'get_browser_ws_url', return_value='ws://browser'), \
             patch(owner + 'CDPConnection') as connection, \
             patch(owner + 'time.sleep'), \
             patch(owner + 'get_tabs', side_effect=AssertionError('stale target inventory forbidden')), \
             patch(owner + 'get_extension_id', side_effect=AssertionError('ambiguous discovery forbidden')), \
             patch(owner + 'CDPActions.reinstall_extension', return_value='workspace-id') as reinstall:
            connection.return_value.call.side_effect = lambda method, params=None: response if method == 'Extensions.uninstall' else {'result': {'extensions': extensions}}
            result = UninstallLifecycleCase().execute(ctx)
            connection.return_value.close.assert_called_once()
            return result, reinstall.call_count

    def test_other_installations_and_stale_options_do_not_block_workspace_uninstall(self):
        result, restores = self.run_case({'result': {}}, [
            {'id': 'another-exporter', 'enabled': True}])
        self.assertTrue(result[0]); self.assertEqual(restores, 1)

    def test_uninstall_rejection_and_lingering_workspace_install_fail(self):
        result, restores = self.run_case({'error': {'message': 'denied'}}, [])
        self.assertFalse(result[0]); self.assertEqual(restores, 0)
        result, restores = self.run_case({'result': {}}, [
            {'id': 'workspace-id', 'enabled': True}])
        self.assertFalse(result[0]); self.assertEqual(restores, 0)


if __name__ == "__main__":
    unittest.main()
