import { parseGeminiCapturedSource } from '../../parsers/gemini/capturedSource.js';
import { GeminiCaptureReceiver, type GeminiCaptureCallbacks } from './captureReceiver.js';
import { registerCleanup } from '../../../runtime/content/cleanupRegistry.js';
import { isDevMode } from '../../../runtime/devMode.js';

let receiver: GeminiCaptureReceiver | null = null;
let listening = false;
// A barrier for captures already received; never an independent task executor.
const pendingAdmissions = new Set<Promise<void>>();
export function init(dependencies: GeminiCaptureCallbacks = {}) {
    receiver = new GeminiCaptureReceiver(dependencies);
    if (!listening) {
        window.addEventListener('message', receiveWindowMessage);
        listening = true;
        registerCleanup(() => {
            window.removeEventListener('message', receiveWindowMessage);
            listening = false; receiver = null; pendingAdmissions.clear();
        });
    }
    return { handleWindowMessage };
}
function receiveWindowMessage(event: MessageEvent<unknown>): void { void handleWindowMessage(event).catch(() => {}); }
export async function handleWindowMessage(event: MessageEvent<unknown>): Promise<void> {
    const capturedReceiver = receiver;
    if (!capturedReceiver || !event || event.source !== window
        || (typeof location !== 'undefined' && event.origin !== location.origin)) return;
    try {
        const capture = parseGeminiCapturedSource(event.data);
        if (!capture) return;
        const operation = capturedReceiver.receive(capture, [...pendingAdmissions], () => receiver === capturedReceiver);
        if (capture.kind === 'network') {
            pendingAdmissions.add(operation);
            void operation.finally(() => pendingAdmissions.delete(operation)).catch(() => {});
        }
        await operation;
    } catch (error) {
        if (isDevMode()) console.debug('[MessageBridge] source capture failed', error);
        throw error;
    }
}
export const MessageBridge = { init, handleWindowMessage };
