# tests/test_gemini_driver.py
"""
Unit tests for GeminiDriver, GeminiChatSession, and TurnResult abstractions.
Validates declarative interaction model, turn encapsulation, and state isolation.
"""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.framework.driver import GeminiDriver, GeminiChatSession, TurnResult


class MockCDP:
    """Mock CDP connection for driver unit testing."""
    def __init__(self):
        self.eval_responses = []
        self.calls = []

    def eval(self, script: str):
        self.calls.append(("eval", script))
        if self.eval_responses:
            return self.eval_responses.pop(0)
        return None

    def call(self, method: str, params=None):
        self.calls.append(("call", method, params))
        return {}

    def reconnect(self):
        self.calls.append(("reconnect",))


class TestGeminiDriverSuite(unittest.TestCase):

    def test_turn_result_defaults(self):
        tr = TurnResult(success=True, prompt="Hello Gemini")
        self.assertTrue(tr.success)
        self.assertEqual(tr.prompt, "Hello Gemini")
        self.assertEqual(tr.model_response, "")
        self.assertFalse(tr.has_images)
        self.assertEqual(tr.duration, 0.0)
        self.assertIsNone(tr.error)

    def test_gemini_chat_session_turn_accumulation(self):
        cdp = MockCDP()
        driver = GeminiDriver(cdp)
        session = GeminiChatSession(driver, chat_id="chat_123")

        # Mock execute_turn_pipeline returning success
        with patch.object(driver, "execute_turn_pipeline", return_value=(True, "OK")):
            with patch.object(driver, "get_current_chat_id", return_value="chat_123"):
                # Mock DOM evaluation for model response
                cdp.eval_responses = [
                    {"text": "Response 1", "hasImages": False, "modelCount": 1}
                ]
                res1 = session.send_turn("Prompt 1")
                self.assertTrue(res1.success)
                self.assertEqual(res1.model_response, "Response 1")
                self.assertEqual(len(session.turns), 1)

                cdp.eval_responses = [
                    {"text": "Response 2", "hasImages": True, "modelCount": 2}
                ]
                res2 = session.send_turn({"prompt": "Prompt 2 画一张图"})
                self.assertTrue(res2.success)
                self.assertTrue(res2.has_images)
                self.assertEqual(len(session.turns), 2)

    def test_gemini_chat_session_turn_failure_fail_fast(self):
        cdp = MockCDP()
        driver = GeminiDriver(cdp)
        session = GeminiChatSession(driver, chat_id="chat_fail")

        with patch.object(driver, "execute_turn_pipeline", return_value=(False, "Detection circuit breaker tripped")):
            res = session.send_turn("Trigger fail")
            self.assertFalse(res.success)
            self.assertIn("circuit breaker", res.error)
            self.assertEqual(len(session.turns), 1)
            self.assertEqual(session.turns[0].error, res.error)

    def test_gemini_driver_new_chat_flow(self):
        cdp = MockCDP()
        driver = GeminiDriver(cdp)

        with patch("scripts.framework.actions.CDPActions.click_new_chat", return_value=True) as mock_click:
            with patch.object(driver, "ensure_model", return_value=True) as mock_model:
                # Mock state polling: ready on first check
                cdp.eval_responses = [
                    {"isAppRoute": True, "bubbleCount": 0, "hasEditor": True}
                ]
                session = driver.new_chat(timeout=5.0)

                mock_click.assert_called_once_with(cdp)
                mock_model.assert_called_once_with(target_model="3.8 Flash", target_thinking=True, force_menu_check=False)
                self.assertIsInstance(session, GeminiChatSession)
                self.assertIsNone(session.chat_id)
                self.assertEqual(driver.active_session, session)

    def test_gemini_driver_open_chat_flow(self):
        cdp = MockCDP()
        driver = GeminiDriver(cdp)

        with patch.object(driver, "get_current_chat_id", return_value="different_chat"):
            with patch.object(driver, "ensure_model", return_value=True) as mock_model:
                cdp.eval_responses = [
                    True  # ready check on path
                ]
                session = driver.open_chat("target_chat_999", timeout=5.0)

                mock_model.assert_called_once_with(target_model="3.8 Flash", target_thinking=True, force_menu_check=False)
                self.assertEqual(session.chat_id, "target_chat_999")
                self.assertEqual(driver.active_session, session)

    def test_gemini_chat_session_delete_via_web(self):
        cdp = MockCDP()
        driver = GeminiDriver(cdp)
        session = GeminiChatSession(driver, chat_id="del_chat_1")

        with patch("scripts.framework.actions.CDPActions.delete_conversation_via_web", return_value=True) as mock_del:
            ok = session.delete_via_web()
            self.assertTrue(ok)
            mock_del.assert_called_once_with(cdp, "del_chat_1")

    def test_get_current_chat_id_multi_source(self):
        from scripts.framework.actions import CDPActions
        cdp = MockCDP()

        # Case 1: URL pathname match
        cdp.eval_responses = ["abc1234567"]
        cid1 = CDPActions.get_current_chat_id(cdp)
        self.assertEqual(cid1, "abc1234567")

        # Case 2: None returned if empty
        cdp.eval_responses = [None]
        cid2 = CDPActions.get_current_chat_id(cdp)
        self.assertIsNone(cid2)


if __name__ == "__main__":
    unittest.main()

