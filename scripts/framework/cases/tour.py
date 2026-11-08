# scripts/framework/cases/tour.py
import time
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions


class TourGuideCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_tour_guide_interactive",
            domain=FeatureDomain.WORKBENCH,
            name="新手向导交互与 0 遮挡防撞",
            description="推进 v2 向导并检查弹窗无目标遮挡、URL 启动意图被消费，不依赖持久化标记",
            critical=False,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if not ctx.ext_id:
            return False, "缺少活跃扩展 ID", None
        ok = CDPActions.verify_onboarding_tour(ctx.port, ctx.ext_id)
        if ok:
            return True, "v2 新手向导交互推进、URL 意图消费完成", None
        return False, "v2 向导未正常完成或 URL 启动意图未消费", None
