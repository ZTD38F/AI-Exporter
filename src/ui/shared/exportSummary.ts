import type { ExportResult, ExportAttachmentIssue } from '../../application/export/types.js';
import { resourceFailureText, resourceIssueKind, type ResourceFailure } from '../../shared/resources/resourceResult.js';
import { text, isDeveloperMode } from './settings.js';

export function attachmentFailure(issue: ExportAttachmentIssue): ResourceFailure {
    return { ok: false, reason: '', ...issue };
}
export function attachmentIssueText(issue: ExportAttachmentIssue): string {
    return issue.name + ': ' + resourceFailureText(attachmentFailure(issue), text('en', 'zh') === 'zh' ? 'zh' : 'en');
}
export function exportSummary(result: ExportResult, developerMode = isDeveloperMode()): string {
    const issues = developerMode ? result.attachmentIssues ?? [] : [];
    const count = (kind: ReturnType<typeof resourceIssueKind>) => issues.filter(issue => resourceIssueKind(attachmentFailure(issue)) === kind).length;
    const expired = count('expired'), restricted = count('restricted'), download = count('download'), processing = count('processing'), unknown = count('unknown');
    const summary = [text(`Successfully downloaded: ${result.exported}`, `成功下载 ${result.exported} 条会话`),
        ...(expired ? [text(`${result.expiredConversations ?? 0} conversations contain unavailable source attachments (${expired} attachments)`, `${result.expiredConversations ?? 0} 条含无法获取的来源附件（${expired} 个附件）`)] : []),
        ...(restricted ? [text(`Access restricted: ${restricted} attachments`, `访问受限 ${restricted} 个附件`)] : []),
        ...(download ? [text(`Attachment download failed: ${download}; retry later`, `附件下载失败 ${download} 个，可重试`)] : []),
        ...(processing ? [text(`Attachment processing failed: ${processing}`, `附件处理失败 ${processing} 个`)] : []),
        ...(unknown ? [text(`Attachment failures with unknown cause: ${unknown}`, `原因未知的附件失败 ${unknown} 个`)] : []),
        ...((result.otherPartial ?? result.partial) ? [text(`Other incomplete conversations: ${result.otherPartial ?? result.partial}`, `其他内容不完整 ${result.otherPartial ?? result.partial} 条`)] : []),
        ...(result.skipped ? [text(`Skipped: ${result.skipped}`, `跳过 ${result.skipped}`)] : []),
        ...(result.failed.length ? [text(`Conversation export failed: ${result.failed.length}`, `会话导出失败 ${result.failed.length}`)] : []),
        ...(!result.rateLimitedUntil && result.aborted ? [text('Cancelled', '已取消')] : [])].join('; ');
    return result.rateLimitedUntil ? summary + '\n' + text(
        `ChatGPT rate limited (429): export stopped; account cooling down until ${new Date(result.rateLimitedUntil).toLocaleTimeString()}. Retry manually after cooldown.`,
        `ChatGPT 请求受限（429），本次导出已停止；账号冷却至 ${new Date(result.rateLimitedUntil).toLocaleTimeString()}，请届时手动重试`) : summary;
}
