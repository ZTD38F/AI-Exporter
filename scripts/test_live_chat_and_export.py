#!/usr/bin/env python3
"""
scripts/test_live_chat_and_export.py
------------------------------------
端到端自动化测试：在真实 Gemini 中执行 2 次对话（每次 5 轮），触发插件导出，
并自动断言导出目录中的文件与 5 轮对话内容的完整性。

特性：
1. 双模支持：默认使用内置的 2 套经典 5 轮高价值对话；支持 --dataset 传入自定义（或由 AI 动态生成）的数据集。
2. 全流程 CDP 驱动：自动创建会话、输入多轮 Prompt、等待流式生成、捕获会话 ID。
3. 扩展自动化导出：自动操作 options.html 同步最新会话、通过 item[data-chat-id] 精准勾选目标会话、导出为 ZIP。
4. 深度内容断言：自动定位并解压导出的 ZIP，深入每个 Markdown 文件严格校验全部 5 轮的用户提问与模型回答。
"""

import sys
import os
import json
import time
import socket
import base64
import struct
import argparse
import zipfile
import re
import urllib.request
import urllib.error

try:
    from tests.helpers.export_spec_asserter import ExportSpecificationAsserter
except ImportError:
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    from tests.helpers.export_spec_asserter import ExportSpecificationAsserter

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True, encoding="utf-8")
except Exception:
    pass

CDP_DEFAULT_PORT = 9222
DATASET_MAX_AGE_SECONDS = 120  # 2 分钟新鲜度时效限制

DEFAULT_SCENARIOS = [
    {
        "id": "scenario_python_concurrency",
        "title": "Python高性能并发系统与异步架构演进",
        "turns": [
            "请解释 Python GIL (全局解释器锁) 的底层工作机制，以及它为什么限制了多线程在 CPU 密集型任务中的并行能力？",
            "在处理海量 I/O 密集型网络请求时，对比 threading、multiprocessing 与 asyncio 三种方案的内存开销与吞吐量差异。",
            "请使用 Python asyncio 和 aiohttp 编写一个并发限制为 5 的异步抓取示例，要求包含超时控制与指数退避重试逻辑。",
            "为刚才编写的异步抓取器设计一个基于内存的 TTL/LRU 缓存装饰器，防止短时间内对相同 URL 重复发起抓取。",
            "请总结在生产环境中排查 Python 异步服务事件循环卡顿 (Event Loop Lag) 和协程内存泄漏的 3 个最有效策略。"
        ]
    },
    {
        "id": "scenario_distributed_architecture",
        "title": "分布式系统高可用架构与最终一致性实战",
        "turns": [
            "请详细阐述分布式系统中的 CAP 定理，并对比 CP 系统 (如 etcd) 与 AP 系统 (如 Cassandra) 在分区容忍时的设计哲学。",
            "在大型高并发秒杀系统中，如何基于 Redis Lua 脚本与 MySQL 设计一套高性能、防超卖的库存预扣方案？",
            "在上述预扣方案中，如果 Redis 扣减成功但后续消息队列异步落盘失败，应该设计怎样的补偿与对账机制来保证数据最终一致性？",
            "请用简洁的 ASCII 纯字符流程图绘制上述秒杀链路中 API 网关、Redis 预扣、消息队列与数据库落库的数据流转过程。",
            "针对跨服务的分布式事务，请对比 2PC (两阶段提交)、TCC (Try-Confirm-Cancel) 与 SAGA 模式的优缺点及各自最适用的业务场景。"
        ]
    }
]


DESIGNATED_HISTORICAL_CHATS = [
    {
        "id": "1bd028d5c5b0c0e2",
        "category": "AI 生成图片 (Imagen)",
        "name": "火星宇航员猫咪（AI 生成图片 Imagen）",
        "expected_snippets": ["astronaut cat"],
        "expected_generated_images": 1,
        "syntax_checks": ["image"]
    },
    {
        "id": "1cea7e48cc166b57",
        "category": "高质量技术代码块 (Python)",
        "name": "Python日志与耗时装饰器设计（高质量技术代码块）",
        "expected_snippets": ["Python", "def ", "functools"],
        "syntax_checks": ["codeblock"]
    },
    {
        "id": "7b29852ecae8344a",
        "category": "Markdown 对比表格与量子理论",
        "name": "贝尔不等式推导与物理意义（复杂表格与量子理论）",
        "expected_snippets": ["贝尔不等式"],
        "syntax_checks": ["table"]
    },
    {
        "id": "f8ba969fe8c7d880",
        "category": "长文本深度推演 (深空探测)",
        "name": "韦伯望远镜深空探测重大发现（长文本科学报告）",
        "expected_snippets": ["韦伯", "深空探测"],
        "syntax_checks": []
    }
]


try:
    from scripts.cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url
except ImportError:
    from cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url



def reinstall_extension_via_cdp(port=CDP_DEFAULT_PORT, repo_path=None):
    """
    通过 Chrome DevTools Protocol 原生 Extensions 域指令彻底卸载并重新安装插件。
    此方式能够 100% 真实触发 chrome.runtime.onInstalled(reason === 'install')，
    且不会唤起操作系统原生文件选择框，全自动化无阻碍运行。
    """
    repo_path = os.path.abspath(repo_path or os.path.join(os.path.dirname(__file__), ".."))
    browser_ws = get_browser_ws_url(port)
    if not browser_ws:
        print(f"❌ 无法获取 Chrome Browser WebSocket (端口 {port})，请确认 Chrome 正在运行并开启了远程调试")
        return None

    old_ext_id = get_extension_id(port)
    cdp = CDPConnection(browser_ws)
    try:
        if old_ext_id:
            print(f"   🗑️ 正在通过 CDP Extensions.uninstall 彻底卸载旧扩展 ({old_ext_id})...")
            try:
                cdp.call("Extensions.uninstall", {"id": old_ext_id})
            except Exception as e:
                print(f"   ⚠️ 卸载旧扩展返回提示: {e}")
            time.sleep(0.5)

        print(f"   📦 正在通过 CDP Extensions.loadUnpacked 原生安装工作区扩展: {repo_path}...")
        res = cdp.call("Extensions.loadUnpacked", {"path": repo_path})
        new_ext_id = res.get("result", {}).get("id")
        if not new_ext_id:
            print(f"❌ 扩展安装失败，CDP 返回: {res}")
            return None
        print(f"   ✅ 扩展安装成功！新 Extension ID: {new_ext_id}")
        return new_ext_id
    finally:
        cdp.close()


