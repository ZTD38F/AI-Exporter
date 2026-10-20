# scripts/visual_agent/sandbox.py
"""
Backward compatibility proxy for VisualPlayground.
"""

from .playground import (
    VisualPlayground,
    VisualSandbox,
    ScreenObservation,
    WaitResult,
    open_visual_playground,
    open_visual_sandbox,
)

__all__ = [
    "VisualPlayground",
    "VisualSandbox",
    "ScreenObservation",
    "WaitResult",
    "open_visual_playground",
    "open_visual_sandbox",
]
