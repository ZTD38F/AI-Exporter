import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { elementById } from '../../shared/elements.js';
import { TaskPanel, type TaskPanelProps } from './taskPanel.js';

/** React exclusively owns progress/status children and the adjacent failure card. */
export function mountTaskPanel() {
    const root = createRoot(elementById('taskProgressPanel'));
    const failureHost = elementById('exportFailureHost');
    return {
        render(props: TaskPanelProps): void {
            // The remaining workbench and tutorial still read these nodes synchronously.
            flushSync(() => root.render(createElement(TaskPanel, { ...props, failureHost })));
        },
        unmount(): void { root.unmount(); },
    };
}
