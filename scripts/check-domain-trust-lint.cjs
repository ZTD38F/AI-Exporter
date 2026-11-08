const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const cli = path.join(path.dirname(require.resolve('oxlint/package.json')), 'bin', 'oxlint');
function ownedTypeScriptFiles(relativeDir) {
    return fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true }).flatMap(entry => {
        const relative = path.posix.join(relativeDir, entry.name);
        if (entry.isDirectory()) return entry.name === 'vendor' ? [] : ownedTypeScriptFiles(relative);
        return entry.isFile() && /\.tsx?$/.test(entry.name) ? [relative] : [];
    });
}
// Typed business and downstream layers reject implicit any flow. The compiler-based
// architecture gate additionally rejects all casts and non-null assertions in these owners.
const files = ['src/l2', 'src/l3a', 'src/l3b', 'src/application', 'src/l4']
    .concat(['src/l1/parsers/gemini', 'src/l1/client/gemini', 'src/l1/sniffer/gemini', 'src/l1/imports/takeout', 'src/l1/imports/openai', 'src/l1/parsers/shared/resources'])
    .flatMap(ownedTypeScriptFiles)
    .concat(['src/shared/platformHosts.ts', 'src/runtime/api/accountRegistry.ts', 'src/runtime/api/domainIngestion.ts',
        'src/runtime/capabilities/platformAuthorization.ts', 'src/runtime/capabilities/platformInjection.ts',
        'src/ui/shared/platformAuthorization.ts', 'src/l1/resources/attachmentBytes.ts',
        'src/ui/shared/elements.ts', 'src/ui/shared/settings.ts', 'src/ui/options/options.ts',
        'src/ui/popup/popup.ts', 'src/ui/options/views/cleanupPrompt.ts',
        'src/ui/options/views/directWritePrompt.ts', 'src/ui/options/views/listView.ts',
        'src/ui/options/views/conversationList.tsx', 'src/ui/options/views/taskPanel.tsx',
        'src/ui/options/controllers/exportSession.ts', 'src/ui/options/views/taskPanelView.ts', 'src/ui/options/state/foregroundTask.ts',
        'src/ui/options/state/exportIssues.ts', 'src/ui/options/views/exportFailures.ts',
        'src/runtime/background/contentSender.ts', 'src/l1/client/claude/fileAssets.ts',
        'src/l1/client/claude/claudeProvider.ts', 'src/l1/client/claude/claudeSource.ts',
        'src/l1/client/grok/grokSource.ts', 'src/ui/guidance/tourGuide.ts', 'src/ui/guidance/tourSteps.ts',
        'src/runtime/content/chatgptContent.ts', 'src/runtime/content/claudeContent.ts',
        'src/runtime/content/grokContent.ts', 'src/ui/badge/badgeView.ts',
        'src/runtime/content/liveSaveCoordinator.ts', 'src/l1/client/chatgpt/imageAssets.ts',
        'src/l1/parsers/chatgpt/parseExportConversation.ts',
        'src/l1/parsers/claude/parseList.ts', 'src/l1/parsers/chatgpt/parseList.ts',
        'src/l1/client/chatgpt/accountObservation.ts', 'src/l1/parsers/chatgpt/dil/expression.ts']);

const result = spawnSync(process.execPath, [cli, '-A', 'all', '-D', 'typescript/no-explicit-any',
    '-D', 'typescript/no-unsafe-assignment', '-D', 'typescript/no-unsafe-argument', '-D', 'typescript/no-unsafe-return',
    '-D', 'typescript/no-unsafe-member-access', '-D', 'typescript/no-unsafe-call', '--type-aware', '--no-ignore',
    '--disable-nested-config', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
