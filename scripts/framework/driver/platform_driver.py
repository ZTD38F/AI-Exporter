# scripts/framework/driver/platform_driver.py
"""
Unified AI Chat Platform Driver Abstraction.
Defines the core abstract contracts and cross-platform data models
for orchestrating automated conversational tests across diverse AI chat platforms
(e.g., Google Gemini, OpenAI ChatGPT, Anthropic Claude).
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, Union, Callable


@dataclass
class TurnResult:
    """Represents the outcome of a single conversational turn across any platform."""
    success: bool
    prompt: str
    model_response: str = ""
    has_images: bool = False
    duration: float = 0.0
    error: Optional[str] = None
    chat_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PlatformCapabilities:
    """Capability matrix declaration for a chat platform."""
    platform_name: str
    supports_model_selection: bool = False
    supports_thinking_mode: bool = False
    supports_image_generation: bool = False
    supports_sidebar_deletion: bool = False
    supports_stream_events: bool = False
    base_url: str = ""


class ChatPlatformDriver(ABC):
    """
    Abstract contract for AI Chat platform automation drivers.
    Each platform (Gemini, ChatGPT, Claude) provides a concrete driver implementing this contract.
    All low-level CDP interactions, DOM manipulations, route navigation, and
    turn dispatches are encapsulated behind these declarative primitives.
    """

    def __init__(self, cdp: Any):
        self.cdp = cdp

    @property
    @abstractmethod
    def platform_id(self) -> str:
        """Unique platform identifier, e.g. 'gemini', 'chatgpt', 'claude'."""
        pass

    @property
    @abstractmethod
    def capabilities(self) -> PlatformCapabilities:
        """Platform capability matrix declaration."""
        pass

    @abstractmethod
    def ensure_ready(self, timeout: float = 20.0) -> bool:
        """Wait for the chat UI core elements to be mounted and interactive."""
        pass

    @abstractmethod
    def new_chat(self, timeout: float = 20.0) -> Any:
        """Start a clean, fresh conversation session."""
        pass

    @abstractmethod
    def open_chat(self, chat_id: str, timeout: float = 20.0) -> Any:
        """Navigate to an existing conversation by ID."""
        pass

    @abstractmethod
    def get_current_chat_id(self) -> Optional[str]:
        """Extract the current active conversation ID."""
        pass

    @abstractmethod
    def get_current_chat_title(self) -> Optional[str]:
        """Extract the current active conversation title."""
        pass

    @abstractmethod
    def send_turn(self, prompt: Union[str, Dict[str, Any]], max_wait: int = 300) -> TurnResult:
        """Send a prompt turn and deterministically wait for full stream settlement."""
        pass

    def ensure_model(self, target_model: str = "", **kwargs) -> bool:
        """Switch or ensure active model and thinking mode if supported."""
        return True

    def delete_chat_via_web(self, chat_id: str, timeout: float = 15.0) -> bool:
        """Trigger in-page deletion of conversation if supported."""
        return False

    @abstractmethod
    def get_selectors(self) -> Dict[str, str]:
        """Return platform DOM selector dictionary."""
        pass

    def prepare_turn_environment(self, is_image: bool = False) -> bool:
        """
        Hook executed before staging a turn, allowing the platform driver to setup
        streaming event listeners, verify active models, or reset session states.
        """
        return True

    @abstractmethod
    def build_turn_pipeline(
        self,
        prompt_text: str,
        max_wait: int = 300,
        is_image: bool = False,
        cooldown_seconds: float = 6.0
    ) -> List[Any]:
        """
        Construct the platform-specific atomic action sequence for a single turn.
        Returns a list of AtomicAction primitives to be executed by SerialActionExecutor.
        """
        pass

    def extract_turn_result(
        self,
        prompt_text: str,
        duration: float,
        is_image: bool = False
    ) -> TurnResult:
        """
        Extract the model's generated response, images, and telemetry data from the active DOM.
        """
        return TurnResult(
            success=True,
            prompt=prompt_text,
            duration=duration,
            chat_id=self.get_current_chat_id()
        )

    def get_pipeline_strategies(self) -> Dict[str, Callable]:
        """Optional pipeline atomic execution strategy hooks for this platform."""
        return {}


class PlatformRegistry:
    """平台驱动注册与发现工厂"""
    _drivers: Dict[str, Any] = {}

    @classmethod
    def register(cls, platform_id: str, driver_cls: Any) -> None:
        cls._drivers[platform_id.lower()] = driver_cls

    @classmethod
    def get_driver_class(cls, platform_id: str = "gemini") -> Optional[Any]:
        return cls._drivers.get(platform_id.lower())

    @classmethod
    def create_driver(cls, platform_id: str, cdp: Any, **kwargs) -> ChatPlatformDriver:
        driver_cls = cls.get_driver_class(platform_id)
        if not driver_cls:
            raise ValueError(f"未注册的平台驱动: '{platform_id}'。当前已注册: {list(cls._drivers.keys())}")
        return driver_cls(cdp, **kwargs)

