# Document AST — current contract

**Source of truth:** `src/l3b/ast/ast.ts` and `src/l3b/compose/composeDomainDocument.ts`.

Provider parsers interpret source-specific data. L2 admits and validates the Domain conversation. L3b composes a format-neutral **reading structure**; L4 renders it. A renderer does not reinterpret provider records or write Domain.

```text
source / import -> L1 source parser -> L2 Domain admission
                                            |
                                    composeDomainDocument
                                            |
                                      DocumentAst
                                            |
                       +--------------------+-------------------+
                       |                    |                   |
                   HTML / Markdown        PDF / Typst           DOCX
```

Standard JSON exports serialize Domain directly, not the reading AST.

## Public AST shape

```ts
interface DocumentAst {
    title: string;
    metadata: {
        id: string;            // source conversation ID, not a local UUID
        provider: string;
        createdAt?: number;    // source timestamp in milliseconds
        updatedAt?: number;
    };
    messages: DisplayMessage[];
}

interface DisplayMessage {
    role: DomainMessageRole;
    timestamp?: number;
    modelLabel?: string;
    blocks: DisplayBlock[];
    sources?: SourceItem[];
}
```

`DisplayInline` contains text, emphasis, inline code, links, citations, image references, inline math and line breaks. `DisplayBlock` contains paragraphs, headings, lists, quotes, code, math, tables, images, files, disclosures, thematic breaks and explicit unsupported content. Table cells keep logical row/column/span information. `SourceItem` contains `id`, `label`, optional `href`, and a required display `number`.

The current AST does **not** include a `schemaVersion`, `header`, `messages[].anchor`, source account credentials, output paths, image bytes, a renderer theme or page layout dimensions. When changing the shape, update `ast.ts`, the composer, every renderer and the AST contract tests together; do not preserve obsolete field aliases solely for old fixtures.

## Composer responsibilities

`composeDomainDocument(conversation: ReadonlyDomain, account: Readonly<Account>): DocumentAst` requires a trusted Index + Detail with matching ConversationKey and the matching Registry Account. It throws on a key mismatch. It does not fetch, persist, revalidate unknown provider input, decide fresh vs stale snapshots, or choose an export format.

- Preserve message order and the Domain roles/model labels/timestamps.
- Place reasoning in a disclosure before authored content.
- Compose authored blocks and explicitly message-owned attachments; unowned assets do not become invented visible messages.
- Bind citations using existing message-local Domain IDs, assign consecutive display numbers across messages, preserve authored inline labels, and use source titles or URLs where available.
- Keep stable Domain asset IDs in image and file nodes, rather than filenames or transport URLs. Do not attach image bytes or export destinations to the tree.

`src/l3b/ast/resourceReferences.ts::collectDocumentResources` walks nested lists, tables, rich captions, descriptions and image/file nodes to report required resource IDs. L1 acquisition, Application orchestration, L4 preparation and Packaging resolve the referenced bytes and destination paths outside L3b.

## Renderer responsibilities

HTML (`src/l4/format/html`), Markdown (`src/l4/format/markdown`), Typst/PDF (`src/l4/format/typst`, `src/l4/format/pdf`) and DOCX (`src/l4/format/docx`) consume the logical tree. They own locale-specific UI text, HTML controls, format-specific table fallback, missing-resource presentation, document layout, fonts, pagination and math conversion. The physical Typst transport is an output implementation detail, not another shared conversation model. See [DOCX details](docx-export.md).

Diagnostics belong beside parser/composer/export results, **not** inside Domain or Document AST. Missing source bytes must not rewrite the AST or silently invent citation/resource evidence.

## Validation

Use `npm run type-check` and the dedicated `tests/ast-composer.test.ts` and `tests/document-ast-contract.test.ts` suites. Cross-format integration, real-WASM PDF and browser export tests remain necessary to confirm rendered output; a TypeScript pass does not establish visual fidelity.
