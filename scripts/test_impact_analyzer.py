#!/usr/bin/env python3
"""
scripts/test_impact_analyzer.py
-------------------------------
Gemini Exporter 依赖感知测试影响分析器 (Dependency-Aware Test Impact Analyzer).

核心能力：
1. 模块反向依赖图构建 (Reverse Dependency Graph)：通过快速解析 TS/JS import/require 构建模块依赖；
2. 传递闭包追溯 (Transitive Closure BFS)：精确向下追溯任意底层改动所直接与间接影响的所有模块与测试；
3. 全局核心文件兜底 (Global Fallback)：修改全局构建/配置时自动触发全量测试；
4. 文档/静态资源极速旁路 (Docs-Only Bypass)：纯文档/资源变更 0 测试秒级通过；
5. E2E 规格精准映射 (E2E Component Mapping)：将改动的组件精确路由至对应的 Playwright 规格测试。
"""

import os
import sys
import re
import json
import argparse
import subprocess
from collections import defaultdict, deque
from typing import Set, List, Dict, Tuple, Optional

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 全局核心文件：任一文件变更均触发全量测试
GLOBAL_FILES = {
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "build.js",
    "manifest.json",
    ".github/workflows/test.yml",
    "tests/ts_register.js",
    "tests/run_tests.py",
    "scripts/test_impact_analyzer.py"
}

# 忽略扫描的目录
IGNORE_DIRS = {".git", "node_modules", "dist", "store_assets", ".gemini"}

# 纯静态/文档文件正则
STATIC_DOCS_PATTERN = re.compile(
    r"^(.*\.(md|png|jpg|jpeg|svg|ico)|docs/.*|icons/.*|store_assets/.*|scripts/test_scenario_(pool|archive)\.json)$",
    re.IGNORECASE
)

# Import/Require/Dynamic-Import 语句正则 (严格忽略仅类型导入 import type / export type)
IMPORT_PATTERN = re.compile(
    r"""(?:import|export)\s+(?!type\s)(?:[\s\w{},*]+\s+from\s+)?[\x27\x22]([^\x27\x22]+)[\x27\x22]|(?:require|import)\s*\(\s*[\x27\x22]([^\x27\x22]+)[\x27\x22]\s*\)"""
)

# 组件与 E2E Spec 映射表
COMPONENT_E2E_MAP = {
    "src/ui/options": [
        "tests/e2e/workbench_ui.spec.ts",
        "tests/e2e/export_flow.spec.ts",
        "tests/e2e/export_zip.spec.ts",
        "tests/e2e/json_export.spec.ts",
        "tests/e2e/legacy_data_healing.spec.ts",
        "tests/e2e/multi_tier_title_arbitration.spec.ts",
        "tests/e2e/scan_flow.spec.ts",
        "tests/e2e/takeout_limit_prompt.spec.ts",
        "tests/e2e/visual_inspector.spec.ts",
        "tests/e2e/export_session_recovery.spec.ts"
    ],
    "src/content": [
        "tests/e2e/page_sync.spec.ts",
        "tests/e2e/realtime_delete.spec.ts",
        "tests/e2e/direct_write_prompt.spec.ts",
        "tests/e2e/live_save.spec.ts"
    ],
    "src/background": [
        "tests/e2e/live_save.spec.ts",
        "tests/e2e/export_flow.spec.ts",
        "tests/e2e/export_zip.spec.ts",
        "tests/e2e/realtime_delete.spec.ts"
    ]
}


def normalize_repo_path(path: str, base_dir: str = REPO_DIR) -> str:
    """将绝对或相对路径规整为相对于 REPO_DIR 的标准正斜杠路径"""
    if os.path.isabs(path):
        rel = os.path.relpath(path, base_dir)
    else:
        rel = os.path.relpath(os.path.join(base_dir, path), base_dir)
    return rel.replace("\\", "/")


def resolve_import_path(source_file: str, import_str: str, base_dir: str = REPO_DIR) -> Optional[str]:
    """
    根据源码路径与 import 字符串，解析出在仓库中存在的标准目标文件路径。
    支持 .js -> .ts 互转与 index.ts/js 解析。
    """
    if not import_str.startswith("."):
        return None  # 外部包或内置库

    src_dir = os.path.dirname(os.path.join(base_dir, source_file))
    target_base = os.path.normpath(os.path.join(src_dir, import_str))

    candidates = [target_base]
    if target_base.endswith(".js"):
        candidates.append(target_base[:-3] + ".ts")
    elif target_base.endswith(".ts"):
        candidates.append(target_base[:-3] + ".js")
    else:
        candidates.extend([
            target_base + ".ts",
            target_base + ".js",
            target_base + ".json",
            os.path.join(target_base, "index.ts"),
            os.path.join(target_base, "index.js"),
        ])

    for cand in candidates:
        if os.path.isfile(cand):
            return normalize_repo_path(cand, base_dir)

    return None


