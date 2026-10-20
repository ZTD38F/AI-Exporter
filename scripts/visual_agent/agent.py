# scripts/visual_agent/agent.py
"""
Autonomous Visual QA Agent (`AutonomousVisualAgent`).
Operates as an active, intelligent QA agent interacting with the VisualPlayground:
- Observes the screen via pure PNG captures (zero DOM tree leaks)
- Reasons and decides physical mouse/keyboard/wait actions via Vision Model (Gemini 2.0 Flash)
- Suspends itself via deterministic `wait_on` primitives during asynchronous generation/export
- Achieves high-level testing objectives without scripted step loops or hardcoded DOM shortcuts
"""

import os
import sys
import time
import json
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any, Tuple

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from .playground import VisualPlayground, ScreenObservation, WaitResult
from .providers.base import VisionProvider, VisualAction, VisualActionType
from .scorecard import VisualUXScorecard, SelfHealingEvent, VisualRisk


@dataclass
class TestMission:
    """A testing objective or mission definition."""
    mission_id: str
    name: str
    description: str
    instructions: List[str] = field(default_factory=list)
    timeout_seconds: float = 120.0
    context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentResult:
    """Outcome of an autonomous testing session."""
    success: bool
    objective: str
    steps_taken: int
    elapsed_seconds: float
    message: str
    history: List[Dict[str, Any]] = field(default_factory=list)


