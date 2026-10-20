#!/usr/bin/env python3
"""
scripts/test_visual_agent.py
----------------------------
Gemini Exporter — Visual AI Testing Playground & Autonomous QA Agent (Tier 3)

Architecture & Two Pathways:
1. 途径一：无 Context 子智能体自主探索 (Subagent Mode, --playground)
   - 宿主 Agent（如 Antigravity）使用 invoke_subagent 拉起一个全新无历史上下文污染的子智能体。
   - 子智能体严格通过受控的 7 大 CLI 接口 (scripts/visual_agent/cli.py) 以纯视觉截屏感知与硬件级动作驱动。
   - 零 DOM 树泄露，绝对沙箱隔离。

2. 途径二：自定义 / 第三方 AI 接口驱动 (Custom AI API Mode, --api / --custom-ai)
   - 通过配置自定义多模态接口 (CUSTOM_AI_ENDPOINT)，由 CustomAIVisionProvider 驱动 AutonomousVisualAgent
   - 在真实或测试环境中自主完成探索目标并输出 UX 审计报告与 Scorecard。
"""

import sys
import os
import time
import argparse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.cdp_client import CDP_DEFAULT_PORT
from scripts.visual_agent.playground import open_visual_playground, VisualPlayground
from scripts.visual_agent.agent import AutonomousVisualAgent
from scripts.visual_agent.scorecard import VisualUXScorecard
from scripts.visual_agent.providers.custom_ai_provider import CustomAIVisionProvider


DEFAULT_OBJECTIVES = [
    "探索并完成新手向导，验证引导气泡与聚焦目标无视觉遮挡，点击下一步直至向导完成。",
    "巡检工作台排版，验证所有核心控制按钮文本完整无截断，并核验模态遮罩层能够阻止背景误触。",
    "导入 Takeout 数据包，选中代表性多模态会话，执行 ZIP 导出并验证物理落地。"
]


def run_playground_mode(
    port: int = CDP_DEFAULT_PORT,
    target_page: str = "options",
    output_dir: str = None,
    reinstall: bool = False
) -> bool:
    """
    Pathway 1: Launches the Visual Playground for autonomous Subagent exploration.
    Initializes environment and outputs the 7 curated CLI interfaces.
    """
    print("=" * 68)
    print(" 🎮 Gemini Exporter — 途径一：纯视觉测试交互靶场已就绪 (Subagent Mode)")
    print("=" * 68)

    playground = open_visual_playground(
        port=port,
        target_page=target_page,
        output_dir=output_dir,
        reinstall=reinstall
    )
    try:
        obs = playground.capture_screen(f"playground_{target_page}_ready")
        print(f" [👀 感知] 初始全景截屏已就绪: {obs.file_path}")
        print(f" [🎯 目标] 活动测试页面: {target_page} (视口尺寸: 1280x800)")
        print("\n 🛠️ 供无 Context 子智能体 (Subagent) 调用的 7 大受控 CLI 交互接口 (0 DOM 泄露):")
        print("   1. 📸 截取当前画面:   python3 scripts/visual_agent/cli.py screenshot --target <target> [--name <name>]")
        print("   2. 🖱️ 物理鼠标点击:   python3 scripts/visual_agent/cli.py click --target <target> --x <0.0-1.0> --y <0.0-1.0>")
        print("   3. ⌨️ 物理键盘键入:   python3 scripts/visual_agent/cli.py type --target <target> --text \"<text>\" [--x <x> --y <y>]")
        print("   4. 📜 物理滚轮滚动:   python3 scripts/visual_agent/cli.py scroll --target <target> --delta <pixels>")
        print("   5. ⏳ 确定性挂起等待: python3 scripts/visual_agent/cli.py wait-on --condition <cond> [--timeout <s>]")
        print("   6. 🔄 重置靶场环境:   python3 scripts/visual_agent/cli.py reset --target <target> [--reinstall]")
        print("   7. 📦 规范断言评测:   python3 scripts/visual_agent/cli.py evaluate-export --zip <path>")
        print("\n [✅ 就绪] 靶场处于完全可用状态。宿主 Agent 可通过 invoke_subagent 拉起子智能体进行探索推演。")
        return True
    finally:
        playground.teardown()


