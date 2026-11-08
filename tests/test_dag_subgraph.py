#!/usr/bin/env python3
"""
tests/test_dag_subgraph.py
--------------------------
Unit tests for Tier 2 Declarative DAG Scheduling, Ancestor Closure推导,
and Subgraph Pruning (子图剪枝) in scripts/framework.
"""

import os
import io
import sys
import unittest
from unittest.mock import MagicMock, patch
from typing import Tuple, Optional, Dict, Any

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from scripts.framework.cases.base import FeatureTestCase, DAGRunner, TestContext
from scripts.framework.features import FeatureDomain, FeatureRegistry, TestStatus
from scripts.framework.runner import FrameworkRunner
from scripts.framework.cases.workbench import SearchClearCase


class DummyTestCase(FeatureTestCase):
    def __init__(self, fid: str, domain: FeatureDomain, prereqs=None, critical=True):
        super().__init__(
            feature_id=fid,
            domain=domain,
            name=f"Dummy {fid}",
            description=f"Description of {fid}",
            critical=critical,
            prerequisites=prereqs or []
        )
        self.executed = False

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        self.executed = True
        return True, f"{self.feature_id} executed successfully", None


class TestDAGSubgraphPruning(unittest.TestCase):
    def setUp(self):
        self.dag = FrameworkRunner._assemble_dag()

    def test_dag_registration_and_count(self):
        """验证 25 项特性全部成功注册进 DAG"""
        self.assertEqual(len(self.dag.cases), 25)
        self.assertIn('feat_gemini_dual_parse', self.dag.cases)

    def test_topological_sort_order(self):
        """验证拓扑排序：所有前置依赖必须在其依赖者之前执行"""
        order = self.dag.get_execution_order()
        self.assertEqual(len(order), 25)

        position = {case.feature_id: idx for idx, case in enumerate(order)}

        # Takeout import 必须在 workbench 搜索之前
        self.assertLess(
            position["feat_takeout_zip_import"],
            position["feat_search_filter_by_keyword"]
        )
        # Image acceptance consumes a physical ZIP; live save consumes generated chats.
        self.assertLess(
            position["feat_zip_export_download"],
            position["feat_imagen_multimodal"]
        )
        self.assertLess(
            position["feat_chat_generation"],
            position["feat_live_save_new_chat"]
        )
        self.assertLess(
            position["feat_chat_generation"],
            position["feat_continued_chat_promotion"]
        )
        self.assertLess(
            position["feat_updated_badge_display"],
            position["feat_live_auto_save_disk_write"]
        )
        # Search clear 必须在 Zip export 之前
        self.assertLess(
            position["feat_search_clear_restore"],
            position["feat_zip_export_download"]
        )
        # Markdown 规范断言仍消费 ZIP 产出（真实数据依赖），失效标签页依赖 Imagen 会话
        self.assertLess(
            position["feat_zip_export_download"],
            position["feat_multimodal_spec_assertion"]
        )
        self.assertLess(
            position["feat_imagen_multimodal"],
            position["feat_stale_tab_image_export"]
        )
        # Fast-skip consumes the actual ZIP export records, not a badge-count assumption.
        self.assertLess(position["feat_zip_export_download"], position["feat_fast_skip_exported"])
        self.assertIn("feat_zip_export_download", self.dag.get_ancestors(["feat_fast_skip_exported"]))
        self.assertIn("feat_chat_generation", self.dag.get_ancestors(["feat_fast_skip_exported"]))
        # 扩展卸载必须在 PDF 导出之后
        self.assertLess(
            position["feat_pdf_export_download"],
            position["feat_uninstall_lifecycle"]
        )

    def test_get_ancestors_closure(self):
        """验证最小前置依赖传递闭包计算"""
        # 搜索过滤只依赖 Takeout 导入
        ancestors = set(self.dag.get_ancestors(["feat_search_filter_by_keyword"]))
        self.assertEqual(ancestors, {"feat_search_filter_by_keyword", "feat_takeout_zip_import"})

        # Image acceptance needs golden export data, with no live generation.
        ancestors_img = set(self.dag.get_ancestors(["feat_imagen_multimodal"]))
        self.assertEqual(ancestors_img, {"feat_imagen_multimodal"} | set(self.dag.get_ancestors(["feat_zip_export_download"])))
        self.assertNotIn("feat_chat_generation", ancestors_img)

    def test_fast_skip_does_not_run_without_complete_live_batch(self):
        ctx = TestContext()
        for fid, case in self.dag.cases.items():
            case.execute = MagicMock(return_value=(fid != 'feat_chat_generation', 'injected result', None))
            case.teardown = MagicMock()
        with patch('sys.stdout', new=io.StringIO()):
            self.assertFalse(self.dag.run(ctx))
        self.assertEqual(ctx.registry.get_result('feat_zip_export_download').status, TestStatus.PASS)
        self.assertEqual(ctx.registry.get_result('feat_fast_skip_exported').status, TestStatus.SKIP)
        self.dag.cases['feat_fast_skip_exported'].execute.assert_not_called()

    def test_subgraph_pruning_isolated_workbench(self):
        """剪枝验证：运行工作台搜索时不应拉起聊天生成和多模态用例"""
        pruned_cases = self.dag.prune_subgraph(["feat_search_filter_by_keyword", "feat_language_toggle"])
        pruned_fids = [c.feature_id for c in pruned_cases]

        # 仅包含 Takeout 导入及所选 2 项工作台特性
        self.assertEqual(len(pruned_cases), 3)
        self.assertEqual(pruned_fids[0], "feat_takeout_zip_import")
        self.assertIn("feat_search_filter_by_keyword", pruned_fids)
        self.assertIn("feat_language_toggle", pruned_fids)

        # 绝对不包含耗时的对话生成
        self.assertNotIn("feat_chat_generation", pruned_fids)
        self.assertNotIn("feat_imagen_multimodal", pruned_fids)

    def test_subgraph_pruning_export_domain(self):
        """剪枝验证：导出领域测试解耦，无需 live chat 也能通过 Takeout 导入执行导出"""
        pruned_cases = self.dag.prune_subgraph(["feat_zip_export_download"])
        pruned_fids = [c.feature_id for c in pruned_cases]

        # 必须包含 Takeout 导入与标题晋级依赖
        self.assertIn("feat_takeout_zip_import", pruned_fids)
        self.assertIn("feat_deep_scan_pagination", pruned_fids)
        self.assertIn("feat_authoritative_title_upgrade", pruned_fids)
        self.assertIn("feat_search_filter_by_id", pruned_fids)
        self.assertIn("feat_search_clear_restore", pruned_fids)
        self.assertIn("feat_zip_export_download", pruned_fids)

        # 剪枝成功：不包含网页端实时发帖节点
        self.assertNotIn("feat_chat_generation", pruned_fids)
        self.assertNotIn("feat_imagen_multimodal", pruned_fids)

    def test_framework_runner_target_resolution(self):
        """验证 FrameworkRunner 对 --features 与 --domain 的解析能力"""
        # 单特性与多特性解析 (逗号分隔)
        targets = FrameworkRunner(target_features="feat_search_filter_by_keyword, feat_language_toggle").target_ids
        self.assertEqual(sorted(targets), ["feat_language_toggle", "feat_search_filter_by_keyword"])

        # 领域解析 (workbench)
        wb_targets = FrameworkRunner(domain="workbench").target_ids
        for fid in [
            "feat_tour_guide_interactive",
            "feat_search_filter_by_keyword",
            "feat_search_filter_by_id",
            "feat_search_clear_restore",
            "feat_selection_controls",
            "feat_language_toggle"
        ]:
            self.assertIn(fid, wb_targets)

        # 领域解析 (takeout)
        to_targets = FrameworkRunner(domain="takeout").target_ids
        self.assertEqual(
            sorted(to_targets),
            ["feat_authoritative_title_upgrade", "feat_deep_scan_pagination", "feat_takeout_zip_import"]
        )

        # 异常特性名报错
        with self.assertRaises(ValueError):
            FrameworkRunner(target_features="invalid_feature_xyz")

        # 异常领域名报错
        with self.assertRaises(ValueError):
            FrameworkRunner(domain="invalid_domain_xyz")

    def test_needs_gemini_and_scenarios_decision(self):
        """验证只有真正需要 Gemini 发帖或页面交互的子图才会初始化 Gemini 标签页与场景池"""
        # 仅测工作台：无需 Gemini，无需实时场景池
        r_wb = FrameworkRunner(domain="workbench")
        self.assertFalse(r_wb.needs_gemini)
        self.assertFalse(r_wb.needs_live_scenarios)

        # 仅测 Takeout：无需 Gemini，无需实时场景池
        r_to = FrameworkRunner(domain="takeout")
        self.assertFalse(r_to.needs_gemini)
        self.assertFalse(r_to.needs_live_scenarios)

        # Fast-skip in the export domain still consumes a complete live batch.
        r_exp = FrameworkRunner(domain="export")
        self.assertTrue(r_exp.needs_gemini)
        self.assertTrue(r_exp.needs_live_scenarios)

        # Golden images need the webpage as independent evidence, without live prompts.
        r_chat = FrameworkRunner(target_features="feat_imagen_multimodal")
        self.assertTrue(r_chat.needs_gemini)
        self.assertFalse(r_chat.needs_live_scenarios)

        # 全量默认运行：必须需要 Gemini 和场景池
        r_full = FrameworkRunner()
        self.assertTrue(r_full.needs_gemini)
        self.assertTrue(r_full.needs_live_scenarios)

    def test_all_planned_cases_must_pass_including_noncritical(self):
        for failed in (None, 'feat_language_toggle'):
            with self.subTest(failed=failed):
                dag = FrameworkRunner._assemble_dag()
                ctx = TestContext()
                for fid, case in dag.cases.items():
                    case.execute = MagicMock(return_value=(fid != failed, 'injected result', None))
                    case.teardown = MagicMock()
                with patch('sys.stdout', new=io.StringIO()):
                    self.assertEqual(dag.run(ctx), failed is None)
                self.assertEqual(len(dag.cases), 25)
                if failed:
                    self.assertFalse(dag.cases[failed].critical)
                    self.assertEqual(ctx.registry.get_result(failed).status, TestStatus.FAIL)

    def test_noncritical_target_and_failed_dependency_fail_selected_run(self):
        for dependent in (False, True):
            with self.subTest(dependent=dependent):
                dag = DAGRunner()
                root = DummyTestCase('root', FeatureDomain.WORKBENCH, critical=False)
                root.execute = MagicMock(return_value=(False, 'injected failure', None))
                dag.register(root)
                if dependent:
                    dag.register(DummyTestCase('target', FeatureDomain.WORKBENCH,
                                               prereqs=['root'], critical=False))
                ctx = TestContext()
                with patch('sys.stdout', new=io.StringIO()):
                    self.assertFalse(dag.run(ctx, target_ids=['target' if dependent else 'root']))
                if dependent:
                    self.assertEqual(ctx.registry.get_result('target').status, TestStatus.SKIP)

    def test_explicit_audit_warning_completes_but_cannot_mask_failed_execution(self):
        for completed in (True, False):
            dag = DAGRunner()
            audit = DummyTestCase('audit', FeatureDomain.EXPORT_DISK, critical=False)
            audit.execute = MagicMock(return_value=(completed, 'audit differences', {'different': 1}))
            audit.success_status = MagicMock(return_value=TestStatus.WARN)
            dag.register(audit)
            downstream = DummyTestCase('downstream', FeatureDomain.EXPORT_DISK, prereqs=['audit'])
            dag.register(downstream)
            ctx = TestContext()
            with patch('sys.stdout', new=io.StringIO()):
                self.assertEqual(dag.run(ctx, target_ids=['downstream']), completed)
            self.assertEqual(ctx.registry.get_result('audit').status,
                             TestStatus.WARN if completed else TestStatus.FAIL)
            self.assertEqual(downstream.executed, completed)
            self.assertEqual(ctx.registry.get_result('downstream').status,
                             TestStatus.PASS if completed else TestStatus.SKIP)
            if completed:
                self.assertIn('⚠️ WARN', ctx.registry.generate_matrix_report())

    def test_noncritical_missing_dependency_skip_fails_full_run(self):
        dag = DAGRunner()
        dag.register(DummyTestCase('target', FeatureDomain.WORKBENCH,
                                   prereqs=['missing'], critical=False))
        ctx = TestContext()
        with patch('sys.stdout', new=io.StringIO()):
            self.assertFalse(dag.run(ctx))
        self.assertEqual(ctx.registry.get_result('target').status, TestStatus.SKIP)

    def test_dag_execution_with_pruning_skip_status(self):
        """验证执行子图剪枝时，未选中的节点被正确记录为 SKIP，且不影响整体通过状态"""
        mock_dag = DAGRunner()
        c1 = DummyTestCase("node_root", FeatureDomain.TAKEOUT, prereqs=[])
        c2 = DummyTestCase("node_mid", FeatureDomain.WORKBENCH, prereqs=["node_root"])
        c3 = DummyTestCase("node_unrelated_heavy", FeatureDomain.PAGE_CHAT, prereqs=[], critical=True)
        mock_dag.register(c1)
        mock_dag.register(c2)
        mock_dag.register(c3)

        # 创建一个轻量 mock TestContext
        class MockContext:
            def __init__(self):
                self.registry = FeatureRegistry()

        ctx = MockContext()
        # 仅调度 node_mid (及其前置 node_root)
        success = mock_dag.run(ctx, target_ids=["node_mid"])

        self.assertTrue(success)
        self.assertTrue(c1.executed)
        self.assertTrue(c2.executed)
        self.assertFalse(c3.executed)

        # 检查 Registry 状态
        res1 = ctx.registry.get_result("node_root")
        res2 = ctx.registry.get_result("node_mid")
        res3 = ctx.registry.get_result("node_unrelated_heavy")

        self.assertEqual(res1.status, TestStatus.PASS)
        self.assertEqual(res2.status, TestStatus.PASS)
        self.assertEqual(res3.status, TestStatus.SKIP)
        self.assertIn("子图剪枝免除执行", res3.message)


