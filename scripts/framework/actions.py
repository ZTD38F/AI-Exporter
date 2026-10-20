# scripts/framework/actions.py
"""
Reusable CDP Action Primitives for Gemini Exporter Test Automation.
Encapsulates real web interactions (typing, clicking, waiting for streams, searching, importing, deleting).
"""

import os
import re
import time
import json
import base64
import urllib.request
from typing import Tuple, Optional, Dict, Any, List

import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
try:
    from scripts.cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url
except ImportError:
    from cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url

from scripts.framework.pipeline import (
    SerialActionExecutor,
    AssertIdleAction,
    StagePromptAction,
    SingleClickSendAction,
    AwaitStreamSettledAction,
    HumanCooldownAction
)
from scripts.framework.selectors import GeminiSelectors, WorkbenchSelectors
from scripts.framework.gateway import get_gateway

_SHARED_PIPELINE_EXECUTOR = SerialActionExecutor()



class ExtensionActions:
    """
    Universal Chrome Extension Options Page & Management Automation Primitives.
    Independent of underlying AI platform; operates strictly on the extension UI.
    """
    @staticmethod
    def reinstall_extension(port: int = 9222, repo_path: Optional[str] = None) -> Optional[str]:
        """通过 CDP Extensions 域指令彻底卸载并纯净重新安装插件"""
        repo_path = os.path.abspath(repo_path or os.path.join(os.path.dirname(__file__), "..", ".."))
        try:
            import subprocess
            subprocess.run(["node", "build.js"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            print(f"   ⚠️ 自动构建提示: {e}")

        browser_ws = get_browser_ws_url(port)
        if not browser_ws:
            print(f"❌ 无法获取 Chrome Browser WebSocket (端口 {port})")
            return None

        old_ext_id = get_extension_id(port)
        cdp = CDPConnection(browser_ws)
        try:
            if old_ext_id:
                print(f"   🗑️ 正在通过 CDP Extensions.uninstall 卸载旧扩展 ({old_ext_id})...")
                try:
                    cdp.call("Extensions.uninstall", {"id": old_ext_id})
                except Exception as e:
                    print(f"   ⚠️ 卸载旧扩展提示: {e}")
                time.sleep(0.5)

            print(f"   📦 正在通过 CDP Extensions.loadUnpacked 安装扩展: {repo_path}...")
            res = cdp.call("Extensions.loadUnpacked", {"path": repo_path})
            new_ext_id = res.get("result", {}).get("id")
            if not new_ext_id:
                print(f"❌ 扩展安装失败，CDP 返回: {res}")
                return None
            print(f"   ✅ 扩展安装成功！新 Extension ID: {new_ext_id}")
            return new_ext_id
        finally:
            cdp.close()

    @staticmethod
    def verify_onboarding_tour(port: int = 9222, ext_id: Optional[str] = None, timeout: int = 15) -> bool:
        """全自动验证 options.html 新手向导交互流程与状态持久化"""
        print("   🧭 正在定位 options.html 标签页...")
        start_time = time.time()
        options_tab = None
        base_options_part = f"chrome-extension://{ext_id}/src/ui/options/options.html"

        while time.time() - start_time < timeout:
            tabs = get_tabs(port)
            options_tab = next((t for t in tabs if base_options_part in t.get("url", "")), None)
            if options_tab:
                break
            time.sleep(0.5)

        if not options_tab:
            new_url = f"http://127.0.0.1:{port}/json/new?{base_options_part}"
            req = urllib.request.Request(new_url, method="PUT")
            with urllib.request.urlopen(req, timeout=5) as r:
                options_tab = json.loads(r.read().decode("utf-8"))

        cdp = CDPConnection(options_tab["webSocketDebuggerUrl"])
        try:
            tour_ready = False
            for _ in range(20):
                is_active = cdp.eval(f"""
                (() => {{
                    const popover = document.querySelector('{WorkbenchSelectors.TOUR_POPOVER}');
                    const active = window.TourGuide ? window.TourGuide.isActive() : false;
                    return active && !!popover;
                }})()
                """)
                if is_active:
                    tour_ready = True
                    break
                time.sleep(0.4)

            if not tour_ready:
                cdp.eval("if (window.TourGuide) window.TourGuide.startTour(0);")
                time.sleep(0.5)

            # Step 1
            step1_info = cdp.eval(f"""
            (() => {{
                const badge = document.querySelector('{WorkbenchSelectors.TOUR_BADGE}')?.textContent || '';
                const step = window.TourGuide ? window.TourGuide.getCurrentStep() : -1;
                return {{ badge, step }};
            }})()
            """) or {}
            current_step_num = step1_info.get("step", 0)
            if current_step_num == 0:
                cdp.eval("""
                (() => {
                    const nextBtn = document.getElementById('tourNextBtn');
                    if (nextBtn) nextBtn.click();
                    else if (window.TourGuide) window.TourGuide.nextStep();
                })()
                """)
                time.sleep(0.5)

            # Step 2: 触发 #btnIncrementalScan
            cdp.eval("""
            (() => {
                const btn = document.getElementById('btnIncrementalScan');
                if (btn) btn.click();
            })()
            """)
            time.sleep(0.8)

            # Step 3: 会话勾选推进
            cdp.eval(f"""
            (() => {{
                const firstCb = document.querySelector('{WorkbenchSelectors.ITEM} {WorkbenchSelectors.CHECKBOX}');
                if (firstCb) {{
                    firstCb.checked = true;
                    firstCb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }} else {{
                    const btnAll = document.getElementById('btnSelectAll');
                    if (btnAll) btnAll.click();
                }}
            }})()
            """)
            time.sleep(0.8)

            # Step 4: 导出步骤 -> 推进至完成
            for _ in range(15):
                time.sleep(0.3)
                is_active = cdp.eval("window.TourGuide ? window.TourGuide.isActive() : false")
                if not is_active:
                    break
                cur_step = cdp.eval("window.TourGuide ? window.TourGuide.getCurrentStep() : -1")
                total_steps = cdp.eval("window.TourGuide && window.TourGuide.STEPS ? window.TourGuide.STEPS.length : 6")
                if cur_step >= total_steps - 1:
                    cdp.eval("""
                    (() => {
                        const nextBtn = document.getElementById('tourNextBtn');
                        if (nextBtn) nextBtn.click();
                        else if (window.TourGuide) window.TourGuide.finishTour();
                    })()
                    """)
                    time.sleep(0.5)
                    break
                else:
                    cdp.eval("""
                    (() => {
                        const nextBtn = document.getElementById('tourNextBtn');
                        if (nextBtn) nextBtn.click();
                        else if (window.TourGuide) window.TourGuide.nextStep();
                    })()
                    """)

            completed_state = cdp.eval(f"""
            (async () => {{
                const popover = document.querySelector('{WorkbenchSelectors.TOUR_POPOVER}');
                const isActive = window.TourGuide ? window.TourGuide.isActive() : false;
                const storage = await chrome.storage.local.get('has_completed_tour');
                return {{
                    hasPopover: !!popover,
                    isActive,
                    storageCompleted: !!storage.has_completed_tour
                }};
            }})()
            """, await_promise=True) or {}

            if completed_state.get("isActive") or completed_state.get("hasPopover"):
                return False
            if not completed_state.get("storageCompleted"):
                return False

            cdp.eval("history.replaceState(null, '', 'options.html');")
            return True
        finally:
            cdp.close()

    @staticmethod
    def search_workbench(cdp_opt, query: str, timeout: float = 3.0) -> int:
        """在 Options 工作台搜索框输入检索内容并等待过滤生效，返回过滤后可见条目数"""
        cdp_opt.eval(f"""
        (() => {{
            const input = document.querySelector('{WorkbenchSelectors.SEARCH_INPUT}');
            if (!input) return -1;
            input.focus();
            input.value = {json.dumps(query)};
            input.dispatchEvent(new Event('input', {{ bubbles: true }}));
            input.dispatchEvent(new Event('change', {{ bubbles: true }}));
            input.blur();
        }})()
        """)
        # 轮询等待列表过滤生效（optionsInit 包含 100ms 防抖及重绘周期）
        start = time.time()
        total_items = cdp_opt.eval(f"""
        (() => {{
            const s = window.ConversationsStore || (typeof ConversationsStore !== 'undefined' ? ConversationsStore : null);
            return s ? s.getConversations().length : document.querySelectorAll('{WorkbenchSelectors.ITEM}').length;
        }})()
        """) or 0

        while time.time() - start < timeout:
            visible_count = cdp_opt.eval(f"document.querySelectorAll('{WorkbenchSelectors.ITEM}').length") or 0
            if total_items > 1:
                if query and visible_count < total_items:
                    return visible_count
                elif not query and visible_count >= total_items:
                    return visible_count
            else:
                return visible_count
            time.sleep(0.05)

        return cdp_opt.eval(f"document.querySelectorAll('{WorkbenchSelectors.ITEM}').length") or 0

    @staticmethod
    def clear_search_workbench(cdp_opt, timeout: float = 3.0) -> int:
        """清空 Options 工作台搜索框并等待完整列表恢复，返回恢复后的列表总数"""
        cdp_opt.eval(f"""
        (() => {{
            const input = document.querySelector('{WorkbenchSelectors.SEARCH_INPUT}');
            if (!input) return -1;
            input.value = '';
            input.dispatchEvent(new Event('input', {{ bubbles: true }}));
            input.dispatchEvent(new Event('change', {{ bubbles: true }}));
            input.blur();
        }})()
        """)
        # 轮询等待搜索防抖及全量列表恢复
        start = time.time()
        target_total = cdp_opt.eval("""
        (() => {
            const s = window.ConversationsStore || (typeof ConversationsStore !== 'undefined' ? ConversationsStore : null);
            return s ? s.getConversations().length : 0;
        })()
        """) or 0

        while time.time() - start < timeout:
            visible_count = cdp_opt.eval(f"document.querySelectorAll('{WorkbenchSelectors.ITEM}').length") or 0
            if target_total > 0 and visible_count >= target_total:
                return visible_count
            time.sleep(0.05)

        return cdp_opt.eval(f"document.querySelectorAll('{WorkbenchSelectors.ITEM}').length") or 0

    @staticmethod
    def select_workbench_item(cdp_opt, chat_id: str, checked: bool = True) -> bool:
        """精准操作指定 chatId 卡片的复选框勾选状态"""
        item_sel = WorkbenchSelectors.item_by_chat_id(chat_id)
        return bool(cdp_opt.eval(f"""
        (() => {{
            const item = document.querySelector('{item_sel}');
            if (!item) return false;
            const cb = item.querySelector('{WorkbenchSelectors.CHECKBOX}');
            if (!cb) return false;
            if (cb.checked !== {str(checked).lower()}) {{
                cb.checked = {str(checked).lower()};
                cb.dispatchEvent(new Event('change', {{ bubbles: true }}));
            }}
            return true;
        }})()
        """))

    @staticmethod
    def toggle_select_all(cdp_opt) -> int:
        """点击全选按钮，返回勾选后的复选框总数"""
        return cdp_opt.eval(f"""
        (() => {{
            const btn = document.querySelector('{WorkbenchSelectors.BTN_SELECT_ALL}');
            if (btn) btn.click();
            return document.querySelectorAll('{WorkbenchSelectors.CHECKED_CHECKBOX}').length;
        }})()
        """) or 0

    @staticmethod
    def toggle_select_none(cdp_opt) -> int:
        """点击取消全选按钮，返回勾选后的复选框总数"""
        return cdp_opt.eval(f"""
        (() => {{
            const btn = document.querySelector('{WorkbenchSelectors.BTN_SELECT_NONE}');
            if (btn) btn.click();
            return document.querySelectorAll('{WorkbenchSelectors.CHECKED_CHECKBOX}').length;
        }})()
        """) or 0

    @staticmethod
    def switch_workbench_language(cdp_opt, lang: str = "en") -> str:
        """切换 Options 工作台语言 (en / zh)，等待异步本地化就绪并返回全选按钮文案"""
        btn_id = 'labelLangEn' if lang == 'en' else 'labelLangZh'
        expected_part = 'all' if lang == 'en' else '全选'
        return cdp_opt.eval(f"""
        (async () => {{
            const label = document.getElementById('{btn_id}');
            if (label) label.click();
            for (let i = 0; i < 20; i++) {{
                const btnAll = document.getElementById('btnSelectAll');
                const txt = btnAll ? btnAll.textContent.trim() : '';
                if (txt.toLowerCase().includes('{expected_part}')) {{
                    return txt;
                }}
                await new Promise(r => setTimeout(r, 100));
            }}
            const btnAll = document.getElementById('btnSelectAll');
            return btnAll ? btnAll.textContent.trim() : '';
        }})()
        """, await_promise=True) or ''

    @staticmethod
    def import_takeout_zip(cdp_opt, zip_path: str) -> Dict[str, Any]:
        """向工作台导入预置 Takeout ZIP 样本"""
        if not os.path.isfile(zip_path):
            return {"success": False, "error": f"File not found: {zip_path}"}

        with open(zip_path, "rb") as tf:
            zip_b64 = base64.b64encode(tf.read()).decode("ascii")

        return cdp_opt.eval(f"""
        (async () => {{
            try {{
                const b64 = {json.dumps(zip_b64)};
                const bin = atob(b64);
                const arr = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                const file = new File([arr], "{os.path.basename(zip_path)}", {{ type: "application/zip" }});
                
                const TC = typeof TakeoutController !== 'undefined' ? TakeoutController : window.TakeoutController;
                if (!TC) return {{ error: "TakeoutController not loaded" }};

                return await new Promise((resolve) => {{
                    TC.handleTakeoutImport(file, {{
                        onFinished: (result) => {{
                            if (typeof window.__workbenchLoadStore === 'function') {{
                                window.__workbenchLoadStore(true);
                            }}
                            resolve({{
                                success: true,
                                addedCount: result.addedCount,
                                totalMediaCount: result.totalMediaCount
                            }});
                        }},
                        onError: (err, msg) => resolve({{ error: msg || (err && err.message) || String(err) }})
                    }});
                }});
            }} catch (e) {{
                return {{ error: e.message }};
            }}
        }})()
        """, await_promise=True) or {}

    @staticmethod
    def trigger_deep_scan(cdp_opt, max_wait: int = 90) -> bool:
        """触发【全量拉取历史】(btnDeepScan) 并等待分页同步完成"""
        cdp_opt.eval(f"""
        (() => {{
            const btn = document.querySelector('{WorkbenchSelectors.BTN_DEEP_SCAN}');
            if (btn) btn.click();
        }})()
        """)
        # 1. 确保等待扫描进入启动状态 (最多 3 秒)
        for _ in range(6):
            time.sleep(0.5)
            state = cdp_opt.eval(f"""
            (() => {{
                const sc = typeof SyncCtrl !== 'undefined' ? SyncCtrl : (typeof SyncController !== 'undefined' ? SyncController : null);
                const isScan = sc && (sc.isScanning ? sc.isScanning() : (sc.isRunning ? sc.isRunning() : false));
                const btn = document.querySelector('{WorkbenchSelectors.BTN_EXPORT}');
                return {{ isScan: Boolean(isScan || (btn && btn.disabled)) }};
            }})()
            """)
            if state and state.get("isScan"):
                break

        # 2. 阻塞等待扫描彻底结束并恢复工作台可用
        start = time.time()
        while time.time() - start < max_wait:
            time.sleep(1.0)
            state = cdp_opt.eval(f"""
            (() => {{
                const sc = typeof SyncCtrl !== 'undefined' ? SyncCtrl : (typeof SyncController !== 'undefined' ? SyncController : null);
                const isScan = sc && (sc.isScanning ? sc.isScanning() : (sc.isRunning ? sc.isRunning() : false));
                const btn = document.querySelector('{WorkbenchSelectors.BTN_EXPORT}');
                return {{ isScan: Boolean(isScan || (btn && btn.disabled)) }};
            }})()
            """)
            if not state or not state.get("isScan"):
                time.sleep(1.0)
                return True
        return False

    @staticmethod
    def trigger_export_zip(
        cdp_opt,
        output_dir: str,
        max_wait: int = 60,
        skip_exported: Optional[bool] = False,
        format_type: Optional[str] = None
    ) -> Optional[str]:
        """确保设置 format_type、启用 includeZip 并点击导出，监控下载并返回落盘的 ZIP 路径"""
        # TestEnvironment routes downloads to output_dir. Avoid scanning the user's
        # Downloads folder, where cloud-backed entries can block directory reads.
        # 记录导出触发前已存在的 ZIP 文件与修改时间戳，杜绝旧文件误命中。
        baseline_files = {}
        for check_d in [output_dir]:
            if os.path.isdir(check_d):
                for f in os.listdir(check_d):
                    if re.match(r"(?i)gemini_export_.*\.zip$", f):
                        fp = os.path.abspath(os.path.join(check_d, f))
                        try:
                            baseline_files[fp] = os.path.getmtime(fp)
                        except OSError:
                            pass

        cdp_opt.eval(f"""
        (() => {{
            const formatType = {json.dumps(format_type)};
            if (formatType) {{
                const fmtSelect = document.getElementById('format');
                if (fmtSelect && fmtSelect.value !== formatType) {{
                    fmtSelect.value = formatType;
                    fmtSelect.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }}
            const skipCb = document.getElementById('skipExported');
            if (skipCb) {{
                const shouldSkip = {json.dumps(skip_exported)};
                if (shouldSkip !== null && skipCb.checked !== shouldSkip) {{
                    skipCb.checked = shouldSkip;
                    skipCb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }}
            const zipCb = document.getElementById('includeZip');
            if (zipCb && !zipCb.checked) {{
                zipCb.checked = true;
                zipCb.dispatchEvent(new Event('change', {{ bubbles: true }}));
            }}
            const btn = document.querySelector('{WorkbenchSelectors.BTN_EXPORT}');
            if (btn && !btn.disabled) btn.click();

            setTimeout(() => {{
                const continueZip = document.getElementById('btnModalContinueZip');
                if (continueZip && continueZip.offsetParent !== null) {{
                    continueZip.click();
                }}
            }}, 300);
        }})()
        """, user_gesture=True)
        start_time = time.time()
        downloaded_zip = None

        while time.time() - start_time < max_wait:
            time.sleep(1.5)
            # 若弹出直写文件夹建议弹窗，自动点击继续使用 ZIP 导出
            cdp_opt.eval("""
            (() => {
                const continueZip = document.getElementById('btnModalContinueZip');
                if (continueZip && continueZip.offsetParent !== null) {
                    continueZip.click();
                }
            })()
            """)
            if os.path.isdir(output_dir):
                candidates = []
                for f in os.listdir(output_dir):
                    if re.match(r"(?i)gemini_export_.*\.zip$", f):
                        fp = os.path.abspath(os.path.join(output_dir, f))
                        try:
                            mtime = os.path.getmtime(fp)
                            if (fp not in baseline_files or mtime > baseline_files[fp]) and os.path.getsize(fp) > 0:
                                candidates.append((mtime, fp))
                        except OSError:
                            pass
                if candidates:
                    candidates.sort(key=lambda x: x[0], reverse=True)
                    downloaded_zip = candidates[0][1]
                    break

        return downloaded_zip


class CDPActions(ExtensionActions):
    """
    Combined Actions Facade for Test Automation.
    Inherits all ExtensionActions (workbench, tour, options, export)
    and contains Gemini-specific web automation primitives.
    """
    @staticmethod
    def wait_for_gemini_ready(cdp, max_wait: int = 30) -> bool:
        """等待 Gemini 页面输入框及核心 DOM 就绪"""
        start = time.time()
        while time.time() - start < max_wait:
            ready = cdp.eval(f"""
            (() => {{
                const editor = document.querySelector('{GeminiSelectors.EDITOR}');
                return !!(editor && document.body);
            }})()
            """)
            if ready:
                return True
            time.sleep(0.5)
        return False

    @staticmethod
    def get_current_chat_id(cdp) -> Optional[str]:
        """从当前页面 URL、网络流式状态、扩展 Hook 属性或侧边栏提取正在进行的对话 ID"""
        raw_id = cdp.eval(f"""
        (() => {{
            // 1. 从 URL pathname 提取
            const path = window.location.pathname || "";
            const parts = path.split("/app/");
            if (parts.length > 1) {{
                const cid = parts[1].split("?")[0].trim();
                if (cid && cid.length >= 8) return cid;
            }}
            // 2. 从 DOM 显式属性提取
            const el = document.querySelector('[data-conversation-id], [data-chat-id]');
            if (el) {{
                const attrId = el.getAttribute('data-conversation-id') || el.getAttribute('data-chat-id');
                if (attrId && attrId.length >= 8) return attrId.trim();
            }}
            // 3. 从扩展流式网络监听器捕获的会话 ID 提取
            if (window.__testStreamState && window.__testStreamState.convId && window.__testStreamState.convId.length >= 8) {{
                return window.__testStreamState.convId;
            }}
            if (window.__geminiActiveStreamConvId && window.__geminiActiveStreamConvId.length >= 8) {{
                return window.__geminiActiveStreamConvId;
            }}
            // 4. 若页面上已存在对话气泡，则侧边栏首项即为当次会话
            const hasBubbles = document.querySelectorAll('{GeminiSelectors.USER_QUERY}, {GeminiSelectors.MODEL_RESPONSE}').length > 0;
            if (hasBubbles) {{
                const activeA = document.querySelector('{GeminiSelectors.NAV_ITEM_ACTIVE}');
                if (activeA) {{
                    const ap = (activeA.getAttribute('href') || '').split('/app/');
                    if (ap.length > 1 && ap[1].length >= 8) return ap[1].split('?')[0].trim();
                }}
                const firstA = document.querySelector('{GeminiSelectors.NAV_ITEM} a[href^="/app/"], nav a[href^="/app/"], a[href^="/app/"]');
                if (firstA) {{
                    const fp = (firstA.getAttribute('href') || '').split('/app/');
                    if (fp.length > 1 && fp[1].length >= 8) return fp[1].split('?')[0].trim();
                }}
            }}
            return null;
        }})()
        """)
        return str(raw_id).strip() if raw_id else None


    @staticmethod
    def get_current_chat_title(cdp) -> Optional[str]:
        """从当前 Gemini 页面提取权威对话标题"""
        title = cdp.eval(f"""
        (() => {{
            const explicit = document.querySelector('{GeminiSelectors.CONVERSATION_TITLE}');
            if (explicit && explicit.textContent.trim()) return explicit.textContent.trim();
            const heading = document.querySelector('h1');
            if (heading && heading.textContent.trim() && !heading.textContent.includes('Gemini')) return heading.textContent.trim();
            const docTitle = document.title || "";
            const cleaned = docTitle.replace(/ - Gemini$| - Google Gemini$|^Gemini - /i, '').trim();
            if (cleaned && cleaned !== 'Gemini') return cleaned;
            return null;
        }})()
        """)
        return str(title).strip() if title else None

    @staticmethod
    def ensure_model_and_thinking(cdp, target_model: str = "3.8 Flash", target_thinking: bool = True, force_menu_check: bool = False) -> bool:
        """严格校验并锁定 Gemini 模型与思考模式 (委托至 GeminiPlatformDriver 权威实现)"""
        from scripts.framework.driver.gemini_driver import GeminiPlatformDriver
        driver = GeminiPlatformDriver(cdp)
        return driver.ensure_model(
            target_model=target_model,
            target_thinking=target_thinking,
            force_menu_check=force_menu_check
        )

    @staticmethod
    def send_gemini_turn(cdp, turn_input: Any, max_wait: int = 300) -> Tuple[bool, str]:
        """向 Gemini 聚焦输入框、粘贴 Prompt、单次物理点击并以单飞串行流水线权威等待流式生成落地 (受网关监控)"""
        if isinstance(turn_input, dict):
            prompt_text = turn_input.get("prompt", "")
        else:
            prompt_text = str(turn_input)

        is_image_gen = any(kw in prompt_text for kw in ["生成图片", "生成一张图片", "画一张", "generate an image", "create an image"])
        if is_image_gen:
            max_wait = max(max_wait, 240)

        from scripts.framework.driver.gemini_driver import GeminiPlatformDriver
        driver = GeminiPlatformDriver(cdp)
        return driver.execute_turn_pipeline(prompt_text, max_wait=max_wait, is_image=is_image_gen)

    @staticmethod
    def upload_gemini_file(cdp, file_path: str, timeout: float = 15.0) -> bool:
        """向当前 Gemini 输入框上传本地文件附件 (委托至 GeminiPlatformDriver 权威实现)"""
        from scripts.framework.driver.gemini_driver import GeminiPlatformDriver
        driver = GeminiPlatformDriver(cdp)
        return driver.upload_file(file_path=file_path, timeout=timeout)

    @staticmethod
    def click_new_chat(cdp) -> bool:
        """开启新对话 (优先通过安全网关导航至 /app，保障物理清空残留气泡)"""
        try:
            if get_gateway().safe_navigate(cdp, "https://gemini.google.com/app"):
                time.sleep(2.0)
                return True
        except Exception:
            pass
        res = cdp.eval(f"""
        (() => {{
            const newBtn = document.querySelector('{GeminiSelectors.NEW_CHAT_BTN}');
            if (newBtn) {{
                newBtn.click();
                return true;
            }}
            window.location.href = 'https://gemini.google.com/app';
            return true;
        }})()
        """)
        time.sleep(2.0)
        return bool(res)


    @staticmethod
    def delete_conversation_via_web(cdp_gemini, chat_id: str) -> bool:
        """在 Gemini 网页端侧边栏执行真实会话删除链路"""
        # 0. 确保侧边栏处于展开状态 (若处于折叠状态则主动点击展开按钮)
        cdp_gemini.eval(f"""
        (() => {{
            const openBtn = document.querySelector('{GeminiSelectors.OPEN_SIDEBAR_BTN}');
            if (openBtn) {{
                openBtn.click();
                return true;
            }}
            return false;
        }})()
        """)
        time.sleep(0.6)

        nav_sel = GeminiSelectors.nav_item_by_chat_id(chat_id)
        # 触发悬停使三点菜单显示
        rect = cdp_gemini.eval(f"""
        (() => {{
            const a = document.querySelector('{nav_sel}');
            if (!a) return null;
            const item = a.closest('{GeminiSelectors.NAV_ITEM}') || a.parentElement;
            item.dispatchEvent(new MouseEvent('mouseenter', {{ bubbles: true }}));
            item.dispatchEvent(new MouseEvent('mouseover', {{ bubbles: true }}));
            const r = item.getBoundingClientRect();
            return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }};
        }})()
        """)
        if rect:
            try:
                cdp_gemini.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": rect["x"], "y": rect["y"]})
            except Exception:
                pass
            time.sleep(0.3)

        click_opts = cdp_gemini.eval(f"""
        (() => {{
            const a = document.querySelector('{nav_sel}');
            if (!a) return 'link_not_found';
            const item = a.closest('{GeminiSelectors.NAV_ITEM}') || a.parentElement;
            let btn = item.querySelector('{GeminiSelectors.MORE_OPTIONS_BTN}');
            if (!btn) {{
                const allBtns = Array.from(item.querySelectorAll('button'));
                btn = allBtns.find(b => {{
                    const l = (b.getAttribute('aria-label') || '').toLowerCase();
                    return l.includes('more') || l.includes('option') || l.includes('更多');
                }});
            }}
            if (!btn) return 'btn_not_found';
            btn.click();
            return 'options_clicked';
        }})()
        """)
        if click_opts != 'options_clicked':
            return False
        time.sleep(0.6)

        del_click = cdp_gemini.eval(f"""
        (() => {{
            const delBtn = document.querySelector('{GeminiSelectors.DELETE_ITEM_BTN}');
            if (delBtn) {{
                delBtn.click();
                return true;
            }}
            const items = Array.from(document.querySelectorAll('[role="menuitem"], button'));
            const match = items.find(b => {{
                const t = b.textContent.trim().toLowerCase();
                return t.includes('delete') || t.includes('删除');
            }});
            if (match) {{
                match.click();
                return true;
            }}
            return false;
        }})()
        """)
        if not del_click:
            return False
        time.sleep(0.8)

        confirm_click = cdp_gemini.eval(f"""
        (() => {{
            const dialog = document.querySelector('{GeminiSelectors.DIALOG}');
            if (!dialog) return false;
            const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(b => {{
                const txt = b.innerText.trim().toLowerCase();
                return txt === 'delete' || txt === '删除';
            }});
            if (confirmBtn) {{
                confirmBtn.click();
                return true;
            }}
            return false;
        }})()
        """)
        time.sleep(2.0)
        return bool(confirm_click)

    @staticmethod
    def setup_live_save(cdp_opt, enabled: bool = True) -> bool:
        """
        在 Options 工作台环境中配置或开关实时本地落盘 (Live Auto-Save)。
        当 enabled=True 时：
        1. 确保导出格式为 markdown；
        2. 获取 native OPFS handle，并持久化写入 gemini_exporter_idb 的 handles 库；
        3. 模拟 showDirectoryPicker 适配返回 OPFS handle；
        4. 点击开启 liveSaveDiskToggle 并确保 live_save_config.enabledDisk 为 True；
        当 enabled=False 时：
        1. 点击关闭 liveSaveDiskToggle 并将 live_save_config.enabledDisk 置为 False。
        """
        res = cdp_opt.eval(f"""
        (async () => {{
            try {{
                const enabled = {json.dumps(enabled)};
                const diskToggle = document.getElementById('liveSaveDiskToggle');
                const formatSelect = document.getElementById('format');

                if (enabled) {{
                    if (formatSelect && formatSelect.value !== 'markdown') {{
                        formatSelect.value = 'markdown';
                        formatSelect.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }}

                    const root = await navigator.storage.getDirectory();
                    await root.getDirectoryHandle('gemini_export', {{ create: true }});

                    await new Promise((resolve, reject) => {{
                        const req = indexedDB.open('gemini_exporter_idb', 1);
                        req.onsuccess = () => {{
                            const db = req.result;
                            const tx = db.transaction('handles', 'readwrite');
                            const store = tx.objectStore('handles');
                            store.put(root, 'export_dir_handle');
                            tx.oncomplete = () => {{ db.close(); resolve(true); }};
                            tx.onerror = () => {{ db.close(); reject(tx.error); }};
                        }};
                        req.onerror = () => reject(req.error);
                    }});

                    window.showDirectoryPicker = async () => root;

                    if (diskToggle && !diskToggle.checked) {{
                        diskToggle.checked = true;
                        diskToggle.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }}

                    await chrome.storage.local.set({{
                        live_save_config: {{
                            enabledDisk: true,
                            dirName: 'gemini_export',
                            format: 'markdown',
                            includeAssets: true,
                            dirError: null
                        }}
                    }});
                    return {{ ok: true, enabled: true }};
                }} else {{
                    if (diskToggle && diskToggle.checked) {{
                        diskToggle.checked = false;
                        diskToggle.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }}
                    const data = await chrome.storage.local.get(['live_save_config']);
                    const cur = data.live_save_config || {{}};
                    await chrome.storage.local.set({{
                        live_save_config: {{
                            ...cur,
                            enabledDisk: false
                        }}
                    }});
                    return {{ ok: true, enabled: false }};
                }}
            }} catch (e) {{
                return {{ ok: false, error: e.message }};
            }}
        }})()
        """, await_promise=True) or {}
        time.sleep(0.5)
        return bool(res.get("ok"))

    @staticmethod
    def flush_live_save_to_disk(cdp_opt, target_disk_dir: str) -> Dict[str, Any]:
        """
        从 OPFS 遍历 gemini_export 目录下的所有 Markdown 文件与 assets/ 图片，
        并将其物理回写到 target_disk_dir/gemini_export/ 目录中，确保磁盘存在物理落地实体。
        返回写入的文件统计清单。
        """
        res = cdp_opt.eval("""
        (async () => {
            try {
                const root = await navigator.storage.getDirectory();
                let exportDir;
                try {
                    exportDir = await root.getDirectoryHandle('gemini_export');
                } catch {
                    return { ok: true, files: [] };
                }

                const files = [];
                for await (const [name, handle] of exportDir.entries()) {
                    if (handle.kind === 'file') {
                        const f = await handle.getFile();
                        const text = await f.text();
                        files.push({ path: name, text, isBinary: false, mtime: f.lastModified });
                    } else if (handle.kind === 'directory' && name === 'assets') {
                        for await (const [assetName, assetHandle] of handle.entries()) {
                            if (assetHandle.kind === 'file') {
                                const af = await assetHandle.getFile();
                                const buf = await af.arrayBuffer();
                                const bytes = new Uint8Array(buf);
                                let binary = '';
                                for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                                files.push({ path: 'assets/' + assetName, base64: btoa(binary), isBinary: true, mtime: af.lastModified });
                            }
                        }
                    }
                }
                return { ok: true, files };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        })()
        """, await_promise=True) or {}

        if not res.get("ok"):
            return {"ok": False, "error": res.get("error"), "files": []}

        files = res.get("files", [])
        sub_export = os.path.join(target_disk_dir, "gemini_export")
        os.makedirs(sub_export, exist_ok=True)

        written_paths = []
        for item in files:
            fpath = os.path.join(sub_export, item["path"])
            os.makedirs(os.path.dirname(fpath), exist_ok=True)
            if item.get("isBinary"):
                import base64
                data = base64.b64decode(item["base64"])
                with open(fpath, "wb") as f:
                    f.write(data)
            else:
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(item["text"])
            written_paths.append(fpath)

        return {"ok": True, "count": len(written_paths), "files": written_paths}

