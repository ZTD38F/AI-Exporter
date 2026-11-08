import { posix } from 'node:path';
import { SignatureKind, type Checker } from 'typescript/unstable/sync';
import { type Node, type SourceFile, isIdentifier, isPropertyAccessExpression, isElementAccessExpression,
    isStringLiteral, isParenthesizedExpression, isNonNullExpression, isImportSpecifier, isExportSpecifier, isVariableDeclaration, isBindingElement,
    isImportDeclaration, isExportDeclaration, isNamedImports, isNamedExports, SyntaxKind, isTypeOfExpression, isTypeParameterDeclaration, isTypeAliasDeclaration, isCallExpression, isAsExpression, isTypeAssertion, isTypePredicateNode,
    isFunctionDeclaration, isReturnStatement, isObjectLiteralExpression, isPropertyAssignment, isArrowFunction, isFunctionExpression } from 'typescript/unstable/ast';

const parsedGeminiAdapters = new Set(['l1/parsers/gemini/shared/contentAdapter.ts', 'l1/parsers/gemini/shared/structuredContentAdapter.ts']);
const geminiDecoders = /^l1\/(?:(?:parsers|sniffer|client)\/gemini\/|imports\/takeout\/)/;
const validator = 'l2/runtimeValidation.ts';
const parserOwners = new Set(['l1/parsers/gemini/rpc/parseConversation.ts',
    'l1/parsers/gemini/takeout/parseConversation.ts', 'l1/parsers/gemini/rpc/mergePages.ts', 'l1/parsers/chatgpt/parseConversation.ts']);
// Source builders finalize new graphs; persistence and the authenticated IPC ingress restore detached snapshots.
const detailIpcIngress = 'runtime/background/domainStorageHandler.ts';
const entries = new Map<string, Set<string>>([
    ['parseGeminiCapturedSource', new Set(['l1/sniffer/gemini/messageBridge.ts'])],
    ['parseGeminiResponse', new Set(['l1/client/gemini/geminiClient.ts', 'l1/parsers/gemini/capturedSource.ts'])],
    ['parseGeminiRpcConversation', new Set(['l1/parsers/gemini/rpc/parseResponse.ts'])],
    ['assertSchema', new Set([validator])], ['assertDomainClosure', new Set([validator])],
    ['validateParserDomain', new Set([...parserOwners, 'l2/ingestion.ts'])], ['restoreDomainSnapshot', new Set(['l2/readConversation.ts'])],
    ['restoreDomainDetail', new Set(['l2/ingestion.ts', detailIpcIngress])],
    ['requestNativeDetail', new Set()],
    ['requestNativeBatch', new Set()],
    ['callDomainBroker', new Set()],
]);
const trustedTypes = new Set(['TrustedDomain', 'ConversationParseResult', 'ResourceConversationParseResult',
    'GeminiRpcParseResult', 'GeminiTakeoutParseResult', 'TrustedDomainBody', 'NativeConversationInput', 'WorkerChatResolveInput', 'ChatExportInput', 'PopupExportInput']);
// Only the shared validator can attach in-memory evidence after schema/closure checks.
// No production owner may manufacture a Domain type with a cast.
function walk(node: Node, visit: (node: Node) => void): void { visit(node); node.forEachChild(child => { walk(child, visit); }); }

