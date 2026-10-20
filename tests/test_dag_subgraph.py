#!/usr/bin/env python3
"""
tests/test_dag_subgraph.py
--------------------------
Unit tests for Tier 2 Declarative DAG Scheduling, Ancestor Closure推导,
and Subgraph Pruning (子图剪枝) in scripts/framework.
"""

import os
import sys
import unittest
from typing import Tuple, Optional, Dict, Any

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from scripts.framework.cases.base import FeatureTestCase, DAGRunner, TestContext
from scripts.framework.features import FeatureDomain, FeatureRegistry, TestStatus
from scripts.framework.runner import FrameworkRunner


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
        """验证 24 项特性全部成功注册进 DAG"""
        self.assertEqual(len(self.dag.cases), 24)

    def test_topological_sort_order(self):
        """验证拓扑排序：所有前置依赖必须在其依赖者之前执行"""
        order = self.dag.get_execution_order()
        self.assertEqual(len(order), 24)

        position = {case.feature_id: idx for idx, case in enumerate(order)}

        # Takeout import 必须在 workbench 搜索之前
        self.assertLess(
            position["feat_takeout_zip_import"],
            position["feat_search_filter_by_keyword"]
        )
        # Chat generation 必须在 multimodal 和 continued chat 以及 live save 之前
        self.assertLess(
            position["feat_chat_generation"],
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
        # HTML 导出必须在 Markdown 极速跳过之后，PDF 导出在 HTML 之后
        self.assertLess(
            position["feat_fast_skip_exported"],
            position["feat_html_export_download"]
        )
        self.assertLess(
            position["feat_html_export_download"],
            position["feat_pdf_export_download"]
        )
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

        # 多模态生图只依赖 Chat 生成
        ancestors_img = set(self.dag.get_ancestors(["feat_imagen_multimodal"]))
        self.assertEqual(ancestors_img, {"feat_imagen_multimodal", "feat_chat_generation"})

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

        # 仅测导出：无需 Gemini，无需实时场景池
        r_exp = FrameworkRunner(domain="export")
        self.assertFalse(r_exp.needs_gemini)
        self.assertFalse(r_exp.needs_live_scenarios)

        # 测多模态或聊天：必须需要 Gemini 和场景池
        r_chat = FrameworkRunner(target_features="feat_imagen_multimodal")
        self.assertTrue(r_chat.needs_gemini)
        self.assertTrue(r_chat.needs_live_scenarios)

        # 全量默认运行：必须需要 Gemini 和场景池
        r_full = FrameworkRunner()
        self.assertTrue(r_full.needs_gemini)
        self.assertTrue(r_full.needs_live_scenarios)

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


if __name__ == "__main__":
    unittest.main()
