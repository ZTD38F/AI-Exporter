/** Evidence describes the returned payload, not whether its endpoint was tested live. */
export type FixtureOrigin =
    | { readonly kind: 'synthetic'; readonly purpose: string }
    | { readonly kind: 'captured'; readonly source: string; readonly unit: string }
    | { readonly kind: 'derived'; readonly sources: readonly [string, ...string[]]; readonly changes: string };

export const synthetic = (purpose: string): FixtureOrigin => ({ kind: 'synthetic', purpose });
export const captured = (source: string, unit: string): FixtureOrigin => ({ kind: 'captured', source, unit });
export const derived = (sources: readonly [string, ...string[]], changes: string): FixtureOrigin =>
    ({ kind: 'derived', sources, changes });

/** Enumerates keys only; factories are never invoked to inspect or classify their output. */
export function describeFixtures<K extends string>(
    cases: Readonly<Record<K, unknown>>,
    fallback: FixtureOrigin,
    overrides?: Readonly<Partial<Record<K, FixtureOrigin>>>,
): Array<{ key: string; origin: FixtureOrigin }> {
    const entries: Array<[string, FixtureOrigin | undefined]> = Object.entries(overrides ?? {});
    const origins = new Map(entries);
    return Object.keys(cases).map(key => ({ key, origin: origins.get(key) ?? fallback }));
}
