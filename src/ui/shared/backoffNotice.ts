import type { Diagnostic } from '../../shared/diagnostics/diagnostic.js';
import { text } from './settings.js';

/** Request-scoped waits may overlap: completing one must not hide another. */
export function createBackoffNotice() {
    const waits = new Map<string, number>();
    let cooldownUntil = 0;
    return {
        observe(diagnostic: Pick<Diagnostic, 'code' | 'details'>): void {
            if (!['CHATGPT_BACKOFF_WAIT', 'CHATGPT_BACKOFF_END', 'CHATGPT_RATE_LIMITED', 'CHATGPT_COOLDOWN_ACTIVE'].includes(diagnostic.code)) return;
            const details = diagnostic.details;
            if (!details || typeof details !== 'object' || Array.isArray(details)) return;
            // Export resource diagnostics retain the provider observation inside this envelope.
            const data = details.observation ?? details;
            if ((diagnostic.code === 'CHATGPT_RATE_LIMITED' || diagnostic.code === 'CHATGPT_COOLDOWN_ACTIVE')
                && data && typeof data === 'object' && !Array.isArray(data) && typeof data.retryAt === 'number') {
                cooldownUntil = Math.max(cooldownUntil, data.retryAt);
                return;
            }
            if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.requestId !== 'string') return;
            if (diagnostic.code === 'CHATGPT_BACKOFF_END') waits.delete(data.requestId);
            else if (typeof data.retryAt === 'number' && Number.isFinite(data.retryAt)) waits.set(data.requestId, data.retryAt);
        },
        message(): string | null {
            if (cooldownUntil > Date.now()) {
                const minutes = Math.ceil((cooldownUntil - Date.now()) / 60000);
                return text(`ChatGPT rate limited (429): export stopped; account cooling down for ${minutes} min. Retry manually later.`,
                    `ChatGPT 请求受限（429），本次导出已停止；账号冷却剩余 ${minutes} 分钟，请稍后手动重试`);
            }
            if (!waits.size) return null;
            const seconds = Math.max(0, Math.ceil((Math.max(...waits.values()) - Date.now()) / 1000));
            return text(`ChatGPT rate limited (429): backing off; retry in ${seconds}s`,
                `ChatGPT 请求受限（429），正在退避，${seconds} 秒后重试`);
        },
    };
}
