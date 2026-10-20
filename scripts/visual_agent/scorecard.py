# scripts/visual_agent/scorecard.py
"""
Structured UX Scorecard and Self-Healing Report Generator.
Outputs Markdown and HTML reports covering feature flow, visual clipping risks, and self-healing trails.
"""

import os
import json
import time
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any


@dataclass
class SelfHealingEvent:
    step_name: str
    instruction: str
    attempt: int
    reason: str
    action_taken: str
    duration_seconds: float
    resolved: bool


@dataclass
class VisualRisk:
    category: str
    element_description: str
    risk_level: str  # "LOW", "MEDIUM", "HIGH"
    details: str
    screenshot_ref: Optional[str] = None


class VisualUXScorecard:
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.features_explored: List[Dict[str, Any]] = []
        self.self_healing_events: List[SelfHealingEvent] = []
        self.visual_risks: List[VisualRisk] = []
        self.screenshots: List[Dict[str, Any]] = []
        self.start_time = time.time()

    def record_feature(self, name: str, domain: str, status: str, duration: float, notes: str = ""):
        self.features_explored.append({
            "name": name,
            "domain": domain,
            "status": status,
            "duration": duration,
            "notes": notes
        })

    def record_self_healing(self, event: SelfHealingEvent):
        self.self_healing_events.append(event)

    def record_risk(self, risk: VisualRisk):
        self.visual_risks.append(risk)

    def record_screenshot(self, name: str, path: str, note: str = ""):
        self.screenshots.append({
            "name": name,
            "path": path,
            "note": note,
            "time": time.strftime("%Y-%m-%d %H:%M:%S")
        })

    def generate_markdown(self) -> str:
        total_time = time.time() - self.start_time
        lines = []
        lines.append("# 🎨 Gemini Exporter 纯视觉 AI 盲测与体验体检报告 (UX & Visual Audit Scorecard)")
        lines.append(f"\n- **审计时间**: {time.strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"- **总耗时**: {total_time:.1f} 秒")
        lines.append(f"- **体验特性数**: {len(self.features_explored)} 项")
        lines.append(f"- **自愈重试次数**: {len(self.self_healing_events)} 次")
        lines.append(f"- **潜在体验风险**: {len(self.visual_risks)} 项")

        lines.append("\n## 1. 实际体验过的功能与操作流列表 (Features Explored)")
        lines.append("| 功能名称 | 所属领域 | 状态 | 耗时 | 体验备注 |")
        lines.append("| :--- | :--- | :--- | :--- | :--- |")
        for f in self.features_explored:
            status_icon = "✅ PASS" if f["status"] == "PASS" else ("⚠️ WARN" if f["status"] == "WARN" else "❌ FAIL")
            dur = f.get("duration", 0.0)
            dur_str = f"{dur:.1f}s" if dur >= 1.0 else f"{int(dur * 1000)}ms"
            lines.append(f"| {f['name']} | {f['domain']} | {status_icon} | {dur_str} | {f['notes']} |")

        lines.append("\n## 2. 发现的潜在排版截断、文本溢出与视觉体验风险 (Visual & Layout Risks)")
        if not self.visual_risks:
            lines.append("🎉 **未发现高风险排版截断或文本遮挡！所有界面元素均符合 0 遮挡防撞规范。**")
        else:
            lines.append("| 风险类别 | 元素/场景描述 | 风险等级 | 详细说明 | 截屏凭证 |")
            lines.append("| :--- | :--- | :--- | :--- | :--- |")
            for r in self.visual_risks:
                lines.append(f"| {r.category} | {r.element_description} | {r.risk_level} | {r.details} | {r.screenshot_ref or '--'} |")

        lines.append("\n## 3. 过程中出现的阻碍及 Agent 自愈轨迹 (Self-Healing Trail)")
        if not self.self_healing_events:
            lines.append("⚡ **全流程一次性顺畅命中，未发生界面卡顿阻碍或遮罩阻塞，自愈引擎 0 介入。**")
        else:
            lines.append("| 步骤 | 目标指令 | 重试轮次 | 阻碍原因 | 采取自愈动作 | 结果 | 耗时 |")
            lines.append("| :--- | :--- | :--- | :--- | :--- | :--- | :--- |")
            for h in self.self_healing_events:
                res_icon = "✅ 愈合成功" if h.resolved else "❌ 仍未响应"
                lines.append(f"| {h.step_name} | {h.instruction} | 第 {h.attempt} 次 | {h.reason} | {h.action_taken} | {res_icon} | {h.duration_seconds:.1f}s |")

        if hasattr(self, "ai_review") and self.ai_review:
            lines.append("\n## 4. Gemini 2.0 视觉质检员多模态分析报告")
            lines.append(self.ai_review)

        if self.screenshots:
            lines.append("\n## 5. 关键执行节点截屏清单 (Audit Snapshots)")
            for s in self.screenshots:
                rel_p = os.path.relpath(s["path"], self.output_dir).replace("\\", "/")
                lines.append(f"\n### 截屏节点: `{s['name']}` ({s['time']})")
                lines.append(f"![{s['name']}]({rel_p})")

        return "\n".join(lines)

    def generate_html(self) -> str:
        md = self.generate_markdown()
        cards_html = []
        for s in self.screenshots:
            rel_p = os.path.relpath(s["path"], self.output_dir).replace("\\", "/")
            cards_html.append(f"""
            <div class="shot-card">
              <div class="shot-title">{s['name']} <span class="shot-time">{s['time']}</span></div>
              <img src="{rel_p}" alt="{s['name']}" loading="lazy" />
            </div>
            """)

        ai_box_html = ""
        if hasattr(self, "ai_review") and self.ai_review:
            ai_box_html = f"""
            <div class="ai-box">
              <h3>🤖 Gemini 2.0 Flash 视觉模型审查意见</h3>
              <pre style="white-space:pre-wrap; font-family:inherit;">{self.ai_review}</pre>
            </div>
            """

        html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Gemini Exporter 纯视觉 AI 盲测与体验体检报告</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 30px; line-height: 1.6; max-width: 1200px; margin: 0 auto; }}
    h1, h2, h3 {{ color: #38bdf8; }}
    table {{ width: 100%; border-collapse: collapse; margin: 20px 0; background: #1e293b; border-radius: 8px; overflow: hidden; }}
    th, td {{ padding: 12px 16px; border-bottom: 1px solid #334155; text-align: left; font-size: 13px; }}
    th {{ background: #0f172a; color: #94a3b8; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }}
    .badge-pass {{ color: #34d399; font-weight: 600; }}
    .badge-fail {{ color: #f87171; font-weight: 600; }}
    .card {{ background: #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 24px; border: 1px solid #334155; }}
    .gallery-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; margin-top: 16px; }}
    .shot-card {{ background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; }}
    .shot-title {{ padding: 10px 14px; background: #0f172a; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; }}
    .shot-time {{ font-size: 11px; color: #64748b; }}
    .shot-card img {{ width: 100%; display: block; border-top: 1px solid #334155; }}
    .ai-box {{ background: #1e293b; border-left: 4px solid #38bdf8; padding: 16px; margin-top: 24px; border-radius: 0 8px 8px 0; }}
  </style>
</head>
<body>
  <h1>🎨 Gemini Exporter 纯视觉 AI 盲测与体验体检报告</h1>
  <div class="card">
    <p><strong>审计时间:</strong> {time.strftime('%Y-%m-%d %H:%M:%S')} | <strong>总耗时:</strong> {(time.time() - self.start_time):.1f}s</p>
    <p><strong>已体验特性:</strong> {len(self.features_explored)} 项 | <strong>自愈重试:</strong> {len(self.self_healing_events)} 次 | <strong>视觉风险:</strong> {len(self.visual_risks)} 项</p>
  </div>
  {ai_box_html}
  <pre style="background:#1e293b; padding:20px; border-radius:8px; white-space:pre-wrap;">{md}</pre>
  <h2>📸 关键视觉执行节点画廊</h2>
  <div class="gallery-grid">
    {''.join(cards_html)}
  </div>
</body>
</html>"""
        return html

    def save(self):
        os.makedirs(self.output_dir, exist_ok=True)
        md_path = os.path.join(self.output_dir, "visual_audit_scorecard.md")
        html_path = os.path.join(self.output_dir, "visual_audit_report.html")

        with open(md_path, "w", encoding="utf-8") as f:
            f.write(self.generate_markdown())

        with open(html_path, "w", encoding="utf-8") as f:
            f.write(self.generate_html())

        print(f"📊 [Scorecard] 报告已生成:\n   📄 {md_path}\n   🌐 {html_path}")
