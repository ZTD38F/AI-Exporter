import os
import json
import time
import zipfile
import re
import subprocess
from typing import Tuple, Optional, Dict, Any

from scripts.framework.gemini_dual_parse import install_capture, finish_capture
from scripts.framework.image_evidence import capture_webpage_images, assert_zip_images
from scripts.framework.archive_resources import validate_archive_resources
from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.assertions import CDPAssertions, assert_archive_targets, assert_scan_result
from scripts.framework.pdf_evidence import assert_pdf_turn_content
from scripts.framework.html_evidence import assert_html_turn_content
from scripts.framework.selectors import WorkbenchSelectors
from scripts.framework.l3_contracts import audit_l3_contracts
from scripts.framework.v2_probe import install_probe
from scripts.framework.cases.sync import wait_for_prior_scan, clear_scan_records, select_source_account

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
        "id": "a714229ffb19b514",
        "category": "长对话跨页完整性 (64 轮)",
        "name": "平稳时序的分割共形预测解析（64 轮长对话）",
        "expected_snippets": ["split conformal prediction", "Chinese-English audit"],
        "syntax_checks": ["codeblock", "table"],
        "turn_evidence_fixture": "gemini_long_conversation.json"
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


def select_format_targets(cdp_opt, ctx, format_type):
    if not CDPActions.wait_for_export_idle(cdp_opt):
        raise RuntimeError("Previous export has not finished its UI/storage cleanup")
    required = [r['chat_id'] for r in ctx.chat_records if r.get('chat_id')]
    required += [h['id'] for h in DESIGNATED_HISTORICAL_CHATS if not h.get('optional')]
    optional = [h['id'] for h in DESIGNATED_HISTORICAL_CHATS if h.get('optional')]
    # The v2 Options controller maintains its own Settings mirror. Drive its
    # real change handlers, then verify both UI and persisted Application values.
    configured = CDPActions.configure_export_controls(cdp_opt, format_type, False)
    if not configured.get('ok'):
        raise RuntimeError(f"v2 export settings were not committed: {configured}")
    result = cdp_opt.eval(f"""
    (() => {{
        const required = {json.dumps(required)}, optional = {json.dumps(optional)};
        const normalize = id => (id || '').replace(/^c_/, '');
        const items = Array.from(document.querySelectorAll('#list .item'));
        const skip = document.getElementById('skipExported'), format = document.getElementById('format');
        if (!skip || !format) return {{ error: 'Missing format/skip controls' }};
        if (format.value !== {json.dumps(format_type)} || skip.checked || document.body.dataset.busy !== 'false')
            return {{error:'v2 export controls changed before selection'}};
        const matched = [];
        for (const item of items) {{
            const cid = normalize(item.dataset.chatId), cb = item.querySelector('input[type=checkbox]');
            if (!cb) continue;
            const selected = [...required, ...optional].includes(cid);
            if (cb.checked !== selected) cb.click();
            if (cb.checked) matched.push(cid);
        }}
        return {{ matched, missing: required.filter(cid => !matched.includes(cid)),
                  optionalMissing: optional.filter(cid => !matched.includes(cid)) }};
    }})()
    """) or {}
    if result.get('error') or result.get('missing') or not result.get('matched'):
        raise RuntimeError(f"指定 {format_type} 目标未完整勾选: {result}")
    return result


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
            flush_res = CDPActions.flush_live_save_to_disk(cdp_opt, ctx.output_dir)
            if not flush_res.get('ok'):
                return False, f"OPFS 回写失败: {flush_res.get('error')}", flush_res
            print(f"      📁 实时落盘文件已同步到磁盘 (文件总数: {flush_res.get('count', 0)})")

            disk_ok, disk_msg, disk_data = CDPAssertions.assert_real_disk_live_save(
                target_dir=ctx.output_dir,
                target_chat_ids=[s2_id],
                min_mtime=ctx.start_time,
                turn_evidence={s2_id: ctx.chat_records[1].get('turn_evidence', [])}, image_cdp=cdp_opt
            )
            if not disk_ok:
                return False, f"场景一物理磁盘落盘断言失败: {disk_msg}", disk_data

            # 3. Options 展示实际完成后的 ExportRecord；选择保持显式
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
        cdp_opt = ctx.connect_options()
        try:
            # Snapshot before the next actual prompt. The first exported MD is a
            # physical ZIP baseline when live save has not yet written this chat.
            baseline = ctx.shared_data.get('live_save_baselines', {}).get(s1_id)
            if not baseline:
                return False, "缺少老会话追加前的真实 MD 基线", None
            flush_res = CDPActions.flush_live_save_to_disk(cdp_opt, ctx.output_dir)
            if not flush_res.get('ok'):
                return False, f"追加前 OPFS 回写失败: {flush_res.get('error')}", flush_res
            before_dir = os.path.join(ctx.output_dir, 'gemini_export')
            if os.path.isdir(before_dir):
                candidates = [f for f in os.listdir(before_dir) if f.endswith(f'_{s1_id[-6:]}.md')]
                if len(candidates) > 1:
                    return False, "追加前老会话 MD 身份不唯一", None
                if candidates:
                    with open(os.path.join(before_dir, candidates[0]), encoding='utf-8') as f:
                        baseline = f.read()
            setup_ok = CDPActions.setup_live_save(cdp_opt, enabled=True)
            if not setup_ok:
                return False, "开启实时导出设置失败", None
            print("      ✓ 实时落盘已重新开启 (enabledDisk=True)")
        finally:
            cdp_opt.close()

        cdp_gem = ctx.connect_gemini()
        try:
            driver = ctx.get_gemini_driver(cdp_gem)
            session = driver.open_chat(s1_id, timeout=20.0)

            follow_up_prompt = "请根据前面讨论的所有方案与避坑建议，提炼一条最核心的架构决策准则，一句话极简总结。"
            print(f"      ▶️ 场景二：会话 1 继续追加提问: '{follow_up_prompt[:36]}...'")
            turn_res = session.send_turn(follow_up_prompt, max_wait=120)
            if not turn_res.success:
                return False, f"老会话继续追加提问失败: {turn_res.error}", None
            ctx.record_turn(ctx.chat_records[0], turn_res)
            ctx.freeze_turn_evidence(driver, ctx.chat_records[0])
            ctx.chat_records[0]["turns"].append(follow_up_prompt)
            print("      ✓ 继续追加提问流式回复已落地，等待实时保存落盘...")
        finally:
            cdp_gem.close()

        cdp_opt = ctx.connect_options()
        try:
            # Poll the actual content, not an arbitrary fixed settle delay.
            deadline = time.monotonic() + 30
            while True:
                flush_res = CDPActions.flush_live_save_to_disk(cdp_opt, ctx.output_dir)
                if not flush_res.get('ok'):
                    return False, f"OPFS 回写失败: {flush_res.get('error')}", flush_res
                disk_ok, disk_msg, disk_data = CDPAssertions.assert_real_disk_live_save(
                    target_dir=ctx.output_dir, target_chat_ids=[s1_id], min_mtime=ctx.start_time,
                    turn_evidence={s1_id: ctx.chat_records[0].get('turn_evidence', [])},
                    baselines={s1_id: baseline}, image_cdp=cdp_opt
                )
                if disk_ok or time.monotonic() >= deadline:
                    break
                time.sleep(0.5)
            if not disk_ok:
                return False, f"场景二物理磁盘落盘断言失败: {disk_msg}", disk_data

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
            CDPActions.clear_search_workbench(cdp_opt)
            # 与 FastSkip 用例解耦：若残留【跳过已导出】开启状态，显式关闭，
            # 保证手动勾选导出不受其他用例的开关状态影响。
            cdp_opt.eval("""
            (() => {
                const skip = document.getElementById('skipExported');
                if (skip && skip.checked) {
                    skip.checked = false;
                    skip.dispatchEvent(new Event('change', { bubbles: true }));
                }
            })()
            """)

            try:
                check_res = select_format_targets(cdp_opt, ctx, "markdown")
            except RuntimeError as e:
                return False, f"ZIP 导出目标准备不足: {e}", None
            expected_min_checked = len(ctx.chat_records) + sum(not h.get('optional') for h in DESIGNATED_HISTORICAL_CHATS)
            if len(check_res['matched']) < expected_min_checked:
                return False, f"工作台勾选数不足: {check_res}", check_res

            # Acquire under the capture before export: a complete local cache otherwise makes no native request.
            install_capture(cdp_opt)
            try:
                install_probe(cdp_opt)
                cdp_opt.eval(f"globalThis.__tier2V2.refreshForNativeAudit({json.dumps(check_res['matched'])})",
                             await_promise=True, timeout=180)
                downloaded_zip = CDPActions.trigger_export_zip(cdp_opt, ctx.output_dir, max_wait=60)
            finally:
                ctx.shared_data['gemini_dual_capture'] = finish_capture(
                    cdp_opt, os.path.join(ctx.output_dir, 'gemini_dual_parse', 'native'), check_res['matched'])
            if downloaded_zip and os.path.isfile(downloaded_zip) and os.path.getsize(downloaded_zip) > 0:
                audit_l3_contracts(cdp_opt, check_res['matched'])
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
            name="黄金分类与长对话全文完整性断言",
            description="解压导出的 ZIP，按 v2 Frontmatter 检查附件、来源事实与 Imagen 模型归属",
            critical=True,
            prerequisites=["feat_zip_export_download"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        downloaded_zip = ctx.shared_data.get("downloaded_zip")
        if not downloaded_zip or not os.path.isfile(downloaded_zip):
            return False, "未找到有效的 ZIP 文件用于多模态规范断言", None

        extract_dir = os.path.join(ctx.output_dir, "extracted_verify_" + str(int(time.time())))
        golden_chats = [dict(c) for c in DESIGNATED_HISTORICAL_CHATS]
        if len(ctx.chat_records) != 2:
            return False, '现场两会话尚未完整生成；不能将未完成场景匹配到其他 Markdown', {
                'completedChatIds': [record['chat_id'] for record in ctx.chat_records],
                'expectedChats': 2,
            }
        expected_scenarios = [dict(sc, chat_id=record['chat_id'], turn_evidence=record['turn_evidence'])
                              for sc, record in zip(ctx.scenarios[:2], ctx.chat_records)]
        min_conversations = len(ctx.chat_records) + sum(not h.get('optional') for h in DESIGNATED_HISTORICAL_CHATS)
        uploaded_files = [ctx.shared_data["uploaded_test_file"]] if "uploaded_test_file" in ctx.shared_data else None

        spec_ok, spec_msg, spec_data = CDPAssertions.assert_exported_zip_spec(
            zip_path=downloaded_zip,
            extract_dir=extract_dir,
            min_conversations=min_conversations,
            expected_golden_chats=golden_chats,
            expected_scenarios=expected_scenarios,
            uploaded_files=uploaded_files
        )

        if not spec_ok:
            return False, spec_msg, spec_data
        image_records = [record for record in ctx.chat_records
                         if any(turn.get('has_images') for turn in record.get('turn_evidence', []))]
        if image_records:
            cdp = ctx.connect_options()
            try:
                for record in image_records:
                    assert_zip_images(cdp, downloaded_zip, record['chat_id'], record['turn_evidence'])
            except (ValueError, OSError, RuntimeError, KeyError) as exc:
                return False, f"现场会话 ZIP 图片与网页不一致: {exc}", spec_data
            finally:
                cdp.close()
        return True, spec_msg, spec_data


class ImagenMultimodalCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_imagen_multimodal",
            domain=FeatureDomain.EXPORT_DISK,
            name="图片导出与网页内容一致性",
            description="核对 golden 会话导出 ZIP 中每轮图片引用、实体附件与网页画面",
            critical=True,
            prerequisites=["feat_zip_export_download"],
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        archive = ctx.shared_data.get('downloaded_zip')
        if not archive or not os.path.isfile(archive):
            return False, "缺少实际导出 ZIP，页面有图不能代替导出验收", None
        chat_id = DESIGNATED_HISTORICAL_CHATS[0]['id']
        cdp = ctx.connect_gemini()
        try:
            cdp.call('Page.navigate', {'url': f'https://gemini.google.com/app/{chat_id}'})
            images = capture_webpage_images(cdp, chat_id)
            count = cdp.eval("document.querySelectorAll('model-response').length")
            evidence = [{'images': [image for image in images if image['turn'] == index]}
                        for index in range(count)]
            with open(os.path.join(ctx.output_dir, 'golden_image_evidence.json'), 'w', encoding='utf-8') as out:
                json.dump({'chat_id': chat_id, 'turns': evidence}, out)
            errors = assert_zip_images(cdp, archive, chat_id, evidence)
            ctx.shared_data['golden_image_evidence'] = evidence
            return True, "导出 ZIP 的图片引用、附件文件与网页画面一致", {
                'chat_id': chat_id, 'images': len(images), 'pixel_errors': errors}
        except (ValueError, OSError, RuntimeError, zipfile.BadZipFile, KeyError) as exc:
            return False, f"图片导出验收失败: {exc}", None
        finally:
            cdp.close()


class StaleTabImageExportCase(FeatureTestCase):
    """Exercise the real image export route with an active, receiver-less Gemini tab."""

    def __init__(self):
        super().__init__(
            feature_id="feat_stale_tab_image_export",
            domain=FeatureDomain.EXPORT_DISK,
            name="失效 Gemini 标签页下的图片导出",
            description="扩展重装后保留未刷新的同账号标签页，验证图片导出可转用已注入的标签页",
            critical=True,
            # Reuse independently captured golden webpage images after reinstall.
            prerequisites=["feat_imagen_multimodal"],
            after=["feat_html_export_download", "feat_pdf_export_download", "feat_fast_skip_exported"],
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        image_chat = DESIGNATED_HISTORICAL_CHATS[0]
        evidence = ctx.shared_data.get('golden_image_evidence')
        if not evidence:
            return False, "缺少 golden 网页图片证据", None
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
                # Uninstall revokes optional origins: tabs.query({url}) cannot
                # see Gemini until a new, real Chrome permission grant. Request
                # access without the Tour's activatePlatformAccess, which would
                # inject the deliberately receiver-less stale document as well.
                granted = cdp_opt.eval("""chrome.permissions.request({origins: [
                    'https://gemini.google.com/*', 'https://*.googleusercontent.com/*',
                    'https://*.usercontent.google.com/*', 'https://drive.google.com/*',
                    'https://lh3.google.com/*', 'https://*.gstatic.com/*'
                ]})""", await_promise=True, user_gesture=True, timeout=120)
                if granted is not True:
                    return False, "重装后 Gemini 站点权限未获授权", {"permissionGranted": granted}
                setup = cdp_opt.eval(f"""(async () => {{
                    const staleId = {stale_id};
                    // Permission resolution and the background onAdded handler
                    // race; do not navigate the fresh document before registration.
                    const ids = ['gemini-source-main', 'gemini-source-content'];
                    let registered = [];
                    for (let i = 0; i < 80; i++) {{
                        registered = await chrome.scripting.getRegisteredContentScripts({{ids}});
                        if (registered.length === ids.length) break;
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }}
                    if (registered.length !== ids.length) return {{error: 'Gemini scripts not registered', registered}};
                    const tabs = await chrome.tabs.query({{url: 'https://gemini.google.com/*'}});
                    const fresh = tabs.filter(tab => tab.id !== staleId && !tab.url?.includes('/glic'));
                    if (!fresh.length) return {{error: 'no second Gemini tab',
                        permissions: await chrome.permissions.getAll(), tabs}};
                    for (const tab of fresh) await chrome.tabs.reload(tab.id);
                    const probe = id => new Promise(resolve => chrome.tabs.sendMessage(id, {{action: 'ping'}}, reply =>
                        resolve({{reply, error: chrome.runtime.lastError?.message || ''}})));
                    let good;
                    for (let i = 0; i < 80; i++) {{
                        good = await probe(fresh[0].id);
                        if (good.reply?.ok) break;
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }}
                    const stale = await probe(staleId);
                    await chrome.tabs.update(staleId, {{active: true}});
                    return {{stale, good, staleId, freshId: fresh[0].id}};
                }})()""", await_promise=True, timeout=50) or {}
                if setup.get("error"):
                    return False, f"旧标签页场景准备失败: {setup['error']}", setup
                if "Receiving end does not exist" not in setup.get("stale", {}).get("error", ""):
                    return False, f"旧标签页未保持无接收端状态: {setup}", setup
                if not setup.get("good", {}).get("reply", {}).get("ok"):
                    return False, f"已刷新标签页尚未注入内容脚本: {setup}", setup

                # Reinstall removes the historical index. Natural sidebar loading
                # only observes a recent page, so an older target is not guaranteed
                # to exist until a real paginated sync finishes.
                cdp_opt.eval("document.querySelector('.tour-popover button')?.click()")
                select_source_account(cdp_opt, source_tab_id=setup['freshId'])
                wait_for_prior_scan(cdp_opt)
                clear_scan_records(cdp_opt)
                scan = CDPActions.trigger_deep_scan(cdp_opt)
                scan_ok, message = assert_scan_result(scan)
                setup['historyScan'] = scan
                if not scan_ok:
                    # Preserve the real reason and post-failure tab state before finalization closes tabs.
                    setup['accountRouteFailure'] = cdp_opt.eval("""(async () => ({
                        log: document.querySelector('#log')?.textContent || '',
                        tabs: await Promise.all((await chrome.tabs.query({})).filter(tab => tab.url &&
                            ['gemini.google.com', 'www.google.com'].includes(new URL(tab.url).hostname))
                            .map(async tab => ({id: tab.id, path: new URL(tab.url).origin + new URL(tab.url).pathname,
                                status: tab.status, discarded: tab.discarded,
                                probe: await chrome.tabs.sendMessage(tab.id, {action: 'getAccountContext'})
                                    .catch(error => ({error: String(error)}))})))
                    }))()""", await_promise=True, timeout=15)
                    return False, f"重装后历史同步未完成: {message}", setup
                # Discovery can now repair a document predating installation.
                # A recovered receiver must prove the same selected account.
                after_scan = cdp_opt.eval(f"""(async () => {{
                    const probe = id => new Promise(resolve => chrome.tabs.sendMessage(id, {{action: 'ping'}}, reply =>
                        resolve({{reply, error: chrome.runtime.lastError?.message || ''}})));
                    await chrome.tabs.update({stale_id}, {{active: true}});
                    const stale = await probe({stale_id});
                    const binding = stale.reply?.ok ? await chrome.tabs.sendMessage({stale_id}, {{action:'getAccountContext'}}) : null;
                    return {{stale, good: await probe({setup['freshId']}), binding,
                        accountId: document.getElementById('accountIdSelect').value}};
                }})()""", await_promise=True, timeout=15) or {}
                setup['afterHistoryScan'] = after_scan
                if "Receiving end does not exist" not in after_scan.get('stale', {}).get('error', ''):
                    binding = after_scan.get('binding') or {}
                    context = binding.get('accountContext') or {}
                    if binding.get('ok') is not True or context.get('providerId') != 'gemini' or context.get('accountId') != after_scan.get('accountId'):
                        return False, "旧标签页修复后未绑定所选 Gemini 账号", setup
                if not after_scan.get('good', {}).get('reply', {}).get('ok'):
                    return False, "历史同步后可用标签页失去接收端", setup

                # Select only a genuinely observed row after the completed sync.
                selected = cdp_opt.eval(f"""(async () => {{
                    // A content-script ping proves injection, not completion of
                    // Gemini's asynchronous list response/account hydration.
                    // Wait for the real observed target; never seed or skip it.
                    for (let attempt = 0; attempt < 80; attempt++) {{
                        const item = Array.from(document.querySelectorAll('#list .item'))
                            .find(el => el.dataset.chatId === '{image_chat['id']}');
                        const cb = item?.querySelector('input[type=checkbox]');
                        if (cb) {{
                            document.querySelector('.tour-popover button')?.click();
                            document.querySelectorAll('#list input[type=checkbox]:checked').forEach(input => input.click());
                            if (!cb.checked) cb.click();
                            return cb.checked;
                        }}
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }}
                    return false;
                }})()""", await_promise=True, timeout=25)
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
                errors = assert_zip_images(cdp_opt, archive, image_chat["id"], evidence)
                details["image_errors"] = errors
                return True, "无接收端旧标签页优先时，图片引用、附件和网页画面均一致", {"tabs": setup, "export": details}
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
            description="勾选【跳过已导出】时，已导出会话前置分流且不会产生下载文件；含新会话时精准导出",
            critical=True,
            # Six exported records require both live conversations and the historical ZIP batch.
            prerequisites=["feat_chat_generation", "feat_zip_export_download"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            CDPActions.clear_search_workbench(cdp_opt)
            install_probe(cdp_opt)
            settings = CDPActions.configure_export_controls(cdp_opt, 'markdown', True)
            if not settings.get('ok'):
                return False, f"v2 Skip 设置未提交: {settings}", settings
            prep = cdp_opt.eval("""
            (async () => {
                const items = Array.from(document.querySelectorAll('#list .item'));
                const state = await globalThis.__tier2V2.snapshot();
                const eligible = new Set(await globalThis.__tier2V2.skipEligibleIds());
                const exported = items.filter(it => eligible.has(it.dataset.chatId));
                const skip = document.getElementById('skipExported');
                const btn = document.getElementById('btnExport');
                if (!skip || !btn || !skip.checked) return { error: 'v2 Skip controls unavailable' };
                for (const it of items) {
                    const cb = it.querySelector('input[type=checkbox]');
                    if (cb && cb.checked !== exported.includes(it)) cb.click();
                }
                return { count: exported.length, log: document.getElementById('status')?.textContent || '' };
            })()
            """, await_promise=True) or {}
            if prep.get('error') or prep.get('count', 0) < 6:
                return False, f"全量跳过准备不足: {prep}", prep
            start = time.monotonic()
            existing_files = set(os.listdir(ctx.output_dir))
            clicked = cdp_opt.eval("""(() => {
                const btn = document.getElementById('btnExport');
                if (!btn || btn.disabled) return false;
                btn.click(); return true;
            })()""")
            if not clicked:
                return False, "全量跳过导出按钮不可用", None
            completed = False
            status = {}
            while time.monotonic() - start < 6:
                status = cdp_opt.eval("""(() => ({
                    busy: !!document.getElementById('btnExport')?.disabled,
                    log: document.getElementById('status')?.textContent || ''
                }))()""") or {}
                previous = prep.get('log', '')
                current = status.get('log', '')
                fresh = current[len(previous):] if current.startswith(previous) else current if current != previous else ''
                result = re.fullmatch(r'Delivery initiated: (\d+); Skipped: (\d+); Conversation export failed: (\d+)', fresh)
                result = result or re.fullmatch(r'已发起交付 (\d+) 条会话; 跳过 (\d+); 会话导出失败 (\d+)', fresh)
                result = result or re.fullmatch(r'Successfully downloaded: (\d+)(?:; Skipped: (\d+))?(?:; Conversation export failed: (\d+))?', fresh)
                result = result or re.fullmatch(r'成功下载 (\d+) 条会话(?:; 跳过 (\d+))?(?:; 会话导出失败 (\d+))?', fresh)
                if not status.get('busy') and result:
                    completed = tuple(int(value or 0) for value in result.groups()) == (0, prep['count'], 0)
                    break
                time.sleep(0.25)
            duration = time.monotonic() - start
            if not completed:
                return False, "没有本次导出的全量跳过完成证据", status
            new_files = sorted(
                name for name in set(os.listdir(ctx.output_dir)) - existing_files
                if os.path.isfile(os.path.join(ctx.output_dir, name))
            )
            if new_files:
                return False, f"全量跳过异常生成文件: {new_files}", status

            partial = cdp_opt.eval("""
            (async () => {
                const items = Array.from(document.querySelectorAll('#list .item'));
                const state = await globalThis.__tier2V2.snapshot();
                const available = new Set(state.rows.filter(row => row.updatedAt !== undefined && row.titleSource === 'provider').map(row => row.key.conversationId));
                const eligible = new Set(await globalThis.__tier2V2.skipEligibleIds());
                const exported = items.find(it => eligible.has(it.dataset.chatId));
                const unexported = items.find(it => !state.records[it.dataset.chatId] && available.has(it.dataset.chatId));
                for (const it of items) {
                    const cb = it.querySelector('input[type=checkbox]');
                    if (cb && cb.checked !== (it === exported || it === unexported)) cb.click();
                }
                return { exportedId: exported?.dataset.chatId, unexportedId: unexported?.dataset.chatId,
                         unexportedSourceVerified: !!unexported };
            })()
            """, await_promise=True) or {}
            if not partial.get('exportedId') or not partial.get('unexportedId') or partial.get('unexportedSourceVerified') is not True:
                return False, "部分跳过需要真实已导出会话与云端可用的未导出会话，准备不足", partial
            # V2 L4 packages a ZIP only for multiple physical files. One
            # Markdown document without assets is delivered directly as .md.
            partial_file = CDPActions.trigger_export_zip(
                cdp_opt, ctx.output_dir, max_wait=30, skip_exported=True, allow_standalone=True
            )
            if not partial_file or not os.path.isfile(partial_file):
                return False, "部分跳过没有生成 v2 Markdown/ZIP 文件", partial
            if partial_file.lower().endswith('.zip'):
                with zipfile.ZipFile(partial_file) as zf:
                    ok, msg = assert_archive_targets(zf.namelist(), [partial['unexportedId']],
                                                     '.md', [partial['exportedId']])
                    if not ok:
                        return False, msg, partial
                    name = next(n for n in zf.namelist()
                                if n.endswith('.md') and '/' not in n.removeprefix('./')
                                and not os.path.basename(n).startswith('.'))
                    text = zf.read(name).decode('utf-8')
            elif partial_file.lower().endswith('.md'):
                with open(partial_file, encoding='utf-8') as exported:
                    text = exported.read()
            else:
                return False, f"v2 Partial Skip 交付了意外格式: {partial_file}", partial
            match = re.search(r'^id:\s*["\']?([^"\'\s]+)', text, re.MULTILINE)
            if not match or match.group(1).removeprefix('c_') != partial['unexportedId'].removeprefix('c_'):
                return False, "部分跳过正文的会话 ID 不匹配", partial
            return True, f"全量跳过与部分跳过均验证，交付只含未导出目标 (全量耗时 {duration:.2f}s)", {
                'all_skip_duration': duration, 'partial_prep': partial, 'download_path': partial_file
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
            # 各格式独立验证：目标选择与格式切换在 execute 内自理并恢复 markdown，
            # 不以 Skip Exported / Markdown 任一通过为必要条件。
            prerequisites=[],
            after=["feat_zip_export_download"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            CDPActions.clear_search_workbench(cdp_opt)
            time.sleep(0.3)

            try:
                check_res = select_format_targets(cdp_opt, ctx, "html")
            except RuntimeError as e:
                return False, f"HTML 导出目标准备不足: {e}", None

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
            targets_ok, targets_msg = assert_archive_targets(namelist, check_res['matched'], '.html')
            if not targets_ok:
                return False, targets_msg, check_res
            if len(html_files) == 0:
                return False, f"导出的 ZIP 中未包含任何 .html 文件 (文件清单: {namelist[:5]})", None

            verified_turns = 0
            for record in ctx.chat_records:
                cid = record.get('chat_id', '').removeprefix('c_')
                matches = [n for n in html_files if os.path.basename(n).endswith(f'_{cid[-6:]}.html')]
                if not cid or len(matches) != 1 or not record.get('turn_evidence'):
                    return False, f"HTML 缺少唯一会话文件或真实网页证据: {cid}", None
                with open(os.path.join(extract_dir, matches[0]), encoding='utf-8') as exported:
                    ok, message = assert_html_turn_content(exported.read(), record['turn_evidence'])
                if not ok:
                    return False, f"{cid}: {message}", None
                verified_turns += len(record['turn_evidence'])

            zero_byte_count = 0
            for hf in html_files:
                fpath = os.path.join(extract_dir, hf)
                if not os.path.isfile(fpath) or os.path.getsize(fpath) == 0:
                    zero_byte_count += 1
                    continue
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
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

            audit_l3_contracts(cdp_opt, check_res['matched'])
            return True, f"HTML 独立网页导出成功落盘并解压验证通过 (HTML文件数: {len(html_files)}, ZIP大小: {zip_size} bytes, 规范结构与 {verified_turns} 轮真实内容核验)", {
                "zip_path": downloaded_zip,
                "html_count": len(html_files),
                "verified_turns": verified_turns,
                "zip_size": zip_size
            }
        finally:
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
            # 与 HTML 同理独立验证，不以 HTML 通过为必要条件。
            prerequisites=[],
            after=["feat_zip_export_download"]
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
                text: res.text,
                contentRuns: res.contentRuns,
                imageXObjectCount: res.imageXObjectCount
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
            CDPActions.clear_search_workbench(cdp_opt)
            time.sleep(0.3)

            try:
                check_res = select_format_targets(cdp_opt, ctx, "pdf")
            except RuntimeError as e:
                return False, f"PDF 导出目标准备不足: {e}", None

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
            targets_ok, targets_msg = assert_archive_targets(namelist, check_res['matched'], '.pdf')
            if not targets_ok:
                return False, targets_msg, check_res
            if len(pdf_files) == 0:
                return False, f"导出的 ZIP 中未包含任何 .pdf 文件 (文件清单: {namelist[:5]})", None

            verified_turns = 0
            for record in ctx.chat_records:
                cid = record.get('chat_id', '').removeprefix('c_')
                matches = [n for n in pdf_files if os.path.basename(n).endswith(f'_{cid[-6:]}.pdf')]
                if not cid or len(matches) != 1 or not record.get('turn_evidence'):
                    return False, f"PDF 缺少唯一会话文件或真实网页证据: {cid}", None
                info = self._extract_pdf_info(os.path.join(extract_dir, matches[0]))
                ok, message = assert_pdf_turn_content(info, record['turn_evidence'])
                if not ok:
                    return False, f"{cid}: {message}", info
                verified_turns += len(record['turn_evidence'])

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
                math_compiled, fallback_context = CDPAssertions.assert_pdf_math_compiled(pdf_text)
                if not math_compiled:
                    return False, f"PDF [{pf}] contains an uncompiled formula fallback: {fallback_context!r}", pdf_info

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

            audit_l3_contracts(cdp_opt, check_res['matched'])
            return True, f"PDF 真实编译导出成功落盘并解压验证通过 (PDF文件数: {len(pdf_files)}, ZIP大小: {zip_size} bytes, 二进制与 {verified_turns} 轮真实内容核验)", {
                "zip_path": downloaded_zip,
                "pdf_count": len(pdf_files),
                "verified_turns": verified_turns,
                "zip_size": zip_size
            }
        finally:
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
