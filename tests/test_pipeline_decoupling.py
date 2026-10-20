# tests/test_pipeline_decoupling.py
"""
Unit tests for Phase 4: Pipeline atomic action platform strategy decoupling,
StreamSettledConfig parametrization, and ChatPlatformDriver turn pipeline orchestration.
"""

import unittest
import time
import os
import sys
from typing import Dict, Any, List, Optional, Set

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.framework.selectors import GeminiSelectors
from scripts.framework.pipeline.stages import PipelineStage
from scripts.framework.pipeline.actions import (
    AtomicAction,
    ActionResult,
    StreamSettledConfig,
    AwaitStreamSettledAction,
    AssertIdleAction,
    StagePromptAction,
    SingleClickSendAction,
    HumanCooldownAction
)
from scripts.framework.pipeline.executor import SerialActionExecutor, PipelineResult
from scripts.framework.driver.platform_driver import (
    ChatPlatformDriver,
    TurnResult,
    PlatformCapabilities
)
from scripts.framework.driver.gemini_driver import GeminiPlatformDriver


class MockCDP:
    """Mock CDP for testing pipeline actions and drivers without Chrome."""
    def __init__(self, eval_return=None):
        self.eval_return = eval_return
        self.eval_history: List[str] = []
        self.call_history: List[Dict[str, Any]] = []

    def eval(self, expr: str) -> Any:
        self.eval_history.append(expr)
        if callable(self.eval_return):
            return self.eval_return(expr)
        return self.eval_return

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        self.call_history.append({"method": method, "params": params})
        return {}


class MockCustomDriver(ChatPlatformDriver):
    """Simulated third-party AI platform driver (e.g., Claude or ChatGPT)."""

    def __init__(self, cdp: Any):
        super().__init__(cdp)
        self.env_prepared = False

    @property
    def platform_id(self) -> str:
        return "mock_ai"

    @property
    def capabilities(self) -> PlatformCapabilities:
        return PlatformCapabilities(
            platform_name="Mock AI Platform",
            supports_model_selection=True,
            base_url="https://mock.ai/chat"
        )

    def ensure_ready(self, timeout: float = 20.0) -> bool:
        return True

    def new_chat(self, timeout: float = 20.0) -> Any:
        return "new_chat_ok"

    def open_chat(self, chat_id: str, timeout: float = 20.0) -> Any:
        return f"opened_{chat_id}"

    def get_current_chat_id(self) -> Optional[str]:
        return "mock_session_123"

    def get_current_chat_title(self) -> Optional[str]:
        return "Mock Session Title"

    def get_selectors(self) -> Dict[str, str]:
        return {"editor": "#custom-input", "send": "#custom-send"}

    def prepare_turn_environment(self, is_image: bool = False) -> bool:
        self.env_prepared = True
        return True

    def build_turn_pipeline(
        self,
        prompt_text: str,
        max_wait: int = 300,
        is_image: bool = False,
        cooldown_seconds: float = 6.0
    ) -> List[AtomicAction]:
        class MockStageAction(AtomicAction):
            @property
            def name(self) -> str:
                return "MockStage"
            @property
            def allowed_stages(self) -> Set[PipelineStage]:
                return {PipelineStage.IDLE}
            @property
            def next_stage(self) -> PipelineStage:
                return PipelineStage.STAGED
            def execute(self, ctx: Any, cdp: Any) -> ActionResult:
                return ActionResult(True, f"Staged {prompt_text}")

        class MockSendAction(AtomicAction):
            @property
            def name(self) -> str:
                return "MockSend"
            @property
            def allowed_stages(self) -> Set[PipelineStage]:
                return {PipelineStage.STAGED}
            @property
            def next_stage(self) -> PipelineStage:
                return PipelineStage.DISPATCHED
            def execute(self, ctx: Any, cdp: Any) -> ActionResult:
                return ActionResult(True, "Sent successfully")

        class MockAwaitAction(AtomicAction):
            @property
            def name(self) -> str:
                return "MockAwait"
            @property
            def allowed_stages(self) -> Set[PipelineStage]:
                return {PipelineStage.DISPATCHED}
            @property
            def next_stage(self) -> PipelineStage:
                return PipelineStage.SETTLED
            def execute(self, ctx: Any, cdp: Any) -> ActionResult:
                return ActionResult(True, "Mock stream settled")

        return [MockStageAction(), MockSendAction(), MockAwaitAction()]

    def send_turn(self, prompt: Any, max_wait: int = 300) -> TurnResult:
        return TurnResult(success=True, prompt=str(prompt), model_response="Mock answer")


