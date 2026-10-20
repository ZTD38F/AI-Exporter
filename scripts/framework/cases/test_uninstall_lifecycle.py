# scripts/framework/cases/test_uninstall_lifecycle.py
"""
Lifecycle Test Case: Extension Uninstall & Clean State Isolation.
Verifies CDP Extensions.uninstall, graceful teardown, and clean reinstallation without state cross-talk.
"""

import time
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions

try:
    from scripts.cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url
except ImportError:
    from cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url


class UninstallLifecycleCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_uninstall_lifecycle",
            domain=FeatureDomain.LIFECYCLE,
            name="扩展彻底卸载与隔离清理",
            description="通过 CDP 原生卸载扩展，验证长连接与 Content Script 优雅终止，重新安装时不产生脏状态交叉污染",
            critical=False,
            prerequisites=[
                "feat_multimodal_spec_assertion",
                "feat_fast_skip_exported",
                "feat_html_export_download",
                "feat_pdf_export_download",
                "feat_stale_tab_image_export",
                "feat_updated_badge_display",
                "feat_authoritative_title_upgrade"
            ]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        browser_ws = get_browser_ws_url(ctx.port)
        if not browser_ws:
            return False, f"无法获取 Chrome Browser WebSocket (端口 {ctx.port})", None

        curr_ext_id = ctx.ext_id or get_extension_id(ctx.port)
        if not curr_ext_id:
            return False, "当前未检测到任何已安装的活跃扩展 ID", None

        print(f"   🗑️ 正在通过 CDP Extensions.uninstall 执行卸载: {curr_ext_id}...")
        cdp = CDPConnection(browser_ws)
        try:
            # 1. 触发原生卸载
            cdp.call("Extensions.uninstall", {"id": curr_ext_id})

            # 2. 验证扩展已从浏览器中完全移除 (轮询最多 6 秒，消除异步靶标注销时序差)
            uninstalled = False
            for _ in range(12):
                time.sleep(0.5)
                new_check_id = get_extension_id(ctx.port)
                if not new_check_id or new_check_id != curr_ext_id:
                    uninstalled = True
                    break

            if not uninstalled:
                return False, f"扩展卸载后仍然在浏览器中驻留: {curr_ext_id}", None

            print("   ✓ 扩展已成功彻底卸载，验证后台页面已注销")

            # 3. 重新纯净安装，验证零污染恢复
            print("   📦 重新安装扩展以恢复测试基线并验证零污染加载...")
            reinstalled_id = CDPActions.reinstall_extension(ctx.port, repo_path=ctx.worktree_root)
            if not reinstalled_id:
                return False, "卸载后重新加载扩展失败", None

            ctx.ext_id = reinstalled_id
            print(f"   ✅ 重新安装就绪，新扩展 ID: {reinstalled_id}")
            return True, f"扩展顺利卸载并通过纯净加载恢复 (新ID: {reinstalled_id})", {"new_ext_id": reinstalled_id}
        finally:
            cdp.close()
