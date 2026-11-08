# ChatGPT component source parsing

ChatGPT educational answers may contain DIL component source alongside provider-generated Markdown. The parser now reads the source first and renders supported components in source order. Provider Markdown is a fallback, rather than the default replacement followed by an unordered list of recovered strings.

## Supported static representations

| Module | Export behavior |
| --- | --- |
| Layout (`box`, `row`, `column`, `grid`, `grid-item`, text/labels/captions, titles, emphasis, divider) | Ordered Markdown content; visual layout properties are not reproduced. |
| Literal bindings, `DIL.useState(initial)`, indexed/member expressions | Bounded data interpretation. State uses the declared initial value, not the live browser state. |
| `each`, nested `if`/`else` | Expand referenced fields in place; repeated labels remain repeated. Unused object fields are not exported. |
| Radio, checkbox, select/option, input, button | Static labels, placeholder, declared input defaults and button text. No current selection or event behavior is claimed. |
| `math` | Inline or display LaTeX from the component value. |
| `CodeBlock` | Exact code body inside a safe Markdown fence, retaining language and indentation. |
| `AsyncImage` | Existing image-gallery binding resolves the query against captured component results; this module does not invent asset URLs. |
| SVG | Preserve SVG source as a code fence, with common React attribute names normalized. This is not a rendered diagram. |
| `LearningViz` | `VARIANCE`, `ANGULAR_FREQUENCY_RELATION` and `COMPOUND_INTEREST` have static descriptions, authored child content and captured initial values. This is not an interactive chart. |

Ordinary Markdown code and math are opaque to component parsing. No provider JavaScript, handler, arbitrary call, getter or prototype access is executed. Input size, nesting, expression work, loop expansion and output are bounded. Unsupported syntax fails to explicit fallback or an incomplete-content diagnostic.

## Fallback and completeness

An unsupported block uses its provider Markdown segment when neighboring text uniquely identifies the boundaries. Ambiguous boundaries use the whole provider fallback and report that representation. A source/fallback content guard also retains the whole fallback if parsed output would lose provider text. Missing fallback produces an unavailable-component marker and incomplete status.

`modules`, `fallbackBlocks` and `unsupported` diagnostics describe which route was used. Completeness measures static textual coverage; it never promises interactive behavior, live selection state, or exact visual reproduction. Branch integrity and stream completion still independently determine conversation quality.

## Regression and limitations

The parser lives in `src/l1/parsers/chatgpt/dil/`, and its source/fallback regression corpus lives in `tests/fixtures/chatgpt_dil_corpus.json`. It exports static content, not live interactions or user input state. New component families require fixtures and an explicit partial/fallback policy. Validate the Domain text and physical output before claiming full fidelity.
