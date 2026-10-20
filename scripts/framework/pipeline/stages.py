# scripts/framework/pipeline/stages.py
"""
Pipeline Stage Definitions and Invariant State Machine for Gemini Actions.
Enforces strictly one direction of state transitions:
IDLE -> STAGED -> DISPATCHED -> STREAMING -> SETTLED -> COOLDOWN -> IDLE
"""

from enum import Enum, auto
from typing import Set


class PipelineStage(Enum):
    IDLE = auto()          # 页面空闲，就绪接受新提问或页面导航
    STAGED = auto()        # Prompt 文本已原子注入输入框，但尚未点击发送
    DISPATCHED = auto()    # 发送按钮已被单次物理点击，等待网络/流式建立
    STREAMING = auto()     # 流式生成中 (捕获到 STREAM_START 或 streaming DOM 节点)
    SETTLED = auto()       # 生成已完成落盘 (STREAM_COMPLETE 落地且页面稳定，未进入冷却)
    COOLDOWN = auto()      # 人性化冷却休息中，结束后自动回到 IDLE


class PipelineConcurrencyViolationError(RuntimeError):
    """Raised when an action violates state machine invariants (e.g. attempting to stage prompt while streaming)."""
    pass


class CircuitBreakerError(RuntimeError):
    """Raised when the fail-fast circuit breaker halts the pipeline on unrecoverable errors."""
    pass
