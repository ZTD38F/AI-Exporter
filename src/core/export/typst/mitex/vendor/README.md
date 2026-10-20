# Vendored MiTeX Engine, Provenance & Production Policy

> **MiTeX is the only LaTeX → Typst converter.**  
> **Raw-LaTeX fallback guarantees export reliability.**  
> **A downstream MiTeX fork, if introduced later, exists only to improve generic MiTeX coverage — never as the runtime fallback.**

---

## 1. Provenance & Artifacts

### Upstream Source
- **Project**: [MiTeX](https://github.com/mitex-rs/mitex)
- **Version**: `0.2.5`
- **Upstream Commit**: `192593c5b817f6c38afd7888f7c84e514c759cf9` (`chore: bump version to 0.2.5 (#186)`)
- **Authors**: `Myriad-Dreamin <camiyoru@gmail.com>`, `OrangeX4 <orangex4@qq.com>`, `mgt <mgt@oi-wiki.org>`, `Enter-tainer`
- **License**: `Apache-2.0`

### Vendored WASM & JS Glue (`src/core/export/typst/mitex/vendor/`)
- **Package Source**: Third-party npm build `mitex-wasm@0.2.5` (`https://registry.npmjs.org/mitex-wasm/-/mitex-wasm-0.2.5.tgz`, tarball sha1 `c88755f21c4462748c043dccdd9a5c90cc74f2d8`, published to npm by `sharevb <sharevb@gmail.com>`, compiled with `wasm-bindgen 0.2.92`).
- **`mitex_wasm_bg.wasm`**:
  - File Size: `230,735` bytes
  - SHA256: `7907415f9e7bbc8447dd2ac1d9a4b7bbc3f4f42b96f855d41883dc39f904c0cf`
- **`mitex_wasm_bg.js`**: `wasm-bindgen` JavaScript bindings from `mitex-wasm@0.2.5`.
- **`mitex_wasm_bg.d.ts`**: TypeScript declarations adapted from `mitex_wasm.d.ts` in `mitex-wasm@0.2.5` (with `__wbg_set_wasm` export declaration added for `mitex_wasm_bg.js`).

### Typst Scope (`src/core/export/typst/templates/mitex-scope.typ`)
- **Source**: `@preview/mitex:0.2.5` (`https://packages.typst.org/preview/mitex-0.2.5.tar.gz`, matching upstream commit `192593c5b817f6c38afd7888f7c84e514c759cf9`: `packages/mitex/specs/prelude.typ` and `packages/mitex/specs/latex/standard.typ`).
- **Integration Modification**: Consolidates `specs/prelude.typ` and `specs/latex/standard.typ` into a single self-contained file (removing `#import "../prelude.typ": *`), adds a 3-line file header comment, and appends `#let mitex-scope = scope` at the end.
- **Mapping Integrity**: No LaTeX command mappings were intentionally changed (retains upstream v0.2.5 definitions verbatim, including upstream `$kai A T E X$`).

---

## 2. Production Architecture & Failure Contract

### Single Converter
Production uses **only MiTeX** for LaTeX → Typst conversion (`Canonical math source → MiTeX → Typst math → Typst → PDF`). Do not restore the legacy handwritten converter, introduce a second converter (`tex2typst`, etc.), route failures to a backup TeX engine, or maintain a project-level command mapping table.

### Failure Handling
A single broken formula or unavailable MiTeX runtime must **never abort the whole PDF export**:
1. **Formula-level failure**: If MiTeX throws or returns empty output on a formula, `typst` remains `undefined`, `TYPST_MATH_CONVERT_FAILED` (or `TYPST_MATH_EMPTY`) is emitted, original LaTeX is preserved in the payload, and Typst renders the raw-LaTeX fallback.
2. **Engine initialization failure**: If MiTeX WASM fails to initialize, `payloadStage` emits **one** `TYPST_MATH_INIT_FAILED` warning diagnostic, disables MiTeX conversion for that payload, preserves all math nodes as raw LaTeX fallback, and continues PDF generation. Failed initialization clears the cached pending promise so subsequent attempts can retry.
3. **Unsupported notation**: Non-LaTeX notations (`mathml`, `asciimath`, `plain`, `unknown`) return `typst: undefined`, emit `TYPST_MATH_UNSUPPORTED_NOTATION`, and preserve the raw source for fallback.

---

## 3. Renderer Stack Versioning

Treat the following components as one validated renderer stack:
- `typst.ts` & embedded Typst compiler
- MiTeX WASM (`mitex_wasm_bg.wasm`)
- MiTeX JS glue (`mitex_wasm_bg.js`) & TypeScript definitions (`mitex_wasm_bg.d.ts`)
- MiTeX Typst scope (`mitex-scope.typ`)
- Gemini Exporter Typst templates

Do not independently bump one component and assume compatibility. Any renderer stack upgrade must run the full validation suite (type-check, unit tests, corpus with real Typst WASM compilation, build, and MV3 PDF E2E).

---

## 4. Future MiTeX Downstream Fork Policy

Every MiTeX failure first uses the runtime raw-LaTeX fallback.

### Admission Criteria for Downstream Patches
A failure may become a downstream MiTeX patch **only if all 6 conditions hold**:
1. Observed in a real exported conversation or backed by strong real-world evidence.
2. The LaTeX is valid or established/common syntax.
3. Reproduces against the MiTeX version in use.
4. It is a generic MiTeX problem, not a Gemini-specific dialect hack.
5. Fixing MiTeX itself is the structurally correct solution.
6. A minimal reproduction can be produced.

### Workflow
`real failure → minimal reproduction → confirm MiTeX bug / missing support → prepare generic MiTeX fix → submit upstream issue / PR → if necessary, temporarily carry the same patch in an OTLFrostA/mitex thin downstream fork → remove downstream patch after upstream release` (long-term target: `downstream fork diff ≈ 0`). Never accumulate Gemini-specific aliases in a downstream fork.

### Cases That Must NOT Become MiTeX Patches
Do not patch MiTeX for:
- Malformed model output;
- Hallucinated commands with no real TeX ecosystem meaning;
- One-off Gemini quirks without repeated real evidence;
- Cosmetic spacing differences that remain semantically correct;
- Behavior already handled safely by raw-LaTeX fallback;
- Differences introduced by our own integration or version mismatch.
