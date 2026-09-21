/**
 * src/core/utils/messaging.ts
 * Type-safe Chrome runtime messaging utility and type guard helpers.
 */

import type { BaseMessage } from '../../types/messages.js';

/**
 * Safely extracts error message string from an unknown caught exception.
 */
export function getErrorMessage(err: unknown): string {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.message;
    if (typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
        return (err as any).message;
    }
    return String(err);
}

/**
 * Sends a strongly-typed message via chrome.runtime.sendMessage with Promise resolution and error wrapping.
 */
export async function sendTypedMessage<T extends BaseMessage, R = any>(
    message: T,
    timeoutMs: number = 10000
): Promise<R> {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        throw new Error('Chrome runtime messaging is not available in current execution context');
    }

    return new Promise<R>((resolve, reject) => {
        let timer: any = null;
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                reject(new Error(`sendTypedMessage timeout after ${timeoutMs}ms for action "${message.action}"`));
            }, timeoutMs);
        }

        try {
            chrome.runtime.sendMessage(message, (response: any) => {
                if (timer) clearTimeout(timer);
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || `Runtime error in action "${message.action}"`));
                    return;
                }
                resolve(response as R);
            });
        } catch (err: unknown) {
            if (timer) clearTimeout(timer);
            reject(new Error(getErrorMessage(err)));
        }
    });
}

/**
 * Type guard for verifying whether an incoming message matches a specific action.
 */
export function isMessageAction<T extends BaseMessage>(msg: unknown, action: T['action']): msg is T {
    return (
        typeof msg === 'object' &&
        msg !== null &&
        'action' in msg &&
        (msg as BaseMessage).action === action
    );
}

export default {
    getErrorMessage,
    sendTypedMessage,
    isMessageAction
};
