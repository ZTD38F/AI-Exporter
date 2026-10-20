# tests/test_visual_sandbox.py
"""
Unit tests for Tier 3 Visual Sandbox and Autonomous QA Agent:
- VisualSandbox physical mouse/keyboard actuation, pure screenshot observation, and wait_on primitives
- VisualQAAgent perception-action closed loop, self-healing retries, and scorecard recording
"""

import os
import sys
import time
import base64
import tempfile
import unittest
from unittest.mock import patch, MagicMock
from typing import Dict, Any, List, Optional

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.visual_agent.sandbox import VisualSandbox, ScreenObservation, WaitResult
from scripts.visual_agent.providers.base import VisionProvider, VisualAction, VisualActionType
from scripts.visual_agent.providers.custom_ai_provider import CustomAIVisionProvider
from scripts.visual_agent.agent import VisualQAAgent, TestMission
from scripts.visual_agent.scorecard import VisualUXScorecard, SelfHealingEvent, VisualRisk


class MockCDP:
    """Mock CDP connection for isolated unit testing of VisualSandbox."""
    def __init__(self, eval_return=None):
        self.eval_return = eval_return
        self.eval_history: List[str] = []
        self.call_history: List[Dict[str, Any]] = []

    def eval(self, expr: str, await_promise: bool = False) -> Any:
        self.eval_history.append(expr)
        if callable(self.eval_return):
            return self.eval_return(expr)
        return self.eval_return

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        self.call_history.append({"method": method, "params": params or {}})
        if method == "Page.captureScreenshot":
            # 1x1 最小合法透明 PNG Base64
            tiny_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
            return {"result": {"data": tiny_png_b64}}
        return {}


class MockCustomVisionProvider(VisionProvider):
    """Deterministic mock vision provider for agent testing."""
    def __init__(self, action_sequence: List[VisualAction]):
        self.action_sequence = list(action_sequence)
        self.call_count = 0

    def decide_action(
        self,
        screenshot_bytes: bytes,
        instruction: str,
        history: List[Dict[str, Any]],
        context: Optional[Dict[str, Any]] = None
    ) -> VisualAction:
        if self.call_count < len(self.action_sequence):
            action = self.action_sequence[self.call_count]
        else:
            action = VisualAction(action_type=VisualActionType.DONE, thought="Fallback DONE")
        self.call_count += 1
        return action


