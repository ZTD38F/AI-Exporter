# scripts/visual_agent/playground.py
"""
Gemini Exporter — Visual Playground Environment.
Acts as an interactive, hardware-isolated playground for Autonomous AI Agents:
- Pure screenshot perception (zero DOM tree leaks)
- Hardware-grade physical mouse & keyboard actuation (mouseMoved/mousePressed/mouseReleased, KeyA/Backspace/insertText)
- Deterministic blocking wait primitives (`wait_on`), reusing Tier 2 infrastructure
- Viewport distortion protection: always clears device metrics override on teardown
"""

import os
import sys
import time
import json
import base64
import platform
import glob
import zipfile
import struct
import shutil
import tempfile
import urllib.request
from dataclasses import dataclass, field
from typing import Optional, Tuple, Dict, Any, List

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from scripts.cdp_client import (
    CDPConnection,
    get_tabs,
    get_extension_id,
    ensure_extension_loaded,
    get_browser_ws_url,
    is_gemini_url,
    CDP_DEFAULT_PORT
)
from scripts.framework.pipeline.actions import (
    AwaitStreamSettledAction,
    AssertIdleAction,
    StreamSettledConfig
)
from scripts.framework.selectors import WorkbenchSelectors
from scripts.framework.gateway import get_gateway


@dataclass
class ScreenObservation:
    """Raw visual perception result. Absolutely zero DOM tree is exposed."""
    image_bytes: bytes
    b64_data: str
    file_path: str
    viewport: Tuple[int, int]
    timestamp: float
    step_name: str


@dataclass
class WaitResult:
    """Outcome of a blocking wait condition."""
    success: bool
    message: str
    elapsed: float
    data: Dict[str, Any] = field(default_factory=dict)


