#!/usr/bin/env python3
"""
scripts/test_live_chat_and_export.py
------------------------------------
Gemini Exporter 全流程特性驱动测试入口 (Feature-Driven Live Chat & Export Test).
基于 scripts/framework 模块化测试框架：
- 声明式 19 大功能特性 (FeatureRegistry) 跨 5 大生命周期领域
- CDP 操作原语 (CDPActions) 与 规范级严格断言 (CDPAssertions)
- 自动化执行编排器 (FrameworkRunner)
- 磁盘实时保存严格核验 (严禁 0 字节图片与对话)
- 4 大黄金分类多模态规范断言 (ExportSpecificationAsserter)
"""

import sys
import os
import json
import time
import argparse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True, encoding="utf-8")
except Exception:
    pass

from scripts.framework.features import FeatureRegistry, FeatureDomain, TestStatus
from scripts.framework.actions import CDPActions
from scripts.framework.assertions import CDPAssertions
from scripts.framework.runner import FrameworkRunner, DEFAULT_SCENARIOS, DESIGNATED_HISTORICAL_CHATS
from scripts.framework.pipeline import ProcessLock, ProcessLockError

try:
    from scripts.cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url
except ImportError:
    from cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url

CDP_DEFAULT_PORT = 9222


# -------------------------------------------------------------
# 向上兼容辅助函数 (Backward Compatibility Delegates)
# -------------------------------------------------------------
def reinstall_extension_via_cdp(port=CDP_DEFAULT_PORT, repo_path=None):
    return CDPActions.reinstall_extension(port=port, repo_path=repo_path)


def verify_onboarding_tour(port=CDP_DEFAULT_PORT, ext_id=None, timeout=15):
    return CDPActions.verify_onboarding_tour(port=port, ext_id=ext_id, timeout=timeout)


def wait_for_gemini_ready(cdp, max_wait=30):
    return CDPActions.wait_for_gemini_ready(cdp, max_wait=max_wait)


def get_current_chat_id(cdp):
    return CDPActions.get_current_chat_id(cdp)


def get_current_chat_title(cdp):
    return CDPActions.get_current_chat_title(cdp)


def send_turn(cdp, turn_input, max_wait=240):
    return CDPActions.send_gemini_turn(cdp, turn_input, max_wait=max_wait)


def run_live_chat_and_export(
    dataset=None,
    port=CDP_DEFAULT_PORT,
    output_dir=None,
    delay=2,
    takeout_zip=None,
    target_features=None,
    domain=None
):
    """
    执行全流程特性驱动测试。
    实例化 FrameworkRunner 并执行 5 大领域 22 项功能特性 DAG 调度验证。
    """
    runner = FrameworkRunner(
        port=port,
        output_dir=output_dir,
        dataset=dataset,
        delay=delay,
        takeout_zip=takeout_zip,
        target_features=target_features,
        domain=domain
    )
    return runner.run()


def load_custom_dataset(dataset_path):
    """
    加载自定义测试数据集 JSON 文件。
    若未指定路径返回 (True, None)；
    若文件不存在或非合法 JSON 返回 (False, 错误原因)；
    加载成功返回 (True, 数据列表或字典)。
    """
    if not dataset_path:
        return True, None

    if not os.path.isfile(dataset_path):
        return False, f"❌ 指定的数据集文件不存在: {dataset_path}"

    try:
        with open(dataset_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return True, data
    except Exception as e:
        return False, f"❌ 读取数据集 JSON 失败: {e}"


def validate_dataset_freshness(dataset_path, allow_stale=False, max_age_seconds=None):
    """向上兼容旧接口，直接委托给 load_custom_dataset"""
    return load_custom_dataset(dataset_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini 特性驱动全流程实跑测试 (Feature-Driven Live Chat & Export Test)")
    parser.add_argument("--features", default=None, help="指定单项或多项待测特性 ID（逗号分隔，如 feat_search_filter_by_keyword,feat_language_toggle）")
    parser.add_argument("--domain", default=None, help="指定待测生命周期领域（chat / lifecycle / takeout / workbench / export）")
    parser.add_argument("--list-features", action="store_true", help="打印所有已注册特性清单及其依赖关系拓扑")
    parser.add_argument("--pool", action="store_true", help="从动态场景池中自动消费最新多模态场景（默认行为）")
    parser.add_argument("--dataset", default=None, help="可选自定义外挂测试数据集 JSON 文件路径（默认从动态场景池调度）")
    parser.add_argument("--output-dir", default=None, help="测试导出落地目录")
    parser.add_argument("--port", type=int, default=CDP_DEFAULT_PORT, help="Chrome CDP 远程调试端口")
    parser.add_argument("--delay", type=int, default=6, help="轮次之间的人性化安全冷却秒数 (默认 6 秒，防机械发帖)")
    parser.add_argument("--takeout-zip", default=None, help="自定义预置 Takeout ZIP 样本路径")
    args = parser.parse_args()

    if args.list_features:
        features = FrameworkRunner.list_all_features()
        print("\n" + "=" * 90)
        print("📋 Gemini Exporter DAG 声明式特性注册表 (Feature Registry)")
        print("=" * 90)
        print(f"{'特性 ID':<35} | {'领域':<12} | {'关键':<4} | {'前置依赖'}")
        print("-" * 90)
        for f in features:
            crit = "★ 是" if f["critical"] else "  否"
            prereqs = ", ".join(f["prerequisites"]) if f["prerequisites"] else "(无)"
            print(f"{f['id']:<35} | {f['domain']:<12} | {crit:<4} | {prereqs}")
        print("=" * 90)
        print(f"💡 总计: {len(features)} 项已注册特性。")
        print("💡 运行单项/多项特性: python3 scripts/test_live_chat_and_export.py --features <id1>,<id2>")
        print("💡 按生命周期领域运行: python3 scripts/test_live_chat_and_export.py --domain <workbench|takeout|export|...>\n")
        sys.exit(0)

    custom_dataset = None
    if args.dataset:
        valid, result_or_err = load_custom_dataset(args.dataset)
        if not valid:
            print(result_or_err)
            sys.exit(1)
        custom_dataset = result_or_err

    try:
        with ProcessLock():
            success = run_live_chat_and_export(
                dataset=custom_dataset,
                port=args.port,
                output_dir=args.output_dir,
                delay=args.delay,
                takeout_zip=args.takeout_zip,
                target_features=args.features,
                domain=args.domain
            )
    except ProcessLockError as ple:
        print(ple)
        sys.exit(1)

    sys.exit(0 if success else 1)