class TestVisualSandbox(unittest.TestCase):
    def setUp(self):
        self.mock_cdp = MockCDP()
        self.temp_dir = tempfile.mkdtemp()
        self.sandbox = VisualSandbox(
            cdp=self.mock_cdp,
            viewport_size=(1280, 800),
            output_dir=self.temp_dir
        )

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_viewport_normalization(self):
        # 1. 归一化坐标转换 (0.5, 0.5) -> (640, 400)
        px_x, px_y = self.sandbox._to_pixel(0.5, 0.5)
        self.assertEqual(px_x, 640)
        self.assertEqual(px_y, 400)

        # 2. 边界约束测试
        px_x, px_y = self.sandbox._to_pixel(1.5, -0.2)
        self.assertEqual(px_x, 2)  # round(1.5) -> 2
        self.assertEqual(px_y, 0)  # clamped to 0

        # 3. 绝对像素坐标
        px_x, px_y = self.sandbox._to_pixel(100.0, 200.0)
        self.assertEqual(px_x, 100)
        self.assertEqual(px_y, 200)

    def test_capture_screen_pure_perception(self):
        obs = self.sandbox.capture_screen("test_shot")
        self.assertIsInstance(obs, ScreenObservation)
        self.assertTrue(len(obs.image_bytes) > 0)
        self.assertTrue(os.path.isfile(obs.file_path))
        self.assertEqual(obs.viewport, (1280, 800))

        # 验证历史记录中不包含 DOM 树信息
        self.assertEqual(len(self.sandbox.history), 1)
        self.assertEqual(self.sandbox.history[0]["action"], "capture_screen")
        self.assertNotIn("dom", self.sandbox.history[0])

    def test_mouse_click_hardware_sequence(self):
        self.sandbox.mouse_click(0.25, 0.75, label="unit_click")
        calls = [c for c in self.mock_cdp.call_history if c["method"] == "Input.dispatchMouseEvent"]

        # 必须按照 mouseMoved -> mousePressed -> mouseReleased 三部曲派发
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0]["params"]["type"], "mouseMoved")
        self.assertEqual(calls[0]["params"]["x"], 320)
        self.assertEqual(calls[0]["params"]["y"], 600)

        self.assertEqual(calls[1]["params"]["type"], "mousePressed")
        self.assertEqual(calls[1]["params"]["button"], "left")

        self.assertEqual(calls[2]["params"]["type"], "mouseReleased")
        self.assertEqual(calls[2]["params"]["button"], "left")

    def test_mouse_scroll(self):
        self.sandbox.mouse_scroll(delta_y=250)
        calls = [c for c in self.mock_cdp.call_history if c["method"] == "Input.dispatchMouseEvent" and c["params"]["type"] == "mouseWheel"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["params"]["deltaY"], 250)

    def test_input_text_hardware_typing(self):
        # 带有清空原内容与硬件剪贴板粘贴
        self.sandbox.input_text(x=0.5, y=0.5, text="Hello AI", clear_first=True, use_insert=True)

        insert_calls = [c for c in self.mock_cdp.call_history if c["method"] == "Input.insertText"]
        self.assertEqual(len(insert_calls), 1)
        self.assertEqual(insert_calls[0]["params"]["text"], "Hello AI")

        # 验证派发了清空快捷键事件 (rawKeyDown KeyA / Backspace)
        key_calls = [c for c in self.mock_cdp.call_history if c["method"] == "Input.dispatchKeyEvent"]
        self.assertTrue(len(key_calls) >= 4)

    def test_wait_on_zip_downloaded(self):
        # 预先在输出目录创建一个合格的 ZIP 文件
        fake_zip = os.path.join(self.temp_dir, "gemini_export_2026.zip")
        with open(fake_zip, "wb") as f:
            f.write(b"PK\x05\x06" + b"\x00" * 18)  # 最小空 zip 标头

        res = self.sandbox.wait_on("zip_downloaded", timeout=2, download_dir=self.temp_dir)
        self.assertTrue(res.success)
        self.assertIn("gemini_export_2026.zip", res.message)
        self.assertEqual(res.data["file_path"], fake_zip)

    def test_press_key_primitive(self):
        self.sandbox.press_key("Enter")
        key_calls = [c for c in self.mock_cdp.call_history if c["method"] == "Input.dispatchKeyEvent"]
        self.assertTrue(any(c["params"].get("key") == "Enter" and c["params"].get("type") == "rawKeyDown" for c in key_calls))
        self.assertTrue(any(c["params"].get("key") == "Enter" and c["params"].get("type") == "keyUp" for c in key_calls))

        self.sandbox.press_key("Escape")
        self.assertTrue(any(c["params"].get("key") == "Escape" for c in self.mock_cdp.call_history))