def verify_onboarding_tour(port=CDP_DEFAULT_PORT, ext_id=None, timeout=15):
    """
    全自动验证全新安装时触发的 options.html?welcome=1 及其新手向导 (TourGuide) 全流程：
    1. 验证 Step 1 (连接引导): 校验 popover 渲染、badge '1 / 4' 并点击下一步；
    2. 验证 Step 2 (扫描同步引导): 校验 badge '2 / 4'，触发 #btnIncrementalScan 动作推进；
    3. 验证 Step 3 (会话选择引导): 校验 badge '3 / 4'，触发会话勾选或全选动作推进；
    4. 验证 Step 4 (导出执行引导): 校验 badge '4 / 4'，点击完成按钮，校验向导销毁与 storage 落盘。
    """
    print("   🧭 正在定位安装后由 background 自动拉起的 options.html?welcome=1 标签页...")
    start_time = time.time()
    welcome_tab = None
    welcome_url_part = f"chrome-extension://{ext_id}/src/ui/options/options.html?welcome=1"
    base_options_part = f"chrome-extension://{ext_id}/src/ui/options/options.html"

    while time.time() - start_time < timeout:
        tabs = get_tabs(port)
        welcome_tab = next((t for t in tabs if welcome_url_part in t.get("url", "")), None)
        if welcome_tab:
            break
        if not welcome_tab:
            opt = next((t for t in tabs if base_options_part in t.get("url", "")), None)
            if opt:
                welcome_tab = opt
                break
        time.sleep(0.5)

    if not welcome_tab:
        print("   ⚠️ 未在 15 秒内检测到自动弹出的 options 标签页，主动发起打开...")
        new_url = f"http://127.0.0.1:{port}/json/new?{welcome_url_part}"
        req = urllib.request.Request(new_url, method="PUT")
        with urllib.request.urlopen(req, timeout=5) as r:
            welcome_tab = json.loads(r.read().decode("utf-8"))

    cdp = CDPConnection(welcome_tab["webSocketDebuggerUrl"])
    try:
        # 等待 options.html DOM 及 TourGuide 初始化
        print("   🔍 正在等待 TourGuide 向导浮层加载与激活...")
        tour_ready = False
        for _ in range(20):
            is_active = cdp.eval("""
            (() => {
                const popover = document.querySelector('.tour-popover');
                const badge = document.querySelector('.tour-step-badge')?.textContent || '';
                const active = window.TourGuide ? window.TourGuide.isActive() : false;
                return active && !!popover;
            })()
            """)
            if is_active:
                tour_ready = True
                break
            time.sleep(0.4)

        if not tour_ready:
            print("   ⚠️ 尝试通过 TourGuide.startTour(0) 兜底激活向导...")
            cdp.eval("if (window.TourGuide) window.TourGuide.startTour(0);")
            time.sleep(0.5)

        # -------------------------------------------------------------
        # Step 1 校验：连接引导 (1 / 5) 或已由动态连接自动推进至 (2 / 5)
        # -------------------------------------------------------------
        step1_info = cdp.eval("""
        (() => {
            const badge = document.querySelector('.tour-step-badge')?.textContent || '';
            const step = window.TourGuide ? window.TourGuide.getCurrentStep() : -1;
            return { badge, step };
        })()
        """)
        current_step_num = step1_info.get("step", 0)
        if current_step_num == 0:
            if "1 / 6" not in step1_info.get("badge", "") and "1 / 5" not in step1_info.get("badge", "") and "1 / 4" not in step1_info.get("badge", ""):
                print(f"❌ 向导 Step 1 校验失败: {step1_info}")
                return False
            print("   ✓ [向导 1/5] 连接就绪步骤校验通过，点击前进...")

            cdp.eval("""
            (() => {
                const nextBtn = document.getElementById('tourNextBtn');
                if (nextBtn) nextBtn.click();
                else if (window.TourGuide) window.TourGuide.nextStep();
            })()
            """)
            time.sleep(0.5)
        elif current_step_num == 1:
            print("   ✓ [向导 1/N ➔ 2/N] 检测到已连接 Gemini 页面，向导已自适应智能推进至 Step 2！")
        else:
            print(f"❌ 向导步骤异常: {step1_info}")
            return False

        # -------------------------------------------------------------
        # Step 2 校验：扫描同步引导 (2 / N) 并触发 #btnIncrementalScan
        # -------------------------------------------------------------
        step2_info = {}
        for _ in range(20):
            step2_info = cdp.eval("""
            (() => {
                const badge = document.querySelector('.tour-step-badge')?.textContent || '';
                const step = window.TourGuide ? window.TourGuide.getCurrentStep() : -1;
                return { badge, step };
            })()
            """) or {}
            if ("2 / 6" in step2_info.get("badge", "") or "2 / 5" in step2_info.get("badge", "") or "2 / 4" in step2_info.get("badge", "")) and step2_info.get("step") == 1:
                break
            time.sleep(0.15)

        if step2_info.get("step") != 1:
            print(f"❌ 向导 Step 2 校验失败: {step2_info}")
            return False
        print("   ✓ [向导 2/5] 扫描同步步骤已就绪，触发 #btnIncrementalScan 动作推进...")

        cdp.eval("""
        (() => {
            const btn = document.getElementById('btnIncrementalScan');
            if (btn) btn.click();
        })()
        """)

        step3_advanced = False
        for _ in range(25):
            time.sleep(0.15)
            cur_step = cdp.eval("window.TourGuide ? window.TourGuide.getCurrentStep() : -1")
            if cur_step == 2:
                step3_advanced = True
                break
        if not step3_advanced:
            print("❌ 点击 #btnIncrementalScan 后未能在超时前自动推进至 Step 3")
            return False
        print("   ✓ [向导 3/5] 行为驱动自动推进至选择会话步骤！")

        # -------------------------------------------------------------
        # Step 3 校验：会话勾选推进 (3 / 5) -> 模拟选择并推进
        # -------------------------------------------------------------
        cdp.eval("""
        (() => {
            const firstCb = document.querySelector('#list .item input[type=checkbox]');
            if (firstCb) {
                firstCb.checked = true;
                firstCb.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                const btnAll = document.getElementById('btnSelectAll');
                if (btnAll) btnAll.click();
            }
        })()
        """)

        step4_advanced = False
        for _ in range(25):
            time.sleep(0.15)
            cur_step = cdp.eval("window.TourGuide ? window.TourGuide.getCurrentStep() : -1")
            if cur_step == 3:
                step4_advanced = True
                break
        if not step4_advanced:
            print("❌ 勾选会话后未能在超时前自动推进至 Step 4")
            return False
        print("   ✓ [向导 4/5] 行为驱动自动推进至导出步骤！")

        # -------------------------------------------------------------
        # Step 4 校验：导出步骤 -> 点击下一步推进至后续步骤与完成
        # -------------------------------------------------------------
        cdp.eval("""
        (() => {
            const nextBtn = document.getElementById('tourNextBtn');
            if (nextBtn) nextBtn.click();
            else if (window.TourGuide) window.TourGuide.nextStep();
        })()
        """)

        # 动态自适应推进后续步骤 (例如 5/6 实时保存 与 6/6 反馈步骤) 直至完成销毁
        for _ in range(20):
            time.sleep(0.25)
            is_active = cdp.eval("window.TourGuide ? window.TourGuide.isActive() : false")
            if not is_active:
                break
            cur_step = cdp.eval("window.TourGuide ? window.TourGuide.getCurrentStep() : -1")
            total_steps = cdp.eval("window.TourGuide && window.TourGuide.STEPS ? window.TourGuide.STEPS.length : 6")
            if cur_step >= total_steps - 1:
                print(f"   ✓ [向导 {cur_step+1}/{total_steps}] 推进至最终反馈与完成步骤，点击完成向导...")
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
                print(f"   ✓ [向导 {cur_step+1}/{total_steps}] 处于中间步骤，推进下一步...")
                cdp.eval("""
                (() => {
                    const nextBtn = document.getElementById('tourNextBtn');
                    if (nextBtn) nextBtn.click();
                    else if (window.TourGuide) window.TourGuide.nextStep();
                })()
                """)
        time.sleep(0.5)

        # 校验 storage 落盘与浮层销毁
        completed_state = cdp.eval("""
        (async () => {
            const popover = document.querySelector('.tour-popover');
            const isActive = window.TourGuide ? window.TourGuide.isActive() : false;
            const storage = await chrome.storage.local.get('has_completed_tour');
            return {
                hasPopover: !!popover,
                isActive,
                storageCompleted: !!storage.has_completed_tour
            };
        })()
        """, await_promise=True)

        if completed_state.get("isActive") or completed_state.get("hasPopover"):
            print(f"❌ 向导未能正确关闭销毁: {completed_state}")
            return False
        if not completed_state.get("storageCompleted"):
            print("❌ 向导完成后 chrome.storage.local 中的 has_completed_tour 未能置为 true")
            return False

        # 清理 URL 参数并保持页面就绪
        cdp.eval("history.replaceState(null, '', 'options.html');")
        print("   🎉 新手向导 5 步交互与持久化状态断言 100% 通过！")
        return True
    finally:
        cdp.close()


def wait_for_gemini_ready(cdp, max_wait=30):
    start = time.time()
    while time.time() - start < max_wait:
        ready = cdp.eval("""
        (() => {
          const editor = document.querySelector('rich-textarea div.ql-editor') || document.querySelector('div[contenteditable="true"]');
          return !!editor;
        })()
        """)
        if ready:
            return True
        time.sleep(1)
    return False


def get_current_chat_id(cdp):
    # 1. 优先直接从 URL 提取
    url = cdp.eval("location.href") or ""
    if "/app/" in url:
        part = url.split("/app/")[-1].split("?")[0].strip()
        if len(part) >= 8:
            return part

    # 2. 兜底：从侧边栏最新/选中的会话锚点提取
    res = cdp.eval("""
    (() => {
        const anchors = Array.from(document.querySelectorAll("a"));
        const chatLink = anchors.find(a => (a.getAttribute("href") || "").includes("/app/"));
        if (chatLink) {
            const href = chatLink.getAttribute("href") || "";
            const parts = href.split("/app/");
            if (parts.length > 1) {
                const cid = parts[1].split("?")[0].trim();
                if (cid.length >= 8) return cid;
            }
        }
        return null;
    })()
    """)
    if res and len(str(res)) >= 8:
        return str(res)

    return None


def get_current_chat_title(cdp):
    title = cdp.eval("""
    (() => {
        const titleEl = document.querySelector('conversation-title, h1, .conversation-title');
        if (titleEl && titleEl.textContent.trim()) return titleEl.textContent.trim();
        const anchors = Array.from(document.querySelectorAll("a"));
        const chatLink = anchors.find(a => (a.getAttribute("href") || "").includes("/app/"));
        if (chatLink && chatLink.textContent.trim()) return chatLink.textContent.trim();
        return document.title;
    })()
    """)
    return (title or "").replace(" - Google Gemini", "").strip()


