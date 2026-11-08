// Read the authored answer independently of the extension's parser/exporter.
// This function is embedded in the live CDP driver and exercised in a browser.
(root) => {
    if (!root) return { text: '', hasImages: false, codeBlocks: [], executionBlocks: [] };
    // A streamed answer may have multiple Markdown panels. Read the complete
    // response body, excluding model-level headers and feedback outside it.
    root = root.querySelector('model-response-content') || root;
    // Execution disclosures are accessible source evidence, even when collapsed.
    // Verify exported protocol-tagged execution blocks separately from prose.
    const isExecution = block => !!block.querySelector('.code-result-container')
        || (!!block.querySelector('.code-container') && [...block.querySelectorAll('.code-block')]
            .some(panel => getComputedStyle(panel).display === 'none')
            && !block.closest('thought-container, thought-box, .thought-container, .thought-wrapper, .model-thought, [data-thought]'));
    // Silent executions have a collapsed source panel but no output element.
    // Collect their actual DOM source too; never invent a nonempty stdout.
    const executions = [...root.querySelectorAll('code-block')].filter(isExecution);
    const executionBlocks = executions.map(block => ({
        code: block.querySelector('.code-container')?.textContent || '',
        stdout: block.querySelector('.code-result-container')?.textContent || '',
    }));
    const clone = root.cloneNode(true);
    const clonedExecutions = [...clone.querySelectorAll('code-block')].filter((_, index) => isExecution(root.querySelectorAll('code-block')[index]));
    const originals = [root, ...root.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    originals.forEach((element, index) => {
        const style = getComputedStyle(element);
        // Collapsed tool execution blocks are not part of the final answer.
        if (style.display === 'none' || style.visibility === 'hidden' || element.hidden) {
            copies[index].remove();
        }
    });
    clonedExecutions.forEach(block => block.remove());
    // Canvas attachment previews contain application UI (including code-error
    // cards), not authored prose. Keep the entry chip's sibling title/link.
    clone.querySelectorAll('immersive-entry-chip inline-preview').forEach(element => element.remove());
    clone.querySelectorAll('follow-up, elicitations, elicitations-group, .elicitations-container, [hide-from-message-actions], mini-app, thought-container, thought-box, .thought-container, .thought-wrapper, .model-thought, [data-thought]').forEach(element => element.remove());
    // Gemini keeps the original LaTeX here; rendered glyph order is lossy.
    clone.querySelectorAll('[data-math]').forEach(element => {
        const source = element.getAttribute('data-math') || '';
        // Gemini expands norm aliases and drops optional row spacing in displayed TeX.
        // Keep double norm bars distinct from single absolute-value bars.
        const value = source.replace(/\\\\\s*\[[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:ex|em|pt|pc|px|cm|mm|in)\]/g, '\\\\').replace(/\\Vert\{\}/g, '\\|').replace(/\\vert\{\}/g, '|');
        const replacement = document.createElement('span');
        replacement.dataset.evidenceMath = value;
        replacement.textContent = value;
        element.replaceWith(replacement);
    });
    // Gemini wraps generated images in a clickable button. Read image evidence
    // before removing control text; disk assertions still require real assets.
    const hasImages = [...clone.querySelectorAll('img, [data-image-id]')]
        .some(image => !image.closest('[data-math], .katex, .katex-display, [aria-hidden="true"]'));
    clone.querySelectorAll('button, .code-block-decoration, .cdk-visually-hidden, [aria-hidden="true"]').forEach(element => element.remove());
    const pdfSegments = [];
    let prose = '';
    const flush = () => {
        if (prose.trim()) pdfSegments.push({ kind: 'text', text: prose });
        prose = '';
    };
    const walk = element => {
        if (element.nodeType === Node.TEXT_NODE) { prose += element.textContent; return; }
        if (element.nodeType !== Node.ELEMENT_NODE) return;
        if (element.hasAttribute('data-evidence-math')) {
            const text = element.dataset.evidenceMath;
            // Gemini emits empty data-math placeholders, including empty table cells.
            // They contribute no authored formula or text to PDF evidence.
            if (text.trim()) { flush(); pdfSegments.push({ kind: 'math', text }); }
            return;
        }
        if (element.tagName === 'PRE') {
            flush(); pdfSegments.push({ kind: 'code', text: (element.querySelector('code') || element).textContent }); return;
        }
        const boundary = /^(P|H[1-6]|LI|TH|TD|BLOCKQUOTE)$/.test(element.tagName);
        if (boundary) flush();
        element.childNodes.forEach(walk);
        if (boundary) flush();
    };
    walk(clone); flush();
    return {
        pdfSegments,
        text: (clone.textContent || '').trim(),
        hasImages,
        codeBlocks: [...clone.querySelectorAll('pre')].map(pre => (pre.querySelector('code') || pre).textContent || ''),
        executionBlocks,
    };
}
