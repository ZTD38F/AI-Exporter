# scripts/framework/cases/workbench.py
import time
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.v2_probe import snapshot
from scripts.framework.assertions import CDPAssertions
from scripts.framework.selectors import WorkbenchSelectors


class SearchKeywordCase(FeatureTestCase):
    def __init__(self, prerequisites=None):
        super().__init__(
            feature_id="feat_search_filter_by_keyword",
            domain=FeatureDomain.WORKBENCH,
            name="按标题关键词实时过滤",
            description="在工作台搜索框输入关键词（如 Python/量子），列表即时收缩为对应匹配项集合",
            critical=True,
            prerequisites=["feat_takeout_zip_import"] if prerequisites is None else prerequisites
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            keyword = getattr(ctx, "search_keyword", "Python")
            CDPActions.search_workbench(cdp_opt, keyword)
            filter_kw_ok, filter_kw_msg, details = CDPAssertions.assert_search_filter(cdp_opt, keyword)
            CDPActions.clear_search_workbench(cdp_opt, provider_id=getattr(ctx, 'platform_id', 'gemini'))
            if filter_kw_ok:
                return True, "关键词过滤列表正常收缩并恢复", details
            return False, filter_kw_msg, details
        finally:
            cdp_opt.close()


class SearchIdCase(FeatureTestCase):
    def __init__(self, prerequisites=None):
        super().__init__(
            feature_id="feat_search_filter_by_id",
            domain=FeatureDomain.WORKBENCH,
            name="按会话 ID 搜索与精准勾选",
            description="在工作台搜索框输入目标会话 ID，列表即时过滤收缩只剩该项，并进行精准勾选",
            critical=True,
            prerequisites=["feat_takeout_zip_import"] if prerequisites is None else prerequisites
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            target_search_id = cdp_opt.eval(f"document.querySelector('{WorkbenchSelectors.ITEM}')?.dataset.chatId") or "1bd028d5c5b0c0e2"
            ctx.shared_data["target_search_id"] = target_search_id

            CDPActions.search_workbench(cdp_opt, target_search_id)
            # 固定测试数据：直接比较可见 ID 集合与预期集合（顺序无关），数量检查已被覆盖
            filter_id_ok, filter_id_msg, details = CDPAssertions.assert_search_filter(
                cdp_opt, target_search_id, expected_ids=[target_search_id],
            )
            if not filter_id_ok:
                return False, filter_id_msg, details
            # 精准勾选返回值与实际选中状态都必须纳入成功判定
            select_ok = CDPActions.select_workbench_item(cdp_opt, target_search_id, True)
            is_checked = bool(cdp_opt.eval(f"""
            (() => {{
                const item = document.querySelector('{WorkbenchSelectors.item_by_chat_id(target_search_id)}');
                return item ? !!item.querySelector('input[type=checkbox]:checked') : false;
            }})()
            """))
            details = {**(details or {}), "select_return": select_ok, "is_checked": is_checked}
            if not select_ok:
                return False, f"ID精准勾选操作返回失败: {target_search_id}", details
            if not is_checked:
                return False, f"ID精准勾选后复选框未实际选中: {target_search_id}", details
            return True, f"ID过滤精准定位并勾选: {target_search_id}", details
        finally:
            cdp_opt.close()


class SearchClearCase(FeatureTestCase):
    def __init__(self, prerequisites=None):
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
            # Other DAG cases can intentionally clear selections or change the
            # search between SearchIdCase and this case. Establish our own real
            # filtered selection immediately before testing clear/restore.
            CDPActions.search_workbench(cdp_opt, target_search_id)
            CDPActions.select_workbench_item(cdp_opt, target_search_id, True)
            restored_count = CDPActions.clear_search_workbench(cdp_opt, provider_id=getattr(ctx, 'platform_id', 'gemini'))
            # 以独立 Store 数据为全量预期；Store 不可访问时明确 FAIL，不用 DOM 数量替代
            state = snapshot(cdp_opt, getattr(ctx, "platform_id", "gemini"))
            total_store = len(state['rows']) if isinstance(state, dict) and isinstance(state.get('rows'), list) else None
            is_still_checked = bool(cdp_opt.eval(f"""
            (() => {{
                const item = document.querySelector('{WorkbenchSelectors.item_by_chat_id(target_search_id)}');
                return item ? !!item.querySelector('input[type=checkbox]:checked') : false;
            }})()
            """))
            details = {"restored_count": restored_count, "total_store": total_store, "is_still_checked": is_still_checked}
            if total_store is None:
                return False, "清空搜索后无法访问 Store 全量，预期缺失", details
            # 清空搜索必须恢复全量（与 Store 总数一致），且先前勾选状态保留
            if restored_count != total_store:
                return False, f"清空搜索未恢复全量: 恢复={restored_count}, 全量={total_store}", details
            if restored_count > 1 and is_still_checked:
                return True, f"列表恢复全量 ({restored_count}项) 且勾选状态完好保留", details
            return False, f"恢复数量={restored_count}, 全量={total_store}, 勾选保留={is_still_checked}", details

        finally:
            cdp_opt.close()


class SelectionControlsCase(FeatureTestCase):
    def __init__(self, prerequisites=None):
        super().__init__(
            feature_id="feat_selection_controls",
            domain=FeatureDomain.WORKBENCH,
            name="全选 / 取消全选联动控制",
            description="点击【全选】与【取消全选】按钮，底部已勾选计数精准联动 (0 -> N -> 0)",
            critical=True,
            prerequisites=["feat_takeout_zip_import"] if prerequisites is None else prerequisites
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            # 确保从全量列表基线开始，避免残留搜索过滤干扰计数
            CDPActions.clear_search_workbench(cdp_opt, provider_id=getattr(ctx, 'platform_id', 'gemini'))
            CDPActions.toggle_select_none(cdp_opt)
            time.sleep(0.2)
            none_state = CDPAssertions.assert_selection_state(cdp_opt)
            CDPActions.toggle_select_all(cdp_opt)
            time.sleep(0.2)
            all_state = CDPAssertions.assert_selection_state(cdp_opt)
            details = {"none_state": none_state, "all_state": all_state}
            # 取消全选：已选集合必须为空（数量由集合派生）
            if not none_state.get("selectable"):
                return False, "联动控制异常: 列表为空无法验证全选/取消全选", details
            if none_state.get("selected"):
                return False, f"取消全选未清空所有勾选 (残留={none_state.get('selected')})", details
            # 全选：可选集合必须非空，且已选的可选 ID 集合必须等于全部可选 ID 集合
            # （漏选/多选均为 FAIL，禁用项不参与）
            if not all_state.get("selectable"):
                return False, "联动控制异常: 全选后可选集合为空", details
            if set(all_state.get("selected", [])) != set(all_state.get("selectable", [])):
                return False, (
                    f"全选集合不一致 (可选={all_state.get('selectable')}, 已选={all_state.get('selected')})"
                ), details
            total = len(all_state.get("selectable", []))
            return True, f"联动控制正常 (取消全选=0, 全选={total}/{total})", details
        finally:
            cdp_opt.close()


class LanguageToggleCase(FeatureTestCase):
    def __init__(self, prerequisites=None):
        super().__init__(
            feature_id="feat_language_toggle",
            domain=FeatureDomain.WORKBENCH,
            name="中英文语言切换与状态驻留",
            description="切换至 English 再切回中文，界面文案正确切换且已勾选状态完整保持",
            critical=False,
            prerequisites=["feat_takeout_zip_import"] if prerequisites is None else prerequisites
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            before = CDPAssertions.assert_selection_state(cdp_opt)
            en_text = CDPActions.switch_workbench_language(cdp_opt, "en")
            after_en = CDPAssertions.assert_selection_state(cdp_opt)
            zh_text = CDPActions.switch_workbench_language(cdp_opt, "zh")
            after_zh = CDPAssertions.assert_selection_state(cdp_opt)
            if any(set(state.get('selected', [])) != set(before.get('selected', [])) for state in (after_en, after_zh)):
                return False, "语言切换改变了勾选集合", {"before": before, "en": after_en, "zh": after_zh}
            if en_text in ("Select all visible conversations", "Clear selection") and zh_text in ("全选当前可见会话", "清空选择"):
                return True, "多语言正确切换且UI渲染完备", {"en": en_text, "zh": zh_text}
            return False, f"多语言切换未匹配: en='{en_text}', zh='{zh_text}'", None
        finally:
            cdp_opt.close()