class DependencyGraph:
    """仓库全量 TypeScript / JavaScript 模块依赖图"""
    def __init__(self, base_dir: str = REPO_DIR):
        self.base_dir = base_dir
        # target_file -> set(files that import target_file)
        self.dependents: Dict[str, Set[str]] = defaultdict(set)
        # source_file -> set(files that source_file imports)
        self.dependencies: Dict[str, Set[str]] = defaultdict(set)
        self._build_graph()

    def _build_graph(self):
        for root, dirs, files in os.walk(self.base_dir):
            # 过滤不需要的目录
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
            for f in files:
                if f.endswith((".ts", ".js")):
                    full_p = os.path.join(root, f)
                    rel_p = normalize_repo_path(full_p, self.base_dir)
                    try:
                        with open(full_p, "r", encoding="utf-8", errors="ignore") as fp:
                            content = fp.read()
                        for m in IMPORT_PATTERN.finditer(content):
                            imp = m.group(1) or m.group(2)
                            resolved = resolve_import_path(rel_p, imp, self.base_dir)
                            if resolved:
                                self.dependencies[rel_p].add(resolved)
                                self.dependents[resolved].add(rel_p)
                    except Exception:
                        pass

    def get_transitive_dependents(self, changed_files: Set[str]) -> Set[str]:
        """通过 BFS 获取所有变更文件的传递闭包受影响集合"""
        visited: Set[str] = set()
        queue = deque(list(changed_files))

        for f in changed_files:
            visited.add(f)

        while queue:
            curr = queue.popleft()
            for dep in self.dependents.get(curr, set()):
                if dep not in visited:
                    visited.add(dep)
                    queue.append(dep)

        return visited


def get_git_changed_files(base_ref: Optional[str] = None, base_dir: str = REPO_DIR) -> Set[str]:
    """从 Git 获取当前工作树中的所有改动文件（含未暂存、暂存、未跟踪与分支差异）"""
    changed: Set[str] = set()

    def run_cmd(cmd_list):
        try:
            res = subprocess.run(cmd_list, cwd=base_dir, capture_output=True, text=True)
            if res.returncode == 0:
                return [line.strip() for line in res.stdout.splitlines() if line.strip()]
        except Exception:
            pass
        return []

    # 1. 未跟踪文件
    for f in run_cmd(["git", "ls-files", "--others", "--exclude-standard"]):
        changed.add(normalize_repo_path(f, base_dir))

    # 2. 未暂存的修改
    for f in run_cmd(["git", "diff", "--name-only"]):
        changed.add(normalize_repo_path(f, base_dir))

    # 3. 暂存区的修改
    for f in run_cmd(["git", "diff", "--name-only", "--cached"]):
        changed.add(normalize_repo_path(f, base_dir))

    # 4. 相对于基准分支的修改
    if not base_ref:
        # 尝试自动检测 base_ref (origin/main 或 main)
        refs_to_try = ["origin/main", "main", "origin/dev", "dev"]
        for r in refs_to_try:
            check = subprocess.run(["git", "rev-parse", "--verify", r], cwd=base_dir, capture_output=True)
            if check.returncode == 0:
                base_ref = r
                break

    if base_ref:
        # 使用三点 diff 获取从分叉点以来的改动
        for f in run_cmd(["git", "diff", "--name-only", f"{base_ref}...HEAD"]):
            changed.add(normalize_repo_path(f, base_dir))

    # 过滤空值与不存在的文件（已删除的文件保留其相对路径以追溯影响）
    return {f for f in changed if f}


class ImpactAnalysisResult:
    def __init__(
        self,
        changed_files: List[str],
        affected_files: Set[str],
        is_all_affected: bool,
        is_docs_only: bool,
        all_unit_tests: List[str],
        all_e2e_specs: List[str]
    ):
        self.changed_files = sorted(changed_files)
        self.affected_files = sorted(affected_files)
        self.is_all_affected = is_all_affected
        self.is_docs_only = is_docs_only
        self.all_unit_tests = sorted(all_unit_tests)
        self.all_e2e_specs = sorted(all_e2e_specs)

        # 筛选计算出最终执行的测试集合
        if self.is_all_affected:
            self.target_unit_tests = self.all_unit_tests
            self.target_e2e_specs = self.all_e2e_specs
        elif self.is_docs_only:
            self.target_unit_tests = []
            self.target_e2e_specs = []
        else:
            # 1. 传递闭包直接命中测试文件
            unit_set = set()
            for f in self.affected_files:
                if f.startswith("tests/") and (f.endswith(".test.ts") or f.endswith(".test.js")):
                    unit_set.add(f)
            self.target_unit_tests = sorted(unit_set)

            # 2. E2E 规格测试判定
            e2e_set = set()
            # 如果 spec 文件自身被修改或依赖
            for f in self.affected_files:
                if f.startswith("tests/e2e/") and f.endswith(".spec.ts"):
                    e2e_set.add(f)

            # 如果影响到 core 模块，则所有 E2E 均可能受影响
            if any(f.startswith("src/core/") for f in self.affected_files):
                e2e_set.update(self.all_e2e_specs)
            else:
                # 检查特定组件映射
                for prefix, specs in COMPONENT_E2E_MAP.items():
                    if any(f.startswith(prefix) for f in self.affected_files):
                        e2e_set.update(specs)

            self.target_e2e_specs = sorted(e2e_set)

    def to_dict(self) -> Dict:
        return {
            "is_all_affected": self.is_all_affected,
            "is_docs_only": self.is_docs_only,
            "changed_files_count": len(self.changed_files),
            "changed_files": self.changed_files,
            "affected_files_count": len(self.affected_files),
            "affected_unit_tests_count": len(self.target_unit_tests),
            "target_unit_tests": self.target_unit_tests,
            "affected_e2e_specs_count": len(self.target_e2e_specs),
            "target_e2e_specs": self.target_e2e_specs
        }


