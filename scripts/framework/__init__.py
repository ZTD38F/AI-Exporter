# scripts/framework/__init__.py
"""
Gemini Exporter Feature-Driven Testing Framework.
Provides declarative feature specifications, CDP action primitives, assertions, and test runner.
"""

from .features import Feature, FeatureDomain, FeatureRegistry, TestStatus, TestResult
from .actions import ExtensionActions, CDPActions
from .assertions import CDPAssertions
from .driver import (
    ChatPlatformDriver,
    PlatformCapabilities,
    GeminiPlatformDriver,
    GeminiDriver,
    GeminiChatSession,
    TurnResult
)

from .environment import TestEnvironment, EnvironmentContext

__all__ = [
    "Feature",
    "FeatureDomain",
    "FeatureRegistry",
    "TestStatus",
    "TestResult",
    "ExtensionActions",
    "CDPActions",
    "CDPAssertions",
    "ChatPlatformDriver",
    "PlatformCapabilities",
    "GeminiPlatformDriver",
    "GeminiDriver",
    "GeminiChatSession",
    "TurnResult",
    "TestEnvironment",
    "EnvironmentContext",
]


