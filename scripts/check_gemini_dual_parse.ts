/** Offline Gemini-only check, also invoked by Tier 2 after capturing actual export RPC replies. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { resolve, join, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { auditGeminiEvidence, readGeminiAuditInput } from '../tests/helpers/geminiDualParse.js';

export function runAudit(input: string, output: string) {
    const source = resolve(input), destination = resolve(output);
    if (source === destination || destination.startsWith(source + sep)) throw new Error('Output must be outside the input directory');
    const files = statSync(source).isDirectory()
        ? readdirSync(source).filter(name => /\.(json|txt)$/.test(name)).sort().map(name => join(source, name)) : [source];
    if (!files.length) throw new Error('No captured native JSON envelopes or raw RPC .txt files');
    mkdirSync(destination, { recursive: true });
    mkdirSync(join(destination, 'sources'), { recursive: true });
    const results = files.map(file => {
        const bytes = readFileSync(file), text = bytes.toString('utf8');
        const name = basename(file), sourceFile = join('sources', name);
        copyFileSync(file, join(destination, sourceFile));
        const identity = { input: file, sourceFile, sha256: createHash('sha256').update(bytes).digest('hex') };
        try {
            const { evidence, provenance, expectedMessages } = readGeminiAuditInput(text, file.endsWith('.txt') ? 'raw_rpc' : 'native_envelope');
            const report = auditGeminiEvidence(evidence);
            if (!report.messages.length) throw new Error('No assistant replies decoded; empty input cannot pass');
            const coverageMatches = expectedMessages === null || JSON.stringify(expectedMessages) === JSON.stringify(report.sourceMessages);
            const checked = { ...identity, provenance, coverageMatches, expectedMessages, ...report };
            const reportFile = `${name}.audit.json`;
            writeFileSync(join(destination, reportFile), JSON.stringify(checked, null, 2));
            return { ...identity, reportFile, provenance, conversationId: report.conversationId,
                complete: report.complete, coverageMatches,
                expectedAssistant: expectedMessages?.filter(m => m.role === 'model').length ?? report.messages.length,
                counts: { assistant: report.messages.length,
                    match: report.messages.filter(m => m.status === 'match').length,
                    different: report.messages.filter(m => m.status === 'different').length,
                    contentOrMetadata: report.messages.filter(m => m.classification === 'content_or_metadata').length,
                    structureOrFormat: report.messages.filter(m => m.classification === 'structure_or_format').length,
                    structuredUnavailable: report.messages.filter(m => m.status === 'structured_unavailable').length },
                differences: report.messages.reduce((count, m) => count + m.differences.length, 0) };
        } catch (error) {
            return { ...identity, error: error instanceof Error ? error.message : String(error) };
        }
    });
    const summary = { schemaVersion: 1, providerId: 'gemini', createdAt: new Date().toISOString(),
        policy: 'Differences need review; neither representation is an oracle. No Markdown fallback counts as structured success. Shared RPC decoding and resource extraction are not independently verified.',
        normalization: 'CRLF/CR to LF; prose whitespace and adjacent text nodes only. Preserve code indentation, TeX, structural boundaries, URLs, citations, resource metadata and order.',
        files: files.length,
        counts: results.reduce((counts, result) => {
            if ('error' in result) counts.errors++;
            else { counts.assistant += result.counts.assistant; counts.expectedAssistant += result.expectedAssistant;
                counts.contentOrMetadata += result.counts.contentOrMetadata; counts.structureOrFormat += result.counts.structureOrFormat; counts.match += result.counts.match; counts.different += result.counts.different;
                counts.structuredUnavailable += result.counts.structuredUnavailable;
                if (!result.complete || !result.coverageMatches) counts.incomplete++; }
            return counts;
        }, { assistant: 0, expectedAssistant: 0, match: 0, different: 0, contentOrMetadata: 0, structureOrFormat: 0, structuredUnavailable: 0, errors: 0, incomplete: 0 }), results };
    const passed = summary.counts.assistant > 0 && !summary.counts.different && !summary.counts.structuredUnavailable && !summary.counts.errors && !summary.counts.incomplete;
    const final = { ...summary, passed };
    writeFileSync(join(destination, 'summary.json'), JSON.stringify(final, null, 2));
    const rows = results.map(result => 'error' in result
        ? `| ${basename(result.input)} | ERROR | ${String(result.error).replace(/\|/g, '\\|')} |`
        : `| [${result.conversationId}](${result.reportFile}) | ${result.complete && result.coverageMatches ? 'complete' : 'INCOMPLETE'} | ${result.counts.match} match / ${result.counts.different} different / ${result.counts.structuredUnavailable} unavailable |`);
    writeFileSync(join(destination, 'REPORT.md'), [
        '# Gemini structured / Markdown differential check', '', `Result: ${passed ? 'PASS' : 'NEEDS REVIEW / INCOMPLETE'}`, '',
        `Files: ${summary.files}; assistant replies: ${summary.counts.assistant}/${summary.counts.expectedAssistant} captured expected; matches: ${summary.counts.match}; differences: ${summary.counts.different} (${summary.counts.contentOrMetadata} content/metadata, ${summary.counts.structureOrFormat} structure/format); structured unavailable: ${summary.counts.structuredUnavailable}; errors: ${summary.counts.errors}; incomplete: ${summary.counts.incomplete}.`, '',
        summary.policy, '', summary.normalization, '',
        'Content/metadata differences and presentation-only differences are classified separately; both require review and keep the check from passing. No mathematical equivalence is inferred from different TeX strings.\n\nEach linked JSON retains both complete Domain messages, canonical trees, every difference path, native document, raw Markdown, diagnostics and the source hash. Original inputs are copied into sources/. Captured decoded payloads are explicitly distinguished from raw RPC text. This check does not validate rendering or downloaded resource bytes.', '',
        '| Conversation/input | Coverage | Comparison |', '| --- | --- | --- |', ...rows, '',
    ].join('\n'));
    return final;
}

if (require.main === module) {
    try {
        const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
        if (!values.input || !values.output) throw new Error('Usage: npm run test:gemini-dual -- --input <native-directory|rpc.txt> --output <report-directory>');
        const report = runAudit(values.input, values.output);
        console.log(JSON.stringify({ passed: report.passed, files: report.files, ...report.counts, report: resolve(values.output, 'REPORT.md') }));
        process.exitCode = report.passed ? 0 : 1;
    } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 2; }
}
