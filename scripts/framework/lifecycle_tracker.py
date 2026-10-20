#!/usr/bin/env python3
"""
scripts/framework/lifecycle_tracker.py
--------------------------------------
Gemini Exporter 在线测试会话生命周期管理器 (SessionLifecycleTracker).

核心原则：
1. 记录测试全过程中产生的所有在线会话 ID；
2. 永久保留测试会话：绝不自动物理删除正常会话，沉淀真实历史数据以更好地模拟多会话用户使用场景；
3. 瞬态自毁会话（feat_ephemeral_chat_pruning）由该用例在执行期自行触发网页端侧边栏删除，在此做状态登记；
4. 在测试结束阶段统一输出会话留存报告，无需人工维护清理开关。
"""

import sys
import os
import time
from typing import List, Set


class SessionLifecycleTracker:
    """在线会话生命周期追踪与留存报告器"""

    def __init__(self):
        self._tracked_chat_ids: List[str] = []
        self._deleted_chat_ids: Set[str] = set()

    def track(self, chat_id: str):
        """登记新创建的在线会话 ID"""
        if chat_id and chat_id not in self._tracked_chat_ids:
            self._tracked_chat_ids.append(chat_id)
            print(f"   📋 [生命周期追踪] 已登记测试会话 ID: {chat_id} (当前总计: {len(self._tracked_chat_ids)} 个)")

    def mark_deleted(self, chat_id: str):
        """标记某个会话已在测试中被提前销毁 (例如瞬态自毁测试)"""
        if chat_id:
            self._deleted_chat_ids.add(chat_id)

    def get_active_chats(self) -> List[str]:
        """获取当前依然保留的有效会话 ID 列表"""
        return [cid for cid in self._tracked_chat_ids if cid not in self._deleted_chat_ids]

    def teardown(self, cdp_gemini=None, **kwargs) -> int:
        """
        在测试执行器 finally 阶段统一报告保留的在线会话。
        完全废除自动删除逻辑，所有正常测试会话永久保留，用于持续模拟真实多会话环境。
        """
        active_chats = self.get_active_chats()
        if active_chats:
            print(f"\n💡 [测试会话保留] 本次测试创建的 {len(active_chats)} 个在线会话已完整保留 (IDs: {active_chats})，沉淀为真实用户历史环境。\n")
        else:
            print("\n💡 [测试会话保留] 本次测试无活跃保留会话。\n")
        return len(active_chats)
