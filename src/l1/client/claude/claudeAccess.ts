import { ProviderRegistry } from '../providerRegistry.js';
import { ClaudeProvider } from './claudeProvider.js';
import { hasClaudeAccess } from './claudeSource.js';

export { hasClaudeAccess, readClaudeSource } from './claudeSource.js';

/** Register only after the user grants Claude's optional host permission. */
export async function ensureClaudeRegistered(): Promise<boolean> {
    if (!await hasClaudeAccess()) return false;
    if (!ProviderRegistry.get('claude')) ProviderRegistry.register(new ClaudeProvider());
    return true;
}
