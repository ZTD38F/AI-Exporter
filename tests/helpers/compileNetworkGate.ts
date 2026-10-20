/**
 * tests/helpers/compileNetworkGate.ts
 * §16 P0 release-blocker harness: zero-external-request gate for the PDF compiler.
 *
 * P0 formal experiment结论: 4 样本 + 300 次压力编译全部 externalRequestsBlocked = 0。
 * 产品红线: Typst WASM 编译必须完全离线 —— 不允许编译器从 CDN (如 jsdelivr)
 * 拉字体/WASM, 不允许任何遥测外发。
 *
 * 用法 (Phase D sandbox 落地后一行接入):
 *   import { withNetworkGate, assertZeroExternalRequests } from '../helpers/compileNetworkGate.js';
 *   const gated = await withNetworkGate(() => sandboxCompiler.compile(payload));
 *   assertZeroExternalRequests(gated, 'typst-sandbox-compile');
 *   const pdfBytes = gated.result;
 *
 * 设计:
 *  - 劫持被测函数执行期间的 globalThis.fetch / XMLHttpRequest / WebSocket,
 *    记录每一次调用 (kind + url + method), 然后以"离线阻断"语义拒绝
 *    (fetch 返回 rejected promise, XHR/WebSocket 抛错), 模拟 P0 实验的
 *    CDP 阻断全部外部 HTTP(S)。
 *  - data:/blob: URL 不是网络请求, 不计入 externalRequestCount (但仍记录在
 *    violations 供排查)。
 *  - 无论被测函数是否吞掉网络错误 (try/catch), 调用计数都已记录,
 *    断言看的是计数不是异常。
 *  - finally 精确恢复所有被劫持的全局 (含"原本就不存在"的情况), 不污染后续测试。
 *
 * 范围说明:
 *  - MV3 sandbox 页面本就没有 chrome.* 网络 egress (sandboxed frame 无
 *    chrome API), 编译器的网络面就是 fetch/XHR/WebSocket, 本 harness 覆盖
 *    其全部。
 *  - 本文件是纯测试辅助, 不依赖 dist/ 产物, 可在 run_tests.py (build.js 之前)
 *    阶段运行。
 */

export interface NetworkGateViolation {
    kind: 'fetch' | 'xhr' | 'websocket';
    url: string;
    method?: string;
}

export interface NetworkGateReport<T> {
    /** 被测函数的返回值 (原样透传)。 */
    result: T;
    /** 执行期间所有被拦截到的网络调用 (含 data:/blob:)。 */
    violations: NetworkGateViolation[];
    /** 外部网络请求计数 — 门禁断言的对象, 必须为 0。 */
    externalRequestCount: number;
}

/** Harness 拒绝网络调用时抛出的错误 (模拟离线环境的网络失败)。 */
export class NetworkGateBlockedError extends Error {
    readonly url: string;
    constructor(url: string) {
        super(`[network-gate] blocked external request: ${url}`);
        this.name = 'NetworkGateBlockedError';
        this.url = url;
    }
}

function isExternalUrl(url: string): boolean {
    const lower = url.trim().toLowerCase();
    return !(lower.startsWith('data:') || lower.startsWith('blob:'));
}

function urlOf(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input && typeof (input as { url?: unknown }).url === 'string') {
        return (input as { url: string }).url;
    }
    try {
        return String(input);
    } catch {
        return '<unprintable>';
    }
}

/**
 * 在网络门禁下执行 fn。返回被测结果 + 违规记录。
 * 被测函数可以是同步或异步; 抛出的业务异常会原样透出 (门禁只管网络计数)。
 */
export async function withNetworkGate<T>(fn: () => T | Promise<T>): Promise<NetworkGateReport<T>> {
    const violations: NetworkGateViolation[] = [];
    const g = globalThis as unknown as Record<string, unknown>;

    const origFetch: unknown = g['fetch'];
    const origXHR: unknown = g['XMLHttpRequest'];
    const origWebSocket: unknown = g['WebSocket'];

    const record = (kind: NetworkGateViolation['kind'], url: string, method?: string): void => {
        violations.push({ kind, url, method });
    };

    // -- fetch: 记录后拒绝, 模拟 CDP 阻断 ------------------------------------
    const gateFetch = (input: unknown, init?: { method?: string }): Promise<never> => {
        const url = urlOf(input);
        const inputMethod =
            input && typeof (input as { method?: unknown }).method === 'string'
                ? (input as { method: string }).method
                : undefined;
        record('fetch', url, (init && init.method) || inputMethod || 'GET');
        return Promise.reject(new NetworkGateBlockedError(url));
    };

    // -- XMLHttpRequest: 存在才劫持 (Node 默认无, 浏览器/sandbox 有) -----------
    // 不继承原类: 构造器直接返回门禁替身, 避免 super() 语义差异。
    const gateXHR = typeof origXHR === 'undefined'
        ? null
        : class {
              open(method: string, url: string): void {
                  record('xhr', String(url), method);
                  throw new NetworkGateBlockedError(String(url));
              }
              send(): void {
                  throw new NetworkGateBlockedError('<xhr send blocked>');
              }
              setRequestHeader(): void {
                  /* no-op: 让 open() 之前的常规调用不提前炸 */
              }
              abort(): void {
                  /* no-op */
              }
          };

    // -- WebSocket: 存在才劫持 -----------------------------------------------
    const gateWebSocket = typeof origWebSocket === 'undefined'
        ? null
        : class {
              constructor(url: string | URL) {
                  record('websocket', String(url));
                  throw new NetworkGateBlockedError(String(url));
              }
          };

    const define = (key: string, value: unknown): void => {
        Object.defineProperty(g, key, { value, writable: true, configurable: true, enumerable: false });
    };
    const restore = (key: string, orig: unknown, patched: unknown): void => {
        if (typeof orig === 'undefined') {
            if (patched && key in g) delete g[key];
        } else {
            define(key, orig);
        }
    };

    define('fetch', gateFetch);
    if (gateXHR) define('XMLHttpRequest', gateXHR);
    if (gateWebSocket) define('WebSocket', gateWebSocket);

    try {
        const result = await fn();
        return {
            result,
            violations,
            externalRequestCount: violations.filter(v => isExternalUrl(v.url)).length,
        };
    } finally {
        restore('fetch', origFetch, gateFetch);
        restore('XMLHttpRequest', origXHR, gateXHR);
        restore('WebSocket', origWebSocket, gateWebSocket);
    }
}

/**
 * 门禁断言: 外部请求数必须为 0。失败时打印全部违规记录 (含被吞掉的调用)。
 */
export function assertZeroExternalRequests(
    report: Pick<NetworkGateReport<unknown>, 'violations' | 'externalRequestCount'>,
    context = 'compiler',
): void {
    if (report.externalRequestCount !== 0) {
        const lines = report.violations.map(v => `  - [${v.kind}] ${(v.method ?? '').trim()} ${v.url}`.trimEnd());
        throw new Error(
            `P0 release gate FAILED: ${context} made ${report.externalRequestCount} external network request(s), expected 0.\n` +
            `Intercepted calls:\n${lines.join('\n')}`,
        );
    }
}
