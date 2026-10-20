# tests/test_selectors_and_gateway.py
"""
Unit tests for GeminiSelectors, WorkbenchSelectors, and SafeInteractionGateway.
Validates central selector registry consistency, URL allowlist filtering,
rate limit protection, and audit logging.
"""

import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.framework.selectors import GeminiSelectors, WorkbenchSelectors
from scripts.framework.gateway import SafeInteractionGateway, SecurityViolationError, get_gateway


class TestSelectorsSuite(unittest.TestCase):
    """验证 DOM 选择器中央注册表的完整性与构建逻辑"""

    def test_gemini_selectors_non_empty(self):
        self.assertTrue(bool(GeminiSelectors.EDITOR))
        self.assertTrue(bool(GeminiSelectors.SEND_BTN))
        self.assertTrue(bool(GeminiSelectors.STOP_BTN))
        self.assertTrue(bool(GeminiSelectors.STREAMING_INDICATORS))
        self.assertTrue(bool(GeminiSelectors.MODEL_RESPONSE))
        self.assertTrue(bool(GeminiSelectors.USER_QUERY))
        self.assertTrue(bool(GeminiSelectors.MODE_MENU_BTN))
        self.assertTrue(bool(GeminiSelectors.MODE_MENU))
        self.assertTrue(bool(GeminiSelectors.NEW_CHAT_BTN))
        self.assertTrue(bool(GeminiSelectors.NAV_ITEM))
        self.assertTrue(bool(GeminiSelectors.DIALOG))
        self.assertTrue(bool(GeminiSelectors.INPAGE_EXPORT_BADGE))

    def test_workbench_selectors_non_empty(self):
        self.assertTrue(bool(WorkbenchSelectors.SEARCH_INPUT))
        self.assertTrue(bool(WorkbenchSelectors.ITEM))
        self.assertTrue(bool(WorkbenchSelectors.CHECKBOX))
        self.assertTrue(bool(WorkbenchSelectors.CHECKED_CHECKBOX))
        self.assertTrue(bool(WorkbenchSelectors.BTN_SELECT_ALL))
        self.assertTrue(bool(WorkbenchSelectors.BTN_SELECT_NONE))
        self.assertTrue(bool(WorkbenchSelectors.BTN_DEEP_SCAN))
        self.assertTrue(bool(WorkbenchSelectors.BTN_EXPORT))
        self.assertTrue(bool(WorkbenchSelectors.TOUR_POPOVER))

    def test_nav_item_builder(self):
        sel = GeminiSelectors.nav_item_by_chat_id("abc12345")
        self.assertIn("abc12345", sel)
        self.assertIn("gem-nav-list-item", sel)

    def test_workbench_item_builder(self):
        sel1 = WorkbenchSelectors.item_by_chat_id("abc12345")
        self.assertIn("abc12345", sel1)
        self.assertIn("c_abc12345", sel1)

        sel2 = WorkbenchSelectors.item_by_chat_id("c_abc12345")
        self.assertIn("abc12345", sel2)
        self.assertIn("c_abc12345", sel2)


