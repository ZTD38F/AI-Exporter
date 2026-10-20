# Follow-up: Gemini's structured RPC document layer

## Executive finding

For all three Tier 2 cases, Gemini's `hNvQHb` conversation-detail RPC already includes a serialized structured document alongside the raw model Markdown. The production frontend decodes that document into `structuredContent`, then passes it directly to the structured document renderer. This is a concrete intermediate layer available to gemini-exporter through its existing detail RPC path; for online conversations, it can bypass local Markdown parsing. The actual Markdown parser that creates the wire document is upstream of the observed RPC response and cannot be named from these browser artifacts. No production parser or export code was changed.

## Data flow proved by the probe

```text
hNvQHb response
  turn[3][0][0][1][0]  raw model Markdown
  turn[3][12][0][0]   serialized structured document node list
       ↓ frontend response decoding
response.structuredContent.children
       ↓ structured-content-container input
       ↓ Jth.transform -> OY.render -> OY.Fc / OY.oa
rendered output
```

The existing repository's `parseDetail` already unwraps `hNvQHb`, finds `inner[0]` turns, and retains the decoded response as `_raw`. Thus the structured field is present in data already fetched for the normal online detail path. `turn[3][12][0][0]` is an **observed positional wire path**, not a documented Google API guarantee.

The CDP stack at the A display node enters `OY.Fc` (renderer chunk line 3645), `OY.render` (3613), then `Jth.transform` in a second chunk (line 2412). At that transform frame, the response object owns `structuredContent`; `OY.render` receives its `children` unchanged as a document root. The corresponding table stack enters `OY.oa` and reaches the same transform. The component feeding this transform maps its `content` input to `structuredContent` (second chunk line 6100). The transform checks that this field exists and renders it; there is no raw Markdown parsing call in this observed renderer path.

The RPC itself proves the structure predates frontend rendering. The target formula/table strings appear twice in decoded `hNvQHb`: once in raw Markdown and again in the serialized document under field 12, already normalized and classified. The verifier compares those serialized strings to the runtime `structuredContent` strings **exactly**, and checks root child counts:

| Case | RPC root nodes | Runtime root nodes | Matching structured value / shape |
|---|---:|---:|---|
| A | 50 | 50 | Display math value `W^{(1)}_{RB}...\end{cases}` is identical in wire and runtime node (`nodeType: 12`). |
| B | 49 | 49 | Display math `A(a, \lambda) = \pm 1, ...` is identical (`nodeType: 12`), separate from prose. |
| C, `$|\alpha|^2$` | 1 | 1 | Table text contains `\vert{}\alpha\vert{}^2` with math annotation; runtime table (`nodeType: 17`) has five cells in every row. |
| C, `$\|\psi\rangle$` | 3 | 3 | Table text contains `\Vert{}\psi\rangle` with math annotation; runtime table has three cells in every row. |

The exact array paths and SHA-256 hashes are in local `parser-trace/intermediate-proof.json`. Run `python3 tests/live/probes/gemini_renderer_probe/verify_intermediate.py artifacts/gemini-renderer-probe` to reproduce all four assertions without opening a browser. Its SHA-256 is `8c0918d4aa5bbcd3bfaeba9b2e8752a09638102a0e05903e3489825c97cf3244`.

## Parser identification and route choice

The browser evidence does not identify a third-party Markdown parser or prove a Google custom parser implementation. The relevant frontend code is a decoder/structured renderer; the parse result is already in the RPC response. Digging further into JS bundles cannot reveal the upstream parser implementation from this path. The **intermediate-layer route is established** and is more directly useful to exporter than selecting a replacement Markdown library based on these cases.

Recommendation for a separate implementation task: decode the RPC structured document into the project's own Canonical AST for online model responses, guarded by schema validation and raw-Markdown fallback. Do not copy Google's renderer code. The adapter would need coverage for the observed document node types and inline annotations, plus broader syntax/attachment fixtures before replacing the current parser. Google Takeout and other offline/raw-only inputs have no demonstrated `hNvQHb` structured field and still need a Markdown path. The wire schema may drift, so an explicit availability check and fallback are necessary.

## Evidence inventory

Ignored local evidence root: `artifacts/gemini-renderer-probe/parser-trace/`.

- `a-stack.json`, `b-stack.json`, `table-stack.json`, `psi-table-stack.json`: CDP call frames, relevant argument shapes and line offsets.
- Matching `*-structured.json`: exact runtime structured roots read at the renderer boundary.
- `intermediate-proof.json`: four wire/runtime equality checks, response hashes, field paths and row cell counts.
- `b-stack-scripts.json`: script URL, offset, byte count and SHA-256 for the two runtime-traced chunks. Renderer chunk SHA-256 `16b05b7dc7bddd404309eb41034f95ab962b46afa300837e77bca8c3ba2977ef`; transform chunk SHA-256 `ad9f0641b7dcc371625efc7256e82f580db7c13adb3fc0ca6cc4bd9fa2344540`. Chunk contents remain local only.
- Existing per-case `rpc-*.txt` files: original `hNvQHb` responses. A/C-alpha response SHA-256 begins `48dde3051a8a0204`; B/C-psi begins `ba9d0b9e7d7f644a`.

The two sampled conversations cover every requested shape but do not establish field-12 availability for all past/future Gemini responses. The finding is sufficient to choose the intermediate-layer direction, while implementation coverage remains a separate task.
