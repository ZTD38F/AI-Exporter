export interface ExportArtifact {
    fileName: string;
    mimeType: string;
    content: string | Blob | Uint8Array;
}
