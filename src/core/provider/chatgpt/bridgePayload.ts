export const MAX_CHATGPT_DETAIL_MESSAGE_BYTES = 16 * 1024 * 1024;

export class ChatGPTBridgePayloadError extends Error {
    readonly code: string;
    readonly byteLength?: number;

    constructor(code: string, message: string, byteLength?: number) {
        super(message);
        this.name = "ChatGPTBridgePayloadError";
        this.code = code;
        this.byteLength = byteLength;
    }
}

export function chatGPTDetailMessageByteLength(raw: any): number {
    let serialized: string;
    try {
        serialized = JSON.stringify(raw);
    } catch {
        throw new ChatGPTBridgePayloadError(
            "DETAIL_SERIALIZATION_FAILED",
            "ChatGPT conversation detail could not be serialized safely"
        );
    }
    if (typeof serialized !== "string") {
        throw new ChatGPTBridgePayloadError(
            "DETAIL_SERIALIZATION_FAILED",
            "ChatGPT conversation detail could not be serialized safely"
        );
    }
    return new TextEncoder().encode(serialized).byteLength;
}

export function assertChatGPTDetailMessageSize(
    raw: any,
    maxBytes: number = MAX_CHATGPT_DETAIL_MESSAGE_BYTES
): number {
    const encodedBytes = chatGPTDetailMessageByteLength(raw);
    if (encodedBytes > maxBytes) {
        throw new ChatGPTBridgePayloadError(
            "DETAIL_TOO_LARGE_FOR_MESSAGE",
            `ChatGPT conversation detail is too large for the current extension message bridge (${encodedBytes} bytes > ${maxBytes})`,
            encodedBytes
        );
    }
    return encodedBytes;
}
