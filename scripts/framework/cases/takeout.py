# scripts/framework/cases/takeout.py
import os
import time
import json
import re
import zipfile
import hashlib
import base64
from typing import Tuple, Optional, Dict, Any

from scripts.framework.cases.base import FeatureTestCase, TestContext
from scripts.framework.features import FeatureDomain
from scripts.framework.actions import CDPActions
from scripts.framework.v2_probe import install_probe, snapshot
from scripts.framework.cases.sync import clear_scan_records
from scripts.framework.assertions import CDPAssertions, assert_scan_result, assert_full_scan_coverage, assert_followup_scan_result, index_rows, is_account_uuid
from scripts.framework.archive_resources import resource_references, resolve_archive_reference


def validate_takeout_records(expected_ids, expected_media, records, source_facts, account_id):
    """Verify current keyed Domain reads against the keyless source facts and bytes.

    A source generation notice without authored content is not an assistant
    message. Existing complete bodies may legitimately win over partial imports.
    """
    if (not is_account_uuid(account_id) or len(records) != len(expected_ids)
            or {r.get('id') for r in records} != set(expected_ids) or set(source_facts) != set(expected_ids)):
        return False, "Takeout 正常读取路径缺少预期会话或来源证据"
    acquired = {}
    for record in records:
        domain, summary = record.get('domain') or {}, record.get('summary') or {}
        index, detail = domain.get('index') or {}, domain.get('detail') or {}
        key = {'accountId': account_id, 'conversationId': record['id']}
        if (record.get('ok') is not True or index.get('key') != key or detail.get('key') != key
                or record.get('account', {}).get('id') != account_id
                or record.get('account', {}).get('providerId') != 'gemini'
                or index_rows({'accountId': account_id, 'rows': [index]}) is None or summary != index
                or set(detail) - {'key', 'savedAt', 'quality', 'messages', 'assets'}):
            return False, f"Takeout 会话身份/Index/Detail 不符合当前合同: {record['id']}"
        messages, assets = detail.get('messages'), detail.get('assets')
        if not isinstance(messages, list) or not isinstance(assets, list):
            return False, 'Takeout Detail 缺少 messages/assets'
        asset_ids = {a.get('id') for a in assets}
        if len(asset_ids) != len(assets) or None in asset_ids:
            return False, 'Takeout Asset 注册表缺少唯一身份'
        for asset in assets:
            if set(asset) - {'id', 'kind', 'name', 'mediaType', 'byteLength', 'sourceUri', 'generation', 'document'}:
                return False, 'Takeout Asset 含旧 schema 字段'
            for name, fields in (('generation', {'providerRequestId', 'time', 'prompt', 'generationOrdinal', 'imageCount', 'imageOrdinal'}),
                                 ('document', {'id', 'contentMarkdown'})):
                if name in asset and (not isinstance(asset[name], dict) or not asset[name] or set(asset[name]) - fields):
                    return False, f'Takeout Asset.{name} 不是当前事实 schema'
        def has_content(value, owned_asset_ids):
            if isinstance(value, list):
                return any(has_content(child, owned_asset_ids) for child in value)
            if not isinstance(value, dict):
                return False
            if any(isinstance(value.get(key), str) and value[key].strip() for key in ('text', 'code', 'source')):
                return True
            if value.get('type') in ('image', 'file') and value.get('assetId') in owned_asset_ids:
                return True
            return any(has_content(value.get(key), owned_asset_ids) for key in ('children', 'blocks', 'items', 'rows', 'cells', 'headerRows'))
        for message in messages:
            if (set(message) - {'id', 'role', 'model', 'content', 'timestamp', 'attachmentIds', 'reasoning', 'citations'}
                    or not set(message.get('attachmentIds', [])).issubset(asset_ids)):
                return False, 'Takeout Message 含旧 schema 或悬空附件'
        source_messages = (source_facts[record['id']].get('detail') or {}).get('messages') or []
        if not source_messages:
            return False, 'Takeout 来源没有可核验的消息事实'
        source_asset_ids = {asset.get('id') for asset in source_facts[record['id']].get('detail', {}).get('assets', [])}
        source_roles = {message['role'] for message in source_messages
                        if has_content(message.get('content'), source_asset_ids) or message.get('attachmentIds')}
        for role in source_roles:
            if not any(m.get('role') == role and (has_content(m.get('content'), asset_ids)
                       or m.get('attachmentIds')) for m in messages):
                return False, f"Takeout 会话 {record['id']} 缺少来源已知的 {role} 内容"
        for resource in record.get('resources', []):
            path = resource.get('sourcePath')
            if path in expected_media:
                try:
                    data = base64.b64decode(resource.get('bytes') or '', validate=True)
                except (ValueError, TypeError):
                    return False, f"Takeout 资源不可读: {path}"
                if (resource.get('assetId') not in asset_ids or not data
                        or hashlib.sha256(data).hexdigest() != expected_media[path]):
                    return False, f"Takeout 资源身份/字节不一致: {path}"
                acquired[path] = True
    missing = set(expected_media) - acquired.keys()
    if missing:
        return False, f"Takeout 预期资源未进入读取路径: {sorted(missing)}"
    return True, f"Takeout {len(expected_ids)} 会话与 {len(expected_media)} 资源真实可读（支持重复导入）"


class TakeoutZipImportCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_takeout_zip_import",
            domain=FeatureDomain.TAKEOUT,
            name="离线 Takeout ZIP 导入",
            description="通过文件输入导入预置 Takeout ZIP，验证本地 Domain 与源归档资源字节",
            critical=True,
            prerequisites=[]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        if not os.path.isfile(ctx.takeout_zip):
            return False, f"Takeout ZIP 样本文件不存在: {ctx.takeout_zip}", None

        cdp_opt = ctx.connect_options()
        try:
            with zipfile.ZipFile(ctx.takeout_zip) as zf:
                html_files = [n for n in zf.namelist() if n.endswith('MyActivity.html')]
                if not html_files:
                    return False, "Takeout 样本缺少 MyActivity.html", None
                html_text = '\n'.join(zf.read(n).decode('utf-8') for n in html_files)
                expected_ids = sorted({cid.removeprefix('c_') for cid in re.findall(r'https://gemini\.google\.com/(?:u/\d+/)?app/([a-zA-Z0-9_-]+)', html_text)})
                expected_media = {}
                for name in html_files:
                    for ref in resource_references(zf.read(name).decode('utf-8'), html=True):
                        entry = resolve_archive_reference(name, ref)
                        if entry and entry not in html_files:
                            if entry not in zf.namelist():
                                return False, f"Takeout 样本引用资源缺失: {entry}", None
                            expected_media[entry] = hashlib.sha256(zf.read(entry)).hexdigest()
                catalog_media = {n: hashlib.sha256(zf.read(n)).hexdigest() for n in zf.namelist()
                                 if n.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'))}
            if not expected_ids:
                return False, "Takeout 样本没有可断言的会话身份", None
            before = snapshot(cdp_opt)
            print(f"   📥 导入离线 ZIP 样本 ({os.path.basename(ctx.takeout_zip)})...")
            import_res = CDPActions.import_takeout_zip(cdp_opt, ctx.takeout_zip, media_paths=list(catalog_media))
            if not import_res.get('success'):
                return False, f"导入失败: {import_res.get('error')}", import_res
            if (set(import_res.get('importedIds', [])) != set(expected_ids)
                    or import_res.get('status') not in ('ok', 'partial')
                    or import_res.get('imported') != len(expected_ids)
                    or snapshot(cdp_opt)['accountId'] != before['accountId']):
                return False, "导入完成回调缺少预期会话或包含部分资源失败", import_res
            if import_res.get('mediaDigests', {}) != catalog_media:
                return False, "Takeout 资源索引读取字节与原始 ZIP 不一致", import_res
            install_probe(cdp_opt)
            stored = cdp_opt.eval(f'globalThis.__tier2V2.conversations({json.dumps(expected_ids)})', await_promise=True) or []
            for record in stored:
                record['resources'] = import_res.get('sourceResources', {}).get(record['id'], [])
            ok, msg = validate_takeout_records(expected_ids, expected_media, stored, import_res.get('sourceFacts', {}), before['accountId'])
            if not ok:
                return False, msg, {'import': import_res}
            ctx.shared_data['takeout_ids'] = expected_ids
            # These designated historical samples are known online fixtures. Pure
            # offline identities in a custom archive are not required to upgrade.
            from scripts.framework.cases.export import DESIGNATED_HISTORICAL_CHATS
            known_online = {h['id'] for h in DESIGNATED_HISTORICAL_CHATS if not h.get('optional')}
            ctx.shared_data['expected_title_upgrade_ids'] = sorted(set(expected_ids) & known_online)
            return True, f"{msg}; 资源索引 {len(catalog_media)} 图片 SHA256 一致", import_res
        finally:
            cdp_opt.close()


class DeepScanPaginationCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_deep_scan_pagination",
            domain=FeatureDomain.TAKEOUT,
            name="会话同步分页覆盖",
            description="点击【同步会话】按钮，分页扫描网页端可访问会话并验证自然耗尽",
            critical=True,
            prerequisites=[],
            after=["feat_live_auto_save_disk_write"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            print("   🔄 触发【同步会话】(btnSyncAll)...")
            # Reset test scan boundaries and export history while retaining imported
            # Index/Detail for the title-upgrade assertion. This does not invoke
            # the user-facing full local-data reset.
            clear_scan_records(cdp_opt)
            evidence = CDPActions.trigger_deep_scan(cdp_opt, max_wait=330)
            scan_ok, message = assert_scan_result(evidence)
            if not scan_ok:
                return False, message, evidence
            # Verify results include the known freshly generated online sessions.
            ids = [r['chat_id'] for r in ctx.chat_records if r.get('chat_id')]
            if ids:
                known = [row['key']['conversationId'].removeprefix('c_') for row in snapshot(cdp_opt)['rows']
                         if row.get('titleSource') == 'provider' and row.get('title')]
                missing = [cid for cid in ids if cid.removeprefix('c_') not in known]
                if missing:
                    return False, f"全量扫描结果缺少已知在线会话: {missing}", evidence
            read_coverage = 'globalThis.__tier2V2.snapshot().then(state => state.coverage)'
            before = cdp_opt.eval(read_coverage, await_promise=True) or {}
            complete_ok, message = assert_full_scan_coverage(evidence, before)
            if not complete_ok:
                return False, message, {'scan': evidence, 'coverage': before}
            incremental = CDPActions.trigger_deep_scan(cdp_opt, max_wait=330)
            after = cdp_opt.eval(read_coverage, await_promise=True) or {}
            ok, closure_message = assert_followup_scan_result(incremental, before, after)
            result = {'initial': evidence, 'incremental': incremental, 'before': before, 'after': after}
            if not ok:
                return False, closure_message, result
            ctx.shared_data['deep_scan_evidence'] = evidence
            ctx.shared_data['incremental_scan_evidence'] = result
            return True, message + '; ' + closure_message, result
        finally:
            cdp_opt.close()


class AuthoritativeTitleUpgradeCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id="feat_authoritative_title_upgrade",
            domain=FeatureDomain.TAKEOUT,
            name="权威 RPC 标题覆盖晋级",
            description="全量拉取历史后，Takeout 临时标题被在线权威 RPC 标题平滑覆盖升级",
            critical=True,
            prerequisites=["feat_takeout_zip_import", "feat_deep_scan_pagination"]
        )

    def execute(self, ctx: TestContext) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        cdp_opt = ctx.connect_options()
        try:
            check_takeout_ids = ctx.shared_data.get('expected_title_upgrade_ids', [])
            if not check_takeout_ids:
                return False, "缺少已匹配的在线 Takeout 样本，无法验证权威标题晋级", None
            upg_ok, upg_msg, details = CDPAssertions.assert_title_upgraded(cdp_opt, check_takeout_ids)
            if upg_ok:
                return True, upg_msg, details
            return False, upg_msg, details
        finally:
            cdp_opt.close()
