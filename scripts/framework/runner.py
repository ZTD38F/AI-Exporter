# scripts/framework/runner.py
"""
Feature-Driven Test Runner Orchestrator.
Uses DAGRunner to resolve dependencies across FeatureTestCases,
executing features across 5 lifecycle domains and generating the verification matrix.
"""

import os
import re
import sys
import time
import json
import urllib.request
from typing import Optional, Dict, Any, List, Set, Union

from .features import FeatureDomain, FeatureRegistry, TestStatus
from .actions import CDPActions
from .assertions import CDPAssertions
from scripts.framework.cases import (
    TestContext,
    DAGRunner,
    TourGuideCase,
    InpageBadgeCase,
    ChatGenerationCase,
    ImagenMultimodalCase,
    ContinuedChatPromotionCase,
    UpdatedBadgeDisplayCase,
    EphemeralChatPruningCase,
    UninstallLifecycleCase,
    TakeoutZipImportCase,
    DeepScanPaginationCase,
    AuthoritativeTitleUpgradeCase,
    SearchKeywordCase,
    SearchIdCase,
    SearchClearCase,
    SelectionControlsCase,
    LanguageToggleCase,
    LiveSaveNewChatCase,
    LiveDiskAutoSaveCase,
    ZipExportDownloadCase,
    MultimodalSpecCase,
    StaleTabImageExportCase,
    FastSkipExportedCase,
    HtmlExportDownloadCase,
    PdfExportDownloadCase,
    DESIGNATED_HISTORICAL_CHATS
)

try:
    from scripts.cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url, is_gemini_url
except ImportError:
    from cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url, is_gemini_url


DEFAULT_SCENARIOS = [
    {
        "id": "scenario_python_concurrency",
        "title": "Python高性能并发系统与异步架构演进",
        "turns": [
            "请解释 Python GIL (全局解释器锁) 的底层工作机制，以及它为什么限制了多线程在 CPU 密集型任务中的并行能力？",
            "在处理海量 I/O 密集型网络请求时，对比 threading、multiprocessing 与 asyncio 三种方案的内存开销与吞吐量差异。",
            "请使用 Python asyncio 和 aiohttp 编写一个并发限制为 5 的异步抓取示例，要求包含超时控制与指数退避重试逻辑。",
            "为刚才编写的异步抓取器设计一个基于内存的 TTL/LRU 缓存装饰器，防止短时间内对相同 URL 重复发起抓取。",
            "请总结在生产环境中排查 Python 异步服务事件循环卡顿 (Event Loop Lag) 和协程内存泄漏的 3 个最有效策略。"
        ]
    },
    {
        "id": "scenario_distributed_architecture",
        "title": "分布式系统高可用架构与最终一致性实战",
        "turns": [
            "请详细阐述分布式系统中的 CAP 定理，并对比 CP 系统 (如 etcd) 与 AP 系统 (如 Cassandra) 在分区容忍时的设计哲学。",
            "在大型高并发秒杀系统中，如何基于 Redis Lua 脚本与 MySQL 设计一套高性能、防超卖的库存预扣方案？",
            "在上述预扣方案中，如果 Redis 扣减成功但后续消息队列异步落盘失败，应该设计怎样的补偿与对账机制来保证数据最终一致性？",
            "请用简洁的 ASCII 纯字符流程图绘制上述秒杀链路中 API 网关、Redis 预扣、消息队列与数据库落库的数据流转过程。",
            "请为这套秒杀系统生成一张架构概念图片：赛博朋克科技感风格的分布式高并发服务器机群与微服务数据流全景图。"
        ]
    }
]