class AutonomousVisualAgent:
    """
    Autonomous Visual Testing Agent.
    Receives high-level natural language objectives, observes the screen,
    and drives actions through the VisualPlayground in an autonomous ReAct loop.
    """

    def __init__(
        self,
        playground: Optional[VisualPlayground] = None,
        provider: Optional[VisionProvider] = None,
        scorecard: Optional[VisualUXScorecard] = None,
        tracker: Optional[Any] = None,
        sandbox: Optional[VisualPlayground] = None
    ):
        self.playground = playground or sandbox
        self.provider = provider
        self.scorecard = scorecard
        self.tracker = tracker
        self.action_history: List[Dict[str, Any]] = []

    def log(self, message: str, tag: str = "INFO"):
        prefix = {
            "INFO": "[ℹ️ 信息]",
            "PASS": "[✅ 通过]",
            "WARN": "[⚠️ 警告]",
            "FAIL": "[❌ 失败]",
            "SEE":  "[👀 感知]",
            "THINK": "[🧠 推理]",
            "ACT":  "[🖱️ 操作]",
            "WAIT": "[⏳ 挂起]"
        }.get(tag, f"[{tag}]")
        print(f" {prefix} {message}")

    def execute_visual_step(
        self,
        step_name: str,
        instruction: str,
        verify_fn: Optional[Any] = None,
        context: Optional[Dict[str, Any]] = None,
        max_attempts: int = 3
    ) -> bool:
        """
        Closed-loop single visual step with self-healing verification:
        1. Observe: playground.capture_screen()
        2. Reason: provider.decide_action()
        3. Act / Wait: dispatch physical actions or suspend via playground.wait_on()
        4. Self-Heal: verify transition and retry with visual adaptation if unfulfilled
        """
        for attempt in range(1, max_attempts + 1):
            obs = self.playground.capture_screen(f"{step_name}_att_{attempt}")
            self.scorecard.record_screenshot(f"{step_name}_att_{attempt}", obs.file_path)

            action = self.provider.decide_action(
                screenshot_bytes=obs.image_bytes,
                instruction=instruction,
                history=self.action_history,
                context=context
            )

            thought = action.thought or f"执行动作: {action.action_type.value}"
            self.action_history.append({
                "step": step_name,
                "attempt": attempt,
                "instruction": instruction,
                "action": action.action_type.value,
                "thought": thought,
                "timestamp": time.time()
            })

            # 派发动作
            if action.action_type == VisualActionType.CLICK:
                self.playground.mouse_click(action.x, action.y, label=step_name)

            elif action.action_type in (VisualActionType.TYPE, VisualActionType.PASTE):
                self.playground.input_text(text=action.text or "", x=action.x, y=action.y)

            elif action.action_type == VisualActionType.CLEAR:
                self.playground.input_text(x=action.x, y=action.y, clear_first=True)

            elif action.action_type == VisualActionType.SCROLL:
                delta = action.details.get("delta_y", 300)
                self.playground.mouse_scroll(delta_y=delta)

            elif action.action_type == VisualActionType.WAIT_ON:
                cond = action.condition or "ui_idle"
                timeout = action.timeout or 300
                wait_res = self.playground.wait_on(cond, timeout=timeout, **(action.details or {}))
                if not wait_res.success:
                    return False

            elif action.action_type == VisualActionType.KEY:
                self.playground.press_key(action.key or "Enter")

            elif action.action_type == VisualActionType.WAIT:
                time.sleep(1.0)

            if verify_fn:
                time.sleep(0.3)
                if verify_fn():
                    if attempt > 1:
                        self.scorecard.record_self_healing(SelfHealingEvent(
                            step_name=step_name,
                            instruction=instruction,
                            attempt=attempt,
                            reason="初次动作未达成预期状态转移",
                            action_taken="再次感知微调动作重试",
                            duration_seconds=0.3,
                            resolved=True
                        ))
                    return True
            else:
                return True

        return False

    def run_objective(
        self,
        objective: str,
        max_steps: int = 25,
        step_prefix: str = "step",
        verify_fn: Optional[Any] = None
    ) -> AgentResult:
        """
        Autonomous ReAct Loop with objective-level acceptance verification:
        1. Observe: playground.capture_screen()
        2. Reason: provider.decide_action() via vision model
        3. Act / Wait: dispatch physical action or suspend via playground.wait_on()
        4. Evaluate: loop until agent outputs DONE and passes verify_fn (if specified), or exceeds max_steps
        """
        self.log(f"🎯 启动自主目标推演: {objective}", "INFO")
        t0 = time.time()
        step = 0

        while step < max_steps:
            step += 1
            step_name = f"{step_prefix}_{step}"

            # 1. 纯视觉感知 (0 DOM 泄露)
            obs = self.playground.capture_screen(step_name)
            self.scorecard.record_screenshot(step_name, obs.file_path)
            self.log(f"[步进 {step}/{max_steps}] 截屏捕获: {os.path.basename(obs.file_path)} ({len(obs.image_bytes)} bytes)", "SEE")

            # 2. 视觉多模态推理决策
            action = self.provider.decide_action(
                screenshot_bytes=obs.image_bytes,
                instruction=objective,
                history=self.action_history
            )

            thought = action.thought or f"决策动作: {action.action_type.value}"
            self.log(f"{thought}", "THINK")

            step_record = {
                "step": step,
                "action": action.action_type.value,
                "thought": thought,
                "timestamp": time.time()
            }
            self.action_history.append(step_record)

            # 3. 目标达成判定与独立断言闭环
            if action.action_type == VisualActionType.DONE:
                elapsed = time.time() - t0
                if verify_fn:
                    time.sleep(0.15)
                    verified = False
                    try:
                        verified = bool(verify_fn())
                    except Exception as e:
                        self.log(f"验收函数执行异常: {e}", "WARN")
                        verified = False

                    if not verified:
                        self.log(f"⚠️ Agent 宣称达成但验收断言未通过 (步进 {step})！触发纠偏自愈...", "WARN")
                        if self.scorecard:
                            self.scorecard.record_self_healing(SelfHealingEvent(
                                step_name=step_name,
                                instruction=objective,
                                attempt=step,
                                reason="模型宣称 DONE 但未通过框架独立验收断言 (verify_fn)",
                                action_taken="向 Agent 注入纠偏反馈并继续自主推演",
                                duration_seconds=0.15,
                                resolved=False
                            ))
                        step_record["verification"] = "FAILED"
                        step_record["thought"] = f"验收断言未达成: {thought}。请观察界面并继续操作。"
                        continue

                self.log(f"🎉 Agent 自主判定目标达成并通过验收！(耗时 {elapsed:.1f}s, 共 {step} 步)", "PASS")
                if self.scorecard:
                    self.scorecard.record_feature(
                        name=f"目标: {objective[:32]}",
                        domain="Autonomous",
                        status="PASS",
                        duration=elapsed,
                        notes=thought
                    )
                return AgentResult(
                    success=True,
                    objective=objective,
                    steps_taken=step,
                    elapsed_seconds=elapsed,
                    message=thought,
                    history=self.action_history
                )

            elif action.action_type == VisualActionType.FAIL:
                elapsed = time.time() - t0
                self.log(f"❌ Agent 自主判定目标失败: {thought}", "FAIL")
                if self.scorecard:
                    self.scorecard.record_feature(
                        name=f"目标: {objective[:32]}",
                        domain="Autonomous",
                        status="FAIL",
                        duration=elapsed,
                        notes=thought
                    )
                    self.scorecard.record_risk(VisualRisk(
                        category="AutonomousFailure",
                        element_description=f"Step {step}",
                        risk_level="HIGH",
                        details=thought,
                        screenshot_ref=obs.file_path
                    ))
                return AgentResult(
                    success=False,
                    objective=objective,
                    steps_taken=step,
                    elapsed_seconds=elapsed,
                    message=thought,
                    history=self.action_history
                )

            # 4. 派发硬件级动作或主动阻塞挂起
            if action.action_type == VisualActionType.CLICK:
                self.log(f"物理鼠标点击 -> ({action.x:.3f}, {action.y:.3f})", "ACT")
                self.playground.mouse_click(action.x, action.y, label=step_name)

            elif action.action_type in (VisualActionType.TYPE, VisualActionType.PASTE):
                self.log(f"物理输入文本 -> '{action.text}'", "ACT")
                self.playground.input_text(text=action.text or "", x=action.x, y=action.y)

            elif action.action_type == VisualActionType.CLEAR:
                self.log("物理清空当前输入区域", "ACT")
                self.playground.input_text(x=action.x, y=action.y, clear_first=True)

            elif action.action_type == VisualActionType.KEY:
                self.log(f"物理按键触发 -> '{action.key}'", "ACT")
                self.playground.press_key(action.key or "Enter")

            elif action.action_type == VisualActionType.SCROLL:
                delta = action.details.get("delta_y", 300)
                self.log(f"物理滚轮滚动 -> deltaY: {delta}", "ACT")
                self.playground.mouse_scroll(delta_y=delta)

            elif action.action_type == VisualActionType.WAIT_ON:
                cond = action.condition or "ui_idle"
                timeout = action.timeout or 120
                self.log(f"Agent 主动调用 blocking 接口挂起自身: wait_on('{cond}', timeout={timeout}s)...", "WAIT")
                wait_res = self.playground.wait_on(cond, timeout=timeout, **(action.details or {}))
                self.log(f"沙盒等待唤醒 -> 结果: {wait_res.success} ({wait_res.message}, 耗时 {wait_res.elapsed:.1f}s)", "WAIT")
                if not wait_res.success:
                    self.log(f"沙盒等待超时失败: {wait_res.message}", "WARN")

            elif action.action_type == VisualActionType.SWITCH_PAGE:
                target = action.target or action.details.get("target", "gemini")
                chat_id = action.chat_id or action.details.get("chat_id")
                new_chat = bool(action.details.get("new_chat") or action.details.get("new"))
                cid_str = f" (chat_id: {chat_id})" if chat_id else ""
                new_str = " (new_chat)" if new_chat else ""
                self.log(f"Agent 主动切换活动页面 -> {target}{new_str}{cid_str}", "ACT")
                self.playground.switch_page(target=target, chat_id=chat_id, new_chat=new_chat)

            elif action.action_type == VisualActionType.WAIT:
                time.sleep(1.0)

            if self.scorecard:
                self.scorecard.record_feature(
                    name=f"{step_name}: {action.action_type.value}",
                    domain="ActionDispatch",
                    status="PASS",
                    duration=0.5,
                    notes=thought[:60]
                )

            time.sleep(0.2)

        elapsed = time.time() - t0
        self.log(f"⚠️ 达到最大步数上限 ({max_steps})，目标未完全达成", "WARN")
        if self.scorecard:
            self.scorecard.record_feature(
                name=f"目标: {objective[:32]}",
                domain="Autonomous",
                status="FAIL",
                duration=elapsed,
                notes=f"Exceeded max steps ({max_steps})"
            )
            self.scorecard.record_risk(VisualRisk(
                category="StepTimeout",
                element_description="Objective",
                risk_level="MEDIUM",
                details=f"在设定的 {max_steps} 步内未能完成目标",
                screenshot_ref=obs.file_path if 'obs' in locals() else None
            ))
        return AgentResult(
            success=False,
            objective=objective,
            steps_taken=max_steps,
            elapsed_seconds=elapsed,
            message="Exceeded max steps",
            history=self.action_history
        )

    def run_mission(
        self,
        mission: TestMission,
        step_verifiers: Optional[Dict[str, Any]] = None
    ) -> AgentResult:
        """
        Executes a structured mission with step-by-step instructions and verifications
        via `execute_visual_step` self-healing loops.
        """
        self.log(f"🎯 启动结构化引导任务 (Mission): {mission.name} ({mission.mission_id})", "INFO")
        t0 = time.time()
        verifiers = step_verifiers or {}
        all_passed = True
        steps_executed = 0

        for idx, instruction in enumerate(mission.instructions, 1):
            step_name = f"{mission.mission_id}_step_{idx}"
            verify_fn = verifiers.get(step_name) or verifiers.get(str(idx))
            self.log(f"执行阶段 [{idx}/{len(mission.instructions)}]: {instruction}", "INFO")

            success = self.execute_visual_step(
                step_name=step_name,
                instruction=instruction,
                verify_fn=verify_fn,
                context=mission.context
            )
            steps_executed += 1

            if not success:
                self.log(f"❌ 任务步骤 [{step_name}] 未能达成并退出自愈", "FAIL")
                all_passed = False
                break

        elapsed = time.time() - t0
        status_str = "PASS" if all_passed else "FAIL"
        if self.scorecard:
            self.scorecard.record_feature(
                name=f"Mission: {mission.name}",
                domain="StructuredMission",
                status=status_str,
                duration=elapsed,
                notes=f"执行步骤: {steps_executed}/{len(mission.instructions)}"
            )

        return AgentResult(
            success=all_passed,
            objective=mission.name,
            steps_taken=steps_executed,
            elapsed_seconds=elapsed,
            message="Mission completed successfully" if all_passed else "Mission step failed",
            history=self.action_history
        )


# Backward compatibility alias
VisualQAAgent = AutonomousVisualAgent
