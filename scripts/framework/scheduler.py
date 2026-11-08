"""Platform-independent feature contracts and dependency execution."""
from abc import ABC, abstractmethod
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple
from scripts.framework.features import Feature, FeatureDomain, TestStatus

class FeatureTestCase(ABC):
    def __init__(
        self,
        feature_id: str,
        domain: FeatureDomain,
        name: str,
        description: str,
        critical: bool = True,
        prerequisites: Optional[List[str]] = None,
        after: Optional[List[str]] = None
    ):
        self.feature_id = feature_id
        self.domain = domain
        self.name = name
        self.description = description
        self.critical = critical
        self.prerequisites = prerequisites or []
        # Ordering protects shared fixtures without making failures skip independent audits.
        self.after = after or []

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
    def execute(self, ctx: Any) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        """
        执行特性测试逻辑。
        返回 (success: bool, message: str, details: Optional[Dict])
        """
        pass

    def teardown(self, ctx: Any):
        """测试后清理（可选）"""
        pass

    def success_status(self, details: Optional[Dict[str, Any]]) -> TestStatus:
        """Completed audits may explicitly report WARN; failures still block."""
        return TestStatus.PASS


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
            for prereq in dict.fromkeys(case.prerequisites + case.after):
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

    def run(self, ctx: Any, target_ids: Optional[List[str]] = None) -> bool:
        """按拓扑顺序调度执行用例（支持目标子图剪枝）"""
        nonblocking_statuses = (TestStatus.PASS, TestStatus.WARN)
        # 同步特性至 registry
        for case in self.cases.values():
            ctx.registry.register(case.to_feature())

        if target_ids:
            if any(tid not in self.cases for tid in target_ids):
                print(f"❌ 存在未注册的目标特性: {target_ids}")
                return False
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
                if not res or res.status not in nonblocking_statuses:
                    failed_prereq = prereq
                    break

            if failed_prereq:
                reason = f"前置依赖 [{failed_prereq}] 未通过，自动安全跳过"
                print(f"   ⏭️ [{fid}] SKIP: {reason}")
                ctx.registry.record_result(fid, TestStatus.SKIP, 0.0, reason)
                continue

            checkpoint = getattr(ctx, 'browser_checkpoint', None)
            if checkpoint:
                checkpoint(fid)
            t0 = time.time()
            success = False
            status = TestStatus.FAIL
            message = ""
            details = None
            try:
                success, message, details = case.execute(ctx)
                status = case.success_status(details) if success else TestStatus.FAIL
                if status not in (TestStatus.PASS, TestStatus.WARN, TestStatus.FAIL):
                    raise ValueError('Executed cases must report PASS, WARN or FAIL')
            except Exception as e:
                success = False
                status = TestStatus.FAIL
                message = f"执行异常: {e}"
                details = {"traceback": traceback.format_exc()}
                print(f"   ❌ [{fid}] 异常: {e}")
            finally:
                try:
                    case.teardown(ctx)
                except Exception as te:
                    print(f"   ⚠️ [{fid}] Teardown 异常: {te}")

            duration = time.time() - t0
            ctx.registry.record_result(fid, status, duration, message, details)

            if checkpoint:
                checkpoint(fid + ':completed')

            dur_str = f"{duration:.1f}s" if duration >= 1.0 else f"{int(duration * 1000)}ms"
            if status == TestStatus.WARN:
                print(f"   ⚠️ [{fid}] WARN (耗时 {dur_str}): {message}")
            elif status == TestStatus.PASS:
                print(f"   ✅ [{fid}] PASS (耗时 {dur_str}): {message}")
            else:
                print(f"   ❌ [{fid}] FAIL (耗时 {dur_str}): {message}")

        # 生成最终检验矩阵
        print("\n" + ctx.registry.generate_matrix_report())

        # Every case must complete. Explicit audit warnings are nonblocking;
        # dependency skips and all failures (including noncritical) still fail.
        all_passed = True
        for case in ordered_cases:
            res = ctx.registry.get_result(case.feature_id)
            if not res or res.status not in nonblocking_statuses:
                all_passed = False
                status_str = res.status.value if res else "未执行"
                print(f"❌ 计划特性 [{case.feature_id}] ({case.name}) 未通过 (状态: {status_str})！")

        return all_passed
