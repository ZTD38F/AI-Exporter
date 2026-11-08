/** UI operation ownership. Source scanning has an independent lifetime. */
export type ForegroundTaskStatus =
    | { kind: 'idle' }
    | { kind: 'export'; phase: 'running' | 'cancelling' | 'refreshing' }
    | { kind: 'takeout' | 'cleanup'; phase: 'running' | 'refreshing' };

/** Only the workbench coordinator can abort a run; views receive status only. */
export type ForegroundTask = { kind: 'idle' }
    | (Exclude<ForegroundTaskStatus, { kind: 'idle' }> & { controller: AbortController });

export type UiMessage = string | (() => string);
export type TaskFeedback =
    | { kind: 'empty' }
    | { kind: 'progress'; message: UiMessage }
    | { kind: 'status'; message: UiMessage; level: 'info' | 'warn' | 'error' };
