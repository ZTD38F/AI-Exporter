"""Platform-neutral Tier 2 orchestration. Plugins supply cases and browser hooks.

No provider-specific imports, selectors, URLs or acceptance branches belong here.
The same DAG executor handles every registered platform, including external ones.
"""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional, Protocol
import json
import re
import time
import traceback

from scripts.framework.scheduler import DAGRunner
from scripts.framework.features import TestStatus


@dataclass(frozen=True)
class RunConfig:
    port: int = 9222
    output_dir: Optional[str] = None
    dataset: object = None
    delay: int = 6
    target_features: Optional[str] = None
    domain: Optional[str] = None
    options: dict = field(default_factory=dict)


@dataclass
class PlatformSession:
    dag: DAGRunner
    context: object
    prepare: Callable
    close: Callable
    finalize: Callable = lambda: None
    target_ids: Optional[list] = None


class PlatformPlugin(Protocol):
    id: str
    capabilities: tuple
    accepted_options: tuple

    def features(self) -> list: ...
    def open(self, config: RunConfig) -> PlatformSession: ...


class PlatformPlugins:
    """Explicit registration; importing a new plugin never changes the runner."""
    def __init__(self):
        self._plugins = {}

    def register(self, plugin: PlatformPlugin):
        if not re.fullmatch(r'[a-z][a-z0-9_-]*', plugin.id):
            raise ValueError(f'Invalid platform id: {plugin.id}')
        if plugin.id in self._plugins:
            raise ValueError(f'Duplicate platform: {plugin.id}')
        self._plugins[plugin.id] = plugin

    def select(self, names):
        tokens = [part.strip() for name in names for part in name.split(',')]
        if not tokens or any(not token for token in tokens):
            raise ValueError('Select at least one platform')
        if 'all' in tokens:
            if tokens != ['all']:
                raise ValueError('Use all alone')
            tokens = list(self._plugins)
        unknown = set(tokens) - self._plugins.keys()
        if unknown:
            raise ValueError(f'Unknown platforms: {sorted(unknown)}; available: {list(self._plugins)}')
        return [self._plugins[name] for name in dict.fromkeys(tokens)]


def feature_spec(case):
    return {'id': case.feature_id, 'name': case.name, 'domain': case.domain.name,
            'critical': case.critical, 'prerequisites': case.prerequisites,
            'description': case.description, 'after': case.after}


def run_session(session, report, persist=lambda: None):
    """One lifecycle for every plugin; errors and missing dependencies block success."""
    diagnostics = None
    tab_scope = None
    port = getattr(session.context, 'port', None)
    output_dir = getattr(session.context, 'output_dir', None)
    if output_dir is None:
        runtime = getattr(session.context, 'runtime', None)
        output_dir = getattr(runtime, 'output_dir', None) or getattr(runtime, 'output', None)
    try:
        if port is not None and output_dir is not None:
            from scripts.framework.tab_cleanup import TestTabScope
            tab_scope = TestTabScope(port)
            from scripts.chrome_diagnostics import BrowserDiagnostics
            diagnostics = BrowserDiagnostics(port, output_dir)
            session.context.browser_checkpoint = diagnostics.checkpoint
            diagnostics.start()
        if 'plan' in report:
            actual = {key: feature_spec(case) for key, case in session.dag.cases.items()}
            declared = {spec['id']: spec for spec in report['plan']}
            if actual.keys() != declared.keys() or any(
                set(actual[key][field]) != set(declared[key].get(field, []))
                for key in actual for field in ('prerequisites', 'after')
            ):
                raise ValueError('Plugin runtime cases differ from its declared plan')
        for case in session.dag.cases.values():
            session.context.registry.register(case.to_feature())
            session.context.registry.record_result(case.feature_id, TestStatus.PENDING,
                                                   message='Environment not yet prepared')
        if session.prepare() is False:
            raise RuntimeError('Platform environment preparation failed')
        report['prepared'] = True
        persist()
        passed = session.dag.run(session.context, target_ids=session.target_ids)
        if diagnostics:
            diagnostics.checkpoint('finalization')
        report['passed'] = passed
    except Exception as error:
        report.update(passed=False, error=str(error), traceback=traceback.format_exc())
    finally:
        try:
            session.finalize()
        except Exception as error:
            report.update(passed=False, finalization_error=str(error))
        report['features'] = [
            {'id': key, 'status': result.status.value, 'message': result.message,
             'duration_seconds': result.duration_seconds, 'details': result.details}
            for key, result in session.context.registry.results.items()
        ]
        try:
            session.close()
        except Exception as error:
            report.update(passed=False, cleanup_error=str(error))
        if tab_scope:
            try:
                runtime = getattr(session.context, 'runtime', None)
                ext_id = getattr(session.context, 'ext_id', None) or getattr(runtime, 'ext_id', None)
                tab_scope.close(ext_id)
            except Exception as error:
                report.update(passed=False, tab_cleanup_error=str(error))
        if diagnostics:
            try:
                try:
                    diagnostics.check()
                except RuntimeError:
                    pass
                report['chrome_diagnostics'] = diagnostics.finish()
                if diagnostics.failure:
                    report.update(passed=False, error=diagnostics.failure)
                    print(f'❌ {diagnostics.failure}; evidence: {diagnostics.output}')
            except Exception as error:
                report.update(passed=False, diagnostics_error=str(error))
        persist()
    return report['passed']


