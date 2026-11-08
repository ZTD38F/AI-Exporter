import { createPortal } from 'react-dom';
import type { ForegroundTaskStatus, TaskFeedback } from '../state/foregroundTask.js';
import { text } from '../../shared/settings.js';
import { failureGroupLabel } from './exportFailures.js';
import type { ExportIssueGroup } from '../state/exportIssues.js';

export interface TaskPanelProps {
    task: ForegroundTaskStatus;
    feedback: TaskFeedback;
    percent: number;
    scanMessage: string | null;
    scanSlow: boolean;
    groups: readonly ExportIssueGroup[];
    failedCount: number;
    dismissed: boolean;
    developerMode: boolean;
    ready: boolean;
    onCancel: () => void;
    onRetry: () => void;
    onDismiss: () => void;
    onCopy: () => void;
}

function FailureCard({ groups, failedCount, dismissed, developerMode, task, ready, onRetry, onDismiss, onCopy }: TaskPanelProps) {
    const visibleGroups = groups.filter(group => developerMode || !(
        ['resource', 'resource_refresh'].includes(group.diagnostic.stage)
        || group.category.startsWith('RESOURCE_')
        || /(?:^|_)(?:ASSET|IMAGE)(?:_|$)/.test(group.diagnostic.code)));
    const hasErrors = failedCount > 0 || visibleGroups.some(group => group.severity === 'error');
    const title = hasErrors
        ? failedCount ? text(`${failedCount} conversations failed · Issue groups: ${visibleGroups.length}`,
            `${failedCount} 条会话导出失败 · ${visibleGroups.length} 组问题`)
            : text(`Export errors · Issue groups: ${visibleGroups.length}`, `导出错误 · ${visibleGroups.length} 组问题`)
        : text(`Export warnings · Issue groups: ${visibleGroups.length}`, `导出警告 · ${visibleGroups.length} 组提示`);
    return <div id="exportFailureCard" className="export-issues" data-severity={hasErrors ? 'error' : 'warning'}
        style={{ display: visibleGroups.length && !dismissed ? 'block' : 'none' }}>
        <div className="export-issues-header">
            <span id="exportFailureTitle">{title}</span>
            <div style={{ display: 'flex', gap: 6 }}>
                <button id="btnCopyFailedLog" className="small ghost" style={{ padding: '2px 8px', fontSize: 11, borderColor: 'var(--subtle-button-border, rgba(255,255,255,0.15))', color: 'var(--text)' }}
                    onClick={onCopy}>{text('Copy Diagnostics', '复制诊断')}</button>
                <button id="btnRetryFailed" className="small ghost" hidden={!failedCount} disabled={task.kind !== 'idle' || !ready}
                    style={{ padding: '2px 8px', fontSize: 11, borderColor: 'rgba(239,68,68,0.4)', color: 'var(--danger, #f87171)' }}
                    onClick={onRetry}>{text('Retry Failed', '重试失败项')}</button>
                <button id="btnDismissFailure" className="small ghost" title={text('Close', '关闭')}
                    style={{ padding: '2px 6px', fontSize: 11, color: 'var(--text-muted)' }} onClick={onDismiss}>✕</button>
            </div>
        </div>
        <div id="exportFailureList" style={{ maxHeight: 140, overflowY: 'auto', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.4 }}>
            {visibleGroups.map(group => <details key={JSON.stringify([group.category, group.httpStatus, group.category === 'UNKNOWN_ERROR' ? group.diagnostic.stage : null])} data-severity={group.severity}>
                <summary>{failureGroupLabel(group)}</summary>
                <div style={{ overflowWrap: 'anywhere' }}>{text('Example diagnostic: ', '示例诊断：')}
                    {`[${group.diagnostic.stage} / ${group.diagnostic.code}] ${group.diagnostic.message}`}</div>
                {group.conversations.map(({ key, title }) => <div key={`${key.accountId}/${key.conversationId}`}>
                    {title ? `${title} (${key.conversationId})` : key.conversationId}
                </div>)}
            </details>)}
        </div>
    </div>;
}

export function TaskPanel({ failureHost, ...props }: TaskPanelProps & { failureHost: HTMLElement }) {
    const { task, feedback, percent, scanMessage, scanSlow, onCancel } = props;
    const exporting = task.kind === 'export';
    const message = feedback.kind === 'empty' ? '' : typeof feedback.message === 'function' ? feedback.message() : feedback.message;
    return <>
        <p id="exportOptionsLock" role="status" hidden={!exporting} style={{ margin: 0, textAlign: 'center', fontSize: 12, lineHeight: 1.5 }}>
            {text('Exporting — options are locked', '导出中，选项已锁定')}
        </p>
        <div id="progWrap" className="progress" style={{ display: exporting || task.kind === 'takeout' ? 'block' : 'none' }}
            role="progressbar" aria-label={text('Task progress', '任务进度')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div id="bar" className="bar" style={{ width: `${percent}%` }} />
        </div>
        <div id="progText" className="stat" role="status" aria-live="polite"
            style={{ display: feedback.kind === 'progress' ? 'block' : 'none', textAlign: 'center', minHeight: 20, lineHeight: 1.5, wordBreak: 'break-word', padding: '2px 0' }}>
            {feedback.kind === 'progress' ? message : ''}
        </div>
        <div id="taskStopControls" style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
            <button id="btnCancel" className="ghost small" disabled={!exporting || task.phase !== 'running'}
                style={{ display: exporting ? 'inline-flex' : 'none', borderColor: 'var(--destructive-border, #5a2a2a)', color: 'var(--destructive-text, #f0a0a0)', margin: '0 auto' }}
                onClick={onCancel}>{exporting && task.phase === 'cancelling'
                    ? text('Cancelling…', '正在取消…') : exporting && task.phase === 'refreshing'
                        ? text('Refreshing history…', '正在刷新记录…') : text('Abort Export', '终止导出')}</button>
        </div>
        <p id="scanStatus" role="status" aria-live="polite" className="stat" hidden={scanMessage === null}
            style={{ margin: 0, textAlign: 'center', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{scanMessage ?? ''}</p>
        <div id="scanSlowHint" className="stat" role="note" style={{ display: scanSlow ? 'block' : 'none', textAlign: 'center', lineHeight: 1.5, overflowWrap: 'anywhere', padding: '2px 0' }}>
            {text('As conversation history grows, Gemini scans may take significantly longer.', '随着对话历史增加，Gemini 的扫描时间可能会显著变长。')}
        </div>
        <p id="status" role="status" aria-live="polite" className="stat" data-level={feedback.kind === 'status' ? feedback.level : undefined}
            style={{ display: feedback.kind === 'progress' ? 'none' : 'block', margin: 0, textAlign: 'center', minHeight: 20, lineHeight: 1.5, overflowWrap: 'anywhere', padding: '2px 0' }}>{message}</p>
        {createPortal(<FailureCard {...props} />, failureHost)}
    </>;
}
