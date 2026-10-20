# scripts/framework/pipeline/__init__.py
from .stages import PipelineStage, PipelineConcurrencyViolationError, CircuitBreakerError
from .process_lock import ProcessLock, ProcessLockError
from .actions import (
    AtomicAction,
    ActionResult,
    UniversalInputAction,
    AssertIdleAction,
    StagePromptAction,
    SingleClickSendAction,
    AwaitStreamSettledAction,
    StreamSettledConfig,
    HumanCooldownAction,
    ClickNewChatAction,
    NavigateChatAction
)
from .executor import SerialActionExecutor, PipelineResult

__all__ = [
    "PipelineStage",
    "PipelineConcurrencyViolationError",
    "CircuitBreakerError",
    "ProcessLock",
    "ProcessLockError",
    "AtomicAction",
    "ActionResult",
    "UniversalInputAction",
    "AssertIdleAction",
    "StagePromptAction",
    "SingleClickSendAction",
    "AwaitStreamSettledAction",
    "StreamSettledConfig",
    "HumanCooldownAction",
    "ClickNewChatAction",
    "NavigateChatAction",
    "SerialActionExecutor",
    "PipelineResult"
]
