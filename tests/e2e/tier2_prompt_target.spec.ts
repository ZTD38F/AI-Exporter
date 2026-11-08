import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

test('Tier 2 prompt target preserves a Canvas document and ignores the hidden Quill clipboard', async ({ context }) => {
    const selector = execFileSync('python3', ['-c', 'from scripts.framework.selectors import GeminiSelectors; print(GeminiSelectors.EDITOR)'],
        { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }).trim();
    const page = await context.newPage();
    await page.setContent(`<div class="ProseMirror" contenteditable="true" aria-label="Canvas editor">Saved document contents</div>
        <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox">Previous prompt</div>
        <div class="ql-clipboard" contenteditable="true" style="display:none">Clipboard</div></rich-textarea>`);
    const target = page.locator(selector);
    await expect(target).toHaveCount(1);
    await target.fill('Next question');
    await expect(target).toHaveText('Next question');
    await expect(page.locator('.ProseMirror')).toHaveText('Saved document contents');
    await expect(page.locator('.ql-clipboard')).toHaveText('Clipboard');
});