class TestVisualQAAgent(unittest.TestCase):
    def setUp(self):
        self.mock_cdp = MockCDP()
        self.temp_dir = tempfile.mkdtemp()
        self.sandbox = VisualSandbox(
            cdp=self.mock_cdp,
            viewport_size=(1280, 800),
            output_dir=self.temp_dir
        )
        self.scorecard = VisualUXScorecard(output_dir=self.temp_dir)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_execute_visual_step_click_success(self):
        provider = MockCustomVisionProvider([
            VisualAction(action_type=VisualActionType.CLICK, x=0.5, y=0.5, thought="Click center")
        ])
        agent = VisualQAAgent(sandbox=self.sandbox, provider=provider, scorecard=self.scorecard)

        verified = [False]
        def verify():
            verified[0] = True
            return True

        res = agent.execute_visual_step("step_click", "点击中心按钮", verify_fn=verify)
        self.assertTrue(res)
        self.assertTrue(verified[0])

        # 校验物理鼠标事件已被派遣
        mouse_calls = [c for c in self.mock_cdp.call_history if c["method"] == "Input.dispatchMouseEvent"]
        self.assertEqual(len(mouse_calls), 3)

    def test_execute_visual_step_self_healing(self):
        # 第一次点击未满足 verify_fn，第二次重试满足
        provider = MockCustomVisionProvider([
            VisualAction(action_type=VisualActionType.CLICK, x=0.2, y=0.2, thought="Attempt 1"),
            VisualAction(action_type=VisualActionType.CLICK, x=0.25, y=0.25, thought="Attempt 2")
        ])
        agent = VisualQAAgent(sandbox=self.sandbox, provider=provider, scorecard=self.scorecard)

        attempts = [0]
        def verify_on_second():
            attempts[0] += 1
            return attempts[0] >= 2

        res = agent.execute_visual_step("step_retry", "微距重试点击", verify_fn=verify_on_second, max_attempts=3)
        self.assertTrue(res)
        self.assertEqual(attempts[0], 2)

        # 检查是否忠实记录了自愈轨迹
        self.assertEqual(len(self.scorecard.self_healing_events), 1)
        event = self.scorecard.self_healing_events[0]
        self.assertEqual(event.step_name, "step_retry")
        self.assertEqual(event.attempt, 2)
        self.assertTrue(event.resolved)

    def test_execute_visual_step_wait_on(self):
        provider = MockCustomVisionProvider([
            VisualAction(action_type=VisualActionType.WAIT_ON, condition="custom_wait", timeout=1, thought="Wait on event")
        ])
        agent = VisualQAAgent(sandbox=self.sandbox, provider=provider, scorecard=self.scorecard)

        res = agent.execute_visual_step("step_wait", "等待沙盒事件")
        self.assertTrue(res)

    def test_scorecard_reporting(self):
        self.scorecard.record_feature("向导防撞", "引导交互", "PASS", 1.2, "0 遮挡通过")
        self.scorecard.record_risk(VisualRisk(
            category="TEXT_TRUNCATION",
            element_description="Button #btnExport",
            risk_level="LOW",
            details="仅超出 1px"
        ))
        self.scorecard.record_screenshot("shot_1", "/tmp/shot_1.png")

        md = self.scorecard.generate_markdown()
        self.assertIn("向导防撞", md)
        self.assertIn("TEXT_TRUNCATION", md)
        self.assertIn("shot_1", md)

        html = self.scorecard.generate_html()
        self.assertIn("向导防撞", html)
        self.assertIn("shot-card", html)

        self.scorecard.save()
        self.assertTrue(os.path.isfile(os.path.join(self.temp_dir, "visual_audit_scorecard.md")))
        self.assertTrue(os.path.isfile(os.path.join(self.temp_dir, "visual_audit_report.html")))

    def test_switch_page_options(self):
        # 默认静默切换，绝不抢占操作系统焦点 (bring_to_front=False)
        ok = self.sandbox.switch_page("options")
        self.assertTrue(ok)
        self.assertEqual(self.sandbox.active_target, "options")
        methods = [c["method"] for c in self.mock_cdp.call_history]
        self.assertNotIn("Page.bringToFront", methods)
        tgt, cid = VisualSandbox.load_active_target(self.temp_dir)
        self.assertEqual(tgt, "options")
        self.assertIsNone(cid)

        # 显式传参 bring_to_front=True 时调用 Page.bringToFront
        self.mock_cdp.call_history.clear()
        ok2 = self.sandbox.switch_page("options", bring_to_front=True)
        self.assertTrue(ok2)
        methods2 = [c["method"] for c in self.mock_cdp.call_history]
        self.assertIn("Page.bringToFront", methods2)

    def test_to_pixel_retina_scaling(self):
        # 默认情况 (MockCDP eval 返回 None 时回退到 self.width=1280, self.height=800)
        px_x, px_y = self.sandbox._to_pixel(0.5, 0.5)
        self.assertEqual(px_x, 640)
        self.assertEqual(px_y, 400)

        # 模拟 macOS Retina 屏幕 (DPR = 1.5, CSS innerWidth=853, innerHeight=533)
        self.mock_cdp.eval_return = {"w": 853, "h": 533, "dpr": 1.5}
        # 归一化输入测试: 0.873, 0.848 应精确缩放到 CSS 像素 (745, 452)
        rx, ry = self.sandbox._to_pixel(0.873, 0.848)
        self.assertEqual(rx, 745)
        self.assertEqual(ry, 452)

        # 绝对物理像素输入测试: 1117, 678 (超出 CSS 范围但在图像范围内) 应除以 DPR 转换为 CSS 像素
        px_abs_x, px_abs_y = self.sandbox._to_pixel(1117, 678)
        self.assertEqual(px_abs_x, 745)
        self.assertEqual(px_abs_y, 452)

    def test_switch_page_gemini_with_chat_id(self):
        ok = self.sandbox.switch_page("gemini", chat_id="c_28a9d16ec6bf")
        self.assertTrue(ok)
        self.assertEqual(self.sandbox.active_target, "gemini")
        nav_calls = [c for c in self.mock_cdp.call_history if c["method"] == "Page.navigate"]
        self.assertTrue(any("28a9d16ec6bf" in c["params"]["url"] for c in nav_calls))
        tgt, cid = VisualSandbox.load_active_target(self.temp_dir)
        self.assertEqual(tgt, "gemini")
        self.assertEqual(cid, "28a9d16ec6bf")

    def test_switch_page_gemini_new_chat(self):
        ok = self.sandbox.switch_page("gemini", new_chat=True)
        self.assertTrue(ok)
        self.assertEqual(self.sandbox.active_target, "gemini")
        nav_calls = [c for c in self.mock_cdp.call_history if c["method"] == "Page.navigate"]
        self.assertTrue(any(c["params"]["url"] == "https://gemini.google.com/app" for c in nav_calls))
        tgt, cid = VisualSandbox.load_active_target(self.temp_dir)
        self.assertEqual(tgt, "gemini")
        self.assertIsNone(cid)

    def test_agent_switch_page_action(self):
        provider = MockCustomVisionProvider([
            VisualAction(
                action_type=VisualActionType.SWITCH_PAGE,
                target="gemini",
                chat_id="c_test123",
                thought="Switch to specific chat"
            ),
            VisualAction(action_type=VisualActionType.DONE, thought="Goal reached")
        ])
        agent = VisualQAAgent(sandbox=self.sandbox, provider=provider, scorecard=self.scorecard)
        result = agent.run_objective("测试切换至指定会话")
        self.assertTrue(result.success)
        self.assertEqual(self.sandbox.active_target, "gemini")

    def test_evaluate_export_targeted_chat_id(self):
        import zipfile
        zip_path = os.path.join(self.temp_dir, "test_export.zip")
        md_content = """---
title: "火星宇航员"
id: "c_mars123456"
provider: "gemini"
url: "https://gemini.google.com/app/mars123456"
date: "2026-09-15"
updated: "2026-09-15"
exported: "2026-09-15"
tags:
  - gemini-export
---

## 👤 You

火星上有水吗？

## 🤖 Assistant

火星上发现了冰形态的水。
"""
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("火星宇航员_123456.md", md_content)

        # 1. Targeted check with matching chat_id passes
        ok, msg, details = self.sandbox.evaluate_export(zip_path, min_conversations=1, chat_id="c_mars123456")
        self.assertTrue(ok, msg)
        self.assertIn("mars123456", msg)

        # 2. Targeted check with non-matching chat_id fails
        ok_fail, msg_fail, _ = self.sandbox.evaluate_export(zip_path, min_conversations=1, chat_id="c_other999")
        self.assertFalse(ok_fail)
        self.assertIn("未在导出包中找到指定目标会话", msg_fail)

        # 3. Default evaluate (no golden required) passes
        ok_gen, msg_gen, _ = self.sandbox.evaluate_export(zip_path, min_conversations=1)
        self.assertTrue(ok_gen, msg_gen)

        # 4. Requiring golden chats fails because our zip does not have them
        from scripts.framework.cases.export import DESIGNATED_HISTORICAL_CHATS
        ok_golden, msg_golden, _ = self.sandbox.evaluate_export(
            zip_path,
            min_conversations=1,
            expected_golden_chats=DESIGNATED_HISTORICAL_CHATS
        )
        self.assertFalse(ok_golden)
        self.assertIn("GoldenCheck", msg_golden)

    @patch("scripts.visual_agent.playground.CDPConnection")
    def test_open_visual_playground_reinstall(self, mock_conn):
        from scripts.visual_agent.playground import open_visual_playground
        mock_env = MagicMock()
        mock_env.reinstall_extension.return_value = "new_mock_ext_id"
        mock_env.ensure_tab.return_value = {"url": "options.html", "webSocketDebuggerUrl": "ws://mock"}
        mock_conn.return_value = self.mock_cdp

        pg = open_visual_playground(port=9222, target_page="options", reinstall=True, env=mock_env)
        mock_env.reinstall_extension.assert_called_once()
        mock_env.ensure_tab.assert_called_once_with("options")
        self.assertIsNotNone(pg)

    def test_agent_key_dispatch(self):
        provider = MockCustomVisionProvider([
            VisualAction(action_type=VisualActionType.KEY, key="Escape", thought="Press Escape to dismiss"),
            VisualAction(action_type=VisualActionType.DONE, thought="Goal reached")
        ])
        agent = VisualQAAgent(sandbox=self.sandbox, provider=provider, scorecard=self.scorecard)
        res = agent.run_objective("测试物理按键派发")
        self.assertTrue(res.success)
        key_calls = [c for c in self.mock_cdp.call_history if c["method"] == "Input.dispatchKeyEvent" and c["params"].get("key") == "Escape"]
        self.assertGreater(len(key_calls), 0)

    def test_run_objective_populates_scorecard(self):
        provider = MockCustomVisionProvider([
            VisualAction(action_type=VisualActionType.CLICK, x=0.1, y=0.1, thought="Click something"),
            VisualAction(action_type=VisualActionType.DONE, thought="Completed objective")
        ])
        agent = VisualQAAgent(sandbox=self.sandbox, provider=provider, scorecard=self.scorecard)
        res = agent.run_objective("测试特性与证据沉淀")
        self.assertTrue(res.success)
        self.assertGreater(len(self.scorecard.features_explored), 0)
        names = [f["name"] for f in self.scorecard.features_explored]
        self.assertTrue(any("目标" in n for n in names))

    def test_run_objective_verify_fn_self_healing(self):
        # 第一次 DONE 时验收未达成，触发自愈，第二次达成
        verify_state = [False]
        def check_verified():
            return verify_state[0]

        provider = MockCustomVisionProvider([
            VisualAction(action_type=VisualActionType.DONE, thought="Claim premature DONE"),
            VisualAction(action_type=VisualActionType.CLICK, x=0.5, y=0.5, thought="Self-heal click"),
            VisualAction(action_type=VisualActionType.DONE, thought="Real DONE")
        ])

        # 在第二次调用时改变状态
        original_decide = provider.decide_action
        def wrapped_decide(*args, **kwargs):
            action = original_decide(*args, **kwargs)
            if action.thought == "Real DONE":
                verify_state[0] = True
            return action
        provider.decide_action = wrapped_decide

        agent = VisualQAAgent(sandbox=self.sandbox, provider=provider, scorecard=self.scorecard)
        res = agent.run_objective("测试客观断言防虚假达成", verify_fn=check_verified, max_steps=5)

        self.assertTrue(res.success)
        # 校验是否成功记录了防虚假自愈事件
        self.assertGreaterEqual(len(self.scorecard.self_healing_events), 1)
        self.assertIn("verify_fn", self.scorecard.self_healing_events[0].reason)

    def test_run_mission_end_to_end(self):
        mission = TestMission(
            mission_id="m_tour",
            name="向导全流程测试",
            description="验证向导引导气泡",
            instructions=["点击下一步", "完成向导"]
        )
        provider = MockCustomVisionProvider([
            VisualAction(action_type=VisualActionType.CLICK, x=0.2, y=0.2, thought="Click step 1"),
            VisualAction(action_type=VisualActionType.CLICK, x=0.3, y=0.3, thought="Click step 2")
        ])
        step_v = {
            "m_tour_step_1": lambda: True,
            "m_tour_step_2": lambda: True
        }
        agent = VisualQAAgent(sandbox=self.sandbox, provider=provider, scorecard=self.scorecard)
        res = agent.run_mission(mission, step_verifiers=step_v)

        self.assertTrue(res.success)
        self.assertEqual(res.steps_taken, 2)
        mission_features = [f for f in self.scorecard.features_explored if "Mission: 向导全流程测试" in f["name"]]
        self.assertEqual(len(mission_features), 1)
        self.assertEqual(mission_features[0]["status"], "PASS")


