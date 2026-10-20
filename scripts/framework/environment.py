# scripts/framework/environment.py
"""
Unified Test Environment Lifecycle Manager for Tier 2 and Tier 3.
Provides deterministic environment preparation:
- Extension clean reinstallation (Extensions.uninstall + Extensions.loadUnpacked)
- Tab discovery & creation (Gemini web app & Options workbench)
- Viewport standardization (Emulation.setDeviceMetricsOverride)
- Download directory routing (Browser & Page setDownloadBehavior)
- Content script reload and synchronization
"""

import os
import sys
import time
import json
import urllib.request
import urllib.parse
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple, Sequence

try:
    from scripts.cdp_client import (
        CDPConnection,
        get_tabs,
        get_extension_id,
        get_browser_ws_url,
        is_gemini_url,
        CDP_DEFAULT_PORT
    )
except ImportError:
    from cdp_client import (
        CDPConnection,
        get_tabs,
        get_extension_id,
        get_browser_ws_url,
        is_gemini_url,
        CDP_DEFAULT_PORT
    )

from scripts.framework.actions import ExtensionActions, CDPActions


@dataclass
class EnvironmentContext:
    """结构化环境生命周期上下文"""
    port: int
    ext_id: Optional[str]
    output_dir: str
    gemini_tab: Optional[Dict[str, Any]] = None
    options_tab: Optional[Dict[str, Any]] = None
    active_tab: Optional[Dict[str, Any]] = None
    active_cdp: Optional[Any] = None
    viewport_size: Tuple[int, int] = (1280, 800)
    extra: Dict[str, Any] = field(default_factory=dict)


