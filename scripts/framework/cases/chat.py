import os
import time
import uuid
import random
import hashlib
import re
import zipfile
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.selectors import GeminiSelectors
from scripts.framework.assertions import CDPAssertions, assert_turn_content
from scripts.framework.cases.sync import prepare_activity_baseline, verify_activity_sync

try:
    from scripts.cdp_client import CDPConnection
except ImportError:
    from cdp_client import CDPConnection


def read_initial_export_markdown(download_path: str, chat_id: str) -> str:
    """Read one actual v2 browser delivery: bare Markdown or a media-containing ZIP."""
    conversation_id = chat_id.removeprefix('c_')
    expected_suffix = f"_{conversation_id[-6:]}.md"
    if download_path.lower().endswith('.zip'):
        with zipfile.ZipFile(download_path) as archive:
            matches = [name for name in archive.namelist()
                       if os.path.basename(name).endswith(expected_suffix)]
            if len(matches) != 1:
                raise ValueError("初始导出 ZIP 不含唯一目标会话")
            content = archive.read(matches[0]).decode('utf-8')
    elif download_path.lower().endswith('.md'):
        if not os.path.basename(download_path).endswith(expected_suffix):
            raise ValueError("初始 Markdown 下载文件名与目标会话不匹配")
        with open(download_path, encoding='utf-8') as file:
            content = file.read()
    else:
        raise ValueError("初始导出不是 v2 Markdown 或 ZIP 文件")

    if not content.startswith('---\n'):
        raise ValueError("初始导出 Markdown 缺少 Frontmatter")
    metadata = content[4:].split('\n---\n', 1)[0]
    matched_id = re.search(r"""(?m)^id:\s*["']?([^"'\s]+)""", metadata)
    if not matched_id or matched_id.group(1).removeprefix('c_') != conversation_id:
        raise ValueError("初始导出 Markdown 会话 ID 不匹配")
    return content


def read_verified_export_baseline(cdp, download_path, chat_id, evidence):
    text = read_initial_export_markdown(download_path, chat_id)
    ok, message = assert_turn_content(text, evidence)
    if not ok:
        raise RuntimeError('初始导出内容基线错误: ' + message)
    recorded, message, _ = CDPAssertions.assert_badge_status(cdp, chat_id, 'exported')
    if not recorded:
        raise RuntimeError('初始导出未提交 ExportRecord: ' + message)
    return text


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
            # Extension reinstall reloads Gemini asynchronously. Observe the
            # product's injection result, including document_start replacement;
            # a fixed delay before this case does not establish readiness.
            deadline = time.monotonic() + 30
            while True:
                try:
                    if cdp.eval(f"""!!document.querySelector('{GeminiSelectors.INPAGE_EXPORT_BADGE}')"""):
                        return True, "页面端悬浮徽标正常渲染", None
                except RuntimeError:
                    # Navigation may replace the execution context mid-poll.
                    pass
                if time.monotonic() >= deadline:
                    return False, "等待 30 秒仍未检测到悬浮徽标 DOM 节点 (#geminiExportBadge)", None
                time.sleep(0.25)
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
            baseline = prepare_activity_baseline(ctx, cdp_gemini)
            # 模型前置门禁断言
            try:
                driver.ensure_model(target_model="3.8 Flash", target_thinking=True, force_menu_check=True)
            except RuntimeError as e:
                return False, f"模型检查不满足: {e}", None

            scenarios = ctx.ensure_scenarios()
            for chat_idx in range(min(2, len(scenarios))):
                sc = scenarios[chat_idx]
                sc_title = sc.get("title", f"会话 {chat_idx + 1}")
                turns = sc.get("turns", [])
                prompts_clean = [t.get("prompt", "") if isinstance(t, dict) else str(t) for t in turns]

                print(f"\n   💬 开始生成第 {chat_idx + 1} 个会话: '{sc_title}' ({len(turns)} 轮)...")
                session = driver.new_chat(timeout=20.0)
                record = {"chat_id": session.chat_id, "title": sc_title, "turns": prompts_clean, "turn_evidence": []}

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
                    ctx.record_turn(record, turn_res)

                    if turn_res.chat_id:
                        ctx.tracker.track(turn_res.chat_id)
                    time.sleep(ctx.delay)

                # Freeze final visible answers independently, before any export.
                # Retain per-stream captures to diagnose late rendering changes.
                ctx.freeze_turn_evidence(driver, record)
                real_title = session.get_title() or sc_title
                record['title'] = real_title
                ctx.chat_records.append(record)
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
                            if not CDPActions.select_workbench_item(cdp_opt_init, session.chat_id, True):
                                return False, "会话 1 初始导出目标未找到", None
                            baseline_file = CDPActions.trigger_export_zip(
                                cdp_opt_init, ctx.output_dir, max_wait=30,
                                format_type='markdown', allow_standalone=True)
                            if not baseline_file or not os.path.isfile(baseline_file):
                                return False, "会话 1 初始 Markdown/ZIP 导出未落盘，无法建立真实基线", None
                            baseline_text = read_verified_export_baseline(
                                cdp_opt_init, baseline_file, session.chat_id, record['turn_evidence'])
                            ctx.shared_data.setdefault('live_save_baselines', {})[session.chat_id] = baseline_text
                            print(f"      ✓ 会话 1 已成功完成初始真实导出并记录 baseline！")
                        finally:
                            cdp_opt_init.close()
                    except Exception as exp_err:
                        return False, f"会话 1 初始基准导出失败: {exp_err}", None

                if chat_idx == 0:
                    print("      🚀 开启实时落盘 (Live Save)，准备进入场景一：开着实时导出生成会话 2...")
                    try:
                        cdp_opt_live = ctx.connect_options()
                        try:
                            if not CDPActions.setup_live_save(cdp_opt_live, enabled=True):
                                return False, "实时落盘设置未就绪", None
                            print("      ✓ 实时落盘已就绪 (enabledDisk=True)")
                        finally:
                            cdp_opt_live.close()
                    except Exception as live_setup_err:
                        return False, f"实时落盘开启失败: {live_setup_err}", None

            verify_activity_sync(ctx, baseline, [r['chat_id'] for r in ctx.chat_records], 'new_chat_incremental_sync')
            return True, "2 次会话全部轮次正常生成落地", {"chat_records": ctx.chat_records}
        finally:
            cdp_gemini.close()
