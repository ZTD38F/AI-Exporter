import { hasPlatformAccess } from '../platformAccess.js';
/**
 * Optional-host entry point for ChatGPT runtime access.
 *
 * The manifest declares ChatGPT origins as `optional_host_permissions` only,
 * so updates never prompt or disable existing users. Nothing here runs on its
 * own: Options requests access through the shared platform-authorization dialog.
 * Account discovery registers the provider only after the user grants access.
 */
import { ProviderRegistry } from '../providerRegistry.js';
import { ChatGPTProvider } from './chatgptProvider.js';

export function hasChatGPTAccess(): Promise<boolean> { return hasPlatformAccess('chatgpt'); }

/**
 * Register the ChatGPT adapter exactly when access is granted. Idempotent and
 * inert otherwise: without a grant the registry (and every Gemini flow built
 * on it) is untouched.
 */
export async function ensureChatGPTRegistered(): Promise<boolean> {
    if (!(await hasChatGPTAccess())) return false;
    if (!ProviderRegistry.get('chatgpt')) {
        ProviderRegistry.register(new ChatGPTProvider());
    }
    return true;
}
