# tests/test_pipeline_decoupling.py
"""
Unit tests for Phase 4: Pipeline atomic action platform strategy decoupling,
StreamSettledConfig parametrization, and ChatPlatformDriver turn pipeline orchestration.
"""

import unittest
from unittest.mock import patch
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

    def prepare_turn_environment(self) -> bool:
        self.env_prepared = True
        return True

    def build_turn_pipeline(
        self,
        prompt_text: str,
        max_wait: int = 300,
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

    def test_stream_settled_config_is_only_page_selectors(self):
        cfg = StreamSettledConfig(stop_btn_selector="#custom-stop")
        self.assertEqual(cfg.stop_btn_selector, '#custom-stop')
        self.assertEqual(cfg.model_response_selector, GeminiSelectors.MODEL_RESPONSE)
        self.assertTrue(all(name.endswith('_selector') for name in cfg.__dict__))

    def settled_state(self, **changes):
        return dict(newReply=True, busy=False, editorReady=True, hasContent=True,
                    content='OK', error=None, **changes)

    def run_wait(self, states, timeout=12):
        cdp = MockCDP()
        samples = iter(states)
        cdp.eval_return = lambda _script: next(samples)
        with patch('scripts.framework.pipeline.actions.time.sleep'), \
             patch('scripts.framework.pipeline.actions.time.monotonic', side_effect=range(100)):
            return AwaitStreamSettledAction(timeout=timeout).execute(None, cdp), cdp

    def test_short_text_and_image_only_reply_settle_without_extension_events(self):
        for content in ('OK', '<img src="blob:actual-image">'):
            state = self.settled_state(); state['content'] = content
            result, cdp = self.run_wait([state] * 4)
            self.assertTrue(result.success)
            self.assertNotIn('__testStreamState', cdp.eval_history[-1])

    def test_busy_stale_or_empty_reply_cannot_settle(self):
        for key, value in [('busy', True), ('newReply', False), ('editorReady', False),
                           ('hasContent', False)]:
            with self.subTest(key=key):
                state = self.settled_state(); state[key] = value
                result, _ = self.run_wait([state] * 5, timeout=5)
                self.assertFalse(result.success)

    def test_timeout_reports_failed_conditions_without_authored_content(self):
        state = self.settled_state()
        state.update(newReply=False, modelCount=3, beforeSendCount=3, content='private answer')
        result, _ = self.run_wait([state] * 5, timeout=5)
        self.assertFalse(result.success)
        self.assertFalse(result.data['newReply'])
        self.assertEqual(result.data['modelCount'], 3)
        self.assertEqual(result.data['contentLength'], len('private answer'))
        self.assertEqual(result.data['stableSamples'], 0)
        self.assertNotIn('private answer', result.message)
        self.assertNotIn('content', result.data)

    def test_same_length_changes_reset_stability_and_busy_resets_it(self):
        ready = self.settled_state()
        changed = dict(ready, content='NO')
        busy = dict(changed, busy=True)
        states = [ready] * 3 + [changed] * 3 + [busy] + [changed] * 4
        result, cdp = self.run_wait(states, timeout=20)
        self.assertTrue(result.success)
        self.assertEqual(len(cdp.eval_history), len(states))

    def test_error_words_are_content_but_explicit_retry_is_a_page_failure(self):
        state = self.settled_state(); state['content'] = 'Explain why something went wrong.'
        self.assertTrue(self.run_wait([state] * 4)[0].success)
        state['error'] = 'Page shows a retry control'
        self.assertFalse(self.run_wait([state])[0].success)

    def test_failed_current_response_can_retry_once_then_must_stabilize(self):
        failed = dict(self.settled_state(), error='Page shows a retry control', replyId='current')
        ready = self.settled_state(replyId='current'); ready['content'] = 'Recovered answer'
        result, cdp = self.run_wait([failed, True] + [ready] * 4)
        self.assertTrue(result.success)
        self.assertIn('"current"', cdp.eval_history[1])
        self.assertIn('retry.click()', cdp.eval_history[1])
        self.assertNotIn('targetBtn.click()', cdp.eval_history[1])
        result, cdp = self.run_wait([failed, True, failed])
        self.assertFalse(result.success)
        self.assertEqual(len(cdp.eval_history), 3, 'a second provider retry must not be clicked')

    def test_retry_cannot_resubmit_an_old_reply_or_a_replaced_target(self):
        failed = dict(self.settled_state(), error='Page shows a retry control', replyId='current')
        failed['newReply'] = False
        result, cdp = self.run_wait([failed])
        self.assertFalse(result.success)
        self.assertEqual(len(cdp.eval_history), 1)
        failed['newReply'] = True
        result, _ = self.run_wait([failed, False])
        self.assertFalse(result.success)

    def test_retry_can_preserve_a_draft_but_cannot_accept_unchanged_failed_content(self):
        failed = dict(self.settled_state(), error='Page shows a retry control', replyId='current')
        ready = dict(self.settled_state(), replyId='current', editorReady=False, content='Recovered answer')
        self.assertTrue(self.run_wait([failed, True] + [ready] * 4)[0].success)
        ready['content'] = failed['content']
        self.assertFalse(self.run_wait([failed, True] + [ready] * 8, timeout=7)[0].success)

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
        actions = driver.build_turn_pipeline("Test Gemini Prompt", max_wait=60, cooldown_seconds=0.0)
        self.assertEqual(len(actions), 4)  # AssertIdle, StagePrompt, SingleClickSend, AwaitStreamSettled
        self.assertIsInstance(actions[0], AssertIdleAction)
        self.assertIsInstance(actions[1], StagePromptAction)
        self.assertIsInstance(actions[2], SingleClickSendAction)
        self.assertIsInstance(actions[3], AwaitStreamSettledAction)

        # 2. Test extract_turn_result
        turn_res = driver.extract_turn_result("Test Gemini Prompt", duration=3.5)
        self.assertTrue(turn_res.success)
        self.assertEqual(turn_res.prompt, "Test Gemini Prompt")
        self.assertEqual(turn_res.model_response, "Gemini response text")
        self.assertEqual(turn_res.duration, 3.5)


if __name__ == "__main__":
    unittest.main()
