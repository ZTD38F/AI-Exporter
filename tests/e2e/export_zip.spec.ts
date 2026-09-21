import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';

const JSZip = require(path.resolve(__dirname, '../../lib/jszip.min.js'));


test.describe('Deep E2E: Real Export to ZIP & Markdown Content Verification', () => {
  test('should execute full ExportEngine, trigger browser ZIP download, and verify unzipped markdown content', async ({ context, extensionId }) => {
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
              SNlM0e: 'mock_at_token_123',
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
        ["c_real_exp_001"],
        "turn_id_1",
        [["请解释一下深度学习中的反向传播算法。"]],
        [
          [
            ["rc_cand_1", ["反向传播（Backpropagation）是训练神经网络的核心算法，通过链式法则计算梯度。"]]
          ]
        ]
      ]
    ];
    const mockDetailInner = JSON.stringify([
      turns,
      "tC_sample_token",
      "深度学习反向传播算法详解"
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
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    // Seed conversation with real ID
    await optionsPage.evaluate(async () => {
      const convs = [
        { id: 'real_exp_001', title: '深度学习反向传播算法详解', timestamp: 1700000000000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: convs,
        exportedIds: {}
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    await expect(optionsPage.locator('#list .item')).toHaveCount(1);

    // 3. Select all items
    await optionsPage.click('#btnSelectAll');
    expect(await optionsPage.locator('#list input[type=checkbox]:checked').count()).toBe(1);

    // 4. Listen for real browser download event and click Export
    const downloadPromise = optionsPage.waitForEvent('download', { timeout: 30000 });
    await optionsPage.click('#btnExport');

    // Wait for the real ZIP file to be generated and downloaded
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    // 5. Inspect and Unzip the real downloaded ZIP file
    const zipData = fs.readFileSync(downloadPath);
    const zip = await JSZip.loadAsync(zipData);

    const zipFiles = Object.keys(zip.files);
    expect(zipFiles.length).toBeGreaterThan(0);

    // Find the generated Markdown file in ZIP
    const mdFileName = zipFiles.find(f => f.endsWith('.md'));
    expect(mdFileName).toBeTruthy();

    const mdContent = await zip.files[mdFileName!].async('text');
    // Verify real markdown structure, title, user query, and model response
    expect(mdContent).toContain('深度学习反向传播算法详解');
    expect(mdContent).toContain('请解释一下深度学习中的反向传播算法');
    expect(mdContent).toContain('反向传播（Backpropagation）是训练神经网络的核心算法');

    // 6. Verify Workbench UI updated to show Exported Badge and Storage is updated
    await expect(optionsPage.locator('[data-chat-id="real_exp_001"] .badge')).toContainText(/已导出|Exported/);

    const storageData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['exportedIds']);
    }) as Record<string, any>;
    expect(storageData.exportedIds['real_exp_001']).toBeTruthy();
    expect(storageData.exportedIds['real_exp_001'].title).toBe('深度学习反向传播算法详解');
  });
});