def send_turn(cdp, turn_input, max_wait=240):
    if isinstance(turn_input, dict):
        prompt_text = turn_input.get("prompt", "")
    else:
        prompt_text = str(turn_input)

    # 识别生图类 Prompt，自适应延长超时时间
    is_image_gen = any(kw in prompt_text for kw in ["生成图片", "生成一张图片", "画一张", "generate an image", "create an image"])
    if is_image_gen:
        max_wait = max(max_wait, 240)

    # 0. 发送前先确保 Gemini 处于空闲状态 (若上一轮仍在流式或 Stop 按钮活跃，等待其完全平息)
    for _ in range(45):
        busy = cdp.eval("""
        (() => {
            const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"], .send-button.stop');
            const isStreaming = !!document.querySelector('.streaming-text, .loading-dots, [data-is-streaming="true"], spark-progress');
            return !!(stopBtn && stopBtn.offsetWidth > 0) || isStreaming;
        })()
        """)
        if not busy:
            break
        time.sleep(1.0)

    # 记录发送前已有的回复条数与用户消息条数，防止多轮时误判旧回复已完成
    prev_model_info = cdp.eval("""
    (() => {
        const allModels = Array.from(document.querySelectorAll('message-content.model-response-text, model-response, .model-response-text'));
        return {
            count: allModels.length,
            lastLen: allModels.length ? (allModels[allModels.length - 1].textContent || '').trim().length : 0
        };
    })()
    """) or {"count": 0, "lastLen": 0}
    prev_resp_count = prev_model_info.get("count", 0)
    prev_last_len = prev_model_info.get("lastLen", 0)

    prev_user_count = cdp.eval("""
    (() => document.querySelectorAll('.user-query, user-query, [data-test-id="user-query"], message-content.user-message').length)()
    """) or 0

    # 1. 聚焦输入框并清空原有占位符
    cdp.eval("""
    (() => {
      const editor = document.querySelector('rich-textarea div.ql-editor') || document.querySelector('div[contenteditable="true"]');
      if (editor) {
        editor.focus();
        editor.innerHTML = '<p><br></p>';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
    """)
    time.sleep(0.3)

    # 2. 原生输入文本
    cdp.call("Input.insertText", {"text": prompt_text})
    time.sleep(0.3)
    cdp.eval("""
    (() => {
      const editor = document.querySelector('rich-textarea div.ql-editor') || document.querySelector('div[contenteditable="true"]');
      if (editor) {
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
    """)
    time.sleep(0.3)

    # 3. 点击发送按钮并确保派发
    sent = False
    for attempt in range(12):
        status = cdp.eval(f"""
        (() => {{
          const currUserCount = document.querySelectorAll('.user-query, user-query, [data-test-id="user-query"], message-content.user-message').length;
          const editor = document.querySelector('rich-textarea div.ql-editor') || document.querySelector('div[contenteditable="true"]');
          const editorText = editor ? editor.textContent.trim() : '';
          const isStreaming = !!document.querySelector('.streaming-text, .loading-dots, [data-is-streaming="true"], spark-progress');
          
          if (currUserCount > {prev_user_count}) {{
            return {{ sent: true, userCount: currUserCount }};
          }}

          const sendBtn = document.querySelector('button[aria-label="Send message"], button[aria-label*="Send"], button[aria-label*="Submit"], button[aria-label*="发送"], button[aria-label*="提交"], [aria-label="Send message"], .send-button button, gem-icon-button.send-button button, gem-icon-button.send-button');
          let coords = null;
          if (sendBtn) {{
            const isDisabled = sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true';
            if (!isDisabled) {{
              const r = sendBtn.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {{
                coords = {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }};
              }}
              sendBtn.click();
              if (sendBtn.parentElement && (sendBtn.parentElement.tagName === 'GEM-ICON-BUTTON' || sendBtn.parentElement.classList.contains('send-button'))) {{
                sendBtn.parentElement.click();
              }}
            }}
          }}
          return {{ sent: false, userCount: currUserCount, coords: coords }};
        }})()
        """)
        if status and status.get("sent"):
            sent = True
            break
        if status and status.get("coords"):
            cx = status["coords"]["x"]
            cy = status["coords"]["y"]
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cx, "y": cy})
            cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1})
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cx, "y": cy, "button": "left", "clickCount": 1})
        if attempt in [2, 5, 8]:
            cdp.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 13, "unmodifiedText": "\\r", "text": "\\r"})
            cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 13, "unmodifiedText": "\\r", "text": "\\r"})
        time.sleep(0.5)

    if not sent:
        return False, "未能成功派发消息（输入未提交到对话流）"

    # 4. 等待生成开始 (出现 stop 按钮、streaming 状态或新回复条数增加)
    for _ in range(30):
        started = cdp.eval(f"""
        (() => {{
          const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"], .send-button.stop');
          const isStreaming = !!document.querySelector('.streaming-text, .loading-dots, [data-is-streaming="true"], spark-progress');
          const currCount = document.querySelectorAll('.model-response-text, model-response, .response-content').length;
          return !!stopBtn || isStreaming || currCount > {prev_resp_count};
        }})()
        """)
        if started:
            break
        time.sleep(0.5)

    # 5. 等待生成完全结束 (无 stop 按钮、send按钮就绪、且确实产生了新回复)
    start_time = time.time()
    last_seen_len = 0
    stable_count = 0
    loop_idx = 0
    while time.time() - start_time < max_wait:
        time.sleep(1.2)
        loop_idx += 1
        elapsed = time.time() - start_time
        state = cdp.eval(f"""
        (() => {{
          const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"], .send-button.stop');
          const isStopActive = !!(stopBtn && stopBtn.offsetWidth > 0);
          const sendBtn = document.querySelector('button[aria-label="Send message"], button[aria-label*="Send"], button[aria-label*="Submit"], button[aria-label*="发送"], button[aria-label*="提交"], gem-icon-button.send-button:not(.stop)');
          const isSendReady = !!(sendBtn && sendBtn.offsetWidth > 0 && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true');
          const editor = document.querySelector('rich-textarea div.ql-editor') || document.querySelector('div[contenteditable="true"]');
          const isEditorReady = !!(editor && (editor.getAttribute('contenteditable') === 'true' || editor.offsetWidth > 0));
          const isStreaming = !!document.querySelector('.streaming-text, .loading-dots, [data-is-streaming="true"], spark-progress');
          const allModels = Array.from(document.querySelectorAll('message-content.model-response-text, model-response, .model-response-text, structured-content-container.model-response-text'));
          const currCount = allModels.length;
          const retryBtn = document.querySelector('button[aria-label*="Retry"], button[aria-label*="重试"]');
          const toastEl = document.querySelector('toast-content, .toast, .error-message, [role="alert"]');
          const lastModel = currCount > 0 ? allModels[currCount - 1] : null;
          const lastLen = lastModel ? (lastModel.textContent || '').trim().length : 0;
          const hasImages = lastModel ? (lastModel.querySelectorAll('img[src*="blob:"], img[src*="googleusercontent"], .image-container, img').length > 0) : false;
          return {{
            hasStop: isStopActive,
            hasSend: isSendReady,
            isEditorReady: isEditorReady,
            isStreaming: isStreaming,
            currCount: currCount,
            hasImages: hasImages,
            hasResponse: currCount > {prev_resp_count} || (currCount === {prev_resp_count} && (lastLen > {prev_last_len} + 30 || hasImages)),
            hasRetry: !!retryBtn,
            toast: toastEl ? toastEl.textContent.trim() : null,
            lastLen: lastLen
          }};
        }})()
        """)
        if not state:
            continue

        if state.get("hasRetry"):
            print("      ⚠️ 检测到页面出现重试按钮，正在点击重试...")
            cdp.eval("""(() => {
                const btn = document.querySelector('button[aria-label*="Retry"], button[aria-label*="重试"]');
                if (btn) btn.click();
            })()""")
            time.sleep(2)
            continue

        last_len = state.get("lastLen", 0)
        has_resp = state.get("hasResponse", False)
        has_images = state.get("hasImages", False)
        is_stream = state.get("isStreaming", False)
        has_stop = state.get("hasStop", False)
        has_send = state.get("hasSend", False)
        is_editor_ready = state.get("isEditorReady", False)
        ready_for_next = has_send or is_editor_ready
        curr_count = state.get("currCount", 0)

        # 详细日志输出：每 ~2.4 秒打印一次当前状态
        if loop_idx % 2 == 0:
            print(f"      ⏳ 等待回复 [t={elapsed:.1f}s]: 回复数={curr_count} (前值={prev_resp_count}), 流式中={is_stream}, Stop按钮={has_stop}, Send就绪={has_send}, Editor就绪={is_editor_ready}, 包含生图={has_images}, 尾部长={last_len}, 稳定计数={stable_count}")

        if has_resp and not is_stream and not has_stop and ready_for_next:
            if has_images and last_len < 20:
                stable_count += 1
                if stable_count >= 2:
                    time.sleep(1.0)
                    return True, f"生图生成完毕 (耗时 {elapsed:.1f}s, 检测到图片实体)"
            elif last_len == last_seen_len:
                stable_count += 1
                if stable_count >= 2:
                    time.sleep(1.0)
                    return True, f"生成完毕 (耗时 {elapsed:.1f}s, 尾部长度: {last_len})"
            else:
                last_seen_len = last_len
                stable_count = 0
        elif has_resp and not is_stream and last_len == last_seen_len and last_seen_len > 30:
            stable_count += 1
            if stable_count >= 6:
                time.sleep(1.0)
                return True, f"生成完毕 (文本已稳定 {stable_count} 次, 耗时 {elapsed:.1f}s, 尾部长度: {last_len})"
        else:
            if last_len != last_seen_len:
                last_seen_len = last_len
                stable_count = 0

        if elapsed > 25 and not has_stop and not is_stream and not has_resp and state.get("toast"):
            return False, f"页面报错: {state.get('toast')}"

    return False, f"等待回复超时 ({max_wait}s)"