def run_custom_ai_mode(
    goal: str,
    endpoint: str = None,
    api_key: str = None,
    model: str = None,
    port: int = CDP_DEFAULT_PORT,
    target_page: str = "options",
    output_dir: str = None,
    max_steps: int = 25,
    reinstall: bool = False,
    ai_review: bool = False
) -> bool:
    """
    Pathway 2: Runs AutonomousVisualAgent driven by a custom multimodal AI API endpoint.
    """
    ep = endpoint or os.environ.get("CUSTOM_AI_ENDPOINT")
    if not ep:
        print("=" * 68)
        print(" [❌ 错误] 途径二 (自定义 AI 模式) 需要配置自定义多模态接口 Endpoint！")
        print(" 请通过 --endpoint 参数或 CUSTOM_AI_ENDPOINT 环境变量提供接口 URL。")
        print(" 例如: --endpoint http://localhost:8000/v1/chat/completions")
        print(" 若需通过子智能体探索，请使用途径一: npm run test:visual")
        print("=" * 68)
        return False

    print("=" * 68)
    print(" 🚀 启动 AutonomousVisualAgent 自定义 AI 多模态视觉闭环推演 (Pathway 2)")
    print(f" 🌐 接口端点: {ep}")
    if model:
        print(f" 🧠 模型名称: {model}")
    print(f" 🎯 目标任务: {goal}")
    if ai_review:
        print(" 🔍 多模态视觉审查: 已开启 (--ai-review)")
    print("=" * 68)

    playground = open_visual_playground(
        port=port,
        target_page=target_page,
        output_dir=output_dir,
        reinstall=reinstall
    )
    scorecard = VisualUXScorecard(output_dir=playground.output_dir)
    provider = CustomAIVisionProvider(
        endpoint=ep,
        api_key=api_key,
        model=model
    )
    agent = AutonomousVisualAgent(playground=playground, provider=provider, scorecard=scorecard)

    try:
        result = agent.run_objective(goal, max_steps=max_steps)
        if ai_review and scorecard.screenshots:
            print("\n 🤖 启动自定义多模态全景视觉质检与体验体检...")
            review_text = provider.review_screenshots(scorecard.screenshots)
            scorecard.ai_review = review_text
            print(" [✅ 完成] 多模态视觉审查意见已注入 Scorecard 审计报告")
        scorecard.save()
        return result.success
    finally:
        playground.teardown()


def main():
    parser = argparse.ArgumentParser(
        description="Gemini Exporter Visual AI Testing Playground (Tier 3: Two Pathways Only)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
支持且仅支持的两大测试途径:
  途径一 (Subagent Mode):
    python3 scripts/test_visual_agent.py --playground [--target options|popup|gemini]
  途径二 (Custom AI API Mode):
    python3 scripts/test_visual_agent.py --api --endpoint <url> [--goal <text>] [--model <name>]
"""
    )
    parser.add_argument("--port", type=int, default=CDP_DEFAULT_PORT, help="Chrome CDP port (default: 9222)")
    parser.add_argument("--output-dir", type=str, default=None, help="Output directory for screenshots")
    parser.add_argument("--target", type=str, default="options", choices=["options", "gemini", "popup"], help="Target page (default: options)")
    parser.add_argument("--no-reinstall", action="store_true", help="跳过纯净重装 (默认启动时纯净重装扩展)")

    # Pathway 1
    parser.add_argument("--playground", action="store_true", help="[途径一] 启动视觉交互靶场供 Subagent 进行自主探索与交互")

    # Pathway 2
    parser.add_argument("--api", "--custom-ai", dest="custom_ai", action="store_true", help="[途径二] 通过自定义/第三方多模态 AI 接口执行推演")
    parser.add_argument("--endpoint", type=str, default=None, help="自定义多模态接口 Endpoint URL (或通过 CUSTOM_AI_ENDPOINT 环境变量配置)")
    parser.add_argument("--api-key", type=str, default=None, help="自定义接口 API Key (或通过 CUSTOM_AI_API_KEY 环境变量配置)")
    parser.add_argument("--model", type=str, default=None, help="自定义接口模型名称 (或通过 CUSTOM_AI_MODEL 环境变量配置)")
    parser.add_argument("--goal", type=str, default=None, help="自主推演的自然语言目标任务 (途径二使用)")
    parser.add_argument("--max-steps", type=int, default=25, help="推演步数上限 (默认: 25)")
    parser.add_argument("--ai-review", action="store_true", help="在推演完成后调用自定义多模态接口进行截屏 UX 质检审查")

    args = parser.parse_args()
    do_reinstall = not args.no_reinstall

    if args.custom_ai or args.endpoint or args.goal:
        goal = args.goal or DEFAULT_OBJECTIVES[0]
        success = run_custom_ai_mode(
            goal=goal,
            endpoint=args.endpoint,
            api_key=args.api_key,
            model=args.model,
            port=args.port,
            target_page=args.target,
            output_dir=args.output_dir,
            max_steps=args.max_steps,
            reinstall=do_reinstall,
            ai_review=args.ai_review
        )
    elif args.playground:
        success = run_playground_mode(
            port=args.port,
            target_page=args.target,
            output_dir=args.output_dir,
            reinstall=do_reinstall
        )
    else:
        # Default behavior: run playground mode (Pathway 1) so human/subagent can immediately interact
        success = run_playground_mode(
            port=args.port,
            target_page=args.target,
            output_dir=args.output_dir,
            reinstall=do_reinstall
        )

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
