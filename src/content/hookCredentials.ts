// src/content/hookCredentials.ts - MAIN world, captures Gemini credentials safely (no inline)
import { GeminiProtocol, CrossWorldEvents } from '../core/protocol/protocol.js';

(() => {
    if (typeof window === 'undefined') return;

    // Protocol anti-corruption layer: globalThis / window fallback
    const Proto = typeof GeminiProtocol !== 'undefined' ? GeminiProtocol : ((window as any).GeminiProtocol || null);
    if (!Proto) {
        console.error('[HookCred] GeminiProtocol missing — check manifest content_scripts load order');
        return;
    }
    const Events = (Proto && (Proto.EVENTS || Proto.CrossWorldEvents)) || (typeof CrossWorldEvents !== 'undefined' ? CrossWorldEvents : ((window as any).CrossWorldEvents || (window as any).GeminiProtocol?.EVENTS));

    const origFetch = window.fetch;
    const origOpen = (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) ? XMLHttpRequest.prototype.open : null;
    const origSend = (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) ? XMLHttpRequest.prototype.send : null;

    function isDev(): boolean {
        return typeof window !== 'undefined' && !!(window as any).__gemExporterDevMode;
    }

    function captureFromUrl(url: any, body: any): void {
        try {
            if (!url) return;
            const u = url.toString();
            if (!u.includes('batchexecute')) return;
            // Extract at, f.sid, bl
            let atMatch = u.match(/[?&]at=([^&]+)/) || (body && typeof body === 'string' && body.match(/at=([^&]+)/));
            const sidMatch = u.match(/[?&]f\.sid=([^&]+)/) || u.match(/f\.sid=([^&]+)/);
            const blMatch = u.match(/[?&]bl=([^&]+)/);
            // Also from body if URLSearchParams
            if (body && typeof body === 'string') {
                try {
                    const params = new URLSearchParams(body);
                    if (!atMatch) {
                        const a = params.get('at');
                        if (a) atMatch = [null, a];
                    }
                } catch (e) {
                    if (isDev()) console.debug('[GemExporter:hook]', e);
                }
            }
            if (atMatch || sidMatch) {
                // Infer account slot from URL path /u/1/
                let slot = 'default';
                const m = u.match(/\/u\/(\d+)\//);
                if (m) slot = 'u' + m[1];
                else {
                    const m2 = location.pathname.match(/\/u\/(\d+)(?:\/|$)/);
                    if (m2) slot = 'u' + m2[1];
                }
                const payload = {
                    at: atMatch ? decodeURIComponent(atMatch[1]) : '',
                    sid: sidMatch ? decodeURIComponent(sidMatch[1]) : '',
                    bl: blMatch ? decodeURIComponent(blMatch[1]) : '',
                    accountSlot: slot,
                    lastUsed: Date.now(),
                    url: location.href
                };
                window.postMessage({
                    type: Events.CREDENTIALS,
                    payload
                }, location.origin);
            }
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
    }

    function detectDeletedConversation(url: any, body: any, responseText: any): void {
        try {
            const hasGz = (body && typeof body === 'string' && body.includes(Proto.RPCS.DELETE)) ||
                          (responseText && typeof responseText === 'string' && responseText.includes(Proto.RPCS.DELETE)) ||
                          ((url || '').toString().includes(Proto.RPCS.DELETE));
            if (!hasGz) return;

            let slot = 'default';
            const uStr = (url || '').toString();
            const m = uStr.match(/\/u\/(\d+)\//);
            if (m) slot = 'u' + m[1];
            else {
                const m2 = location.pathname.match(/\/u\/(\d+)(?:\/|$)/);
                if (m2) slot = 'u' + m2[1];
            }

            let targetText = (body || '') + ' ' + (responseText || '');
            try {
                if (targetText.includes('%')) {
                    targetText = decodeURIComponent(targetText);
                }
            } catch {
                /* intentional: invalid date or URI fallback */
            }

            // Anchor specifically to the delete-RPC payload parameter context to prevent false positives
            const idMatch = targetText.match(Proto.DELETION_ANCHORS[0]) ||
                            targetText.match(Proto.DELETION_ANCHORS[1]);
            if (idMatch && idMatch[1]) {
                const deletedId = idMatch[1];
                window.postMessage({
                    type: Events.CONVERSATION_DELETED,
                    payload: { id: deletedId, slot }
                }, location.origin);
            }
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
    }

    function getSlotFromUrl(url: any): string {
        let slot = 'default';
        const uStr = (url || '').toString();
        const m = uStr.match(/\/u\/(\d+)\//);
        if (m) slot = 'u' + m[1];
        else if (typeof location !== 'undefined') {
            const m2 = location.pathname.match(/\/u\/(\d+)(?:\/|$)/);
            if (m2) slot = 'u' + m2[1];
        }
        return slot;
    }

    function isStreamUrl(url: any): boolean {
        const u = (url || '').toString();
        return u.includes('StreamGenerate') || u.includes('BardFrontendService');
    }

    function extractConversationId(url: any, body: any, responseText?: any): string | null {
        try {
            // 1. Check response text first (most authoritative for newly assigned conversation IDs in streaming chunk 1)
            if (responseText && typeof responseText === 'string') {
                const m = responseText.match(/["']c_([a-f0-9]{8,64})["']/i) || responseText.match(/c_([a-f0-9]{8,64})/i);
                if (m && m[1]) return m[1];
            }
            // 2. Check request body
            if (body && typeof body === 'string') {
                let decoded = body;
                try { decoded = decodeURIComponent(body); } catch {}
                const m = decoded.match(/["']c_([a-f0-9]{8,64})["']/i) || decoded.match(/c_([a-f0-9]{8,64})/i);
                if (m && m[1]) return m[1];
            }
            // 3. Check current window location
            if (typeof location !== 'undefined') {
                const m = location.pathname.match(/\/app\/([a-f0-9]{8,64})/i);
                if (m && m[1]) return m[1];
            }
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
        return null;
    }

    function broadcastStreamStart(url: any, body: any): void {
        try {
            const convId = extractConversationId(url, body);
            const slot = getSlotFromUrl(url);
            window.postMessage({
                type: Events.STREAM_START,
                payload: { id: convId, slot }
            }, location.origin);
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
    }

    function broadcastStreamComplete(url: any, body: any, responseText?: any): void {
        try {
            const convId = extractConversationId(url, body, responseText);
            const slot = getSlotFromUrl(url);
            window.postMessage({
                type: Events.STREAM_COMPLETE,
                payload: { id: convId, slot, url: (url || '').toString() }
            }, location.origin);
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
    }

    function broadcastBatchexecute(url: any, text: any): void {
        try {
            // wrb.fr is the outer wrapper of EVERY batchexecute response, so it must
            // not take part in this test — including it makes the filter always pass
            // and relays every response body (up to 3MB) across worlds. Only the
            // payloads the ISOLATED side actually parses (list / detail) are relayed.
            if (!text || (!text.includes(Proto.RPCS.LIST) && !text.includes(Proto.RPCS.DETAIL))) return;
            const slot = getSlotFromUrl(url);
            window.postMessage({
                type: Events.NETWORK_BATCHEXECUTE,
                payload: {
                    text: text.slice(0, 3000000), // Protect against memory spikes
                    slot,
                    url: (url || '').toString()
                }
            }, location.origin);
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
    }

    // Hook Fetch
    if (origFetch) {
        window.fetch = async function(...args: any[]) {
            const url = args[0];
            const init = args[1] || {};
            const body = init.body || (args[0] && args[0].body);

            try {
                captureFromUrl(url, body);
                if (isStreamUrl(url)) {
                    broadcastStreamStart(url, body);
                }
            } catch (e) {
                if (isDev()) console.debug('[GemExporter:hook]', e);
            }

            const response = await origFetch.apply(this, args as any);

            try {
                const u = (url || '').toString();
                if (u.includes('batchexecute')) {
                    const cloned = response.clone();
                    cloned.text().then((txt: string) => {
                        try {
                            detectDeletedConversation(url, body, txt);
                            broadcastBatchexecute(url, txt);
                        } catch (e) {
                            if (isDev()) console.debug('[GemExporter:hook]', e);
                        }
                    }).catch((e: any) => {
                        if (isDev()) console.debug('[GemExporter:hook]', e);
                    });
                } else if (isStreamUrl(url)) {
                    try {
                        const cloned = response.clone();
                        cloned.text().then((txt: string) => {
                            try {
                                broadcastStreamComplete(url, body, txt);
                            } catch (e) {
                                if (isDev()) console.debug('[GemExporter:hook]', e);
                            }
                        }).catch(() => {
                            broadcastStreamComplete(url, body);
                        });
                    } catch {
                        broadcastStreamComplete(url, body);
                    }
                }
            } catch (e) {
                if (isDev()) console.debug('[GemExporter:hook]', e);
            }

            return response;
        };
    }

    // Hook XHR
    if (origOpen && origSend) {
        XMLHttpRequest.prototype.open = function(...args: any[]) {
            try {
                (this as any).__hookUrl = args[1];
            } catch (e) {
                if (isDev()) console.debug('[GemExporter:hook]', e);
            }
            return origOpen.apply(this, args as any);
        };

        XMLHttpRequest.prototype.send = function(...args: any[]) {
            try {
                const url = (this as any).__hookUrl;
                const body = args[0];
                captureFromUrl(url, body);

                const u = (url || '').toString();
                if (u.includes('batchexecute')) {
                    this.addEventListener('load', () => {
                        try {
                            detectDeletedConversation(url, body, this.responseText);
                            broadcastBatchexecute(url, this.responseText);
                        } catch (e) {
                            if (isDev()) console.debug('[GemExporter:hook]', e);
                        }
                    });
                } else if (isStreamUrl(url)) {
                    broadcastStreamStart(url, body);
                    let ended = false;
                    const handleStreamEnd = () => {
                        if (ended) return;
                        ended = true;
                        try {
                            broadcastStreamComplete(url, body, this.responseText);
                        } catch (e) {
                            if (isDev()) console.debug('[GemExporter:hook]', e);
                        }
                    };
                    this.addEventListener('load', handleStreamEnd);
                    this.addEventListener('loadend', handleStreamEnd);
                    this.addEventListener('abort', handleStreamEnd);
                }
            } catch (e) {
                if (isDev()) console.debug('[GemExporter:hook]', e);
            }
            return origSend.apply(this, args as any);
        };
    }

    if (isDev()) console.log('[Gemini Exporter] MAIN world credentials hook initialized');
})();

export {};
