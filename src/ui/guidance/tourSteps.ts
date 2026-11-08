import { EXPORT_FORMATS, text } from '../shared/settings.js';
export interface TourStep {
    id: string; target: () => HTMLElement | null; title: () => string; description: () => string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    hint?: () => string;
    setupAction?: (advance: () => void) => () => void;
}
/** Delayed advancement belongs to the step and is cancelled with its listeners. */
export function bindDelayedActions(bindings: [EventTarget | null, string][], advance: () => void, delay = 250, ready: () => boolean = () => true): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAction = (event: Event) => {
        const target = event.target;
        if (event.type === 'change' && target instanceof HTMLInputElement && target.type === 'checkbox' && !target.checked) return;
        if (timer !== undefined) return;
        timer = setTimeout(() => { timer = undefined; if (ready()) advance(); }, delay);
    };
    for (const [target, event] of bindings) target?.addEventListener(event, onAction);
    return () => { clearTimeout(timer); for (const [target, event] of bindings) target?.removeEventListener(event, onAction); };
}
const target = (id: string) => () => document.getElementById(id);
/** A menu option confirms selection even when its value has not changed. */
function bindSelectConfirmation(id: string, next: () => void): () => void {
    const selector = target(id)();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const confirmSelection = (event: Event) => {
        const confirmed = event.type === 'change'
            || event.type === 'click' && event.target instanceof HTMLOptionElement
            || event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ') && selector?.matches(':open');
        if (confirmed && selector instanceof HTMLSelectElement) {
            clearTimeout(timer);
            const value = selector.value;
            timer = setTimeout(() => {
                timer = undefined;
                // A failed save restores the previous value; an in-flight save
                // disables the selector and completes through beginStepAction.
                if (!selector.disabled && selector.value === value
                    && Array.from(selector.options).some(option => option.value === value && !option.disabled)
                    && (id !== 'format' || EXPORT_FORMATS.some(format => format === value))) next();
            }, 250);
        }
    };
    // Opening the menu is not confirmation; choosing the current option is.
    for (const event of ['change', 'click']) selector?.addEventListener(event, confirmSelection);
    selector?.addEventListener('keydown', confirmSelection, true);
    return () => {
        clearTimeout(timer);
        for (const event of ['change', 'click']) selector?.removeEventListener(event, confirmSelection);
        selector?.removeEventListener('keydown', confirmSelection, true);
    };
}
/** Only account switching is shared with the full tutorial. */
export const ACCOUNT_STEP: TourStep = { id: 'accounts', target: () => document.querySelector<HTMLElement>('.conversation-source'), placement: 'bottom',
        title: () => text('Switch platforms and accounts', '切换平台与账号'),
        description: () => text('Accounts identified on authorized platforms appear here. Use the highlighted selector to switch between platforms and accounts, then scan and export the selected account’s conversations.', '已授权平台上识别到的账号会显示在这里。点击高亮的账号选择框，即可切换不同平台、不同账号，再扫描和导出所选账号的对话。'),
        setupAction: next => bindSelectConfirmation('accountIdSelect', next) };
