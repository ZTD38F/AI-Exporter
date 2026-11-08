# Module unit-test isolation

Current source owners are L1, L2, L3a, L3b, L4, Application, Runtime, UI, Migration and Shared. A **module unit test** executes real code owned by one module; an **integration test** intentionally crosses real module boundaries. The ordinary Tier 1 suite contains both.

## Rules

1. Import the real implementation of the owner being tested. Replace calls into other owners with test doubles conforming to the **current exported TypeScript contract** (`import type`, `typeof import(...)`, `satisfies`), not a newly invented backward-compatible Facade.
2. Keep mocks at the boundary: provide scripted facts or record decisions, rather than reproducing IndexedDB transaction logic, parser logic, AST composition, browser routing or rendering from another module.
3. Shared pure utilities may be used by multiple owners. Tests exercising multiple real modules belong to integration suites and remain part of regression coverage.
4. `tests/helpers/v2UnitRealModuleGuard.cjs` guards against another owner's implementation being compiled into an isolated module test. A green ordinary `npm run test:unit` is **not** evidence of module isolation.
5. A test of released v1/v1.7 migration is a real migration regression, not permission to restore a v1 production API. Preserve `tests/upgrade_v1.test.cjs` and its Tier 1 wrapper.

## Commands

```sh
npm run test:v2:unit-ports
npm run test:v2:unit-isolation
node scripts/test-v2-unit-isolation.cjs l2 migration
npm test
```

The port gate checks mock and owner interface types. The isolation gate checks the compiled real-module boundary. `npm test` additionally checks TypeScript, the mixed unit/integration regressions, production bundling and Playwright browser behavior. None of these replaces authenticated live Tier 2.

See [tests/README.md](../tests/README.md) for test entrypoints and [source architecture](../src/README.md) for ownership.
