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
            try:
                busy = cdp.eval(f"""
                (() => {{
                    const stopBtn = document.querySelector('{self.stop_btn_selector}');
                    const isStreaming = !!document.querySelector('{self.streaming_indicators_selector}');
                    const workbenchBusy = document.body?.dataset.busy === 'true';
                    return workbenchBusy || !!(stopBtn && stopBtn.offsetWidth > 0) || isStreaming;
                }})()
                """)
            except (TimeoutError, OSError):
                busy = True
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
        UniversalInputAction.clear_target(cdp, selector=self.editor_selector)
        time.sleep(0.2)

        UniversalInputAction.insert_text(cdp, self.prompt_text, selector=self.editor_selector)
        time.sleep(0.2)

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
                        const replies = [...document.querySelectorAll('model-response')];
                        window.__tier2ReplyCountBeforeSend = replies.length;
                        window.__tier2RepliesBeforeSend = {{
                            ids: new Set(replies.map(el => el.closest('.conversation-container[id]')?.id).filter(Boolean)),
                            nodes: new WeakSet(replies)
                        }};
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
    """Selectors for observing a new reply, independent of expected content or extension events."""
    stop_btn_selector: str = GeminiSelectors.STOP_BTN
    editor_selector: str = GeminiSelectors.EDITOR
    streaming_indicators_selector: str = GeminiSelectors.STREAMING_INDICATORS
    model_response_selector: str = GeminiSelectors.MODEL_RESPONSE
    model_response_body_selector: str = GeminiSelectors.MODEL_RESPONSE_BODY
    retry_btn_selector: str = GeminiSelectors.RETRY_BTN
    toast_selector: str = GeminiSelectors.TOAST


class AwaitStreamSettledAction(AtomicAction):
    """Wait for a new, idle, stable reply. Validate its contents on exported files."""

    def __init__(self, timeout: int = 300, config: Optional[StreamSettledConfig] = None):
        self.timeout = timeout
        self.config = config or StreamSettledConfig()

    @property
    def name(self) -> str:
        return f"AwaitStreamSettled(timeout={self.timeout}s)"

    @property
    def allowed_stages(self) -> Set[PipelineStage]:
        return {PipelineStage.DISPATCHED, PipelineStage.STREAMING}

    @property
    def next_stage(self) -> PipelineStage:
        return PipelineStage.SETTLED

    def execute(self, ctx: Any, cdp: Any) -> ActionResult:
        deadline = time.monotonic() + self.timeout
        previous, stable = None, 0
        last_state, last_error = {}, None
        retried_response = False
        retry_started, failed_content = False, None
        cfg = self.config
        while time.monotonic() < deadline:
            try:
                state = cdp.eval(f"""
                (() => {{
                    const stop = document.querySelector('{cfg.stop_btn_selector}');
                    const editor = document.querySelector('{cfg.editor_selector}');
                    const models = [...document.querySelectorAll('{cfg.model_response_selector}')];
                    const last = models.at(-1);
                    const originalBody = last?.querySelector('{cfg.model_response_body_selector}');
                    const body = originalBody?.cloneNode(true);
                    body?.querySelectorAll('follow-up, elicitations, elicitations-group, .elicitations-container, [hide-from-message-actions], mini-app, thought-container, thought-box, .thought-container, .thought-wrapper, .model-thought, [data-thought]').forEach(el => el.remove());
                    body?.querySelectorAll('button').forEach(el => {{ if (!el.querySelector('img')) el.remove(); }});
                    const content = body?.innerHTML || '';
                    const replyId = last?.closest('.conversation-container[id]')?.id || null;
                    const before = window.__tier2RepliesBeforeSend;
                    return {{
                        // Gemini virtualizes old turns: the sixth reply can replace
                        // the first while the mounted response count stays at five.
                        // Stable turn IDs also reject a re-render of the old answer.
                        newReply: !!last && (before
                            ? replyId ? !before.ids.has(replyId) : !before.nodes.has(last)
                            : models.length > (window.__tier2ReplyCountBeforeSend ?? 0)),
                        replyId,
                        modelCount: models.length,
                        beforeSendCount: window.__tier2ReplyCountBeforeSend ?? 0,
                        busy: !!(stop && stop.offsetWidth > 0) || !!document.querySelector('{cfg.streaming_indicators_selector}'),
                        editorReady: !!editor && !(editor.textContent || '').trim(),
                        hasContent: !!body?.textContent.trim() || !!body?.querySelector('img, video, audio'),
                        content,
                        error: /^(www\\.)?google\\.com$/.test(location.hostname) && location.pathname.startsWith('/sorry')
                            ? 'Google human verification required; complete verification in the test browser'
                            : document.querySelector('{cfg.retry_btn_selector}') ? 'Page shows a retry control'
                            : document.querySelector('{cfg.toast_selector}')?.textContent.trim() || null
                    }};
                }})()
                """) or {}
            except (TimeoutError, OSError) as error:
                last_error = str(error)
                previous, stable = None, 0
                time.sleep(1.0)
                continue
            last_state = {key: value for key, value in state.items() if key != 'content'}
            last_state['contentLength'] = len(state.get('content') or '')
            if state.get('error'):
                if (state['error'] == 'Page shows a retry control' and not retried_response
                        and state.get('newReply') and state.get('replyId')):
                    # Retry only the provider's failed current response, never
                    # resubmit a prompt or act on an older turn's retry button.
                    clicked = cdp.eval(f"""
                    (() => {{
                        const last = [...document.querySelectorAll('{cfg.model_response_selector}')].at(-1);
                        if (last?.closest('.conversation-container[id]')?.id !== {json.dumps(state['replyId'])}) return false;
                        const retry = last.querySelector('{cfg.retry_btn_selector}');
                        if (!retry || !retry.getClientRects().length || retry.disabled || retry.getAttribute('aria-disabled') === 'true') return false;
                        retry.click();
                        return true;
                    }})()
                    """)
                    if clicked is True:
                        print('         ↻ Gemini current response failed; clicked its Retry once without resubmitting the prompt')
                        retried_response = True
                        failed_content = state.get('content')
                        previous, stable = None, 0
                        time.sleep(1.0)
                        continue
                return ActionResult(False, state['error'])
            if retried_response and (state.get('busy') or state.get('content') != failed_content):
                retry_started = True
            # Gemini can retain the restored failed prompt as an unsent draft
            # after Retry. Reply identity and a fresh retry transition supply
            # completion evidence without treating that draft as a new send.
            ready = (state.get('newReply') and not state.get('busy')
                     and (state.get('editorReady') or retried_response)
                     and (not retried_response or retry_started) and state.get('hasContent'))
            if ready:
                snapshot = (state.get('replyId'), state.get('content'))
                stable = stable + 1 if snapshot == previous else 1
                previous = snapshot
                if stable >= 4:
                    return ActionResult(True, "New reply is idle and stable; exported artifacts supply content acceptance")
            else:
                previous, stable = None, 0
            time.sleep(1.0)
        diagnostics = {**last_state, "stableSamples": stable, "retriedResponse": retried_response}
        if last_error:
            diagnostics["lastObservationError"] = last_error
        return ActionResult(False, f"Reply did not become idle and stable within {self.timeout}s; "
                            f"last observation: {json.dumps(diagnostics, ensure_ascii=False)}", diagnostics)


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

