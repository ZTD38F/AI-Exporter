#!/usr/bin/env python3
"""
scripts/run_changed_tests.py
----------------------------
Tier 1 依赖感知增量测试统一编排入口 (Tier 1 Incremental Test Runner).

流程：
1. 分析当前 Git 改动（或传入文件）的传递依赖闭包；
2. 若为纯文档/静态资源改动，0 测试秒级放行；
3. 执行 TypeScript 严格类型检查 (tsc --noEmit)；
4. 执行受影响的单元测试套件 (python3 tests/run_tests.py --changed)；
5. 执行 esbuild 极速构建校验 (node build.js)；
6. 若有受影响的 Playwright E2E 规格测试，精准执行对应 spec 文件，否则跳过。
"""

import os
import sys
import argparse
import subprocess
from typing import List

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
scripts_dir = os.path.join(REPO_DIR, "scripts")
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

from test_impact_analyzer import get_git_changed_files, analyze_impact, DependencyGraph


def main():
    parser = argparse.ArgumentParser(description="Tier 1 依赖感知增量测试执行器")
    parser.add_argument("--base", default=None, help="Git 对比基准分支 (默认自动识别 origin/main 或 main)")
    parser.add_argument("--files", nargs="*", default=None, help="显式指定变更文件列表")
    parser.add_argument("--skip-e2e", action="store_true", help="跳过 Playwright E2E 测试")
    parser.add_argument("--skip-typecheck", action="store_true", help="跳过 TypeScript 类型检查")
    args = parser.parse_args()

    print("=" * 70)
    print("⚡ Gemini Exporter — Tier 1 依赖感知增量测试 (Incremental Test Runner)")
    print("=" * 70)

    # 1. 影响分析
    changed_files = set(args.files) if args.files is not None else get_git_changed_files(base_ref=args.base, base_dir=REPO_DIR)
    graph = DependencyGraph(base_dir=REPO_DIR)
    impact = analyze_impact(changed_files, graph=graph, base_dir=REPO_DIR)

    if impact.is_docs_only:
        print(f"📁 变更文件 ({len(impact.changed_files)} 个):")
        for cf in impact.changed_files:
            print(f"  • {cf}")
        print("\n⚡ 变更纯属文档或静态资源，无需执行代码与浏览器测试，秒级安全放行！")
        print("=" * 70)
        print("🎉 INCREMENTAL TESTS PASSED SUCCESSFULLY! (0s)")
        print("=" * 70)
        sys.exit(0)

    if impact.is_all_affected:
        print("⚠️ 检测到全局核心配置文件变更，已激活【全量全套测试执行】！")
    else:
        print(f"📁 变更文件: {len(impact.changed_files)} 个 | 传递闭包影响: {len(impact.affected_files)} 个模块")
        print(f"🧪 受影响单元测试: {len(impact.target_unit_tests)} 个 | 🎭 受影响 E2E 规格: {len(impact.target_e2e_specs)} 个")

    # 2. TypeScript 类型检查
    if not args.skip_typecheck:
        print("\n📘 [步骤 1/4] TypeScript 全局严格类型检查 (tsc --noEmit)...")
        res = subprocess.run(["npm", "run", "type-check"], cwd=REPO_DIR)
        if res.returncode != 0:
            print("❌ TypeScript 类型检查未通过！")
            sys.exit(res.returncode)
        print("  ✓ TypeScript strict check passed")

    # 3. 受影响单元测试
    print("\n🧪 [步骤 2/4] 运行受影响的单元测试套件...")
    unit_cmd = [sys.executable, os.path.join(REPO_DIR, "tests", "run_tests.py"), "--changed"]
    if args.base:
        unit_cmd.extend(["--base", args.base])
    if args.files is not None:
        unit_cmd.extend(["--files"] + args.files)
    res = subprocess.run(unit_cmd, cwd=REPO_DIR)
    if res.returncode != 0:
        print("❌ 单元测试套件执行失败！")
        sys.exit(res.returncode)

    # 4. 构建验证
    print("\n📦 [步骤 3/4] 构建 dist bundles (node build.js)...")
    res = subprocess.run(["node", "build.js"], cwd=REPO_DIR)
    if res.returncode != 0:
        print("❌ 打包构建失败！")
        sys.exit(res.returncode)

    # 5. Playwright E2E 规格测试
    if not args.skip_e2e:
        if impact.target_e2e_specs:
            print(f"\n🎭 [步骤 4/4] 运行受影响的 Playwright E2E 规格 ({len(impact.target_e2e_specs)} 个)...")
            for spec in impact.target_e2e_specs:
                print(f"  • {spec}")
            e2e_cmd = ["npx", "playwright", "test"] + impact.target_e2e_specs
            res = subprocess.run(e2e_cmd, cwd=REPO_DIR)
            if res.returncode != 0:
                print("❌ Playwright E2E 规格测试失败！")
                sys.exit(res.returncode)
        else:
            print("\n🎭 [步骤 4/4] 本次改动未波及 E2E 测试范围，跳过 Playwright 测试。")

    print("\n" + "=" * 70)
    print("🎉 TIER 1 增量测试全部顺利通过 (ALL INCREMENTAL TESTS PASSED)!")
    print("=" * 70)


if __name__ == "__main__":
    main()
