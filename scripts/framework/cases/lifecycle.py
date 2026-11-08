# scripts/framework/cases/lifecycle.py
import json
import time
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.assertions import CDPAssertions
from scripts.framework.cases.sync import read_sync_state, verify_activity_sync, select_source_account

try:
    from scripts.cdp_client import CDPConnection
except ImportError:
    from cdp_client import CDPConnection


class ContinuedChatPromotionCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_continued_chat_promotion",
            domain=FeatureDomain.LIFECYCLE,
            name="老会话追加提问实时置顶",
            description="回访较早创建的会话追加提问，STREAM_COMPLETE 触发后在 Options 列表无刷新置顶至首位",
            critical=True,
            prerequisites=["feat_chat_generation"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if len(ctx.chat_records) < 2:
            return False, "会话记录不足 2 个，无法验证老会话置顶升权", None

        s1_id = ctx.chat_records[0].get("chat_id")
        s2_id = ctx.chat_records[1].get("chat_id")
        if not s1_id or not s2_id or s1_id == s2_id:
            return False, f"会话 ID 无效或重复 (s1={s1_id}, s2={s2_id})", None

        print(f"\n   🔄 回访较早创建的会话 1 ({s1_id}) 进行追加提问...")
        # 确保实时落盘暂时处于关闭状态，使得本次更新在 Options 呈现「已更新」未同步状态
        try:
            cdp_opt_prep = ctx.connect_options()
            try:
                if not CDPActions.setup_live_save(cdp_opt_prep, enabled=False):
                    return False, "无法关闭实时落盘以验证已更新状态", None
                state = read_sync_state(cdp_opt_prep)
                ctx.shared_data['pre_promotion_sync_baseline'] = {
                    'state': state, 'scan': ctx.shared_data.get('deep_scan_evidence')
                    or ctx.shared_data.get('pre_chat_sync_baseline', {}).get('scan')}
            finally:
                cdp_opt_prep.close()
        except Exception as e:
            return False, f"临时关闭实时落盘失败: {e}", None

        cdp_g2 = ctx.connect_gemini()
        try:
            driver = ctx.get_gemini_driver(cdp_g2)
            session = driver.open_chat(s1_id, timeout=20.0)

            add_turn = "针对刚才深入探讨的系统架构设计，请再补充一条关于线上压测与容量规划的核心避坑建议，保持极简总结。"
            print(f"      ▶️ 追加提问: '{add_turn[:36]}...'")
            turn_res = session.send_turn(add_turn, max_wait=120)
            if turn_res.success:
                ctx.record_turn(ctx.chat_records[0], turn_res)
                ctx.freeze_turn_evidence(driver, ctx.chat_records[0])
                ctx.chat_records[0]["turns"].append(add_turn)
                return True, "老会话追加提问成功完成并触发 STREAM_COMPLETE", None
            return False, f"追加提问失败: {turn_res.error}", None
        finally:
            cdp_g2.close()


class UpdatedBadgeDisplayCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_updated_badge_display",
            domain=FeatureDomain.LIFECYCLE,
            name="来源更新时间与导出记录",
            description="追加提问后验证来源更新时间晚于已有导出记录；v2 保持显式选择",
            critical=True,
            prerequisites=["feat_continued_chat_promotion"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if len(ctx.chat_records) < 2:
            return False, "会话记录不足 2 个", None

        s1_id = ctx.chat_records[0].get("chat_id")
        s2_id = ctx.chat_records[1].get("chat_id")
        if not s1_id or not s2_id:
            return False, "会话 ID 无效", None

        cdp_opt = ctx.connect_options()
        try:
            # 严格禁止任何直接写入 chrome.storage.local 的后门作弊！
            # 确保工作台处于无过滤全量展示状态，避免先前搜索残余隐藏目标项
            CDPActions.clear_search_workbench(cdp_opt)
            time.sleep(0.5)
            order_ok, order_msg, _ = CDPAssertions.assert_realtime_order(cdp_opt, s1_id, s2_id)
            badge_ok, badge_msg, _ = CDPAssertions.assert_badge_status(cdp_opt, s1_id, "updated")

            if order_ok and badge_ok:
                baseline = ctx.shared_data.get('pre_promotion_sync_baseline') or {}
                verify_activity_sync(ctx, baseline, [s1_id], 'promoted_chat_incremental_sync')
                return True, f"真实置顶与徽章双重断言通过: {order_msg}; {badge_msg}", None
            return False, f"真实断言未通过: Order={order_msg} | Badge={badge_msg}", None
        finally:
            cdp_opt.close()


class EphemeralChatPruningCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_ephemeral_chat_pruning",
            domain=FeatureDomain.LIFECYCLE,
            name="确证网页删除与同 Key 原子清理",
            description="确证网页删除后，清理同 Key Index/Detail/ExportRecord，保留其他对话",
            critical=True,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_gem_live = ctx.connect_gemini()
        cdp_opt = ctx.connect_options()
        try:
            if not CDPActions.setup_live_save(cdp_opt, enabled=True):
                return False, '无法启用瞬态会话的真实保存', None
            driver = ctx.get_gemini_driver(cdp_gem_live)
            session = driver.new_chat(timeout=20.0)

            eph_query = ctx.provider.pop_ephemeral_query()
            print(f"   ▶️ 生成瞬态会话用于删除测试: '{eph_query[:30]}...'")
            turn_res = session.send_turn(eph_query, max_wait=90)
            if not turn_res.success:
                return False, f"瞬态会话发帖超时: {turn_res.error}", None

            eph_chat_id = session.chat_id or driver.get_current_chat_id()
            if not eph_chat_id:
                return False, "未能获取瞬态会话 ID", None

            ctx.tracker.track(eph_chat_id)
            select_source_account(cdp_opt, cdp_gem_live)
            before = read_sync_state(cdp_opt)
            key = {'accountId': before['accountId'], 'conversationId': eph_chat_id.removeprefix('c_')}
            retained_ids = [row['key']['conversationId'] for row in before['rows']
                            if row['key'] != key]
            deadline = time.monotonic() + 40
            prior = None
            while time.monotonic() < deadline:
                prior = cdp_opt.eval(f"globalThis.__tier2V2.storedConversation({json.dumps(key)})", await_promise=True)
                if (prior and (prior.get('index') or {}).get('key') == key
                        and (prior.get('detail') or {}).get('key') == key
                        and prior.get('exportRecord')):
                    break
                time.sleep(0.2)
            else:
                return False, "删除前未确认同 Key Index、Detail 与 ExportRecord，不能做空值验收", prior
            cdp_gem_live.eval("""(() => {
                window.__tier2DeleteEvents = [];
                window.addEventListener('message', event => {
                    if (event.source === window && event.origin === location.origin && event.data?.type === 'GEMINI_CONVERSATION_DELETED')
                        window.__tier2DeleteEvents.push(event.data.payload);
                });
            })()""")
            print(f"   🗑️ 成功生成瞬态会话 ({eph_chat_id})，在侧边栏触发网页原生删除...")
            del_ok = session.delete_via_web()
            if not del_ok:
                return False, f"网页端原生删除触发失败 (会话 ID: {eph_chat_id})", None
            ctx.tracker.mark_deleted(eph_chat_id)

            pruned_ok, pruned_msg, _ = CDPAssertions.assert_confirmed_deleted(cdp_opt, key, retained_ids, timeout=10.0)
            events = cdp_gem_live.eval("window.__tier2DeleteEvents || []")
            verified = any(event.get('id') == key['conversationId']
                           and event.get('requestAccountObservation', {}).get('providerAccountId') == before['account']['providerAccountId']
                           and event.get('requestAccountObservation', {}).get('providerId') == 'gemini'
                           and event.get('requestBody') and event.get('responseText') for event in events or [])
            if pruned_ok and verified:
                return True, "确证远端删除后，同 Key 本地事实已原子清理", {"delete_events": events}
            return False, f"确证删除清理校验失败: {pruned_msg}; 捕获到确认事件={verified}", {"delete_events": events}
        finally:
            cdp_gem_live.close()
            cdp_opt.close()
