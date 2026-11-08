#!/usr/bin/env python3
"""
scripts/test_live_chat_and_export.py
------------------------------------
平台插件驱动的 Tier 2 入口。公共 DAG 与生命周期支持多选平台，
平台用例与环境差异由 scripts/framework/platforms 注册的插件提供。
旧版 Gemini 辅助接口保留兼容。
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


def main(argv=None):
    from scripts.framework.platforms import load_plugins, RunConfig, Tier2Runner
    parser = argparse.ArgumentParser(description="Platform-independent Tier 2 live acceptance")
    parser.add_argument('--platforms', '--platform', '--provider', dest='platforms',
                        nargs='+', action='append', help='Registered platform IDs (space/comma separated), or all')
    parser.add_argument('--plugin', action='append', default=[], help='Python module exporting register(registry)')
    parser.add_argument('--list-platforms', action='store_true')
    parser.add_argument('--list-features', action='store_true')
    parser.add_argument('--plan', action='store_true', help='Validate and print plans without touching Chrome or the scenario pool')
    parser.add_argument('--features', default=None)
    parser.add_argument('--domain', default=None)
    parser.add_argument('--pool', action='store_true', help='Use the shared scenario pool (default)')
    parser.add_argument('--dataset', default=None)
    parser.add_argument('--output-dir', default=None)
    parser.add_argument('--port', type=int, default=CDP_DEFAULT_PORT)
    parser.add_argument('--delay', type=int, default=6)
    parser.add_argument('--platform-option', action='append', default=[], metavar='PLATFORM.KEY=VALUE',
                        help='Plugin option, scoped to its platform; VALUE may be JSON')
    parser.add_argument('--takeout-zip', default=None, help='Compatibility alias for gemini.takeout_zip')
    args = parser.parse_args(argv)
    try:
        registry = load_plugins(args.plugin)
        if args.list_platforms:
            print(json.dumps([{'id': p.id, 'capabilities': p.capabilities,
                               'options': p.accepted_options} for p in registry.select(['all'])],
                             ensure_ascii=False, indent=2))
            return 0
        plugins = registry.select([item for group in (args.platforms or [['gemini']]) for item in group])
        options = {}
        for item in args.platform_option:
            key, value = item.split('=', 1)
            platform, option = key.split('.', 1)
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
            options.setdefault(platform, {})[option] = value
        if args.takeout_zip:
            options.setdefault('gemini', {})['takeout_zip'] = args.takeout_zip
        valid, dataset = load_custom_dataset(args.dataset)
        if not valid:
            parser.error(dataset)
        domain = {'chat': 'page_chat', 'export': 'export_disk'}.get(args.domain, args.domain)
        targets = ','.join(part.strip() for part in args.features.split(',')) if args.features else None
        config = RunConfig(port=args.port, output_dir=args.output_dir, dataset=dataset,
                           delay=args.delay, target_features=targets, domain=domain, options=options)
        runner = Tier2Runner(plugins, config)
        if args.list_features or args.plan:
            print(json.dumps(runner.plan(), ensure_ascii=False, indent=2))
            return 0
        with ProcessLock():
            return 0 if runner.run() else 1
    except (ValueError, ProcessLockError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    sys.exit(main())
