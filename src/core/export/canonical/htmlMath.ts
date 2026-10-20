import katex from 'katex';
import type { RenderDiagnostic } from './rendering.js';
import { getRendererStrings } from './rendererStrings.js';

export interface RenderMathHtmlResult {
    html: string;
    diagnostic?: RenderDiagnostic;
}

function escapeHtml(text?: string | null): string {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Renders a LaTeX math expression into accessible, offline-safe MathML for HTML exports.
 *
 * Supported math:
 * - Typesets expressions (fractions, square roots, matrices, Greek symbols, scripts, operators, etc.)
 *   into native W3C MathML (<math xmlns="http://www.w3.org/1998/Math/MathML">...</math>).
 * - Requires ZERO external fonts, stylesheets, or network requests; fully offline-compatible.
 *
 * Unsupported or malformed math (e.g. TikZ diagrams, unknown LaTeX macros):
 * - Emits a diagnostic warning.
 * - Gracefully falls back to a readable, copyable source block with localized diagnostic label.
 */
export function renderMathHtml(
    source: string,
    display: boolean,
    isEn: boolean,
): RenderMathHtmlResult {
    let cleanSource = (source ?? '').trim();
    // Strip accidental boundary delimiters if present
    if (cleanSource.startsWith('$$') && cleanSource.endsWith('$$') && cleanSource.length >= 4) {
        cleanSource = cleanSource.slice(2, -2).trim();
    } else if (cleanSource.startsWith('$') && cleanSource.endsWith('$') && cleanSource.length >= 2) {
        cleanSource = cleanSource.slice(1, -1).trim();
    }

    if (!cleanSource) {
        return {
            html: display ? '<div class="gem-math-block gem-math-empty"></div>' : '',
            diagnostic: {
                severity: 'warning',
                code: 'HTML_MATH_EMPTY',
                message: 'Empty math source; no formula rendered.',
            },
        };
    }

    const strings = getRendererStrings(isEn ? 'en' : 'zh');

    // Detect known unsupported environments such as TikZ diagrams
    if (/\\begin\{(?:tikzpicture|pgfpicture)\}/i.test(cleanSource)) {
        return {
            html: renderFallback(cleanSource, display, strings.mathFallback),
            diagnostic: {
                severity: 'warning',
                code: 'HTML_MATH_UNSUPPORTED_TIKZ',
                message: 'LaTeX TikZ diagram cannot be rendered as HTML math; raw source preserved.',
            },
        };
    }

    try {
        const mathml = katex.renderToString(cleanSource, {
            output: 'mathml',
            displayMode: display,
            throwOnError: true,
        });
        const container = display
            ? `<div class="gem-math-block">${mathml}</div>`
            : `<span class="gem-math-inline">${mathml}</span>`;
        return { html: container };
    } catch (err: any) {
        const errMsg = err?.message || String(err);
        return {
            html: renderFallback(cleanSource, display, strings.mathFallback),
            diagnostic: {
                severity: 'warning',
                code: 'HTML_MATH_RENDER_FAILED',
                message: `LaTeX formula could not be typeset (${errMsg}); raw source preserved.`,
            },
        };
    }
}

function renderFallback(source: string, display: boolean, fallbackLabel: string): string {
    if (display) {
        return `<div class="gem-math-block gem-math-unsupported">
  <div class="gem-math-fallback-label">${escapeHtml(fallbackLabel)}</div>
  <pre class="gem-math-fallback-source"><code>${escapeHtml(source)}</code></pre>
</div>`;
    }
    return `<code class="gem-inline-code gem-math-inline-fallback" title="${escapeHtml(fallbackLabel)}">${escapeHtml(source)}</code>`;
}
