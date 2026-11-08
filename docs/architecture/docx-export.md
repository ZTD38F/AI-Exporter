# Local DOCX rendering

DOCX is an L4 projection of the same Document AST used by other formats. It does not reparse provider responses, modify Domain facts or write storage. Application owns export orchestration and Packaging owns image companions and delivery.

## Word lists

Each AST list gets an independent native numbering definition. Its paragraphs share that definition, so nested lists cannot reset the parent's counter, while a new list starts at its own `start` (default 1). Decimal and bullet lists use native `w:numPr` properties rather than text prefixes. Continuation paragraphs remain unnumbered and retain their list indentation.

OOXML supports levels 0–8. Deeper source nesting preserves every item at level 8 rather than generating an invalid level. Non-paragraph first blocks retain an empty numbered paragraph followed by their original content.

## Word equations

`format/docx/math.ts` calls the existing public KaTeX MathML renderer with expansion/size limits and rejects trusted-HTML/link commands. The pinned MIT-licensed `@xmldom/xmldom` parser reads only that locally generated MathML. The adapter accepts explicit MathML structures and creates native OMML with the `docx` XML builders, which escape all text and attribute values.

Supported structures include inline and display equations, fractions/binomials, roots, sub/superscripts, lower/upper limits, matrices and aligned/cases tables, fences, supported accents/bars, text and common math alphabets. Function limits use an OMML function container so readers do not incorporate the limit name into a following fraction. MathML vertical-bar delimiters use the corresponding Word delimiter characters. Display equations use `m:oMathPara`; inline equations stay in their surrounding paragraph.

An unsupported tag, variant, table structure, parse error or resource bound rejects the entire conversion. The renderer keeps the original LaTeX as editable text, with a localized fallback label for block math. It never emits only the recognized portion of an equation. This is a supported subset of KaTeX MathML, not general TeX/OMML compatibility. Styling hints such as color, spacing and display size are approximated; custom layouts/enclosures and unsupported macros fall back to source.

The `docx` library's `MathComponent` TypeScript union omits some native structures, including matrices and limits. Its public `BuilderElement` and XML-child methods provide the required native elements without type assertions, raw XML string interpolation or changes to the shared AST.

## Verification

`tests/document-docx.test.ts` reads the physical OOXML to verify numbering identities/starts, continuation paragraphs, native math structures, matrix cells, function limits, XML escaping and atomic source fallback. `tests/e2e/export_zip.spec.ts` downloads real single and batch DOCX exports from the Workbench, checks their equations/numbering and verifies committed export records.

Visual QA renders actual DOCX files with LibreOffice and checks every page. LibreOffice is the current visual acceptance target. Microsoft Word editing and pagination are outside this acceptance scope.

## Width and reader compatibility

Tables budget their columns against an explicit Letter page with one-inch margins. Minimum widths account for unbreakable inline equations (estimated structurally from MathML), words, images and column spans. When the grid cannot fit, the DOCX projection expands it into row records: every cell retains its column header labels, row order and span information at full page width. Small grids retain native table cells and merged headers. This trades a compact grid for readable complete expressions; it does not rewrite the shared AST. The width estimate is conservative, not exact font measurement, and needs rendered regression checks.

KaTeX's terminal function-application marker is not an extra script operand. Macron accents, named limits and scripts on bracketed expressions are represented explicitly in OMML. Blank alignment cells and intentionally empty script bases use an invisible run, avoiding missing-operand placeholders in readers. Unsupported or malformed source still falls back atomically.

Code uses Courier New and a bounded width-based font size; short blocks stay together, while long blocks can paginate. Section and role headings stay with the following paragraph, and native table rows request no splitting across pages. These are reader layout hints; long code and ASCII blocks may still paginate or wrap.
