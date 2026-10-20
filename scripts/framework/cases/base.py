# scripts/framework/cases/base.py
"""
Base abstractions for Feature-Driven E2E test cases and DAG execution.
Defines TestContext, FeatureTestCase, and DAGRunner.
"""

import os
import sys
import time
import json
import traceback
import urllib.request
from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Any, Tuple

from scripts.framework.features import Feature, FeatureDomain, FeatureRegistry, TestStatus, TestResult
from scripts.framework.scenario_provider import OnlineScenarioProvider
from scripts.framework.lifecycle_tracker import SessionLifecycleTracker
from scripts.framework.pipeline import SerialActionExecutor
from scripts.framework.environment import TestEnvironment

try:
    from scripts.cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url, is_gemini_url
except ImportError:
    from cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url, is_gemini_url


class TestContext:
    def __init__(
        self,
        port: int = 9222,
        output_dir: Optional[str] = None,
        dataset: Optional[Any] = None,
        delay: int = 6,
        takeout_zip: Optional[str] = None,
        pop_scenarios: bool = False
    ):
        self.port = port
        self.worktree_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        self.output_dir = os.path.abspath(output_dir or os.path.join(self.worktree_root, "tests", "output", "live_export"))
        self.delay = max(4, delay)
        self.takeout_zip = takeout_zip or os.path.abspath(os.path.join(self.worktree_root, "tests", "fixtures", "gemini_takeout_clean.zip"))
        self.start_time = time.time()

        self.provider = OnlineScenarioProvider()
        self.tracker = SessionLifecycleTracker()
        self.registry = FeatureRegistry()
        self.executor = SerialActionExecutor()

        self.env = TestEnvironment(
            port=self.port,
            output_dir=self.output_dir,
            repo_path=self.worktree_root
        )

        self._dataset_arg = dataset
        self.scenarios = []
        if isinstance(dataset, dict) and "scenarios" in dataset:
            self.scenarios = dataset["scenarios"]
        elif isinstance(dataset, list) and dataset:
            self.scenarios = dataset
        self._ext_id: Optional[str] = None
        self.chat_records: List[Dict[str, Any]] = []
        self.shared_data: Dict[str, Any] = {}
        os.makedirs(self.output_dir, exist_ok=True)

        if pop_scenarios:
            self.ensure_scenarios()

    def ensure_scenarios(self) -> List[Dict[str, Any]]:
        if not self.scenarios:
            print("🏊 [场景池调度] 从在线对话池中提取 2 个最新多模态场景 (1个Imagen生图 + 1个深度推演)...")
            sc_img = self.provider.pop_scenario(required_features=["imagen"], min_turns=2)
            sc_text = self.provider.pop_scenario(min_turns=2)
            self.scenarios = [sc_img, sc_text]
        return self.scenarios

    @property
    def ext_id(self) -> Optional[str]:
        return self.env.ext_id or self._ext_id

    @ext_id.setter
    def ext_id(self, val: Optional[str]):
        self._ext_id = val
        if hasattr(self, "env") and self.env:
            self.env.ext_id = val

    def get_gemini_tab(self) -> Optional[Dict[str, Any]]:
        return self.env.get_gemini_tab()

    def ensure_gemini_tab(self) -> Optional[Dict[str, Any]]:
        return self.env.ensure_gemini_tab()

    def get_options_tab(self) -> Optional[Dict[str, Any]]:
        return self.env.get_options_tab()

    def ensure_options_tab(self) -> Optional[Dict[str, Any]]:
        return self.env.ensure_options_tab()

    def connect_gemini(self) -> CDPConnection:
        return self.env.connect_gemini()

    def connect_options(self) -> CDPConnection:
        return self.env.connect_options()

    def get_gemini_driver(self, cdp: Optional[CDPConnection] = None):
        """获取高层 Gemini 自动化驱动"""
        from scripts.framework.driver import GeminiPlatformDriver
        conn = cdp or self.connect_gemini()
        return GeminiPlatformDriver(conn)

    def get_platform_driver(self, cdp: Optional[CDPConnection] = None, platform_id: str = "gemini"):
        """获取当前配置的平台自动化驱动契约对象 (通过 PlatformRegistry 动态发现与创建)"""
        from scripts.framework.driver import PlatformRegistry
        conn = cdp or self.connect_gemini()
        return PlatformRegistry.create_driver(platform_id, conn)



class FeatureTestCase(ABC):
    def __init__(
        self,
        feature_id: str,
        domain: FeatureDomain,
        name: str,
        description: str,
        critical: bool = True,
        prerequisites: Optional[List[str]] = None
    ):
        self.feature_id = feature_id
        self.domain = domain
        self.name = name
        self.description = description
        self.critical = critical
        self.prerequisites = prerequisites or []

    def to_feature(self) -> Feature:
        return Feature(
            id=self.feature_id,
            domain=self.domain,
            name=self.name,
            description=self.description,
            critical=self.critical,
            prerequisites=self.prerequisites
        )

    @abstractmethod
    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        """
        执行特性测试逻辑。
        返回 (success: bool, message: str, details: Optional[Dict])
        """
        pass

    def teardown(self, ctx: TestContext):
        """测试后清理（可选）"""
        pass