class VisualPlayground:
    """
    Interactive Visual Playground Environment.
    Exposes only physical sensory and actuator primitives for an Agent:
    1. capture_screen() -> ScreenObservation
    2. mouse_click(x, y)
    3. mouse_scroll(delta_y, x, y)
    4. input_text(text, x, y, clear_first)
    5. wait_on(condition, timeout)
    6. reset(target)
    7. evaluate_export(zip_path)
    """

    def __init__(
        self,
        cdp: Any,
        port: int = CDP_DEFAULT_PORT,
        active_target: str = "options",
        viewport_size: Tuple[int, int] = (1280, 800),
        output_dir: Optional[str] = None,
        env: Optional[Any] = None
    ):
        self.cdp = cdp
        self.port = port
        self.active_target = active_target
        self.viewport_size = viewport_size
        self.width, self.height = viewport_size
        self.output_dir = output_dir or os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../../tests/output/visual_audit")
        )
        os.makedirs(self.output_dir, exist_ok=True)
        self.history: List[Dict[str, Any]] = []
        self._is_mock = not hasattr(self.cdp, "ws_url") or "Mock" in type(self.cdp).__name__

        if env is not None:
            self.env = env
        else:
            from scripts.framework.environment import TestEnvironment
            self.env = TestEnvironment(
                port=self.port,
                output_dir=self.output_dir,
                viewport_size=self.viewport_size
            )

        self._setup_viewport()
        self._setup_download_behavior()
        self._save_state()

    def _save_state(self, chat_id: Optional[str] = None):
        """Persist current active target and chat info for stateless CLI calls."""
        state_file = os.path.join(self.output_dir, ".playground_state.json")
        try:
            with open(state_file, "w", encoding="utf-8") as f:
                json.dump({
                    "port": self.port,
                    "target": self.active_target,
                    "chat_id": chat_id,
                    "updated_at": time.time()
                }, f, indent=2)
        except Exception:
            pass

    @classmethod
    def load_active_target(cls, output_dir: Optional[str] = None) -> Tuple[str, Optional[str]]:
        """Read current active target and chat_id from persistent state."""
        out = output_dir or os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../../tests/output/visual_audit")
        )
        state_file = os.path.join(out, ".playground_state.json")
        if os.path.exists(state_file):
            try:
                with open(state_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data.get("target", "options"), data.get("chat_id")
            except Exception:
                pass
        return "options", None

    def _setup_download_behavior(self):
        """Configure browser and page download behavior to save exported archives to output_dir."""
        if hasattr(self, "env") and self.env and not self._is_mock:
            self.env.setup_download_behavior(output_dir=self.output_dir, cdp=self.cdp)
        else:
            try:
                res = self.cdp.call("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": self.output_dir})
                if isinstance(res, dict) and "error" in res:
                    print(f"⚠️ Page.setDownloadBehavior failed: {res['error']}")
            except Exception as e:
                print(f"⚠️ Page.setDownloadBehavior exception: {e}")

    def _setup_viewport(self):
        """Force standardized physical viewport and remove scaling distortions."""
        if self.active_target == "popup" and not self._is_mock:
            # Action popups retain Chrome's native surface size. Emulating a
            # full page changes layout metrics but not the captured surface.
            self.cdp.call("Emulation.clearDeviceMetricsOverride", {})
            response = self.cdp.call("Page.getLayoutMetrics", {})
            viewport = response.get("result", response).get("cssLayoutViewport", {})
            width, height = viewport.get("clientWidth", 0), viewport.get("clientHeight", 0)
            if width <= 0 or height <= 0:
                raise RuntimeError("Action popup has no usable native viewport")
            self.viewport_size = (width, height)
            self.width, self.height = self.viewport_size
            return
        if hasattr(self, "env") and self.env and not self._is_mock:
            response = self.cdp.call("Page.getLayoutMetrics", {})
            viewport = response.get("result", response).get("cssLayoutViewport", {})
            if (viewport.get("clientWidth"), viewport.get("clientHeight")) == self.viewport_size:
                return
            self.env.setup_viewport(self.cdp, self.viewport_size)
        else:
            try:
                self.cdp.call("Page.enable")
            except Exception:
                pass
            try:
                self.cdp.call("Emulation.clearDeviceMetricsOverride")
            except Exception:
                pass
            try:
                self.cdp.call("Emulation.setDeviceMetricsOverride", {
                    "width": self.width,
                    "height": self.height,
                    "deviceScaleFactor": 1,
                    "mobile": False
                })
            except Exception:
                pass

    def teardown(self, keep_viewport: bool = False):
        """
        Safely tear down the playground:
        Explicitly clear any device metrics overrides to prevent viewport shrinkage bugs,
        and cleanly disconnect the CDP session.
        """
        if keep_viewport:
            # Stateless CLI commands share one fixed test viewport; final teardown restores it.
            self.cdp.close()
            browser_cdp = getattr(self.env, "browser_cdp", None)
            if browser_cdp:
                browser_cdp.close()
        elif hasattr(self, "env") and self.env and not self._is_mock:
            self.env.teardown(self.cdp)
        else:
            try:
                self.cdp.call("Emulation.clearDeviceMetricsOverride")
            except Exception:
                pass
            try:
                self.cdp.close()
            except Exception:
                pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.teardown()

    def _to_pixel(self, x: float, y: float) -> Tuple[int, int]:
        """
        Convert normalized (0.0 - 1.0) or absolute coordinates to CSS pixels for CDP Input dispatch.
        Accurately scales by CDP layout metrics without evaluating page JavaScript,
        natively accommodating any display DPI / Retina scaling (DPR 1.0, 1.5, 2.0).
        """
        css_w = float(self.width)
        css_h = float(self.height)
        dpr = 1.0
        try:
            response = self.cdp.call("Page.getLayoutMetrics", {})
            metrics = response.get("result", response)
            viewport = metrics.get("cssLayoutViewport", {})
            css_w = float(viewport.get("clientWidth") or css_w)
            css_h = float(viewport.get("clientHeight") or css_h)
            device_width = float(metrics.get("layoutViewport", {}).get("clientWidth") or css_w)
            dpr = device_width / css_w
        except Exception:
            pass

        if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0:
            px_x = int(round(x * css_w))
            px_y = int(round(y * css_h))
        else:
            if x > css_w and dpr > 1.0:
                px_x = int(round(x / dpr))
            else:
                px_x = int(round(x))

            if y > css_h and dpr > 1.0:
                px_y = int(round(y / dpr))
            else:
                px_y = int(round(y))

        px_x = max(0, min(int(css_w), px_x))
        px_y = max(0, min(int(css_h), px_y))
        return px_x, px_y

    def capture_screen(self, step_name: Optional[str] = None) -> ScreenObservation:
        """
        Pure visual perception primitive.
        Takes a native CDP screenshot of the current viewport.
        Returns a clean ScreenObservation object containing raw PNG bytes and file path.
        ZERO DOM elements, selectors, or text structures are returned.
        """
        step_name = step_name or f"shot_{int(time.time() * 1000)}"
        # A reconnect can race the compositor's resize. Never return an image
        # whose coordinates differ from the viewport used by click/type.
        for attempt in range(10):
            res = self.cdp.call("Page.captureScreenshot", {"format": "png"})
            data = res.get("result", res)
            b64_data = data.get("data", "")
            img_bytes = base64.b64decode(b64_data)
            if img_bytes[:8] != b"\x89PNG\r\n\x1a\n" or len(img_bytes) < 24:
                raise RuntimeError("Screenshot is not a valid PNG")
            actual = struct.unpack(">II", img_bytes[16:24])
            if actual == self.viewport_size:
                break
            if attempt == 9:
                raise RuntimeError(f"Screenshot viewport mismatch: expected {self.viewport_size}, got {actual}")
            time.sleep(0.1)
            self._setup_viewport()

        file_path = os.path.join(self.output_dir, f"{step_name}.png")
        with open(file_path, "wb") as f:
            f.write(img_bytes)

        obs = ScreenObservation(
            image_bytes=img_bytes,
            b64_data=b64_data,
            file_path=file_path,
            viewport=(self.width, self.height),
            timestamp=time.time(),
            step_name=step_name
        )
        self.history.append({
            "action": "capture_screen",
            "file": file_path,
            "step_name": step_name,
            "timestamp": obs.timestamp
        })
        return obs

    def mouse_click(self, x: float, y: float, button: str = "left", label: Optional[str] = None):
        """
        Hardware-grade physical mouse click primitive:
        Dispatches standard Input.dispatchMouseEvent:
        1. mouseMoved -> (x, y)
        2. mousePressed -> (x, y)
        3. mouseReleased -> (x, y)
        """
        px_x, px_y = self._to_pixel(x, y)
        btn = "left" if button.lower() == "left" else "right"

        self.cdp.call("Input.dispatchMouseEvent", {
            "type": "mouseMoved",
            "x": px_x,
            "y": px_y
        })
        time.sleep(0.05)

        self.cdp.call("Input.dispatchMouseEvent", {
            "type": "mousePressed",
            "x": px_x,
            "y": px_y,
            "button": btn,
            "clickCount": 1
        })
        time.sleep(0.08)

        self.cdp.call("Input.dispatchMouseEvent", {
            "type": "mouseReleased",
            "x": px_x,
            "y": px_y,
            "button": btn,
            "clickCount": 1
        })
        time.sleep(0.15)

        self.history.append({
            "action": "mouse_click",
            "coords": [px_x, px_y],
            "norm_coords": [x, y],
            "button": btn,
            "label": label,
            "timestamp": time.time()
        })

    def mouse_scroll(self, delta_y: int, x: float = 0.5, y: float = 0.5):
        """Hardware-grade physical mouse wheel event."""
        px_x, px_y = self._to_pixel(x, y)
        self.cdp.call("Input.dispatchMouseEvent", {
            "type": "mouseWheel",
            "x": px_x,
            "y": px_y,
            "deltaX": 0,
            "deltaY": int(delta_y)
        })
        time.sleep(0.2)
        self.history.append({
            "action": "mouse_scroll",
            "delta_y": delta_y,
            "at": [px_x, px_y],
            "timestamp": time.time()
        })

    def input_text(
        self,
        text: str = "",
        x: Optional[float] = None,
        y: Optional[float] = None,
        clear_first: bool = True,
        use_insert: bool = True
    ):
        """
        Hardware-level text input primitive:
        1. Physically clicks (x, y) to gain focus if coordinates provided.
        2. If clear_first=True, clears the focused control using KeyA / Backspace.
        3. Inserts text through CDP Input.insertText at physical focus.
        Never inspect or mutate DOM nodes: non-text controls must keep their children.
        Note: To simply clear an input at (x, y), call input_text("", x=x, y=y, clear_first=True).
        """
        if x is not None and y is not None:
            self.mouse_click(x, y, label="focus_for_input")
            time.sleep(0.1)

        if clear_first:
            is_mac = platform.system().lower() == "darwin"
            modifier = 4 if is_mac else 2
            self.cdp.call("Input.dispatchKeyEvent", {
                "type": "rawKeyDown",
                "windowsVirtualKeyCode": 65,
                "key": "a",
                "code": "KeyA",
                "modifiers": modifier,
                "commands": ["selectAll"]
            })
            self.cdp.call("Input.dispatchKeyEvent", {
                "type": "keyUp",
                "windowsVirtualKeyCode": 65,
                "key": "a",
                "code": "KeyA",
                "modifiers": modifier
            })
            time.sleep(0.05)
            self.cdp.call("Input.dispatchKeyEvent", {
                "type": "rawKeyDown",
                "windowsVirtualKeyCode": 8,
                "key": "Backspace",
                "code": "Backspace"
            })
            self.cdp.call("Input.dispatchKeyEvent", {
                "type": "keyUp",
                "windowsVirtualKeyCode": 8,
                "key": "Backspace",
                "code": "Backspace"
            })
            time.sleep(0.1)

        if text:
            if use_insert:
                self.cdp.call("Input.insertText", {"text": text})
            else:
                for ch in text:
                    self.cdp.call("Input.dispatchKeyEvent", {"type": "char", "text": ch})
                    time.sleep(0.02)

        time.sleep(0.15)
        self.history.append({
            "action": "input_text",
            "text": text,
            "x": x,
            "y": y,
            "clear_first": clear_first,
            "timestamp": time.time()
        })

    def press_key(self, key: str, modifiers: int = 0):
        """
        Hardware-grade physical keystroke dispatch primitive via CDP Input.dispatchKeyEvent.
        Supports standard keys like Enter, Escape, Tab, Backspace, Arrow keys, etc.
        """
        KEY_MAP = {
            "Enter": {"windowsVirtualKeyCode": 13, "key": "Enter", "code": "Enter"},
            "Return": {"windowsVirtualKeyCode": 13, "key": "Enter", "code": "Enter"},
            "Escape": {"windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"},
            "Esc": {"windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"},
            "Tab": {"windowsVirtualKeyCode": 9, "key": "Tab", "code": "Tab"},
            "Backspace": {"windowsVirtualKeyCode": 8, "key": "Backspace", "code": "Backspace"},
            "Delete": {"windowsVirtualKeyCode": 46, "key": "Delete", "code": "Delete"},
            "Home": {"windowsVirtualKeyCode": 36, "key": "Home", "code": "Home"},
            "End": {"windowsVirtualKeyCode": 35, "key": "End", "code": "End"},
            "ArrowDown": {"windowsVirtualKeyCode": 40, "key": "ArrowDown", "code": "ArrowDown"},
            "Down": {"windowsVirtualKeyCode": 40, "key": "ArrowDown", "code": "ArrowDown"},
            "ArrowUp": {"windowsVirtualKeyCode": 38, "key": "ArrowUp", "code": "ArrowUp"},
            "Up": {"windowsVirtualKeyCode": 38, "key": "ArrowUp", "code": "ArrowUp"},
            "ArrowLeft": {"windowsVirtualKeyCode": 37, "key": "ArrowLeft", "code": "ArrowLeft"},
            "Left": {"windowsVirtualKeyCode": 37, "key": "ArrowLeft", "code": "ArrowLeft"},
            "ArrowRight": {"windowsVirtualKeyCode": 39, "key": "ArrowRight", "code": "ArrowRight"},
            "Right": {"windowsVirtualKeyCode": 39, "key": "ArrowRight", "code": "ArrowRight"},
            "Space": {"windowsVirtualKeyCode": 32, "key": " ", "code": "Space"},
        }
        # Background extension tabs need keyboard focus without stealing OS focus.
        self.cdp.call("Emulation.setFocusEmulationEnabled", {"enabled": True})
        entry = KEY_MAP.get(key)
        if entry:
            vk = entry["windowsVirtualKeyCode"]
            k = entry["key"]
            code = entry["code"]
        elif len(key) == 1:
            vk = ord(key.upper()) if key.isalnum() else 0
            k = key
            code = f"Key{key.upper()}" if key.isalpha() else (f"Digit{key}" if key.isdigit() else "")
        else:
            vk = 0
            k = key
            code = key

        self.cdp.call("Input.dispatchKeyEvent", {
            "type": "rawKeyDown",
            "windowsVirtualKeyCode": vk,
            "key": k,
            "code": code,
            "modifiers": modifiers
        })
        if len(key) == 1 and not modifiers:
            self.cdp.call("Input.dispatchKeyEvent", {
                "type": "char",
                "text": key
            })
        self.cdp.call("Input.dispatchKeyEvent", {
            "type": "keyUp",
            "windowsVirtualKeyCode": vk,
            "key": k,
            "code": code,
            "modifiers": modifiers
        })
        time.sleep(0.05)
        self.history.append({
            "action": "press_key",
            "key": key,
            "modifiers": modifiers,
            "timestamp": time.time()
        })

    def wait_on(
        self,
        condition: str,
        timeout: int = 300,
        **kwargs
    ) -> WaitResult:
        """
        Deterministic blocking wait primitive, directly reusing Tier 2 infrastructure.
        The Agent calls this method after dispatching actions (e.g. send prompt or export),
        suspending itself with ZERO token waste while the deterministic engine awaits settlement.
        """
        t0 = time.time()
        cond = condition.lower().strip()

        if cond in ("stream_settled", "stream", "chat_complete"):
            config = kwargs.get("config", None)
            action = AwaitStreamSettledAction(
                timeout=timeout,
                config=config
            )
            res = action.execute(None, self.cdp)
            elapsed = time.time() - t0
            return WaitResult(
                success=res.success,
                message=res.message,
                elapsed=elapsed,
                data=res.data or {}
            )

        elif cond in ("ui_idle", "idle"):
            action = AssertIdleAction(max_wait=timeout)
            res = action.execute(None, self.cdp)
            elapsed = time.time() - t0
            return WaitResult(
                success=res.success,
                message=res.message,
                elapsed=elapsed,
                data=res.data or {}
            )

        elif cond in ("zip_downloaded", "download_complete", "export_complete"):
            download_dir = kwargs.get("download_dir") or self.output_dir
            expected_pattern = kwargs.get("pattern") or ("*.zip" if cond == "zip_downloaded" else "*")
            previous = {}
            min_mtime = kwargs.get("min_mtime", 0.0)
            start_wait = time.time()

            found_file = None
            while time.time() - start_wait < timeout:
                time.sleep(0.8)
                if os.path.isdir(download_dir):
                    matches = sorted(glob.glob(os.path.join(download_dir, expected_pattern)), key=os.path.getmtime, reverse=True)
                    for candidate in matches:
                        suffix = os.path.splitext(candidate)[1].lower()
                        if suffix not in (".zip", ".md", ".json", ".html", ".pdf") or not os.path.isfile(candidate):
                            continue
                        stat = os.stat(candidate)
                        signature = (stat.st_size, stat.st_mtime_ns)
                        stable = previous.get(candidate) == signature
                        previous[candidate] = signature
                        if stat.st_mtime < min_mtime or stat.st_size == 0 or os.path.exists(candidate + ".crdownload"):
                            continue
                        if suffix == ".zip" and not zipfile.is_zipfile(candidate):
                            continue
                        if not stable:
                            continue
                        found_file = candidate
                        break
                    if found_file:
                        break

            elapsed = time.time() - t0
            if found_file:
                return WaitResult(
                    success=True,
                    message=f"导出文件成功落盘: {os.path.basename(found_file)} ({os.path.getsize(found_file)} bytes)",
                    elapsed=elapsed,
                    data={"file_path": found_file, "size": os.path.getsize(found_file)}
                )
            return WaitResult(
                success=False,
                message=f"等待导出文件落盘超时 ({timeout}s)",
                elapsed=elapsed
            )

        elif cond in ("dom_pruned", "pruned"):
            from scripts.framework.assertions import CDPAssertions
            chat_id = kwargs.get("chat_id", "")
            pruned_ok, pruned_msg, _ = CDPAssertions.assert_dom_pruned(self.cdp, chat_id, timeout=float(timeout))
            elapsed = time.time() - t0
            return WaitResult(
                success=pruned_ok,
                message=pruned_msg,
                elapsed=elapsed
            )

        else:
            time.sleep(min(timeout, 1.0))
            return WaitResult(
                success=True,
                message=f"通用等待完成 ({condition})",
                elapsed=time.time() - t0
            )

    def switch_page(
        self,
        target: str = "gemini",
        chat_id: Optional[str] = None,
        timeout: float = 20.0,
        bring_to_front: bool = False,
        new_chat: bool = False
    ) -> bool:
        """
        无缝切换活动标签页。
        
        参数:
          - target: "options" (或 "workbench") | "gemini" (或 "chat")
          - chat_id: 可选。当 target 为 gemini 时，传入指定会话 ID (如 "c_28a9d..." 或 "28a9d...")，
                     将直接精准导航至 https://gemini.google.com/app/{chat_id_clean} 并等待输入框就绪。
          - timeout: 等待页面或会话就绪的最大超时秒数。
          - bring_to_front: 是否将 Chrome 窗口物理前置激活 (Page.bringToFront)。默认为 False，
                            CDP 在后台直接静默操作标签页，彻底杜绝抢占 OS 桌面焦点。
          - new_chat: 当 target 为 gemini 时，是否开启全新空白对话 (导航至 https://gemini.google.com/app 并清空输入框)。
        """
        t_lower = target.lower() if target else ""
        if t_lower in ("gemini", "chat"):
            norm_target = "gemini"
        elif t_lower in ("popup",):
            norm_target = "popup"
        else:
            norm_target = "options"

        # 单元测试 / MockCDP 环境兼容处理
        if self._is_mock:
            self.active_target = norm_target
            if bring_to_front:
                try:
                    self.cdp.call("Page.bringToFront")
                except Exception:
                    pass
            clean_cid = None
            if norm_target == "gemini":
                gateway = get_gateway()
                if new_chat:
                    try:
                        gateway.safe_navigate(self.cdp, "https://gemini.google.com/app")
                    except Exception:
                        pass
                elif chat_id:
                    clean_cid = str(chat_id).strip()
                    if clean_cid.startswith("c_"):
                        clean_cid = clean_cid[2:]
                    try:
                        gateway.safe_navigate(self.cdp, f"https://gemini.google.com/app/{clean_cid}")
                    except Exception:
                        pass
            self._save_state(chat_id=clean_cid)
            return True

        target_tab = self.env.ensure_tab(norm_target)
        if not target_tab:
            tabs = get_tabs(self.port)
            if norm_target == "gemini":
                target_tab = next((t for t in tabs if t.get("type", "page") == "page" and is_gemini_url(t.get("url", ""))), None)
            elif norm_target == "popup":
                target_tab = next((t for t in tabs if t.get("type", "page") == "page" and "popup.html" in t.get("url", "")), None)
            elif norm_target == "options":
                target_tab = next((t for t in tabs if t.get("type", "page") == "page" and "options.html" in t.get("url", "")), None)
            if not target_tab and tabs:
                target_tab = tabs[0]

        if not target_tab:
            raise RuntimeError(f"无法定位或创建目标标签页: {target}")

        # 切换活动 CDP 连接
        target_ws = target_tab.get("webSocketDebuggerUrl")
        current_ws = getattr(self.cdp, "ws_url", None)
        if target_ws and target_ws != current_ws:
            try:
                self.cdp.close()
            except Exception:
                pass
            self.cdp = CDPConnection(target_ws)

        # 可选物理置顶前置激活目标标签页 (默认 False 避免抢占 macOS 桌面焦点)
        if bring_to_front:
            try:
                self.cdp.call("Page.bringToFront")
            except Exception:
                pass

        # 导航处理：全新对话 或 指定会话 ID (100% 复用 Tier 2 网关与平台驱动，绝无私有 DOM innerHTML 篡改)
        clean_cid = None
        if norm_target == "gemini":
            from scripts.framework.actions import CDPActions
            gateway = get_gateway()

            if new_chat:
                try:
                    gateway.safe_navigate(self.cdp, "https://gemini.google.com/app")
                except Exception:
                    pass
                time.sleep(1.0)
                CDPActions.wait_for_gemini_ready(self.cdp, max_wait=int(timeout))
            elif chat_id:
                clean_cid = str(chat_id).strip()
                if clean_cid.startswith("c_"):
                    clean_cid = clean_cid[2:]
                target_url = f"https://gemini.google.com/app/{clean_cid}"
                curr_url = target_tab.get("url", "")
                if clean_cid not in curr_url:
                    try:
                        gateway.safe_navigate(self.cdp, target_url)
                    except Exception:
                        pass
                    time.sleep(1.0)
                CDPActions.wait_for_gemini_ready(self.cdp, max_wait=int(timeout))

        self._setup_viewport()
        self._setup_download_behavior()
        self.active_target = norm_target
        self._save_state(chat_id=clean_cid)
        return True

    def reset(self, target: str = "options", reinstall: bool = False) -> bool:
        """
        Resets the playground to a clean initial state.
        Supports optional extension reinstallation via Tier 2 TestEnvironment.
        """
        t_lower = target.lower() if target else ""
        if t_lower in ("gemini", "chat"):
            norm_target = "gemini"
        elif t_lower in ("popup",):
            norm_target = "popup"
        else:
            norm_target = "options"

        if reinstall and hasattr(self, "env") and self.env and not self._is_mock:
            self.env.init_environment(
                reinstall=True,
                target_pages=[norm_target],
                active_target=norm_target,
                reload_gemini=(norm_target == "gemini"),
                setup_viewport=True,
                setup_download=True
            )
            return self.switch_page(target=norm_target)

        self._setup_viewport()
        return self.switch_page(target=target)

    def evaluate_export(
        self,
        zip_path: str,
        min_conversations: int = 1,
        expected_golden_chats: Optional[List[Dict[str, Any]]] = None,
        chat_id: Optional[str] = None
    ) -> Tuple[bool, str, Dict[str, Any]]:
        """Run the comprehensive ExportSpecificationAsserter against a given exported ZIP file."""
        from scripts.framework.assertions import CDPAssertions
        suffix = os.path.splitext(zip_path)[1].lower()
        if suffix == ".md":
            from tests.helpers.export_spec_asserter import ExportSpecificationAsserter
            if not os.path.isfile(zip_path) or not os.path.getsize(zip_path):
                return False, "Markdown file is missing or empty", {}
            with tempfile.TemporaryDirectory(prefix="visual-export-") as stage:
                shutil.copy2(zip_path, os.path.join(stage, os.path.basename(zip_path)))
                checker = ExportSpecificationAsserter(stage)
                ok = checker.run_all_assertions(min_conversations=min_conversations,
                    expected_golden_chats=expected_golden_chats, target_chat_id=chat_id)
                return ok, "Standalone Markdown specification " + ("passed" if ok else "failed"), {
                    "format": "md", "md_count": len(checker.md_files), "errors": checker.errors,
                    "warnings": checker.warnings, "file_path": zip_path}
        if suffix != ".zip" or not zipfile.is_zipfile(zip_path):
            return False, "Expected a valid ZIP or standalone Markdown; other formats need their own validator", {"format": suffix}
        with zipfile.ZipFile(zip_path) as archive:
            documents = [name for name in archive.namelist() if not name.endswith('/')
                         and not any(part in ('assets', 'files', 'images') for part in name.split('/')[:-1])]
            formats = {os.path.splitext(name)[1].lower() for name in documents}
        if '.json' in formats and '.md' not in formats:
            if expected_golden_chats:
                return False, 'JSON golden content assertions are unsupported', {'format': 'json'}
            from scripts.framework.json_archive import validate_json_archive
            return validate_json_archive(zip_path, min_conversations, chat_id)
        if '.md' not in formats and formats.intersection({'.html', '.pdf'}):
            return False, 'Unsupported archive format: HTML/PDF need their own content validator', {'formats': sorted(formats)}
        extract_dir = os.path.join(self.output_dir, "extracted_export")
        return CDPAssertions.assert_exported_zip_spec(
            zip_path=zip_path, extract_dir=extract_dir, min_conversations=min_conversations,
            expected_golden_chats=expected_golden_chats, chat_id=chat_id)



