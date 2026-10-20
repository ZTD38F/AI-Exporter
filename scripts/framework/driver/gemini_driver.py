# scripts/framework/driver/gemini_driver.py
"""
High-Level Gemini Automation Driver and Chat Session Abstractions.
Encapsulates all low-level CDP interactions, DOM selectors, atomic pipelines,
session lifecycle transitions, and turn evaluations into clean, declarative APIs.
"""

import os
import time
import base64
import mimetypes
from typing import Optional, Dict, Any, List, Union, Callable, Tuple

from scripts.framework.actions import CDPActions
from scripts.framework.selectors import GeminiSelectors
from scripts.framework.gateway import get_gateway
from .platform_driver import ChatPlatformDriver, TurnResult, PlatformCapabilities, PlatformRegistry


class GeminiChatSession:
    """
    High-level abstraction for an active or opened Gemini conversation.
    Tracks conversation turns, identity, and lifecycle operations.
    """

    def __init__(self, driver: "GeminiPlatformDriver", chat_id: Optional[str] = None, title: Optional[str] = None):
        self.driver = driver
        self.chat_id = chat_id
        self.title = title
        self.turns: List[TurnResult] = []

    def send_turn(
        self,
        prompt: Union[str, Dict[str, Any]],
        max_wait: int = 300,
        file_attachment: Optional[str] = None
    ) -> TurnResult:
        """
        Send a conversational prompt to this session, waiting deterministically for stream settlement.
        Extracts the generated response, checks for images, and updates session state.
        Supports uploading and mounting a local file attachment before submitting the turn.
        """
        t0 = time.time()
        if isinstance(prompt, dict):
            prompt_text = prompt.get("prompt", "")
            file_attachment = prompt.get("file_attachment") or file_attachment
        else:
            prompt_text = str(prompt)

        # 若指定了待上传文件，在发帖前先将其注入输入框并等待卡片挂载
        if file_attachment:
            print(f"      📎 正在向输入框上传并挂载文件附件: {os.path.basename(file_attachment)}...")
            self.driver.upload_file(file_attachment)
            time.sleep(1.0)

        p_lower = prompt_text.lower()
        is_image_turn = (
            ("生成" in prompt_text and "图" in prompt_text) or
            any(kw in p_lower for kw in ["画", "生图", "图片", "image", "draw", "imagen", "photo", "picture", "illustration"])
        )
        wait_timeout = max(max_wait, 240) if is_image_turn else max_wait

        # 通过 Driver 单飞原子流水线发帖 (受网关速率控制与主动熔断保护)
        ok, msg = self.driver.execute_turn_pipeline(prompt_text, max_wait=wait_timeout, is_image=is_image_turn)
        duration = time.time() - t0

        if not ok:
            err_res = TurnResult(
                success=False,
                prompt=prompt_text,
                duration=duration,
                error=msg,
                chat_id=self.chat_id
            )
            self.turns.append(err_res)
            return err_res

        # 刷新/补全会话 ID
        curr_id = self.driver.get_current_chat_id()
        if curr_id:
            self.chat_id = curr_id

        # 通过 Driver 提取最新回复文本与生图实体
        turn_res = self.driver.extract_turn_result(prompt_text, duration=duration, is_image=is_image_turn)
        turn_res.chat_id = self.chat_id
        self.turns.append(turn_res)
        return turn_res

    def delete_via_web(self, timeout: float = 15.0) -> bool:
        """在侧边栏触发网页原生删除流程"""
        chat_id = self.chat_id or self.driver.get_current_chat_id()
        if not chat_id:
            return False
        return self.driver.delete_chat_via_web(chat_id, timeout=timeout)

    def get_title(self) -> str:
        """获取当前会话权威标题"""
        t = self.driver.get_current_chat_title()
        if t:
            self.title = t
        return self.title or ""


