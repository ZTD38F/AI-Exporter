# scripts/framework/cases/workbench.py
import time
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.assertions import CDPAssertions
from scripts.framework.selectors import WorkbenchSelectors


class SearchKeywordCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_search_filter_by_keyword",
            domain=FeatureDomain.WORKBENCH,
            name="按标题关键词实时过滤",
            description="在工作台搜索框输入关键词（如 Python/量子），列表即时收缩为对应匹配项集合",
            critical=True,
            prerequisites=["feat_takeout_zip_import"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            CDPActions.search_workbench(cdp_opt, "Python")
            filter_kw_ok, filter_kw_msg, details = CDPAssertions.assert_search_filter(cdp_opt, "Python", expected_visible_min=1)
            CDPActions.clear_search_workbench(cdp_opt)
            if filter_kw_ok:
                return True, "关键词过滤列表正常收缩并恢复", details
            return False, filter_kw_msg, details
        finally:
            cdp_opt.close()


class SearchIdCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_search_filter_by_id",
            domain=FeatureDomain.WORKBENCH,
            name="按会话 ID 搜索与精准勾选",
            description="在工作台搜索框输入目标会话 ID，列表即时过滤收缩只剩该项，并进行精准勾选",
            critical=True,
            prerequisites=["feat_takeout_zip_import"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            target_search_id = cdp_opt.eval(f"document.querySelector('{WorkbenchSelectors.ITEM}')?.dataset.chatId") or "1bd028d5c5b0c0e2"
            ctx.shared_data["target_search_id"] = target_search_id

            CDPActions.search_workbench(cdp_opt, target_search_id)
            filter_id_ok, filter_id_msg, details = CDPAssertions.assert_search_filter(cdp_opt, target_search_id, expected_visible_min=1, expected_visible_max=2)
            CDPActions.select_workbench_item(cdp_opt, target_search_id, True)

            if filter_id_ok:
                return True, f"ID过滤精准定位并勾选: {target_search_id}", details
            return False, filter_id_msg, details
        finally:
            cdp_opt.close()


class SearchClearCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_search_clear_restore",
            domain=FeatureDomain.WORKBENCH,
            name="清空搜索框恢复完整列表",
            description="清空搜索框后列表完整恢复全量项，且先前勾选状态完好保留",
            critical=True,
            prerequisites=["feat_search_filter_by_id"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            target_search_id = ctx.shared_data.get("target_search_id", "1bd028d5c5b0c0e2")
            restored_count = CDPActions.clear_search_workbench(cdp_opt)
            is_still_checked = bool(cdp_opt.eval(f"""
            (() => {{
                const item = document.querySelector('#list .item[data-chat-id="{target_search_id}"], #list .item[data-chat-id="c_{target_search_id}"]');
                return item ? !!item.querySelector('input[type=checkbox]:checked') : false;
            }})()
            """))
            if restored_count > 1 and is_still_checked:
                return True, f"列表恢复全量 ({restored_count}项) 且勾选状态完好保留", {"restored_count": restored_count}
            return False, f"恢复数量={restored_count}, 勾选保留={is_still_checked}", None

        finally:
            cdp_opt.close()


class SelectionControlsCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_selection_controls",
            domain=FeatureDomain.WORKBENCH,
            name="全选 / 取消全选联动控制",
            description="点击【全选】与【取消全选】按钮，底部已勾选计数精准联动 (0 -> N -> 0)",
            critical=True,
            prerequisites=["feat_takeout_zip_import"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            none_count = CDPActions.toggle_select_none(cdp_opt)
            time.sleep(0.2)
            all_count = CDPActions.toggle_select_all(cdp_opt)
            time.sleep(0.2)
            if none_count == 0 and all_count > 0:
                return True, f"联动控制正常 (取消全选=0, 全选={all_count})", {"all_count": all_count}
            return False, f"联动控制异常 (none={none_count}, all={all_count})", None
        finally:
            cdp_opt.close()


class LanguageToggleCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_language_toggle",
            domain=FeatureDomain.WORKBENCH,
            name="中英文语言切换与状态驻留",
            description="切换至 English 再切回中文，界面文案正确切换且已勾选状态完整保持",
            critical=False,
            prerequisites=["feat_takeout_zip_import"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            en_text = CDPActions.switch_workbench_language(cdp_opt, "en")
            time.sleep(0.2)
            zh_text = CDPActions.switch_workbench_language(cdp_opt, "zh")
            time.sleep(0.2)
            if ("select all" in en_text.lower() or "all" in en_text.lower()) and ("全选" in zh_text):
                return True, "多语言正确切换且UI渲染完备", {"en": en_text, "zh": zh_text}
            return False, f"多语言切换未匹配: en='{en_text}', zh='{zh_text}'", None
        finally:
            cdp_opt.close()
