/** Read-only CDP network audit. Never records credentials, request bodies or successful response bodies. */
const fs = require('node:fs');
const path = require('node:path');

function endpoint(raw) {
    try {
        const u = new URL(raw);
        return u.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(u.hostname)
            ? u.origin + u.pathname : null;
    } catch { return null; }
}
function safeHeaders(headers) {
    return Object.fromEntries(Object.entries(headers).filter(([key]) =>
        /^(retry-after|ratelimit-.*|x-ratelimit-.*|x-request-id|cf-ray|content-type|date|server)$/i.test(key)));
}
function errorSummary(text) {
    const scrub = value => String(value).slice(0, 700)
        .replace(/Bearer\s+\S+/gi, '[credential]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[credential]');
    try {
        const parsed = JSON.parse(text);
        const value = parsed.error || parsed.detail || parsed;
        if (typeof value === 'string') return { message: scrub(value) };
        return Object.fromEntries(['code', 'type', 'message', 'error_code', 'error_type'].flatMap(key =>
            ['string', 'number'].includes(typeof value?.[key]) ? [[key, scrub(value[key])]] : []));
    } catch { return { nonJson: true, bytes: Buffer.byteLength(text) }; }
}

async function audit(port, output, workerOnly = false) {
    fs.mkdirSync(output, { recursive: true });
    const metadata = workerOnly
        ? (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://cbfmddjhbigjddpmfgaddnpjkobmaelj/'))
        : await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    if (!metadata) throw new Error('No extension worker target');
    const ws = new WebSocket(metadata.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    let seq = 0;
    const pending = new Map(), sessions = new Map(), targets = new Set(), requests = new Map();
    const log = item => fs.appendFileSync(path.join(output, 'network.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...item }) + '\n');
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    async function attach(target) {
        if (!['page', 'service_worker', 'worker'].includes(target.type) || targets.has(target.targetId)) return;
        targets.add(target.targetId);
        try {
            const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
            sessions.set(sessionId, { type: target.type, extension: target.url.startsWith('chrome-extension://') });
            await call('Network.enable', {}, sessionId);
            log({ event: 'observer_attached', targetType: target.type, extension: target.url.startsWith('chrome-extension://') });
        } catch (error) { log({ event: 'observer_error', message: error.message }); }
    }
    ws.addEventListener('message', async event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const p = pending.get(message.id);
            if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
            return;
        }
        const p = message.params || {}, sid = message.sessionId;
        if (message.method === 'Target.targetCreated') { void attach(p.targetInfo); return; }
        const key = sid + ':' + p.requestId;
        if (message.method === 'Network.requestWillBeSent') {
            const url = endpoint(p.request.url);
            if (!url) return;
            const record = { requestId: key, url, method: p.request.method, monotonic: p.timestamp,
                wallTime: p.wallTime, ...sessions.get(sid), initiator: p.initiator?.type };
            requests.set(key, record);
            log({ event: 'request', ...record });
        }
        const request = requests.get(key);
        if (!request) return;
        if (message.method === 'Network.responseReceived') {
            request.status = p.response.status;
            log({ event: 'response', requestId: key, url: request.url, status: request.status,
                monotonic: p.timestamp, fromDiskCache: p.response.fromDiskCache || false,
                headers: safeHeaders(p.response.headers) });
            if (request.status === 429) {
                const incident = { ...request, headers: safeHeaders(p.response.headers), observedAt: new Date().toISOString() };
                const flag = path.join(output, 'first-429.json');
                if (!fs.existsSync(flag)) fs.writeFileSync(flag, JSON.stringify(incident, null, 2));
                console.log('HTTP 429: ' + request.method + ' ' + request.url);
            }
        }
        if (message.method === 'Network.loadingFailed') log({ event: 'network_failure', requestId: key, url: request.url, error: p.errorText });
        if (message.method === 'Network.loadingFinished' && request.status === 429) {
            try {
                const body = await call('Network.getResponseBody', { requestId: p.requestId }, sid);
                const decoded = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
                log({ event: 'rate_limit_body', requestId: key, url: request.url, error: errorSummary(decoded) });
            } catch (error) { log({ event: 'body_unavailable', requestId: key, message: error.message }); }
        }
    });
    if (workerOnly) {
        sessions.set(undefined, { type: 'service_worker', extension: true, directWorkerObserver: true });
        await call('Network.enable');
        log({ event: 'observer_attached', targetType: 'service_worker', extension: true, directWorkerObserver: true });
    } else {
        await call('Target.setDiscoverTargets', { discover: true });
        const all = await call('Target.getTargets');
        await Promise.all(all.targetInfos.map(attach));
    }
    fs.writeFileSync(path.join(output, workerOnly ? 'worker-observer-ready' : 'observer-ready'), new Date().toISOString());
    console.log('Read-only network observer ready');
    process.on('SIGTERM', () => { ws.close(); process.exit(0); });
    process.on('SIGINT', () => { ws.close(); process.exit(0); });
}
module.exports = { endpoint, safeHeaders, errorSummary };
if (require.main === module) audit(Number(process.argv[2] || 9222), process.argv[3], process.argv[4] === '--worker').catch(error => { console.error(error); process.exitCode = 1; });