/** Inspect real compiler nodes, retaining aliases and excluding comment/string contents. */
export function trustBoundaryViolations(source: SourceFile, owner: string, checker?: Checker): string[] {
    const nodes: Node[] = []; walk(source, n => nodes.push(n));
    const aliases = new Map<string, string>();
    const unwrap = (node: Node): Node => isParenthesizedExpression(node) || isNonNullExpression(node) ? unwrap(node.expression) : node;
    const jsonParse = (node: Node): boolean => {
        node = unwrap(node);
        return isCallExpression(node) && isPropertyAccessExpression(node.expression)
            && isIdentifier(node.expression.expression) && node.expression.expression.text === 'JSON' && node.expression.name.text === 'parse';
    };
    const symbol = (node: Node | undefined): string | undefined => {
        if (!node) return undefined;
        node = unwrap(node);
        if (isIdentifier(node)) return aliases.get(node.text) ?? node.text;
        if (isPropertyAccessExpression(node)) return aliases.get(node.name.text) ?? node.name.text;
        if (isElementAccessExpression(node) && isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
        return undefined;
    };
    const typeNames = (node: Node | undefined): Set<string> => {
        const result = new Set<string>();
        if (node) walk(node, child => { if (isIdentifier(child)) result.add(aliases.get(child.text) ?? child.text); });
        return result;
    };
    // Imports, local aliases, destructuring, and type aliases cannot hide a guarded operation.
    for (let pass = 0; pass < nodes.length; pass++) {
        let changed = false;
        const set = (name: string, target: string | undefined) => { if (target && aliases.get(name) !== target) { aliases.set(name, target); changed = true; } };
        for (const node of nodes) {
            if (isImportSpecifier(node)) set(node.name.text, symbol(node.propertyName ?? node.name));
            else if (isVariableDeclaration(node) && isIdentifier(node.name)) set(node.name.text, symbol(node.initializer));
            else if (isBindingElement(node) && node.name && isIdentifier(node.name)) set(node.name.text, symbol(node.propertyName));
            else if (isTypeAliasDeclaration(node) && !trustedTypes.has(node.name.text)) {
                const target = [...typeNames(node.type)].find(name => trustedTypes.has(name) || name === 'DomainConversationDetail');
                set(node.name.text, target);
            }
        }
        if (!changed) break;
    }
    const issues: string[] = [];
    const report = (node: Node, message: string) => issues.push(`${owner}:${node.getStart()} ${message}`);
    const entry = (node: Node, name: string | undefined) => {
        if (name && entries.has(name) && owner !== validator && !entries.get(name)!.has(owner)) report(node, `unauthorized ${name}`);
        if (name === 'assertDomainClosure' && owner !== validator) report(node, 'Closure belongs only to the shared validator');
    };
    for (const node of nodes) {
        if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)
            && posix.normalize(posix.join(posix.dirname(owner), node.moduleSpecifier.text)).replace(/\.js$/, '.ts') === 'l1/parsers/gemini/rpc/parseList.ts'
            && owner !== 'l1/parsers/gemini/rpc/parseResponse.ts') {
            const typeOnly = isImportDeclaration(node)
                ? node.importClause?.phaseModifier === SyntaxKind.TypeKeyword || (node.importClause?.namedBindings && isNamedImports(node.importClause.namedBindings)
                    && node.importClause.namedBindings.elements.every(binding => binding.isTypeOnly))
                : node.isTypeOnly || (node.exportClause && isNamedExports(node.exportClause)
                    && node.exportClause.elements.every(binding => binding.isTypeOnly));
            const bindings = isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
            const helpersOnly = !(isImportDeclaration(node) && node.importClause?.name) && bindings
                && (isNamedImports(bindings) || isNamedExports(bindings))
                && bindings.elements.every(binding => binding.isTypeOnly || !['parseList', 'default'].includes((binding.propertyName ?? binding.name).text));
            if (!typeOnly && !helpersOnly) report(node, 'Gemini LIST wire parser belongs behind parseResponse');
        }
        if (owner === 'l1/sniffer/gemini/captureReceiver.ts' && (node.kind === SyntaxKind.UnknownKeyword
            || node.kind === SyntaxKind.AnyKeyword || node.kind === SyntaxKind.ObjectKeyword || isTypeParameterDeclaration(node)
            || (isTypeOfExpression(node) && !(isIdentifier(node.expression) && ['document', 'location'].includes(node.expression.text))))) {
            report(node, 'capture receivers consume decoded source contracts; raw probing belongs to ingress parsers');
        }
        if (parsedGeminiAdapters.has(owner) && (node.kind === SyntaxKind.UnknownKeyword || node.kind === SyntaxKind.AnyKeyword
            || node.kind === SyntaxKind.ObjectKeyword || isTypeOfExpression(node) || isTypeParameterDeclaration(node))) {
            report(node, 'parsed Gemini adapters consume concrete source facts without re-probing raw input');
        }
        if ((/^(?:l2|l3a|l3b|application|l4)\//.test(owner) || parsedGeminiAdapters.has(owner) || geminiDecoders.test(owner) || owner === detailIpcIngress
            || owner === 'l1/client/chatgpt/imageAssets.ts' || owner === 'l1/parsers/chatgpt/parseList.ts'
            || owner === 'l1/client/chatgpt/accountObservation.ts' || owner === 'l1/parsers/chatgpt/dil/expression.ts')
            && (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node))) {
            report(node, 'typed business layers must narrow or construct values without assertions');
        }
        if (isImportSpecifier(node)) entry(node, symbol(node.propertyName ?? node.name));
        if (isExportSpecifier(node)) entry(node, symbol(node.propertyName ?? node.name));
        if (isCallExpression(node)) entry(node, symbol(node.expression));
        if (isAsExpression(node) || isTypeAssertion(node)) {
            const types = typeNames(node.type);
            for (const name of types) if (trustedTypes.has(name) || name === 'DomainConversationDetail') {
                report(node, `unauthorized trust assertion ${name}`);
                if (isAsExpression(unwrap(node.expression)) || isTypeAssertion(unwrap(node.expression))) report(node, 'double trust assertion');
            }
        }
        if (isTypePredicateNode(node)) {
            const types = typeNames(node.type);
            if ([...types].some(name => trustedTypes.has(name) || name === 'DomainConversationDetail')) {
                const parent = node.parent;
                const internal = owner === 'l1/parsers/parsingResult.ts' && parent && isFunctionDeclaration(parent)
                    && parent.name?.text === 'isResourceConversationParseResult'
                    && parent.parameters[0]?.type?.getText() === 'NativeConversationInput';
                const schema = owner === validator && parent && isFunctionDeclaration(parent)
                    && ((parent.name?.text === 'assertSchema' && types.has('DomainConversationDetail'))
                        || (parent.name?.text === 'isTrustedBody' && types.has('TrustedDomainBody'))
                        || (parent.name?.text === 'registerDetail' && types.has('TrustedDomainBody')));
                if (!schema && !internal) report(node, 'unauthorized trust-producing predicate');
            }
        }
        if (owner !== validator && isObjectLiteralExpression(node)) {
            const properties = new Map(node.properties.filter(isPropertyAssignment).map(p => [p.name.getText(), p.initializer]));
            const fields = ['providerId', 'id', 'title', 'timestamp', 'messages', 'assets'];
            if (fields.every(key => properties.has(key)) && fields.every(key => {
                const value = properties.get(key)!;
                if (isArrowFunction(value) || isFunctionExpression(value)) return true;
                const type = checker?.getTypeAtLocation(value);
                return type ? checker!.getSignaturesOfType(type, SignatureKind.Call).length > 0 : false;
            })) report(node, 'copied full Domain schema descriptor');
        }
        // JSON.parse must stay unknown until an authorized boundary, never directly supply a brand.
        if (isVariableDeclaration(node) && node.initializer && jsonParse(node.initializer)
            && [...typeNames(node.type)].some(name => trustedTypes.has(name))) report(node, 'JSON cannot manufacture trust');
        if (isReturnStatement(node) && node.expression && jsonParse(node.expression)) {
            let enclosing = node.parent;
            while (enclosing && !isFunctionDeclaration(enclosing) && !isFunctionExpression(enclosing) && !isArrowFunction(enclosing)) enclosing = enclosing.parent;
            if (enclosing && (isFunctionDeclaration(enclosing) || isFunctionExpression(enclosing) || isArrowFunction(enclosing))
                && [...typeNames(enclosing.type)].some(name => trustedTypes.has(name))) report(node, 'JSON cannot return manufactured trust');
        }
        if (isArrowFunction(node) && jsonParse(node.body)
            && [...typeNames(node.type)].some(name => trustedTypes.has(name))) report(node, 'JSON cannot return manufactured trust');
    }
    return [...new Set(issues)];
}
