# scripts/visual_agent/providers/subagent_provider.py
"""
SubAgent Vision Provider for IDE-integrated AI Agents.
Enables Antigravity subagent coordination for visual inspection.
"""

import os
import json
import time
from typing import List, Dict, Optional, Any

from .base import VisionProvider, VisualAction, VisualActionType


class SubAgentVisionProvider(VisionProvider):
    def __init__(self, callback=None):
        self.callback = callback

    def decide_action(
        self,
        screenshot_bytes: bytes,
        instruction: str,
        history: List[Dict[str, Any]],
        context: Optional[Dict[str, Any]] = None
    ) -> VisualAction:
        if callable(self.callback):
            return self.callback(screenshot_bytes, instruction, history, context)

        # 默认使用通用推理逻辑（当外部注入 subagent handler 时委派）
        return VisualAction(
            action_type=VisualActionType.WAIT,
            thought=f"SubAgent provider 待处理指令: '{instruction}'"
        )
