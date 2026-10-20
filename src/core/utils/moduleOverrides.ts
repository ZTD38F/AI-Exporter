/**
 * Test seam for module resolution. Replaces fragile globalThis mocking where
 * transitively requiring modules re-ran registrations and clobbered mocks.
 */

const isProduction = (): boolean =>
    typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';

const overrides = new Map<string, any>();

export function __setModuleOverride<T = any>(name: string, impl: T | undefined): void {
    if (isProduction()) return;
    if (impl === undefined) overrides.delete(name);
    else overrides.set(name, impl);
}

export function __clearModuleOverrides(): void {
    if (isProduction()) return;
    overrides.clear();
}

export function __getModuleOverride<T = any>(name: string): T | undefined {
    if (isProduction()) return undefined;
    return overrides.get(name);
}

export function __resolveModule(name: string, fallback: null | undefined): any;
export function __resolveModule<T>(name: string, fallback: T): T;
export function __resolveModule(name: string, fallback?: any): any {
    if (isProduction()) return fallback;
    const o = overrides.get(name);
    return o !== undefined ? o : fallback;
}

