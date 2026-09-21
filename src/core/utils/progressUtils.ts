// progressUtils.ts - Export progress formatting utilities

export interface ExportProgressFormatted {
    text: string;
    pct: number;
}

export interface ExportProgressInput {
    pct?: number;
    current?: number;
    total?: number;
    title?: string;
    assetsDownloaded?: number;
    assetsTotal?: number;
    [key: string]: any;
}

/**
 * Formats export progress details into human-readable text and percentage.
 */
export function formatExportProgress(
    progress?: ExportProgressInput | number | null,
    txt?: string,
    isEn: boolean = false
): ExportProgressFormatted {
    let pct = 0;
    let text = '';

    if (typeof progress === 'object' && progress !== null) {
        pct = typeof progress.pct === 'number' ? progress.pct : 0;
        const current = progress.current || 0;
        const total = progress.total || 0;
        let title = progress.title || txt || '';
        const assetsDownloaded = progress.assetsDownloaded || 0;
        const assetsTotal = progress.assetsTotal || 0;

        if (title === 'Preparing...') {
            title = isEn ? 'Preparing...' : '准备导出...';
        } else if (title === 'Packaging ZIP file...') {
            title = isEn ? 'Packaging ZIP file...' : '正在打包 ZIP 文件...';
        } else if (title === 'Export complete!') {
            title = isEn ? 'Export complete!' : '导出完成！';
        }

        const parts: string[] = [];
        if (total > 0) {
            const chatLabel = isEn ? 'Exporting' : '导出中';
            parts.push(`${chatLabel} (${current}/${total})`);
        }
        if (title) {
            parts.push(title);
        }
        if (assetsTotal > 0 || assetsDownloaded > 0) {
            const assetLabel = isEn ? 'Assets' : '附件';
            parts.push(`📎 ${assetLabel} ${assetsDownloaded}/${assetsTotal}`);
        }

        text = parts.join(' · ');
    } else {
        pct = typeof progress === 'number' ? progress : 0;
        text = txt || '';
    }

    return { text, pct: Math.min(Math.max(pct, 0), 100) };
}