class TestSafeInteractionGatewaySuite(unittest.TestCase):
    """验证安全交互网关的域名白名单、速率限制与审计机制"""

    def setUp(self):
        self.gateway = SafeInteractionGateway(
            allowed_hosts=["gemini.google.com", "accounts.google.com"],
            min_action_interval=0.01,
            enable_strict_domain_check=True
        )

    def test_url_validation_allowed(self):
        self.assertTrue(self.gateway.validate_url("https://gemini.google.com/app"))
        self.assertTrue(self.gateway.validate_url("https://gemini.google.com/app/1bd028d5c5b0c0e2"))
        self.assertTrue(self.gateway.validate_url("https://accounts.google.com/signin"))
        self.assertTrue(self.gateway.validate_url("chrome-extension://abcdefg/options.html"))
        self.assertTrue(self.gateway.validate_url("chrome://extensions"))

    def test_url_validation_blocked(self):
        self.assertFalse(self.gateway.validate_url("https://malicious-site.com"))
        self.assertFalse(self.gateway.validate_url("https://evil-gemini.google.com.attacker.com"))
        self.assertFalse(self.gateway.validate_url("javascript:alert(1)"))
        self.assertFalse(self.gateway.validate_url(""))

    def test_safe_navigate_success(self):
        mock_cdp = MagicMock()
        mock_cdp.call.return_value = {}

        res = self.gateway.safe_navigate(mock_cdp, "https://gemini.google.com/app")
        self.assertTrue(res)
        mock_cdp.call.assert_called_once_with("Page.navigate", {"url": "https://gemini.google.com/app"})

        summary = self.gateway.get_summary()
        self.assertEqual(summary["total"], 1)
        self.assertEqual(summary["success"], 1)
        self.assertEqual(summary["blocked"], 0)

    def test_safe_navigate_blocked_raises_security_error(self):
        mock_cdp = MagicMock()

        with self.assertRaises(SecurityViolationError):
            self.gateway.safe_navigate(mock_cdp, "https://unauthorized-domain.com")

        mock_cdp.call.assert_not_called()
        summary = self.gateway.get_summary()
        self.assertEqual(summary["total"], 1)
        self.assertEqual(summary["blocked"], 1)

    def test_audit_logging_and_dump(self, tmp_path=None):
        self.gateway.record_audit("TEST_ACTION", "target_item", "SUCCESS", duration=0.05, details={"foo": "bar"})
        self.assertEqual(len(self.gateway.audit_log), 1)
        entry = self.gateway.audit_log[0]
        self.assertEqual(entry["action"], "TEST_ACTION")
        self.assertEqual(entry["target"], "target_item")
        self.assertEqual(entry["status"], "SUCCESS")
        self.assertEqual(entry["duration_ms"], 50)

    def test_global_gateway_singleton(self):
        g1 = get_gateway()
        g2 = get_gateway()
        self.assertIs(g1, g2)

    def test_safe_send_turn_success_and_audit(self):
        mock_cdp = MagicMock()
        mock_cdp.eval.return_value = {"hasCaptcha": False, "hasAbuse": False}
        send_fn = MagicMock(return_value=(True, "ok"))

        res = self.gateway.safe_send_turn(mock_cdp, send_fn, "Hello Gemini", custom_cooldown=0.0)
        self.assertEqual(res, (True, "ok"))
        send_fn.assert_called_once_with(mock_cdp, "Hello Gemini")
        self.assertTrue(any(e["action"] == "SEND_TURN" and e["status"] == "SUCCESS" for e in self.gateway.audit_log))

    def test_safe_send_turn_circuit_breaker_on_captcha(self):
        mock_cdp = MagicMock()
        mock_cdp.eval.return_value = {"hasCaptcha": True, "hasAbuse": False}
        send_fn = MagicMock()

        from scripts.framework.gateway import CircuitBreakerError
        with self.assertRaises(CircuitBreakerError):
            self.gateway.safe_send_turn(mock_cdp, send_fn, "Trigger CAPTCHA", custom_cooldown=0.0)
        send_fn.assert_not_called()

    def test_safe_send_turn_circuit_breaker_on_quota_error(self):
        mock_cdp = MagicMock()
        mock_cdp.eval.return_value = {"hasCaptcha": False, "hasAbuse": False}
        send_fn = MagicMock(return_value=(False, "HTTP 429 Too Many Requests: quota exceeded"))

        from scripts.framework.gateway import CircuitBreakerError
        with self.assertRaises(CircuitBreakerError):
            self.gateway.safe_send_turn(mock_cdp, send_fn, "Spam turn", custom_cooldown=0.0)

    def test_safe_delete_success_and_audit(self):
        mock_cdp = MagicMock()
        delete_fn = MagicMock(return_value=True)

        res = self.gateway.safe_delete(mock_cdp, delete_fn, "c_123456", custom_cooldown=0.0)
        self.assertTrue(res)
        delete_fn.assert_called_once_with(mock_cdp, "c_123456")
        self.assertTrue(any(e["action"] == "DELETE_CHAT" and e["target"] == "c_123456" for e in self.gateway.audit_log))


if __name__ == "__main__":
    unittest.main()
