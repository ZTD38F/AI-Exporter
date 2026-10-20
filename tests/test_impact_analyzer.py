#!/usr/bin/env python3
"""
tests/test_impact_analyzer.py
-----------------------------
Unit tests for scripts/test_impact_analyzer.py (Test Impact Analysis & Dependency Graph).
"""

import os
import sys
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
scripts_dir = os.path.join(BASE_DIR, "scripts")
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

from test_impact_analyzer import (
    DependencyGraph,
    analyze_impact,
    normalize_repo_path,
    resolve_import_path,
    GLOBAL_FILES
)


class TestImpactAnalyzer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph = DependencyGraph(base_dir=BASE_DIR)

    def test_graph_has_nodes(self):
        self.assertGreater(len(self.graph.dependencies), 10)
        self.assertGreater(len(self.graph.dependents), 10)

    def test_storage_service_transitive_dependencies(self):
        """核心断言：修改底层 storageService.ts 必须传递影响所有依赖它的模块与测试"""
        target = "src/core/storage/storageService.ts"
        affected = self.graph.get_transitive_dependents({target})

        # 直接引用
        self.assertIn("src/content/syncEngine.ts", affected)
        self.assertIn("src/ui/options/options.ts", affected)
        self.assertIn("tests/storage_service.test.ts", affected)

        # 传递间接引用 (via syncEngine or options)
        self.assertIn("tests/p1_d_regressions.test.ts", affected)
        self.assertIn("tests/takeout_and_limit_guidance.test.ts", affected)

        # 影响分析结果断言
        res = analyze_impact({target}, graph=self.graph, base_dir=BASE_DIR)
        self.assertFalse(res.is_all_affected)
        self.assertFalse(res.is_docs_only)
        self.assertGreaterEqual(len(res.target_unit_tests), 15)
        self.assertIn("tests/storage_service.test.ts", res.target_unit_tests)
        self.assertIn("tests/takeout_and_limit_guidance.test.ts", res.target_unit_tests)
        # core 变动应触发所有 E2E
        self.assertEqual(len(res.target_e2e_specs), len(res.all_e2e_specs))

    def test_localized_badge_view_impact(self):
        """修改局部的 badgeView.ts 只应该影响 content 相关的少数测试，不应全量执行"""
        target = "src/content/badgeView.ts"
        res = analyze_impact({target}, graph=self.graph, base_dir=BASE_DIR)
        self.assertFalse(res.is_all_affected)
        self.assertFalse(res.is_docs_only)

        # 仅影响少数几个单元测试
        self.assertLess(len(res.target_unit_tests), len(res.all_unit_tests) // 3)
        self.assertIn("tests/ui_views.test.ts", res.target_unit_tests)
        self.assertNotIn("tests/takeout_engine.test.ts", res.target_unit_tests)

        # 仅影响 content 相关的 E2E
        self.assertIn("tests/e2e/page_sync.spec.ts", res.target_e2e_specs)
        self.assertIn("tests/e2e/live_save.spec.ts", res.target_e2e_specs)
        self.assertNotIn("tests/e2e/workbench_ui.spec.ts", res.target_e2e_specs)

    def test_global_config_fallback_triggers_all(self):
        """修改 package.json 或 tsconfig.json 等核心配置必须兜底触发全量测试"""
        for gf in ["package.json", "tsconfig.json", "build.js"]:
            res = analyze_impact({gf}, graph=self.graph, base_dir=BASE_DIR)
            self.assertTrue(res.is_all_affected)
            self.assertEqual(len(res.target_unit_tests), len(res.all_unit_tests))
            self.assertEqual(len(res.target_e2e_specs), len(res.all_e2e_specs))

    def test_docs_only_bypass(self):
        """纯文档或测试场景池变更必须秒级旁路通过"""
        res = analyze_impact({"README.md", "docs/architecture.md", "scripts/test_scenario_pool.json"}, graph=self.graph, base_dir=BASE_DIR)
        self.assertFalse(res.is_all_affected)
        self.assertTrue(res.is_docs_only)
        self.assertEqual(len(res.target_unit_tests), 0)
        self.assertEqual(len(res.target_e2e_specs), 0)

    def test_import_pattern_filtering_and_dynamic_imports(self):
        """验证 IMPORT_PATTERN 正确跳过 import type / export type，并正确解析动态 import()"""
        from test_impact_analyzer import IMPORT_PATTERN
        sample = """
        import { foo } from "./runtime_foo";
        import type { BarType } from "./type_bar";
        export { baz } from "./runtime_baz";
        export type { QuuxType } from "./type_quux";
        const lazyMod = import("./dynamic_lazy");
        const reqMod = require("./cjs_req");
        """
        matches = [m.group(1) or m.group(2) for m in IMPORT_PATTERN.finditer(sample)]
        self.assertIn("./runtime_foo", matches)
        self.assertIn("./runtime_baz", matches)
        self.assertIn("./dynamic_lazy", matches)
        self.assertIn("./cjs_req", matches)
        self.assertNotIn("./type_bar", matches)
        self.assertNotIn("./type_quux", matches)


if __name__ == "__main__":
    unittest.main()
