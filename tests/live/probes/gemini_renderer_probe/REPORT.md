# Gemini Web renderer probe (production, 2026-09-29)

**Follow-up finding:** [STRUCTURED_RPC_FINDING.md](STRUCTURED_RPC_FINDING.md) traces the renderer input back to a structured document already present in `hNvQHb`. It supersedes this report's earlier uncertainty about whether the RPC supplies the document tree and its recommendation to defer the route choice.

## Executive finding

The production page receives plain model Markdown in its `hNvQHb` `batchexecute` response and renders a structured document tree with separate math block and inline math paths. Its math renderer is reachable as `window.katex` version `0.16.28`. The current micromark pipeline disagrees at math fence recognition (A/B) and GFM table splitting (C). The targeted runtime chunk does not establish the identity of Gemini's Markdown parser or whether math protection is a separate prepass or part of a combined parser.

## Evidence and comparison

The raw texts below were extracted from decoded production RPC response strings, not reconstructed from the extension's export. Each case directory contains the complete `raw.md`, its `raw-source.json` with response SHA-256 and JSON path, rendered DOM, mutation stacks, KaTeX calls, loaded resources, and our parser's MDAST/Canonical result. The `exported-snippet.md` files are independently preserved Tier 2 export references.

### A — multiline display formula

Raw source (inside a list item):

```text
  $$W^{(1)}_{RB}(v) = \begin{cases} 
  0 & \text{若 } v \in C_{RG} \quad (\text{使该边在第二阶段能无代价免费选用}) \\ 
  W^{(0)}(v) & \text{若 } v \notin C_{RG} 
  \end{cases}$$
```

Gemini produced a `DIV.math-block[data-math]` inside the list item. Its `data-math` begins with `W^{(1)}_{RB}(v) = \begin{cases}` and ends with `\end{cases}`; neither fence is part of the TeX. The `katex.render` call receives that formula with `displayMode: true`. The `data-math` assignment stack passes through the page chunk's `E2f` at line 3594, and the KaTeX call passes through `C2f` at line 3598. Whitespace is normalized before this call.

Current `mdast-util-from-markdown` + GFM + math yields a nested `math` node whose value starts with `0 & ...` and ends with `\end{cases}$$`. `mdastToCanonical` carries that damaged value into `math.source`. The opening line's formula is consumed as fence metadata and the trailing same-line `$$` is not recognized as a close. The divergence occurs before Canonical adaptation.

### B — display formula immediately after prose

Raw source:

```text
假设测量结果仅能取值 $+1$ 或 $-1$（对应自旋朝上或朝下）：
$$A(a, \lambda) = \pm 1, \quad B(b, \lambda) = \pm 1$$
```

Gemini's prose is a `P`; the next sibling is a separate `DIV.math-block[data-math]`. The TeX passed to `katex.render` is `A(a, \lambda) = \pm 1, \quad B(b, \lambda) = \pm 1`, with `displayMode: true`. The same `E2f`/`C2f` stack path appears. The current MDAST and Canonical output keep the formula as `inlineMath` inside the preceding paragraph, after a line break. The divergence occurs at block/inline math boundary recognition.

### C — pipes inside table math

Two real RPC examples were captured:

```text
... $|\alpha|^2$ ...
... $\|\psi\rangle = \alpha\|0\rangle + \beta\|1\rangle$ ...
```

For the first example, Gemini's table row has five cells, matching its five-column header; the entire formula remains in one `TD > P > SPAN.math-inline[data-math]`. The exact TeX passed to `katex.render` is `\vert{}\alpha\vert{}^2`, with `displayMode: false`. For the second, the table row has three cells and the TeX passed to KaTeX is `\Vert{}\psi\rangle = \alpha\Vert{}0\rangle + \beta\Vert{}1\rangle`, also with `displayMode: false`. Thus the raw `|` and `\|` are transformed before the KaTeX call, respectively to `\vert{}` and `\Vert{}`. Their original spellings do **not** reach KaTeX unchanged.

Our current parser turns the five-column `|\alpha|^2` row into seven cells; the pipe characters become separators and `\alpha` survives as text in a displaced cell. Its Canonical table also has seven cells for that row. For the `\|\psi` example, current MDAST retains the inline math in a three-cell row, with the original `\|` spelling. Gemini must protect math-internal pipes no later than table cell splitting. The captures cannot distinguish a protected math prepass from a combined table/math tokenizer.

## Renderer architecture and dependency finding

Observed path:

```text
RPC model Markdown string
  -> structured document nodes (including table and display-math node types,
     and inline math annotations)
  -> Gemini client HTML/math-node renderer
  -> KaTeX 0.16.28 render(..., {displayMode, output:'html', ...})
  -> DOM
```

The runtime stack for `data-math` is `E2f` (chunk line 3594:430), `G2f` (3598:115), and document-node renderer `OY.Fc` (3645:399). A nearby node-type dispatch handles table and math nodes separately; the inline text renderer consumes annotations. This proves classification precedes KaTeX and final DOM construction. It does **not** prove where the Markdown parser runs, or the precise order of a math prepass versus table parsing. The decoded RPC response contains the plain model text, while no parser source map, package banner, or distinctive upstream Markdown parser signature was found in the targeted renderer chunk. Consequently no third-party Markdown parser name/version/options can be established. KaTeX is identifiable by the exposed runtime version and bundled API, but it is not the Markdown parser.

The traced chunk is the `boq-gemini-web-uiserver.BardChatUi.en.oaEcnaS9CrQ.2018.O` resource recorded in `chunks/source.json`; its SHA-256 is `16b05b7dc7bddd404309eb41034f95ab962b46afa300837e77bca8c3ba2977ef` (2,213,815 bytes). Only the runtime-identified call sites were inspected. The chunk is a local uncommitted evidence file; no proprietary implementation code is copied into this probe.

## Recommendation

**Further investigation required before choosing a parser migration.** The three observable behaviors are clear enough to build focused compatibility tests, but parser identity and the exact table/math tokenization stage remain unproven. A small compatibility layer around the current parser is the most plausible first implementation candidate; switching the whole Markdown stack has no supporting evidence yet. This task makes no production changes.

## Evidence inventory

Local deterministic root: `artifacts/gemini-renderer-probe/`. Each case contains `raw.md`, `raw-source.json`, `rendered.html`, `dom.json`, `math-calls.json`, `mutation-stacks.json`, `resources.json`, and `current-parser.json`. RPC response bodies and the traced JS chunk are retained locally only. The key SHA-256 prefixes are:

| Case | raw.md | dom.json | current-parser.json |
|---|---|---|---|
| A | `699f3274389e81f8` | `9f28a1d4fb2a3f4a` | `320c6b146d809245` |
| B | `acca5d2772b3efeb` | `66c3eaf22bd9f286` | `a04891cedeca3a77` |
| C, `$|\alpha|^2$` | `8351895c30eaa6c7` | `e0bb42e62abdd2c4` | `8f8cc008f2e9d7b5` |
| C, `$\|\psi\rangle$` | `d371f9c834778d9d` | `eca0d8ab27a2ebe4` | `09ad52888539011b` |

Probe limitations: local evidence contains entire historical model responses and DOM/stack data, so it is intentionally not committed. The C alpha KaTeX call file was selected from the earlier full reload of the same conversation (`math-calls-provenance.json`), because a later page load populated DOM from cache before the global wrapper attached. The global KaTeX hook leaves the original arguments and return path unchanged; `data-math` interception forwards the original `setAttribute` call unchanged.
