export type WriteFileContent = string | Uint8Array | ArrayBuffer | Blob;

/** Options supported by the export pipeline and its writers. */
export interface WriteFileOptions {
    base64?: boolean;
    compression?: 'STORE' | 'DEFLATE';
    compressionOptions?: { level?: number };
}

export interface IExportWriter {
    /** Resolves to the actual relative path accepted by the writer. */
    writeFile(relativePath: string, content: WriteFileContent, options?: WriteFileOptions): Promise<string> | string;
    generateBlob?(onUpdate?: (pct: number) => void): Promise<Blob>;
    init?(): Promise<FileSystemDirectoryHandle>;
}
