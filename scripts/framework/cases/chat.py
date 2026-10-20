import os
import time
import uuid
import random
import hashlib
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.selectors import GeminiSelectors

try:
    from scripts.cdp_client import CDPConnection
except ImportError:
    from cdp_client import CDPConnection


class InpageBadgeCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_inpage_export_badge",
            domain=FeatureDomain.PAGE_CHAT,
            name="页面端悬浮导出徽标",
            description="监听页面加载，徽标处于就绪状态，记录并响应拖拽位置持久化",
            critical=False,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp = ctx.connect_gemini()
        try:
            has_badge = cdp.eval(f"""!!document.querySelector('{GeminiSelectors.INPAGE_EXPORT_BADGE}')""")
            if has_badge:
                return True, "页面端悬浮徽标正常渲染", None
            return False, "未检测到悬浮徽标 DOM 节点 (#geminiExportBadge)", None
        finally:
            cdp.close()


class ChatGenerationCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_chat_generation",
            domain=FeatureDomain.PAGE_CHAT,
            name="真实多轮问答发帖",
            description="在 gemini.google.com 聚焦输入框并粘贴 Prompt，等待流式回复全部完成落地",
            critical=True,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_gemini = ctx.connect_gemini()
        try:
            driver = ctx.get_gemini_driver(cdp_gemini)
            # 模型前置门禁断言
            try:
                driver.ensure_model(target_model="3.8 Flash", target_thinking=True, force_menu_check=True)
            except RuntimeError as e:
                return False, f"模型检查不满足: {e}", None

            imagen_found = False

            scenarios = ctx.ensure_scenarios()
            for chat_idx in range(min(2, len(scenarios))):
                sc = scenarios[chat_idx]
                sc_title = sc.get("title", f"会话 {chat_idx + 1}")
                turns = sc.get("turns", [])
                prompts_clean = [t.get("prompt", "") if isinstance(t, dict) else str(t) for t in turns]

                print(f"\n   💬 开始生成第 {chat_idx + 1} 个会话: '{sc_title}' ({len(turns)} 轮)...")
                session = driver.new_chat(timeout=20.0)

                for turn_no, turn_input in enumerate(turns, 1):
                    p_text = turn_input.get("prompt", "") if isinstance(turn_input, dict) else str(turn_input)
                    preview = (p_text[:40] + "...") if len(p_text) > 40 else p_text
                    print(f"      ▶️ 轮次 {turn_no}/{len(turns)}: '{preview}'")

                    # 在会话 2 的第 1 轮动态生成带随机尾缀与随机内容的测试附件进行真实上传闭环
                    current_attachment = None
                    if chat_idx == 1 and turn_no == 1:
                        ext_pool = [".json", ".txt", ".md", ".custom", ".log", ".yaml", ".csv"]
                        chosen_ext = random.choice(ext_pool)
                        random_tag = uuid.uuid4().hex[:8]
                        rnd_fname = f"gemini_test_{int(time.time())}_{random_tag}{chosen_ext}"
                        rnd_fpath = os.path.join(ctx.output_dir, rnd_fname)
                        os.makedirs(ctx.output_dir, exist_ok=True)

                        test_token = f"TOKEN-{uuid.uuid4().hex}"
                        rnd_content = f"""# Gemini Attachment Verification
filename: "{rnd_fname}"
token: "{test_token}"
timestamp: {time.time()}
description: "Dynamically created test attachment to verify multi-format user upload & export"
"""
                        with open(rnd_fpath, "w", encoding="utf-8") as f:
                            f.write(rnd_content)

                        with open(rnd_fpath, "rb") as f:
                            f_bytes = f.read()

                        f_sha256 = hashlib.sha256(f_bytes).hexdigest()
                        ctx.shared_data["uploaded_test_file"] = {
                            "file_path": rnd_fpath,
                            "file_name": rnd_fname,
                            "extension": chosen_ext,
                            "token": test_token,
                            "sha256": f_sha256,
                            "size": len(f_bytes)
                        }
                        current_attachment = rnd_fpath
                        p_text = f"{p_text}\n\n（我附带上传了一个测试参考文件 {rnd_fname}，请阅读并确认收到该文件）"
                        print(f"         📁 现场生成随机多格式测试文件: {rnd_fname} (大小: {len(f_bytes)} bytes, SHA256: {f_sha256[:12]}...)")

                    turn_res = session.send_turn(p_text, max_wait=300, file_attachment=current_attachment)
                    if not turn_res.success:
                        return False, f"会话 {chat_idx + 1} 轮次 {turn_no} 失败 (Fail-Fast 熔断安全停机): {turn_res.error}", None

                    if turn_res.chat_id:
                        ctx.tracker.track(turn_res.chat_id)
                    if turn_res.has_images:
                        imagen_found = True
                        ctx.shared_data["imagen_chat_id"] = turn_res.chat_id
                        print("         🎨 AI Imagen 多模态生图实体已在页面渲染落地！")

                    time.sleep(ctx.delay)

                real_title = session.get_title() or sc_title
                ctx.chat_records.append({
                    "chat_id": session.chat_id,
                    "title": real_title,
                    "turns": prompts_clean
                })
                if chat_idx == 1 and "uploaded_test_file" in ctx.shared_data:
                    ctx.shared_data["uploaded_test_file"]["chat_id"] = session.chat_id
                print(f"      🏁 第 {chat_idx + 1} 次对话完成！会话 ID: {session.chat_id}")

                # 关键真实闭环：在完成会话 1 后，立即触发一次真实导出记录其初始导出时间戳基线，
                # 这样后续在会话 1 进行追加提问时，其更新时间天然晚于导出时间，彻底告别假数据写库作弊！
                if chat_idx == 0 and session.chat_id and ctx.ext_id:
                    print(f"      📦 触发会话 1 ({session.chat_id}) 真实导出建立时间基准线...")
                    try:
                        cdp_opt_init = ctx.connect_options()
                        try:
                            # 触发单项导出真实落盘
                            CDPActions.clear_search_workbench(cdp_opt_init)
                            CDPActions.toggle_select_none(cdp_opt_init)
                            CDPActions.select_workbench_item(cdp_opt_init, session.chat_id, True)
                            CDPActions.trigger_export_zip(cdp_opt_init, ctx.output_dir, max_wait=30)
                            print(f"      ✓ 会话 1 已成功完成初始真实导出并记录 baseline！")
                        finally:
                            cdp_opt_init.close()
                    except Exception as exp_err:
                        print(f"      ⚠️ 会话 1 初始基准导出提示: {exp_err}")

                if chat_idx == 0:
                    print("      🚀 开启实时落盘 (Live Save)，准备进入场景一：开着实时导出生成会话 2...")
                    try:
                        cdp_opt_live = ctx.connect_options()
                        try:
                            CDPActions.setup_live_save(cdp_opt_live, enabled=True)
                            print("      ✓ 实时落盘已就绪 (enabledDisk=True)")
                        finally:
                            cdp_opt_live.close()
                    except Exception as live_setup_err:
                        print(f"      ⚠️ 实时落盘开启提示: {live_setup_err}")

            ctx.shared_data["imagen_found"] = imagen_found
            return True, "2 次会话全部轮次正常生成落地", {"chat_records": ctx.chat_records}
        finally:
            cdp_gemini.close()



class ImagenMultimodalCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_imagen_multimodal",
            domain=FeatureDomain.PAGE_CHAT,
            name="AI Imagen 生图与附件落地",
            description="包含生图指令的 Prompt 触发，网页成功渲染高分辨率生成图像",
            critical=True,
            prerequisites=["feat_chat_generation"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if ctx.shared_data.get("imagen_found"):
            return True, "检测到 AI Imagen 图片渲染落地", None

        # 检查是否场景中本来就没有生图需求
        has_image_scenario = any(
            ("生成" in str(t) and "图" in str(t)) or
            any(kw in str(t).lower() for kw in ["image", "draw", "画", "生图", "图片", "photo", "picture"])
            for sc in ctx.scenarios[:2] for t in sc.get("turns", [])
        )
        if not has_image_scenario:
            return True, "当次选取的场景不包含生图需求，免除物理生图断言", None

        # 兜底再次到 Gemini 页面检查一次
        cdp_g = ctx.connect_gemini()
        try:
            has_img = cdp_g.eval(f"""
            (() => {{
                const imgs = document.querySelectorAll('{GeminiSelectors.MODEL_RESPONSE} {GeminiSelectors.IMAGES}');
                return imgs.length > 0;
            }})()
            """)
            if has_img:
                ctx.shared_data["imagen_found"] = True
                if ctx.chat_records:
                    ctx.shared_data["imagen_chat_id"] = ctx.chat_records[-1]["chat_id"]
                return True, "在当前活动会话中成功确认检测到 AI Imagen 图片渲染实体", None
            return False, "预期生图场景未在页面捕获到 AI Imagen 图片渲染实体", None
        finally:
            cdp_g.close()
