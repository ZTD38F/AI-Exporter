# scripts/framework/features.py
"""
Declarative Feature Registry and Test Status Matrix.
Defines all testable capabilities of Gemini Exporter across 5 core lifecycle domains.
"""

import time
from enum import Enum
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any


class TestStatus(Enum):
    PENDING = "PENDING"
    PASS = "PASS"
    FAIL = "FAIL"
    SKIP = "SKIP"
    WARN = "WARN"


class FeatureDomain(Enum):
    PAGE_CHAT = "Gemini 网页端与多轮问答"
    LIFECYCLE = "会话生命周期与实时同步"
    TAKEOUT = "Takeout 离线导入与标题晋级"
    WORKBENCH = "工作台搜索、过滤与交互控制"
    EXPORT_DISK = "物理磁盘真实落盘与多模态双轨断言"


@dataclass
class Feature:
    id: str
    domain: FeatureDomain
    name: str
    description: str
    critical: bool = True
    prerequisites: List[str] = field(default_factory=list)


@dataclass
class TestResult:
    feature_id: str
    status: TestStatus
    duration_seconds: float = 0.0
    message: str = ""
    details: Optional[Dict[str, Any]] = None


class FeatureRegistry:
    def __init__(self):
        self._features: Dict[str, Feature] = {}
        self._results: Dict[str, TestResult] = {}
        self._init_standard_features()

    def _init_standard_features(self):
        # -------------------------------------------------------------
        # 领域一：Gemini 网页端与多轮问答
        # -------------------------------------------------------------
        self.register(Feature(
            id="feat_chat_generation",
            domain=FeatureDomain.PAGE_CHAT,
            name="真实多轮问答发帖",
            description="在 gemini.google.com 聚焦输入框并粘贴 Prompt，等待流式回复全部完成落地",
            critical=True
        ))
        self.register(Feature(
            id="feat_imagen_multimodal",
            domain=FeatureDomain.PAGE_CHAT,
            name="AI Imagen 生图与附件落地",
            description="包含生图指令的 Prompt 触发，网页成功渲染高分辨率生成图像",
            critical=True,
            prerequisites=["feat_chat_generation"]
        ))
        self.register(Feature(
            id="feat_inpage_export_badge",
            domain=FeatureDomain.PAGE_CHAT,
            name="页面端悬浮导出徽标",
            description="监听页面加载，徽标处于就绪状态，记录并响应拖拽位置持久化",
            critical=False
        ))
        self.register(Feature(
            id="feat_live_save_new_chat",
            domain=FeatureDomain.PAGE_CHAT,
            name="新会话实时落盘与状态验证",
            description="开着实时落盘生成新会话（场景一），验证本地磁盘自动落盘非空且工作台直接呈现「已导出」状态",
            critical=True,
            prerequisites=["feat_chat_generation"]
        ))

        # -------------------------------------------------------------
        # 领域二：会话生命周期与实时同步
        # -------------------------------------------------------------
        self.register(Feature(
            id="feat_continued_chat_promotion",
            domain=FeatureDomain.LIFECYCLE,
            name="老会话追加提问实时置顶",
            description="回访较早创建的会话追加提问，STREAM_COMPLETE 触发后在 Options 列表无刷新置顶至首位",
            critical=True,
            prerequisites=["feat_chat_generation"]
        ))
        self.register(Feature(
            id="feat_updated_badge_display",
            domain=FeatureDomain.LIFECYCLE,
            name="「已更新」徽章与智能勾选",
            description="已导出过的会话检测到新提问后，渲染琥珀色「已更新」徽章并被默认自动勾选",
            critical=True,
            prerequisites=["feat_continued_chat_promotion"]
        ))
        self.register(Feature(
            id="feat_live_auto_save_disk_write",
            domain=FeatureDomain.LIFECYCLE,
            name="老会话开启实时导出与增量更新落盘",
            description="已更新的老会话开启实时落盘并继续更新（场景二），验证物理写盘与「已导出」状态跃迁",
            critical=True,
            prerequisites=["feat_updated_badge_display"]
        ))
        self.register(Feature(
            id="feat_ephemeral_chat_pruning",
            domain=FeatureDomain.LIFECYCLE,
            name="瞬态会话网页端删除实时剥离",
            description="在网页端侧边栏删除会话，Options 列表与 Storage 在无需刷新情况下平滑剥离该项",
            critical=True
        ))
        self.register(Feature(
            id="feat_uninstall_lifecycle",
            domain=FeatureDomain.LIFECYCLE,
            name="扩展彻底卸载与隔离清理",
            description="通过 CDP 原生卸载扩展，验证长连接与 Content Script 优雅终止，重新安装时不产生脏状态交叉污染",
            critical=False
        ))

        # -------------------------------------------------------------
        # 领域三：Takeout 离线导入与标题晋级
        # -------------------------------------------------------------
        self.register(Feature(
            id="feat_takeout_zip_import",
            domain=FeatureDomain.TAKEOUT,
            name="离线 Takeout ZIP 导入",
            description="导入预置纯净 Takeout ZIP，离线附件池建立，初始提问前缀临时标题生效",
            critical=True
        ))
        self.register(Feature(
            id="feat_deep_scan_pagination",
            domain=FeatureDomain.TAKEOUT,
            name="全量拉取历史分页同步",
            description="点击【全量拉取历史】按钮，分页拉取所有云端会话，进度条正常推进至 100%",
            critical=True
        ))
        self.register(Feature(
            id="feat_authoritative_title_upgrade",
            domain=FeatureDomain.TAKEOUT,
            name="权威 RPC 标题覆盖晋级",
            description="全量拉取历史后，Takeout 临时标题被在线权威 RPC 标题平滑覆盖升级",
            critical=True,
            prerequisites=["feat_takeout_zip_import", "feat_deep_scan_pagination"]
        ))

        # -------------------------------------------------------------
        # 领域四：工作台搜索、过滤与交互控制
        # -------------------------------------------------------------
        self.register(Feature(
            id="feat_search_filter_by_id",
            domain=FeatureDomain.WORKBENCH,
            name="按会话 ID 搜索与精准勾选",
            description="在工作台搜索框输入目标会话 ID，列表即时过滤收缩只剩该项，并进行精准勾选",
            critical=True,
            prerequisites=["feat_takeout_zip_import"]
        ))
        self.register(Feature(
            id="feat_search_filter_by_keyword",
            domain=FeatureDomain.WORKBENCH,
            name="按标题关键词实时过滤",
            description="在工作台搜索框输入关键词（如 Python/量子），列表即时收缩为对应匹配项集合",
            critical=True,
            prerequisites=["feat_takeout_zip_import"]
        ))
        self.register(Feature(
            id="feat_search_clear_restore",
            domain=FeatureDomain.WORKBENCH,
            name="清空搜索框恢复完整列表",
            description="清空搜索框后列表完整恢复全量项，且先前勾选状态完好保留",
            critical=True,
            prerequisites=["feat_search_filter_by_id"]
        ))
        self.register(Feature(
            id="feat_selection_controls",
            domain=FeatureDomain.WORKBENCH,
            name="全选 / 取消全选联动控制",
            description="点击【全选】与【取消全选】按钮，底部已勾选计数精准联动 (0 -> N -> 0)",
            critical=True,
            prerequisites=["feat_takeout_zip_import"]
        ))
        self.register(Feature(
            id="feat_language_toggle",
            domain=FeatureDomain.WORKBENCH,
            name="中英文语言切换与状态驻留",
            description="切换至 English 再切回中文，界面文案正确切换且已勾选状态完整保持",
            critical=False,
            prerequisites=["feat_takeout_zip_import"]
        ))
        self.register(Feature(
            id="feat_tour_guide_interactive",
            domain=FeatureDomain.WORKBENCH,
            name="新手向导交互与 0 遮挡防撞",
            description="推进向导步骤，气泡与高亮目标 0 遮挡重叠，完成后写入 Storage 持久化标记",
            critical=False
        ))

        # -------------------------------------------------------------
        # 领域五：物理磁盘真实落盘与多模态双轨断言
        # -------------------------------------------------------------
        self.register(Feature(
            id="feat_zip_export_download",
            domain=FeatureDomain.EXPORT_DISK,
            name="手动勾选 ZIP 导出与落盘",
            description="点击【导出选中 -> ZIP】主按钮，进度条视觉反馈，下载落盘并校验文件非空",
            critical=True
        ))
        self.register(Feature(
            id="feat_multimodal_spec_assertion",
            domain=FeatureDomain.EXPORT_DISK,
            name="4 大黄金分类规范断言",
            description="解压导出的 ZIP，严格断言 Frontmatter 7 键、附件非空、AI Imagen 模型归属",
            critical=True,
            prerequisites=["feat_zip_export_download"]
        ))
        self.register(Feature(
            id="feat_fast_skip_exported",
            domain=FeatureDomain.EXPORT_DISK,
            name="跳过已导出会话前置极速过滤",
            description="勾选【跳过已导出】时，已导出会话前置分流瞬间跳过（防空 ZIP 保护），含新会话时精准分流导出",
            critical=True,
            prerequisites=["feat_multimodal_spec_assertion"]
        ))
        self.register(Feature(
            id="feat_html_export_download",
            domain=FeatureDomain.EXPORT_DISK,
            name="HTML 独立网页 ZIP 导出与落盘核验",
            description="切换导出格式为 HTML (.html)，下载 ZIP 并解压，严格断言独立网页结构、CSS 样式与附件落地",
            critical=True,
            prerequisites=["feat_fast_skip_exported"]
        ))
        self.register(Feature(
            id="feat_pdf_export_download",
            domain=FeatureDomain.EXPORT_DISK,
            name="PDF 真实编译 ZIP 导出与落盘核验",
            description="切换导出格式为 PDF (.pdf)，通过沙箱 Typst WASM 真实编译导出 ZIP，解压严格断言 %PDF- 二进制规范与非空",
            critical=True,
            prerequisites=["feat_html_export_download"]
        ))
        self.register(Feature(
            id="feat_stale_tab_image_export",
            domain=FeatureDomain.EXPORT_DISK,
            name="失效 Gemini 标签页下的图片导出",
            description="旧标签页无消息接收端时仍成功导出 Imagen 图片与引用",
            critical=True,
            prerequisites=["feat_pdf_export_download"]
        ))

    def register(self, feature: Feature):
        self._features[feature.id] = feature

    def get_feature(self, feature_id: str) -> Optional[Feature]:
        return self._features.get(feature_id)

    def record_result(self, feature_id: str, status: TestStatus, duration_seconds: float = 0.0, message: str = "", details: Optional[Dict[str, Any]] = None):
        self._results[feature_id] = TestResult(
            feature_id=feature_id,
            status=status,
            duration_seconds=duration_seconds,
            message=message,
            details=details or {}
        )

    def get_result(self, feature_id: str) -> Optional[TestResult]:
        return self._results.get(feature_id)

    def all_features(self) -> List[Feature]:
        return list(self._features.values())

    def generate_matrix_report(self) -> str:
        lines = []
        lines.append("=" * 80)
        lines.append(" 📊 Gemini Exporter — 全流程功能特性检验矩阵 (Feature Verification Matrix)")
        lines.append("=" * 80)

        domain_order = [
            FeatureDomain.PAGE_CHAT,
            FeatureDomain.LIFECYCLE,
            FeatureDomain.TAKEOUT,
            FeatureDomain.WORKBENCH,
            FeatureDomain.EXPORT_DISK
        ]

        total_count = len(self._features)
        passed_count = sum(1 for r in self._results.values() if r.status == TestStatus.PASS)
        failed_count = sum(1 for r in self._results.values() if r.status == TestStatus.FAIL)
        skipped_count = sum(1 for r in self._results.values() if r.status == TestStatus.SKIP)
        warn_count = sum(1 for r in self._results.values() if r.status == TestStatus.WARN)

        for domain in domain_order:
            dom_feats = [f for f in self._features.values() if f.domain == domain]
            if not dom_feats:
                continue

            lines.append(f"\n📂 【{domain.value}】")
            lines.append(f" {'ID':<34} | {'功能名称':<26} | {'状态':<8} | {'耗时':<7} | {'结果简述'}")
            lines.append("-" * 96)

            for f in dom_feats:
                r = self._results.get(f.id)
                status_icon = "⚪ PENDING"
                duration_str = "--"
                msg = ""
                if r:
                    if r.status == TestStatus.PASS:
                        status_icon = "✅ PASS"
                    elif r.status == TestStatus.FAIL:
                        status_icon = "❌ FAIL"
                    elif r.status == TestStatus.WARN:
                        status_icon = "⚠️ WARN"
                    elif r.status == TestStatus.SKIP:
                        status_icon = "⏭️ SKIP"

                    if r.duration_seconds >= 1.0:
                        duration_str = f"{r.duration_seconds:.1f}s"
                    else:
                        duration_str = f"{int(r.duration_seconds * 1000)}ms"
                    msg = r.message

                lines.append(f" {f.id:<34} | {f.name:<24} | {status_icon:<8} | {duration_str:<7} | {msg}")

        lines.append("\n" + "=" * 80)
        overall_status = "🎉 全部通过 (ALL PASSED)" if failed_count == 0 and passed_count > 0 else ("⚠️ 存在失败项" if failed_count > 0 else "未完成")
        lines.append(f" 汇总统计: 总计 {total_count} 项 | 通过: {passed_count} | 失败: {failed_count} | 跳过: {skipped_count} | 警告: {warn_count}")
        lines.append(f" 最终判定: {overall_status}")
        lines.append("=" * 80)
        return "\n".join(lines)
