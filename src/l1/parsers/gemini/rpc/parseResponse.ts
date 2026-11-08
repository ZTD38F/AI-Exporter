import { GeminiProtocol } from '../../../protocol/gemini/protocol.js';
import { GeminiResponseEnvelope } from './responseEnvelope.js';
import { parseList } from './parseList.js';
import { parseGeminiRpcConversation, type GeminiRpcParseContext } from './parseConversation.js';

/** Both active requests and passive captures enter through this transport boundary. */
export function parseGeminiResponse(text: string) {
    const response = new GeminiResponseEnvelope(text);
    return {
        list: () => parseList(response),
        detail: (context: GeminiRpcParseContext) => parseGeminiRpcConversation(response, context),
        hasList: response.rows(GeminiProtocol.RPCS.LIST).length > 0,
        hasDetail: response.rows(GeminiProtocol.RPCS.DETAIL).length > 0,
        envelope: response,
    };
}