class TestCustomAIVisionProvider(unittest.TestCase):
    def test_endpoint_and_model_resolution(self):
        # 1. 默认模型与空 endpoint
        with patch.dict(os.environ, {}, clear=True):
            p1 = CustomAIVisionProvider()
            self.assertEqual(p1.model, "default-vlm")
            self.assertIsNone(p1.endpoint)

        # 2. 从环境变量继承
        with patch.dict(os.environ, {"CUSTOM_AI_ENDPOINT": "http://mock-ai:8000/v1", "CUSTOM_AI_MODEL": "test-vlm-v1"}):
            p2 = CustomAIVisionProvider()
            self.assertEqual(p2.endpoint, "http://mock-ai:8000/v1")
            self.assertEqual(p2.model, "test-vlm-v1")

        # 3. 构造参数覆盖环境变量
        with patch.dict(os.environ, {"CUSTOM_AI_MODEL": "test-vlm-v1"}):
            p3 = CustomAIVisionProvider(endpoint="http://custom:9000", model="override-vlm")
            self.assertEqual(p3.endpoint, "http://custom:9000")
            self.assertEqual(p3.model, "override-vlm")

    def test_no_endpoint_fails_cleanly(self):
        p = CustomAIVisionProvider(endpoint=None)
        action = p.decide_action(b"fake_png", "Click button", [])
        self.assertEqual(action.action_type, VisualActionType.FAIL)
        self.assertIn("未配置 CUSTOM_AI_ENDPOINT", action.thought)

    @patch("urllib.request.urlopen")
    def test_reject_blind_click_without_coordinates(self, mock_urlopen):
        from unittest.mock import MagicMock
        mock_cm = MagicMock()
        mock_cm.__enter__.return_value.read.return_value = b'{"choices": [{"message": {"content": "{\\"action\\": \\"CLICK\\", \\"thought\\": \\"no coords\\"}"}}]}'
        mock_urlopen.return_value = mock_cm

        p = CustomAIVisionProvider(endpoint="http://mock-ai:8000/v1/chat")
        action = p.decide_action(b"fake_png", "Click button", [])
        self.assertEqual(action.action_type, VisualActionType.FAIL)
        self.assertIn("缺少有效定位坐标", action.thought)

    @patch("urllib.request.urlopen")
    def test_parse_key_action(self, mock_urlopen):
        from unittest.mock import MagicMock
        mock_cm = MagicMock()
        mock_cm.__enter__.return_value.read.return_value = b'{"choices": [{"message": {"content": "{\\"action\\": \\"KEY\\", \\"key\\": \\"Enter\\", \\"thought\\": \\"press enter\\"}"}}]}'
        mock_urlopen.return_value = mock_cm

        p = CustomAIVisionProvider(endpoint="http://mock-ai:8000/v1/chat")
        action = p.decide_action(b"fake_png", "Submit search", [])
        self.assertEqual(action.action_type, VisualActionType.KEY)
        self.assertEqual(action.key, "Enter")

    @patch("urllib.request.urlopen")
    def test_parse_box_2d_action(self, mock_urlopen):
        from unittest.mock import MagicMock
        mock_cm = MagicMock()
        mock_cm.__enter__.return_value.read.return_value = b'{"choices": [{"message": {"content": "{\\"action\\": \\"CLICK\\", \\"box_2d\\": [100, 200, 300, 400], \\"thought\\": \\"click box\\"}"}}]}'
        mock_urlopen.return_value = mock_cm

        p = CustomAIVisionProvider(endpoint="http://mock-ai:8000/v1/chat")
        action = p.decide_action(b"fake_png", "Click target", [])
        self.assertEqual(action.action_type, VisualActionType.CLICK)
        self.assertAlmostEqual(action.x, 0.3)
        self.assertAlmostEqual(action.y, 0.2)

    def test_review_screenshots_without_endpoint(self):
        p = CustomAIVisionProvider(endpoint=None)
        review = p.review_screenshots([])
        self.assertIn("未配置 CUSTOM_AI_ENDPOINT", review)


if __name__ == "__main__":
    unittest.main()
