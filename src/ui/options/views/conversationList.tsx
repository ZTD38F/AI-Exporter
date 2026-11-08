import { useEffect, useState } from 'react';
import { resourceDownloadOrigin } from '../../../shared/platformHosts.js';
import { hasResourceAccess, requestResourceAuthorization } from '../../../runtime/capabilities/platformAuthorization.js';
import { attachmentFailure, attachmentIssueText } from '../../shared/exportSummary.js';
import { resourceIssueKind } from '../../../shared/resources/resourceResult.js';
import { indexActivityTime, type DomainConversationIndex } from '../../../l2/conversationIndex.js';
import type { Account } from '../../../l2/accountRegistry.js';
import type { ExportRecord } from '../../../application/export/types.js';
import { text, uiLocale } from '../../shared/settings.js';

interface ConversationRowFacts {
    index: DomainConversationIndex;
    record: ExportRecord | undefined;
    selected: boolean;
    prepared: boolean;
    failed: boolean;
}
interface ConversationListProps {
    rows: readonly ConversationRowFacts[];
    disabled: boolean;
    provider: Account['providerId'] | undefined;
    developerMode: boolean;
    onSelect: (id: string, selected: boolean) => void;
}

/** Display recent ExportRecord facts and transient delivery results; Application still owns Skip. */
function viewStatus(index: DomainConversationIndex, record: ExportRecord | undefined, prepared: boolean, failed: boolean, developerMode: boolean) {
    if (failed) return { label: text('Export failed', '导出失败'), className: 'status-failed' };
    if (prepared) return { label: text('Rendered, awaiting download', '渲染成功，等待下载'), className: 'status-prepared' };
    if (!record) return { label: '', className: '' };
    if (record.status === 'partial' && (developerMode || record.otherContentMissing || !record.attachmentIssues?.length)) {
        if (record.otherContentMissing || !record.attachmentIssues?.length)
            return { label: text('Incomplete export', '导出不完整'), className: 'status-partial' };
        const onlyExpired = record.attachmentIssues.every(issue =>
            resourceIssueKind(attachmentFailure(issue)) === 'expired');
        return onlyExpired
            ? { label: text('Some source attachments unavailable', '部分来源附件无法获取'), className: 'status-unavailable' }
            : { label: text('Some attachments failed', '部分附件获取失败'), className: 'status-unavailable' };
    }
    if (record.chatTime !== undefined && index.updatedAt !== undefined
        && Number.isSafeInteger(record.chatTime) && Number.isSafeInteger(index.updatedAt)
        && index.updatedAt > record.chatTime)
        return { label: text('Updated', '有更新'), className: 'status-updated' };
    return { label: text(`Export successful (${date(record.exportedAt)})`, `导出成功（${date(record.exportedAt)}）`), className: 'status-exported' };
}
function date(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value) ? '' : new Date(value).toLocaleString(uiLocale());
}

// Permission queries belong to the mounted control, never the list render loop.
function ResourceAuthorization({ sourceUrl, hostname }: { sourceUrl: string; hostname: string }) {
    const [permission, setPermission] = useState<'checking' | 'available' | 'requesting' | 'granted' | 'existing'>('checking');
    useEffect(() => {
        let active = true;
        void hasResourceAccess(sourceUrl).then(granted => {
            if (active) setPermission(granted ? 'existing' : 'available');
        }).catch(() => { if (active) setPermission('available'); });
        return () => { active = false; };
    }, [sourceUrl]);
    if (permission === 'checking' || permission === 'existing') return null;
    return <button type="button" className="authorize-resource"
        disabled={permission !== 'available'} onClick={() => {
            // Start the browser permission request within the actual click gesture.
            const request = requestResourceAuthorization(sourceUrl);
            setPermission('requesting');
            void request.then(granted => setPermission(granted ? 'granted' : 'available'))
                .catch(() => setPermission('available'));
        }}>
        {permission === 'granted'
            ? text('Access allowed; export this conversation again', '已授权，请重新导出此会话')
            : text(`Allow downloads from ${hostname}`, `允许从 ${hostname} 下载`)}
    </button>;
}

