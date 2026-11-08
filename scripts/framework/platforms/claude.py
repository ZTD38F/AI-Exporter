"""Claude's live acceptance plan, scheduled by the platform-independent framework."""
from .core import feature_spec
from .browser import browser_session
from scripts.framework.scheduler import DAGRunner, FeatureTestCase
from scripts.framework.features import FeatureDomain


class ClaudeCase(FeatureTestCase):
    def __init__(self, name, method, domain, prerequisites=(), after=(), evidence=()):
        super().__init__(name, domain, name.replace('_', ' '),
                         'Real Claude page and physical disk evidence: '+name,
                         prerequisites=list(prerequisites), after=list(after))
        self.method, self.evidence = method, evidence

    def execute(self, ctx):
        def operation():
            detail = getattr(ctx.runtime, self.method)()
            missing = [key for key in self.evidence if ctx.runtime.report['gates'].get(key, {}).get('status') != 'passed']
            if missing:
                raise ValueError(f'Missing mandatory evidence: {missing}')
            return detail
        detail = ctx.runtime.gate(self.feature_id, operation)
        if self.method == 'sync':
            ctx.search_keyword = detail[0]['title']
        return True, 'Physical evidence verified', {'evidence': detail}


def build_dag():
    dag = DAGRunner()
    P, W, E, L = FeatureDomain.PAGE_CHAT, FeatureDomain.WORKBENCH, FeatureDomain.EXPORT_DISK, FeatureDomain.LIFECYCLE
    # Ordering-only edges keep unsupported passive/coverage features from hiding
    # independent generation/export failures. They remain mandatory full-run gates.
    stages = [
        ('page_badge', 'page_badge', P, (), ()),
        ('passive_sidebar', 'passive_sidebar', W, (), ('page_badge',)),
        ('complex_multiturn', 'generate', P, (), ('passive_sidebar',)),
        ('independent_golden_capture', 'capture_golden', P, ('complex_multiturn',), ()),
        ('scan', 'sync', W, ('complex_multiturn',), ('independent_golden_capture',)),
        ('scan_coverage', 'scan_coverage', W, ('scan',), ()),
        ('physical_four_format_export', 'physical_exports', E, ('scan',),
         ('scan_coverage', 'feat_language_toggle')),
        ('full_reply_fidelity', 'assert_full_exports', E, ('physical_four_format_export',), ()),
        ('golden_physical_exports', 'golden_exports', E, ('physical_four_format_export', 'independent_golden_capture'), ()),
        ('account_boundary', 'account_boundary', L, ('physical_four_format_export',), ()),
        ('initial_export_baseline', 'initial_export', E, ('physical_four_format_export',), ('account_boundary',)),
        ('passive_lifecycle', 'lifecycle', L, ('initial_export_baseline',), ('golden_physical_exports', 'full_reply_fidelity'),
         ('live_disk_save', 'passive_promotion', 'export_record_advancement')),
        ('confirmed_deletion', 'confirmed_deletion', L, ('passive_lifecycle',), ()),
        ('popup_export', 'popup_export', E, ('full_reply_fidelity',), ('confirmed_deletion',)),
        ('fast_skip', 'fast_skip', E, ('physical_four_format_export',), ('popup_export',)),
        ('explicit_cleanup', 'cleanup_records', L, ('scan',), ('fast_skip',)),
        ('uninstall_lifecycle', 'uninstall_lifecycle', L, (), ('explicit_cleanup',)),
    ]
    for args in stages:
        dag.register(ClaudeCase(*args))
    from scripts.framework.cases.workbench import SearchKeywordCase, SearchIdCase, SearchClearCase, SelectionControlsCase, LanguageToggleCase
    dag.register(SearchKeywordCase(prerequisites=['scan']))
    dag.register(SearchIdCase(prerequisites=['feat_search_filter_by_keyword']))
    dag.register(SearchClearCase(prerequisites=['feat_search_filter_by_id']))
    dag.register(SelectionControlsCase(prerequisites=['feat_search_clear_restore']))
    dag.register(LanguageToggleCase(prerequisites=['feat_selection_controls']))
    return dag


class ClaudePlugin:
    id = 'claude'
    capabilities = ('chat', 'scan', 'live_save', 'promotion', 'deletion', 'export', 'questionnaires',
                    'artifacts', 'popup', 'workbench', 'onboarding', 'cleanup', 'installation')
    accepted_options = ('golden',)

    def features(self):
        return [feature_spec(c) for c in build_dag().get_execution_order()]

    def open(self, config):
        from scripts.framework.claude_live import ClaudeLiveRunner
        runtime = ClaudeLiveRunner(port=config.port, output_dir=config.output_dir, dataset=config.dataset,
                                   delay=config.delay, options=config.options)
        return browser_session(runtime, self.id, build_dag, config.target_features, config.domain)
