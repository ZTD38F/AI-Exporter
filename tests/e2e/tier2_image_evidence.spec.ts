import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { normalize, capture } = JSON.parse(execFileSync('python3', ['-c',
    'import json; from scripts.framework.image_evidence import _NORMALIZE_IMAGE, _WEBPAGE_IMAGES; print(json.dumps(dict(normalize=_NORMALIZE_IMAGE, capture=_WEBPAGE_IMAGES)))'],
{ encoding: 'utf8' })) as { normalize: string; capture: string };

test('independent image evidence excludes KaTeX glyphs and keeps generated images in their turn', async ({ page }) => {
    const image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    await page.setContent(`<model-response id="math"><model-response-content><p>Formula</p>
        <span class="katex"><span class="hide-tail"><img class="katex-svg" src="${image}"></span></span>
        <span data-math="x"><img src="${image}"></span>
        <thought-container><img src="${image}"></thought-container>
    </model-response-content></model-response>
    <model-response id="picture"><model-response-content><button class="image-button"><img src="${image}"></button></model-response-content></model-response>`);
    const result = await page.evaluate(capture => new Function('return ' + capture)(), capture) as { images: { turn: number }[] };
    expect(result.images.map(image => image.turn)).toEqual([1]);
    const source = readFileSync('scripts/framework/driver/authored_response.js', 'utf8');
    const hasImages = await page.evaluate(source => {
        const extract = new Function('return (' + source + ')')();
        return [...document.querySelectorAll('model-response')].map(reply => extract(reply).hasImages);
    }, source);
    expect(hasImages).toEqual([false, true]);
});

test('area sampling compares differently sized diagrams and rejects a changed picture', async ({ page }) => {
    const errors = await page.evaluate(normalize => {
        const sample = new Function('return (' + normalize + ')')() as (image: HTMLCanvasElement) => { pixels: number[] };
        const diagram = (width: number, height: number, changed = false) => {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d')!; ctx.scale(width / 1376, height / 768);
            ctx.fillStyle = changed ? '#203040' : '#fffff0'; ctx.fillRect(0, 0, 1376, 768);
            ctx.fillStyle = '#dff4ff'; ctx.fillRect(0, 425, 1376, 343);
            ctx.strokeStyle = '#b01920'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(330, 180); ctx.lineTo(1050, 650); ctx.stroke();
            ctx.fillStyle = '#000'; ctx.font = 'bold 48px sans-serif'; ctx.fillText('REFRACTION OF LIGHT', 170, 70);
            ctx.font = '30px sans-serif'; ctx.fillText('Boundary and normal', 700, 410);
            return sample(canvas).pixels;
        };
        const original = diagram(1376, 768), preview = diagram(1024, 572), wrong = diagram(1376, 768, true);
        const rms = (a: number[], b: number[]) => Math.sqrt(a.reduce((sum, x, i) => sum + (x - b[i]) ** 2, 0) / a.length) / 255;
        return { same: rms(original, preview), wrong: rms(original, wrong) };
    }, normalize);
    expect(errors.same).toBeLessThan(0.01);
    expect(errors.wrong).toBeGreaterThan(0.03);
});
