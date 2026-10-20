# tests/test_platform_driver.py
"""
Unit Tests for ChatPlatformDriver Abstraction and GeminiPlatformDriver Implementation.
Validates abstract contract enforcement, capability declarations, selector exposure,
TurnResult data modeling, and ExtensionActions hierarchy.
"""

import os
import sys
import unittest
from unittest.mock import MagicMock
from typing import Dict, Optional, Any, Union, List

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.framework.driver import (
    ChatPlatformDriver,
    TurnResult,
    PlatformCapabilities,
    GeminiPlatformDriver,
    GeminiDriver,
    GeminiChatSession
)
from scripts.framework.actions import ExtensionActions, CDPActions
from scripts.framework.selectors import GeminiSelectors, WorkbenchSelectors


class ConcreteTestDriver(ChatPlatformDriver):
    """Minimal concrete driver implementation for testing ChatPlatformDriver ABC."""

    @property
    def platform_id(self) -> str:
        return "mock_ai"

    @property
    def capabilities(self) -> PlatformCapabilities:
        return PlatformCapabilities(
            platform_name="Mock AI",
            supports_model_selection=True,
            base_url="https://mock.ai"
        )

    def ensure_ready(self, timeout: float = 20.0) -> bool:
        return True

    def new_chat(self, timeout: float = 20.0) -> Any:
        return "new_mock_session"

    def open_chat(self, chat_id: str, timeout: float = 20.0) -> Any:
        return f"opened_{chat_id}"

    def get_current_chat_id(self) -> Optional[str]:
        return "mock_chat_123"

    def get_current_chat_title(self) -> Optional[str]:
        return "Mock Chat Title"

    def send_turn(self, prompt: Union[str, Dict[str, Any]], max_wait: int = 300) -> TurnResult:
        return TurnResult(success=True, prompt=str(prompt), model_response="Mock Response")

    def get_selectors(self) -> Dict[str, str]:
        return {"input": "#mock-input"}

    def build_turn_pipeline(
        self,
        prompt_text: str,
        max_wait: int = 300,
        is_image: bool = False,
        cooldown_seconds: float = 6.0
    ) -> List[Any]:
        return []


