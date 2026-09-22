import type { AIProvider, ProviderId } from "./aiProvider.js";

export class ProviderRegistryClass {
    private readonly providers = new Map<ProviderId, AIProvider>();
    private defaultProviderId: ProviderId | null = null;

    register(provider: AIProvider): void {
        if (!provider || !provider.id) {
            throw new Error("Invalid provider: id is required");
        }
        const existing = this.providers.get(provider.id);
        if (existing && existing !== provider) {
            throw new Error(`Provider "${provider.id}" is already registered`);
        }
        this.providers.set(provider.id, provider);
        if (!this.defaultProviderId) this.defaultProviderId = provider.id;
    }

    unregister(id: ProviderId): boolean {
        const removed = this.providers.delete(id);
        if (removed && this.defaultProviderId === id) {
            this.defaultProviderId = this.providers.keys().next().value ?? null;
        }
        return removed;
    }

    get(id: ProviderId): AIProvider | undefined {
        return this.providers.get(id);
    }

    require(id: ProviderId): AIProvider {
        const provider = this.get(id);
        if (!provider) throw new Error(`Provider "${id}" is not registered`);
        return provider;
    }

    getAll(): AIProvider[] {
        return [...this.providers.values()];
    }

    setDefaultProviderId(id: ProviderId): void {
        if (!this.providers.has(id)) {
            throw new Error(`Cannot set unregistered provider "${id}" as default`);
        }
        this.defaultProviderId = id;
    }

    getDefault(): AIProvider | undefined {
        return this.defaultProviderId ? this.providers.get(this.defaultProviderId) : undefined;
    }

    findByUrl(url: string): AIProvider | undefined {
        for (const provider of this.providers.values()) {
            if (provider.matchesUrl(url)) return provider;
        }
        return undefined;
    }

    clear(): void {
        this.providers.clear();
        this.defaultProviderId = null;
    }
}

export const ProviderRegistry = new ProviderRegistryClass();
export default ProviderRegistry;