class TestPipelineDecoupling(unittest.TestCase):
    """Test suite for Phase 4 decoupled pipeline architecture."""

    def test_stream_settled_config_defaults(self):
        """Verify StreamSettledConfig default values match GeminiSelectors."""
        cfg = StreamSettledConfig()
        self.assertEqual(cfg.stop_btn_selector, GeminiSelectors.STOP_BTN)
        self.assertEqual(cfg.send_btn_selector, GeminiSelectors.SEND_BTN_NOT_STOP)
        self.assertEqual(cfg.editor_selector, GeminiSelectors.EDITOR)
        self.assertEqual(cfg.stream_complete_flag, "__geminiLastStreamComplete")
        self.assertIn("you stopped this response", cfg.abort_keywords)
        self.assertIn("something went wrong", cfg.error_keywords)

    def test_stream_settled_config_custom(self):
        """Verify StreamSettledConfig custom injection."""
        cfg = StreamSettledConfig(
            stop_btn_selector="#claude-stop",
            send_btn_selector="#claude-send",
            stream_complete_flag="__claudeComplete",
            abort_keywords=("claude aborted",),
            error_keywords=("rate limit exceeded",)
        )
        self.assertEqual(cfg.stop_btn_selector, "#claude-stop")
        self.assertEqual(cfg.send_btn_selector, "#claude-send")
        self.assertEqual(cfg.stream_complete_flag, "__claudeComplete")
        self.assertIn("claude aborted", cfg.abort_keywords)

    def test_await_stream_settled_action_success_via_config(self):
        """Verify AwaitStreamSettledAction uses custom config and evaluates success."""
        cfg = StreamSettledConfig(
            stop_btn_selector="#custom-stop",
            stream_complete_flag="__customComplete"
        )
        action = AwaitStreamSettledAction(timeout=5, config=cfg)

        mock_cdp = MockCDP(eval_return={
            "hasStop": False,
            "hasSend": True,
            "isEditorReady": True,
            "isStreamingDOM": False,
            "netCompleted": True,
            "currCount": 1,
            "lastLen": 120,
            "lastSnippet": "Hello from custom model",
            "hasImages": False,
            "hasRetry": False,
            "toast": None
        })

        result = action.execute(None, mock_cdp)
        self.assertTrue(result.success)
        self.assertIn("流式回复权威完成", result.message)
        self.assertTrue(any("#custom-stop" in expr for expr in mock_cdp.eval_history))
        self.assertTrue(any("__customComplete" in expr for expr in mock_cdp.eval_history))

    def test_await_stream_settled_action_fail_fast_abort(self):
        """Verify AwaitStreamSettledAction fast-fails upon detecting abort keywords."""
        cfg = StreamSettledConfig(
            abort_keywords=("custom abort triggered",)
        )
        action = AwaitStreamSettledAction(timeout=5, config=cfg)

        mock_cdp = MockCDP(eval_return={
            "hasStop": False,
            "hasSend": True,
            "isEditorReady": True,
            "isStreamingDOM": False,
            "netCompleted": False,
            "currCount": 1,
            "lastLen": 50,
            "lastSnippet": "Warning: custom abort triggered right here",
            "hasImages": False,
            "hasRetry": False,
            "toast": None
        })

        result = action.execute(None, mock_cdp)
        self.assertFalse(result.success)
        self.assertIn("检测到回复被异常中断掐死", result.message)

    def test_mock_driver_pipeline_orchestration(self):
        """Verify SerialActionExecutor executes custom platform driver's pipeline."""
        mock_cdp = MockCDP()
        driver = MockCustomDriver(mock_cdp)
        executor = SerialActionExecutor()

        self.assertFalse(driver.env_prepared)
        res = executor.execute_driver_turn(
            ctx=None,
            driver=driver,
            prompt_text="Hello Multi-AI World",
            max_wait=30,
            is_image=False,
            cooldown_seconds=0.0
        )

        self.assertTrue(res.success)
        self.assertTrue(driver.env_prepared)
        self.assertEqual(res.executed_actions, 3)
        self.assertEqual(res.final_stage, PipelineStage.SETTLED)

    def test_pipeline_circuit_breaker_on_driver_failure(self):
        """Verify Circuit Breaker halts execution when an action in driver pipeline fails."""
        class FailingAction(AtomicAction):
            @property
            def name(self) -> str:
                return "FailingAction"
            @property
            def allowed_stages(self) -> Set[PipelineStage]:
                return {PipelineStage.IDLE}
            @property
            def next_stage(self) -> PipelineStage:
                return PipelineStage.STAGED
            def execute(self, ctx: Any, cdp: Any) -> ActionResult:
                return ActionResult(False, "Simulated DOM element missing")

        class FaultyDriver(MockCustomDriver):
            def build_turn_pipeline(self, *args, **kwargs) -> List[AtomicAction]:
                return [FailingAction()]

        executor = SerialActionExecutor()
        driver = FaultyDriver(MockCDP())
        res = executor.execute_driver_turn(None, driver, "test prompt")

        self.assertFalse(res.success)
        self.assertIn("Simulated DOM element missing", res.error or "")
        self.assertEqual(executor.current_stage, PipelineStage.IDLE)
        self.assertFalse(executor.is_in_flight)

    def test_gemini_platform_driver_pipeline_methods(self):
        """Verify GeminiPlatformDriver implements build_turn_pipeline and extract_turn_result."""
        mock_cdp = MockCDP(eval_return={
            "text": "Gemini response text",
            "hasImages": False,
            "modelCount": 2
        })
        driver = GeminiPlatformDriver(mock_cdp)

        # 1. Test build_turn_pipeline
        actions = driver.build_turn_pipeline("Test Gemini Prompt", max_wait=60, is_image=False, cooldown_seconds=0.0)
        self.assertEqual(len(actions), 4)  # AssertIdle, StagePrompt, SingleClickSend, AwaitStreamSettled
        self.assertIsInstance(actions[0], AssertIdleAction)
        self.assertIsInstance(actions[1], StagePromptAction)
        self.assertIsInstance(actions[2], SingleClickSendAction)
        self.assertIsInstance(actions[3], AwaitStreamSettledAction)

        # 2. Test extract_turn_result
        turn_res = driver.extract_turn_result("Test Gemini Prompt", duration=3.5, is_image=False)
        self.assertTrue(turn_res.success)
        self.assertEqual(turn_res.prompt, "Test Gemini Prompt")
        self.assertEqual(turn_res.model_response, "Gemini response text")
        self.assertEqual(turn_res.duration, 3.5)


if __name__ == "__main__":
    unittest.main()