class TestEnvironment:
    """
    Tier 2 统一测试环境生命周期与初始化管理器。
    为 Tier 2 (特性驱动 DAG) 与 Tier 3 (纯视觉 AI 沙盒/靶场) 提供唯一权威的环境生命周期管线：
    1. 浏览器可达性校验 (Ping CDP 9222)
    2. 扩展原生纯净重装 (Extensions.uninstall + Extensions.loadUnpacked)
    3. 目标标签页权威发现与幂等创建 (Gemini / Options)
    4. 视口规格标准化 (Emulation.setDeviceMetricsOverride 1280x800)
    5. 文件下载落盘重定向 (Browser/Page.setDownloadBehavior -> output_dir)
    6. Content Script 注入保障 (Gemini 页面幂等刷新与就绪等待)
    """

    def __init__(
        self,
        port: int = CDP_DEFAULT_PORT,
        output_dir: Optional[str] = None,
        viewport_size: Tuple[int, int] = (1280, 800),
        repo_path: Optional[str] = None
    ):
        self.port = port
        self.repo_path = os.path.abspath(repo_path or os.path.join(os.path.dirname(__file__), "..", ".."))
        self.output_dir = os.path.abspath(output_dir or os.path.join(self.repo_path, "tests", "output", "live_export"))
        self.viewport_size = viewport_size
        self.ext_id: Optional[str] = None
        self.browser_cdp: Optional[CDPConnection] = None
        os.makedirs(self.output_dir, exist_ok=True)

    def get_browser_cdp(self) -> Optional[CDPConnection]:
        """获取或复用持久化 Browser 级 CDP 连接以保证 Browser.grantPermissions 生命周期有效"""
        if self.browser_cdp is not None:
            return self.browser_cdp
        browser_ws = get_browser_ws_url(self.port)
        if browser_ws:
            try:
                self.browser_cdp = CDPConnection(browser_ws)
            except Exception:
                self.browser_cdp = None
        return self.browser_cdp

    def setup_permissions(self):
        """为当前扩展 Origin 授予 localFonts 权限，保证本地字体可被 Local Font Access 读取"""
        b_cdp = self.get_browser_cdp()
        if not b_cdp:
            return
        ext_id = self.get_extension_id()
        if not ext_id:
            return
        ext_origin = f"chrome-extension://{ext_id}"
        try:
            b_cdp.call("Browser.grantPermissions", {
                "permissions": ["localFonts"],
                "origin": ext_origin
            })
            b_cdp.call("Browser.setPermission", {
                "permission": {"name": "local-fonts"},
                "setting": "granted",
                "origin": ext_origin
            })
        except Exception:
            pass

    def reinstall_extension(self) -> Optional[str]:
        """通过 CDP 域指令纯净重装扩展并更新缓存的 ext_id"""
        if self.browser_cdp:
            try:
                self.browser_cdp.close()
            except Exception:
                pass
            self.browser_cdp = None
        new_id = CDPActions.reinstall_extension(port=self.port, repo_path=self.repo_path)
        if new_id:
            self.ext_id = new_id
        return new_id

    def get_extension_id(self) -> Optional[str]:
        if self.ext_id:
            return self.ext_id
        self.ext_id = get_extension_id(self.port)
        return self.ext_id

    def get_tabs(self) -> List[Dict[str, Any]]:
        return get_tabs(self.port)

    def get_gemini_tab(self) -> Optional[Dict[str, Any]]:
        tabs = self.get_tabs()
        return next((t for t in tabs if t.get("type", "page") == "page" and is_gemini_url(t.get("url", ""))), None)

    def ensure_gemini_tab(self) -> Optional[Dict[str, Any]]:
        """发现或幂等创建 Gemini Web 标签页"""
        tab = self.get_gemini_tab()
        if not tab:
            try:
                new_url = f"http://127.0.0.1:{self.port}/json/new?https://gemini.google.com/app"
                req = urllib.request.Request(new_url, method="PUT")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    tab = json.loads(resp.read().decode("utf-8"))
                    time.sleep(2.0)
            except Exception as e:
                print(f"   ⚠️ 自动创建 Gemini 标签页异常: {e}")
        return tab or self.get_gemini_tab()

    def get_options_tab(self) -> Optional[Dict[str, Any]]:
        ext_id = self.get_extension_id()
        tabs = self.get_tabs()
        if ext_id:
            options_url = f"chrome-extension://{ext_id}/src/ui/options/options.html"
            tab = next((t for t in tabs if t.get("type", "page") == "page" and options_url in t.get("url", "")), None)
            if tab:
                return tab
        return next((t for t in tabs if t.get("type", "page") == "page" and "options.html" in t.get("url", "")), None)

    def ensure_options_tab(self) -> Optional[Dict[str, Any]]:
        """发现或幂等创建 Options 导出工作台标签页"""
        tab = self.get_options_tab()
        if not tab:
            ext_id = self.get_extension_id()
            if ext_id:
                base_url = f"chrome-extension://{ext_id}/src/ui/options/options.html"
            else:
                base_url = "src/ui/options/options.html"
            try:
                new_url = f"http://127.0.0.1:{self.port}/json/new?{base_url}"
                req = urllib.request.Request(new_url, method="PUT")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    tab = json.loads(resp.read().decode("utf-8"))
                    time.sleep(1.0)
            except Exception as e:
                print(f"   ⚠️ 自动创建 Options 标签页异常: {e}")
        return tab or self.get_options_tab()

    def get_popup_tab(self) -> Optional[Dict[str, Any]]:
        """获取当前活跃的 Popup 标签页"""
        ext_id = self.get_extension_id()
        tabs = self.get_tabs()
        if ext_id:
            popup_url = f"chrome-extension://{ext_id}/src/ui/popup/popup.html"
            tab = next((t for t in tabs if t.get("type", "page") == "page" and popup_url in t.get("url", "")), None)
            if tab:
                return tab
        return next((t for t in tabs if t.get("type", "page") == "page" and "popup.html" in t.get("url", "")), None)

    def ensure_popup_tab(self) -> Optional[Dict[str, Any]]:
        """发现或幂等创建 Popup 动作中心标签页"""
        tab = self.get_popup_tab()
        if not tab:
            ext_id = self.get_extension_id()
            if ext_id:
                base_url = f"chrome-extension://{ext_id}/src/ui/popup/popup.html"
            else:
                base_url = "src/ui/popup/popup.html"
            try:
                new_url = f"http://127.0.0.1:{self.port}/json/new?{base_url}"
                req = urllib.request.Request(new_url, method="PUT")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    tab = json.loads(resp.read().decode("utf-8"))
                    time.sleep(1.0)
            except Exception as e:
                print(f"   ⚠️ 自动创建 Popup 标签页异常: {e}")
        return tab or self.get_popup_tab()

    def ensure_tab(self, target: str) -> Optional[Dict[str, Any]]:
        """统一按逻辑名解析并确保标签页就绪 (gemini|chat, options|workbench, 或 popup)"""
        t_lower = target.lower()
        if t_lower in ("gemini", "chat"):
            return self.ensure_gemini_tab()
        elif t_lower in ("popup",):
            return self.ensure_popup_tab()
        return self.ensure_options_tab()

    def connect_tab(self, target: str) -> CDPConnection:
        """为指定逻辑目标建立原生 CDPConnection"""
        tab = self.ensure_tab(target)
        if not tab or not tab.get("webSocketDebuggerUrl"):
            raise RuntimeError(f"标签页 '{target}' 不存在且无法建立 CDP 连接")
        conn = CDPConnection(tab["webSocketDebuggerUrl"])
        try:
            conn.call("Emulation.setFocusEmulationEnabled", {"enabled": True})
        except Exception:
            pass
        return conn

    def connect_gemini(self) -> CDPConnection:
        return self.connect_tab("gemini")

    def connect_options(self) -> CDPConnection:
        self.setup_permissions()
        conn = self.connect_tab("options")
        # 预热并缓存本地字体至 window.__geminiLocalFontsCache
        try:
            conn.eval("""
            (async () => {
                if (typeof window.queryLocalFonts === 'function' && (!window.__geminiLocalFontsCache || window.__geminiLocalFontsCache.length === 0)) {
                    try {
                        const fonts = await window.queryLocalFonts();
                        if (Array.isArray(fonts) && fonts.length > 0) {
                            window.__geminiLocalFontsCache = fonts;
                        }
                    } catch (e) {}
                }
            })()
            """, await_promise=True, user_gesture=True)
        except Exception:
            pass
        return conn

    def connect_popup(self) -> CDPConnection:
        return self.connect_tab("popup")

    def setup_viewport(self, cdp: Any, size: Optional[Tuple[int, int]] = None):
        """锁定标准化物理视口尺寸并清除缩放畸变"""
        if not cdp:
            return
        w, h = size or self.viewport_size
        try:
            cdp.call("Page.enable")
        except Exception:
            pass
        try:
            cdp.call("Emulation.clearDeviceMetricsOverride")
        except Exception:
            pass
        try:
            cdp.call("Emulation.setDeviceMetricsOverride", {
                "width": w,
                "height": h,
                "deviceScaleFactor": 1,
                "mobile": False
            })
        except Exception:
            pass

    def clear_viewport(self, cdp: Any):
        """恢复默认视口配置"""
        if not cdp:
            return
        try:
            cdp.call("Emulation.clearDeviceMetricsOverride")
        except Exception:
            pass

    def setup_download_behavior(self, output_dir: Optional[str] = None, cdp: Optional[Any] = None):
        """配置下载落盘路径至 output_dir (优先 Browser WS 拦截，支持 Page WS 双保险)"""
        target_dir = output_dir or self.output_dir
        os.makedirs(target_dir, exist_ok=True)

        b_cdp = self.get_browser_cdp()
        if b_cdp:
            try:
                b_cdp.call("Browser.setDownloadBehavior", {
                    "behavior": "allow",
                    "downloadPath": target_dir,
                    "eventsEnabled": True
                })
            except Exception:
                pass
        self.setup_permissions()

        if cdp:
            try:
                cdp.call("Page.setDownloadBehavior", {
                    "behavior": "allow",
                    "downloadPath": target_dir
                })
            except Exception:
                pass

    def reload_gemini_tab(
        self,
        gemini_tab: Optional[Dict[str, Any]] = None,
        wait_ready: bool = False,
        max_wait: int = 30
    ):
        """刷新 Gemini 页面以注入最新 Content Scripts 并可选等待输入框就绪"""
        tab = gemini_tab or self.ensure_gemini_tab()
        if not tab or not tab.get("webSocketDebuggerUrl"):
            return
        cdp_g = CDPConnection(tab["webSocketDebuggerUrl"])
        try:
            try:
                cdp_g.eval("location.reload()")
            except Exception:
                pass
            time.sleep(2.0)
            if wait_ready:
                CDPActions.wait_for_gemini_ready(cdp_g, max_wait=max_wait)
        finally:
            cdp_g.close()

    def init_environment(
        self,
        reinstall: bool = True,
        target_pages: Sequence[str] = ("gemini", "options"),
        active_target: Optional[str] = None,
        reload_gemini: bool = True,
        wait_gemini_ready: bool = False,
        setup_viewport: bool = True,
        setup_download: bool = True
    ) -> EnvironmentContext:
        """
        全量环境生命周期就绪初始化：
        1. 扩展卸载与纯净重装 (可选)
        2. 目标标签页权威发现与幂等创建
        3. Gemini 页面刷新 (若执行了重装且包含 Gemini)
        4. 全局下载路径拦截
        5. 活动连接视口与行为标准化
        """
        # 1. 扩展卸载与纯净重装
        if reinstall:
            print("\n🔄 [环境初始化] 通过 CDP 原生卸载并纯净安装当前工作区扩展代码...")
            ext_id = self.reinstall_extension()
            if not ext_id:
                raise RuntimeError(f"❌ 扩展安装失败 (端口 {self.port}, 路径 {self.repo_path})！")
            time.sleep(1.0)
            print(f"🧩 [环境初始化] 当前活跃扩展 ID: {ext_id}")
        else:
            self.get_extension_id()

        gemini_tab = None
        options_tab = None

        # 2. 准备标签页
        for page in target_pages:
            norm = "gemini" if page.lower() in ("gemini", "chat") else "options"
            if norm == "gemini":
                gemini_tab = self.ensure_gemini_tab()
                if reinstall and reload_gemini and gemini_tab:
                    print("   🔄 [环境初始化] 刷新 Gemini 页面以注入最新 Content Scripts...")
                    self.reload_gemini_tab(gemini_tab, wait_ready=wait_gemini_ready)
            elif norm == "options":
                options_tab = self.ensure_options_tab()

        # 3. 设置全局下载
        if setup_download:
            self.setup_download_behavior(self.output_dir)

        # 4. 连接活动标签页
        active_tab = None
        active_cdp = None
        if active_target:
            norm_active = "gemini" if active_target.lower() in ("gemini", "chat") else "options"
            active_tab = gemini_tab if norm_active == "gemini" else options_tab
            if not active_tab:
                active_tab = self.ensure_tab(norm_active)
            if active_tab and active_tab.get("webSocketDebuggerUrl"):
                active_cdp = CDPConnection(active_tab["webSocketDebuggerUrl"])
                if setup_viewport:
                    self.setup_viewport(active_cdp, self.viewport_size)
                if setup_download:
                    self.setup_download_behavior(self.output_dir, cdp=active_cdp)

        return EnvironmentContext(
            port=self.port,
            ext_id=self.ext_id,
            output_dir=self.output_dir,
            gemini_tab=gemini_tab,
            options_tab=options_tab,
            active_tab=active_tab,
            active_cdp=active_cdp,
            viewport_size=self.viewport_size
        )

    def teardown(self, cdp: Optional[Any] = None):
        """安全释放环境覆盖与连接"""
        if cdp:
            self.clear_viewport(cdp)
            try:
                cdp.close()
            except Exception:
                pass
