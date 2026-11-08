"""Compatibility aliases for the original Gemini-only Tier 2 API.

New callers use platforms.Tier2Runner with registered platform plugins.
"""
from scripts.framework.platforms.gemini_runtime import (
    GeminiRuntime as FrameworkRunner, DEFAULT_SCENARIOS, DESIGNATED_HISTORICAL_CHATS,
)
