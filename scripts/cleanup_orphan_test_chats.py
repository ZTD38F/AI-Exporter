#!/usr/bin/env python3
"""
scripts/cleanup_orphan_test_chats.py
------------------------------------
一键清理 Gemini 网页端侧边栏中历史残留的测试孤儿会话。
根据测试题材特征（赛博枯山水、发帖按钮测试、新对话测试等）进行匹配，
通过 CDP 原生触发三点菜单 -> 删除 -> 确认物理清除，恢复纯净状态。
"""

import sys
import os
import time
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.cdp_client import CDPConnection, get_tabs, is_gemini_url

TEST_TITLE_KEYWORDS = [
    "赛博",
    "cyberpunk",
    "zen garden",
    "枯山水",
    "发帖按钮与交互实现",
    "新对话状态测试",
    "瞬态会话",
    "测试发帖"
]


def cleanup_orphan_chats(port=9222):
    tabs = get_tabs(port)
    gemini_tab = next((t for t in tabs if t.get("type", "page") == "page" and is_gemini_url(t.get("url", ""))), None)
    if not gemini_tab:
        print("❌ 未在 127.0.0.1:9222 中找到 gemini.google.com 页面！")
        return 0

    cdp = CDPConnection(gemini_tab["webSocketDebuggerUrl"])
    try:
        from scripts.framework.driver.gemini_driver import GeminiPlatformDriver
        driver = GeminiPlatformDriver(cdp)
        print("🔍 正在扫描 Gemini 侧边栏中的测试残留会话...")
        deleted_count = 0

        while True:
            # 获取当前侧边栏中匹配的孤儿测试会话
            candidates = cdp.eval(f"""
            (() => {{
                const keywords = {json.dumps(TEST_TITLE_KEYWORDS)};
                const items = Array.from(document.querySelectorAll('gem-nav-list-item[data-test-id="conversation"]'));
                const matched = [];
                for (const item of items) {{
                    const a = item.querySelector('a[href*="/app/"]');
                    if (!a) continue;
                    const href = a.getAttribute('href') || '';
                    const m = href.match(/\\/app\\/([a-f0-9]+)/);
                    const cid = m ? m[1] : null;
                    const text = (a.textContent || '').trim().toLowerCase();
                    const isTest = keywords.some(kw => text.includes(kw.toLowerCase()));
                    if (isTest && cid) {{
                        matched.push({{ id: cid, title: (a.textContent || '').trim().replace(/\\s+/g, ' ') }});
                    }}
                }}
                return matched;
            }})()
            """) or []

            if not candidates:
                break

            target = candidates[0]
            cid = target["id"]
            title = target["title"]
            print(f"   🗑️ 正在删除孤儿会话: [{cid}] '{title}'...")

            success = driver.delete_chat_via_web(cid)
            if success:
                deleted_count += 1
                print(f"      ✓ 已成功物理删除 [{cid}]")
            else:
                print(f"      ⚠️ 未能删除会话，跳过 [{cid}]")
                break

            time.sleep(1.0)

        print(f"\n✨ 清理完毕！共物理删除 {deleted_count} 个测试孤儿会话。")
        return deleted_count
    finally:
        cdp.close()


if __name__ == "__main__":
    cleanup_orphan_chats()