VisualSandbox = VisualPlayground


def open_visual_playground(
    port: int = CDP_DEFAULT_PORT,
    target_page: Optional[str] = None,
    viewport_size: Tuple[int, int] = (1280, 800),
    output_dir: Optional[str] = None,
    reinstall: bool = False,
    repo_path: Optional[str] = None,
    env: Optional[Any] = None
) -> VisualPlayground:
    out = output_dir or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../tests/output/visual_audit")
    )
    if not target_page:
        saved_target, _ = VisualPlayground.load_active_target(out)
        target_page = saved_target or "options"

    t_lower = target_page.lower() if target_page else ""
    if t_lower in ("gemini", "chat"):
        norm_target = "gemini"
    elif t_lower in ("popup",):
        norm_target = "popup"
    else:
        norm_target = "options"

    target_repo = os.path.abspath(repo_path or os.path.join(os.path.dirname(__file__), "../.."))

    if env is None:
        from scripts.framework.environment import TestEnvironment
        env = TestEnvironment(
            port=port,
            output_dir=out,
            viewport_size=viewport_size,
            repo_path=target_repo
        )

    if reinstall:
        print(f"\n🔄 [Playground 步骤 0] 通过 Tier 2 TestEnvironment 原生卸载并纯净安装扩展: {target_repo}...")
        reinstalled_id = env.reinstall_extension()
        if not reinstalled_id:
            raise RuntimeError(f"❌ 扩展卸载与纯净重装失败 (端口 {port})，无法初始化 Playground 靶场！")
        time.sleep(1.0)
        print(f"🧩 当前活跃扩展 ID: {reinstalled_id}")

    expected_path = {"options": "/src/ui/options/options.html", "popup": "/src/ui/popup/popup.html"}
    target_tab = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        candidate = env.ensure_tab(norm_target)
        if candidate:
            parsed = urllib.parse.urlsplit(candidate.get("url", ""))
            valid = (is_gemini_url(candidate.get("url", "")) if norm_target == "gemini" else
                     parsed.scheme == "chrome-extension" and parsed.netloc == env.get_extension_id()
                     and parsed.path == expected_path[norm_target])
            if valid and candidate.get("webSocketDebuggerUrl"):
                target_tab = candidate
                break
        time.sleep(0.2)
    if not target_tab:
        raise RuntimeError(f"Target {norm_target} not ready on port {port}; refusing unrelated tab fallback")

    cdp = CDPConnection(target_tab["webSocketDebuggerUrl"])
    playground = VisualPlayground(
        cdp=cdp,
        port=port,
        active_target=norm_target,
        viewport_size=viewport_size,
        output_dir=out,
        env=env
    )
    return playground


open_visual_sandbox = open_visual_playground