def analyze_impact(
    changed_files: Set[str],
    graph: Optional[DependencyGraph] = None,
    base_dir: str = REPO_DIR
) -> ImpactAnalysisResult:
    """主入口：根据改动文件列表计算传递依赖与测试影响结果"""
    if graph is None:
        graph = DependencyGraph(base_dir=base_dir)

    # 扫描收集仓库中的全量测试清单
    all_unit_tests = []
    all_e2e_specs = []
    for root, _, files in os.walk(os.path.join(base_dir, "tests")):
        for f in files:
            p = normalize_repo_path(os.path.join(root, f), base_dir)
            if p.startswith("tests/e2e/") and p.endswith(".spec.ts"):
                all_e2e_specs.append(p)
            elif p.startswith("tests/") and not p.startswith("tests/e2e/") and (p.endswith(".test.ts") or p.endswith(".test.js")):
                all_unit_tests.append(p)

    norm_changed = {normalize_repo_path(f, base_dir) for f in changed_files if f}

    if not norm_changed:
        return ImpactAnalysisResult([], set(), False, True, all_unit_tests, all_e2e_specs)

    # 1. 检查是否命中全局核心文件
    if any(f in GLOBAL_FILES for f in norm_changed):
        return ImpactAnalysisResult(list(norm_changed), norm_changed, True, False, all_unit_tests, all_e2e_specs)

    # 2. 检查是否全部为文档/静态文件
    if all(STATIC_DOCS_PATTERN.match(f) for f in norm_changed):
        return ImpactAnalysisResult(list(norm_changed), norm_changed, False, True, all_unit_tests, all_e2e_specs)

    # 3. 计算传递闭包
    affected = graph.get_transitive_dependents(norm_changed)

    return ImpactAnalysisResult(
        list(norm_changed),
        affected,
        False,
        False,
        all_unit_tests,
        all_e2e_specs
    )


def main():
    parser = argparse.ArgumentParser(description="Gemini Exporter 依赖感知测试影响分析器")
    parser.add_argument("--base", default=None, help="对比基准 Git 分支/Commit (默认自动识别 origin/main 或 main)")
    parser.add_argument("--files", nargs="*", default=None, help="显式指定变更文件列表（用于测试或指定范围）")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出完整分析结果")
    parser.add_argument("--unit-only", action="store_true", help="仅输出受影响的单元测试文件列表（空格分隔）")
    parser.add_argument("--e2e-only", action="store_true", help="仅输出受影响的 E2E spec 列表（空格分隔）")
    parser.add_argument("--summary", action="store_true", help="打印人类友好的摘要报告")
    args = parser.parse_args()

    if args.files is not None:
        changed_files = set(args.files)
    else:
        changed_files = get_git_changed_files(base_ref=args.base)

    graph = DependencyGraph()
    result = analyze_impact(changed_files, graph=graph)

    if args.json:
        print(json.dumps(result.to_dict(), indent=2, ensure_ascii=False))
        return

    if args.unit_only:
        print(" ".join(result.target_unit_tests))
        return

    if args.e2e_only:
        print(" ".join(result.target_e2e_specs))
        return

    # 默认或 --summary 格式输出
    sep = "=" * 70
    print(sep)
    print("🔍 Gemini Exporter — 依赖感知测试影响分析报告 (Test Impact Analysis)")
    print(sep)
    print(f"📁 变更文件数: {len(result.changed_files)}")
    for cf in result.changed_files[:10]:
        print(f"  • {cf}")
    if len(result.changed_files) > 10:
        print(f"  ... 以及其他 {len(result.changed_files) - 10} 个文件")

    print(f"\n🌊 传递闭包影响总文件数: {len(result.affected_files)}")
    if result.is_all_affected:
        print("⚠️ 命中全局核心配置文件，已激活【全量全套测试兜底】！")
    elif result.is_docs_only:
        print("⚡ 变更纯属文档/静态资源，受影响测试集为 0，秒级安全放行！")
    else:
        print(f"🧪 受影响单元测试 ({len(result.target_unit_tests)}/{len(result.all_unit_tests)}):")
        for ut in result.target_unit_tests:
            print(f"  ✓ {ut}")
        print(f"🎭 受影响 Playwright E2E 规格 ({len(result.target_e2e_specs)}/{len(result.all_e2e_specs)}):")
        for st in result.target_e2e_specs:
            print(f"  ✓ {st}")
    print(sep)


if __name__ == "__main__":
    main()
