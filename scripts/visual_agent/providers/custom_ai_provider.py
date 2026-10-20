# scripts/visual_agent/providers/custom_ai_provider.py
"""
Custom AI Vision Provider for Tier 3 Autonomous Visual Agent Testing.
Connects to external/custom multimodal AI endpoints (e.g., OpenAI-compatible vision APIs or custom VLMs)
to autonomously ground UI elements and decide physical actions from screenshots (0 DOM leaks).
"""

import os
import json
import base64
import urllib.request
import urllib.error
from typing import List, Dict, Optional, Any

from .base import VisionProvider, VisualAction, VisualActionType


class CustomAIVisionProvider(VisionProvider):
    """
    Generic Custom AI Multimodal Vision Provider.
    Supports configurable endpoints, API keys, and models for third-party or internal AI services.
    """

    def __init__(
        self,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: float = 45.0
    ):
        self.endpoint = endpoint or os.environ.get("CUSTOM_AI_ENDPOINT")
        self.api_key = api_key or os.environ.get("CUSTOM_AI_API_KEY") or os.environ.get("OPENAI_API_KEY")
        self.model = model or os.environ.get("CUSTOM_AI_MODEL") or "default-vlm"
        self.custom_headers = headers or {}
        self.timeout = timeout

    def decide_action(
        self,
        screenshot_bytes: bytes,
        instruction: str,
        history: List[Dict[str, Any]],
        context: Optional[Dict[str, Any]] = None
    ) -> VisualAction:
        """
        Sends current screenshot and testing instruction to custom multimodal endpoint.
        Receives and validates physical action decision.
        """
        if not self.endpoint:
            return VisualAction(
                action_type=VisualActionType.FAIL,
                thought="未配置 CUSTOM_AI_ENDPOINT，无法调用自定义 AI 视觉接口"
            )

        b64_image = base64.b64encode(screenshot_bytes).decode("utf-8")

        system_prompt = (
            "You are an autonomous AI UI testing agent interacting with a Chrome extension web interface.\n"
            "You have ZERO access to DOM trees, HTML, or JavaScript selectors.\n"
            "You MUST perceive the interface exclusively from the provided screenshot image.\n"
            "Determine the single best physical mouse or keyboard action to fulfill the current instruction.\n\n"
            "Return ONLY a JSON object formatted exactly as:\n"
            "{\n"
            '  "thought": "brief explanation of what you visually observe and why you chose this action",\n'
            '  "action": "CLICK" | "TYPE" | "PASTE" | "CLEAR" | "KEY" | "SCROLL" | "WAIT_ON" | "SWITCH_PAGE" | "WAIT" | "DONE" | "FAIL",\n'
            '  "box_2d": [ymin, xmin, ymax, xmax], // 0 to 1000 normalized coordinates for CLICK / TYPE\n'
            '  "x": 0.0-1.0, // or normalized 0.0-1.0 X coordinate\n'
            '  "y": 0.0-1.0, // or normalized 0.0-1.0 Y coordinate\n'
            '  "key": "Enter" | "Escape" | "Tab" | "ArrowDown" | "Backspace", // key name for KEY action\n'
            '  "text": "text to type or paste",\n'
            '  "condition": "stream_settled" | "zip_downloaded" | "ui_idle", // for WAIT_ON\n'
            '  "target": "options" | "popup" | "gemini", // for SWITCH_PAGE\n'
            '  "delta_y": 300 // for SCROLL\n'
            "}"
        )

        user_content = [
            {
                "type": "text",
                "text": (
                    f"Current Instruction: \"{instruction}\"\n\n"
                    f"Recent Action History:\n"
                    f"{json.dumps(history[-3:] if history else [], ensure_ascii=False, indent=2)}"
                )
            },
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{b64_image}"
                }
            }
        ]

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1
        }

        req_headers = {
            "Content-Type": "application/json",
            **self.custom_headers
        }
        if self.api_key:
            req_headers["Authorization"] = f"Bearer {self.api_key}"

        try:
            req = urllib.request.Request(
                self.endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers=req_headers,
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))

            raw_text = ""
            # Support OpenAI chat completions structure
            if "choices" in result and result["choices"]:
                raw_text = result["choices"][0].get("message", {}).get("content", "")
            # Support generic / direct output structure
            elif "output" in result:
                raw_text = result["output"] if isinstance(result["output"], str) else json.dumps(result["output"])
            elif "candidates" in result and result["candidates"]:
                raw_text = result["candidates"][0].get("content", {}).get("parts", [{}])[0].get("text", "")
            elif isinstance(result, dict) and "action" in result:
                parsed = result
                raw_text = None

            if raw_text:
                parsed = json.loads(raw_text)

            action_str = parsed.get("action", "CLICK").upper()
            thought = parsed.get("thought", "")

            # Coordinate normalization
            norm_x, norm_y = None, None
            box = parsed.get("box_2d")
            if box and len(box) == 4:
                ymin, xmin, ymax, xmax = box
                norm_x = ((xmin + xmax) / 2.0) / 1000.0
                norm_y = ((ymin + ymax) / 2.0) / 1000.0
            elif "x" in parsed and "y" in parsed and parsed["x"] is not None and parsed["y"] is not None:
                raw_x = float(parsed["x"])
                raw_y = float(parsed["y"])
                norm_x = raw_x / 1000.0 if raw_x > 1.0 else raw_x
                norm_y = raw_y / 1000.0 if raw_y > 1.0 else raw_y

            if action_str == "CLICK":
                if norm_x is None or norm_y is None:
                    return VisualAction(
                        action_type=VisualActionType.FAIL,
                        thought=f"CLICK 缺少有效定位坐标，拒绝盲点击回退: {thought}",
                        details={"raw": parsed}
                    )
                return VisualAction(
                    action_type=VisualActionType.CLICK,
                    x=norm_x,
                    y=norm_y,
                    thought=thought,
                    details={"box_2d": box} if box else {}
                )
            elif action_str in ("TYPE", "PASTE"):
                act_type = VisualActionType.PASTE if action_str == "PASTE" else VisualActionType.TYPE
                return VisualAction(
                    action_type=act_type,
                    x=norm_x,
                    y=norm_y,
                    text=parsed.get("text", ""),
                    thought=thought
                )
            elif action_str == "CLEAR":
                return VisualAction(
                    action_type=VisualActionType.CLEAR,
                    x=norm_x,
                    y=norm_y,
                    thought=thought
                )
            elif action_str == "KEY":
                key = parsed.get("key") or parsed.get("text") or "Enter"
                return VisualAction(
                    action_type=VisualActionType.KEY,
                    key=key,
                    thought=thought
                )
            elif action_str == "SCROLL":
                return VisualAction(
                    action_type=VisualActionType.SCROLL,
                    thought=thought,
                    details={"delta_y": parsed.get("delta_y", 300)}
                )
            elif action_str == "WAIT_ON":
                cond = parsed.get("condition", "stream_settled")
                return VisualAction(
                    action_type=VisualActionType.WAIT_ON,
                    condition=cond,
                    timeout=parsed.get("timeout", 120),
                    thought=thought
                )
            elif action_str == "SWITCH_PAGE":
                return VisualAction(
                    action_type=VisualActionType.SWITCH_PAGE,
                    target=parsed.get("target", "options"),
                    chat_id=parsed.get("chat_id"),
                    thought=thought
                )
            elif action_str == "DONE":
                return VisualAction(action_type=VisualActionType.DONE, thought=thought)
            elif action_str == "WAIT":
                return VisualAction(action_type=VisualActionType.WAIT, thought=thought)

            return VisualAction(action_type=VisualActionType.FAIL, thought=f"无法识别动作: {action_str}")
        except Exception as e:
            return VisualAction(action_type=VisualActionType.FAIL, thought=f"自定义 AI 接口请求失败: {e}")

    def review_screenshots(self, screenshots: List[Dict[str, Any]]) -> str:
        """
        Multimodal visual UX/UI review for --ai-review.
        Sends key audit snapshots to custom multimodal AI to inspect layout, contrast, and alignment.
        """
        if not self.endpoint:
            return "⚠️ 未配置 CUSTOM_AI_ENDPOINT，跳过多模态模型在线视觉审查。"

        if not screenshots:
            return "ℹ️ 本次运行无捕获截屏，跳过视觉审查。"

        selected = screenshots[:4]
        user_content = [
            {
                "type": "text",
                "text": (
                    "You are a senior UI/UX visual QA inspector reviewing a web extension's screens.\n"
                    "Analyze the attached UI screenshots and provide a structured visual audit covering:\n"
                    "1. Layout Truncation & Text Overflow (Check if any buttons, badges, or labels are cut off)\n"
                    "2. Visual Occlusion & Collision (Check if popovers, modals, or banners collide with background elements)\n"
                    "3. Dialog & Modal Backdrop (Verify backdrop masks background interaction cleanly)\n"
                    "4. Overall Visual Polish & Recommendations (Rate 1-10 and note any UX risks)\n\n"
                    "Format your response in concise GitHub-flavored Markdown."
                )
            }
        ]

        for s in selected:
            path = s.get("path")
            if path and os.path.isfile(path):
                try:
                    with open(path, "rb") as f:
                        img_bytes = f.read()
                    b64 = base64.b64encode(img_bytes).decode("utf-8")
                    user_content.append({"type": "text", "text": f"Snapshot: {s.get('name', 'unnamed')}"})
                    user_content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})
                except Exception as ex:
                    print(f" [⚠️ 警告] 读取审查截屏失败: {path}: {ex}")

        payload = {
            "model": self.model,
            "messages": [
                {"role": "user", "content": user_content}
            ],
            "temperature": 0.2
        }

        req_headers = {
            "Content-Type": "application/json",
            **self.custom_headers
        }
        if self.api_key:
            req_headers["Authorization"] = f"Bearer {self.api_key}"

        try:
            req = urllib.request.Request(
                self.endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers=req_headers,
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))

            if "choices" in result and result["choices"]:
                return result["choices"][0].get("message", {}).get("content", "（模型未返回分析文本）")
            elif "output" in result:
                return str(result["output"])
            return "（模型响应中无候选内容）"
        except Exception as e:
            return f"❌ 视觉审查请求失败: {e}"