class TestExportFormatDecoupling(unittest.TestCase):
    """导出格式链解耦：Markdown/HTML/PDF 失败互不阻塞，各自给出 PASS/FAIL 而非 SKIP。"""

    def test_format_cases_have_no_serial_pass_gates(self):
        dag = FrameworkRunner._assemble_dag()
        for fid in ("feat_html_export_download", "feat_pdf_export_download"):
            with self.subTest(fid=fid):
                ancestors = set(dag.get_ancestors([fid]))
                self.assertEqual(ancestors, {fid})
        fast_skip_ancestors = set(dag.get_ancestors(["feat_fast_skip_exported"]))
        self.assertIn("feat_zip_export_download", fast_skip_ancestors)
        self.assertNotIn("feat_multimodal_spec_assertion", fast_skip_ancestors)
        stale_ancestors = set(dag.get_ancestors(["feat_stale_tab_image_export"]))
        self.assertEqual(stale_ancestors, {
            "feat_stale_tab_image_export", "feat_imagen_multimodal"}
            | set(dag.get_ancestors(["feat_zip_export_download"])))
        self.assertNotIn("feat_chat_generation", stale_ancestors)

    def run_with_injected_results(self, failing):
        dag = FrameworkRunner._assemble_dag()
        ctx = TestContext()
        for fid, case in dag.cases.items():
            case.execute = MagicMock(
                return_value=(fid not in failing, "injected result", None))
            case.teardown = MagicMock()
        with patch("sys.stdout", new=io.StringIO()):
            dag.run(ctx)
        return ctx

    def test_markdown_failure_does_not_skip_html_pdf(self):
        ctx = self.run_with_injected_results({"feat_multimodal_spec_assertion"})
        self.assertEqual(ctx.registry.get_result("feat_multimodal_spec_assertion").status, TestStatus.FAIL)
        # 各格式独立执行并通过，不被 Markdown 失败连带 SKIP
        for fid in ("feat_fast_skip_exported", "feat_html_export_download",
                    "feat_pdf_export_download", "feat_stale_tab_image_export"):
            with self.subTest(fid=fid):
                self.assertEqual(ctx.registry.get_result(fid).status, TestStatus.PASS)

    def test_html_failure_does_not_skip_pdf(self):
        ctx = self.run_with_injected_results({"feat_html_export_download"})
        self.assertEqual(ctx.registry.get_result("feat_html_export_download").status, TestStatus.FAIL)
        self.assertEqual(ctx.registry.get_result("feat_pdf_export_download").status, TestStatus.PASS)

    def test_gemini_free_export_subset_preserved(self):
        # The four archive checks support history-only targets. Fast-skip needs
        # the six-target live batch and therefore is not part of this subset.
        targets = ",".join([
            "feat_zip_export_download", "feat_multimodal_spec_assertion",
            "feat_html_export_download",
            "feat_pdf_export_download",
        ])
        r = FrameworkRunner(target_features=targets)
        self.assertFalse(r.needs_gemini)
        self.assertFalse(r.needs_live_scenarios)
        fast_skip = FrameworkRunner(target_features="feat_fast_skip_exported")
        self.assertTrue(fast_skip.needs_gemini)
        self.assertTrue(fast_skip.needs_live_scenarios)