class FrameworkRunner:
    def __init__(
        self,
        port: int = 9222,
        output_dir: Optional[str] = None,
        dataset: Optional[Any] = None,
        delay: int = 2,
        takeout_zip: Optional[str] = None,
        target_features: Optional[Any] = None,
        domain: Optional[str] = None
    ):
        self.port = port
        self.output_dir = os.path.abspath(output_dir or os.path.join(os.path.dirname(__file__), "..", "..", "tests", "output", "live_export"))
        self.dataset = dataset
        self.delay = delay
        self.takeout_zip = takeout_zip or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "gemini_takeout_clean.zip"))
        self.target_features = target_features
        self.domain = domain

        # 组装 DAG 调度器并解析目标子图与前置闭包
        self.dag = self._assemble_dag()
        self.target_ids = self._resolve_target_ids(self.target_features, self.domain)

        # 确定执行节点集合 (包含直接目标与传递前置闭包)
        gemini_required_fids = {
            "feat_inpage_badge_dom",
            "feat_chat_generation",
            "feat_imagen_multimodal_turn",
            "feat_continued_chat_promotion",
            "feat_ephemeral_chat_pruning"
        }
        if self.target_ids is not None:
            ancestors = set(self.dag.get_ancestors(self.target_ids))
            subgraph_fids = ancestors | set(self.target_ids)
            self.needs_gemini = bool(subgraph_fids & gemini_required_fids)
            self.needs_live_scenarios = "feat_chat_generation" in subgraph_fids
        else:
            self.needs_gemini = True
            self.needs_live_scenarios = True

        self.ctx = TestContext(
            port=self.port,
            output_dir=self.output_dir,
            dataset=self.dataset,
            delay=self.delay,
            takeout_zip=self.takeout_zip,
            pop_scenarios=False
        )

        # 向上兼容字段映射
        self.provider = self.ctx.provider
        self.tracker = self.ctx.tracker
        self.scenarios = self.ctx.scenarios
        self.registry = self.ctx.registry

    @property
    def ext_id(self):
        return self.ctx.ext_id

    @ext_id.setter
    def ext_id(self, val):
        self.ctx.ext_id = val

    @property
    def chat_records(self):
        return self.ctx.chat_records

    @staticmethod
    def _assemble_dag() -> DAGRunner:
        dag = DAGRunner()
        dag.register(TourGuideCase())
        dag.register(InpageBadgeCase())
        dag.register(ChatGenerationCase())
        dag.register(ImagenMultimodalCase())
        dag.register(LiveSaveNewChatCase())
        dag.register(ContinuedChatPromotionCase())
        dag.register(UpdatedBadgeDisplayCase())
        dag.register(LiveDiskAutoSaveCase())
        dag.register(EphemeralChatPruningCase())
        dag.register(TakeoutZipImportCase())
        dag.register(DeepScanPaginationCase())
        dag.register(AuthoritativeTitleUpgradeCase())
        dag.register(SearchKeywordCase())
        dag.register(SearchIdCase())
        dag.register(SearchClearCase())
        dag.register(SelectionControlsCase())
        dag.register(LanguageToggleCase())
        dag.register(ZipExportDownloadCase())
        dag.register(MultimodalSpecCase())
        dag.register(FastSkipExportedCase())
        dag.register(HtmlExportDownloadCase())
        dag.register(PdfExportDownloadCase())
        dag.register(StaleTabImageExportCase())
        dag.register(UninstallLifecycleCase())
        return dag

    @staticmethod
    def _normalize_domain(domain_input: str) -> Optional[FeatureDomain]:
        d_clean = domain_input.strip().lower()
        mapping = {
            "page_chat": FeatureDomain.PAGE_CHAT,
            "chat": FeatureDomain.PAGE_CHAT,
            "lifecycle": FeatureDomain.LIFECYCLE,
            "takeout": FeatureDomain.TAKEOUT,
            "workbench": FeatureDomain.WORKBENCH,
            "export": FeatureDomain.EXPORT_DISK,
            "export_disk": FeatureDomain.EXPORT_DISK,
        }
        if d_clean in mapping:
            return mapping[d_clean]
        for fd in FeatureDomain:
            if d_clean == fd.name.lower() or d_clean == fd.value.lower():
                return fd
        return None

    def _resolve_target_ids(self, target_features: Optional[Any], domain: Optional[str]) -> Optional[List[str]]:
        if not target_features and not domain:
            return None

        resolved: Set[str] = set()

        if target_features:
            if isinstance(target_features, str):
                features_list = [f.strip() for f in target_features.split(",") if f.strip()]
            else:
                features_list = list(target_features)
            for fid in features_list:
                if fid not in self.dag.cases:
                    valid_ids = ", ".join(sorted(self.dag.cases.keys()))
                    raise ValueError(f"未知特性 ID: '{fid}'. 有效的特性 ID 包括: {valid_ids}")
                resolved.add(fid)

        if domain:
            fd = self._normalize_domain(domain)
            if not fd:
                valid_domains = ["chat", "lifecycle", "takeout", "workbench", "export"]
                raise ValueError(f"未知领域 '{domain}'. 支持的领域包括: {', '.join(valid_domains)}")
            for fid, case in self.dag.cases.items():
                if case.domain == fd:
                    resolved.add(fid)

        return sorted(list(resolved))

    @classmethod
    def list_all_features(cls) -> List[Dict[str, Any]]:
        dag = cls._assemble_dag()
        feature_list = []
        for case in dag.get_execution_order():
            feature_list.append({
                "id": case.feature_id,
                "name": case.name,
                "domain": case.domain.name,
                "domain_title": case.domain.value,
                "critical": case.critical,
                "prerequisites": case.prerequisites,
                "description": case.description
            })
        return feature_list

    def run(self) -> bool:
        """执行 DAG 特性依赖驱动测试，并在 finally 阶段输出会话留存报告"""
        try:
            return self._execute_lifecycle()
        finally:
            try:
                self.tracker.teardown()
            except Exception as e:
                print(f"⚠️ [生命周期管理] 异常: {e}")

    def _execute_lifecycle(self) -> bool:
        print("=" * 80)
        print("🚀 启动 Gemini Exporter DAG 特性驱动测试执行器 (DAG Feature Runner)")
        print(f"📁 导出落盘目录: {self.output_dir}")
        print(f"🌐 Chrome 调试端口: 127.0.0.1:{self.port}")
        if self.target_ids:
            print(f"🎯 显式目标特性: {self.target_ids}")
            print("⚡ 运行模式: DAG 局部依赖闭包剪枝执行 (免发无谓帖子，非必要不发帖)")
        else:
            print(f"🌐 运行模式: 全量 {len(self.dag.cases)} 大特性闭环全量执行 (Full Regression)")
        print("=" * 80)

        # 步骤 0：统一环境初始化 (扩展卸载重装、标签页确保、Gemini 刷新、下载落盘)
        print("\n🔄 [步骤 0] 通过 TestEnvironment 纯净重装扩展并标准化测试环境...")
        target_pages = ("gemini", "options") if self.needs_gemini else ("options",)
        env_ctx = self.ctx.env.init_environment(
            reinstall=True,
            target_pages=target_pages,
            reload_gemini=self.needs_gemini,
            setup_download=True
        )
        self.ext_id = env_ctx.ext_id
        self.ctx.ext_id = env_ctx.ext_id
        if not self.ext_id:
            print("❌ 扩展安装失败，终止运行！")
            return False
        if self.needs_gemini and not env_ctx.gemini_tab:
            print("❌ 未在 Chrome 中找到或创建 gemini.google.com 页面，请先启动测试浏览器！")
            return False

        # 如果执行计划中不包含向导用例，预先闭合新手向导避免遮挡后续工作台交互
        if self.target_ids and "feat_tour_guide_interactive" not in self.target_ids:
            try:
                CDPActions.verify_onboarding_tour(port=self.port, ext_id=self.ext_id, timeout=5)
            except Exception:
                pass

        # 执行调度
        return self.dag.run(self.ctx, target_ids=self.target_ids)
