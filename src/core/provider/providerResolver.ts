import { ProviderRegistry } from "./providerRegistry.js";
import type { AIProvider } from "./aiProvider.js";
// Providers self-register into ProviderRegistry on module evaluation; these
// side-effect imports keep the registry populated without the barrel entry.
import "./gemini/geminiProvider.js";

export function resolveProvider(): AIProvider | undefined {
    const url = (typeof location !== "undefined" && location.href) || "";
    return ProviderRegistry.findByUrl(url) || ProviderRegistry.getDefault();
}
