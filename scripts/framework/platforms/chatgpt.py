"""ChatGPT operation adapters; all dispatch/dependency handling uses the shared DAG."""
from .core import feature_spec
from scripts.framework.scheduler import DAGRunner, FeatureTestCase
from scripts.framework.features import FeatureDomain


class ChatGPTCase(FeatureTestCase):
    def __init__(self, name, method, domain, prerequisites=(), evidence=()):
        super().__init__(name, domain, name.replace('_', ' '),
                         'Live browser and physical export evidence: '+name,
                         prerequisites=list(prerequisites))
        self.method, self.evidence = method, evidence

    def execute(self, ctx):
        runtime = ctx.runtime
        if self.method == 'assert_full_exports':
            from scripts.framework.chatgpt_evidence import assert_full_exports
            operation = lambda: assert_full_exports(runtime.root, runtime.output, runtime.chat_ids, image_cdp=runtime.options)
        else:
            operation = getattr(runtime, self.method)
        def verify():
            detail = operation()
            missing = [key for key in self.evidence
                       if runtime.report['gates'].get(key, {}).get('status') != 'passed']
            if missing:
                raise ValueError(f'Missing mandatory evidence: {missing}')
            return detail
        detail = runtime.gate(self.feature_id, verify)
        if self.method == 'sync':
            ctx.search_keyword = runtime.report['scan'][0]['title']
        return True, 'Physical evidence verified', {'evidence': detail}



def build_dag():
    dag = DAGRunner()
    stages = [
        ('page_badge', 'page_badge', FeatureDomain.PAGE_CHAT, (), ()),
        ('passive_sidebar', 'passive_sidebar', FeatureDomain.WORKBENCH, ('page_badge',), ()),
        ('complex_multiturn', 'generate', FeatureDomain.PAGE_CHAT, ('passive_sidebar',), ()),
        ('independent_golden_capture', 'capture_golden', FeatureDomain.PAGE_CHAT,
         ('complex_multiturn',), ()),
        ('scan', 'sync', FeatureDomain.WORKBENCH, ('independent_golden_capture',), ()),
        ('initial_export_baseline', 'initial_export', FeatureDomain.EXPORT_DISK,
         ('feat_search_clear_restore', 'feat_selection_controls', 'feat_language_toggle'), ()),
        ('account_boundary', 'account_boundary', FeatureDomain.LIFECYCLE, ('initial_export_baseline',), ()),
        ('passive_lifecycle', 'lifecycle', FeatureDomain.LIFECYCLE, ('initial_export_baseline', 'account_boundary'),
         ('live_disk_save', 'passive_promotion', 'export_record_advancement')),
        ('confirmed_deletion', 'confirmed_deletion', FeatureDomain.LIFECYCLE,
         ('passive_lifecycle',), ()),
        ('physical_four_format_export', 'exports', FeatureDomain.EXPORT_DISK,
         ('confirmed_deletion',), ()),
        ('full_reply_fidelity', 'assert_full_exports', FeatureDomain.EXPORT_DISK,
         ('physical_four_format_export',), ()),
        ('golden_physical_exports', 'golden_exports', FeatureDomain.EXPORT_DISK,
         ('physical_four_format_export',), ('image_pixels', 'questionnaires')),
        ('popup_export', 'popup_export', FeatureDomain.EXPORT_DISK,
         ('full_reply_fidelity', 'golden_physical_exports'), ()),
        ('fast_skip', 'fast_skip', FeatureDomain.EXPORT_DISK, ('popup_export',), ()),
        ('stale_tab_images', 'stale_tab_images', FeatureDomain.EXPORT_DISK, ('fast_skip',), ()),
        ('explicit_cleanup', 'cleanup_records', FeatureDomain.LIFECYCLE, ('stale_tab_images',), ()),
        ('uninstall_lifecycle', 'uninstall_lifecycle', FeatureDomain.LIFECYCLE, ('explicit_cleanup',), ()),
    ]
    for args in stages:
        dag.register(ChatGPTCase(*args))
    from scripts.framework.cases.workbench import (
        SearchKeywordCase, SearchIdCase, SearchClearCase, SelectionControlsCase, LanguageToggleCase,
    )
    dag.register(SearchKeywordCase(prerequisites=['scan']))
    dag.register(SearchIdCase(prerequisites=['feat_search_filter_by_keyword']))
    dag.register(SearchClearCase(prerequisites=['feat_search_filter_by_id']))
    dag.register(SelectionControlsCase(prerequisites=['feat_search_clear_restore']))
    dag.register(LanguageToggleCase(prerequisites=['feat_selection_controls']))
    return dag


class ChatGPTPlugin:
    id = 'chatgpt'
    capabilities = ('chat', 'scan', 'live_save', 'promotion', 'deletion', 'export',
                    'images', 'questionnaires', 'popup', 'workbench', 'onboarding', 'cleanup', 'installation')
    accepted_options = ()

    def features(self):
        return [feature_spec(case) for case in build_dag().get_execution_order()]

    def open(self, config):
        from scripts.framework.chatgpt_live import ChatGPTLiveRunner
        runtime = ChatGPTLiveRunner(port=config.port, output_dir=config.output_dir,
            dataset=config.dataset, delay=config.delay)
        return self.session(runtime, config.target_features, config.domain)

    @staticmethod
    def session(runtime, target_features=None, domain=None):
        from .browser import browser_session
        return browser_session(runtime, 'chatgpt', build_dag, target_features, domain)
