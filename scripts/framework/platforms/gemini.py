"""Gemini cases and environment adapter; scheduling lives in platforms.core."""
from .core import PlatformSession, feature_spec


class GeminiPlugin:
    id = 'gemini'
    capabilities = ('chat', 'scan', 'live_save', 'promotion', 'deletion', 'export',
                    'images', 'workbench', 'takeout', 'dual_parse', 'onboarding')
    accepted_options = ('takeout_zip',)

    def features(self):
        from .gemini_runtime import GeminiRuntime
        return [feature_spec(case) for case in GeminiRuntime._assemble_dag().get_execution_order()]

    def open(self, config):
        from .gemini_runtime import GeminiRuntime
        runtime = GeminiRuntime(port=config.port, output_dir=config.output_dir,
            dataset=config.dataset, delay=config.delay, target_features=config.target_features,
            domain=config.domain, takeout_zip=config.options.get('takeout_zip'))
        return self.session(runtime)

    @staticmethod
    def session(runtime):
        def close():
            try:
                runtime.tracker.teardown()
            finally:
                if runtime.environment_context:
                    runtime.ctx.env.teardown(runtime.environment_context.active_cdp)
        return PlatformSession(runtime.dag, runtime.ctx, runtime.prepare,
                               close, target_ids=runtime.target_ids)