class TestSearchClearIsolation(unittest.TestCase):
    def run_case(self, preserve_selection, store_total=12, platform_id='gemini'):
        # Earlier independent cases have changed both the search and selection.
        state = {"query": "another-chat", "selected": False}
        cdp = MagicMock()

        def eval_dispatch(expression, *args, **kwargs):
            # Store 总数查询返回独立全量基线；Store 不可访问时返回 None（必须明确 FAIL）
            if "getConversations" in str(expression):
                return store_total
            return state["selected"]
        cdp.eval.side_effect = eval_dispatch
        ctx = MagicMock()
        ctx.platform_id = platform_id
        ctx.shared_data = {"target_search_id": "target-chat"}
        ctx.connect_options.return_value = cdp

        def search(connection, query):
            state["query"] = query
            return 1

        def select(connection, chat_id, checked):
            state["selected"] = state["query"] == chat_id and checked
            return state["selected"]

        def clear(connection, provider_id):
            self.assertEqual(provider_id, platform_id)
            state["query"] = ""
            if not preserve_selection:
                state["selected"] = False
            return 12

        with patch("scripts.framework.cases.workbench.snapshot", return_value={"rows":[{} for _ in range(store_total)]} if store_total is not None else None), \
             patch("scripts.framework.cases.workbench.CDPActions.search_workbench", side_effect=search), \
             patch("scripts.framework.cases.workbench.CDPActions.select_workbench_item", side_effect=select), \
             patch("scripts.framework.cases.workbench.CDPActions.clear_search_workbench", side_effect=clear):
            result = SearchClearCase().execute(ctx)
        cdp.close.assert_called_once()
        return result

    def test_intervening_cases_do_not_invalidate_clear_selection_contract(self):
        self.assertTrue(self.run_case(preserve_selection=True)[0])

    def test_chatgpt_clear_uses_its_own_platform(self):
        self.assertTrue(self.run_case(preserve_selection=True, platform_id='chatgpt')[0])

    def test_clear_that_loses_selection_still_fails(self):
        self.assertFalse(self.run_case(preserve_selection=False)[0])

    def test_store_inaccessible_fails_without_dom_fallback(self):
        self.assertFalse(self.run_case(preserve_selection=True, store_total=None)[0])


if __name__ == "__main__":
    unittest.main()