class TestPlatformDriver(unittest.TestCase):

    def test_turn_result_defaults(self):
        """Test TurnResult dataclass initialization and defaults."""
        res = TurnResult(success=True, prompt="Hello world")
        self.assertTrue(res.success)
        self.assertEqual(res.prompt, "Hello world")
        self.assertEqual(res.model_response, "")
        self.assertFalse(res.has_images)
        self.assertEqual(res.duration, 0.0)
        self.assertIsNone(res.error)
        self.assertIsNone(res.chat_id)
        self.assertIsInstance(res.metadata, dict)

    def test_platform_capabilities(self):
        """Test PlatformCapabilities dataclass initialization and flags."""
        caps = PlatformCapabilities(
            platform_name="ChatGPT",
            supports_model_selection=True,
            supports_thinking_mode=False,
            supports_image_generation=True,
            supports_sidebar_deletion=True,
            base_url="https://chatgpt.com"
        )
        self.assertEqual(caps.platform_name, "ChatGPT")
        self.assertTrue(caps.supports_model_selection)
        self.assertFalse(caps.supports_thinking_mode)
        self.assertTrue(caps.supports_image_generation)
        self.assertEqual(caps.base_url, "https://chatgpt.com")

    def test_abc_enforcement(self):
        """Test that ChatPlatformDriver cannot be instantiated directly without implementations."""
        with self.assertRaises(TypeError):
            ChatPlatformDriver(MagicMock())

    def test_concrete_driver_contract(self):
        """Test that a compliant subclass of ChatPlatformDriver satisfies all abstract methods."""
        mock_cdp = MagicMock()
        driver = ConcreteTestDriver(mock_cdp)
        self.assertEqual(driver.platform_id, "mock_ai")
        self.assertEqual(driver.capabilities.platform_name, "Mock AI")
        self.assertTrue(driver.ensure_ready())
        self.assertEqual(driver.new_chat(), "new_mock_session")
        self.assertEqual(driver.open_chat("c1"), "opened_c1")
        self.assertEqual(driver.get_current_chat_id(), "mock_chat_123")
        self.assertEqual(driver.get_current_chat_title(), "Mock Chat Title")

        turn_res = driver.send_turn("Test prompt")
        self.assertTrue(turn_res.success)
        self.assertEqual(turn_res.model_response, "Mock Response")

        # Optional methods default behavior
        self.assertTrue(driver.ensure_model("gpt-4"))
        self.assertFalse(driver.delete_chat_via_web("c1"))
        self.assertEqual(driver.get_selectors(), {"input": "#mock-input"})
        self.assertEqual(driver.get_pipeline_strategies(), {})

    def test_gemini_platform_driver_metadata(self):
        """Test GeminiPlatformDriver identity, capabilities, and backwards compatibility alias."""
        mock_cdp = MagicMock()
        driver = GeminiPlatformDriver(mock_cdp)

        self.assertIsInstance(driver, ChatPlatformDriver)
        self.assertEqual(driver.platform_id, "gemini")
        self.assertEqual(driver.capabilities.platform_name, "Google Gemini")
        self.assertTrue(driver.capabilities.supports_model_selection)
        self.assertTrue(driver.capabilities.supports_thinking_mode)
        self.assertTrue(driver.capabilities.supports_image_generation)
        self.assertTrue(driver.capabilities.supports_sidebar_deletion)
        self.assertTrue(driver.capabilities.supports_stream_events)
        self.assertEqual(driver.capabilities.base_url, "https://gemini.google.com")

        # Check alias equality
        self.assertIs(GeminiDriver, GeminiPlatformDriver)

    def test_gemini_driver_selectors_and_strategies(self):
        """Test that GeminiPlatformDriver exposes standard selectors and pipeline strategies."""
        mock_cdp = MagicMock()
        driver = GeminiPlatformDriver(mock_cdp)

        selectors = driver.get_selectors()
        self.assertIsInstance(selectors, dict)
        self.assertIn("EDITOR", selectors)
        self.assertIn("SEND_BTN", selectors)
        self.assertIn("MODEL_RESPONSE", selectors)
        self.assertEqual(selectors["EDITOR"], GeminiSelectors.EDITOR)
        self.assertEqual(selectors["SEND_BTN"], GeminiSelectors.SEND_BTN)

        strategies = driver.get_pipeline_strategies()
        self.assertIsInstance(strategies, dict)
        self.assertIn("send_turn", strategies)
        self.assertIn("wait_ready", strategies)
        self.assertTrue(callable(strategies["send_turn"]))

    def test_actions_class_hierarchy(self):
        """Test ExtensionActions and CDPActions hierarchy and method exposure."""
        self.assertTrue(issubclass(CDPActions, ExtensionActions))

        # Check that extension-level actions are defined on ExtensionActions
        ext_methods = [
            "reinstall_extension",
            "verify_onboarding_tour",
            "search_workbench",
            "clear_search_workbench",
            "select_workbench_item",
            "toggle_select_all",
            "toggle_select_none",
            "switch_workbench_language",
            "import_takeout_zip",
            "trigger_deep_scan",
            "trigger_export_zip",
        ]
        for m in ext_methods:
            self.assertTrue(hasattr(ExtensionActions, m), f"ExtensionActions missing {m}")
            self.assertTrue(hasattr(CDPActions, m), f"CDPActions missing inherited {m}")

        # Check that Gemini-specific platform actions are defined on CDPActions
        platform_methods = [
            "wait_for_gemini_ready",
            "get_current_chat_id",
            "get_current_chat_title",
            "ensure_model_and_thinking",
            "send_gemini_turn",
            "click_new_chat",
            "delete_conversation_via_web",
        ]
        for m in platform_methods:
            self.assertTrue(hasattr(CDPActions, m), f"CDPActions missing {m}")

    def test_pipeline_actions_selector_customization(self):
        """Test that pipeline AtomicActions can accept custom selectors and URLs for multi-platform reuse."""
        from scripts.framework.pipeline.actions import (
            AssertIdleAction,
            StagePromptAction,
            SingleClickSendAction,
            ClickNewChatAction,
            NavigateChatAction
        )

        # 1. AssertIdleAction
        default_idle = AssertIdleAction()
        self.assertEqual(default_idle.stop_btn_selector, GeminiSelectors.STOP_BTN)
        custom_idle = AssertIdleAction(stop_btn_selector="#chatgpt-stop", streaming_indicators_selector=".result-streaming")
        self.assertEqual(custom_idle.stop_btn_selector, "#chatgpt-stop")
        self.assertEqual(custom_idle.streaming_indicators_selector, ".result-streaming")

        # 2. StagePromptAction
        default_stage = StagePromptAction("hello")
        self.assertEqual(default_stage.editor_selector, GeminiSelectors.EDITOR)
        custom_stage = StagePromptAction("hello", editor_selector="#prompt-textarea")
        self.assertEqual(custom_stage.editor_selector, "#prompt-textarea")

        # 3. SingleClickSendAction
        default_send = SingleClickSendAction()
        self.assertEqual(default_send.send_btn_selector, GeminiSelectors.SEND_BTN)
        custom_send = SingleClickSendAction(send_btn_selector='button[data-testid="send-button"]')
        self.assertEqual(custom_send.send_btn_selector, 'button[data-testid="send-button"]')

        # 4. ClickNewChatAction
        default_new = ClickNewChatAction()
        self.assertEqual(default_new.new_chat_selector, GeminiSelectors.NEW_CHAT_BTN)
        self.assertEqual(default_new.new_chat_url, "https://gemini.google.com/app")
        custom_new = ClickNewChatAction(new_chat_selector="a#new-chat", new_chat_url="https://chatgpt.com")
        self.assertEqual(custom_new.new_chat_selector, "a#new-chat")
        self.assertEqual(custom_new.new_chat_url, "https://chatgpt.com")

        # 5. NavigateChatAction
        default_nav = NavigateChatAction("c_123")
        self.assertEqual(default_nav.url_template, "https://gemini.google.com/app/{chat_id}")
        custom_nav = NavigateChatAction("c_123", url_template="https://chatgpt.com/c/{chat_id}")
        self.assertEqual(custom_nav.url_template, "https://chatgpt.com/c/{chat_id}")

    def test_test_context_driver_provider(self):
        """Test TestContext get_platform_driver contract."""
        from scripts.framework.cases.base import TestContext
        mock_ctx = MagicMock(spec=TestContext)
        mock_cdp = MagicMock()
        mock_ctx.get_gemini_driver = lambda cdp: TestContext.get_gemini_driver(mock_ctx, cdp)

        # Test real TestContext methods bound to mock
        driver = TestContext.get_platform_driver(mock_ctx, mock_cdp)
        self.assertIsInstance(driver, ChatPlatformDriver)
        self.assertIsInstance(driver, GeminiPlatformDriver)
        self.assertEqual(driver.platform_id, "gemini")


if __name__ == "__main__":
    unittest.main()
