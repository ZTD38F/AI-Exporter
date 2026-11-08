import { posix } from 'node:path';
import { type Node, type SourceFile, SyntaxKind, isImportDeclaration, isExportDeclaration,
    isNamedImports, isNamedExports, isCallExpression, isIdentifier, isExternalModuleReference, isImportEqualsDeclaration,
    isStringLiteral, isNoSubstitutionTemplateLiteral } from 'typescript/unstable/ast';

/** Inspect syntax, never comment/string contents; resolve paths before applying the layer policy. */
export function markdownBoundaryViolations(source: SourceFile): string[] {
    const issues: string[] = [];
    const dependency = (node: Node): void => {
        if (!isStringLiteral(node) && !isNoSubstitutionTemplateLiteral(node)) {
            issues.push('Renderer dependency must have a literal module path');
            return;
        }
        const target = node.text.startsWith('.') ? posix.normalize(posix.join('l4/format/markdown', node.text)) : node.text;
        if (/(?:^|\/)(?:l1|l2|l3a|application|runtime|ui|domain|parsers|storage|provider|api|engine)(?:\/|$)/.test(target))
            issues.push(`Markdown renderer cannot depend on ${target}`);
    };
    const visit = (node: Node): void => {
        if (isImportEqualsDeclaration(node)) {
            if (!node.isTypeOnly && isExternalModuleReference(node.moduleReference)) dependency(node.moduleReference.expression);
        } else if (isImportDeclaration(node)) {
            const clause = node.importClause;
            const bindings = clause?.namedBindings;
            const typeOnly = clause?.phaseModifier === SyntaxKind.TypeKeyword || (!clause?.name && bindings && isNamedImports(bindings)
                && bindings.elements.length > 0 && bindings.elements.every(binding => binding.isTypeOnly));
            if (!typeOnly) dependency(node.moduleSpecifier);
        } else if (isExportDeclaration(node)) {
            const clause = node.exportClause;
            const typeOnly = node.isTypeOnly || clause && isNamedExports(clause)
                && clause.elements.length > 0 && clause.elements.every(binding => binding.isTypeOnly);
            if (!typeOnly && node.moduleSpecifier) dependency(node.moduleSpecifier);
        } else if (isCallExpression(node) && (node.expression.kind === SyntaxKind.ImportKeyword
            || isIdentifier(node.expression) && node.expression.text === 'require')) {
            if (node.arguments[0]) dependency(node.arguments[0]);
        }
        node.forEachChild(visit);
    };
    visit(source);
    return issues;
}
