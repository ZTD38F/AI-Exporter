import { ProviderRegistry } from '../providerRegistry.js';
import { GrokProvider } from './grokProvider.js';
import { hasGrokAccess } from './grokSource.js';
export { hasGrokAccess, readGrokSource } from './grokSource.js';
export async function ensureGrokRegistered(): Promise<boolean> {
    if (!await hasGrokAccess()) return false;
    if (!ProviderRegistry.get('grok')) ProviderRegistry.register(new GrokProvider());
    return true;
}
