import { test, expect } from './fixtures';

test.describe('E2E: Live Auto-Save Controls & In-Page Persistence Flow', () => {
  test('should render unified directory card, auto-prompt picker on toggle, and sync dir label', async ({ context, extensionId }) => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    // 1. Verify card elements exist (and legacy/removed boxes are absent)
    const diskToggle = optionsPage.locator('#liveSaveDiskToggle');
    const dirBox = optionsPage.locator('#dirBox');
    const dirLabel = optionsPage.locator('#dirLabel');
    const statusTag = optionsPage.locator('#liveSaveStatusTag');

    await expect(optionsPage.locator('#includeIndex')).toHaveCount(0);
    await expect(optionsPage.locator('#liveSaveDbToggle')).toHaveCount(0);
    await expect(optionsPage.locator('#liveSaveDiskBox')).toHaveCount(0);
    await expect(diskToggle).toBeVisible();
    await expect(dirBox).toBeVisible();
    await expect(statusTag).toBeVisible();
    await expect(diskToggle).not.toBeChecked();

    // 2. Mock showDirectoryPicker to abort first
    await optionsPage.evaluate(() => {
      (window as any).showDirectoryPicker = async () => {
        const err = new Error('User cancelled');
        err.name = 'AbortError';
        throw err;
      };
    });

    // 3. Click diskToggle without directory set -> picker prompts and user aborts -> rollback to unchecked
    await diskToggle.click();
    await expect(diskToggle).not.toBeChecked();

    // 4. Now mock showDirectoryPicker to return a directory
    await optionsPage.evaluate(() => {
      (window as any).showDirectoryPicker = async () => ({
        name: 'E2E_Test_Vault',
        kind: 'directory'
      });
    });

    // 5. Click diskToggle again -> picker prompts and succeeds -> checked and dirLabel updated
    await diskToggle.click();
    await expect(diskToggle).toBeChecked();
    await expect(dirLabel).toContainText('E2E_Test_Vault');

    // 6. Click again to disable
    await diskToggle.click();
    await expect(diskToggle).not.toBeChecked();

    // 7. Click again to re-enable with existing directory -> immediately checked without prompting
    await diskToggle.click();
    await expect(diskToggle).toBeChecked();

    await optionsPage.close();
  });

  test('should trigger live save execution and display visual badge feedback on completion', async ({ context, extensionId }) => {
    const geminiPage = await context.newPage();

    // Route HTML for Gemini page
    await geminiPage.route('https://gemini.google.com/app/live_test_chat_1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html>
        <html>
        <head>
          <title>AI Agent Live Auto-Save Test - Google Gemini</title>
        </head>
        <body>
          <h1 data-test-id="conversation-title">AI Agent Live Auto-Save Test</h1>
          <user-query><div class="query-text">Can you live save this message?</div></user-query>
          <model-response><div class="markdown">Yes, live save persists your conversation in real time!</div></model-response>
        </body>
        </html>`
      });
    });

    const mockDetailInner = JSON.stringify([
      [
        ["c_live_test_chat_1", "turn_1", [null, null, ["Can you live save this message?"]]],
        ["c_live_test_chat_1", "turn_2", [null, null, ["Yes, live save persists your conversation in real time!"]]]
      ],
      "token_123",
      "AI Agent Live Auto-Save Test"
    ]);
    const mockRpcResponse = `)]}'\n\n[["wrb.fr","hNvQHb",${JSON.stringify(mockDetailInner)}]]`;

    await geminiPage.route('**/batchexecute*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockRpcResponse
      });
    });

    await geminiPage.goto('https://gemini.google.com/app/live_test_chat_1');
    await geminiPage.waitForLoadState('domcontentloaded');

    // Wait for injected badge
    const badge = geminiPage.locator('#geminiExportBadge');
    await expect(badge).toBeVisible();

    // Trigger live save via window.postMessage with mockMode to test in-page visual badge feedback
    await geminiPage.evaluate(() => {
      window.postMessage({
        type: 'GEMINI_LIVE_SAVE_TRIGGER',
        payload: {
          cid: 'live_test_chat_1',
          reason: 'turn_complete',
          mockMode: true
        }
      }, location.origin);
    });

    // Verify badge received feedback state
    await expect(badge).toHaveClass(/live-saved/, { timeout: 4000 });
    const badgeText = geminiPage.locator('#geminiExportBadgeText');
    await expect(badgeText).toContainText('✓', { timeout: 4000 });

    await geminiPage.close();
  });

  test('should write live save files to gemini_export folder with cid6 filename matching manual export', async ({ context, extensionId }) => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    // Test FsWriter initialization and directory structure consistency
    const result = await optionsPage.evaluate(async () => {
      const written: Record<string, any> = {};
      const mockDir = {
        name: 'MyVault',
        getDirectoryHandle: async (folder: string) => ({
          name: folder,
          getFileHandle: async (file: string) => ({
            createWritable: async () => ({
              write: async (content: any) => { written[`${folder}/${file}`] = content; },
              close: async () => {}
            })
          }),
          getDirectoryHandle: async (subFolder: string) => ({
            name: subFolder,
            getFileHandle: async (assetFile: string) => ({
              createWritable: async () => ({
                write: async (content: any) => { written[`${folder}/${subFolder}/${assetFile}`] = content; },
                close: async () => {}
              })
            })
          })
        })
      };

      const FsWriterModule = (window as any).FsWriter;
      const FsWriterClass = FsWriterModule?.FsWriter || FsWriterModule;
      const writer = new FsWriterClass(mockDir, 'gemini_export');
      await writer.init();

      // Write markdown with cid6
      const cid = 'c_0123456789abcdef';
      const cid6 = cid.replace(/^c_/, '').slice(-6);
      const fileName = `Quantum Computing_${cid6}.md`;
      await writer.writeFile('', fileName, '# Quantum Computing\n\nContent');

      // Write asset into assets/
      await writer.writeFile('assets', `${cid6}_t1_img1.png`, new Uint8Array([1, 2, 3]));

      return {
        writtenFiles: Object.keys(written),
        fileName,
        cid6
      };
    });

    expect(result.cid6).toBe('abcdef');
    expect(result.fileName).toBe('Quantum Computing_abcdef.md');
    expect(result.writtenFiles).toContain('gemini_export/Quantum Computing_abcdef.md');
    expect(result.writtenFiles).toContain('gemini_export/assets/abcdef_t1_img1.png');

    await optionsPage.close();
  });
});
