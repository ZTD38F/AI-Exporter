import type { ForegroundTask, ForegroundTaskStatus, TaskFeedback } from '../src/ui/options/state/foregroundTask.js';

declare function status(task: ForegroundTaskStatus): void;
declare function operation(task: ForegroundTask): void;
declare function feedback(value: TaskFeedback): void;
status({ kind: 'idle' });
status({ kind: 'export', phase: 'cancelling' });
operation({ kind: 'cleanup', phase: 'refreshing', controller: new AbortController() });
feedback({ kind: 'status', message: 'Done', level: 'info' });
// @ts-expect-error Only an export can be cancelling.
status({ kind: 'takeout', phase: 'cancelling' });
// @ts-expect-error An idle task cannot own a cancellation controller.
operation({ kind: 'idle', controller: new AbortController() });
// @ts-expect-error An active operation must own its lifetime controller.
operation({ kind: 'export', phase: 'running' });
// @ts-expect-error Empty feedback cannot retain stale progress text.
feedback({ kind: 'empty', message: 'Old task' });