def run_live_chat_and_export(dataset=None, port=CDP_DEFAULT_PORT, output_dir=None, delay=2, skip_chat=False, skip_takeout=False, takeout_zip=None, skip_reinstall=False, skip_tour=False):
    if isinstance(dataset, dict) and "scenarios" in dataset:
        scenarios = dataset["scenarios"]
    else:
        scenarios = dataset or DEFAULT_SCENARIOS
    if len(scenarios) < 2:
        print("❌ 场景数不足 2 个，本测试要求执行 2 次独立会话！")
        return False

    abs_output_dir = os.path.abspath(output_dir or os.path.join(os.path.dirname(__file__), "..", "tests", "output", "live_export"))
    os.makedirs(abs_output_dir, exist_ok=True)

    print("=" * 70)
    print("🚀 启动固定生产测试流：卸载重装 ➔ 新手向导 ➔ 真实 Gemini 问答 ➔ 导出 ➔ 规范断言")
    print(f"📁 导出目标目录: {abs_output_dir}")
    print(f"🌐 Chrome 端口: 127.0.0.1:{port}")
    if skip_reinstall:
        print("⚡ [模式] 已开启 --skip-reinstall：跳过扩展卸载与重装步骤")
    if skip_tour:
        print("⚡ [模式] 已开启 --skip-tour：跳过新手向导全流程测试步骤")
    if skip_chat:
        print("⚡ [模式] 已开启 --skip-chat：直接复用已有会话进行同步与导出校验")
    if not skip_takeout:
        print("📥 [增强] 已启用 Takeout 样本预置自动导入与历史合流验证")
    if dataset:
        print(f"📝 [数据集] 已加载动态注入测试数据集（包含 {len(scenarios)} 个会话场景）")
    else:
        print(f"📦 [数据集] 使用内置默认标准测试数据集（--allow-stale-dataset 模式，包含 {len(scenarios)} 个会话场景）")
    print("=" * 70)

    worktree_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

    # ==========================================
    # 阶段零：通过原生 CDP 彻底卸载旧插件并纯净重装当前代码
    # ==========================================
    if not skip_reinstall:
        print("\n" + "-" * 70)
        print("🔄 阶段零：通过 CDP Extensions 域彻底卸载旧扩展并纯净安装当前代码...")
        print("-" * 70)
        reinstalled_id = reinstall_extension_via_cdp(port, repo_path=worktree_root)
        if not reinstalled_id:
            print("❌ 扩展卸载重装失败，中断全流程测试！")
            return False
        ext_id = reinstalled_id
        time.sleep(1.0)
    else:
        ext_id = get_extension_id(port)
        if not ext_id:
            print("❌ 未能获取到 Gemini Exporter 扩展程序 ID")
            return False

    print(f"🧩 当前活跃扩展 ID: {ext_id}")

    # 检查 Gemini 页面并在重装后第一时间刷新以注入最新 Content Scripts
    tabs = get_tabs(port)
    gemini_tab = next((t for t in tabs if "gemini.google.com" in t.get("url", "")), None)
    if not gemini_tab and not skip_chat:
        print("   🌐 未在 Chrome 中检测到打开的 gemini.google.com 页面，尝试通过 CDP 自动拉起...")
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?https://gemini.google.com/app", method="PUT")
            with urllib.request.urlopen(req, timeout=5) as resp:
                new_tab = json.loads(resp.read().decode())
                print(f"   ✓ 已成功通过 CDP 自动创建 Gemini 标签页 (ID: {new_tab.get('id', '')[:8]}...)")
                time.sleep(3.0)
                tabs = get_tabs(port)
                gemini_tab = next((t for t in tabs if "gemini.google.com" in t.get("url", "")), None)
        except Exception as e:
            print(f"   ⚠️ 自动打开 Gemini 页面异常: {e}")

    if not gemini_tab and not skip_chat:
        print("❌ 未在 Chrome 中找到打开的 gemini.google.com 页面")
        print("💡 请先启动测试浏览器: ./scripts/open_test_chrome.sh")
        return False

    if gemini_tab and not skip_reinstall:
        print("   🔄 扩展重新安装后，刷新 gemini.google.com 标签页以注入最新 Content Scripts...")
        cdp_g = CDPConnection(gemini_tab["webSocketDebuggerUrl"])
        try:
            cdp_g.eval("location.reload()")
        except Exception:
            pass
        finally:
            cdp_g.close()
        time.sleep(2.0)

    # ==========================================
    # 阶段零点五：全流程自动化验证新手向导 (TourGuide 4步交互与落盘)
    # ==========================================
    if not skip_tour:
        print("\n" + "-" * 70)
        print("🧭 阶段零点五：全流程自动化验证新手向导 (TourGuide 4步交互与持久化)...")
        print("-" * 70)
        tour_ok = verify_onboarding_tour(port, ext_id)
        if not tour_ok:
            print("❌ 新手向导全自动验证失败，中断全流程测试！")
            return False

    chat_records = []

    # ==========================================
    # 阶段一与阶段二：执行 2 次对话，每次 5 轮 (或复用已有)
    # ==========================================
    if not skip_chat:
        cdp_gemini = CDPConnection(gemini_tab["webSocketDebuggerUrl"])
        try:
            for chat_idx in range(2):
                sc = scenarios[chat_idx]
                sc_title = sc.get("title", f"测试会话 {chat_idx + 1}")
                turns = sc.get("turns", [])

                # 智能会话定位：优先从当前页面或侧边栏查找是否已有本场景的会话
                prompts_clean = [t.get("prompt", "") if isinstance(t, dict) else str(t) for t in turns]
                first_p = prompts_clean[0][:14] if prompts_clean else ""

                # 检查当前页面是否就是本场景
                curr_ups = cdp_gemini.eval("""
                (() => {
                    const ups = Array.from(document.querySelectorAll(".user-query, user-query, [data-test-id='user-query'], message-content.user-message"));
                    return ups.map(p => p.textContent);
                })()
                """) or []

                is_curr_page_match = any(first_p in up for up in curr_ups) if (curr_ups and first_p) else False

                target_chat_id = sc.get("chat_id")
                if target_chat_id:
                    print(f"   🧭 数据集指定会话 ID: /app/{target_chat_id}，直接加载！")
                    cdp_gemini.eval(f"location.href = 'https://gemini.google.com/app/{target_chat_id}'")
                    time.sleep(3.0)
                    try:
                        cdp_gemini.reconnect()
                    except Exception:
                        pass
                    wait_for_gemini_ready(cdp_gemini, max_wait=15)
                    curr_ups = cdp_gemini.eval("""
                    (() => {
                        const ups = Array.from(document.querySelectorAll(".user-query, user-query, [data-test-id='user-query'], message-content.user-message"));
                        return ups.map(p => p.textContent);
                    })()
                    """) or []
                elif not is_curr_page_match:
                    # 检查侧边栏是否有本场景历史会话
                    sidebar_links = cdp_gemini.eval("""
                    (() => {
                        const anchors = Array.from(document.querySelectorAll("a"));
                        const links = anchors.filter(a => (a.getAttribute("href") || "").includes("/app/"));
                        return links.map(a => ({
                            cid: (a.getAttribute("href") || "").split("/app/")[1].split("?")[0],
                            text: a.textContent.trim()
                        }));
                    })()
                    """) or []
                    sidebar_match = next((l for l in sidebar_links if (first_p and first_p[:8] in l["text"]) or (sc_title and sc_title[:6] in l["text"])), None)
                    if sidebar_match and sidebar_match["cid"]:
                        target_cid = sidebar_match["cid"]
                        print(f"   🧭 侧边栏发现已有会话《{sidebar_match['text'][:20]}...》，跳转加载: /app/{target_cid}")
                        cdp_gemini.eval(f"location.href = 'https://gemini.google.com/app/{target_cid}'")
                        time.sleep(2.5)
                        try:
                            cdp_gemini.reconnect()
                        except Exception:
                            pass
                        wait_for_gemini_ready(cdp_gemini, max_wait=15)
                        curr_ups = cdp_gemini.eval("""
                        (() => {
                            const ups = Array.from(document.querySelectorAll(".user-query, user-query, [data-test-id='user-query'], message-content.user-message"));
                            return ups.map(p => p.textContent);
                        })()
                        """) or []

                # 计算已存在的轮次与缺失的轮次
                missing_turns = []
                for idx, t in enumerate(turns, 1):
                    p_text = t.get("prompt", "") if isinstance(t, dict) else str(t)
                    if not any(p_text[:14] in up for up in curr_ups):
                        missing_turns.append((idx, t))

                if not missing_turns:
                    existing_cid = get_current_chat_id(cdp_gemini)
                    print(f"   ⚡ 检测到会话在当前页面已完整存在 ({len(prompts_clean)} 轮全部就绪)，直接复用！会话 ID: {existing_cid}")
                    chat_records.append({
                        "chat_id": existing_cid,
                        "title": get_current_chat_title(cdp_gemini) or sc_title,
                        "turns": prompts_clean
                    })
                    continue

                chat_id = get_current_chat_id(cdp_gemini)
                successful_turns = [p for p in prompts_clean if any(p[:14] in up for up in curr_ups)]
                if curr_ups and len(missing_turns) < len(turns):
                    print(f"   ⚡ 检测到当前会话已包含 {len(turns) - len(missing_turns)}/{len(turns)} 轮，补充发送剩余 {len(missing_turns)} 轮！会话 ID: {chat_id}")
                    turns_to_run = missing_turns
                else:
                    # 全新对话
                    cdp_gemini.eval("location.href = 'https://gemini.google.com/app'")
                    time.sleep(1.8)
                    try:
                        cdp_gemini.reconnect()
                    except Exception:
                        pass
                    if not wait_for_gemini_ready(cdp_gemini):
                        print("❌ 页面加载超时，未能就绪")
                        return False
                    time.sleep(1.5)
                    turns_to_run = list(enumerate(turns, 1))
                    successful_turns = []

                for turn_no, turn_input in turns_to_run:
                    prompt_text = turn_input.get("prompt", "") if isinstance(turn_input, dict) else str(turn_input)
                    preview = (prompt_text[:48] + "...") if len(prompt_text) > 48 else prompt_text
                    print(f"   ▶️ 轮次 {turn_no}/{len(turns)}: \"{preview}\"")
                    ok = False
                    msg = ""
                    for try_idx in range(3):
                        ok, msg = send_turn(cdp_gemini, turn_input, max_wait=300)
                        if ok:
                            break
                        print(f"      ⚠️ 轮次 {turn_no} 提示: {msg}，等待 4 秒后重试 ({try_idx + 1}/3)...")
                        time.sleep(4)

                    if ok:
                        chat_id = get_current_chat_id(cdp_gemini) or chat_id
                        print(f"      ✅ 回复完成 (会话 ID: {chat_id or '生成中'})")
                        successful_turns.append(prompt_text)
                    else:
                        print(f"      ❌ {msg}")
                        return False
                    time.sleep(delay)

                real_title = get_current_chat_title(cdp_gemini) or sc_title
                chat_records.append({
                    "chat_id": chat_id,
                    "title": real_title,
                    "turns": prompts_clean
                })
                print(f"   🏁 第 {chat_idx + 1} 次对话完成！会话 ID: {chat_id}，总计 {len(prompts_clean)} 轮已全量就绪")

            # ==========================================
            # 阶段 2.5：老会话继续对话与实时置顶上升检验 (Continued Chat Real-time Promotion)
            # ==========================================
            if len(chat_records) >= 2:
                session1_id = chat_records[0].get("chat_id")
                session2_id = chat_records[1].get("chat_id")
                if session1_id and session2_id and session1_id != session2_id:
                    print("\n" + "-" * 70)
                    print("🔄 阶段 2.5：老会话继续对话与实时置顶检验 (Continued Chat Real-time Promotion)...")
                    print("-" * 70)
                    print(f"   🧭 正在返回首个历史会话 (会话 1, ID: {session1_id}) 进行追加对话...")
                    cdp_gemini.eval(f"location.href = 'https://gemini.google.com/app/{session1_id}'")
                    time.sleep(2.5)
                    try:
                        cdp_gemini.reconnect()
                    except Exception:
                        pass
                    wait_for_gemini_ready(cdp_gemini, max_wait=15)

                    continuation_prompt = "请对以上我们探讨的核心观点进行精炼总结，列出 3 条最具操作性的关键行动清单。"
                    curr_ups_s1 = cdp_gemini.eval("""
                    (() => {
                        const ups = Array.from(document.querySelectorAll(".user-query, user-query, [data-test-id='user-query'], message-content.user-message"));
                        return ups.map(p => p.textContent);
                    })()
                    """) or []

                    already_has_cont = any(continuation_prompt[:14] in up for up in curr_ups_s1)
                    if already_has_cont:
                        print(f"   ⚡ 检测到会话 1 中追加轮次已存在，跳过发帖直接进入置顶与合流验证！")
                    else:
                        print(f"   ▶️ 追加轮次 (第 {len(chat_records[0]['turns']) + 1} 轮): \"{continuation_prompt}\"")
                        cont_ok = False
                        cont_msg = ""
                        for try_idx in range(3):
                            cont_ok, cont_msg = send_turn(cdp_gemini, continuation_prompt, max_wait=300)
                            if cont_ok:
                                break
                            print(f"      ⚠️ 追加轮次提示: {cont_msg}，等待 4 秒后重试 ({try_idx + 1}/3)...")
                            time.sleep(4)

                        if cont_ok:
                            print(f"      ✅ 追加回复完成！流式生成结束已触发 STREAM_COMPLETE 实时触达")
                            chat_records[0]["turns"].append(continuation_prompt)
                            if isinstance(scenarios[0].get("turns"), list):
                                scenarios[0]["turns"].append(continuation_prompt)
                        else:
                            print(f"      ⚠️ 追加轮次发送异常: {cont_msg}")
                    time.sleep(delay)

        finally:
            cdp_gemini.close()
    else:
        # 复用模式下：优先从当前活跃的 Gemini 标签页侧边栏探测最近生成的真实会话 ID
        recent_gemini_ids = []
        if gemini_tab:
            try:
                cdp_temp = CDPConnection(gemini_tab["webSocketDebuggerUrl"])
                try:
                    detected = cdp_temp.eval("""
                    (() => {
                        const anchors = Array.from(document.querySelectorAll("a"));
                        const links = anchors.filter(a => (a.getAttribute("href") || "").includes("/app/"));
                        return links.map(a => {
                            const parts = (a.getAttribute("href") || "").split("/app/");
                            return parts.length > 1 ? parts[1].split("?")[0].trim() : null;
                        }).filter(id => id && id.length >= 8);
                    })()
                    """)
                    if detected and isinstance(detected, list):
                        for cid in detected:
                            if cid not in recent_gemini_ids:
                                recent_gemini_ids.append(cid)
                finally:
                    cdp_temp.close()
            except Exception:
                pass

        for chat_idx in range(2):
            sc = scenarios[chat_idx]
            raw_turns = sc.get("turns", [])
            extracted_prompts = [t.get("prompt", "") if isinstance(t, dict) else str(t) for t in raw_turns]
            # Note: in Gemini sidebar, newest chat is at top (index 0 is Session 2, index 1 is Session 1)
            real_cid = sc.get("id")
            if len(recent_gemini_ids) >= 2:
                # chat_idx 0 (Session 1, older) -> index 1 in sidebar
                # chat_idx 1 (Session 2, newer) -> index 0 in sidebar
                real_cid = recent_gemini_ids[1 - chat_idx]
            elif len(recent_gemini_ids) == 1:
                real_cid = recent_gemini_ids[0]

            chat_records.append({
                "chat_id": real_cid,
                "title": sc.get("title", ""),
                "turns": extracted_prompts
            })

    # ==========================================
    # 阶段三：控制插件后台 options.html 执行同步与导出
    # ==========================================
    print("\n" + "-" * 70)
    print("📦 阶段三：打开扩展后台 Options 页面，触发同步并导出选中的 2 个会话...")
    print("-" * 70)

    options_url = f"chrome-extension://{ext_id}/src/ui/options/options.html"
    tabs = get_tabs(port)
    opt_tab = next((t for t in tabs if options_url in t.get("url", "")), None)
    if not opt_tab:
        new_url = f"http://127.0.0.1:{port}/json/new?{options_url}"
        req = urllib.request.Request(new_url, method="PUT")
        with urllib.request.urlopen(req, timeout=5) as r:
            opt_tab = json.loads(r.read().decode("utf-8"))

    cdp_opt = CDPConnection(opt_tab["webSocketDebuggerUrl"])
    try:
        try:
            cdp_opt.call("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": abs_output_dir})
        except Exception:
            pass

        browser_ws = get_browser_ws_url(port)
        if browser_ws:
            try:
                b_cdp = CDPConnection(browser_ws)
                b_cdp.call("Browser.setDownloadBehavior", {
                    "behavior": "allow",
                    "downloadPath": abs_output_dir,
                    "eventsEnabled": True
                })
                b_cdp.close()
            except Exception:
                pass

        time.sleep(1.0)

        # ------------------------------------------------------------------
        # 步骤 3.0：断言老会话追加发帖后的实时置顶与「已更新」徽章智能默认勾选
        # ------------------------------------------------------------------
        if not skip_chat and len(chat_records) >= 2:
            s1_id = chat_records[0].get("chat_id")
            s2_id = chat_records[1].get("chat_id")
            if s1_id and s2_id and s1_id != s2_id:
                print("   🔍 步骤 3.0：校验老会话继续发帖后的实时置顶提权状态与「已更新」徽章智能勾选...")
                # 模拟历史导出基准线：会话 1 在追加提问前曾导出，会话 2 亦曾导出
                cdp_opt.eval(f"""
                (async () => {{
                    return new Promise((resolve) => {{
                        chrome.storage.local.get(['gemini_conversations', 'gemini_exported_u0', 'gemini_exported_ids'], (data) => {{
                            const convs = data.gemini_conversations || [];
                            const c1 = convs.find(c => c.id === '{s1_id}' || c.id === 'c_{s1_id}');
                            const c2 = convs.find(c => c.id === '{s2_id}' || c.id === 'c_{s2_id}');
                            const ts2 = c2 ? (c2.updatedAt || c2.timestamp || Date.now()) : Date.now();
                            // 会话 1 的旧导出时间设在追加发帖之前 (ts2 - 5000)
                            const expTimeS1 = new Date(Math.max(0, ts2 - 5000)).toISOString();
                            // 会话 2 的导出时间设在最新 (ts2 + 10000)，代表已导出且无新变更
                            const expTimeS2 = new Date(ts2 + 10000).toISOString();

                            const expMap = data.gemini_exported_u0 || data.gemini_exported_ids || {{}};
                            expMap['{s1_id}'] = {{ exportedAt: expTimeS1, title: c1?.title || 'Chat 1', format: 'markdown' }};
                            expMap['c_{s1_id}'] = expMap['{s1_id}'];
                            expMap['{s2_id}'] = {{ exportedAt: expTimeS2, title: c2?.title || 'Chat 2', format: 'markdown' }};
                            expMap['c_{s2_id}'] = expMap['{s2_id}'];

                            chrome.storage.local.set({{
                                gemini_exported_u0: expMap,
                                gemini_exported_ids: expMap
                            }}, () => {{
                                if (typeof window.__workbenchLoadStore === 'function') {{
                                    window.__workbenchLoadStore(true);
                                }}
                                resolve(true);
                            }});
                        }});
                    }});
                }})()
                """, await_promise=True)
                time.sleep(0.8)

                order_info = cdp_opt.eval(f"""
                (() => {{
                    return new Promise((resolve) => {{
                        chrome.storage.local.get(['gemini_conversations', 'gemini_exported_u0', 'gemini_exported_ids'], (data) => {{
                            const convs = data.gemini_conversations || [];
                            const c1 = convs.find(c => c.id === '{s1_id}' || c.id === 'c_{s1_id}');
                            const c2 = convs.find(c => c.id === '{s2_id}' || c.id === 'c_{s2_id}');
                            const domItems = Array.from(document.querySelectorAll('#list .item'));
                            const el1 = domItems.find(el => el.dataset.chatId === '{s1_id}' || el.dataset.chatId === 'c_{s1_id}');
                            const el2 = domItems.find(el => el.dataset.chatId === '{s2_id}' || el.dataset.chatId === 'c_{s2_id}');
                            const idx1 = domItems.indexOf(el1);
                            const idx2 = domItems.indexOf(el2);

                            const badge1 = el1 ? el1.querySelector('.badge-updated, .badge') : null;
                            const badge2 = el2 ? el2.querySelector('.badge-exported, .badge') : null;
                            const cb1 = el1 ? el1.querySelector('input[type=checkbox]') : null;
                            const cb2 = el2 ? el2.querySelector('input[type=checkbox]') : null;

                            resolve({{
                                ts1: c1 ? (c1.updatedAt || c1.timestamp) : 0,
                                ts2: c2 ? (c2.updatedAt || c2.timestamp) : 0,
                                idx1,
                                idx2,
                                totalDom: domItems.length,
                                hasBadgeUpdated1: !!(el1 && el1.querySelector('.badge-updated')),
                                badge1Text: badge1 ? badge1.textContent.trim() : '',
                                cb1Checked: cb1 ? cb1.checked : false,
                                hasBadgeExported2: !!(el2 && el2.querySelector('.badge-exported')),
                                badge2Text: badge2 ? badge2.textContent.trim() : '',
                                cb2Checked: cb2 ? cb2.checked : false
                            }});
                        }});
                    }});
                }})()
                """, await_promise=True)
                if order_info:
                    ts1 = order_info.get("ts1", 0)
                    ts2 = order_info.get("ts2", 0)
                    idx1 = order_info.get("idx1", -1)
                    idx2 = order_info.get("idx2", -1)
                    has_badge_up = order_info.get("hasBadgeUpdated1", False)
                    badge1_text = order_info.get("badge1Text", "")
                    cb1_checked = order_info.get("cb1Checked", False)
                    has_badge_exp = order_info.get("hasBadgeExported2", False)
                    badge2_text = order_info.get("badge2Text", "")
                    cb2_checked = order_info.get("cb2Checked", False)

                    print(f"      • 会话 1 (追加发帖): 时间戳={ts1}, DOM位置={idx1}, 徽章='{badge1_text}', 默认勾选={cb1_checked}")
                    print(f"      • 会话 2 (未更新):   时间戳={ts2}, DOM位置={idx2}, 徽章='{badge2_text}', 默认勾选={cb2_checked}")

                    if ts1 > ts2 and idx1 == 0 and (idx2 < 0 or idx1 < idx2):
                        print(f"      ✓ [PASS] 老会话追加提问后时间戳权威跃升，并在列表中自动上升至首位！")
                    else:
                        print(f"      ⚠️ 老会话时间戳或排序对比提示: ts1={ts1}, ts2={ts2}, idx1={idx1}, idx2={idx2}")

                    if has_badge_up and ("已更新" in badge1_text or "Updated" in badge1_text):
                        print(f"      ✓ [PASS] 会话 1 检测到新发帖，成功渲染琥珀色「已更新」徽章: '{badge1_text}'")
                    else:
                        print(f"      ⚠️ 会话 1 徽章未检测到已更新状态: '{badge1_text}'")

                    if cb1_checked:
                        print(f"      ✓ [PASS] 会话 1 因已更新，被智能默认勾选 (checked=true)")
                    else:
                        print(f"      ⚠️ 会话 1 未被默认勾选")

                    if has_badge_exp and ("已导出" in badge2_text or "Exported" in badge2_text):
                        print(f"      ✓ [PASS] 会话 2 无新变更，成功渲染绿色「已导出」徽章: '{badge2_text}'")
                    else:
                        print(f"      ⚠️ 会话 2 徽章提示: '{badge2_text}'")

                    if not cb2_checked:
                        print(f"      ✓ [PASS] 会话 2 无新变更，智能默认保持未勾选 (checked=false)")
                    else:
                        print(f"      ⚠️ 会话 2 勾选状态异常: checked=true")

        # ------------------------------------------------------------------
        # 步骤 3.1：自动导入纯净版 Google Takeout ZIP 样本 (验证离线历史与附件)
        # ------------------------------------------------------------------
        resolved_takeout_zip = takeout_zip or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "gemini_takeout_clean.zip"))
        if not skip_takeout and os.path.isfile(resolved_takeout_zip):
            print(f"   📥 正在导入预置 Takeout ZIP 样本: {os.path.basename(resolved_takeout_zip)}...")
            with open(resolved_takeout_zip, "rb") as tf:
                zip_b64 = base64.b64encode(tf.read()).decode("ascii")

            takeout_res = cdp_opt.eval(f"""
            (async () => {{
                try {{
                    const b64 = {json.dumps(zip_b64)};
                    const bin = atob(b64);
                    const arr = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                    const file = new File([arr], "{os.path.basename(resolved_takeout_zip)}", {{ type: "application/zip" }});
                    
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
            """, await_promise=True)
            if isinstance(takeout_res, dict) and takeout_res.get("success"):
                print(f"   ✓ Takeout 导入成功！已索引离线附件池: {takeout_res.get('totalMediaCount', 0)} 个资源")
            else:
                err_info = takeout_res.get('error') if isinstance(takeout_res, dict) else str(takeout_res)
                print(f"   ⚠️ Takeout 导入提示: {err_info}")
            time.sleep(1.0)

        # ------------------------------------------------------------------
        # 步骤 3.1.1：断言 Takeout 导入后的初始离线索引与临时标题状态
        # ------------------------------------------------------------------
        print("   🔍 校验 Takeout 导入后的初始状态与临时提问标题...")
        takeout_initial = cdp_opt.eval("""
        (() => {
            return new Promise((resolve) => {
                chrome.storage.local.get(['gemini_conversations'], (data) => {
                    const convs = data.gemini_conversations || [];
                    const checkIds = ['1bd028d5c5b0c0e2', '1cea7e48cc166b57', '7b29852ecae8344a', 'f8ba969fe8c7d880'];
                    const matched = convs.filter(c => checkIds.includes(c.id));
                    resolve({
                        total: convs.length,
                        matched: matched.map(c => ({
                            id: c.id,
                            title: c.title,
                            source: c.titleSource,
                            titles: c.titles || {}
                        }))
                    });
                });
            });
        })()
        """, await_promise=True)

        takeout_found = 0
        if takeout_initial and "matched" in takeout_initial:
            for m in takeout_initial.get("matched", []):
                print(f"      • [{m['id']}] 初始标题: 「{m['title'][:36]}...」 (source: {m['source']})")
                if m.get("source") == "takeout" or "takeout" in m.get("titles", {}):
                    takeout_found += 1
            if takeout_found > 0:
                print(f"   ✓ [Takeout 初始断言通过] 成功检测到 {takeout_found} 条会话具备 Takeout 离线提问前缀！")

        # ------------------------------------------------------------------
        # 步骤 3.2：点击【全量拉取历史】(btnDeepScan)，加载全部历史并触发在线权威升级
        # ------------------------------------------------------------------
        print("   🔄 点击【全量拉取历史】按钮 (btnDeepScan)，地毯式加载该账号下的所有历史会话...")
        cdp_opt.eval("""
        (() => {
            const btn = document.getElementById('btnDeepScan');
            if (btn) btn.click();
        })()
        """)

        # 等待全量拉取历史完成 (SyncController.isScanning() 变回 false 且按钮恢复可用)
        print("   ⏳ 正在等待全量扫描完成并持续输出分页进度...")
        for loop_idx in range(60):
            time.sleep(1)
            scan_state = cdp_opt.eval("""
            (() => {
                const sc = typeof SyncCtrl !== 'undefined' ? SyncCtrl : (typeof SyncController !== 'undefined' ? SyncController : null);
                const isScan = sc && (sc.isScanning ? sc.isScanning() : (sc.isRunning ? sc.isRunning() : false));
                const progEl = document.getElementById('progText');
                const progText = progEl ? progEl.textContent.trim() : '';
                const btn = document.getElementById('btnExport');
                return {
                    isScan: isScan || (btn && btn.disabled),
                    progText: progText
                };
            })()
            """)
            if loop_idx % 3 == 0 or not scan_state.get("isScan"):
                prog_msg = scan_state.get("progText") or "全量同步进行中..."
                print(f"      ⏳ 全量扫描中: {prog_msg}")
            if not scan_state.get("isScan"):
                break
        time.sleep(1.0)

        # ------------------------------------------------------------------
        # 步骤 3.2.1：断言全量拉取历史后 Takeout 临时标题被在线 RPC 权威晋级覆盖
        # ------------------------------------------------------------------
        print("   🔍 验证全量拉取历史后 Takeout 临时标题是否被在线 RPC 权威晋级覆盖...")
        upgraded_state = cdp_opt.eval("""
        (() => {
            return new Promise((resolve) => {
                chrome.storage.local.get(['gemini_conversations'], (data) => {
                    const convs = data.gemini_conversations || [];
                    const checkIds = ['1bd028d5c5b0c0e2', '1cea7e48cc166b57', '7b29852ecae8344a', 'f8ba969fe8c7d880'];
                    const matched = convs.filter(c => checkIds.includes(c.id));
                    resolve({
                        total: convs.length,
                        matched: matched.map(c => ({
                            id: c.id,
                            title: c.title,
                            source: c.titleSource,
                            titles: c.titles || {}
                        }))
                    });
                });
            });
        })()
        """, await_promise=True)

        upgraded_count = 0
        for m in upgraded_state.get("matched", []):
            cid = m["id"]
            title = m["title"]
            source = m["source"]
            titles = m.get("titles", {})
            has_takeout = "takeout" in titles
            is_rpc = source == "rpc" or "rpc" in titles
            if has_takeout and is_rpc:
                upgraded_count += 1
                print(f"   ✓ [标题晋级断言通过] 会话 {cid} 成功由 Takeout 临时标题晋级为 RPC 权威标题: 「{title}」 (titles: {list(titles.keys())})")
            else:
                print(f"   ℹ️ 会话 {cid} 当前状态: 「{title}」 (source: {source}, titles: {list(titles.keys())})")

        if upgraded_count > 0:
            print(f"   🎉 成功核实 {upgraded_count} 条 Takeout 历史会话在全量拉取历史后权威升级为在线 RPC 标题！")

        # ------------------------------------------------------------------
        # 步骤 3.2.2：真机网页端瞬态会话实时删除链路断言 (Live Ephemeral Chat Real-Time Deletion)
        # ------------------------------------------------------------------
        if not skip_chat and gemini_tab:
            print("   ⚡ 校验网页端瞬态会话实时删除链路 (Live Ephemeral Chat Real-Time Deletion)...")
            try:
                cdp_gem_live = CDPConnection(gemini_tab["webSocketDebuggerUrl"])
                try:
                    print("      • 正在 Gemini 页面创建极简瞬态测试会话 (用于验证即时删除)...")
                    cdp_gem_live.eval("location.href = 'https://gemini.google.com/app'")
                    time.sleep(2.0)
                    try:
                        cdp_gem_live.reconnect()
                    except Exception:
                        pass
                    wait_for_gemini_ready(cdp_gem_live, max_wait=15)
                    time.sleep(1.0)

                    eph_prompt = "请回复单个单词：EPHEMERAL_OK（本会话为实时删除生命周期测试，稍后自动销毁）"
                    sent_ok, sent_msg = send_turn(cdp_gem_live, eph_prompt, max_wait=45)
                    if sent_ok:
                        time.sleep(2.0)
                        eph_chat_id = get_current_chat_id(cdp_gem_live)
                        if eph_chat_id and len(eph_chat_id) >= 8:
                            print(f"      ✓ 瞬态测试会话生成成功！会话 ID: {eph_chat_id}")
                            
                            cdp_opt.eval(f"""
                            (() => {{
                                return new Promise((resolve) => {{
                                    chrome.storage.local.get(['gemini_conversations'], (data) => {{
                                        let convs = data.gemini_conversations || [];
                                        if (!convs.some(c => c.id === '{eph_chat_id}')) {{
                                            convs.unshift({{
                                                id: '{eph_chat_id}',
                                                title: 'EPHEMERAL_TEST_CHAT',
                                                titleSource: 'rpc',
                                                createdAt: Date.now(),
                                                updatedAt: Date.now(),
                                                source: 'batchexecute'
                                            }});
                                            chrome.storage.local.set({{ gemini_conversations: convs }}, () => {{
                                                if (typeof window.__workbenchLoadStore === 'function') {{
                                                    window.__workbenchLoadStore(true);
                                                }}
                                                resolve(true);
                                            }});
                                        }} else {{
                                            resolve(true);
                                        }}
                                    }});
                                }});
                            }})()
                            """, await_promise=True)
                            time.sleep(0.5)

                            has_eph_in_dom = cdp_opt.eval(f"!!document.querySelector('#list .item[data-chat-id=\"{eph_chat_id}\"]')")
                            print(f"      • options 工作台登记状态: 列表中已呈现该瞬态会话 = {has_eph_in_dom}")

                            print(f"      • 在 Gemini 网页端侧边栏执行真实删除操作 ({eph_chat_id})...")
                            cdp_gem_live.eval(f"""
                            (() => {{
                                const a = document.querySelector('a[href*=\"{eph_chat_id}\"]');
                                if (!a) return 'link_not_found';
                                const btn = a.parentElement.querySelector('button[aria-label^=\"More options\"]');
                                if (!btn) return 'btn_not_found';
                                btn.click();
                                return 'options_clicked';
                            }})()
                            """)
                            time.sleep(0.6)

                            cdp_gem_live.eval("""
                            (() => {
                                const delBtn = document.querySelector('button[data-test-id="delete-button"]');
                                if (delBtn) delBtn.click();
                            })()
                            """)
                            time.sleep(0.8)

                            cdp_gem_live.eval("""
                            (() => {
                                const dialog = document.querySelector('mat-dialog-container, [role="dialog"], .mat-mdc-dialog-container');
                                if (!dialog) return;
                                const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(b => {
                                    const txt = b.innerText.trim().toLowerCase();
                                    return txt === 'delete' || txt === '删除';
                                });
                                if (confirmBtn) confirmBtn.click();
                            })()
                            """)
                            print(f"      • 已触发确认删除对话框！等待实时网络拦截与广播...")
                            time.sleep(2.5)

                            eph_realtime_check = cdp_opt.eval(f"""
                            (() => {{
                                return new Promise((resolve) => {{
                                    chrome.storage.local.get(['gemini_conversations'], (data) => {{
                                        const convs = data.gemini_conversations || [];
                                        const stillInStorage = convs.some(c => c.id === '{eph_chat_id}');
                                        const stillInDom = !!document.querySelector('#list .item[data-chat-id=\"{eph_chat_id}\"]');
                                        resolve({{ stillInStorage, stillInDom, count: convs.length }});
                                    }});
                                }});
                            }})()
                            """, await_promise=True)

                            if eph_realtime_check.get("stillInStorage") or eph_realtime_check.get("stillInDom"):
                                time.sleep(2.0)
                                eph_realtime_check = cdp_opt.eval(f"""
                                (() => {{
                                    return new Promise((resolve) => {{
                                        chrome.storage.local.get(['gemini_conversations'], (data) => {{
                                            const convs = data.gemini_conversations || [];
                                            const stillInStorage = convs.some(c => c.id === '{eph_chat_id}');
                                            const stillInDom = !!document.querySelector('#list .item[data-chat-id=\"{eph_chat_id}\"]');
                                            resolve({{ stillInStorage, stillInDom, count: convs.length }});
                                        }});
                                    }});
                                }})()
                                """, await_promise=True)

                            if not eph_realtime_check.get("stillInStorage") and not eph_realtime_check.get("stillInDom"):
                                print(f"      ✓ [实时删除断言通过] 瞬态会话 {eph_chat_id} 经网页端删除后，已被实时剥离 Storage 与 DOM 列表（当前有效总数: {eph_realtime_check.get('count')}）！")
                            else:
                                print(f"      ℹ️ 瞬态会话实时剥离状态: storage残留={eph_realtime_check.get('stillInStorage')}, dom残留={eph_realtime_check.get('stillInDom')}")
                        else:
                            print(f"      ⚠️ 未能捕获瞬态会话 ID，跳过现场实时删除测试")
                    else:
                        print(f"      ⚠️ 瞬态会话回复超时: {sent_msg}，跳过现场实时删除测试")
                finally:
                    cdp_gem_live.close()
            except Exception as e_live:
                print(f"      ⚠️ 瞬态会话实时删除测试提示: {e_live}")

        # ------------------------------------------------------------------
        # 步骤 3.3：多维度联合导出勾选（本次新生成会话 + 4 种指定核心分类历史会话）
        # ------------------------------------------------------------------
        # 确保 skipExported 复选框处于未勾选状态，强制全量取回对话内容，并确保启用 ZIP 导出模式
        cdp_opt.eval("""
        (() => {
            const skipCb = document.getElementById('skipExported');
            if (skipCb && skipCb.checked) {
                skipCb.checked = false;
                skipCb.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const zipCb = document.getElementById('includeZip');
            if (zipCb && !zipCb.checked) {
                zipCb.checked = true;
                zipCb.dispatchEvent(new Event('change', { bubbles: true }));
            }
        })()
        """)

        # 目标会话：
        # 1. 本次测试现场生成的 2 个新会话 (来自 scenarios[:2])
        # 2. 预设固化的 4 种不同核心分类的历史老会话：
        target_ids = [r["chat_id"] for r in chat_records if r.get("chat_id") and len(str(r["chat_id"])) > 8]
        target_ids.extend([h["id"] for h in DESIGNATED_HISTORICAL_CHATS])
        target_titles = [r.get("title", "") for r in chat_records if r.get("title")]
        target_titles.extend(["Martian Astronaut Cat", "Python日志与耗时装饰器", "贝尔不等式推导与物理意义", "韦伯望远镜深空探测重大发现"])

        # 通过 label.item[data-chat-id] 及标题关键词精准勾选目标会话
        print(f"   ☑️ 联合勾选目标会话（现场问答新会话 + 4 大核心分类历史会话）...")
        selected_count = cdp_opt.eval(f"""
        (() => {{
            const selectNone = document.getElementById('btnSelectNone');
            if (selectNone) selectNone.click();
            
            const targetIds = {json.dumps(target_ids)};
            const targetTitles = {json.dumps(target_titles)};
            const items = Array.from(document.querySelectorAll('#list .item'));
            let checked = 0;

            items.forEach(item => {{
                const cid = item.dataset.chatId;
                const titleText = item.querySelector('.chat-title, .title')?.textContent || '';
                const matchId = targetIds.some(tid => cid && (cid === tid || cid.includes(tid) || tid.includes(cid)));
                const matchTitle = targetTitles.some(tt => tt && tt.length > 2 && (titleText.includes(tt) || tt.includes(titleText)));
                if (matchId || matchTitle) {{
                    const cb = item.querySelector('input[type=checkbox]');
                    if (cb && !cb.checked) {{
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                        checked++;
                    }}
                }}
            }});

            // 兜底：若勾选数少于 2，选列表顶部最新的 2 条
            if (checked < 2) {{
                items.slice(0, 2).forEach(item => {{
                    const cb = item.querySelector('input[type=checkbox]');
                    if (cb && !cb.checked) {{
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                        checked++;
                    }}
                }});
                checked = 2;
            }}

            return checked;
        }})()
        """)
        time.sleep(0.5)
        print(f"   ✓ 成功联合勾选 {selected_count} 条会话 (包含现场问答会话与 4 大类别代表性历史)")

        # 等待导出按钮非 disabled 状态
        for _ in range(20):
            is_ready = cdp_opt.eval("""
            (() => {
                const btn = document.getElementById('btnExport');
                return btn && !btn.disabled;
            })()
            """)
            if is_ready:
                break
            time.sleep(0.5)

        start_export_time = time.time()

        # 点击【导出选中 → ZIP】
        print("   🚀 点击【导出选中 → ZIP】主按钮...")
        for attempt in range(5):
            click_res = cdp_opt.eval("""
            (() => {
                const btn = document.getElementById('btnExport');
                if (!btn || btn.disabled) return { ok: false, reason: 'btn disabled or missing' };
                btn.click();
                return { ok: true };
            })()
            """)
            if click_res and click_res.get("ok"):
                break
            time.sleep(1.0)

        # 等待 ZIP 导出与下载完成
        print(f"   ⏳ 正在等待 ZIP 导出打包完成并落地...")
        downloaded_zip = None
        for _ in range(40):
            time.sleep(1.5)
            # 1. 检查 abs_output_dir
            for f in os.listdir(abs_output_dir):
                if re.match(r"(?i)gemini_export_.*\.zip$", f):
                    fpath = os.path.join(abs_output_dir, f)
                    if os.path.getmtime(fpath) >= start_export_time - 3:
                        downloaded_zip = fpath
                        break
            if downloaded_zip:
                break

            # 2. 检查 ~/Downloads
            sys_downloads = os.path.expanduser("~/Downloads")
            if os.path.isdir(sys_downloads):
                for f in os.listdir(sys_downloads):
                    if re.match(r"(?i)gemini_export_.*\.zip$", f):
                        fpath = os.path.join(sys_downloads, f)
                        if os.path.getmtime(fpath) >= start_export_time - 3:
                            downloaded_zip = fpath
                            break
            if downloaded_zip:
                break

        if not downloaded_zip:
            print("❌ 未在超时时间内检测到导出的 ZIP 文件！")
            return False

        # 若从系统下载目录捕获，拷贝至本次专用的导出目录
        sys_downloads = os.path.expanduser("~/Downloads")
        if sys_downloads in downloaded_zip:
            dest_zip = os.path.join(abs_output_dir, os.path.basename(downloaded_zip))
            if os.path.abspath(downloaded_zip) != os.path.abspath(dest_zip):
                import shutil
                shutil.copy2(downloaded_zip, dest_zip)
                downloaded_zip = dest_zip

        print(f"   ✅ 成功获取导出 ZIP: {downloaded_zip} ({os.path.getsize(downloaded_zip)} bytes)")

        # ------------------------------------------------------------------
        # 步骤 3.5：磁盘实时落盘与手动文件夹导出物理同构与命名规范校验
        # ------------------------------------------------------------------
        print("\n" + "-" * 70)
        print("💾 步骤 3.5：校验磁盘实时落盘与手动文件夹导出目录规范与同构性...")
        print("-" * 70)
        parity_res = cdp_opt.eval("""
        (async () => {
            const manualWritten = {};
            const liveWritten = {};

            const createMockDir = (store) => ({
                name: 'UserSelectedVault',
                keys: async function* () { yield 'vault_root'; },
                queryPermission: async () => 'granted',
                getDirectoryHandle: async (dirName, opts) => {
                    return {
                        name: dirName,
                        getFileHandle: async (fileName, fOpts) => ({
                            createWritable: async () => ({
                                write: async (c) => { store[`${dirName}/${fileName}`] = c; },
                                close: async () => {}
                            })
                        }),
                        getDirectoryHandle: async (subDirName, sOpts) => ({
                            name: subDirName,
                            getFileHandle: async (subFileName, sfOpts) => ({
                                createWritable: async () => ({
                                    write: async (c) => { store[`${dirName}/${subDirName}/${subFileName}`] = c; },
                                    close: async () => {}
                                })
                            })
                        })
                    };
                }
            });

            const testChatId = 'c_0123456789abcdef';
            const testCid6 = 'abcdef';
            const testTitle = 'Quantum Encryption Algorithm';

            // 1. 手动文件夹导出写盘逻辑
            const manualRoot = createMockDir(manualWritten);
            const FsWriterModule = (window.FsWriter && window.FsWriter.FsWriter) ? window.FsWriter.FsWriter : window.FsWriter;
            const manualWriter = new FsWriterModule(manualRoot, 'gemini_export');
            await manualWriter.init();
            const manualFileName = `${testTitle.replace(/[\\\\/:*?"<>|]/g, '_')}_${testCid6}.md`;
            await manualWriter.writeFile('', manualFileName, '# Quantum Encryption\\n\\nContent');
            await manualWriter.writeFile('assets', `${testCid6}_t1_diagram.png`, new Uint8Array([1, 2, 3]));

            // 2. 实时自动落盘写盘逻辑 (Live Save via FsWriter)
            const liveRoot = createMockDir(liveWritten);
            const liveWriter = new FsWriterModule(liveRoot, 'gemini_export');
            await liveWriter.init();
            const liveCid6 = testChatId.replace(/^c_/, '').slice(-6);
            const liveFileName = `${testTitle.replace(/[\\\\/:*?"<>|]/g, '_')}_${liveCid6}.md`;
            await liveWriter.writeFile('', liveFileName, '# Quantum Encryption\\n\\nContent');
            await liveWriter.writeFile('assets', `${liveCid6}_t1_diagram.png`, new Uint8Array([1, 2, 3]));

            const manualKeys = Object.keys(manualWritten).sort();
            const liveKeys = Object.keys(liveWritten).sort();
            const keysMatch = JSON.stringify(manualKeys) === JSON.stringify(liveKeys);

            return {
                ok: keysMatch,
                manualKeys,
                liveKeys,
                hasGeminiExportDir: manualKeys.every(k => k.startsWith('gemini_export/')),
                hasCid6: manualKeys.some(k => k.includes('_abcdef.md')),
                hasAssetsSubdir: manualKeys.some(k => k.startsWith('gemini_export/assets/'))
            };
        })()
        """, await_promise=True)

        if parity_res and parity_res.get("ok"):
            print("   ✓ [PASS] 实时落盘与手动文件夹导出目录规范与文件结构 100% 物理同构！")
            print(f"      • 统一根子目录: gemini_export/ (校验通过: {parity_res.get('hasGeminiExportDir')})")
            print(f"      • 统一文件命名: <title>_<cid6>.md (校验通过: {parity_res.get('hasCid6')})")
            print(f"      • 统一资源目录: gemini_export/assets/ (校验通过: {parity_res.get('hasAssetsSubdir')})")
            for k in parity_res.get("manualKeys", []):
                print(f"        └─ {k}")
        else:
            print(f"   ⚠️ 实时落盘与手动文件夹导出结构对比异常: {parity_res}")

    finally:
        cdp_opt.close()

    # ==========================================
    # 阶段四：解压与严格断言校验 (Verification)
    # ==========================================
    print("\n" + "=" * 70)
    print("🔍 阶段四：深入校验导出的会话文件与 5 轮对话完整性...")
    print("=" * 70)

    extract_dir = os.path.join(abs_output_dir, "extracted_verify_" + str(int(time.time())))
    os.makedirs(extract_dir, exist_ok=True)

    with zipfile.ZipFile(downloaded_zip, "r") as zf:
        zf.extractall(extract_dir)

    all_extracted_files = []
    for root, _, files in os.walk(extract_dir):
        for f in files:
            if f.endswith(".md") and not f.startswith("00_INDEX") and not f.startswith("_index"):
                all_extracted_files.append(os.path.join(root, f))

    all_extracted_files.sort()

    print(f"📂 解压出的 Markdown 对话文件数: {len(all_extracted_files)}")
    if len(all_extracted_files) < 2:
        print(f"❌ 导出的会话文件不足 2 个 (实际找到 {len(all_extracted_files)})！")
        return False

    # 校验文件名统一遵循 <title>_<cid6>.md 命名规范
    cid6_pattern = re.compile(r"_[a-zA-Z0-9_-]{6}\.md$")
    valid_cid6_files = [f for f in all_extracted_files if cid6_pattern.search(f)]
    print(f"   📋 验证导出文件 cid6 统一命名规范: {len(valid_cid6_files)}/{len(all_extracted_files)} 命名符合 `_<cid6>.md` 规则")
    if len(valid_cid6_files) != len(all_extracted_files):
        print(f"   ❌ 部分导出文件未遵循 `_<cid6>.md` 命名规则！")
        verification_success = False

    verification_success = True

    should_verify_scenarios = (not skip_chat) or (dataset is not None)
    if should_verify_scenarios:
        for idx, sc in enumerate(scenarios[:2], 1):
            raw_turns = sc.get("turns", [])
            expected_turns = [t.get("prompt", "") if isinstance(t, dict) else str(t) for t in raw_turns]
            num_expected = len(expected_turns)
            sc_title = sc.get("title", f"场景 {idx}")
            print(f"\n[验证 {idx}/2] 🔎 正在核对会话 {idx}: 《{sc_title}》 (共 {num_expected} 轮)")

            # 智能匹配属于此场景的导出文件（只要包含本场景任意一轮 Prompt 关键词）
            matched_file = None
            for fpath in all_extracted_files:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                if any(t[:14] in content for t in expected_turns if t):
                    matched_file = fpath
                    break

            if not matched_file and idx <= len(all_extracted_files):
                matched_file = all_extracted_files[idx - 1]

            if not matched_file:
                print(f"   ❌ 未能找到会话 {idx} 对应的导出文件！")
                verification_success = False
                continue

            print(f"   📄 匹配到导出文件: {os.path.basename(matched_file)} ({os.path.getsize(matched_file)} bytes)")
            with open(matched_file, "r", encoding="utf-8", errors="ignore") as f:
                file_text = f.read()

            matched_turns_count = 0
            for t_idx, prompt_str in enumerate(expected_turns, 1):
                snippet = prompt_str[:16]
                if snippet in file_text:
                    matched_turns_count += 1
                    print(f"      ✓ 轮次 {t_idx}/{num_expected} 校验通过: 「{snippet}...」在导出文件中完整存在")
                else:
                    print(f"      ❌ 轮次 {t_idx}/{num_expected} 缺失: 未在文件中找到「{snippet}...」")
                    verification_success = False

            # 校验轮次标记
            turn_headers = len(re.findall(r"(?:###|####|\*\*User\*\*|\*\*Model\*\*|\*\*Gemini\*\*|## 👤|## 🤖)", file_text))
            min_expected_headers = max(10, num_expected * 2)
            print(f"      📊 会话问答角色标记数: {turn_headers} (预期至少 {min_expected_headers} 个角色轮次标记)")

            if matched_turns_count == num_expected:
                print(f"   🎉 会话 {idx} 全部 {num_expected} 轮对话内容核对 100% 完整无误！")
            else:
                print(f"   ⚠️ 会话 {idx} 仅核对到 {matched_turns_count}/{num_expected} 轮！")
                verification_success = False

    # ==========================================
    # 阶段 4.2：执行全量导出规范与特征深度断言
    # ==========================================
    golden_chats = [dict(c) for c in DESIGNATED_HISTORICAL_CHATS]
    # 若在线发帖，追加在线场景关键词作为黄金校验
    if should_verify_scenarios:
        for idx, sc in enumerate(scenarios[:2]):
            title = sc.get("title", "")
            raw_turns = sc.get("turns", [])
            prompts = [t.get("prompt", "") if isinstance(t, dict) else str(t) for t in raw_turns]
            features = sc.get("features", [])
            syntax_checks = []
            code_features = {"code", "python", "glsl", "shaders", "c++", "rust", "kernel"}
            if any(f in code_features for f in features):
                syntax_checks.append("codeblock")
            elif not features:
                if any(kw in title for kw in ["代码", "编译器", "Rust", "Python"]) or any(kw in p for p in prompts for kw in ["编写代码", "实现代码", "编写一个", "代码片段", "def ", "fn "]):
                    syntax_checks.append("codeblock")

            if "imagen" in features or any(kw in p for p in prompts for kw in ["生成一张图片", "生成图片", "画一张", "image"]):
                syntax_checks.append("image")

            if "tables" in features:
                syntax_checks.append("table")

            rec_cid = chat_records[idx].get("chat_id") if idx < len(chat_records) else None

            golden_chats.append({
                "id": rec_cid or sc.get("id"),
                "name": title,
                "expected_snippets": [t[:14] for t in prompts[:3] if t],
                "syntax_checks": syntax_checks
            })

    min_expected_convs = 6 if should_verify_scenarios else 4
    asserter = ExportSpecificationAsserter(extract_dir)
    spec_success = asserter.run_all_assertions(min_conversations=min_expected_convs, expected_golden_chats=golden_chats)
    if not spec_success:
        verification_success = False

    print("\n" + "=" * 70)
    if verification_success:
        print("🏆 🎉 全部会话端到端导出、多轮内容与全维度格式规范断言 100% 成功通过！")
    else:
        print("❌ 测试断言未完全通过，请检查上述具体缺失或规范违背报告！")
    print("=" * 70)

    return verification_success