class DAGRunner:
    def __init__(self):
        self.cases: Dict[str, FeatureTestCase] = {}

    def register(self, case: FeatureTestCase):
        self.cases[case.feature_id] = case

    def get_execution_order(self) -> List[FeatureTestCase]:
        """拓扑排序解析执行顺序"""
        in_degree: Dict[str, int] = {fid: 0 for fid in self.cases}
        graph: Dict[str, List[str]] = {fid: [] for fid in self.cases}

        for fid, case in self.cases.items():
            for prereq in case.prerequisites:
                if prereq in self.cases:
                    graph[prereq].append(fid)
                    in_degree[fid] += 1

        queue = [fid for fid, deg in in_degree.items() if deg == 0]
        order = []

        while queue:
            curr = queue.pop(0)
            order.append(self.cases[curr])
            for neighbor in graph[curr]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        # 处理可能存在的环路或孤立项
        if len(order) < len(self.cases):
            remaining = [self.cases[fid] for fid in self.cases if self.cases[fid] not in order]
            order.extend(remaining)

        return order

    def get_ancestors(self, target_ids: List[str]) -> List[str]:
        """获取目标特性的所有直接与间接前置节点集合（包含目标本身）"""
        ancestors: List[str] = []
        visited = set()
        queue = list(target_ids)

        for tid in target_ids:
            if tid in self.cases and tid not in visited:
                visited.add(tid)
                ancestors.append(tid)

        while queue:
            curr = queue.pop(0)
            case = self.cases.get(curr)
            if not case:
                continue
            for prereq in case.prerequisites:
                if prereq in self.cases and prereq not in visited:
                    visited.add(prereq)
                    ancestors.append(prereq)
                    queue.append(prereq)
        return ancestors

    def prune_subgraph(self, target_ids: List[str]) -> List[FeatureTestCase]:
        """
        子图剪枝：根据指定的目标特性列表，推导最小前置依赖闭包，
        并返回拓扑排序后的最小执行序列。
        """
        if not target_ids:
            return self.get_execution_order()

        valid_targets = [tid for tid in target_ids if tid in self.cases]
        if not valid_targets:
            print(f"⚠️ 指定的目标特性均不在已注册用例中: {target_ids}")
            return []

        active_fids = set(self.get_ancestors(valid_targets))
        full_order = self.get_execution_order()
        subgraph_order = [case for case in full_order if case.feature_id in active_fids]

        pruned = [case.feature_id for case in full_order if case.feature_id not in active_fids]
        if pruned:
            print(f"✂️ [DAG 子图剪枝] 已自动剔除 {len(pruned)} 个非关联重型节点:")
            for pfid in pruned[:8]:
                print(f"   🚫 剪枝跳过: [{pfid}]")
            if len(pruned) > 8:
                print(f"   ... 以及其他 {len(pruned) - 8} 个节点")

        return subgraph_order

    def run(self, ctx: TestContext, target_ids: Optional[List[str]] = None) -> bool:
        """按拓扑顺序调度执行用例（支持目标子图剪枝）"""
        # 同步特性至 registry
        for case in self.cases.values():
            ctx.registry.register(case.to_feature())

        if target_ids:
            ordered_cases = self.prune_subgraph(target_ids)
            # 记录被剪枝的节点为 SKIP
            pruned_ids = [fid for fid in self.cases if fid not in {c.feature_id for c in ordered_cases}]
            for pid in pruned_ids:
                ctx.registry.record_result(pid, TestStatus.SKIP, 0.0, "子图剪枝免除执行")
        else:
            ordered_cases = self.get_execution_order()

        print(f"📋 [DAG 调度器] 解析拓扑依赖完成，执行序列包含 {len(ordered_cases)} 个用例。")

        for idx, case in enumerate(ordered_cases, 1):
            fid = case.feature_id
            print(f"\n[{idx}/{len(ordered_cases)}] ▶️ 调度特性: [{fid}] ({case.name})...")

            # 检查前置依赖
            failed_prereq = None
            for prereq in case.prerequisites:
                res = ctx.registry.get_result(prereq)
                if not res or res.status != TestStatus.PASS:
                    failed_prereq = prereq
                    break

            if failed_prereq:
                reason = f"前置依赖 [{failed_prereq}] 未通过，自动安全跳过"
                print(f"   ⏭️ [{fid}] SKIP: {reason}")
                ctx.registry.record_result(fid, TestStatus.SKIP, 0.0, reason)
                continue

            t0 = time.time()
            success = False
            message = ""
            details = None
            try:
                success, message, details = case.execute(ctx)
            except Exception as e:
                success = False
                message = f"执行异常: {e}"
                details = {"traceback": traceback.format_exc()}
                print(f"   ❌ [{fid}] 异常: {e}")
            finally:
                try:
                    case.teardown(ctx)
                except Exception as te:
                    print(f"   ⚠️ [{fid}] Teardown 异常: {te}")

            duration = time.time() - t0
            status = TestStatus.PASS if success else TestStatus.FAIL
            ctx.registry.record_result(fid, status, duration, message, details)

            dur_str = f"{duration:.1f}s" if duration >= 1.0 else f"{int(duration * 1000)}ms"
            if success:
                print(f"   ✅ [{fid}] PASS (耗时 {dur_str}): {message}")
            else:
                print(f"   ❌ [{fid}] FAIL (耗时 {dur_str}): {message}")

        # 生成最终检验矩阵
        print("\n" + ctx.registry.generate_matrix_report())

        # 校验关键特性
        has_failed_critical = False
        for case in ordered_cases:
            if case.critical:
                res = ctx.registry.get_result(case.feature_id)
                if not res or res.status != TestStatus.PASS:
                    has_failed_critical = True
                    status_str = res.status.value if res else "未执行"
                    print(f"❌ 关键特性 [{case.feature_id}] ({case.name}) 未通过 (状态: {status_str})！")
                    break

        return not has_failed_critical
