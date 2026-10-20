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
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.framework.environment import TestEnvironment, EnvironmentContext


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

    def test_setup_and_clear_viewport(self):
        mock_cdp = MockCDP()
        self.env.setup_viewport(mock_cdp, (1920, 1080))
        methods = [c["method"] for c in mock_cdp.calls]
        self.assertIn("Emulation.clearDeviceMetricsOverride", methods)
        self.assertIn("Emulation.setDeviceMetricsOverride", methods)
        set_override = next(c for c in mock_cdp.calls if c["method"] == "Emulation.setDeviceMetricsOverride")
        self.assertEqual(set_override["params"]["width"], 1920)
        self.assertEqual(set_override["params"]["height"], 1080)

        # clear viewport
        self.env.clear_viewport(mock_cdp)
        self.assertEqual(mock_cdp.calls[-1]["method"], "Emulation.clearDeviceMetricsOverride")

    @patch("scripts.framework.environment.get_browser_ws_url")
    @patch("scripts.framework.environment.CDPConnection")
    def test_setup_download_behavior(self, mock_conn, mock_browser_ws):
        mock_browser_cdp = MockCDP()
        mock_conn.return_value = mock_browser_cdp
        mock_browser_ws.return_value = "ws://mock/browser"

        page_cdp = MockCDP()
        self.env.setup_download_behavior(output_dir=self.temp_dir, cdp=page_cdp)

        browser_methods = [c["method"] for c in mock_browser_cdp.calls]
        self.assertIn("Browser.setDownloadBehavior", browser_methods)

        page_methods = [c["method"] for c in page_cdp.calls]
        self.assertIn("Page.setDownloadBehavior", page_methods)

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
        self.assertIsNotNone(ctx.active_tab)
        mock_reinstall.assert_called_once()

    def test_teardown_cleans_viewport_and_closes_connection(self):
        mock_cdp = MockCDP()
        self.env.teardown(mock_cdp)
        self.assertTrue(mock_cdp.closed)
        methods = [c["method"] for c in mock_cdp.calls]
        self.assertIn("Emulation.clearDeviceMetricsOverride", methods)


if __name__ == "__main__":
    unittest.main()