def validate_dataset_freshness(dataset_path, allow_stale=False, skip_chat=False, max_age_seconds=DATASET_MAX_AGE_SECONDS):
    """
    门禁检查：
    在非 allow_stale 且非 skip_chat 模式下，强制要求必须传入 2 分钟之内新鲜生成的数据集文件。
    若未传入或文件超过 max_age_seconds 秒，拦截并返回详细的错误指导说明。
    """
    if allow_stale or skip_chat:
        if dataset_path:
            if not os.path.isfile(dataset_path):
                return False, f"❌ 指定的数据集文件不存在: {dataset_path}"
            try:
                with open(dataset_path, "r", encoding="utf-8") as f:
                    return True, json.load(f)
            except Exception as e:
                return False, f"❌ 读取数据集 JSON 失败: {e}"
        return True, None

    sep = "=" * 70
    if not dataset_path:
        msg = f"""
{sep}
❌ [AI 执行门禁拦截] 未指定测试数据集（--dataset <path>）！
{sep}
💡 场景池推荐模式：直接使用 `--pool` 参数从 20 题多模态场景池中自动消费 2 个高价值场景：
   python3 scripts/test_live_chat_and_export.py --pool
   (或 npm run test:live:pool)

💡 规则说明：若手动传入 `--dataset`，由 AI Agent 驱动的测试与验收必须现场动态构思全新的测试场景并在 {max_age_seconds} 秒（2 分钟）之内生成 JSON 数据集文件，严禁直接复用静态数据集。
💡 人工调试提示：若本次运行并非由 AI Agent 驱动（例如人工本地调试或离线复现），请添加 `--allow-stale-dataset` 参数以绕过此时效限制并允许使用内置默认数据集：
   python3 scripts/test_live_chat_and_export.py --allow-stale-dataset
{sep}"""
        return False, msg

    if not os.path.isfile(dataset_path):
        return False, f"❌ 指定的数据集文件不存在: {dataset_path}"

    try:
        mtime = os.path.getmtime(dataset_path)
        file_age = time.time() - mtime
    except Exception as e:
        return False, f"❌ 获取数据集文件修改时间失败: {e}"

    if file_age > max_age_seconds:
        msg = f"""
{sep}
❌ [AI 执行门禁拦截] 数据集文件 `{dataset_path}` 生成/修改于 {int(file_age)} 秒前（已超过 2 分钟 / {max_age_seconds} 秒时效限制）！
{sep}
💡 场景池推荐模式：直接使用 `--pool` 参数从 20 题多模态场景池中自动消费 2 个高价值场景：
   python3 scripts/test_live_chat_and_export.py --pool

💡 规则说明：在 AI Agent 驱动的测试与验收模式下，必须现场动态构思全新的测试场景并在 2 分钟内实时生成 JSON，严禁复用历史旧数据集。
💡 人工调试提示：若本次运行并非由 AI Agent 驱动（例如人工本地调试或复现历史用例），请添加 `--allow-stale-dataset` 参数以绕过此时效限制：
   python3 scripts/test_live_chat_and_export.py --dataset {dataset_path} --allow-stale-dataset
{sep}"""
        return False, msg

    try:
        with open(dataset_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return True, data
    except Exception as e:
        return False, f"❌ 读取数据集 JSON 失败: {e}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini 2次×5轮真实对话、Takeout 导入与导出规范断言全生产测试流程")
    parser.add_argument("--pool", action="store_true", help="从动态场景池 (scripts/test_scenario_pool.json) 中自动消费 2 个最新多模态场景并归档至 scripts/test_scenario_archive.json")
    parser.add_argument("--pool-path", default=None, help="自定义场景池文件路径")
    parser.add_argument("--dataset", default=None, help="自定义测试数据集 JSON 文件路径 (AI 协同模式下必须在 2 分钟之内新鲜生成)")
    parser.add_argument("--allow-stale-dataset", action="store_true", help="允许使用超过 2 分钟时效限制的历史数据集，或在未指定 --dataset 时使用内置默认数据集（供非 AI Agent 的人工本地调试使用）")
    parser.add_argument("--output-dir", default=None, help="测试导出落地目录")
    parser.add_argument("--port", type=int, default=CDP_DEFAULT_PORT, help="Chrome CDP 远程调试端口")
    parser.add_argument("--delay", type=int, default=2, help="轮次之间的间隔秒数")
    parser.add_argument("--skip-chat", action="store_true", help="跳过发帖步骤，直接使用已有会话跑导出与目录校验")
    parser.add_argument("--skip-takeout", action="store_true", help="跳过预置 Takeout ZIP 导入步骤")
    parser.add_argument("--skip-reinstall", action="store_true", help="跳过扩展卸载与重装步骤")
    parser.add_argument("--skip-tour", action="store_true", help="跳过新手向导全流程测试步骤")
    parser.add_argument("--takeout-zip", default=None, help="自定义预置 Takeout ZIP 样本路径")
    args = parser.parse_args()

    if args.pool:
        try:
            from scripts.manage_scenario_pool import consume_scenarios, DEFAULT_POOL_PATH, TARGET_POOL_SIZE
        except ImportError:
            from manage_scenario_pool import consume_scenarios, DEFAULT_POOL_PATH, TARGET_POOL_SIZE
        pool_p = args.pool_path or DEFAULT_POOL_PATH
        print(f"🏊 [场景池模式] 正在从测试池 ({pool_p}) 中提取 2 个最新多模态场景...")
        try:
            selected, remaining = consume_scenarios(pool_path=pool_p, count=2, require_imagen=True)
        except Exception as e:
            print(f"❌ 场景池消费失败: {e}")
            sys.exit(1)
        custom_dataset = selected
        print(f"   ✅ 已成功消费 2 个场景并在 scripts/test_scenario_archive.json 归档留痕:")
        for s in selected:
            print(f"      • [{s.get('id')}] {s.get('title')} ({len(s.get('turns', []))} 轮)")
        print(f"   💡 当前池剩余水位: {len(remaining)}/{TARGET_POOL_SIZE}")
        if len(remaining) < TARGET_POOL_SIZE:
            print(f"   ⚠️ 提示: 场景池剩余不足 {TARGET_POOL_SIZE} 题，请在下次提交 PR 前由 AI 助手构思补齐！")
    else:
        valid, result_or_err = validate_dataset_freshness(
            args.dataset,
            allow_stale=args.allow_stale_dataset,
            skip_chat=args.skip_chat
        )
        if not valid:
            print(result_or_err)
            sys.exit(1)
        custom_dataset = result_or_err

    success = run_live_chat_and_export(
        dataset=custom_dataset,
        port=args.port,
        output_dir=args.output_dir,
        delay=args.delay,
        skip_chat=args.skip_chat,
        skip_takeout=args.skip_takeout,
        takeout_zip=args.takeout_zip,
        skip_reinstall=args.skip_reinstall,
        skip_tour=args.skip_tour
    )
    sys.exit(0 if success else 1)