export const PLATFORM_STEPS: TourStep[] = [
    { id: 'platforms', target: () => null,
        title: () => text('Multi-platform support (Beta)', '多平台支持（测试版）'),
        description: () => text('Gemini Exporter 2.1 now supports Gemini, ChatGPT, Claude and Grok. Authorize the sites you use and manage conversations from different platforms and accounts in one place.', 'Gemini Exporter 2.1 新增多平台支持：Gemini、ChatGPT、Claude 和 Grok。授权你使用的网站，即可在同一个工作台管理不同平台、不同账号的对话。') },
    { id: 'site_access', target: target('btnPlatformPermissions'), placement: 'bottom',
        title: () => text('Authorize the sites you use', '授权指定网站'),
        description: () => text('Click the highlighted Site access button, select the platforms you need, and authorize their conversation and attachment sites. You can change site access here at any time.', '点击高亮的「网站授权」按钮，勾选需要的平台，授权对应的会话和附件网站。以后也可以随时从这里管理网站授权。'),
        hint: () => text('Try Site access, or choose Next.', '点击「网站授权」试试看，或使用「下一步」。') },
    ACCOUNT_STEP,
];
export const AUTHORIZATION_STEP: TourStep = { id: 'connect', target: () => null, title: () => text('Authorize AI platforms', '授权 AI 平台'), description: () => text('Select the platforms you want to use, then authorize their conversation and attachment sites in Chrome.', '勾选需要使用的平台，然后通过 Chrome 授权访问其会话与附件网站。') };
export const STEPS: TourStep[] = [
    AUTHORIZATION_STEP,
    { id: 'identify_account', target: () => null,
        title: () => text('Connect an account', '识别平台账号'),
        description: () => text('Connect an authorized platform to identify your account. If needed, sign in on the platform tab.', '点击下方按钮连接已授权的平台，识别账号后即可继续；如尚未登录，请前往平台页面登录。') },
    ACCOUNT_STEP,
    { id: 'sync', placement: 'bottom', target: target('btnSyncAll'), title: () => text('Scan conversations', '扫描对话'), description: () => text('Scan the connected platform. Once the first conversations appear, continue selecting while scanning runs.', '扫描已连接的平台。首批对话显示后，教程会继续，你可以边扫描边勾选。'), hint: () => text('Click Scan to try it, or use Next.', '点击扫描体验，或使用「下一步」。') },
    { id: 'select', placement: 'left', target: () => document.querySelector('#list .item'), title: () => text('Select conversations', '选择对话'), description: () => text('Select one conversation to try exporting.', '勾选一条对话，体验导出。'), hint: () => document.querySelector('#list .item')
        ? text('Select the highlighted conversation to continue.', '勾选高亮的这条对话即可继续。')
        : text('No conversations yet. Scan conversations first, or choose Next to explore the remaining steps.', '暂无对话。请先扫描对话，或点击「下一步」浏览后续步骤。'), setupAction: next => bindDelayedActions([[target('list')(), 'change'], [target('list')(), 'conversation-selection-change']], next, 250,
        () => document.querySelectorAll('#list .item input[type=checkbox]:checked').length === 1) },
    { id: 'format', placement: 'right', target: target('format'), title: () => text('Choose a format', '选择格式'), description: () => text('Markdown, HTML, PDF, Word and JSON share one export workflow.', 'Markdown、HTML、PDF、Word 和 JSON 共用同一导出流程。'), hint: () => text('Choose an export format to continue.', '选择导出格式即可继续。'), setupAction: next => bindSelectConfirmation('format', next) },
    { id: 'export', placement: 'right', target: target('btnExport'), title: () => text('Export selected conversations', '导出选中对话'), description: () => text('Download in your browser or write into an authorized folder. Multiple download files are automatically zipped.', '在浏览器下载或写入已授权目录。多个下载文件自动打包 ZIP。'), hint: () => text('Click Export. The tutorial continues when the export finishes, or choose Next to skip.', '点击导出，完成后教程会继续；也可以使用「下一步」跳过。') },
    { id: 'live_save', placement: 'right',
        target: () => document.querySelector<HTMLElement>('#localFolderControls[data-authorized="true"] #liveSaveControls')
            ?? document.querySelector<HTMLElement>('.delivery-card:has(input[value="folderWriter"])'),
        title: () => text('Live Save', '实时保存'),
        description: () => text('Markdown has been selected for this step. Select Save to local folder and authorize it, then enable Live Save (only effective with MD format); browser download or other formats pause it without forgetting your preference.', '已为此步骤切换到 Markdown（MD）。先选择「保存到本地文件夹」并授权目录，再开启实时保存（只有在选择 MD 格式时生效）。切换到浏览器下载或其他格式时会暂停，不会清除原来的开启状态。'),
        hint: () => text('Select Save to local folder to choose a directory, then enable Live Save. You can also use Next.', '选择「保存到本地文件夹」会弹出目录选择，选好后开启实时保存；也可以使用「下一步」。') },
    { id: 'feedback', placement: 'right', target: () => document.querySelector<HTMLElement>('.support-links'), title: () => text('Optional feedback', '可选反馈'), description: () => text('Join Discord for faster feedback!', '加入 Discord 获取更加及时的反馈！'), setupAction: next => bindDelayedActions([[document.querySelector('#feedbackBox[href]'), 'click'], [document.querySelector('#discordBox[href]'), 'click']], next, 0) }
];
