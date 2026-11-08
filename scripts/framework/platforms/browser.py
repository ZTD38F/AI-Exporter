"""Shared browser plugin lifecycle, report finalization and resource cleanup."""
from types import SimpleNamespace
from .core import PlatformSession
from scripts.framework.features import FeatureRegistry


def browser_session(runtime, platform_id, dag_factory, target_features=None, domain=None):
    dag = dag_factory()
    targets = set(target_features.split(',')) if target_features else set()
    if domain:
        targets.update(case.feature_id for case in dag.cases.values()
                       if case.domain.name.lower() == domain)
    ctx = SimpleNamespace(runtime=runtime, registry=FeatureRegistry(standard=False),
                          platform_id=platform_id, port=runtime.port, shared_data={},
                          connect_options=runtime.fresh_options)

    def prepare():
        detail = runtime.gate('connection', runtime.prepare)
        ctx.ext_id = runtime.ext_id
        return detail

    def finalize():
        # Mirror the shared DAG, including failed and blocked cases, into the
        # legacy evidence report; nested physical evidence remains intact.
        for key, result in ctx.registry.results.items():
            if result.status.value not in ('PASS', 'WARN'):
                runtime.report['gates'][key] = {'status': result.status.value.lower(),
                                              'error': result.message}
        # DAG outcome, including blocked dependencies, is authoritative.
        expected = set(dag.get_ancestors(list(targets))) if targets else set(dag.cases)
        results = ctx.registry.results
        runtime.report['passed'] = (
            runtime.report['gates'].get('connection', {}).get('status') == 'passed'
            and bool(expected) and all(key in results and results[key].status.value in ('PASS', 'WARN')
                                      for key in expected))
        runtime.save_report()

    def close():
        errors = []
        for connection in (runtime.options, runtime.chat, runtime.browser):
            if connection:
                try:
                    connection.close()
                except Exception as error:
                    errors.append(str(error))
        if errors:
            raise RuntimeError('; '.join(errors))

    return PlatformSession(dag, ctx,
        prepare, close, finalize,
        list(targets) if targets else None)
