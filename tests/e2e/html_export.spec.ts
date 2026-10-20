import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';

const JSZip = require(path.resolve(__dirname, '../../lib/jszip.min.js'));

test.describe('Deep E2E: Real Export to HTML & Full Fidelity Verification', () => {
  test('should execute ExportEngine with html format, download ZIP, and verify valid HTML structure and styling', async ({ context, extensionId }) => {
    // 1. Open mock Gemini page in the background with valid credentials and network routing
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
              SNlM0e: 'mock_at_token_html_123',
              cfb2h: 'boq_assistant-bard-web-server_20260802.09_p1'
            };
          </script>
        </head>
        <body>Gemini Mock Session Active</body>
        </html>`
      });
    });

    // Mock Gemini conversation detail response (hNvQHb)
    const turns = [
      [
        ["c_html_exp_001"],
        "turn_id_html_1",
        [["请解释一下热膨胀系数突变引发的瞬态热激波。"]],
        [
          [
            ["rc_cand_html_1", ["热膨胀系数 $\\alpha_T$ 突变会引发局部应力波与瞬态热激波，在极高加热速率下尤为显著。"]]
          ]
        ]
      ]
    ];
    const mockDetailInner = JSON.stringify([
      turns,
      "tC_sample_token",
      "瞬态热激波与热膨胀物理机制"
    ]);
    const mockRpcResponse = `)]}'\n\n[["wrb.fr","hNvQHb",${JSON.stringify(mockDetailInner)}]]`;

    await geminiPage.route('**/batchexecute*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockRpcResponse
      });
    });

    await geminiPage.goto('https://gemini.google.com/app');
    await geminiPage.waitForLoadState('domcontentloaded');

    // 2. Open Workbench Options page
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await optionsPage.waitForLoadState('domcontentloaded');

    // Seed conversation
    await optionsPage.evaluate(async () => {
      const convs = [
        { id: 'html_exp_001', title: '瞬态热激波与热膨胀物理机制', timestamp: 1700000000000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: convs,
        exportedIds: {},
        has_completed_tour: true,
        last_seen_feature_version: '999.0.0'
      });
      if (typeof (window as any).__workbenchLoadStore === 'function') {
        await (window as any).__workbenchLoadStore(true);
      }
    });

    await expect(optionsPage.locator('#list .item')).toHaveCount(1);

    // 3. Select HTML format
    await optionsPage.selectOption('#format', 'html');
    await optionsPage.click('#btnSelectAll');
    expect(await optionsPage.locator('#list input[type=checkbox]:checked').count()).toBe(1);

    // 4. Trigger download
    const downloadPromise = optionsPage.waitForEvent('download', { timeout: 30000 });
    await optionsPage.click('#btnExport');

    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    // 5. Inspect and Unzip the real downloaded ZIP file
    const zipData = fs.readFileSync(downloadPath!);
    const zip = await JSZip.loadAsync(zipData);

    const zipFiles = Object.keys(zip.files);
    expect(zipFiles.length).toBeGreaterThan(0);

    const htmlFileName = zipFiles.find(f => f.endsWith('.html'));
    expect(htmlFileName).toBeTruthy();

    const htmlContent = await zip.files[htmlFileName!].async('text');

    // Validate HTML structure, typography, and print styles
    expect(htmlContent).toContain('<!DOCTYPE html>');
    expect(htmlContent).toContain('瞬态热激波与热膨胀物理机制');
    expect(htmlContent).toContain('@media print');
    expect(htmlContent).toContain('gem-user-bubble');
    expect(htmlContent).toContain('gem-model-content');
    expect(htmlContent).toContain('热膨胀系数');
    expect(htmlContent).toContain('prefers-color-scheme');
    expect(htmlContent).not.toContain('gem-top-bar');

    // 6. Verify Workbench UI updated
    await expect(optionsPage.locator('[data-chat-id="html_exp_001"] .badge')).toContainText(/已导出|Exported/);

    const storageData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['exportedIds']);
    }) as Record<string, any>;
    expect(storageData.exportedIds['html_exp_001']).toBeTruthy();
    expect(storageData.exportedIds['html_exp_001'].format).toBe('html');
  });
});
