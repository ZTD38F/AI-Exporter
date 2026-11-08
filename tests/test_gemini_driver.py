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

    def check_model_menu(self, menus, button=None):
        cdp = MockCDP()
        status = button or {"text": "Flash", "label": "Open mode picker, currently Flash", "disabled": False}
        cdp.eval_responses = [status]
        for menu in menus:
            cdp.eval_responses.extend([status, True, menu])
            model_selected = any(it["isSelected"] and it["text"].startswith("3.8 Flash ") for it in menu)
            medium_selected = any(it["isSelected"] and it["text"].startswith("Medium ") for it in menu)
            if not model_selected:
                cdp.eval_responses.append(True)  # model click
            if not medium_selected:
                cdp.eval_responses.extend([False, True, True])  # reopen and select Medium
        return cdp

    def model_menu(self, model="3.8 Flash", level="Low", include_medium=True, include_target=True):
        options = [
            {"text": "3.5 Flash-Lite Fastest answers", "isSelected": model == "3.5 Flash-Lite"},
            {"text": "3.1 Pro Advanced reasoning", "isSelected": model == "3.1 Pro"},
            {"text": "Low Quick and efficient", "isSelected": level == "Low"},
            {"text": "High Extra thorough", "isSelected": level == "High"}
        ]
        if include_target:
            options.append({"text": "3.8 Flash All-around help", "isSelected": model == "3.8 Flash"})
        if include_medium:
            options.append({"text": "Medium Balanced depth", "isSelected": level == "Medium"})
        return options

    def test_model_gate_accepts_selected_flash_38_and_medium(self):
        cdp = self.check_model_menu([self.model_menu(level="Medium")])
        with patch("scripts.framework.driver.gemini_driver.time.sleep"):
            self.assertTrue(GeminiDriver(cdp).ensure_model(force_menu_check=True))

    def test_model_gate_expands_nested_thinking_menu_and_verifies_medium(self):
        status = {"text": "Flash Medium", "label": "Flash Medium", "disabled": False}
        root = [it for it in self.model_menu() if not it["text"].startswith(("Low ", "Medium ", "High "))]
        root.append({"text": "Thinking level", "isSelected": False})
        cdp = MockCDP()
        cdp.eval_responses = [status, status, True, root, True, self.model_menu(level="Medium")]
        with patch("scripts.framework.driver.gemini_driver.time.sleep"):
            self.assertTrue(GeminiDriver(cdp).ensure_model())
        scripts = [script for kind, script, *rest in cdp.calls if kind == "eval"]
        self.assertTrue(any('thinking_level' in script and 'item.click()' in script for script in scripts))
        self.assertFalse(cdp.eval_responses)

    def test_model_gate_reopens_submenu_to_switch_low_and_high(self):
        status = {"text": "Flash", "label": "Flash", "disabled": False}
        for level in ["Low", "High"]:
            with self.subTest(level=level):
                root = [it for it in self.model_menu() if not it["text"].startswith(("Low ", "Medium ", "High "))]
                root.append({"text": "Thinking level", "isSelected": False})
                expanded = self.model_menu(level=level) + [root[-1]]
                cdp = MockCDP()
                cdp.eval_responses = [
                    status, status, True, root, True, expanded,
                    False, True, True, True,  # reopen parent, submenu, select
                    status, True, root, True, self.model_menu(level="Medium")
                ]
                with patch("scripts.framework.driver.gemini_driver.time.sleep"):
                    self.assertTrue(GeminiDriver(cdp).ensure_model())
                self.assertFalse(cdp.eval_responses, "selection must be re-read after changing the nested level")

    def test_model_only_does_not_expand_thinking_submenu(self):
        root = [it for it in self.model_menu() if not it["text"].startswith(("Low ", "Medium ", "High "))]
        root.append({"text": "Thinking level", "isSelected": False})
        cdp = MockCDP()
        status = {"text": "Flash", "label": "Flash", "disabled": False}
        cdp.eval_responses = [status, status, True, root]
        with patch("scripts.framework.driver.gemini_driver.time.sleep"):
            self.assertTrue(GeminiDriver(cdp).ensure_model(target_thinking=False))
        self.assertFalse(any('item.click()' in script for kind, script, *rest in cdp.calls if kind == "eval"))

    def test_model_gate_reports_google_verification_instead_of_missing_model(self):
        cdp = MockCDP()
        cdp.eval_responses = [{'blocked': True}]
        with self.assertRaisesRegex(RuntimeError, 'Google 人机验证拦截'):
            GeminiDriver(cdp).ensure_model()
        self.assertFalse(any(kind == 'call' for kind, *_ in cdp.calls))

    def test_model_gate_waits_for_delayed_menu_before_verifying_selection(self):
        cdp = self.check_model_menu([self.model_menu(level="Medium")])
        cdp.eval_responses[3:3] = [None, None]
        with patch("scripts.framework.driver.gemini_driver.time.sleep"):
            self.assertTrue(GeminiDriver(cdp).ensure_model())
        clicks = [script for kind, script, *rest in cdp.calls if kind == 'eval' and 'btn.click()' in script]
        self.assertEqual(len(clicks), 1)

    def test_model_gate_switches_low_and_high_and_rechecks_selection(self):
        for level in ["Low", "High"]:
            with self.subTest(level=level):
                cdp = self.check_model_menu([self.model_menu(level=level), self.model_menu(level="Medium")])
                with patch("scripts.framework.driver.gemini_driver.time.sleep"):
                    self.assertTrue(GeminiDriver(cdp).ensure_model())
                menus_read = [script for kind, script, *rest in cdp.calls if kind == "eval" and "return items.map" in script]
                self.assertEqual(len(menus_read), 2, "must verify Medium after clicking it")

    def test_model_gate_switches_wrong_model_and_rechecks_flash_38(self):
        for model in ["3.5 Flash-Lite", "3.1 Pro"]:
            with self.subTest(model=model):
                cdp = self.check_model_menu([self.model_menu(model=model, level="Medium"), self.model_menu(level="Medium")])
                with patch("scripts.framework.driver.gemini_driver.time.sleep"):
                    self.assertTrue(GeminiDriver(cdp).ensure_model())

    def test_model_gate_rejects_missing_medium_even_when_button_says_thinking(self):
        menu = self.model_menu(include_medium=False)
        cdp = self.check_model_menu([menu], button={"text": "Flash Thinking", "label": "Flash Thinking", "disabled": False})
        with patch("scripts.framework.driver.gemini_driver.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "缺失必要能力: Medium"):
                GeminiDriver(cdp).ensure_model()

    def test_model_gate_rejects_missing_flash_38(self):
        cdp = self.check_model_menu([self.model_menu(include_target=False, level="Medium")])
        with patch("scripts.framework.driver.gemini_driver.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "3.8 Flash"):
                GeminiDriver(cdp).ensure_model(force_menu_check=True)

    def test_model_gate_rejects_selection_that_does_not_stick(self):
        cdp = self.check_model_menu([self.model_menu()] * 5)
        with patch("scripts.framework.driver.gemini_driver.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, r"无法将模型切换至 3.8 Flash \+ Medium"):
                GeminiDriver(cdp).ensure_model()

    def test_model_gate_model_only_does_not_require_or_select_medium(self):
        menu = self.model_menu(include_medium=False)
        cdp = MockCDP()
        status = {"text": "Flash", "label": "Flash", "disabled": False}
        cdp.eval_responses = [status, status, True, menu]
        with patch("scripts.framework.driver.gemini_driver.time.sleep"):
            self.assertTrue(GeminiDriver(cdp).ensure_model(target_thinking=False, force_menu_check=True))
        self.assertFalse(any("el.click()" in script for kind, script, *rest in cdp.calls if kind == "eval"))

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

    def test_prompt_words_do_not_change_waiting_or_extraction(self):
        driver = GeminiDriver(MockCDP())
        session = GeminiChatSession(driver, chat_id="content-neutral")
        for prompt in ["Explain the earlier illustration and drawing.", "Generate an image.", "Say OK."]:
            with self.subTest(prompt=prompt), \
                 patch.object(driver, "execute_turn_pipeline", return_value=(True, "OK")) as run, \
                 patch.object(driver, "get_current_chat_id", return_value=session.chat_id), \
                 patch.object(driver, "extract_turn_result", return_value=TurnResult(success=True, prompt=prompt)) as extract:
                self.assertTrue(session.send_turn(prompt, max_wait=60).success)
                run.assert_called_once_with(prompt, max_wait=60)
                self.assertEqual(set(extract.call_args.kwargs), {'duration'})

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

