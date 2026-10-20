# scripts/framework/driver/__init__.py
"""
High-Level Automation Driver and Chat Session Abstractions.
Encapsulates all low-level CDP interactions, DOM selectors, atomic pipelines,
session lifecycle transitions, and turn evaluations into clean, declarative APIs.
"""

from .platform_driver import (
    ChatPlatformDriver,
    TurnResult,
    PlatformCapabilities,
    PlatformRegistry
)
from .gemini_driver import (
    GeminiPlatformDriver,
    GeminiDriver,
    GeminiChatSession
)

__all__ = [
    "ChatPlatformDriver",
    "TurnResult",
    "PlatformCapabilities",
    "PlatformRegistry",
    "GeminiPlatformDriver",
    "GeminiDriver",
    "GeminiChatSession"
]