function AttachmentIssue({ issue }: { issue: NonNullable<ExportRecord['attachmentIssues']>[number] }) {
    let source: URL | undefined;
    if (issue.sourceUrl) {
        try {
            const url = new URL(issue.sourceUrl);
            if (url.protocol === 'https:' && !url.username && !url.password) source = url;
        } catch { /* Older records may contain an invalid source locator. */ }
    }
    return <div>{attachmentIssueText(issue)}{source && <>
        {' '}<a href={source.href} target="_blank" rel="noopener noreferrer">{text('Open source', '查看来源')}</a>
        {issue.sourceUrl && resourceDownloadOrigin(issue.sourceUrl) && issue.httpStatus === undefined
            && ['RESOURCE_DOWNLOAD_FAILED', 'RESOURCE_UNAVAILABLE'].includes(issue.code) && <>
                {' '}<ResourceAuthorization key={issue.sourceUrl} sourceUrl={issue.sourceUrl} hostname={source.hostname} />
            </>}
    </>}</div>;
}

function sourceTurnNote(sourceTurn: ExportRecord['sourceTurn']): string | null {
    if (!sourceTurn || sourceTurn === 'finished') return null;
    return sourceTurn === 'unfinished' ? text('Source reply has not ended', '原回答尚未结束')
        : sourceTurn === 'interrupted' ? text('Source reply was interrupted', '原回答已中断')
        : sourceTurn === 'handoff' ? text('Source is at a handoff', '原对话停在交接步骤')
        : sourceTurn === 'awaiting_reply' ? text('Source ends with a user message', '来源最后为用户消息')
        : sourceTurn === 'tool_pending' ? text('Source ends at a tool step', '来源停在工具步骤')
        : text('Source reply completion unconfirmed; available content saved', '原回答结束状态未确认，已保存可用正文');
}

function ConversationRow({ row, disabled, provider, developerMode, onSelect }: Omit<ConversationListProps, 'rows'> & { row: ConversationRowFacts }) {
    const { index, record, selected, prepared, failed } = row;
    const id = index.key.conversationId;
    const status = viewStatus(index, record, prepared, failed, developerMode);
    const note = sourceTurnNote(record?.sourceTurn);
    const origin = provider === 'grok' ? 'https://grok.com/c/' : provider === 'claude' ? 'https://claude.ai/chat/'
        : provider === 'chatgpt' ? 'https://chatgpt.com/c/' : 'https://gemini.google.com/app/';
    const openLabel = provider === 'grok' ? text('Open in Grok', '在 Grok 中打开') : provider === 'claude' ? text('Open in Claude', '在 Claude 中打开')
        : provider === 'chatgpt' ? text('Open in ChatGPT', '在 ChatGPT 中打开') : text('Open in Gemini', '在 Gemini 中打开');
    return <div className="item" data-chat-id={id} data-account-id={index.key.accountId}
        data-selected={selected} onClick={event => {
            if (disabled || event.target instanceof Element && event.target.closest('input, a, details, button')) return;
            onSelect(id, !selected);
        }}>
        <input type="checkbox" checked={selected} disabled={disabled}
            aria-label={text('Select conversation', '选择会话')}
            onChange={event => onSelect(id, event.currentTarget.checked)} />
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                <span className="chat-title title" style={index.title ? undefined : { color: 'var(--warn)' }}>{index.title || id}</span>
                {status.className && <span className={`status-tag ${status.className}`}>{status.label}</span>}
            </div>
            <small className="meta" style={{ display: 'block' }}>{[
                date(indexActivityTime(index)), record ? `${text('Last export', '上次导出')} · ${record.format}` : '',
            ].filter(Boolean).join(' · ')}</small>
            {note && <div className="source-turn-status">{note}</div>}
            {developerMode && !!record?.attachmentIssues?.length && <details className="attachment-issues" onClick={event => event.stopPropagation()}>
                <summary>{text(`Attachment details (${record.attachmentIssues.length})`, `附件详情（${record.attachmentIssues.length}）`)}</summary>
                {record.attachmentIssues.map((issue, position) => <AttachmentIssue key={`${issue.resourceId}:${position}`} issue={issue} />)}
            </details>}
        </div>
        {/* Provider-supplied URLs never become navigation destinations. */}
        <a className="open-link" href={origin + encodeURIComponent(id)} target="_blank" rel="noopener noreferrer"
            title={openLabel} aria-label={openLabel}>↗</a>
    </div>;
}

export function ConversationList({ rows, ...props }: ConversationListProps) {
    if (!rows.length) return <>{text('No conversations match this view', '当前视图没有对话')}</>;
    return <>{rows.map(row => <ConversationRow key={`${row.index.key.accountId}:${row.index.key.conversationId}`} row={row} {...props} />)}</>;
}
