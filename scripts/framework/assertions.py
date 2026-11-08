# scripts/framework/assertions.py
"""
Declarative Assertion Primitives for Gemini Exporter Test Automation.
Verifies CDP DOM states, storage invariants, disk file structure, 0-byte guards, and specification rules.
"""

import os
import re
import json
import zipfile
import time
import hashlib
import html
import unicodedata
import math
from scripts.framework.v2_probe import install_probe, snapshot
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Tuple, Optional, Dict, Any, List

import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
try:
    from tests.helpers.export_spec_asserter import ExportSpecificationAsserter
except ImportError:
    ExportSpecificationAsserter = None

from scripts.framework.selectors import GeminiSelectors, WorkbenchSelectors
from scripts.framework.archive_resources import validate_archive_resources, resource_references, find_archive_resource


def normalized_text(text: str) -> str:
    """Compare prose/code across DOM and Markdown without formatting/space noise."""
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'\\([\\`*_{}\[\]()#+.!|>-])', r'\1', text)
    return ''.join(c for c in unicodedata.normalize('NFKC', html.unescape(text)) if c.isalnum())


@lru_cache(maxsize=64)
def markdown_answer_evidence(text: str, visible_reference: str = '') -> Dict[str, Any]:
    parser = Path(__file__).with_name('markdown_evidence.mjs')
    result = subprocess.run(['node', str(parser)], input=json.dumps({'text': text, 'visibleReference': visible_reference}),
                            capture_output=True, text=True, check=True, timeout=20)
    return json.loads(result.stdout)


@lru_cache(maxsize=64)
def normalized_answer(text: str, markdown: bool = False, visible_reference: str = '') -> str:
    """Compare the entire authored answer, including code/math punctuation.

    Remove Markdown presentation through its grammar, not fragment heuristics.
    DOM evidence independently restores LaTeX and excludes collapsed tool/UI text.
    Image entities/resources are checked separately on physical disk.
    """
    if markdown:
        text = markdown_answer_evidence(text, visible_reference)['text']
    return ''.join(c for c in unicodedata.normalize('NFKC', text)
                   if not c.isspace() and c not in '\u200b\ufeff')


def markdown_messages(text: str) -> List[Dict[str, str]]:
    # Ignore headings inside fenced code, which can contain literal role examples.
    messages = []
    fence = None
    for line in text.splitlines(keepends=True):
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
        role = re.match(r'^## (?:👤 (You|你)|🤖 (Assistant|助手))\s*$', line) if fence is None else None
        if role:
            messages.append({'role': 'user' if role.group(1) else 'model', 'content': ''})
        elif messages:
            messages[-1]['content'] += line
    return messages


def assert_turn_content(text: str, evidence: List[Dict[str, Any]]) -> Tuple[bool, str]:
    """Check the exact ordered roles, including the last actual model response."""
    messages = markdown_messages(text)
    if not evidence or len(messages) != 2 * len(evidence):
        return False, f"轮次不完整: 实际消息={len(messages)}, 预期={2 * len(evidence)}"
    for idx, turn in enumerate(evidence):
        user, model = messages[2 * idx:2 * idx + 2]
        if (user['role'], model['role']) != ('user', 'model'):
            return False, f"第 {idx + 1} 轮角色次序错误"
        prompt = normalized_answer(turn.get('prompt', ''))
        if not prompt or prompt not in normalized_answer(user['content'], markdown=True, visible_reference=turn.get('prompt', '')):
            return False, f"第 {idx + 1} 轮真实用户 Prompt 缺失"
        response = normalized_answer(turn.get('response', ''))
        actual = normalized_answer(model['content'], markdown=True, visible_reference=turn.get('response', ''))
        execution = lambda events: [{key: event[key].replace('\r\n', '\n').strip('\n') for key in ('code', 'stdout')} for event in events]
        if execution(turn.get('execution_blocks', [])) != execution(markdown_answer_evidence(model['content'])['executionBlocks']):
            return False, f"第 {idx + 1} 轮代码执行记录与实际网页证据不匹配"
        if 'code_blocks' in turn:
            code = lambda blocks: [value.replace('\r\n', '\n').strip('\n') for value in blocks]
            if code(turn['code_blocks']) != code(markdown_answer_evidence(model['content'])['codeBlocks']):
                return False, f"第 {idx + 1} 轮代码不匹配（包含缩进和换行）"
        if response or actual:
            if response != actual:
                return False, f"第 {idx + 1} 轮真实 AI 回复全文不匹配 (网页={len(response)}, 导出={len(actual)})"
        elif not turn.get('has_images'):
            return False, f"第 {idx + 1} 轮缺少实际回复文本或图片证据"
        if turn.get('has_images') and not re.search(r'!\[[^\]]*\]\([^)]+\)', model['content']):
            return False, f"第 {idx + 1} 轮模型图片引用缺失"
    return True, f"完整 {len(evidence)} 轮真实提问/回复按角色匹配"


