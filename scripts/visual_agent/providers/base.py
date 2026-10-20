# scripts/visual_agent/providers/base.py
"""
Base interface for Vision Providers in Tier 3 Pure Visual Agent Testing.
"""

from enum import Enum
from dataclasses import dataclass, field
from abc import ABC, abstractmethod
from typing import List, Dict, Optional, Any, Tuple


class VisualActionType(Enum):
    CLICK = "CLICK"
    TYPE = "TYPE"
    PASTE = "PASTE"
    CLEAR = "CLEAR"
    SCROLL = "SCROLL"
    WAIT = "WAIT"
    WAIT_ON = "WAIT_ON"
    SWITCH_PAGE = "SWITCH_PAGE"
    KEY = "KEY"
    DONE = "DONE"
    FAIL = "FAIL"


@dataclass
class VisualAction:
    action_type: VisualActionType
    x: Optional[float] = None  # Normalized (0.0 - 1.0) or absolute pixel
    y: Optional[float] = None  # Normalized (0.0 - 1.0) or absolute pixel
    text: Optional[str] = None
    key: Optional[str] = None
    target: Optional[str] = None
    chat_id: Optional[str] = None
    condition: Optional[str] = None
    timeout: Optional[int] = None
    thought: Optional[str] = None
    confidence: float = 1.0
    details: Dict[str, Any] = field(default_factory=dict)


class VisionProvider(ABC):
    """
    Abstract Vision Provider Interface.
    Takes raw screenshot bytes and a high-level user instruction,
    relying exclusively on visual perception to decide physical actions.
    """

    @abstractmethod
    def decide_action(
        self,
        screenshot_bytes: bytes,
        instruction: str,
        history: List[Dict[str, Any]],
        context: Optional[Dict[str, Any]] = None
    ) -> VisualAction:
        """
        Input: PNG screenshot bytes, instruction string, action history.
        Output: VisualAction (coordinates, key, or text) deduced purely from visual perception.
        """
        pass
