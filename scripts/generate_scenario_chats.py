#!/usr/bin/env python3
"""
scripts/generate_scenario_chats.py
----------------------------------
数据驱动的 Gemini 真实多轮测试对话生成器 (纯标准库，零 Token 消耗)。
基于 Chrome DevTools Protocol (CDP) WebSocket 协议，自动按配置在测试 Chrome 中生成多轮对话与生图内容。

使用方法:
    # 1. 确保测试浏览器正在运行 (端口 9222)
    ./scripts/open_test_chrome.sh

    # 2. 运行默认数据集生成所有测试对话
    python3 scripts/generate_scenario_chats.py

    # 3. 指定自定义数据集
    python3 scripts/generate_scenario_chats.py --dataset scripts/my_custom_chats.json

    # 4. 仅跑某一个场景
    python3 scripts/generate_scenario_chats.py --only multi_turn_coding
"""

import sys
import os
import json
import time
import socket
import base64
import struct
import argparse
import urllib.request
import urllib.error

try:
    from scripts.cdp_client import CDPConnection, get_tabs, CDP_DEFAULT_PORT, is_gemini_url
except ImportError:
    from cdp_client import CDPConnection, get_tabs, CDP_DEFAULT_PORT, is_gemini_url

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass


def get_gemini_tab(port=CDP_DEFAULT_PORT):
    tabs = get_tabs(port)
    if not tabs:
        print(f"❌ 无法连接到 Chrome CDP 端口 {port}")
        print("💡 请先运行 ./scripts/open_test_chrome.sh 启动测试浏览器")
        sys.exit(1)

    for tab in tabs:
        if tab.get("type", "page") == "page" and is_gemini_url(tab.get("url", "")):
            return tab

    # 未找到则尝试新开一个
    new_url = f"http://127.0.0.1:{port}/json/new?https://gemini.google.com/app"
    req = urllib.request.Request(new_url, method="PUT")
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))



def wait_for_ready(cdp, max_wait=30):
    from scripts.framework.actions import CDPActions
    return CDPActions.wait_for_gemini_ready(cdp, max_wait=max_wait)


def send_turn(cdp, prompt_text, max_wait=180, is_image=False):
    from scripts.framework.driver.gemini_driver import GeminiPlatformDriver
    driver = GeminiPlatformDriver(cdp)
    return driver.execute_turn_pipeline(prompt_text, max_wait=max_wait, is_image=is_image)


def get_current_chat_id(cdp):
    from scripts.framework.actions import CDPActions
    return CDPActions.get_current_chat_id(cdp)