def assert_archive_targets(names: List[str], target_ids: List[str], extension: str,
                           excluded_ids: Optional[List[str]] = None) -> Tuple[bool, str]:
    # Conversation documents are root entries; files/ and assets/ may contain the same extension.
    entries = [n for n in names if n.endswith(extension) and '/' not in n.replace('\\', '/').removeprefix('./')
               and not os.path.basename(n).startswith('.')]
    missing = [cid for cid in target_ids if not any(os.path.basename(n).endswith(f"_{cid.removeprefix('c_')[-6:]}{extension}") for n in entries)]
    forbidden = [cid for cid in (excluded_ids or []) if any(os.path.basename(n).endswith(f"_{cid.removeprefix('c_')[-6:]}{extension}") for n in entries)]
    if not target_ids or missing or forbidden:
        return False, f"ZIP 目标覆盖错误: 缺失={missing}, 禁止出现={forbidden}"
    if excluded_ids is not None and len(entries) != len(target_ids):
        return False, f"部分跳过 ZIP 含额外会话: 实际={len(entries)}, 预期={len(target_ids)}"
    return True, f"ZIP 指定目标 {len(target_ids)} 个均存在"


def assert_scan_result(evidence: Dict[str, Any]) -> Tuple[bool, str]:
    response = evidence.get('response') or {}
    if (evidence.get('started') is not True or evidence.get('finished') is not True or evidence.get('error')
            or response.get('status') != 'complete' or not isinstance(response.get('pagesFetched'), int)
            or response['pagesFetched'] < 1 or not isinstance(response.get('conversationsFetched'), int)
            or response['conversationsFetched'] < 0):
        return False, f"Scan lacks a complete v2 result: {evidence}"
    return True, f"Recent source exhausted: {response['pagesFetched']} pages, {response['conversationsFetched']} entries"


def is_account_uuid(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', value) is not None


def valid_coverage(value):
    if not isinstance(value, dict) or set(value) != {'range'}:
        return False
    span = value['range']
    if span is None:
        return True
    if not isinstance(span, dict) or set(span) != {'head', 'tail'}:
        return False
    for end in ('head', 'tail'):
        key = span[end]
        if (not isinstance(key, dict) or set(key) != {'id', 'time'} or not isinstance(key['id'], str)
                or not key['id'] or type(key['time']) not in (int, float)
                or not math.isfinite(key['time'])):
            return False
    return span['head']['time'] >= span['tail']['time']


def assert_full_scan_coverage(evidence, coverage):
    ok, message = assert_scan_result(evidence)
    if not ok:
        return False, message
    if not valid_coverage(coverage):
        return False, 'Missing persisted v2 Recent Coverage: ' + str(coverage)
    # range=null is valid for empty/unordered sources. It is not proof of a trusted range.
    return True, message + '; Recent Coverage read after completion'


def assert_incremental_scan_result(evidence, before, after):
    response = evidence.get('response') or {}
    if (evidence.get('started') is not True or evidence.get('finished') is not True or evidence.get('error')
            or response.get('status') != 'up_to_date' or not isinstance(response.get('pagesFetched'), int)
            or response['pagesFetched'] < 1 or not valid_coverage(before) or not valid_coverage(after)
            or not before['range'] or not after['range']):
        return False, 'Incremental scan lacks a v2 trusted-boundary result'
    if (after['range']['tail'] != before['range']['tail']
            or after['range']['head']['time'] < before['range']['head']['time']):
        return False, 'Incremental scan lost persisted Recent coverage'
    return True, f"Trusted Recent boundary reached: {response['pagesFetched']} pages"


def assert_followup_scan_result(evidence, before, after):
    if (evidence.get('response') or {}).get('status') == 'up_to_date':
        return assert_incremental_scan_result(evidence, before, after)
    # v2 can exhaust instead of connecting; no v4 generation/order flags exist.
    return assert_full_scan_coverage(evidence, after)


def index_rows(state):
    """Only current account-keyed Index facts; no flat-id/title-source aliases."""
    account = state.get('accountId')
    rows = state.get('rows')
    if not is_account_uuid(account) or not isinstance(rows, list):
        return None
    result = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) - {'key', 'title', 'titleSource', 'createdAt', 'updatedAt', 'activityAt'}:
            return None
        key = row.get('key')
        if (not isinstance(key, dict) or set(key) != {'accountId', 'conversationId'}
                or key.get('accountId') != account or not isinstance(key.get('conversationId'), str)
                or not key['conversationId'] or key['conversationId'] in result):
            return None
        if ('title' in row) != ('titleSource' in row):
            return None
        if 'title' in row and (not isinstance(row['title'], str) or not row['title'].strip()
                               or row['titleSource'] not in ('user', 'provider', 'derived')):
            return None
        if any(type(row[field]) not in (int, float) or not math.isfinite(row[field])
               for field in ('createdAt', 'updatedAt', 'activityAt') if field in row):
            return None
        result[key['conversationId']] = row
    return result


