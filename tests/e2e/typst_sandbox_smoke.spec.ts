/**
 * tests/e2e/typst_sandbox_smoke.spec.ts
 *
 * Tier 1 Playwright smoke test for the P1b sandbox compile container:
 * drives the REAL typst.ts 0.7.0 WASM compiler inside the MV3 sandbox page
 * (init + font install + compile of a minimal v8-template document) and
 * asserts:
 * - the compile returns bytes starting with %PDF-
 * - zero external (http/https) requests happen during the whole flow
 *   (the P0 "no remote" gate)
 *
 * This mirrors the P0 probe's verified recipe: extension page -> iframe ->
 * postMessage with transferred ArrayBuffers.
 */
import { test, expect } from './fixtures';

test.describe('Typst sandbox compile container (P1b smoke)', () => {
  test('sandbox page compiles a minimal template to PDF with zero external requests', async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(90000);
    const extOrigin = `chrome-extension://${extensionId}`;
    const page = await context.newPage();

    // P0 gate: any remote request fails the test.
    const remoteRequests: string[] = [];
    await page.route(/^https?:\/\//, async (route) => {
      remoteRequests.push(route.request().url());
      await route.abort();
    });

    await page.goto(`${extOrigin}/src/ui/options/options.html`);

    const result = await page.evaluate(
      async (urls: { sandbox: string; wasm: string; font: string }) => {
        const nextJob = () =>
          (crypto as Crypto).randomUUID
            ? (crypto as Crypto).randomUUID()
            : `job-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        const ready = new Promise<void>((resolve) => {
          const onMessage = (event: MessageEvent) => {
            if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
            const data = event.data as { type?: string };
            if (data && data.type === 'typst/ready') {
              window.removeEventListener('message', onMessage);
              resolve();
            }
          };
          window.addEventListener('message', onMessage);
        });
        iframe.src = urls.sandbox;
        document.documentElement.appendChild(iframe);
        await ready;

        const post = <T>(message: Record<string, unknown>, transfer?: Transferable[]): Promise<T> =>
          new Promise<T>((resolve, reject) => {
            const jobId = message.jobId as string;
            const timer = window.setTimeout(() => reject(new Error(`timeout waiting for ${message.type}`)), 60000);
            const onMessage = (event: MessageEvent) => {
              if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
              const data = event.data as { type?: string; jobId?: string };
              if (!data || data.jobId !== jobId) return;
              if (data.type === 'typst/compiled' || data.type === 'typst/inited') {
                window.clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                resolve(data as T);
              } else if (data.type === 'typst/error') {
                window.clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                const err = (data as { error?: { message?: string } }).error;
                reject(new Error(`sandbox error: ${err?.message ?? 'unknown'}`));
              }
            };
            window.addEventListener('message', onMessage);
            iframe.contentWindow!.postMessage(message, '*', transfer ?? []);
          });

        const fetchBytes = async (url: string): Promise<ArrayBuffer> => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
          return res.arrayBuffer();
        };

        // 1. Init with the vendored WASM module bytes.
        const wasm = await fetchBytes(urls.wasm);
        const initJob = nextJob();
        const inited = await post<{ type: string; ok: boolean; initMs: number }>(
          { type: 'typst/init', jobId: initJob, wasm },
          [wasm],
        );
        if (!inited.ok) throw new Error('sandbox init reported ok=false');

        // 2. Compile a minimal document through the real v8 templates.
        const font = await fetchBytes(urls.font);
        const payload = {
          schemaVersion: 1,
          title: 'P1b sandbox smoke',
          provider: 'gemini',
          date: '2026-09-26',
          messageCount: 1,
          messages: [
            {
              id: 'm1',
              role: 'user',
              blocks: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: 'hello from the sandbox smoke test' }],
                },
              ],
            },
          ],
        };
        const compileJob = nextJob();
        const compiled = await post<{
          type: string;
          ok: boolean;
          pdf: ArrayBuffer | null;
          pdfBytes: number;
          diagnostics: Array<{ severity: string; message: string }>;
        }>(
          {
            type: 'typst/compile',
            jobId: compileJob,
            files: [{ path: '/payload.json', text: JSON.stringify(payload) }],
            binaries: [],
            fonts: [font],
          },
          [font],
        );
        iframe.remove();
        const header = compiled.pdf
          ? String.fromCharCode(...new Uint8Array(compiled.pdf).slice(0, 5))
          : null;
        return {
          ok: compiled.ok,
          pdfBytes: compiled.pdfBytes,
          pdfHeader: header,
          initMs: inited.initMs,
          diagnostics: compiled.diagnostics,
        };
      },
      {
        sandbox: `${extOrigin}/src/ui/sandbox/typst-compile.html`,
        wasm: `${extOrigin}/src/ui/sandbox/vendor/typst_ts_web_compiler_bg.wasm`,
        font: `${extOrigin}/src/ui/sandbox/fonts/NewCMMath-Regular.otf`,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.pdfHeader).toBe('%PDF-');
    expect(result.pdfBytes).toBeGreaterThan(1000);
    expect(remoteRequests).toEqual([]);
  });
});
