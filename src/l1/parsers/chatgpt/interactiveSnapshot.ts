import { renderDil } from './dil/render.js';

interface ChatGPTInteractiveSnapshot {
    text: string;
    /** Static textual content coverage; this never claims executable UI fidelity. */
    incomplete: boolean;
    representation: 'provider-fallback' | 'source-text' | 'structured-source' | 'unavailable';
    interactive: boolean;
    modules: string[];
    fallbackBlocks: number;
    unsupported: string[];
}

/** Parse source components in place. Provider Markdown is a fallback for
 * unsupported blocks or a source/fallback disagreement, not the default body. */
export function chatGPTInteractiveSnapshot(raw: string, fallback?: string): ChatGPTInteractiveSnapshot {
    const base: Pick<ChatGPTInteractiveSnapshot, 'modules' | 'fallbackBlocks' | 'unsupported'> =
        { modules: [], fallbackBlocks: 0, unsupported: [] };
    if (!raw.trim()) return fallback?.trim()
        ? { ...base, text: fallback, incomplete: false, representation: 'provider-fallback', interactive: false, fallbackBlocks: 1 }
        : { ...base, text: '> Interactive content unavailable: no static source or Markdown fallback was provided.',
            incomplete: true, representation: 'unavailable', interactive: true };
    const result = renderDil(raw, fallback);
    const interactive = result.modules.some(name => ['bindings', 'each', 'if', 'radio', 'radio-group', 'checkbox', 'button', 'select', 'input'].includes(name));
    return { ...result, interactive,
        representation: result.fallbackBlocks ? 'provider-fallback' : result.modules.length ? 'structured-source' : 'source-text' };
}