def assert_passive_coverage(before, after, observations):
    coverage = after.get('coverage')
    account = after.get('accountId')
    rows = index_rows(after)
    if (before.get('coverage') is not None or not is_account_uuid(account) or before.get('accountId') != account
            or not valid_coverage(coverage) or not rows
            or coverage['range'] and any(coverage['range'][end]['id'] not in rows for end in ('head', 'tail'))
            or not any(p.get('streamId') == 'recent' and p.get('accountId') == account
                       and not p.get('truncated') and p.get('requestedAt', 0) > 0 for p in observations)):
        return False, 'Passive RPC did not establish persisted same-account Recent coverage'
    return True, 'Natural passive Recent coverage verified without active Scan'


def assert_activity_sync_result(baseline, before, scan, after, target_ids):
    initial = baseline.get('state') or {}
    account = after.get('accountId')
    if not is_account_uuid(account) or any(state.get('accountId') != account for state in (initial, before)):
        return False, 'Activity scan changed selected Registry account'
    ok, message = assert_followup_scan_result(scan, before.get('coverage'), after.get('coverage'))
    if not ok:
        return False, message
    old_rows, prior_rows, new_rows = index_rows(initial), index_rows(before), index_rows(after)
    if any(rows is None for rows in (old_rows, prior_rows, new_rows)):
        return False, 'Activity scan contains invalid account-keyed Index facts'
    if not target_ids:
        return False, 'Activity check has no targets'
    for cid in target_ids:
        row = new_rows.get(cid) or {}
        if (row.get('titleSource') != 'provider' or row.get('updatedAt', 0) <= old_rows.get(cid, {}).get('updatedAt', 0)):
            return False, f'Real activity was not committed: {cid}'
    for state in (initial, before):
        if not set(index_rows(state)).issubset(new_rows) or not set(state.get('exportIds', [])).issubset(after.get('exportIds', [])):
            return False, 'Scan removed archives or export records'
    return True, message


