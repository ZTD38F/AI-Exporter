"""Gemini-specific additional check, downstream of the physical ZIP export."""
from pathlib import Path
from scripts.framework.cases.base import FeatureTestCase
from scripts.framework.features import FeatureDomain, TestStatus
from scripts.framework.gemini_dual_parse import run_check


class GeminiDualParseCase(FeatureTestCase):
    def __init__(self):
        super().__init__(
            feature_id='feat_gemini_dual_parse', domain=FeatureDomain.EXPORT_DISK,
            name='Gemini structured 与 Markdown 双路对比',
            description='非阻断审计：同一份原生 RPC 分别走两条解析路径，完整保留逐轮差异与来源证据',
            critical=False,
            prerequisites=['feat_zip_export_download'])

    def success_status(self, details):
        return TestStatus.WARN if details and details['counts']['different'] else TestStatus.PASS

    def execute(self, ctx):
        capture = ctx.shared_data.get('gemini_dual_capture')
        if not capture or not capture.get('expected') or capture.get('missingNative'):
            return False, '缺少实际导出目标的原生 RPC 证据', capture
        root = Path(ctx.output_dir) / 'gemini_dual_parse'
        passed, summary = run_check(ctx.worktree_root, root / 'native', root / 'report')
        captured_ids = [result.get('conversationId', '').removeprefix('c_') for result in summary['results']]
        coverage_matches = sorted(captured_ids) == sorted(capture['expected'])
        if not coverage_matches:
            summary['targetCoverageMismatch'] = {'expected': capture['expected'], 'captured': captured_ids}
        counts = summary['counts']
        # The user explicitly made representation equality informational.
        # Capture/decoder completeness remains a gate; no Markdown fallback,
        # missing turn or missing native source can become an audit warning.
        complete = (coverage_matches and counts['assistant'] > 0
                    and not any(counts.get(key, 0) for key in ('structuredUnavailable', 'errors', 'incomplete')))
        if not passed and not counts['different']:
            complete = False
        summary['equalityBlocking'] = False
        summary['gatePassed'] = complete
        message = (f"{counts['assistant']} 条回复：{counts['match']} 一致，"
                   f"{counts['different']} 差异，{counts['structuredUnavailable']} structured 不可用；"
                   f"{'差异仅供审计，不阻断；' if counts['different'] else ''}报告：{root / 'report/REPORT.md'}")
        return complete, message, summary
