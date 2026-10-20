# scripts/framework/cases/lifecycle.py
import time
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.assertions import CDPAssertions

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
                CDPActions.setup_live_save(cdp_opt_prep, enabled=False)
            finally:
                cdp_opt_prep.close()
        except Exception as e:
            print(f"      ⚠️ 临时关闭实时落盘提示: {e}")

        cdp_g2 = ctx.connect_gemini()
        try:
            driver = ctx.get_gemini_driver(cdp_g2)
            session = driver.open_chat(s1_id, timeout=20.0)

            add_turn = "针对刚才深入探讨的系统架构设计，请再补充一条关于线上压测与容量规划的核心避坑建议，保持极简总结。"
            print(f"      ▶️ 追加提问: '{add_turn[:36]}...'")
            turn_res = session.send_turn(add_turn, max_wait=120)
            if turn_res.success:
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
            name="「已更新」徽章与智能勾选",
            description="已导出过的会话检测到新提问后，渲染琥珀色「已更新」徽章并被默认自动勾选",
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
                return True, f"真实置顶与徽章双重断言通过: {order_msg}; {badge_msg}", None
            return False, f"真实断言未通过: Order={order_msg} | Badge={badge_msg}", None
        finally:
            cdp_opt.close()


class EphemeralChatPruningCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_ephemeral_chat_pruning",
            domain=FeatureDomain.LIFECYCLE,
            name="瞬态会话网页端删除实时剥离",
            description="在网页端侧边栏删除会话，Options 列表与 Storage 在无需刷新情况下平滑剥离该项",
            critical=True,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_gem_live = ctx.connect_gemini()
        cdp_opt = ctx.connect_options()
        try:
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
            cdp_gem_live.eval("""(() => {
                window.__tier2DeleteEvents = [];
                window.addEventListener('message', event => {
                    if (event.data?.type === 'GEMINI_CONVERSATION_DELETED')
                        window.__tier2DeleteEvents.push(event.data.payload);
                });
            })()""")
            print(f"   🗑️ 成功生成瞬态会话 ({eph_chat_id})，在侧边栏触发网页原生删除...")
            del_ok = session.delete_via_web()
            if not del_ok:
                return False, f"网页端原生删除触发失败 (会话 ID: {eph_chat_id})", None
            ctx.tracker.mark_deleted(eph_chat_id)

            pruned_ok, pruned_msg, _ = CDPAssertions.assert_dom_pruned(cdp_opt, eph_chat_id, timeout=10.0)
            events = cdp_gem_live.eval("window.__tier2DeleteEvents || []")
            if pruned_ok:
                return True, "瞬态会话已实时剥离 DOM 与本地 Storage", {"delete_events": events}
            return False, f"DOM剥离校验失败: {pruned_msg}; 删除事件={events}", {"delete_events": events}
        finally:
            cdp_gem_live.close()
            cdp_opt.close()