def run_scenarios(dataset_path, port=CDP_DEFAULT_PORT, delay=2, only_id=None):
    if not os.path.isfile(dataset_path):
        print(f"❌ 数据集文件不存在: {dataset_path}")
        sys.exit(1)

    with open(dataset_path, "r", encoding="utf-8") as f:
        scenarios = json.load(f)

    if only_id:
        scenarios = [s for s in scenarios if s.get("id") == only_id]
        if not scenarios:
            print(f"❌ 未找到匹配 ID 为 '{only_id}' 的场景")
            sys.exit(1)

    print("=" * 65)
    print(f"🚀 启动数据驱动的真实测试对话生成器 (共 {len(scenarios)} 个场景)")
    print(f"📂 数据集来源: {dataset_path}")
    print(f"🌐 目标 CDP: 127.0.0.1:{port}")
    print("=" * 65)

    tab = get_gemini_tab(port)
    ws_url = tab["webSocketDebuggerUrl"]
    cdp = CDPConnection(ws_url)

    from scripts.framework.driver.gemini_driver import GeminiPlatformDriver
    driver = GeminiPlatformDriver(cdp)

    results = []

    try:
        # 严格校验并锁定模型为 3.8 Flash + Extended thinking
        print("🔒 校验锁定模型环境 (3.8 Flash + Extended thinking)...")
        driver.ensure_model(target_model="3.8 Flash", target_thinking=True)

        for idx, sc in enumerate(scenarios, 1):
            sc_id = sc.get("id", f"sc_{idx}")
            title = sc.get("title", f"场景 {idx}")
            turns = sc.get("turns", [])
            desc = sc.get("description", "")

            print(f"\n[{idx}/{len(scenarios)}] 🎬 开始场景: {title} ({sc_id})")
            if desc:
                print(f"    ℹ️  {desc}")
            print(f"    🔄 计划轮次: {len(turns)} 轮")

            # 开启新会话: 导航至 /app
            cdp.eval("location.href = 'https://gemini.google.com/app'")
            if not driver.ensure_ready(timeout=30.0):
                print(f"    ❌ 页面加载就绪超时，跳过此场景")
                continue

            time.sleep(1.5)
            chat_id = None
            successful_turns = 0

            for turn_idx, turn in enumerate(turns, 1):
                prompt = turn if isinstance(turn, str) else turn.get("prompt", "")
                preview = (prompt[:45] + "...") if len(prompt) > 45 else prompt
                print(f"    ▶️ 轮次 {turn_idx}/{len(turns)}: \"{preview}\"")

                is_img = any(kw in prompt.lower() for kw in ["生成一张", "绘制一张", "画一张", "generate an image", "draw an image", "create an image"])
                ok, msg = driver.execute_turn_pipeline(prompt, max_wait=180, is_image=is_img)
                if ok:
                    successful_turns += 1
                    chat_id = driver.get_current_chat_id() or chat_id
                    print(f"       ✅ 完成 (当前会话 ID: {chat_id or '生成中'})")
                else:
                    print(f"       ⚠️ {msg}")

                if turn_idx < len(turns):
                    time.sleep(delay)

            results.append({
                "id": sc_id,
                "title": title,
                "chat_id": chat_id,
                "total_turns": len(turns),
                "successful_turns": successful_turns
            })

            print(f"    🏁 场景完成: {successful_turns}/{len(turns)} 轮成功")
            time.sleep(delay)

    finally:
        cdp.close()

    print("\n" + "=" * 65)
    print("🎉 所有测试场景对话生成执行完毕！汇总统计:")
    print("=" * 65)
    for r in results:
        status = "✅ 成功" if r["successful_turns"] == r["total_turns"] else "⚠️ 部分成功"
        print(f"{status} | 会话 ID: {r['chat_id'] or '未知'} | 轮数: {r['successful_turns']}/{r['total_turns']} | {r['title']}")
    print("=" * 65)
    print("💡 接下来可切换至 Gemini Exporter 工作台点击【增量扫描】，即可查验新生成的多轮会话！")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini 数据驱动测试对话生成器")
    parser.add_argument("--pool", action="store_true", help="从动态场景池 (test_scenario_pool.json) 消费场景")
    parser.add_argument("--count", type=int, default=2, help="场景池消费数量 (默认 2)")
    parser.add_argument("--dataset", default=os.path.join(os.path.dirname(__file__), "test_scenario_pool.json"), help="测试场景数据集 JSON 路径")
    parser.add_argument("--port", type=int, default=CDP_DEFAULT_PORT, help="Chrome CDP 远程调试端口")
    parser.add_argument("--delay", type=int, default=2, help="轮次之间的间隔秒数")
    parser.add_argument("--only", default=None, help="仅运行指定 ID 的场景")
    args = parser.parse_args()

    ds_path = args.dataset
    if args.pool:
        try:
            from scripts.manage_scenario_pool import consume_scenarios, DEFAULT_POOL_PATH
        except ImportError:
            from manage_scenario_pool import consume_scenarios, DEFAULT_POOL_PATH
        import tempfile
        selected, _ = consume_scenarios(pool_path=DEFAULT_POOL_PATH, count=args.count, require_imagen=True)
        tmp_f = tempfile.NamedTemporaryFile("w", delete=False, suffix=".json", encoding="utf-8")
        json.dump(selected, tmp_f, ensure_ascii=False, indent=2)
        tmp_f.close()
        ds_path = tmp_f.name

    try:
        run_scenarios(dataset_path=ds_path, port=args.port, delay=args.delay, only_id=args.only)
    finally:
        if args.pool and ds_path and os.path.isfile(ds_path):
            try:
                os.remove(ds_path)
            except Exception:
                pass
