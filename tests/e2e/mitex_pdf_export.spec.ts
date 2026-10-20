/**
 * tests/e2e/mitex_pdf_export.spec.ts
 *
 * Tier 1 Playwright E2E verification for the MiTeX production math engine (PR 5):
 * Verifies the complete real MV3 browser extension runtime pipeline:
 *   MiTeX WASM init -> math conversion -> payloadStage -> Typst sandbox -> valid PDF
 *
 * Asserts:
 * 1. Actual browser loading path via chrome.runtime.getURL succeeds offline.
 * 2. MiTeX WASM converts standard LaTeX math formulas into Typst syntax in browser.
 * 3. Typst sandbox compile container evaluates the MiTeX-converted formulas with mitex-scope.typ.
 * 4. Produced PDF binary is valid (%PDF- header, non-empty bytes).
 * 5. Full UI PDF export flow succeeds and delivers a valid ZIP containing the PDF.
 * 6. Zero remote requests occur during the entire flow.
 */

import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';

const JSZip = require(path.resolve(__dirname, '../../lib/jszip.min.js'));

test.describe('MiTeX production math converter & Typst PDF export (MV3 browser runtime)', () => {
  for (const denyLocalFonts of [false, true]) {
    test(denyLocalFonts ? 'exports English PDF when local font permission is denied' : 'verifies real MV3 browser pipeline: MiTeX init -> math conversion -> sandbox compile -> valid PDF', async ({
      context,
      extensionId,
    }) => {
      test.setTimeout(90000);
      const extOrigin = `chrome-extension://${extensionId}`;
      const page = await context.newPage();

      // Zero remote requests gate
      const remoteRequests: string[] = [];
      await page.route(/^https?:\/\//, async (route) => {
        remoteRequests.push(route.request().url());
        await route.abort();
      });

      await page.goto(`${extOrigin}/src/ui/options/options.html?notour=1`);
      await page.waitForLoadState('domcontentloaded');

      // 1. In-browser pipeline evaluation
      const pipelineResult = await page.evaluate(
        async (urls: { sandbox: string; wasm: string; font: string }) => {
          const nextJob = () =>
            (crypto as Crypto).randomUUID
              ? (crypto as Crypto).randomUUID()
              : `job-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

          // Verify window.__mitex is mounted
          const mitex = (window as any).__mitex;
          if (!mitex) throw new Error('window.__mitex hook not found on options page');

          // Step 1: Initialize MiTeX WASM via extension URL
          await mitex.initMitexWasm();
          const isReady = mitex.isMitexReady();
          if (!isReady) throw new Error('MiTeX WASM reports isReady=false after init');

          // Step 2: Convert representative standard LaTeX expressions in browser
          const formulas = [
            String.raw`\int_0^\infty e^{-x} dx = 1`,
            String.raw`\frac{\sqrt{x^2 + 1}}{2}`,
            String.raw`\begin{cases} 1 & x > 0 \\ 0 & x \le 0 \end{cases}`,
          ];

          const convertedMath: string[] = [];
          for (const f of formulas) {
            const res = mitex.convertMathWithMitex(f, 'latex', true);
            if (!res.typst) {
              throw new Error(`MiTeX math conversion failed for formula: ${f}; diagnostic: ${JSON.stringify(res.diagnostic)}`);
            }
            convertedMath.push(res.typst);
          }

          // Step 3: Mount Typst sandbox iframe
          const iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          const readyPromise = new Promise<void>((resolve) => {
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
          await readyPromise;

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

          // Step 4: Init Typst compiler WASM
          const wasmBytes = await fetchBytes(urls.wasm);
          const initJob = nextJob();
          const inited = await post<{ type: string; ok: boolean; initMs: number }>(
            { type: 'typst/init', jobId: initJob, wasm: wasmBytes },
            [wasmBytes],
          );
          if (!inited.ok) throw new Error('sandbox init reported ok=false');

          // Step 5: Build document payload using the MiTeX-converted math
          const font = await fetchBytes(urls.font);
          const payload = {
            schemaVersion: 1,
            title: 'MiTeX Browser E2E Test',
            provider: 'gemini',
            date: '2026-09-28',
            messageCount: 1,
            messages: [
              {
                id: 'm1',
                role: 'assistant',
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'MiTeX converted formulas in Typst sandbox:' }],
                  },
                  ...formulas.map((f, idx) => ({
                    type: 'math',
                    latex: f,
                    typst: convertedMath[idx],
                  })),
                ],
              },
            ],
          };

          // Step 6: Compile to PDF through Typst sandbox
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
            isReady,
            convertedMathCount: convertedMath.length,
            compileOk: compiled.ok,
            pdfBytes: compiled.pdfBytes,
            pdfHeader: header,
            diagnostics: compiled.diagnostics,
          };
        },
        {
          sandbox: `${extOrigin}/src/ui/sandbox/typst-compile.html`,
          wasm: `${extOrigin}/src/ui/sandbox/vendor/typst_ts_web_compiler_bg.wasm`,
          font: `${extOrigin}/src/ui/sandbox/fonts/NewCMMath-Regular.otf`,
        },
      );

      expect(pipelineResult.isReady).toBe(true);
      expect(pipelineResult.convertedMathCount).toBe(3);
      expect(pipelineResult.compileOk).toBe(true);
      expect(pipelineResult.pdfHeader).toBe('%PDF-');
      expect(pipelineResult.pdfBytes).toBeGreaterThan(1000);
      const errors = (pipelineResult.diagnostics || []).filter((d) => d.severity === 'error');
      expect(errors).toHaveLength(0);

      // 2. Full UI PDF export flow verification
      const geminiPage = await context.newPage();
      await geminiPage.route('https://gemini.google.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!DOCTYPE html>
          <html>
          <head>
            <script>
              window._WIZ_global_data = {
                SNlM0e: 'mock_token_mitex_123',
                cfb2h: 'boq_assistant-bard-web-server_20260928.01_p1'
              };
            </script>
          </head>
          <body>Gemini Mock Session Active</body>
          </html>`,
        });
      });

      const mockDetailInner = JSON.stringify([
        [
          [
            ["c_mitex_pdf_001"],
            "turn_1",
            [[denyLocalFonts ? "Calculate the Gaussian integral" : "计算高斯积分"]],
            [
              [
                ["rc_cand_1", [(denyLocalFonts ? "The Gaussian integral is:" : "高斯积分结果为：") + "\n\n$$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$"]]
              ]
            ]
          ]
        ],
        "tC_sample_token",
        denyLocalFonts ? "Gaussian integral derivation" : "高斯积分推导"
      ]);
      const mockRpcResponse = `)]}'\n\n[["wrb.fr","hNvQHb",${JSON.stringify(mockDetailInner)}]]`;

      await geminiPage.route('**/batchexecute*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: mockRpcResponse,
        });
      });

      await geminiPage.goto('https://gemini.google.com/app');
      await geminiPage.waitForLoadState('domcontentloaded');

      if (denyLocalFonts) {
        await page.evaluate(() => {
          (window as any).__deniedFontQueries = 0;
          (window as any).queryLocalFonts = async () => {
            (window as any).__deniedFontQueries++;
            throw new DOMException('Local font access denied by user', 'NotAllowedError');
          };
        });
      }

      // Seed conversation and select PDF format
      await page.evaluate(async (english) => {
        const convs = [
          { id: 'mitex_pdf_001', title: english ? 'Gaussian integral derivation' : '高斯积分推导', timestamp: 1700000000000 },
        ];
        await chrome.storage.local.set({
          gemini_conversations: convs,
          exportedIds: {},
          has_completed_tour: true,
          last_seen_feature_version: '999.0.0',
        });
        if (typeof (window as any).__workbenchLoadStore === 'function') {
          await (window as any).__workbenchLoadStore(true);
        }
      }, denyLocalFonts);

      await expect(page.locator('#list .item')).toHaveCount(1);
      await page.click('#btnSelectAll');
      await page.selectOption('#format', 'pdf');

      // Trigger PDF Export and wait for browser download
      const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
      await page.click('#btnExport');

      const download = await downloadPromise;
      const downloadPath = await download.path();
      expect(downloadPath).toBeTruthy();

      // Inspect the generated ZIP file containing the PDF
      const zipData = fs.readFileSync(downloadPath!);
      const zip = await JSZip.loadAsync(zipData);
      const zipFiles = Object.keys(zip.files);

      const pdfFileName = zipFiles.find((f: string) => f.endsWith('.pdf'));
      expect(pdfFileName).toBeTruthy();

      const pdfBuffer = await zip.files[pdfFileName!].async('nodebuffer');
      expect(pdfBuffer.length).toBeGreaterThan(1000);
      expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');

      if (denyLocalFonts) {
        expect(await page.evaluate(() => (window as any).__deniedFontQueries)).toBeGreaterThan(0);
        fs.writeFileSync(test.info().outputPath('denied-local-fonts-english.pdf'), pdfBuffer);
      }

      // Assert zero remote requests during entire test
      expect(remoteRequests).toEqual([]);
    });
  }
});