def resolve_plan(specs, targets=None, domain=None):
    """Validate plugin declarations and calculate the dependency closure offline."""
    by_id = {spec['id']: spec for spec in specs}
    if not by_id or len(by_id) != len(specs):
        raise ValueError('Plugin must declare a nonempty set of unique features')
    visited, visiting, ordered = set(), set(), []

    def visit(key):
        if key not in by_id:
            raise ValueError(f'Undeclared prerequisite: {key}')
        if key in visiting:
            raise ValueError(f'Cyclic feature dependency: {key}')
        if key in visited:
            return
        visiting.add(key)
        for parent in by_id[key]['prerequisites'] + by_id[key].get('after', []):
            visit(parent)
        visiting.remove(key)
        visited.add(key)
        ordered.append(key)

    for key in by_id:
        visit(key)
    selected = set(targets.split(',')) if targets else set()
    if selected - by_id.keys():
        raise ValueError(f'Unknown features: {sorted(selected - by_id.keys())}')
    if domain:
        matching = {key for key, spec in by_id.items() if spec['domain'].lower() == domain}
        if not matching:
            raise ValueError(f'Unsupported domain: {domain}')
        selected.update(matching)
    if not selected:
        selected = set(by_id)
    active = set()

    def include(key):
        if key in active:
            return
        active.add(key)
        for parent in by_id[key]['prerequisites']:
            include(parent)

    for key in selected:
        include(key)
    return [{**by_id[key], 'scheduled': key in active} for key in ordered]


class Tier2Runner:
    """Serialize platforms on a shared Chrome profile and isolate their artifacts."""
    def __init__(self, plugins, config: RunConfig):
        if not plugins:
            raise ValueError('Select at least one platform')
        if len({plugin.id for plugin in plugins}) != len(plugins):
            raise ValueError('Duplicate platform selection')
        self.plugins, self.config = plugins, config
        self.output = Path(config.output_dir or 'tests/output/tier2').resolve()
        self.report = {'passed': False, 'scope': 'targeted' if config.target_features or config.domain else 'full',
                       'platforms': {}}
        # Preflight ALL plans before any browser mutation or scenario consumption.
        unknown_options = set(config.options) - {p.id for p in plugins}
        if unknown_options:
            raise ValueError(f'Options target unselected platforms: {sorted(unknown_options)}')
        self.plans = {}
        for plugin in plugins:
            unsupported = set(config.options.get(plugin.id, {})) - set(plugin.accepted_options)
            if unsupported:
                raise ValueError(f'{plugin.id}: unsupported options {sorted(unsupported)}')
            try:
                self.plans[plugin.id] = resolve_plan(plugin.features(), config.target_features, config.domain)
            except ValueError as error:
                raise ValueError(f'{plugin.id}: {error}') from error

    def plan(self):
        return {plugin.id: {'capabilities': list(plugin.capabilities),
                            'features': self.plans[plugin.id]}
                for plugin in self.plugins}

    def save(self):
        self.output.mkdir(parents=True, exist_ok=True)
        target = self.output/'tier2-report.json'
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(target)

    def run(self):
        from dataclasses import replace
        self.report['passed'] = False
        self.report['platforms'] = {
            plugin.id: {'passed': False, 'status': 'pending', 'capabilities': list(plugin.capabilities),
                        'plan': self.plans[plugin.id]}
            for plugin in self.plugins
        }
        self.save()
        for plugin in self.plugins:
            report = self.report['platforms'][plugin.id]
            started = time.monotonic()
            report['status'] = 'running'
            self.save()
            try:
                config = replace(self.config, output_dir=str(self.output/plugin.id),
                                 options=self.config.options.get(plugin.id, {}))
                session = plugin.open(config)
                # Selection is owned by the framework, not individual plugins.
                session.target_ids = ([spec['id'] for spec in self.plans[plugin.id] if spec['scheduled']]
                                      if config.target_features or config.domain else None)
                run_session(session, report, self.save)
            except Exception as error:
                report.update(passed=False, error=str(error), traceback=traceback.format_exc())
            report.update(status='passed' if report['passed'] else 'failed',
                          duration_seconds=time.monotonic()-started)
            self.save()
        self.report['passed'] = all(p['passed'] for p in self.report['platforms'].values())
        self.save()
        return self.report['passed']
