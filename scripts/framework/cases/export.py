# scripts/framework/cases/export.py
import os
import json
import time
import zipfile
import re
import subprocess
from typing import Tuple, Optional, Dict, Any

from scripts.framework.archive_resources import validate_archive_resources
from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.assertions import CDPAssertions
from scripts.framework.selectors import WorkbenchSelectors

DESIGNATED_HISTORICAL_CHATS = [
    {
        "id": "1bd028d5c5b0c0e2",
        "category": "AI 生成图片 (Imagen)",
        "name": "火星宇航员猫咪（AI 生成图片 Imagen）",
        "expected_snippets": ["astronaut cat"],
        "expected_generated_images": 1,
        "syntax_checks": ["image"]
    },
    {
        "id": "1cea7e48cc166b57",
        "category": "高质量技术代码块 (Python)",
        "name": "Python日志与耗时装饰器设计（高质量技术代码块）",
        "expected_snippets": ["Python", "def ", "functools"],
        "syntax_checks": ["codeblock"]
    },
    {
        "id": "7b29852ecae8344a",
        "category": "Markdown 对比表格与量子理论",
        "name": "贝尔不等式推导与物理意义（复杂表格与量子理论）",
        "expected_snippets": ["贝尔不等式"],
        "syntax_checks": ["table"]
    },
    {
        "id": "f8ba969fe8c7d880",
        "category": "长文本深度推演 (深空探测)",
        "name": "韦伯望远镜深空探测重大发现（长文本科学报告）",
        "expected_snippets": ["韦伯", "深空探测"],
        "syntax_checks": []
    },
    {
        "id": "533ac8ca2ecb8bd7",
        "category": "用户文件附件 (JSON/Docs)",
        "name": "测试配置文件加载（用户文件附件 JSON）",
        "expected_snippets": ["test_config.json"],
        "expected_file_attachments": ["test_config.json"],
        "syntax_checks": [],
        "optional": True
    }
]


class LiveSaveNewChatCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_live_save_new_chat",
            domain=FeatureDomain.PAGE_CHAT,
            name="新会话实时落盘与状态验证",
            description="开着实时落盘生成新会话（场景一），验证本地磁盘自动落盘非空且工作台直接呈现「已导出」状态",
            critical=True,
            prerequisites=["feat_chat_generation"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if len(ctx.chat_records) < 2:
            return False, "会话记录不足 2 个，无法验证新会话实时落盘", None

        s2_id = ctx.chat_records[1].get("chat_id")
        if not s2_id:
            return False, "会话 2 ID 无效", None

        print(f"\n   💾 正在验证场景一：新会话 2 ({s2_id}) 实时落盘与状态标签闭环...")
        cdp_opt = ctx.connect_options()
        try:
            # 1. 刷新 OPFS 目录并物理落盘到 output_dir
            flush_res = CDPActions.flush_live_save_to_disk(cdp_opt, ctx.output_dir)
            print(f"      📁 实时落盘文件已同步到磁盘 (文件总数: {flush_res.get('count', 0)})")

            # 2. 真实物理磁盘断言：必须存在对应的 .md 文件、大小 > 0、mtime >= ctx.start_time
            disk_ok, disk_msg, disk_data = CDPAssertions.assert_real_disk_live_save(
                target_dir=ctx.output_dir,
                target_chat_ids=[s2_id],
                min_mtime=ctx.start_time
            )
            if not disk_ok:
                return False, f"场景一物理磁盘落盘断言失败: {disk_msg}", disk_data

            # 3. Options 工作台状态标签断言：会话 2 刚生成且已落盘，直接呈现「已导出」(.badge-exported) 且未被勾选
            CDPActions.clear_search_workbench(cdp_opt)
            time.sleep(0.5)
            badge_ok, badge_msg, badge_data = CDPAssertions.assert_badge_status(cdp_opt, s2_id, "exported")
            if not badge_ok:
                return False, f"场景一状态标签断言失败: {badge_msg}", {"disk": disk_data, "badge": badge_data}

            return True, f"场景一（新会话实时落盘）断言通过: {disk_msg}; {badge_msg}", {"disk": disk_data, "badge": badge_data}
        finally:
            cdp_opt.close()


class LiveDiskAutoSaveCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_live_auto_save_disk_write",
            domain=FeatureDomain.LIFECYCLE,
            name="老会话开启实时导出与增量更新落盘",
            description="已更新的老会话开启实时落盘并继续更新（场景二），验证物理写盘与「已导出」状态跃迁",
            critical=True,
            prerequisites=["feat_updated_badge_display"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if len(ctx.chat_records) < 1:
            return False, "会话记录为空，无法验证老会话继续更新落盘", None

        s1_id = ctx.chat_records[0].get("chat_id")
        if not s1_id:
            return False, "会话 1 ID 无效", None

        print(f"\n   🔄 正在执行场景二：老会话 1 ({s1_id}) 开启实时落盘并继续更新...")
        # 1. 在 Options 工作台重新开启实时导出
        cdp_opt = ctx.connect_options()
        try:
            setup_ok = CDPActions.setup_live_save(cdp_opt, enabled=True)
            if not setup_ok:
                return False, "开启实时导出设置失败", None
            print("      ✓ 实时落盘已重新开启 (enabledDisk=True)")
        finally:
            cdp_opt.close()

        # 2. 回访会话 1 发送继续追加提问 B
        cdp_gem = ctx.connect_gemini()
        try:
            driver = ctx.get_gemini_driver(cdp_gem)
            session = driver.open_chat(s1_id, timeout=20.0)

            follow_up_prompt = "请根据前面讨论的所有方案与避坑建议，提炼一条最核心的架构决策准则，一句话极简总结。"
            print(f"      ▶️ 场景二：会话 1 继续追加提问: '{follow_up_prompt[:36]}...'")
            turn_res = session.send_turn(follow_up_prompt, max_wait=120)
            if not turn_res.success:
                return False, f"老会话继续追加提问失败: {turn_res.error}", None
            ctx.chat_records[0]["turns"].append(follow_up_prompt)
            print("      ✓ 继续追加提问流式回复已落地，等待实时保存落盘...")
            time.sleep(3.0)
        finally:
            cdp_gem.close()

        # 3. 回到 Options 页面，将 OPFS 实时落盘实体回写物理磁盘
        cdp_opt = ctx.connect_options()
        try:
            flush_res = CDPActions.flush_live_save_to_disk(cdp_opt, ctx.output_dir)
            print(f"      📁 实时落盘文件已同步到磁盘 (文件总数: {flush_res.get('count', 0)})")

            # 4. 物理磁盘断言：会话 1 的 .md 必须物理存在、字节非空、mtime 更新
            disk_ok, disk_msg, disk_data = CDPAssertions.assert_real_disk_live_save(
                target_dir=ctx.output_dir,
                target_chat_ids=[s1_id],
                min_mtime=ctx.start_time
            )
            if not disk_ok:
                return False, f"场景二物理磁盘落盘断言失败: {disk_msg}", disk_data

            # 5. Options 工作台状态标签断言：会话 1 状态必须由之前的「已更新」跃迁回「已导出」(.badge-exported) 且取消自动勾选
            CDPActions.clear_search_workbench(cdp_opt)
            time.sleep(0.5)
            badge_ok, badge_msg, badge_data = CDPAssertions.assert_badge_status(cdp_opt, s1_id, "exported")
            if not badge_ok:
                return False, f"场景二状态标签回写断言失败: {badge_msg}", {"disk": disk_data, "badge": badge_data}

            return True, f"场景二（老会话开启实时导出增量更新落盘）双重断言通过: {disk_msg}; {badge_msg}", {"disk": disk_data, "badge": badge_data}
        finally:
            cdp_opt.close()


class ZipExportDownloadCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_zip_export_download",
            domain=FeatureDomain.EXPORT_DISK,
            name="手动勾选 ZIP 导出与落盘",
            description="点击【导出选中 -> ZIP】主按钮，进度条视觉反馈，下载落盘并校验文件非空",
            critical=True,
            prerequisites=[
                "feat_search_clear_restore",
                "feat_authoritative_title_upgrade"
            ]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            # 确保搜索框已彻底清空并恢复全量工作台项目
            CDPActions.clear_search_workbench(cdp_opt)
            cdp_opt.eval("""
            (() => {
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ gemini_suppress_direct_write_prompt: true });
                }
            })()
            """)
            time.sleep(0.5)

            target_ids = []
            target_ids.extend([r["chat_id"] for r in ctx.chat_records if r.get("chat_id") and len(str(r["chat_id"])) > 8])
            target_ids.extend([h["id"] for h in DESIGNATED_HISTORICAL_CHATS])

            target_titles = ["Martian Astronaut Cat", "Python日志与耗时装饰器", "贝尔不等式推导与物理意义", "韦伯望远镜深空探测重大发现", "Test Configuration Status Load"]

            check_res = cdp_opt.eval(f"""
            (() => {{
                const searchInput = document.getElementById('chatSearchInput') || document.getElementById('search');
                if (searchInput && searchInput.value) {{
                    searchInput.value = '';
                    searchInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                }}
                const selectNone = document.getElementById('btnSelectNone');
                if (selectNone) selectNone.click();
                const targetIds = {json.dumps(target_ids)};
                const targetTitles = {json.dumps(target_titles)};
                const items = Array.from(document.querySelectorAll('#list .item'));
                let checkedCount = 0;
                const matchedList = [];
                items.forEach(item => {{
                    const cid = item.dataset.chatId;
                    const titleText = item.querySelector('.chat-title, .title')?.textContent || '';
                    const matchId = targetIds.some(tid => cid && (cid === tid || cid.includes(tid) || tid.includes(cid)));
                    const matchTitle = targetTitles.some(tt => tt && tt.length > 2 && (titleText.includes(tt) || tt.includes(titleText)));
                    if (matchId || matchTitle) {{
                        const cb = item.querySelector('input[type=checkbox]');
                        if (cb && !cb.checked) {{
                            cb.checked = true;
                            cb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                            checkedCount++;
                            matchedList.push({{ id: cid, title: titleText }});
                        }}
                    }}
                }});
                return {{
                    totalItems: items.length,
                    checkedCount: checkedCount,
                    matched: matchedList
                }};
            }})()
            """) or {}
            time.sleep(0.5)

            checked_count = check_res.get("checkedCount", 0)
            expected_min_checked = 6 if ctx.chat_records else 4
            if checked_count < expected_min_checked:
                return False, f"工作台勾选数不足: 实际 {checked_count} < 预期 {expected_min_checked}", check_res

            downloaded_zip = CDPActions.trigger_export_zip(cdp_opt, ctx.output_dir, max_wait=60)
            if downloaded_zip and os.path.isfile(downloaded_zip) and os.path.getsize(downloaded_zip) > 0:
                ctx.shared_data["downloaded_zip"] = downloaded_zip
                size = os.path.getsize(downloaded_zip)
                return True, f"ZIP 导出成功落盘: {os.path.basename(downloaded_zip)} ({size} bytes)", {"zip_path": downloaded_zip, "size": size}
            return False, "未能成功下载或落盘 ZIP 文件", None
        finally:
            cdp_opt.close()


class MultimodalSpecCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_multimodal_spec_assertion",
            domain=FeatureDomain.EXPORT_DISK,
            name="4 大黄金分类规范断言",
            description="解压导出的 ZIP，严格断言 Frontmatter 7 键、附件非空、AI Imagen 模型归属",
            critical=True,
            prerequisites=["feat_zip_export_download"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        downloaded_zip = ctx.shared_data.get("downloaded_zip")
        if not downloaded_zip or not os.path.isfile(downloaded_zip):
            return False, "未找到有效的 ZIP 文件用于多模态规范断言", None

        extract_dir = os.path.join(ctx.output_dir, "extracted_verify_" + str(int(time.time())))
        golden_chats = [dict(c) for c in DESIGNATED_HISTORICAL_CHATS]
        expected_scenarios = ctx.scenarios[:2] if ctx.chat_records else []
        min_conversations = 6 if ctx.chat_records else 4
        uploaded_files = [ctx.shared_data["uploaded_test_file"]] if "uploaded_test_file" in ctx.shared_data else None

        spec_ok, spec_msg, spec_data = CDPAssertions.assert_exported_zip_spec(
            zip_path=downloaded_zip,
            extract_dir=extract_dir,
            min_conversations=min_conversations,
            expected_golden_chats=golden_chats,
            expected_scenarios=expected_scenarios,
            uploaded_files=uploaded_files
        )

        if spec_ok:
            return True, spec_msg, spec_data
        return False, spec_msg, spec_data


class StaleTabImageExportCase(FeatureTestCase):
    """Exercise the real image export route with an active, receiver-less Gemini tab."""

    def __init__(self):
        super().__init__(
            feature_id="feat_stale_tab_image_export",
            domain=FeatureDomain.EXPORT_DISK,
            name="失效 Gemini 标签页下的图片导出",
            description="扩展重装后保留未刷新的同账号标签页，验证图片导出可转用已注入的标签页",
            critical=True,
            prerequisites=["feat_pdf_export_download"],
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        image_chat_id = ctx.shared_data.get("imagen_chat_id")
        if not image_chat_id:
            return False, "缺少本轮已验证的 Imagen 会话", None
        image_record = next((r for r in ctx.chat_records if r["chat_id"] == image_chat_id), None)
        if not image_record:
            return False, "Imagen 会话未记录在本轮测试结果中", None
        image_chat = {
            "id": image_chat_id,
            "name": image_record["title"],
            "expected_generated_images": 1,
            "syntax_checks": ["image"],
        }
        cdp_opt = ctx.connect_options()
        stale_id = None
        try:
            stale_id = cdp_opt.eval("""(async () => {
                const tab = await chrome.tabs.create({url: 'https://gemini.google.com/app', active: true});
                for (let i = 0; i < 40; i++) {
                    const current = await chrome.tabs.get(tab.id);
                    if (current.status === 'complete') return tab.id;
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                throw new Error('stale Gemini tab did not load');
            })()""", await_promise=True, timeout=20)
        finally:
            cdp_opt.close()
        if not stale_id:
            return False, "无法创建待验证的旧 Gemini 标签页", None

        try:
            new_id = ctx.env.reinstall_extension()
            if not new_id:
                return False, "无法重装扩展以构造无接收端的旧标签页", None
            ctx.ext_id = new_id
            ctx.env.ensure_options_tab()
            ctx.env.setup_download_behavior(ctx.output_dir)
            cdp_opt = ctx.connect_options()
            try:
                setup = cdp_opt.eval(f"""(async () => {{
                    const staleId = {stale_id};
                    const tabs = await chrome.tabs.query({{url: 'https://gemini.google.com/*'}});
                    const fresh = tabs.filter(tab => tab.id !== staleId && !tab.url?.includes('/glic'));
                    if (!fresh.length) return {{error: 'no second Gemini tab'}};
                    for (const tab of fresh) await chrome.tabs.reload(tab.id);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    const probe = id => new Promise(resolve => chrome.tabs.sendMessage(id, {{action: 'ping'}}, reply =>
                        resolve({{reply, error: chrome.runtime.lastError?.message || ''}})));
                    const stale = await probe(staleId);
                    const good = await probe(fresh[0].id);
                    await chrome.tabs.update(staleId, {{active: true}});
                    return {{stale, good, staleId, freshId: fresh[0].id}};
                }})()""", await_promise=True, timeout=30) or {}
                if "Receiving end does not exist" not in setup.get("stale", {}).get("error", ""):
                    return False, f"旧标签页未保持无接收端状态: {setup}", setup
                if not setup.get("good", {}).get("reply", {}).get("ok"):
                    return False, f"已刷新标签页尚未注入内容脚本: {setup}", setup

                # A clean install can show onboarding; dismiss it before choosing one known Imagen chat.
                selected = cdp_opt.eval(f"""(() => {{
                    document.getElementById('tourSkipBtn')?.click();
                    document.getElementById('btnSelectNone')?.click();
                    const item = Array.from(document.querySelectorAll('#list .item'))
                        .find(el => el.dataset.chatId === '{image_chat['id']}');
                    const cb = item?.querySelector('input[type=checkbox]');
                    if (!cb) return false;
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', {{bubbles: true}}));
                    return true;
                }})()""")
                if not selected:
                    return False, "旧标签页测试未找到指定 Imagen 会话", setup

                archive = CDPActions.trigger_export_zip(cdp_opt, ctx.output_dir, max_wait=90,
                                                       skip_exported=False, format_type="markdown")
                if not archive:
                    return False, "旧标签页在前时图片 ZIP 未能落盘", setup
                ok, message, details = CDPAssertions.assert_exported_zip_spec(
                    zip_path=archive,
                    extract_dir=os.path.join(ctx.output_dir, "extracted_stale_tab_image"),
                    min_conversations=1,
                    expected_golden_chats=[image_chat],
                    chat_id=image_chat["id"],
                )
                if not ok:
                    return False, message, {"tabs": setup, "export": details}
                with zipfile.ZipFile(archive) as zf:
                    entries = zf.namelist()
                if any(os.path.basename(name) == "_export_errors.json" for name in entries):
                    return False, "图片导出含错误清单", {"tabs": setup, "entries": entries}
                return True, "无接收端旧标签页优先时，图片及 Markdown 引用均成功落盘", {"tabs": setup, "export": details}
            finally:
                cdp_opt.close()
        finally:
            try:
                cdp_opt = ctx.connect_options()
                cdp_opt.eval(f"chrome.tabs.remove({stale_id})")
                cdp_opt.close()
            except Exception:
                pass


class FastSkipExportedCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_fast_skip_exported",
            domain=FeatureDomain.EXPORT_DISK,
            name="跳过已导出会话前置极速过滤",
            description="勾选【跳过已导出】时，已导出会话前置分流瞬间跳过（防空 ZIP 保护），含新会话时精准分流导出",
            critical=True,
            prerequisites=["feat_multimodal_spec_assertion"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            # 确保清空搜索框
            CDPActions.clear_search_workbench(cdp_opt)
            time.sleep(0.5)

            # 步骤 1：全量跳过与防空 ZIP 保护断言 (All-Skip Fast Path)
            target_ids = []
            target_ids.extend([r["chat_id"] for r in ctx.chat_records if r.get("chat_id") and len(str(r["chat_id"])) > 8])
            target_ids.extend([h["id"] for h in DESIGNATED_HISTORICAL_CHATS])
            target_titles = ["Martian Astronaut Cat", "Python日志与耗时装饰器", "贝尔不等式推导与物理意义", "韦伯望远镜深空探测重大发现", "Test Configuration Status Load"]

            select_res = cdp_opt.eval(f"""
            (() => {{
                const searchInput = document.getElementById('chatSearchInput') || document.getElementById('search');
                if (searchInput && searchInput.value) {{
                    searchInput.value = '';
                    searchInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    searchInput.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
                if (searchInput) searchInput.blur();

                const selectNone = document.getElementById('btnSelectNone');
                if (selectNone) selectNone.click();
                document.querySelectorAll('#list input[type=checkbox]').forEach(cb => {{
                    if (cb.checked) {{
                        cb.checked = false;
                        cb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }}
                }});

                const targetIds = {json.dumps(target_ids)};
                const targetTitles = {json.dumps(target_titles)};
                const items = Array.from(document.querySelectorAll('#list .item'));
                let checkedCount = 0;
                items.forEach(item => {{
                    const cid = item.dataset.chatId;
                    const titleText = item.querySelector('.chat-title, .title')?.textContent || '';
                    const hasBadge = Boolean(item.querySelector('.badge-exported'));
                    const matchId = targetIds.some(tid => cid && (cid === tid || cid.includes(tid) || tid.includes(cid)));
                    const matchTitle = targetTitles.some(tt => tt && tt.length > 2 && (titleText.includes(tt) || tt.includes(titleText)));
                    if (hasBadge || matchId || matchTitle) {{
                        const cb = item.querySelector('input[type=checkbox]');
                        if (cb) {{
                            cb.checked = true;
                            cb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                            checkedCount++;
                        }}
                    }}
                }});
                const skipCb = document.getElementById('skipExported');
                if (skipCb && !skipCb.checked) {{
                    skipCb.checked = true;
                    skipCb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
                const zipCb = document.getElementById('includeZip');
                if (zipCb && !zipCb.checked) {{
                    zipCb.checked = true;
                    zipCb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
                const actualChecked = document.querySelectorAll('#list input[type=checkbox]:checked').length;
                return {{ checkedCount, actualChecked }};
            }})()
            """) or {}

            actual_checked = select_res.get("actualChecked", 0)
            if actual_checked < 6:
                return False, f"未能在工作台中勾选足够的已导出会话: actualChecked={actual_checked} < 6", select_res

            # 触发导出前记录时间戳与当前输出目录文件列表
            start_t = time.time()
            existing_files = set(os.listdir(ctx.output_dir)) if os.path.isdir(ctx.output_dir) else set()

            # 点击导出
            cdp_opt.eval(f"document.querySelector('{WorkbenchSelectors.BTN_EXPORT}')?.click();")

            # 等待极速跳过完成（至多 6 秒，正常情况下在 0.5s 之内瞬间完成）
            completed = False
            skip_log_found = False
            finish_msg = ""
            for _ in range(12):
                time.sleep(0.5)
                status_info = cdp_opt.eval(f"""
                (() => {{
                    const progText = document.getElementById('progText')?.textContent || '';
                    const logEl = document.querySelector('{WorkbenchSelectors.LOG}') || document.getElementById('log');
                    const logText = logEl ? logEl.textContent : '';
                    const btn = document.querySelector('{WorkbenchSelectors.BTN_EXPORT}');
                    const isBusy = btn && btn.disabled;
                    const hasSkip = logText.includes('跳过') || logText.includes('skipped') || logText.includes('无需生成 ZIP') ||
                                    progText.includes('跳过') || progText.includes('skipped') || progText.includes('无需生成 ZIP');
                    return {{
                        progText,
                        logSnippet: logText.slice(-200),
                        hasSkipLog: Boolean(hasSkip),
                        isBusy: Boolean(isBusy)
                    }};
                }})()
                """) or {}
                if status_info.get("hasSkipLog"):
                    skip_log_found = True
                if not status_info.get("isBusy") and status_info.get("hasSkipLog"):
                    completed = True
                    finish_msg = status_info.get("progText", "") or status_info.get("logSnippet", "")
                    break

            all_skip_duration = time.time() - start_t
            if not completed or not skip_log_found:
                return False, f"全量已导出会话未在预期时间内瞬间跳过: duration={all_skip_duration:.2f}s, msg={finish_msg}", None

            # 检查输出目录，验证没有生成新的空 ZIP 文件 (防空 ZIP 保护)
            current_files = set(os.listdir(ctx.output_dir)) if os.path.isdir(ctx.output_dir) else set()
            new_zips = [f for f in (current_files - existing_files) if f.endswith(".zip")]
            if new_zips:
                return False, f"全量跳过时异常生成了无内容 ZIP 包: {new_zips}", None

            # 步骤 2：部分跳过与分流导出断言 (Partial Skip + Export)
            partial_prep = cdp_opt.eval("""
            (() => {
                const selectNone = document.getElementById('btnSelectNone');
                if (selectNone) selectNone.click();
                document.querySelectorAll('#list input[type=checkbox]').forEach(cb => {
                    if (cb.checked) {
                        cb.checked = false;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
                const items = Array.from(document.querySelectorAll('#list .item'));
                let unexportedItem = null;
                let exportedItem = null;
                for (const it of items) {
                    const hasExportedBadge = it.querySelector('.badge-exported');
                    if (hasExportedBadge && !exportedItem) {
                        exportedItem = it;
                    } else if (!hasExportedBadge && !unexportedItem) {
                        unexportedItem = it;
                    }
                    if (exportedItem && unexportedItem) break;
                }
                if (exportedItem) {
                    const cb = exportedItem.querySelector('input[type=checkbox]');
                    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
                }
                if (unexportedItem) {
                    const cb = unexportedItem.querySelector('input[type=checkbox]');
                    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
                }
                const skipCb = document.getElementById('skipExported');
                if (skipCb && !skipCb.checked) {
                    skipCb.checked = true;
                    skipCb.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return {
                    hasExported: Boolean(exportedItem),
                    hasUnexported: Boolean(unexportedItem),
                    exportedTitle: exportedItem?.querySelector('.chat-title')?.textContent || '',
                    unexportedTitle: unexportedItem?.querySelector('.chat-title')?.textContent || ''
                };
            })()
            """) or {}

            if partial_prep.get("hasExported") and partial_prep.get("hasUnexported"):
                partial_zip = CDPActions.trigger_export_zip(cdp_opt, ctx.output_dir, max_wait=30, skip_exported=True)
                if not partial_zip or not os.path.isfile(partial_zip):
                    return False, "部分跳过导出时未能成功生成未导出会话的 ZIP 包", partial_prep

            return True, f"已导出会话前置极速过滤与防空 ZIP 保护验证通过 (全量跳过耗时 {all_skip_duration:.2f}s，防空 ZIP 生效)", {
                "all_skip_duration": all_skip_duration,
                "finish_msg": finish_msg,
                "partial_prep": partial_prep
            }
        finally:
            cdp_opt.close()


class HtmlExportDownloadCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_html_export_download",
            domain=FeatureDomain.EXPORT_DISK,
            name="HTML 独立网页 ZIP 导出与落盘核验",
            description="切换导出格式为 HTML (.html)，下载 ZIP 并解压，严格断言独立网页结构、CSS 样式与附件落地",
            critical=True,
            prerequisites=[
                "feat_fast_skip_exported"
            ]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            # 确保清空搜索框
            CDPActions.clear_search_workbench(cdp_opt)
            time.sleep(0.3)

            target_ids = []
            target_ids.extend([r["chat_id"] for r in ctx.chat_records if r.get("chat_id") and len(str(r["chat_id"])) > 8])
            target_ids.extend([h["id"] for h in DESIGNATED_HISTORICAL_CHATS])
            target_titles = ["Martian Astronaut Cat", "Python日志与耗时装饰器", "贝尔不等式推导与物理意义", "韦伯望远镜深空探测重大发现", "Test Configuration Status Load"]

            # 勾选待导出会话，禁用 skipExported，并将 format 设为 html
            check_res = cdp_opt.eval(f"""
            (() => {{
                const searchInput = document.getElementById('chatSearchInput') || document.getElementById('search');
                if (searchInput && searchInput.value) {{
                    searchInput.value = '';
                    searchInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                }}
                const selectNone = document.getElementById('btnSelectNone');
                if (selectNone) selectNone.click();

                const skipCb = document.getElementById('skipExported');
                if (skipCb && skipCb.checked) {{
                    skipCb.checked = false;
                    skipCb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                const sel = document.getElementById('format');
                if (sel && sel.value !== 'html') {{
                    sel.value = 'html';
                    sel.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                const targetIds = {json.dumps(target_ids)};
                const targetTitles = {json.dumps(target_titles)};
                const items = Array.from(document.querySelectorAll('#list .item'));
                let checkedCount = 0;
                const matchedList = [];
                items.forEach(item => {{
                    const cid = item.dataset.chatId;
                    const titleText = item.querySelector('.chat-title, .title')?.textContent || '';
                    const matchId = targetIds.some(tid => cid && (cid === tid || cid.includes(tid) || tid.includes(cid)));
                    const matchTitle = targetTitles.some(tt => tt && tt.length > 2 && (titleText.includes(tt) || tt.includes(titleText)));
                    if (matchId || matchTitle) {{
                        const cb = item.querySelector('input[type=checkbox]');
                        if (cb && !cb.checked) {{
                            cb.checked = true;
                            cb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                            checkedCount++;
                            matchedList.push({{ id: cid, title: titleText }});
                        }}
                    }}
                }});
                return {{
                    totalItems: items.length,
                    checkedCount: checkedCount,
                    matched: matchedList
                }};
            }})()
            """) or {}
            time.sleep(0.5)

            checked_count = check_res.get("checkedCount", 0)
            if checked_count < 2:
                # 兜底：若特定会话未匹配够，勾选当前列表前 4 项
                cdp_opt.eval("""
                (() => {
                    const items = Array.from(document.querySelectorAll('#list .item'));
                    items.slice(0, 4).forEach(it => {
                        const cb = it.querySelector('input[type=checkbox]');
                        if (cb && !cb.checked) {
                            cb.checked = true;
                            cb.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    });
                })()
                """)
                time.sleep(0.3)

            downloaded_zip = CDPActions.trigger_export_zip(
                cdp_opt,
                ctx.output_dir,
                max_wait=60,
                skip_exported=False,
                format_type="html"
            )
            if not downloaded_zip or not os.path.isfile(downloaded_zip) or os.path.getsize(downloaded_zip) == 0:
                return False, "未能成功下载或落盘 HTML 导出的 ZIP 文件", None

            zip_size = os.path.getsize(downloaded_zip)
            import shutil
            extract_dir = os.path.join(ctx.output_dir, "extracted_html")
            if os.path.isdir(extract_dir):
                shutil.rmtree(extract_dir)
            os.makedirs(extract_dir, exist_ok=True)
            with zipfile.ZipFile(downloaded_zip, "r") as zf:
                zf.extractall(extract_dir)
                namelist = zf.namelist()

            html_files = [n for n in namelist if n.endswith(".html") and not os.path.basename(n).startswith(".")]
            if len(html_files) == 0:
                return False, f"导出的 ZIP 中未包含任何 .html 文件 (文件清单: {namelist[:5]})", None

            # 校验每一个 HTML 文件的规范结构
            zero_byte_count = 0
            for hf in html_files:
                fpath = os.path.join(extract_dir, hf)
                if not os.path.isfile(fpath) or os.path.getsize(fpath) == 0:
                    zero_byte_count += 1
                    continue
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                # 校验合法 HTML 网页骨架
                if "<!DOCTYPE html>" not in content and "<!doctype html>" not in content.lower():
                    return False, f"HTML 导出文件缺少 DOCTYPE 声明: {hf}", None
                if "<html" not in content or "</html>" not in content:
                    return False, f"HTML 导出文件缺少 html 根标签闭合: {hf}", None
                if "<body" not in content or "</body>" not in content:
                    return False, f"HTML 导出文件缺少 body 标签: {hf}", None
                if 'generator" content="Gemini Exporter"' not in content:
                    return False, f"HTML 导出文件缺少 Gemini Exporter 生成元数据: {hf}", None

                # 校验包含真实会话消息节点（防止空文档假通过）
                has_turns = 'class="gem-turn' in content or '<div class="bubble' in content or 'gem-user-bubble' in content
                if not has_turns:
                    return False, f"HTML 导出文件缺少对话轮次节点 (未渲染真实对话消息): {hf}", None

                # 校验属性合法性：严禁属性值内嵌非法 HTML 标签（如 Markdown 错误转义导致的 target="<em>blank" 或 src="assets/...</em>..."）
                corrupt_attrs = re.findall(r'(?:src|href|target|class)=\"[^\"]*<[a-z]+>[^\"]*\"', content, re.IGNORECASE)
                if corrupt_attrs:
                    return False, f"HTML 导出文件 [{hf}] 存在属性被内联标签破坏缺陷: {corrupt_attrs[:3]}", None

                resource_errors = validate_archive_resources(extract_dir, hf, content, html=True)
                if resource_errors:
                    return False, f"HTML 导出文件 [{hf}] 归档资源引用无效: {resource_errors[:3]}", None

                # 校验 LaTeX 公式完整性：严禁 LaTeX 宏或下标被错误切碎插入 <em> 标签（如 \hat{H}<em>{JC}、\omega<em>a 等）
                corrupted_math = re.findall(r'\\[a-zA-Z]+<em>[^<]+</em>', content)
                if corrupted_math:
                    return False, f"HTML 导出文件 [{hf}] LaTeX 公式中下划线被错误解析为斜体标签: {corrupted_math[:3]}", None

            if zero_byte_count > 0:
                return False, f"发现 {zero_byte_count} 个 0 字节的 HTML 文件", None

            return True, f"HTML 独立网页导出成功落盘并解压验证通过 (HTML文件数: {len(html_files)}, ZIP大小: {zip_size} bytes, 规范结构 100%)", {
                "zip_path": downloaded_zip,
                "html_count": len(html_files),
                "zip_size": zip_size
            }
        finally:
            # 恢复工作台默认格式为 markdown
            try:
                cdp_opt.eval("""
                (() => {
                    const sel = document.getElementById('format');
                    if (sel && sel.value !== 'markdown') {
                        sel.value = 'markdown';
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                })()
                """)
            except Exception:
                pass
            cdp_opt.close()


class PdfExportDownloadCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_pdf_export_download",
            domain=FeatureDomain.EXPORT_DISK,
            name="PDF 真实编译 ZIP 导出与落盘核验",
            description="切换导出格式为 PDF (.pdf)，通过沙箱 Typst WASM 真实编译导出 ZIP，解压严格断言 %PDF- 二进制规范与非空",
            critical=True,
            prerequisites=[
                "feat_html_export_download"
            ]
        )

    @staticmethod
    def _extract_pdf_info(pdf_path: str) -> Dict[str, Any]:
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        ts_register = os.path.join(repo_root, "tests", "ts_register.js")
        extractor = os.path.join(repo_root, "tests", "helpers", "pdfTextExtract.ts")
        cmd = [
            "node",
            "-r", ts_register,
            "-e",
            """
            const { extractPdfText } = require(process.argv[1]);
            const fs = require('fs');
            const buf = fs.readFileSync(process.argv[2]);
            const res = extractPdfText(buf);
            console.log(JSON.stringify({
                pageCount: res.pageCount,
                textLength: res.text.length,
                text: res.text
            }));
            """,
            extractor,
            pdf_path
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if proc.returncode != 0:
                return {"pageCount": 0, "textLength": 0, "text": "", "error": proc.stderr}
            return json.loads(proc.stdout)
        except Exception as e:
            return {"pageCount": 0, "textLength": 0, "text": "", "error": str(e)}

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            # 确保清空搜索框
            CDPActions.clear_search_workbench(cdp_opt)
            time.sleep(0.3)

            target_ids = []
            target_ids.extend([r["chat_id"] for r in ctx.chat_records if r.get("chat_id") and len(str(r["chat_id"])) > 8])
            target_ids.extend([h["id"] for h in DESIGNATED_HISTORICAL_CHATS])
            target_titles = ["Martian Astronaut Cat", "Python日志与耗时装饰器", "贝尔不等式推导与物理意义", "韦伯望远镜深空探测重大发现", "Test Configuration Status Load"]

            # 勾选待导出会话，禁用 skipExported，并将 format 设为 pdf
            check_res = cdp_opt.eval(f"""
            (() => {{
                const searchInput = document.getElementById('chatSearchInput') || document.getElementById('search');
                if (searchInput && searchInput.value) {{
                    searchInput.value = '';
                    searchInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                }}
                const selectNone = document.getElementById('btnSelectNone');
                if (selectNone) selectNone.click();

                const skipCb = document.getElementById('skipExported');
                if (skipCb && skipCb.checked) {{
                    skipCb.checked = false;
                    skipCb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                const sel = document.getElementById('format');
                if (sel && sel.value !== 'pdf') {{
                    sel.value = 'pdf';
                    sel.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                const targetIds = {json.dumps(target_ids)};
                const targetTitles = {json.dumps(target_titles)};
                const items = Array.from(document.querySelectorAll('#list .item'));
                let checkedCount = 0;
                const matchedList = [];
                items.forEach(item => {{
                    const cid = item.dataset.chatId;
                    const titleText = item.querySelector('.chat-title, .title')?.textContent || '';
                    const matchId = targetIds.some(tid => cid && (cid === tid || cid.includes(tid) || tid.includes(cid)));
                    const matchTitle = targetTitles.some(tt => tt && tt.length > 2 && (titleText.includes(tt) || tt.includes(titleText)));
                    if (matchId || matchTitle) {{
                        const cb = item.querySelector('input[type=checkbox]');
                        if (cb && !cb.checked) {{
                            cb.checked = true;
                            cb.dispatchEvent(new Event('change', {{ bubbles: true }}));
                            checkedCount++;
                            matchedList.push({{ id: cid, title: titleText }});
                        }}
                    }}
                }});
                return {{
                    totalItems: items.length,
                    checkedCount: checkedCount,
                    matched: matchedList
                }};
            }})()
            """) or {}
            time.sleep(0.5)

            checked_count = check_res.get("checkedCount", 0)
            if checked_count < 2:
                # 兜底：若特定会话未匹配够，勾选当前列表前 4 项
                cdp_opt.eval("""
                (() => {
                    const items = Array.from(document.querySelectorAll('#list .item'));
                    items.slice(0, 4).forEach(it => {
                        const cb = it.querySelector('input[type=checkbox]');
                        if (cb && !cb.checked) {
                            cb.checked = true;
                            cb.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    });
                })()
                """)
                time.sleep(0.3)

            downloaded_zip = CDPActions.trigger_export_zip(
                cdp_opt,
                ctx.output_dir,
                max_wait=90,
                skip_exported=False,
                format_type="pdf"
            )
            if not downloaded_zip or not os.path.isfile(downloaded_zip) or os.path.getsize(downloaded_zip) == 0:
                return False, "未能成功下载或落盘 PDF 导出的 ZIP 文件", None

            zip_size = os.path.getsize(downloaded_zip)
            import shutil
            extract_dir = os.path.join(ctx.output_dir, "extracted_pdf")
            if os.path.isdir(extract_dir):
                shutil.rmtree(extract_dir)
            os.makedirs(extract_dir, exist_ok=True)
            with zipfile.ZipFile(downloaded_zip, "r") as zf:
                zf.extractall(extract_dir)
                namelist = zf.namelist()

            pdf_files = [n for n in namelist if n.endswith(".pdf") and not os.path.basename(n).startswith(".")]
            if len(pdf_files) == 0:
                return False, f"导出的 ZIP 中未包含任何 .pdf 文件 (文件清单: {namelist[:5]})", None

            # 校验每一个 PDF 文件合法的二进制结构
            zero_byte_count = 0
            for pf in pdf_files:
                fpath = os.path.join(extract_dir, pf)
                if not os.path.isfile(fpath) or os.path.getsize(fpath) == 0:
                    zero_byte_count += 1
                    continue
                size = os.path.getsize(fpath)
                if size < 500:
                    return False, f"PDF 导出文件尺寸异常过小 ({size} bytes): {pf}", None

                with open(fpath, "rb") as f:
                    header = f.read(1024)
                    f.seek(max(0, size - 2048))
                    tail = f.read(2048)

                # 校验合法 PDF 魔数头与结构特征
                if not header.startswith(b"%PDF-"):
                    return False, f"PDF 导出文件缺少标准 %PDF- 文件头魔数: {pf}", None
                if b"%%EOF" not in tail and b"/Root" not in header and b"/Root" not in tail:
                    return False, f"PDF 导出文件缺少标准结构体特征: {pf}", None

                # 提取并严格断言 PDF 内部真实文本与消息渲染（物理杜绝空会话假通过）
                pdf_info = self._extract_pdf_info(fpath)
                pdf_text = pdf_info.get("text", "")
                text_len = pdf_info.get("textLength", 0)

                # 物理禁止空会话 0 messages 占位
                if re.search(r"\b0\s*(messages|条消息)\b", pdf_text, re.IGNORECASE):
                    return False, f"PDF 导出文件 [{pf}] 正文缺失（包含 '0 messages' 占位符，未渲染真实对话消息）: text={pdf_text!r}", pdf_info

                if text_len < 100:
                    return False, f"PDF 导出文件 [{pf}] 提取文本长度异常过短 ({text_len} 字符): text={pdf_text!r}", pdf_info

                # 1. 中文字符保留率断言（物理防止沙箱中文字体缺失导致汉字全部被静默丢弃）
                if re.search(r"[\u4e00-\u9fa5]", pf):
                    cjk_chars = len(re.findall(r"[\u4e00-\u9fa5]", pdf_text))
                    if cjk_chars < 50:
                        return False, f"PDF 导出文件 [{pf}] 中文字符提取数量过低 ({cjk_chars} 字符)，疑似中文字体未正确嵌入导致字符丢失: text={pdf_text[:300]!r}", pdf_info

                # 2. 乱码与字符替换断言（杜绝缺少字形时的替换字符 \ufffd 豆腐块）
                if "\ufffd" in pdf_text:
                    return False, f"PDF 导出文件 [{pf}] 存在字符乱码/替换字符 (\\ufffd 豆腐块)", pdf_info

                # 3. 内部元数据标签泄露断言（防 <Image ... image_agent_tag_...> 泄露）
                if "image_agent_tag_" in pdf_text or re.search(r"<Image\s+[^>]*image_agent_tag", pdf_text):
                    return False, f"PDF 导出文件 [{pf}] 泄漏内部未清洗的 <Image ... image_agent_tag> 标签: text={pdf_text[:300]!r}", pdf_info

                # 4. 数学公式转换回退断言（防止 LaTeX 公式解析失败回退为带有 fallbackLabel 的提示或原始代码块）
                has_fallback_label = "无法排版该公式" in pdf_text or "Could not typeset this formula" in pdf_text
                raw_latex_fallback_blocks = len(re.findall(r"\bLaTeX[\s\ufffd]+[\\a-zA-Z0-9_\^\|\-]", pdf_text))
                if has_fallback_label or raw_latex_fallback_blocks > 0:
                    return False, f"PDF 导出文件 [{pf}] 存在未编译的原始 LaTeX 公式回退标签: text={pdf_text[:300]!r}", pdf_info

                # 5. 关键业务词物理存在性断言（确保标题与核心正文真实落地）
                if "贝尔不等式" in pf:
                    for kw in ["贝尔", "不等式"]:
                        if kw not in pdf_text:
                            return False, f"PDF 导出文件 [{pf}] 缺失核心关键词 [{kw}]: text={pdf_text[:300]!r}", pdf_info
                elif "Python日志" in pf:
                    for kw in ["Python", "日志"]:
                        if kw not in pdf_text:
                            return False, f"PDF 导出文件 [{pf}] 缺失核心关键词 [{kw}]: text={pdf_text[:300]!r}", pdf_info
                elif "韦伯望远镜" in pf:
                    for kw in ["韦伯"]:
                        if kw not in pdf_text:
                            return False, f"PDF 导出文件 [{pf}] 缺失核心关键词 [{kw}]: text={pdf_text[:300]!r}", pdf_info

            if zero_byte_count > 0:
                return False, f"发现 {zero_byte_count} 个 0 字节的 PDF 文件", None

            return True, f"PDF 真实编译导出成功落盘并解压验证通过 (PDF文件数: {len(pdf_files)}, ZIP大小: {zip_size} bytes, 二进制与内容合规 100%)", {
                "zip_path": downloaded_zip,
                "pdf_count": len(pdf_files),
                "zip_size": zip_size
            }
        finally:
            # 恢复工作台默认格式为 markdown
            try:
                cdp_opt.eval("""
                (() => {
                    const sel = document.getElementById('format');
                    if (sel && sel.value !== 'markdown') {
                        sel.value = 'markdown';
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                })()
                """)
            except Exception:
                pass
            cdp_opt.close()
