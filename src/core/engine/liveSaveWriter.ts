// src/core/engine/liveSaveWriter.ts
// Shared "format chat -> write markdown file via FsWriter" used by live-save.
//
// Content and background live-save share the async Canonical Markdown route,
// writer setup and "CleanTitle_Cid6.md" filename format. Formatting failures
// propagate to the caller's existing error handling.
//
// Context-specific orchestration stays at the call sites:
// - content side keeps its own image asset pipeline (processAndSaveImages),
// - background side keeps permission checks, dir probing, the base64 asset
//   loop and export-record bookkeeping.

import { isLiveSaveFormatSupported } from '../storage/liveStorageManager.js';
import { FsWriter } from './writers/fsWriter.js';
import { ChatFormatter } from './chatFormatter.js';
import { buildExportFileName } from '../utils/pathUtils.js';
import { DEFAULT_EXPORT_FOLDER_NAME } from '../utils/constants.js';

export interface LiveSaveWriteInput {
    chat: any;
    safeTitle: string;
    nid: string;
}

export interface LiveSaveWriterDeps {
    fsWriterClass?: new (dirHandle: any, rootDir: string) => FsWriter;
    formatter?: Pick<typeof ChatFormatter, 'formatMarkdownCanonical'>;
    buildFileName?: (safeTitle: string, nid: string, ext: string) => string;
}

export interface LiveSaveWriter {
    init(): Promise<void>;
    writeFile(subDir: string, fileName: string, data: string | Uint8Array): Promise<void>;
}

const LIVE_SAVE_ROOT_DIR = DEFAULT_EXPORT_FOLDER_NAME;

export async function createLiveSaveWriter(
    dirHandle: any,
    deps: LiveSaveWriterDeps = {}
): Promise<LiveSaveWriter> {
    const WriterCls = deps.fsWriterClass || FsWriter;
    const writer = new WriterCls(dirHandle, LIVE_SAVE_ROOT_DIR);
    await writer.init();
    // The LiveSaveWriter facade keeps its (subDir, fileName, data) API, but the
    // underlying writer only supports (relativePath, content, options?) since the
    // legacy 3-arg overload was retired. Translate explicitly here instead of
    // relying on the removed overload dispatch (previously via an unsafe cast).
    return {
        init: () => writer.init(),
        writeFile: (subDir: string, fileName: string, data: string | Uint8Array): Promise<void> =>
            writer.writeFile(subDir ? `${subDir}/${fileName}` : fileName, data).then(() => undefined),
    };
}

export async function formatLiveSaveMarkdown(
    input: LiveSaveWriteInput,
    deps: LiveSaveWriterDeps = {}
): Promise<{ fileName: string; markdown: string }> {
    const buildFileName = deps.buildFileName || buildExportFileName;
    const formatter = deps.formatter ?? ChatFormatter;
    const fileName = buildFileName(input.safeTitle, input.nid, 'md');
    const shaped = { ...input.chat, title: input.safeTitle, id: input.nid };
    const { content: markdown } = await formatter.formatMarkdownCanonical(shaped);
    return { fileName, markdown };
}

export async function writeLiveSaveMarkdown(
    writer: LiveSaveWriter,
    input: LiveSaveWriteInput,
    deps: LiveSaveWriterDeps = {},
    opts: { fileName?: string } = {}
): Promise<string> {
    const { fileName, markdown } = await formatLiveSaveMarkdown(input, deps);
    const targetFile = opts.fileName || fileName;
    if (!await isLiveSaveFormatSupported()) throw new Error('Live save only supports Markdown');
    await writer.writeFile('', targetFile, markdown);
    return targetFile;
}
