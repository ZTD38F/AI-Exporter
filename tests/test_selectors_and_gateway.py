# tests/test_selectors_and_gateway.py
"""
Unit tests for GeminiSelectors, WorkbenchSelectors, and SafeInteractionGateway.
Validates central selector registry consistency, URL allowlist filtering,
rate limit protection, and audit logging.
"""

import os
import sys
import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.framework.selectors import GeminiSelectors, WorkbenchSelectors
from scripts.framework.gateway import SafeInteractionGateway, SecurityViolationError, get_gateway


class TestSelectorsSuite(unittest.TestCase):
    """验证 DOM 选择器中央注册表的完整性与构建逻辑"""

    def test_nav_item_builder(self):
        selector = GeminiSelectors.nav_item_by_chat_id(" abc12345 ")
        self.assertEqual(
            selector,
            'gem-nav-list-item a[href*="abc12345"], nav a[href*="abc12345"], a[href*="abc12345"]',
            "navigation must target the requested chat ID without whitespace",
        )

    def test_workbench_item_builder(self):
        expected = '#list .item[data-chat-id="abc12345"], #list .item[data-chat-id="c_abc12345"]'
        for chat_id in ["abc12345", "c_abc12345"]:
            self.assertEqual(WorkbenchSelectors.item_by_chat_id(chat_id), expected,
                "both provider ID forms must target exactly the same two workbench rows")


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
        for url in [
            "https://evil-gemini.google.com.attacker.com",
            "https://gemini.google.com.attacker.com/app",
            "https://gemini.google.com@attacker.com/app",
            "http://gemini.google.com/app",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "",
        ]:
            self.assertFalse(self.gateway.validate_url(url), f"forbidden navigation accepted: {url}")

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

    def test_safe_navigate_uses_logged_fallback_after_cdp_navigation_error(self):
        mock_cdp = MagicMock()
        mock_cdp.call.side_effect = RuntimeError("Page.navigate failed")
        self.assertTrue(self.gateway.safe_navigate(mock_cdp, "https://gemini.google.com/app"))
        self.assertEqual(mock_cdp.eval.call_count, 1)
        self.assertIn("window.location.href", mock_cdp.eval.call_args.args[0])
        self.assertEqual(self.gateway.audit_log[-1]["action"], "NAVIGATE_FALLBACK")
        self.assertEqual(self.gateway.audit_log[-1]["status"], "SUCCESS")

    def test_safe_navigate_blocked_raises_security_error(self):
        mock_cdp = MagicMock()

        with self.assertRaises(SecurityViolationError):
            self.gateway.safe_navigate(mock_cdp, "https://unauthorized-domain.com")

        mock_cdp.call.assert_not_called()
        summary = self.gateway.get_summary()
        self.assertEqual(summary["total"], 1)
        self.assertEqual(summary["blocked"], 1)

    def test_audit_logging_and_dump(self):
        self.gateway.record_audit("TEST_ACTION", "target_item", "SUCCESS", duration=0.05, details={"foo": "bar"})
        entry = self.gateway.audit_log[0]
        self.assertEqual(entry["duration_ms"], 50)
        with TemporaryDirectory() as directory:
            target = Path(directory) / "audit" / "events.json"
            self.gateway.dump_audit_log(str(target))
            self.assertTrue(target.is_file(), "audit must be written to disk, not just buffered")
            report = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(report["total_actions"], 1)
            self.assertEqual(report["entries"], [entry])
            self.assertEqual(report["entries"][0]["details"], {"foo": "bar"})
            self.assertEqual(self.gateway.get_summary(),
                {"total": 1, "success": 1, "blocked": 0, "failed": 0})

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

    def test_safe_send_turn_enforces_maximum_before_sending_another_message(self):
        gateway = SafeInteractionGateway(max_turns_per_run=1, min_turn_interval=0)
        mock_cdp = MagicMock()
        mock_cdp.eval.return_value = {"hasCaptcha": False, "hasAbuse": False}
        send_fn = MagicMock(return_value=(True, "ok"))
        self.assertEqual(gateway.safe_send_turn(mock_cdp, send_fn, "First", custom_cooldown=0), (True, "ok"))
        from scripts.framework.gateway import CircuitBreakerError
        with self.assertRaises(CircuitBreakerError):
            gateway.safe_send_turn(mock_cdp, send_fn, "Second", custom_cooldown=0)
        send_fn.assert_called_once_with(mock_cdp, "First")
        self.assertEqual(gateway.get_summary(),
            {"total": 2, "success": 1, "blocked": 1, "failed": 0})

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
        send_fn.assert_called_once()
        self.assertEqual(self.gateway.get_summary()["blocked"], 1)
        self.assertFalse(any(e["action"] == "SEND_TURN" and e["status"] == "SUCCESS"
                             for e in self.gateway.audit_log))

    def test_safe_delete_success_and_audit(self):
        mock_cdp = MagicMock()
        delete_fn = MagicMock(return_value=True)

        res = self.gateway.safe_delete(mock_cdp, delete_fn, "c_123456", custom_cooldown=0.0)
        self.assertTrue(res)
        delete_fn.assert_called_once_with(mock_cdp, "c_123456")
        self.assertTrue(any(e["action"] == "DELETE_CHAT" and e["target"] == "c_123456" for e in self.gateway.audit_log))
        self.assertEqual(self.gateway.get_summary()["success"], 1)

    def test_safe_delete_records_failure_without_claiming_success(self):
        mock_cdp = MagicMock()
        delete_fn = MagicMock(return_value=False)
        self.assertFalse(self.gateway.safe_delete(mock_cdp, delete_fn, "c_missing", custom_cooldown=0))
        delete_fn.assert_called_once_with(mock_cdp, "c_missing")
        self.assertEqual(self.gateway.get_summary()["failed"], 1)
        self.assertEqual(self.gateway.audit_log[-1]["status"], "FAILED")


if __name__ == "__main__":
    unittest.main()
