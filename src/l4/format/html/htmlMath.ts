import katex from 'katex';
import { CENTERED_NOT_IMPLIES_COMPAT_RULE } from '../../../shared/utils/latexCompatibility.js';
import type { Diagnostic as RenderDiagnostic } from '../../../shared/diagnostics/diagnostic.js';
import { getErrorMessage } from '../../../shared/utils/errorText.js';

interface RenderMathHtmlResult {
    html: string;
    diagnostic?: RenderDiagnostic;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Renders a LaTeX math expression into accessible, offline-safe MathML for HTML exports.
 * - Requires ZERO external fonts, stylesheets, or network requests; fully offline-compatible.
 * Unsupported or malformed math (e.g. TikZ diagrams, unknown LaTeX macros):
 * - Gracefully falls back to a readable, copyable source block with localized diagnostic label.
 */
export function renderMathHtml(
    source: string,
    display: boolean,
    fallbackLabel: string,
): RenderMathHtmlResult {
    // Math source is already normalized at the parser/content boundary.
    if (!source.trim()) {
        return {
            html: display ? '<div class="gem-math-block gem-math-empty"></div>' : '',
            diagnostic: {
                severity: 'warning',
                code: 'HTML_MATH_EMPTY',
                message: 'Empty math source; no formula rendered.',
            },
        };
    }

    if (/\\begin\{(?:tikzpicture|pgfpicture)\}/i.test(source)) {
        return {
            html: renderFallback(source, display, fallbackLabel),
            diagnostic: {
                severity: 'warning',
                code: 'HTML_MATH_UNSUPPORTED_TIKZ',
                message: 'LaTeX TikZ diagram cannot be rendered as HTML math; raw source preserved.',
            },
        };
    }

    try {
        const adapted = CENTERED_NOT_IMPLIES_COMPAT_RULE.transform(source);
        const mathml = katex.renderToString(adapted, {
            output: 'mathml',
            displayMode: display,
            throwOnError: true,
        });
        // Keep the original authoring source available for copy/accessibility audits.
        const preserved = mathml.replace(/(<annotation encoding="application\/x-tex">)[\s\S]*?(<\/annotation>)/,
            (_match, open: string, close: string) => open + escapeHtml(source) + close);
        const container = display
            ? `<div class="gem-math-block">${preserved}</div>`
            : `<span class="gem-math-inline">${preserved}</span>`;
        return { html: container };
    } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        return {
            html: renderFallback(source, display, fallbackLabel),
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
