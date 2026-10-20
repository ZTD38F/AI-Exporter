import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';

const JSZip = require(path.resolve(__dirname, '../../lib/jszip.min.js'));

test.describe('Deep E2E: Real Export to JSON (OpenAI format) & Structure Verification', () => {
  test('should execute ExportEngine with json_openai format, download ZIP, and verify valid JSON structure and roles', async ({ context, extensionId }) => {
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
              SNlM0e: 'mock_at_token_json_123',
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
        ["c_json_exp_001"],
        "turn_id_json_1",
        [["请解释一下分布式系统中的一致性哈希算法。"]],
        [
          [
            ["rc_cand_json_1", ["一致性哈希（Consistent Hashing）是一种特殊的哈希算法，能够在节点增删时最小化数据迁移。"]]
          ]
        ]
      ]
    ];
    const mockDetailInner = JSON.stringify([
      turns,
      "tC_sample_token",
      "分布式一致性哈希算法详解"
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
        { id: 'json_exp_001', title: '分布式一致性哈希算法详解', timestamp: 1700000000000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: convs,
        exportedIds: {},
        has_completed_tour: true,
        last_seen_feature_version: '999.0.0'
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    await expect(optionsPage.locator('#list .item')).toHaveCount(1);

    // 3. Select JSON (OpenAI) format
    await optionsPage.selectOption('#format', 'json_openai');
    await optionsPage.click('#btnSelectAll');
    expect(await optionsPage.locator('#list input[type=checkbox]:checked').count()).toBe(1);

    // 4. Trigger download
    const downloadPromise = optionsPage.waitForEvent('download', { timeout: 30000 });
    await optionsPage.click('#btnExport');

    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    // 5. Inspect and Unzip the real downloaded ZIP file
    const zipData = fs.readFileSync(downloadPath);
    const zip = await JSZip.loadAsync(zipData);

    const zipFiles = Object.keys(zip.files);
    expect(zipFiles.length).toBeGreaterThan(0);

    const jsonFileName = zipFiles.find(f => f.endsWith('.json') && !f.includes('metadata'));
    expect(jsonFileName).toBeTruthy();

    const jsonContentRaw = await zip.files[jsonFileName!].async('text');
    const parsed = JSON.parse(jsonContentRaw);

    // Validate OpenAI JSON structure
    expect(parsed).toBeTruthy();
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.messages.length).toBeGreaterThanOrEqual(2);

    const userMsg = parsed.messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeTruthy();
    expect(userMsg.content).toContain('一致性哈希');

    const assistantMsg = parsed.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg).toBeTruthy();
    expect(assistantMsg.content).toContain('一致性哈希（Consistent Hashing）是一种特殊的哈希算法');

    // 6. Verify Workbench UI updated
    await expect(optionsPage.locator('[data-chat-id="json_exp_001"] .badge')).toContainText(/已导出|Exported/);

    const storageData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['exportedIds']);
    }) as Record<string, any>;
    expect(storageData.exportedIds['json_exp_001']).toBeTruthy();
    expect(storageData.exportedIds['json_exp_001'].format).toBe('json_openai');
  });
});
