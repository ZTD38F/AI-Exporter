# scripts/framework/cases/takeout.py
import os
import time
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.assertions import CDPAssertions


class TakeoutZipImportCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_takeout_zip_import",
            domain=FeatureDomain.TAKEOUT,
            name="离线 Takeout ZIP 导入",
            description="导入预置纯净 Takeout ZIP，离线附件池建立，初始提问前缀临时标题生效",
            critical=True,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if not os.path.isfile(ctx.takeout_zip):
            return False, f"Takeout ZIP 样本文件不存在: {ctx.takeout_zip}", None

        cdp_opt = ctx.connect_options()
        try:
            print(f"   📥 导入离线 ZIP 样本 ({os.path.basename(ctx.takeout_zip)})...")
            import_res = CDPActions.import_takeout_zip(cdp_opt, ctx.takeout_zip)
            if import_res.get("success"):
                media_count = import_res.get("totalMediaCount", 0)
                return True, f"离线附件池建立，已索引资源 {media_count}", import_res
            return False, f"导入失败: {import_res.get('error')}", import_res
        finally:
            cdp_opt.close()


class DeepScanPaginationCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_deep_scan_pagination",
            domain=FeatureDomain.TAKEOUT,
            name="全量拉取历史分页同步",
            description="点击【全量拉取历史】按钮，分页拉取所有云端会话，进度条正常推进至 100%",
            critical=True,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            print("   🔄 触发【全量拉取历史】(btnDeepScan)...")
            scan_ok = CDPActions.trigger_deep_scan(cdp_opt, max_wait=90)
            if scan_ok:
                return True, "全量拉取历史分页同步完成", None
            return False, "全量拉取扫描超时未恢复可用", None
        finally:
            cdp_opt.close()


class AuthoritativeTitleUpgradeCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_authoritative_title_upgrade",
            domain=FeatureDomain.TAKEOUT,
            name="权威 RPC 标题覆盖晋级",
            description="全量拉取历史后，Takeout 临时标题被在线权威 RPC 标题平滑覆盖升级",
            critical=True,
            prerequisites=["feat_takeout_zip_import", "feat_deep_scan_pagination"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            check_takeout_ids = ['1bd028d5c5b0c0e2', '1cea7e48cc166b57', '7b29852ecae8344a', 'f8ba969fe8c7d880']
            upg_ok, upg_msg, details = CDPAssertions.assert_title_upgraded(cdp_opt, check_takeout_ids)
            if upg_ok:
                return True, upg_msg, details
            return False, upg_msg, details
        finally:
            cdp_opt.close()
