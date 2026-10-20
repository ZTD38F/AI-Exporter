import { visual } from '../../export/visualContract';

function escapeHtml(text?: string | null): string {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(text?: string | null): string {
    return escapeHtml(text);
}

export function sanitizeUrl(rawUrl?: string | null, allowImageData: boolean = false): string {
    if (!rawUrl || typeof rawUrl !== 'string') return '#';
    const trimmed = rawUrl.trim();
    if (!trimmed) return '#';

    if (/[\u0000-\u001F\u007F-\u009F]/.test(trimmed)) return '#';

    const schemeMatch = trimmed.match(/^([a-zA-Z0-9+.-]+):/);
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme === 'javascript' || scheme === 'vbscript') {
            return '#';
        }
        if (scheme === 'data') {
            if (allowImageData && /^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(trimmed)) {
                return escapeAttr(trimmed);
            }
            return '#';
        }
        if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto' && scheme !== 'tel') {
            return '#';
        }
    }
    return escapeAttr(trimmed);
}

export const GEM_HTML_CSS = `
:root {
  --sp-inline: ${visual.spacing.inline}px;
  --sp-paragraph: ${visual.spacing.paragraph}px;
  --sp-block: ${visual.spacing.block}px;
  --sp-section: ${visual.spacing.section}px;
  --sp-turn: ${visual.spacing.turn}px;
  --content-width: ${visual.content.maxWidth}px;
  --prose-width: ${visual.content.proseWidth}px;
  --page-side-padding: ${visual.content.pageSidePadding}px;
  --bg-main: #131314;
  --bg-user-bubble: #282a2c;
  --bg-card: #1e1f20;
  --bg-card-hover: #2d2f31;
  --text-primary: #e3e3e3;
  --text-secondary: #9aa0a6;
  --text-muted: #757575;
  --border-color: #3c4043;
  --accent-blue: #a8c7fa;
  --accent-blue-hover: #8ab4f8;
  --code-bg: #1e1f20;
  --code-border: #3c4043;
  --table-stripe: rgba(255, 255, 255, 0.02);
  --math-color: #c4eed0;
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
}

@media (prefers-color-scheme: light) {
  :root {
    --bg-main: #ffffff;
    --bg-user-bubble: #f0f4f9;
    --bg-card: #f8f9fa;
    --bg-card-hover: #eef0f3;
    --text-primary: #1f1f1f;
    --text-secondary: #444746;
    --text-muted: #747775;
    --border-color: #e0e2e5;
    --accent-blue: #0b57d0;
    --accent-blue-hover: #0842a0;
    --code-bg: #f8f9fa;
    --code-border: #e0e2e5;
    --table-stripe: rgba(0, 0, 0, 0.02);
    --math-color: #0f5132;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
  }
}

body.light-theme {
  --bg-main: #ffffff;
  --bg-user-bubble: #f0f4f9;
  --bg-card: #f8f9fa;
  --bg-card-hover: #eef0f3;
  --text-primary: #1f1f1f;
  --text-secondary: #444746;
  --text-muted: #747775;
  --border-color: #e0e2e5;
  --accent-blue: #0b57d0;
  --accent-blue-hover: #0842a0;
  --code-bg: #f8f9fa;
  --code-border: #e0e2e5;
  --table-stripe: rgba(0, 0, 0, 0.02);
  --math-color: #0f5132;
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background-color: var(--bg-main);
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Google Sans", Helvetica, Arial, sans-serif;
  font-size: ${visual.type.body.size}px;
  line-height: ${visual.type.body.lineHeight};
  -webkit-font-smoothing: antialiased;
}

/* Conversation Container - 1:1 Gemini Pure Stream */
.gem-container {
  max-width: calc(var(--content-width) + 2 * var(--page-side-padding));
  margin: 0 auto;
  padding: 40px var(--page-side-padding) 80px;
}

/* Conversation title is the strongest document anchor. */
.gem-conversation-header { max-width: var(--prose-width); margin-bottom: var(--sp-section); }
.gem-conversation-title {
  font-size: ${visual.type.title.size}px;
  font-weight: ${visual.type.title.weight};
  line-height: ${visual.type.title.lineHeight};
  overflow-wrap: anywhere;
}
.gem-conversation-metadata {
  margin-top: var(--sp-inline);
  font-size: ${visual.type.metadata.size}px;
  line-height: ${visual.type.metadata.lineHeight};
  color: var(--text-muted);
}

/* Turn Items */
.gem-turn {
  margin-bottom: var(--sp-turn);
}

.gem-turn-user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.gem-user-bubble {
  background: var(--bg-user-bubble);
  color: var(--text-primary);
  border-radius: 20px 20px 4px 20px;
  padding: 14px 18px;
  max-width: min(85%, var(--prose-width));
  font-size: ${visual.type.body.size}px;
  line-height: ${visual.type.body.lineHeight};
  box-shadow: var(--shadow-sm);
  word-break: break-word;
}

.gem-prompt-content.collapsed {
  max-height: 120px;
  overflow: hidden;
  position: relative;
  mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
}

.gem-prompt-content.expanded {
  max-height: none;
  mask-image: none;
  -webkit-mask-image: none;
}

.gem-prompt-toggle {
  background: transparent;
  border: none;
  color: var(--accent-blue);
  font-size: ${visual.type.small.size}px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  transition: background 0.2s;
}
.gem-prompt-toggle:hover {
  background: rgba(255, 255, 255, 0.08);
}
.gem-prompt-toggle.expanded .chevron-icon {
  transform: rotate(180deg);
}

.gem-att-card {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  text-decoration: none;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
  max-width: 240px;
}
.gem-att-card:hover {
  background: var(--bg-card-hover);
  border-color: var(--accent-blue);
}

.gem-att-preview {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  overflow: hidden;
  flex: none;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.gem-att-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gem-att-icon {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  background: rgba(168, 199, 250, 0.12);
  color: var(--accent-blue);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.gem-att-info {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex: 1;
}

.gem-att-name {
  font-size: ${visual.type.small.size}px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gem-att-badge {
  font-size: ${visual.type.metadata.size}px;
  line-height: ${visual.type.metadata.lineHeight};
  color: var(--text-muted);
  text-transform: uppercase;
}

.gem-att-open-btn {
  color: var(--text-muted);
  display: flex;
  align-items: center;
  padding: 4px;
  border-radius: 4px;
}
.gem-att-card:hover .gem-att-open-btn {
  color: var(--accent-blue);
}

/* Model Turn */
.gem-turn-model {
  display: flex;
  flex-direction: column;
  margin-bottom: var(--sp-turn);
}

.gem-model-content {
  color: var(--text-primary);
  font-size: ${visual.type.body.size}px;
  line-height: ${visual.type.body.lineHeight};
  word-break: break-word;
}

/* Thinking Process Accordion */
.gem-thoughts {
  margin-bottom: var(--sp-block);
  border-left: 2px solid var(--border-color);
  padding-left: 12px;
}

.gem-thoughts-summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
}
.gem-thoughts-summary::-webkit-details-marker {
  display: none;
}

.gem-thoughts-header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: ${visual.type.small.size}px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.2s, color 0.2s;
}
.gem-thoughts-header:hover {
  background: var(--bg-card);
  color: var(--text-primary);
}

.gem-thoughts[open] .gem-thought-chevron {
  transform: rotate(180deg);
}

.gem-thoughts-content {
  margin-top: var(--sp-paragraph);
  font-size: ${visual.type.small.size}px;
  color: var(--text-secondary);
  line-height: ${visual.type.small.lineHeight};
  font-style: italic;
}

/* Semantic prose measure leaves tables, code, media and display math wide. */
.gem-turn-model .gem-paragraph,
.gem-turn-model .gem-heading,
.gem-turn-model .gem-blockquote {
  max-width: var(--prose-width);
}
.gem-turn-model .gem-list {
  max-width: calc(var(--prose-width) - 1.8em);
}
@media (max-width: 600px) {
  .gem-container { padding-inline: calc(var(--page-side-padding) / 2); }
}

/* Explicit rhythm also prevents outer paragraph margins from inflating turns. */
.gem-model-content > :first-child, .gem-prompt-content > :first-child { margin-top: 0; }
.gem-model-content > :last-child, .gem-prompt-content > :last-child { margin-bottom: 0; }

/* Content Elements */
.gem-paragraph {
  margin: var(--sp-paragraph) 0;
}

.gem-heading {
  font-weight: 600;
  margin: var(--sp-section) 0 var(--sp-paragraph);
  color: var(--text-primary);
}
h1.gem-heading { font-size: ${visual.type.title.size}px; font-weight: ${visual.type.title.weight}; line-height: ${visual.type.title.lineHeight}; }
h2.gem-heading { font-size: ${visual.type.h2.size}px; font-weight: ${visual.type.h2.weight}; line-height: ${visual.type.h2.lineHeight}; }
h3.gem-heading { font-size: ${visual.type.h3.size}px; font-weight: ${visual.type.h3.weight}; line-height: ${visual.type.h3.lineHeight}; }
h4.gem-heading, h5.gem-heading, h6.gem-heading { font-size: ${visual.type.body.size}px; font-weight: ${visual.type.h3.weight}; line-height: ${visual.type.h3.lineHeight}; }

.gem-blockquote {
  border-left: 3px solid var(--accent-blue);
  margin: var(--sp-block) 0;
  padding: 0.6em 1.2em;
  background: rgba(168, 199, 250, 0.06);
  border-radius: 0 8px 8px 0;
  color: var(--text-secondary);
}

.gem-hr {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: var(--sp-section) 0;
}

.gem-list {
  margin: var(--sp-paragraph) 0 var(--sp-paragraph) 1.8em;
}
.gem-list li {
  margin-bottom: var(--sp-inline);
}

.gem-inline-code {
  background: var(--bg-card);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: ${visual.type.small.size}px;
  border: 1px solid var(--border-color);
}

.gem-code-block {
  margin: var(--sp-block) 0;
  border: 1px solid var(--code-border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--code-bg);
}

.gem-code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 14px;
  background: rgba(0, 0, 0, 0.15);
  border-bottom: 1px solid var(--code-border);
}

.gem-code-lang {
  font-size: ${visual.type.metadata.size}px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: lowercase;
}

.gem-copy-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: ${visual.type.metadata.size}px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}
.gem-copy-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}
.gem-copy-btn.copied {
  color: #34d399;
}

.gem-code-block pre {
  margin: 0;
  padding: 14px 16px;
  overflow-x: auto;
}
.gem-code-block code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: ${visual.type.small.size}px;
  line-height: ${visual.type.small.lineHeight};
}

.gem-table-wrapper {
  overflow-x: auto;
  margin: var(--sp-block) 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}
.gem-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.gem-table th, .gem-table td {
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  text-align: left;
}
.gem-table th {
  background: var(--bg-card);
  font-weight: 600;
}
.gem-table tr:nth-child(even) {
  background: var(--table-stripe);
}

.gem-math-inline {
  display: inline-block;
  vertical-align: middle;
  padding: 0 2px;
}
.gem-math-block {
  margin: var(--sp-block) 0;
  text-align: center;
  overflow-x: auto;
  padding: 10px;
}

.gem-msg-img {
  max-width: 100%;
  border-radius: 12px;
  margin: var(--sp-block) 0;
  cursor: pointer;
  transition: opacity 0.2s;
}
.gem-msg-img:hover {
  opacity: 0.95;
}

.gem-img-link {
  display: inline-block;
}

.gem-link {
  color: var(--accent-blue);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.gem-empty-notice {
  text-align: center;
  color: var(--text-muted);
  padding: 60px 0;
  font-size: ${visual.type.body.size}px;
}

/* High Fidelity Print Stylesheet (@media print) for direct PDF output */
@media print {
  @page {
    margin: 15mm 15mm 15mm 15mm;
    size: A4 portrait;
  }
  body {
    background: #ffffff !important;
    color: #111111 !important;
  }
  .gem-copy-btn, .gem-prompt-toggle, .gem-att-open-btn {
    display: none !important;
  }
  .gem-container {
    max-width: 100% !important;
    padding: 0 !important;
  }
  .gem-turn-user {
    align-items: flex-start !important;
  }
  .gem-user-bubble {
    background: #f4f6f8 !important;
    color: #111111 !important;
    border: 1px solid #dcdfe3 !important;
    max-width: 100% !important;
    box-shadow: none !important;
  }
  .gem-prompt-content.collapsed {
    max-height: none !important;
    mask-image: none !important;
    -webkit-mask-image: none !important;
  }
  .gem-thoughts {
    border-left-color: #777 !important;
  }
  .gem-thoughts-content {
    display: block !important;
    color: #444 !important;
  }
  .gem-code-block, .gem-table-wrapper, .gem-att-card, blockquote, img {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .gem-code-block {
    background: #f8f9fa !important;
    border-color: #dcdfe3 !important;
  }
  .gem-code-block pre code {
    color: #111111 !important;
  }
  .gem-table th, .gem-table td {
    border-color: #ccc !important;
    color: #111111 !important;
  }
  .gem-table th {
    background: #f0f2f5 !important;
  }
  a {
    color: #0b57d0 !important;
    text-decoration: underline !important;
  }
}
`;
export const GEM_HTML_SCRIPT = `
// Copy code button handler with offline file:/// fallback
function copyCode(btn) {
  var block = btn.closest('.gem-code-block');
  if (!block) return;
  var codeEl = block.querySelector('pre code');
  if (!codeEl) return;
  var text = codeEl.textContent || '';
  
  function showSuccess() {
    var label = btn.querySelector('.copy-text');
    if (label) {
      var orig = label.textContent;
      label.textContent = '已复制 ✓';
      btn.classList.add('copied');
      setTimeout(function() {
        label.textContent = orig;
        btn.classList.remove('copied');
      }, 2000);
    }
  }

  function fallbackCopy() {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var successful = document.execCommand('copy');
      document.body.removeChild(ta);
      if (successful) showSuccess();
    } catch (err) {}
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(showSuccess).catch(function() {
      fallbackCopy();
    });
  } else {
    fallbackCopy();
  }
}

// Expand / collapse user prompt
function togglePrompt(btn, showMore, showLess) {
  var content = btn.previousElementSibling;
  if (!content) return;
  var isCollapsed = content.classList.contains('collapsed');
  if (isCollapsed) {
    content.classList.remove('collapsed');
    content.classList.add('expanded');
    btn.classList.add('expanded');
    btn.querySelector('.toggle-text').textContent = showLess;
  } else {
    content.classList.remove('expanded');
    content.classList.add('collapsed');
    btn.classList.remove('expanded');
    btn.querySelector('.toggle-text').textContent = showMore;
  }
}
`;

