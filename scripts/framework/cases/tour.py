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
            description="推进向导步骤，气泡与高亮目标 0 遮挡重叠，完成后写入 Storage 持久化标记",
            critical=False,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if not ctx.ext_id:
            return False, "缺少活跃扩展 ID", None
        ok = CDPActions.verify_onboarding_tour(ctx.port, ctx.ext_id)
        if ok:
            return True, "新手向导交互推进与持久化完成", None
        return False, "向导未能正常完成或状态未落盘", None
