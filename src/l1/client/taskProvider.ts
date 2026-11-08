import { OperationError } from '../../shared/errors/operationError.js';
import type { AIProvider } from './aiProvider.js';
import type { SourceResourceContext } from '../resources/sourceResources.js';
import { ProviderRegistry } from './providerRegistry.js';
import { GeminiProvider } from './gemini/geminiProvider.js';
import { ChatGPTProvider } from './chatgpt/chatgptProvider.js';
import { GrokProvider } from './grok/grokProvider.js';
import { ClaudeProvider } from './claude/claudeProvider.js';

/** L1 owns platform-specific construction; Application owns the task lifetime. */
export function createTaskProvider(providerId: string, resources: SourceResourceContext): AIProvider {
    switch (providerId) {
        case 'gemini': return new GeminiProvider(undefined, undefined, resources);
        case 'chatgpt': return new ChatGPTProvider({ resources });
        case 'grok': return new GrokProvider({ resources });
        case 'claude': return new ClaudeProvider({ resources });
        default: {
            const provider = ProviderRegistry.get(providerId);
            if (!provider) throw new OperationError('ACCOUNT_UNAVAILABLE', 'Account provider unavailable');
            return provider;
        }
    }
}
