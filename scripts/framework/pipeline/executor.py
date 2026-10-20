# scripts/framework/pipeline/executor.py
"""
Serial Action Executor with State Machine Invariant Guard.
Guarantees strictly single-flight execution of atomic actions,
halting on anomalies via Fail-Fast Circuit Breaker.
"""

import time
from typing import List, Optional, Any
from dataclasses import dataclass

from .stages import PipelineStage, PipelineConcurrencyViolationError, CircuitBreakerError
from .actions import AtomicAction, ActionResult


@dataclass
class PipelineResult:
    success: bool
    final_stage: PipelineStage
    error: Optional[str] = None
    executed_actions: int = 0
    duration: float = 0.0


class SerialActionExecutor:
    """
    绝对串行流水线执行器 (Single-Flight Invariant Executor).
    从数据结构与调度机制上彻底杜绝并发请求与死循环重试。
    """

    def __init__(self):
        self._current_stage: PipelineStage = PipelineStage.IDLE
        self._in_flight: bool = False

    @property
    def current_stage(self) -> PipelineStage:
        return self._current_stage

    @property
    def is_in_flight(self) -> bool:
        return self._in_flight

    def run_pipeline(self, ctx: Any, cdp: Any, actions: List[AtomicAction]) -> PipelineResult:
        """
        以绝对串行方式依次执行动作序列。
        任意 Action 失败立即触发 Circuit Breaker 熔断，绝不继续执行后续指令。
        """
        if self._in_flight:
            err_msg = f"❌【严格单飞违规】执行器当前正处于流水线执行中 (Stage: {self._current_stage})，物理拒绝重入或并发调用！"
            raise PipelineConcurrencyViolationError(err_msg)

        self._in_flight = True
        t0 = time.time()
        executed_count = 0

        try:
            for idx, action in enumerate(actions, 1):
                # 状态机前置硬校验 (Invariant Guard)
                if self._current_stage not in action.allowed_stages:
                    err_msg = (
                        f"❌【流水线状态机断言失败】动作 '{action.name}' 期望前置状态处于 {action.allowed_stages}，"
                        f"但当前实际状态为: {self._current_stage}！"
                        f"可能存在流式未结束即触发发帖的非法并发行为。执行器已主动阻断停机！"
                    )
                    raise PipelineConcurrencyViolationError(err_msg)

                print(f"      ▶️ [Action {idx}/{len(actions)}] {action.name} (Stage: {self._current_stage.name})...")

                # 执行原子动作
                try:
                    res: ActionResult = action.execute(ctx, cdp)
                except Exception as ex:
                    res = ActionResult(False, f"执行抛出未捕获异常: {ex}")

                if not res.success:
                    err = f"动作 [{action.name}] 失败: {res.message}"
                    print(f"      🛑 [Circuit Breaker] 全局熔断触发: {err}")
                    # 失败后安全回退至 IDLE，并熔断退出
                    self._current_stage = PipelineStage.IDLE
                    return PipelineResult(
                        success=False,
                        final_stage=self._current_stage,
                        error=err,
                        executed_actions=executed_count,
                        duration=time.time() - t0
                    )

                executed_count += 1
                self._current_stage = action.next_stage
                print(f"         ✓ 完成 ➔ 状态迁入: {self._current_stage.name}")

            return PipelineResult(
                success=True,
                final_stage=self._current_stage,
                error=None,
                executed_actions=executed_count,
                duration=time.time() - t0
            )

        finally:
            self._in_flight = False

    def execute_driver_turn(
        self,
        ctx: Any,
        driver: Any,
        prompt_text: str,
        max_wait: int = 300,
        is_image: bool = False,
        cooldown_seconds: float = 0.0
    ) -> PipelineResult:
        """
        基于 ChatPlatformDriver 的平台策略驱动单飞流水线执行。
        1. 执行 driver.prepare_turn_environment(is_image) 确保环境就绪
        2. 由 driver.build_turn_pipeline(...) 构建定制原子动作序列
        3. run_pipeline 绝对串行单飞执行
        """
        try:
            if hasattr(driver, "prepare_turn_environment"):
                driver.prepare_turn_environment(is_image=is_image)
        except Exception as ex:
            return PipelineResult(
                success=False,
                final_stage=self._current_stage,
                error=f"平台前置环境准备失败: {ex}",
                duration=0.0
            )

        cdp = getattr(driver, "cdp", None)
        actions = driver.build_turn_pipeline(
            prompt_text=prompt_text,
            max_wait=max_wait,
            is_image=is_image,
            cooldown_seconds=cooldown_seconds
        )
        return self.run_pipeline(ctx, cdp, actions)