class GeminiPlatformDriver(ChatPlatformDriver):
    """
    High-Level Automation Driver for Google Gemini.
    Implements ChatPlatformDriver contract for Gemini Web UI.
    Manages session lifecycle, model validation, and route switching.
    """

    def __init__(self, cdp: Any):
        super().__init__(cdp)
        self.active_session: Optional[GeminiChatSession] = None

    @property
    def platform_id(self) -> str:
        return "gemini"

    @property
    def capabilities(self) -> PlatformCapabilities:
        return PlatformCapabilities(
            platform_name="Google Gemini",
            supports_model_selection=True,
            supports_thinking_mode=True,
            supports_image_generation=True,
            supports_sidebar_deletion=True,
            supports_stream_events=True,
            base_url="https://gemini.google.com"
        )

    def ensure_ready(self, timeout: float = 20.0) -> bool:
        """等待 Gemini 页面核心输入框与 DOM 挂载就绪"""
        return CDPActions.wait_for_gemini_ready(self.cdp, max_wait=int(timeout))

    def ensure_model(self, target_model: str = "3.8 Flash", target_thinking: bool = True, force_menu_check: bool = False, **kwargs) -> bool:
        """
        严格校验并锁定 Gemini 模型与思考模式。
        如果 target_model="3.8 Flash"，严格检查菜单中是否存在 3.8 Flash 选项。
        如果 target_thinking=True，严格检查菜单中是否存在 Extended thinking (深度思考) 选项。
        若任一能力在当前账号/界面中不存在，立即主动抛出致命异常中断测试，绝不隐式降级或盲跑。
        """
        cdp = self.cdp
        # 1. 首先缓冲等待模型切换按钮挂载就绪并包含文本（最多等待 15 秒，避免 SPA 路由切换瞬间 DOM 未就绪）
        wait_btn_start = time.time()
        while time.time() - wait_btn_start < 15.0:
            btn_info = cdp.eval(f"""
            (() => {{
                const btn = document.querySelector('{GeminiSelectors.MODE_MENU_BTN}');
                if (!btn) return null;
                const text = (btn.textContent || '').trim();
                const label = (btn.getAttribute('aria-label') || '').trim();
                if (text || label) {{
                    return {{ text, label, disabled: !!btn.disabled }};
                }}
                return null;
            }})()
            """)
            if btn_info:
                break
            time.sleep(0.5)

        for pass_idx in range(5):
            status = cdp.eval(f"""
            (() => {{
                const btn = document.querySelector('{GeminiSelectors.MODE_MENU_BTN}');
                if (!btn) return null;
                const text = (btn.textContent || '').trim();
                const label = (btn.getAttribute('aria-label') || '').trim();
                return {{ text, label, disabled: !!btn.disabled }};
            }})()
            """)
            if not status:
                time.sleep(0.5)
                continue

            full_desc = f"{status.get('label', '')} {status.get('text', '')}".lower()
            is_lite = "flash-lite" in full_desc or "lite" in full_desc
            has_model = ("flash" in full_desc and not is_lite) if "flash" in target_model.lower() else (target_model.lower() in full_desc)
            has_thinking = ("extended" in full_desc or "thinking" in full_desc) if target_thinking else True

            if has_model and has_thinking and not force_menu_check:
                return True

            opened = cdp.eval(f"""
            (() => {{
                const btn = document.querySelector('{GeminiSelectors.MODE_MENU_BTN}');
                if (btn && !btn.disabled) {{
                    btn.click();
                    return true;
                }}
                return false;
            }})()
            """)
            if not opened:
                time.sleep(0.5)
                continue

            time.sleep(0.5)

            menu_info = cdp.eval(f"""
            (() => {{
                const menu = document.querySelector('{GeminiSelectors.MODE_MENU}');
                if (!menu) return null;
                const items = Array.from(menu.querySelectorAll('{GeminiSelectors.MODE_MENU_ITEM}'));
                return items.map(el => ({{
                    text: (el.textContent || '').trim().replace(/\\s+/g, ' '),
                    isSelected: el.classList.contains('selected') || el.getAttribute('aria-checked') === 'true'
                }}));
            }})()
            """)

            if not menu_info:
                cdp.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
                cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
                raise RuntimeError("❌【测试安全门禁拦截】无法打开 Gemini 模型切换菜单，测试已主动终止！")

            if "3.8" in target_model.lower() and "flash" in target_model.lower():
                has_target_model_opt = any(
                    ("3.8" in it["text"].lower() and "flash" in it["text"].lower() and "lite" not in it["text"].lower())
                    for it in menu_info
                )
                target_model_label = "3.8 Flash"
            elif "flash" in target_model.lower():
                has_target_model_opt = any(
                    ("flash" in it["text"].lower() and "lite" not in it["text"].lower())
                    for it in menu_info
                )
                target_model_label = "Flash"
            else:
                has_target_model_opt = any(target_model.lower() in it["text"].lower() for it in menu_info)
                target_model_label = target_model

            has_thinking_opt = any(
                ("extended" in it["text"].lower() and "thinking" in it["text"].lower())
                for it in menu_info
            )

            missing = []
            if not has_target_model_opt:
                missing.append(f"{target_model_label} 模型选项")
            if target_thinking and not has_thinking_opt:
                missing.append("Extended thinking (深度思考) 选项")

            if missing:
                cdp.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
                cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
                avail = [it["text"] for it in menu_info]
                err_msg = f"❌【测试安全门禁拦截】当前 Gemini 页面中缺失必要能力: {' 和 '.join(missing)}！当前可用菜单项: {avail}。测试已被强制熔断终止，杜绝盲跑或使用非预期模型。"
                print(f"\n🛑 {err_msg}\n")
                raise RuntimeError(err_msg)

            is_flash_selected = any(
                ("3.8" in it["text"].lower() and "flash" in it["text"].lower() and "lite" not in it["text"].lower() and it["isSelected"])
                for it in menu_info
            )
            is_thinking_selected = any(
                ("extended" in it["text"].lower() and "thinking" in it["text"].lower() and it["isSelected"])
                for it in menu_info
            )

            if is_flash_selected and is_thinking_selected:
                cdp.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
                cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
                time.sleep(0.3)
                return True

            if not is_flash_selected:
                cdp.eval(f"""
                (() => {{
                    const menu = document.querySelector('{GeminiSelectors.MODE_MENU}');
                    if (!menu) return;
                    const items = Array.from(menu.querySelectorAll('{GeminiSelectors.MODE_MENU_ITEM}'));
                    for (const el of items) {{
                        const t = (el.textContent || '').trim().toLowerCase();
                        if (t.includes('3.8 flash') || (t.includes('3.8') && t.includes('flash'))) {{
                            el.click();
                            return;
                        }}
                    }}
                }})()
                """)
                time.sleep(0.5)

            if not is_thinking_selected:
                still_open = cdp.eval(f"!!document.querySelector('{GeminiSelectors.MODE_MENU}')")
                if not still_open:
                    cdp.eval(f"""
                    (() => {{
                        const btn = document.querySelector('{GeminiSelectors.MODE_MENU_BTN}');
                        if (btn) btn.click();
                    }})()
                    """)
                    time.sleep(0.5)

                cdp.eval(f"""
                (() => {{
                    const menu = document.querySelector('{GeminiSelectors.MODE_MENU}');
                    if (!menu) return;
                    const items = Array.from(menu.querySelectorAll('{GeminiSelectors.MODE_MENU_ITEM}'));
                    for (const el of items) {{
                        const t = (el.textContent || '').trim().toLowerCase();
                        if (t.includes('extended thinking') || (t.includes('extended') && t.includes('thinking'))) {{
                            el.click();
                            return;
                        }}
                    }}
                }})()
                """)
                time.sleep(0.5)

            cdp.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
            cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
            time.sleep(0.4)
            force_menu_check = False

        final_status = ""
        check_final_start = time.time()
        while time.time() - check_final_start < 5.0:
            final_status = cdp.eval(f"""
            (() => {{
                const btn = document.querySelector('{GeminiSelectors.MODE_MENU_BTN}');
                return btn ? ((btn.getAttribute('aria-label') || '') + ' ' + (btn.textContent || '')).toLowerCase() : '';
            }})()
            """) or ""
            if "flash" in final_status and ("extended" in final_status or "thinking" in final_status):
                return True
            time.sleep(0.5)

        raise RuntimeError(f"❌【测试安全门禁拦截】无法将模型切换至 3.8 Flash + Extended thinking！当前状态: '{final_status}'。测试已被主动终止。")

    def execute_turn_pipeline(
        self,
        prompt_text: str,
        max_wait: int = 300,
        is_image: bool = False
    ) -> Tuple[bool, str]:
        """通过单飞串行流水线执行发帖，全程受安全网关监控与主动熔断保护"""
        from scripts.framework.pipeline.executor import SerialActionExecutor
        from scripts.framework.gateway import get_gateway
        executor = SerialActionExecutor()

        def _send(cdp, p_text):
            result = executor.execute_driver_turn(
                ctx=None,
                driver=self,
                prompt_text=p_text,
                max_wait=max_wait,
                is_image=is_image,
                cooldown_seconds=0.0
            )
            if result.success:
                return True, f"流式生成权威落地 (单飞执行器完成, 耗时 {result.duration:.1f}s)"
            return False, f"发帖流水线熔断: {result.error}"

        return get_gateway().safe_send_turn(self.cdp, _send, prompt_text)

    def get_current_chat_id(self) -> Optional[str]:
        """提取当前对话 ID"""
        return CDPActions.get_current_chat_id(self.cdp)

    def get_current_chat_title(self) -> Optional[str]:
        """提取当前对话标题"""
        return CDPActions.get_current_chat_title(self.cdp)

    def send_turn(self, prompt: Union[str, Dict[str, Any]], max_wait: int = 300) -> TurnResult:
        """发送一轮提问（若当前无活动 session 则自动初始化当前会话上下文）"""
        if self.active_session is None:
            curr_id = self.get_current_chat_id()
            self.active_session = GeminiChatSession(driver=self, chat_id=curr_id)
        return self.active_session.send_turn(prompt, max_wait=max_wait)

    def delete_chat_via_web(self, chat_id: str, timeout: float = 15.0) -> bool:
        """在侧边栏触发网页原生删除流程 (受网关审计与冷却保护)"""
        from scripts.framework.gateway import get_gateway
        return bool(get_gateway().safe_delete(
            self.cdp,
            CDPActions.delete_conversation_via_web,
            chat_id
        ))

    def upload_file(self, file_path: str, timeout: float = 15.0) -> bool:
        """
        通过 CDP 向当前 Gemini 输入框注入并挂载本地文件附件。
        使用原生 ClipboardEvent('paste') 传递 DataTransfer File 对象，
        并等待页面中 uploader-file-preview / gem-attachment 挂载完成。
        """
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"文件不存在: {file_path}")

        file_name = os.path.basename(file_path)
        mime_type, _ = mimetypes.guess_type(file_path)
        mime_type = mime_type or "text/plain"

        with open(file_path, "rb") as f:
            b64_content = base64.b64encode(f.read()).decode("ascii")

        res = self.cdp.eval(f"""
        (() => {{
            const editor = document.querySelector('{GeminiSelectors.EDITOR}');
            if (!editor) return {{ success: false, error: '未找到输入框编辑器' }};
            editor.focus();
            const b64 = "{b64_content}";
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            // 使用 application/json 作为通用结构化 MIME，确保 contenteditable 触发文件卡片挂载而不是纯文本粘贴
            const blob = new Blob([bytes], {{ type: 'application/json' }});
            const file = new File([blob], "{file_name}", {{ type: 'application/json' }});
            const dt = new DataTransfer();
            dt.items.add(file);
            const pasteEvt = new ClipboardEvent('paste', {{
                bubbles: true,
                cancelable: true,
                clipboardData: dt
            }});
            editor.dispatchEvent(pasteEvt);
            return {{ success: true }};
        }})()
        """)
        if not res or not res.get("success"):
            err = res.get("error", "未知错误") if isinstance(res, dict) else "CDP eval 失败"
            raise RuntimeError(f"文件注入粘贴事件失败: {err}")

        # 等待页面渲染出附件预览卡片
        t0 = time.time()
        while time.time() - t0 < timeout:
            mounted = self.cdp.eval(f"""
            (() => {{
                const preview = document.querySelector('{GeminiSelectors.FILE_PREVIEW}');
                if (!preview) return null;
                const text = (preview.textContent || '').trim();
                return {{ mounted: true, text }};
            }})()
            """)
            if mounted and mounted.get("mounted"):
                time.sleep(0.5)
                return True
            time.sleep(0.5)

        raise TimeoutError(f"等待文件附件 '{file_name}' 挂载超时 ({timeout}s)")

    def get_selectors(self) -> Dict[str, str]:
        """返回 Gemini 平台的全部 DOM 选择器常量字典"""
        return {
            k: getattr(GeminiSelectors, k)
            for k in dir(GeminiSelectors)
            if not k.startswith("_") and isinstance(getattr(GeminiSelectors, k), str)
        }

    def get_pipeline_strategies(self) -> Dict[str, Callable]:
        """返回 Gemini 流水线执行策略"""
        return {
            "send_turn": CDPActions.send_gemini_turn,
            "wait_ready": CDPActions.wait_for_gemini_ready,
        }

    def prepare_turn_environment(self, is_image: bool = False) -> bool:
        """
        发帖前环境准备：
        1. 确保模型为 3.8 Flash + Extended thinking
        2. 挂载网络流式完成事件监听器
        """
        self.ensure_model(target_model="3.8 Flash", target_thinking=True, force_menu_check=False)
        self.cdp.eval("""
        (() => {
            window.__testStreamState = {
                started: false,
                completed: false,
                convId: null,
                startedAt: 0,
                completedAt: 0
            };
            if (!window.__testStreamListenerAttached) {
                window.addEventListener('message', (e) => {
                    if (!e.data || typeof e.data !== 'object') return;
                    if (e.data.type === 'GEMINI_STREAM_GENERATE_START') {
                        window.__testStreamState.started = true;
                        window.__testStreamState.startedAt = Date.now();
                        if (e.data.payload && e.data.payload.id) {
                            window.__testStreamState.convId = e.data.payload.id;
                        }
                    } else if (e.data.type === 'GEMINI_STREAM_GENERATE_COMPLETE') {
                        window.__testStreamState.completed = true;
                        window.__testStreamState.completedAt = Date.now();
                        if (e.data.payload && e.data.payload.id) {
                            window.__testStreamState.convId = e.data.payload.id;
                        }
                    }
                });
                window.__testStreamListenerAttached = true;
            }
        })()
        """)
        return True

    def build_turn_pipeline(
        self,
        prompt_text: str,
        max_wait: int = 300,
        is_image: bool = False,
        cooldown_seconds: float = 6.0
    ) -> List[Any]:
        """构建 Gemini 平台的单轮发帖原子动作序列"""
        from scripts.framework.pipeline.actions import (
            AssertIdleAction,
            StagePromptAction,
            SingleClickSendAction,
            AwaitStreamSettledAction,
            HumanCooldownAction
        )
        turn_start_time = time.time()
        pipeline = [
            AssertIdleAction(max_wait=45),
            StagePromptAction(prompt_text),
            SingleClickSendAction(),
            AwaitStreamSettledAction(timeout=max_wait, require_image=is_image, turn_start_time=turn_start_time)
        ]
        if cooldown_seconds > 0:
            pipeline.append(HumanCooldownAction(seconds=cooldown_seconds))
        return pipeline

    def extract_turn_result(
        self,
        prompt_text: str,
        duration: float,
        is_image: bool = False
    ) -> TurnResult:
        """从页面 DOM 提取 Gemini 最新回复文本与生图实体"""
        resp_data = self.cdp.eval(f"""
        (() => {{
            const models = Array.from(document.querySelectorAll('{GeminiSelectors.MODEL_RESPONSE}'));
            if (models.length === 0) return {{ text: '', hasImages: false, modelCount: 0 }};
            const last = models[models.length - 1];
            const text = (last.textContent || '').trim();
            const imgs = last.querySelectorAll('{GeminiSelectors.IMAGES}');
            return {{
                text: text,
                hasImages: imgs.length > 0,
                modelCount: models.length
            }};
        }})()
        """) or {}

        has_images = bool(resp_data.get("hasImages", False))
        if is_image and not has_images:
            for _ in range(5):
                time.sleep(2.0)
                img_check = self.cdp.eval(f"""
                (() => {{
                    const models = Array.from(document.querySelectorAll('{GeminiSelectors.MODEL_RESPONSE}'));
                    const root = models.length > 0 ? models[models.length - 1] : document;
                    const imgs = root.querySelectorAll('{GeminiSelectors.IMAGES}');
                    return imgs.length > 0;
                }})()
                """)
                if img_check:
                    has_images = True
                    break

        curr_id = self.get_current_chat_id()
        return TurnResult(
            success=True,
            prompt=prompt_text,
            model_response=resp_data.get("text", ""),
            has_images=has_images,
            duration=duration,
            chat_id=curr_id,
            metadata={"model_count": resp_data.get("modelCount", 1)}
        )

    def new_chat(self, timeout: float = 20.0) -> GeminiChatSession:
        """
        开启全新对话并等待绝对确定性就绪：
        1. 路径跳转回 /app
        2. 历史气泡物理清空 (0 计数)
        3. 输入框就绪
        4. 模型与 Thinking 就绪
        """
        CDPActions.click_new_chat(self.cdp)

        start_t = time.time()
        while time.time() - start_t < timeout:
            state = self.cdp.eval(f"""
            (() => {{
                const path = window.location.pathname || '';
                const isAppRoute = (path === '/app' || path === '/app/');
                const bubbleCount = document.querySelectorAll('{GeminiSelectors.USER_QUERY}, {GeminiSelectors.MODEL_RESPONSE}').length;
                const editor = document.querySelector('{GeminiSelectors.EDITOR}');
                const modeBtn = document.querySelector('{GeminiSelectors.MODE_MENU_BTN}');
                return {{
                    isAppRoute,
                    bubbleCount,
                    hasEditor: !!editor,
                    hasModeBtn: !!(modeBtn && ((modeBtn.textContent || '').trim() || (modeBtn.getAttribute('aria-label') || '').trim()))
                }};
            }})()
            """)
            if state and state.get("isAppRoute") and state.get("bubbleCount") == 0 and state.get("hasEditor") and state.get("hasModeBtn"):
                break
            time.sleep(0.5)

        self.ensure_model(target_model="3.8 Flash", target_thinking=True, force_menu_check=False)

        session = GeminiChatSession(driver=self, chat_id=None)
        self.active_session = session
        return session

    def open_chat(self, chat_id: str, timeout: float = 20.0) -> GeminiChatSession:
        """
        导航至已有会话并等待就绪
        """
        chat_id_clean = str(chat_id).strip()
        curr_id = self.get_current_chat_id()
        if curr_id != chat_id_clean:
            target_url = f"https://gemini.google.com/app/{chat_id_clean}"
            get_gateway().safe_navigate(self.cdp, target_url)
            time.sleep(2.0)

        start_t = time.time()
        while time.time() - start_t < timeout:
            state = self.cdp.eval(f"""
            (() => {{
                const path = window.location.pathname || '';
                const onPath = path.includes('{chat_id_clean}');
                const editor = document.querySelector('{GeminiSelectors.EDITOR}');
                return onPath && !!editor;
            }})()
            """)
            if state:
                break
            time.sleep(0.5)

        self.ensure_model(target_model="3.8 Flash", target_thinking=True, force_menu_check=False)

        session = GeminiChatSession(driver=self, chat_id=chat_id_clean)
        self.active_session = session
        return session


# 保持 100% 向后兼容别名
GeminiDriver = GeminiPlatformDriver

# 自动注册至平台驱动注册中心
PlatformRegistry.register("gemini", GeminiPlatformDriver)