class CDPAssertions:
    @staticmethod
    def assert_pdf_math_compiled(text: str) -> Tuple[bool, str]:
        """Detect the renderer's fallback label, not ordinary LaTeX prose.

        Typst always emits mathFallback before preserved raw source. Whitespace
        can vary when text is extracted across glyphs, lines, and page breaks.
        """
        match = re.search(
            r"Could\s*not\s*typeset\s*this\s*formula|"
            r"\u65e0\s*\u6cd5\s*\u6392\s*\u7248\s*\u8be5\s*\u516c\s*\u5f0f",
            text,
        )
        if match:
            return False, text[max(0, match.start() - 80):match.end() + 300]
        return True, ""

    @staticmethod
    def assert_stream_completed(cdp_gemini, min_turns: int = 1) -> Tuple[bool, str, Dict[str, Any]]:
        """断言 Gemini 页面流式回复已彻底完成且 DOM 稳定"""
        state = cdp_gemini.eval(f"""
        (() => {{
            const userQueries = document.querySelectorAll('{GeminiSelectors.USER_QUERY_ALL}');
            const modelResponses = document.querySelectorAll('{GeminiSelectors.MODEL_RESPONSE_ALL}');
            const isStreaming = !!document.querySelector('{GeminiSelectors.STREAMING_INDICATORS}');
            const lastResp = modelResponses.length > 0 ? modelResponses[modelResponses.length - 1] : null;
            const textLen = lastResp ? (lastResp.textContent || '').length : 0;
            const hasImages = lastResp ? !!lastResp.querySelector('{GeminiSelectors.IMAGES}') : false;
            return {{
                userCount: userQueries.length,
                modelCount: modelResponses.length,
                isStreaming: isStreaming,
                lastTextLength: textLen,
                hasImages: hasImages
            }};
        }})()
        """) or {}

        user_count = state.get("userCount", 0)
        model_count = state.get("modelCount", 0)
        is_streaming = state.get("isStreaming", True)
        last_len = state.get("lastTextLength", 0)

        if user_count < min_turns:
            return False, f"提问轮次不足: 当前 {user_count} < 预期 {min_turns}", state
        if model_count < user_count:
            return False, f"模型回复数量不足: 模型 {model_count} < 提问 {user_count}", state
        if is_streaming:
            return False, "页面仍处于流式生成状态 (streaming flag active)", state
        if last_len == 0 and not state.get("hasImages"):
            return False, "末尾模型回复内容为空 (0 字符且无图片实体)", state

        return True, f"流式完成已断言 (轮次: {user_count}, 字符数: {last_len}, 包含图片: {state.get('hasImages')})", state

    @staticmethod
    def assert_realtime_order(cdp_opt, promoted_chat_id: str, older_chat_id: str) -> Tuple[bool, str, Dict[str, Any]]:
        """断言老会话追加提问后在 Options 列表中已实时置顶于对比会话之前"""
        install_probe(cdp_opt)
        order_info = cdp_opt.eval(f"""(async () => {{
            const state = await globalThis.__tier2V2.snapshot();
            const find = id => state.rows.find(row => row.key.conversationId.replace(/^c_/, '') === id.replace(/^c_/, ''));
            const items = [...document.querySelectorAll('#list .item')];
            const one = items.find(el => el.dataset.chatId?.replace(/^c_/, '') === {json.dumps(promoted_chat_id.removeprefix('c_'))});
            const two = items.find(el => el.dataset.chatId?.replace(/^c_/, '') === {json.dumps(older_chat_id.removeprefix('c_'))});
            return {{ts1:find({json.dumps(promoted_chat_id)})?.updatedAt ?? 0, ts2:find({json.dumps(older_chat_id)})?.updatedAt ?? 0,
                idx1:items.indexOf(one), idx2:items.indexOf(two), el1Found:!!one, el2Found:!!two, totalDom:items.length}};
        }})()""", await_promise=True) or {}

        idx1 = order_info.get("idx1", -1)
        idx2 = order_info.get("idx2", -1)
        ts1 = order_info.get("ts1", 0)
        ts2 = order_info.get("ts2", 0)

        if idx1 == -1 or idx2 == -1:
            return False, f"未在 DOM 列表中找到两会话节点 (idx1={idx1}, idx2={idx2})", order_info

        if idx1 > idx2:
            return False, f"实时置顶顺序违背: 被置顶会话索引 {idx1} > 对比会话索引 {idx2}", order_info

        if ts1 < ts2:
            return False, f"时间戳更新异常: 置顶会话时间戳 {ts1} < 对比会话时间戳 {ts2}", order_info

        return True, f"实时置顶顺序正确 (置顶会话 #{idx1} 排在 #{idx2} 之前, ts1={ts1} >= ts2={ts2})", order_info

    @staticmethod
    def assert_badge_status(cdp_opt, chat_id: str, expected_type: str = "updated", timeout: float = 6.0) -> Tuple[bool, str, Dict[str, Any]]:
        """v2 shows export history; freshness is asserted from source and Record, never auto-selection."""
        install_probe(cdp_opt)
        deadline = time.monotonic() + timeout
        last = {}
        while time.monotonic() < deadline:
            last = cdp_opt.eval(f"""(async () => {{
                const state = await globalThis.__tier2V2.snapshot();
                const index = state.rows.find(row => row.key.conversationId.replace(/^c_/, '') === {json.dumps(chat_id.removeprefix('c_'))});
                const record = index && state.records[index.key.conversationId];
                const row = [...document.querySelectorAll('#list .item')].find(el => el.dataset.chatId === index?.key.conversationId);
                return {{found:!!row, index, record, text:row?.querySelector('small')?.textContent || ''}};
            }})()""", await_promise=True) or {}
            record, index = last.get('record') or {}, last.get('index') or {}
            shown = bool(re.search(r'Last export|Partial export|上次导出|部分导出', last.get('text', '')))
            if last.get('found') and shown and record.get('status') in ('ok', 'partial'):
                if expected_type == 'exported':
                    return True, 'ExportRecord is present and displayed', last
                if (isinstance(index.get('updatedAt'), (int, float)) and isinstance(record.get('chatTime'), (int, float))
                        and index['updatedAt'] > record['chatTime']):
                    return True, 'Source update is newer than the displayed ExportRecord', last
            time.sleep(0.25)
        return False, f'v2 export history/freshness evidence missing: {last}', last

    @staticmethod
    def assert_confirmed_deleted(cdp_opt, key: Dict[str, str], retained_ids: List[str], timeout: float = 10.0) -> Tuple[bool, str, Dict[str, Any]]:
        """Confirmed remote deletion removes the same key's three local facts only."""
        install_probe(cdp_opt)
        deadline = time.monotonic() + timeout
        last = {}
        while time.monotonic() < deadline:
            last = cdp_opt.eval(f"""(async () => {{
                const key = {json.dumps(key)};
                const id = key.conversationId;
                const stored = await globalThis.__tier2V2.storedConversation(key);
                const state = await globalThis.__tier2V2.snapshot();
                const ids = new Set(state.rows.map(row => row.key.conversationId));
                return {{sameAccount: state.accountId === key.accountId, removed: stored.index === null && stored.detail === null && stored.exportRecord === null,
                    othersRetained: {json.dumps(retained_ids)}.every(id => ids.has(id)),
                    inDom:[...document.querySelectorAll('#list .item')].some(el => el.dataset.chatId?.replace(/^c_/, '') === id)}};
            }})()""", await_promise=True) or {}
            if last.get('sameAccount') and last.get('removed') and last.get('othersRetained') and last.get('inDom') is False:
                return True, 'Confirmed deletion removed Index, Detail and ExportRecord; unrelated Index facts remain', last
            time.sleep(0.3)
        return False, f'Confirmed local deletion failed: {last}', last

    @staticmethod
    def assert_title_upgraded(cdp_opt, check_ids: List[str]) -> Tuple[bool, str, Dict[str, Any]]:
        """断言 Takeout 导入的会话标题在全量拉取历史后被在线 RPC 权威晋级"""
        state = snapshot(cdp_opt)
        status = {'total': len(state['rows']), 'matched': [
            {'id': row['key']['conversationId'], 'title': row.get('title'), 'source': row.get('titleSource')}
            for row in state['rows'] if row['key']['conversationId'].removeprefix('c_') in {cid.removeprefix('c_') for cid in check_ids}]}

        matched = status.get("matched", [])
        missing = [cid for cid in check_ids if not any(m.get('id', '').removeprefix('c_') == cid.removeprefix('c_') for m in matched)]
        if not check_ids or missing:
            return False, f"预期需要 RPC 晋级的会话缺失: {missing}", status
        if not matched:
            return False, "未找到任何匹配的 Takeout 导入会话", status

        upgraded_count = 0
        for m in matched:
            source = m.get("source", "")
            is_rpc = source == "provider" and bool(m.get("title"))
            if is_rpc:
                upgraded_count += 1

        if upgraded_count != len(check_ids):
            return False, f"预期 RPC 晋级未全部完成: {upgraded_count}/{len(check_ids)} (sources: {[m.get('source') for m in matched]})", status

        return True, f"Takeout 临时标题成功升级为 RPC 权威标题 (升级数: {upgraded_count}/{len(matched)})", status

    @staticmethod
    def _norm_chat_id(chat_id: Any) -> str:
        """剥离 c_ 前缀并做大小写归一，用于会话 ID 集合比对（顺序无关）。"""
        if chat_id is None:
            return ""
        return str(chat_id).removeprefix("c_").strip().lower()

    @staticmethod
    def assert_search_filter(cdp_opt, query: str, expected_ids: Optional[List[str]] = None, timeout: float = 3.0) -> Tuple[bool, str, Dict[str, Any]]:
        """断言搜索过滤结果，轮询等待渲染稳定后做一次集合判定。

        两种互斥模式（不再叠加数量区间/收缩/逐项等多重判断）：
        - expected_ids 给定时：直接比较实际可见 ID 与预期 ID 的排序列表（归一化后，
          顺序无关、重复计数敏感）。错误 ID、额外结果、遗漏结果、重复 ID 均为 FAIL，
          天然覆盖数量检查。
        - expected_ids 为空时：逐项确认每个可见项的标题或 ID 包含查询串，
          用于无法预先确定完整结果集的关键词搜索。
        """
        q = (query or "").strip().lower()
        norm_expected = None
        if expected_ids is not None:
            norm_expected = sorted(CDPAssertions._norm_chat_id(i) for i in expected_ids)
        start = time.time()
        last_vis_info: Dict[str, Any] = {}
        last_msg = ""

        while time.time() - start < timeout:
            vis_info = cdp_opt.eval(f"""
            (() => {{
                const items = Array.from(document.querySelectorAll('{WorkbenchSelectors.ITEM}'));
                const visible = items.filter(el => el.style.display !== 'none');
                return {{
                    visibleItems: visible.map(el => ({{
                        id: el.dataset.chatId || '',
                        title: el.querySelector('{WorkbenchSelectors.ITEM_TITLE}')?.textContent || ''
                    }}))
                }};
            }})()
            """) or {}
            last_vis_info = vis_info
            visible_items = vis_info.get("visibleItems", [])

            if norm_expected is not None:
                norm_visible = sorted(CDPAssertions._norm_chat_id(i.get("id", "")) for i in visible_items)
                if norm_visible != norm_expected:
                    last_msg = (
                        f"ID搜索不一致 (Query: '{query}'): "
                        f"实际={norm_visible} 预期={norm_expected}"
                    )
                else:
                    return True, f"搜索过滤断言通过 (Query: '{query}', 命中 {len(norm_visible)} 项，与预期一致)", vis_info
            else:
                if not visible_items:
                    last_msg = f"搜索过滤后无可见项 (Query: '{query}')"
                else:
                    mismatched = [
                        item for item in visible_items
                        if q not in str(item.get("title", "")).lower()
                        and q not in str(item.get("id", "")).lower()
                    ]
                    if mismatched:
                        last_msg = (
                            f"搜索过滤误匹配: {len(mismatched)} 项不含查询串 '{query}' "
                            f"(如 id={mismatched[0].get('id')} title={str(mismatched[0].get('title'))[:30]})"
                        )
                    else:
                        return True, f"搜索过滤断言通过 (Query: '{query}', {len(visible_items)} 项逐项匹配)", vis_info

            time.sleep(0.05)

        return False, last_msg, last_vis_info

    @staticmethod
    def assert_selection_state(cdp_opt) -> Dict[str, Any]:
        """快照工作台复选框原始状态：可选 ID 集合与已选 ID 集合（禁用项直接排除，不要求被选中）。

        数量一律由调用方按 len() 派生，本函数不维护任何计数或差集字段。
        """
        return cdp_opt.eval(f"""
        (() => {{
            const boxes = Array.from(document.querySelectorAll('{WorkbenchSelectors.ITEM} {WorkbenchSelectors.CHECKBOX}'));
            const selectable = [];
            const selected = [];
            for (const cb of boxes) {{
                if (cb.disabled) continue;
                const id = cb.closest('{WorkbenchSelectors.ITEM}')?.dataset?.chatId || '';
                selectable.push(id);
                if (cb.checked) selected.push(id);
            }}
            return {{ selectable, selected }};
        }})()
        """) or {}

    @staticmethod
    def assert_real_disk_live_save(
        target_dir: Optional[str] = None,
        target_chat_ids: Optional[List[str]] = None,
        min_mtime: Optional[float] = None,
        turn_evidence: Optional[Dict[str, List[Dict[str, Any]]]] = None,
        baselines: Optional[Dict[str, str]] = None,
        image_cdp=None
    ) -> Tuple[bool, str, Dict[str, Any]]:
        """
        断言真实磁盘的自动实时导出目录。
        必须指定明确的 target_dir 目录，严禁随意读取未授权的历史静态旧目录。
        若指定了 target_chat_ids，必须验证当次会话对应的 .md 文件真实存在、体积 > 0 且 mtime >= min_mtime。
        """
        if not target_dir or not os.path.isdir(target_dir):
            return False, f"未指定或未找到有效的实时落盘目录 (target_dir: {target_dir})", {}

        # 检查 target_dir 或其下的 gemini_export 子目录
        check_dir = target_dir
        sub_export = os.path.join(target_dir, "gemini_export")
        if os.path.isdir(sub_export):
            check_dir = sub_export

        zero_byte_files = []
        valid_md_files = []
        valid_img_files = []
        img_exts = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg")

        for root, _, files in os.walk(check_dir):
            for fname in files:
                fpath = os.path.join(root, fname)
                try:
                    fsize = os.path.getsize(fpath)
                    fmtime = os.path.getmtime(fpath)
                except OSError:
                    continue

                if fsize == 0:
                    zero_byte_files.append((fname, fpath))

                if fname.endswith(".md"):
                    if fsize > 0:
                        valid_md_files.append((fname, fsize, fmtime, fpath))
                elif fname.lower().endswith(img_exts):
                    if fsize > 0:
                        valid_img_files.append((fname, fsize, fmtime, fpath))

        summary = {
            "export_dir": check_dir,
            "total_md_valid": len(valid_md_files),
            "total_img_valid": len(valid_img_files),
            "zero_byte_files": [f[0] for f in zero_byte_files],
            "zero_byte_paths": [f[1] for f in zero_byte_files]
        }

        if zero_byte_files:
            return False, f"发现 {len(zero_byte_files)} 个 0 字节非法落盘文件！严重违背落盘完备性规范: {[f[0] for f in zero_byte_files]}", summary

        if len(valid_md_files) == 0:
            return False, f"落盘目录 {check_dir} 中未找到任何有效 .md 对话文件", summary

        # 若指定了目标会话 ID，执行严格的 ID 匹配与修改时间门禁核验
        if target_chat_ids:
            missing_ids = []
            stale_files = []
            matched_targets = []
            for cid in target_chat_ids:
                if not cid:
                    continue
                clean_cid = str(cid).removeprefix("c_")
                short_cid = clean_cid[-6:]
                matched = [
                    f for f in valid_md_files 
                    if f[0].endswith(f"_{short_cid}.md") or clean_cid in f[0]
                ]
                if not matched:
                    missing_ids.append(cid)
                else:
                    if len(matched) != 1:
                        return False, f"会话 {cid} 对应多个 MD，身份不唯一", summary
                    for mf in matched:
                        if min_mtime and mf[2] < (min_mtime - 5.0):
                            stale_files.append((mf[0], mf[2], min_mtime))
                        else:
                            matched_targets.append(mf[0])
                        text = Path(mf[3]).read_text(encoding='utf-8')
                        identity = re.search(r'^id:\s*["\']?([^"\'\s]+)', text, re.MULTILINE)
                        if not identity or identity.group(1).removeprefix('c_') != clean_cid:
                            return False, f"文件 {mf[0]} 的完整会话 ID 不匹配 {cid}", summary
                        if turn_evidence is not None:
                            ok, msg = assert_turn_content(text, turn_evidence.get(cid, []))
                            if not ok:
                                return False, f"{cid}: {msg}", summary
                        resource_errors = validate_archive_resources(check_dir, os.path.relpath(mf[3], check_dir), text)
                        if resource_errors:
                            return False, f"{cid} 资源引用无效: {resource_errors}", summary
                        evidence = (turn_evidence or {}).get(cid, [])
                        if any(turn.get('has_images') for turn in evidence):
                            if image_cdp is None:
                                return False, f"{cid} 缺少图片解码器，无法验证导出画面", summary
                            from .image_evidence import assert_markdown_images
                            try:
                                summary.setdefault('image_errors', {})[cid] = assert_markdown_images(
                                    image_cdp, check_dir, os.path.relpath(mf[3], check_dir), text, evidence)
                            except (ValueError, OSError, RuntimeError) as exc:
                                return False, f"{cid} 图片与网页不一致: {exc}", summary
                        before = (baselines or {}).get(cid)
                        if before is not None:
                            old_messages, new_messages = markdown_messages(before), markdown_messages(text)
                            if hashlib.sha256(before.encode()).digest() == hashlib.sha256(text.encode()).digest() or len(new_messages) <= len(old_messages):
                                return False, f"{cid} 内容未增量更新，仍为旧文件", summary
                            for old, new in zip(old_messages, new_messages):
                                if (old['role'] != new['role'] or normalized_answer(old['content'], True) != normalized_answer(new['content'], True)
                                        or markdown_answer_evidence(old['content'])['codeBlocks'] != markdown_answer_evidence(new['content'])['codeBlocks']
                                        or markdown_answer_evidence(old['content'])['executionBlocks'] != markdown_answer_evidence(new['content'])['executionBlocks']):
                                    return False, f"{cid} 追加后原有轮次内容被改变或丢失", summary
                        summary.setdefault('documents', {})[cid] = {'path': mf[3], 'text': text, 'sha256': hashlib.sha256(text.encode()).hexdigest()}

            summary["matched_targets"] = matched_targets
            summary["missing_targets"] = missing_ids
            summary["stale_targets"] = stale_files

            if missing_ids:
                return False, f"当次生成的会话未在落盘目录中找到对应的物理文件: {missing_ids}", summary

            if stale_files:
                return False, f"落盘文件修改时间早于当次测试启动时间 (疑似读取旧缓存文件): {[s[0] for s in stale_files]}", summary

        return True, f"物理磁盘实时落盘断言通过 (目录: {os.path.basename(check_dir)}, 有效MD: {len(valid_md_files)}, 有效图片: {len(valid_img_files)}, 0字节文件: 0)", summary

    @staticmethod
    def assert_exported_zip_spec(
        zip_path: str,
        extract_dir: str,
        min_conversations: int = 1,
        expected_golden_chats: Optional[List[Dict[str, Any]]] = None,
        expected_scenarios: Optional[List[Dict[str, Any]]] = None,
        chat_id: Optional[str] = None,
        uploaded_files: Optional[List[Dict[str, Any]]] = None
    ) -> Tuple[bool, str, Dict[str, Any]]:
        """解压 ZIP 归档包，核实 100% 对话轮次物理落盘，严禁 0 字节附件，并运行 ExportSpecificationAsserter 规范断言"""
        if not os.path.isfile(zip_path):
            return False, f"ZIP 文件不存在: {zip_path}", {}

        if os.path.getsize(zip_path) == 0:
            return False, f"导出的 ZIP 文件为 0 字节非法文件: {zip_path}", {}

        if os.path.exists(extract_dir):
            import shutil
            shutil.rmtree(extract_dir, ignore_errors=True)
        os.makedirs(extract_dir, exist_ok=True)
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(extract_dir)

        # 检查 0 字节文件
        zero_byte_files = []
        all_files = []
        for root, _, files in os.walk(extract_dir):
            for f in files:
                fp = os.path.join(root, f)
                all_files.append(fp)
                if os.path.getsize(fp) == 0:
                    zero_byte_files.append(f)

        if zero_byte_files:
            return False, f"导出的 ZIP 解压后发现 {len(zero_byte_files)} 个 0 字节文件: {zero_byte_files}", {"zero_byte": zero_byte_files}

        # 严禁出现 URL 畸变或长 URL 命名的附件文件 (files/*_https___... 或包含 URL 参数特征)
        malformed_files = [
            os.path.basename(f) for f in all_files 
            if "_https___" in f or "http___" in f or "download_c=" in f or "usercontent.google" in f
        ]
        if malformed_files:
            return False, f"导出的 ZIP 解压后发现因 URL 伪装文件名导致的严重畸变文件: {malformed_files}", {"malformed_files": malformed_files}

        # 校验文件名 cid6 统一命名
        all_mds = [
            f for f in all_files 
            if f.endswith(".md") 
            and not os.path.basename(f).startswith(("00_INDEX", "_index"))
            and not any(sub in os.path.relpath(f, extract_dir).split(os.sep) for sub in ("assets", "files", "images"))
        ]
        cid6_pat = re.compile(r"_[a-zA-Z0-9_-]{6}\.md$")
        invalid_naming = [os.path.basename(f) for f in all_mds if not cid6_pat.search(f)]
        if invalid_naming:
            return False, f"发现未遵循 _<cid6>.md 命名规范的文件: {invalid_naming}", {"invalid_naming": invalid_naming}

        # 校验现场会话轮次 100% 存在
        scenario_results = []
        if expected_scenarios:
            for idx, sc in enumerate(expected_scenarios, 1):
                raw_turns = sc.get("turns", [])
                turns_clean = [t.get("prompt", "") if isinstance(t, dict) else str(t) for t in raw_turns]
                best_file = None
                best_match_count = 0
                expected_id = sc.get('chat_id')
                for mf in all_mds:
                    with open(mf, "r", encoding="utf-8", errors="ignore") as f:
                        txt = f.read()
                    if expected_id:
                        matched_id = re.search(r'''(?m)^id:\s*["']?([^"'\s]+)''', txt.split('\n---\n', 1)[0])
                        if matched_id and matched_id.group(1).removeprefix('c_') == expected_id.removeprefix('c_'):
                            best_file = mf
                            break
                        continue
                    matches = sum(1 for t in turns_clean if t and t[:14] in txt)
                    if matches > best_match_count:
                        best_match_count = matches
                        best_file = mf

                matched_file = best_file

                if not matched_file:
                    return False, f"场景 {idx} 《{sc.get('title')}》 未在解压文件中找到对应的对话 Markdown！", {}

                with open(matched_file, "r", encoding="utf-8", errors="ignore") as f:
                    file_text = f.read()

                users = [message['content'] for message in markdown_messages(file_text)
                         if message['role'] == 'user']
                missing_turns = []
                for t_idx, p_str in enumerate(turns_clean, 1):
                    # Compare complete prompts in ordered user messages through
                    # Markdown's grammar: e.g. b=\[6,12,3\] renders as b=[6,12,3].
                    if (not p_str or t_idx > len(users)
                            or normalized_answer(p_str) not in normalized_answer(
                                users[t_idx - 1], markdown=True, visible_reference=p_str)):
                        missing_turns.append((t_idx, p_str[:20]))

                if missing_turns:
                    return False, f"场景 {idx} 存在缺失轮次: {missing_turns}", {"scenario": sc.get("title"), "missing": missing_turns}
                if 'turn_evidence' in sc:
                    complete, message = assert_turn_content(file_text, sc['turn_evidence'])
                    if not complete:
                        return False, f"场景 {idx} 全文核对失败: {message}", {"scenario": sc.get('title')}
                scenario_results.append({"scenario": sc.get("title"), "turns_matched": len(turns_clean)})

        # 运行 ExportSpecificationAsserter
        if ExportSpecificationAsserter:
            asserter = ExportSpecificationAsserter(extract_dir)
            spec_ok = asserter.run_all_assertions(
                min_conversations=min_conversations,
                expected_golden_chats=expected_golden_chats,
                target_chat_id=chat_id,
                uploaded_files=uploaded_files
            )
            if not spec_ok:
                err_summary = f": {asserter.errors[0]}" if asserter.errors else ""
                return False, f"ExportSpecificationAsserter 规范断言失败 (错误数: {len(asserter.errors)}){err_summary}", {"errors": asserter.errors}

        target_info = f", 目标会话命中: {chat_id}" if chat_id else ""
        return True, f"导出 ZIP 规范断言 100% 通过 (对话数: {len(all_mds)}, 0字节文件: 0{target_info}, 场景全轮次命中: {len(scenario_results)})", {"md_count": len(all_mds)}
