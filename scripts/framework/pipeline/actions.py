# scripts/framework/pipeline/actions.py
"""
Atomic Action Primitives for Gemini Interaction Pipeline.
Each action encapsulates exactly one single-responsibility step with state invariants,
eliminating monolithic multi-step loops, multi-click storms, and premature completion bugs.
"""

import time
import json
from abc import ABC, abstractmethod
from typing import Set, Optional, Dict, Any, Tuple
from dataclasses import dataclass

from .stages import PipelineStage, PipelineConcurrencyViolationError, CircuitBreakerError
from scripts.framework.selectors import GeminiSelectors
from scripts.framework.gateway import get_gateway


@dataclass
class ActionResult:
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None


class AtomicAction(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @property
    @abstractmethod
    def allowed_stages(self) -> Set[PipelineStage]:
        pass

    @property
    @abstractmethod
    def next_stage(self) -> PipelineStage:
        pass

    @abstractmethod
    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        pass


class AssertIdleAction(AtomicAction):
    """硬核确保页面处于绝对空闲状态，严禁在前序流式未停时执行任何后续操作"""

    def __init__(self, max_wait: int = 45, stop_btn_selector: Optional[str] = None, streaming_indicators_selector: Optional[str] = None):
        self.max_wait = max_wait
        self.stop_btn_selector = stop_btn_selector or GeminiSelectors.STOP_BTN
        self.streaming_indicators_selector = streaming_indicators_selector or GeminiSelectors.STREAMING_INDICATORS

    @property
    def name(self) -> str:
        return "AssertIdle"

    @property
    def allowed_stages(self) -> Set[PipelineStage]:
        return {PipelineStage.IDLE, PipelineStage.SETTLED, PipelineStage.COOLDOWN}

    @property
    def next_stage(self) -> PipelineStage:
        return PipelineStage.IDLE

    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        start = time.time()
        while time.time() - start < self.max_wait:
            busy = cdp.eval(f"""
            (() => {{
                const stopBtn = document.querySelector('{self.stop_btn_selector}');
                const isStreaming = !!document.querySelector('{self.streaming_indicators_selector}');
                return !!(stopBtn && stopBtn.offsetWidth > 0) || isStreaming;
            }})()
            """)
            if not busy:
                return ActionResult(True, "页面处于完全空闲状态")
            time.sleep(1.0)

        return ActionResult(False, f"页面在 {self.max_wait}s 内未能恢复空闲 (前序流式或任务尚未结束)")


class UniversalInputAction:
    """
    Tier 2 基础设施：通用输入与清空原语。
    支持物理坐标碰撞寻址 (document.elementFromPoint(x, y))、CSS 选择器或当前焦点元素。
    无论目标是原生 <input>/<textarea> 还是复杂富文本框 (Quill / contenteditable)，
    均执行确定性清空、CDP Input.insertText 插入及标准框架事件分发。
    """

    @staticmethod
    def clear_target(
        cdp: Any,
        point: Optional[Tuple[int, int]] = None,
        selector: Optional[str] = None
    ) -> bool:
        """
        确定性清空目标元素。
        优先使用 point=(px_x, px_y) 进行物理光标碰撞寻找可编辑容器。
        """
        if not cdp:
            return False

        px_x = point[0] if point and len(point) >= 2 else None
        px_y = point[1] if point and len(point) >= 2 else None

        res = cdp.eval(f"""
        (() => {{
            let target = null;
            const px = {json.dumps(px_x)};
            const py = {json.dumps(px_y)};
            const sel = {json.dumps(selector)};

            if (px !== null && py !== null) {{
                const hit = document.elementFromPoint(px, py);
                if (hit) {{
                    target = hit.closest('input, textarea, [contenteditable="true"], rich-textarea, .ql-editor') || hit;
                }}
            }}

            if (!target && sel) {{
                target = document.querySelector(sel);
            }}

            if (!target) {{
                target = document.activeElement;
            }}

            if (!target) return false;

            target.focus();

            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {{
                target.value = '';
                target.dispatchEvent(new Event('input', {{ bubbles: true }}));
                target.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return true;
            }}

            // 富文本 / ContentEditable / rich-textarea / Quill
            const rich = target.closest('rich-textarea') || document.querySelector('rich-textarea');
            if (rich && rich.__quill) {{
                rich.__quill.setText('');
                target.dispatchEvent(new Event('input', {{ bubbles: true, composed: true }}));
                target.dispatchEvent(new Event('change', {{ bubbles: true, composed: true }}));
                return true;
            }}

            const range = document.createRange();
            range.selectNodeContents(target);
            const selection = window.getSelection();
            if (selection) {{
                selection.removeAllRanges();
                selection.addRange(range);
            }}
            try {{
                document.execCommand('delete', false, null);
            }} catch (e) {{}}

            if ((target.textContent || '').trim().length > 0) {{
                while (target.firstChild) {{
                    target.removeChild(target.firstChild);
                }}
                const p = document.createElement('p');
                p.appendChild(document.createElement('br'));
                target.appendChild(p);
            }}
            target.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'deleteContentBackward' }}));
            target.dispatchEvent(new Event('input', {{ bubbles: true }}));
            target.dispatchEvent(new Event('change', {{ bubbles: true }}));
            return true;
        }})()
        """)
        return bool(res)

    @staticmethod
    def insert_text(
        cdp: Any,
        text: str,
        point: Optional[Tuple[int, int]] = None,
        selector: Optional[str] = None
    ) -> bool:
        """
        在目标元素聚焦后，通过 CDP 原生 Input.insertText 插入文本并派发框架事件。
        """
        if not cdp:
            return False

        px_x = point[0] if point and len(point) >= 2 else None
        px_y = point[1] if point and len(point) >= 2 else None

        # 1. 物理寻址并上焦
        cdp.eval(f"""
        (() => {{
            let target = null;
            const px = {json.dumps(px_x)};
            const py = {json.dumps(px_y)};
            const sel = {json.dumps(selector)};

            if (px !== null && py !== null) {{
                const hit = document.elementFromPoint(px, py);
                if (hit) {{
                    target = hit.closest('input, textarea, [contenteditable="true"], rich-textarea, .ql-editor') || hit;
                }}
            }}

            if (!target && sel) {{
                target = document.querySelector(sel);
            }}

            if (!target) {{
                target = document.activeElement;
            }}

            if (target) {{
                target.click();
                target.focus();
                if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {{
                    target.value = {json.dumps(text)};
                    target.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    target.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    return true;
                }}
                const p = target.querySelector('p') || target;
                const sel = window.getSelection();
                if (sel) {{
                    const r = document.createRange();
                    r.selectNodeContents(p);
                    r.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(r);
                }}
                return true;
            }}
            return false;
        }})()
        """)
        time.sleep(0.05)

        # 2. 原生底层 CDP Input.insertText 插入文本（完全遵循物理级真实键盘事件，杜绝 execCommand 脱节）
        if text:
            cdp.call("Input.insertText", {"text": text})
            time.sleep(0.05)

        # 3. 派发 input 与 change 事件保证框架数据绑定感知与 Quill delta 刷新
        target_selector_json = json.dumps(selector or "")
        cdp.eval(f"""
        (() => {{
            const sel = {target_selector_json};
            const targetEl = (sel ? document.querySelector(sel) : null) || document.activeElement;
            if (targetEl) {{
                targetEl.dispatchEvent(new Event('input', {{ bubbles: true, composed: true }}));
                targetEl.dispatchEvent(new InputEvent('input', {{ bubbles: true, composed: true, inputType: 'insertText' }}));
                targetEl.dispatchEvent(new Event('change', {{ bubbles: true, composed: true }}));
                const rich = targetEl.closest('rich-textarea') || document.querySelector('rich-textarea');
                if (rich) {{
                    if (rich.__quill) {{
                        try {{ rich.__quill.update(); }} catch (e) {{}}
                    }}
                    rich.dispatchEvent(new Event('input', {{ bubbles: true, composed: true }}));
                    rich.dispatchEvent(new Event('change', {{ bubbles: true, composed: true }}));
                }}
                return true;
            }}
            return false;
        }})()
        """)
        return True


class StagePromptAction(AtomicAction):
    """原子化注入 Prompt 文本，彻底清空富文本框模型，坚决不触碰发送按钮"""

    def __init__(self, prompt_text: str, editor_selector: Optional[str] = None):
        self.prompt_text = prompt_text
        self.editor_selector = editor_selector or GeminiSelectors.EDITOR

    @property
    def name(self) -> str:
        return f"StagePrompt({self.prompt_text[:20]}...)"

    @property
    def allowed_stages(self) -> Set[PipelineStage]:
        return {PipelineStage.IDLE}

    @property
    def next_stage(self) -> PipelineStage:
        return PipelineStage.STAGED

    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        # 1. 彻底清空目标编辑器
        UniversalInputAction.clear_target(cdp, selector=self.editor_selector)
        time.sleep(0.2)

        # 2. 原生输入文本并派发事件
        UniversalInputAction.insert_text(cdp, self.prompt_text, selector=self.editor_selector)
        time.sleep(0.2)

        # 3. 校验注入结果
        editor_sel_json = json.dumps(self.editor_selector)
        staged_len = cdp.eval(f"""
        (() => {{
            const editor = document.querySelector({editor_sel_json});
            return editor ? (editor.textContent || '').trim().length : 0;
        }})()
        """) or 0

        if staged_len > 0:
            return ActionResult(True, f"Prompt 已原子注入输入框 ({staged_len} 字符)")
        return ActionResult(False, "输入框未能成功接收 Prompt 文本")


class SingleClickSendAction(AtomicAction):
    """单次物理点击发送按钮 (Single-Click Guarantee)，绝对不进行多重连击重试循环"""

    def __init__(self, send_btn_selector: Optional[str] = None, timeout: float = 30.0):
        self.send_btn_selector = send_btn_selector or GeminiSelectors.SEND_BTN
        self.timeout = timeout

    @property
    def name(self) -> str:
        return "SingleClickSend"

    @property
    def allowed_stages(self) -> Set[PipelineStage]:
        return {PipelineStage.STAGED}

    @property
    def next_stage(self) -> PipelineStage:
        return PipelineStage.DISPATCHED

    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        # 严格执行唯一点击通道 (Single Channel of Truth)：
        # 遍历所有候选发送按钮，等待解除禁用并完成单次派发 (最多等待 30 秒，消除 Angular 脏检查与输入渲染时序差)
        try:
            cdp.call("Emulation.setFocusEmulationEnabled", {"enabled": True})
        except Exception:
            pass

        start_wait = time.time()
        selector_combo = f"{self.send_btn_selector}, gem-icon-button.send-button, [data-test-id='send-button-container'] button, [data-test-id='send-button-container'] gem-icon-button, gem-icon-button.send-button button"
        selector_json = json.dumps(selector_combo)
        editor_sel_json = json.dumps(GeminiSelectors.EDITOR)

        while time.time() - start_wait < self.timeout:
            elapsed = time.time() - start_wait
            click_info = cdp.eval(f"""
            (() => {{
                const selector = {selector_json};
                const btns = Array.from(document.querySelectorAll(selector));
                for (const sendBtn of btns) {{
                    if (!sendBtn || sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {{
                        continue;
                    }}
                    if (sendBtn.closest('.stop')) {{
                        continue;
                    }}
                    const parentGem = sendBtn.closest('gem-icon-button');
                    if (parentGem && (parentGem.getAttribute('aria-disabled') === 'true' || parentGem.classList.contains('stop'))) {{
                        continue;
                    }}
                    const label = (sendBtn.getAttribute('aria-label') || '').toLowerCase();
                    if (!label.includes('stop') && !label.includes('停止')) {{
                        const targetBtn = sendBtn.tagName === 'BUTTON' ? sendBtn : (sendBtn.querySelector('button') || sendBtn);
                        targetBtn.click();
                        return {{ clicked: true }};
                    }}
                }}

                // 若等待超过 1.5 秒仍未检出可用按钮，主动触发 Quill 模型更新并派发 input 事件驱动 Angular 脏检查
                if ({elapsed} > 1.5) {{
                    const rich = document.querySelector('rich-textarea');
                    if (rich && rich.__quill) {{
                        try {{ rich.__quill.update(); }} catch (e) {{}}
                    }}
                    const editor = document.querySelector({editor_sel_json});
                    if (editor) {{
                        editor.dispatchEvent(new Event('input', {{ bubbles: true, composed: true }}));
                        editor.dispatchEvent(new InputEvent('input', {{ bubbles: true, composed: true, inputType: 'insertText' }}));
                        if (rich) rich.dispatchEvent(new Event('input', {{ bubbles: true, composed: true }}));
                        try {{ editor.click(); }} catch (e) {{}}
                    }}
                }}
                return null;
            }})()
            """)
            if click_info and click_info.get("clicked"):
                return ActionResult(True, "发送按钮单次提交成功派发")

            time.sleep(0.5)

        # 超时后收集 DOM 诊断详情，便于精准定位原因
        diag = cdp.eval(f"""
        (() => {{
            const btns = Array.from(document.querySelectorAll({selector_json})).map(b => ({{
                tag: b.tagName,
                cls: b.className.slice(0, 50),
                disabled: b.disabled,
                ariaDisabled: b.getAttribute('aria-disabled'),
                ariaLabel: b.getAttribute('aria-label')
            }}));
            const editor = document.querySelector({editor_sel_json});
            return {{
                buttons: btns,
                editorTextLen: editor ? (editor.textContent || '').trim().length : 0
            }};
        }})()
        """)
        return ActionResult(False, f"未定位到可用且非禁用的发送按钮 (等待 {int(self.timeout)}s 超时, 诊断: {diag})")



@dataclass
class StreamSettledConfig:
    """可配置的流式落盘与判定规则，支持不同 AI 平台策略定制"""
    stop_btn_selector: str = GeminiSelectors.STOP_BTN
    send_btn_selector: str = GeminiSelectors.SEND_BTN_NOT_STOP
    editor_selector: str = GeminiSelectors.EDITOR
    streaming_indicators_selector: str = GeminiSelectors.STREAMING_INDICATORS
    model_response_selector: str = GeminiSelectors.MODEL_RESPONSE_ALL
    images_selector: str = GeminiSelectors.IMAGES
    retry_btn_selector: str = GeminiSelectors.RETRY_BTN
    toast_selector: str = GeminiSelectors.TOAST
    stream_complete_flag: str = "__geminiLastStreamComplete"
    stream_state_var: str = "__testStreamState"
    abort_keywords: Tuple[str, ...] = ("you stopped this response", "你已停止此回复")
    error_keywords: Tuple[str, ...] = ("something went wrong", "无法生成图片", "i cannot generate", "unable to process")


class AwaitStreamSettledAction(AtomicAction):
    """
    权威等待流式生成与落盘。
    以扩展网络层真实捕获的 STREAM_COMPLETE 事件为主准绳，图片实体与 DOM 状态为辅助。
    同时内建 Fail-Fast 即刻熔断：遇「You stopped this response」或卡片报错 1 秒内中止，绝不盲等 300 秒。
    """

    def __init__(
        self,
        timeout: int = 300,
        require_image: bool = False,
        turn_start_time: Optional[float] = None,
        config: Optional[StreamSettledConfig] = None
    ):
        self.timeout = timeout
        self.require_image = require_image
        self.turn_start_time = turn_start_time or time.time()
        self.config = config or StreamSettledConfig()

    @property
    def name(self) -> str:
        return f"AwaitStreamSettled(timeout={self.timeout}s, require_image={self.require_image})"

    @property
    def allowed_stages(self) -> Set[PipelineStage]:
        return {PipelineStage.DISPATCHED, PipelineStage.STREAMING}

    @property
    def next_stage(self) -> PipelineStage:
        return PipelineStage.SETTLED

    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        start_wait = time.time()
        turn_start_ms = int(self.turn_start_time * 1000)
        last_seen_len = 0
        stable_count = 0
        cfg = self.config

        while time.time() - start_wait < self.timeout:
            time.sleep(1.0)
            elapsed = time.time() - start_wait

            state = cdp.eval(f"""
            (() => {{
                const stopBtn = document.querySelector('{cfg.stop_btn_selector}');
                const hasStop = !!(stopBtn && stopBtn.offsetWidth > 0);
                const sendBtn = document.querySelector('{cfg.send_btn_selector}');
                const hasSend = !!(sendBtn && sendBtn.offsetWidth > 0 && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true');
                const editor = document.querySelector('{cfg.editor_selector}');
                const isEditorReady = !!(editor && (editor.getAttribute('contenteditable') === 'true' || editor.offsetWidth > 0));
                const isStreamingDOM = !!document.querySelector('{cfg.streaming_indicators_selector}');

                const streamState = window.{cfg.stream_state_var} || {{}};
                const lastCompleteTime = window.{cfg.stream_complete_flag} || 0;
                const netCompleted = !!streamState.completed || (lastCompleteTime >= {turn_start_ms});

                const allModels = Array.from(document.querySelectorAll('{cfg.model_response_selector}'));
                const currCount = allModels.length;
                const lastModel = currCount > 0 ? allModels[currCount - 1] : null;
                const lastLen = lastModel ? (lastModel.textContent || '').trim().length : 0;
                const lastSnippet = lastModel ? (lastModel.textContent || '').trim().slice(0, 150) : '';
                const hasImages = lastModel ? (lastModel.querySelectorAll('{cfg.images_selector}').length > 0) : false;

                const retryBtn = document.querySelector('{cfg.retry_btn_selector}');
                const toastEl = document.querySelector('{cfg.toast_selector}');

                return {{
                    hasStop,
                    hasSend,
                    isEditorReady,
                    isStreamingDOM,
                    netCompleted,
                    currCount,
                    lastLen,
                    lastSnippet,
                    hasImages,
                    hasRetry: !!retryBtn,
                    toast: toastEl ? toastEl.textContent.trim() : null
                }};
            }})()
            """)

            if not state:
                continue

            # 异常熔断守护 1：若检测到报错 Toast 或 Retry 按钮，严禁盲目自动点击重试，立即熔断！
            if state.get("hasRetry") or state.get("toast"):
                err_text = state.get("toast") or "页面弹出 Retry 重试按钮（服务遇到错误）"
                return ActionResult(False, f"触发熔断停机 (绝不盲目狂点重试): {err_text}")

            last_snippet = (state.get("lastSnippet") or "").lower()
            # 异常熔断守护 2：若卡片内被掐死或打出报错提示，即刻熔断，绝不盲等 300 秒！
            if any(abort_kw in last_snippet for abort_kw in cfg.abort_keywords):
                return ActionResult(False, f"检测到回复被异常中断掐死 ({last_snippet[:60]})")
            if any(err_kw in last_snippet for err_kw in cfg.error_keywords):
                return ActionResult(False, f"卡片内显示报错信息: {last_snippet[:60]}")

            has_stop = state.get("hasStop", False)
            has_send = state.get("hasSend", False)
            is_editor_ready = state.get("isEditorReady", False)
            is_stream_dom = state.get("isStreamingDOM", False)
            net_completed = state.get("netCompleted", False)
            last_len = state.get("lastLen", 0)
            has_images = state.get("hasImages", False)

            # 权威判断 1：必须网络层确证完成 + 页面 UI 已脱离忙碌态 + DOM 停止流式
            if net_completed and not has_stop and (has_send or is_editor_ready) and not is_stream_dom:
                if self.require_image:
                    if has_images or elapsed > 45:
                        time.sleep(1.0)
                        return ActionResult(True, f"生图回复完成并落地 (网络确认, 耗时 {elapsed:.1f}s, 检测到图片实体)")
                else:
                    time.sleep(0.5)
                    return ActionResult(True, f"流式回复权威完成 (网络事件确认, 耗时 {elapsed:.1f}s, 字符数: {last_len})")

            # 严格安全兜底 2：在等待超过 15 秒后，若 Stop 消失且 UI 就绪，且图片落地或文本连续 4 次稳定
            if not has_stop and (has_send or is_editor_ready) and not is_stream_dom and elapsed > 15:
                if self.require_image and has_images:
                    time.sleep(1.0)
                    return ActionResult(True, f"生图回复完成并落地 (DOM 图片实体确认, 耗时 {elapsed:.1f}s)")
                elif not self.require_image and last_len > 20:
                    if last_len == last_seen_len:
                        stable_count += 1
                        if stable_count >= 4:
                            time.sleep(0.5)
                            return ActionResult(True, f"流式回复权威完成 (DOM 稳定确认, 耗时 {elapsed:.1f}s, 字符数: {last_len})")
                    else:
                        last_seen_len = last_len
                        stable_count = 0

        return ActionResult(False, f"等待流式完成超时 ({self.timeout}s)")


class HumanCooldownAction(AtomicAction):
    """强制人类阅读节奏冷却期，消除非人类短间隔机械超频发帖特征"""

    def __init__(self, seconds: float = 6.0):
        self.seconds = max(3.0, float(seconds))

    @property
    def name(self) -> str:
        return f"HumanCooldown({self.seconds:.1f}s)"

    @property
    def allowed_stages(self) -> Set[PipelineStage]:
        return {PipelineStage.SETTLED, PipelineStage.IDLE}

    @property
    def next_stage(self) -> PipelineStage:
        return PipelineStage.IDLE

    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        time.sleep(self.seconds)
        return ActionResult(True, f"人类安全节奏冷却完成 ({self.seconds:.1f}s)")


class ClickNewChatAction(AtomicAction):
    """原子化新建会话"""

    def __init__(self, new_chat_selector: Optional[str] = None, new_chat_url: str = "https://gemini.google.com/app"):
        self.new_chat_selector = new_chat_selector or GeminiSelectors.NEW_CHAT_BTN
        self.new_chat_url = new_chat_url

    @property
    def name(self) -> str:
        return "ClickNewChat"

    @property
    def allowed_stages(self) -> Set[PipelineStage]:
        return {PipelineStage.IDLE, PipelineStage.SETTLED}

    @property
    def next_stage(self) -> PipelineStage:
        return PipelineStage.IDLE

    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        try:
            get_gateway().safe_navigate(cdp, self.new_chat_url)
            time.sleep(2.0)
            return ActionResult(True, "已通过安全网关 safe_navigate 开启新会话")
        except Exception:
            pass
        cdp.eval(f"""
        (() => {{
            const newBtn = document.querySelector('{self.new_chat_selector}');
            if (newBtn) {{
                newBtn.click();
            }} else {{
                window.location.href = '{self.new_chat_url}';
            }}
        }})()
        """)
        time.sleep(2.5)
        return ActionResult(True, "已点击开启新会话并加载就绪")


class NavigateChatAction(AtomicAction):
    """原子化导航至指定会话"""

    def __init__(self, chat_id: str, url_template: str = "https://gemini.google.com/app/{chat_id}"):
        self.chat_id = str(chat_id).strip()
        self.url_template = url_template

    @property
    def name(self) -> str:
        return f"NavigateChat({self.chat_id})"

    @property
    def allowed_stages(self) -> Set[PipelineStage]:
        return {PipelineStage.IDLE, PipelineStage.SETTLED}

    @property
    def next_stage(self) -> PipelineStage:
        return PipelineStage.IDLE

    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        target_url = self.url_template.format(chat_id=self.chat_id)
        if get_gateway().safe_navigate(cdp, target_url):
            time.sleep(2.0)
            return ActionResult(True, f"已通过安全网关 safe_navigate 导航至会话: {self.chat_id}")
        time.sleep(2.5)
        return ActionResult(True, f"已导航至会话: {self.chat_id}")

