import { chatGPTConversationId } from './observation.js';

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Request-independent SSR evidence, bound to the workspace which rendered it.
 * Only list fields cross worlds; bootstrap auth/session data never does. */
export async function chatGPTSidebarPage(history: unknown, identity: () => Promise<string | null>) {
    if (!record(history) || typeof history.accountId !== 'string' || !history.chats) return null;
    const before = await identity();
    if (!before || JSON.parse(before)[1] !== history.accountId) return null;
    const page: unknown = await history.chats;
    if (!record(page)) return null;
    const items: unknown = page.items;
    if (!Array.isArray(items) || items.length > 100
        || !items.every((item): item is Record<string, unknown> & { id: string } =>
            record(item) && chatGPTConversationId(item.id))) return null;
    const responseBody = { items: items.map(item => ({
        id: item.id, title: item.title, create_time: item.create_time, update_time: item.update_time,
    })), total: page.total, offset: page.offset, limit: page.limit };
    if (await identity() !== before) return null;
    return { requestIdentity: before, responseBody };
}

type SidebarCapturePayload = NonNullable<Awaited<ReturnType<typeof chatGPTSidebarPage>>> & { kind: 'sidebar'; url: string };
export function installChatGPTSidebarCapture(identity: () => Promise<string | null>,
    emit: (payload: SidebarCapturePayload) => void): void {
    let attempts = 0;
    const timer = setInterval(() => {
        if (++attempts > 240) { clearInterval(timer); return; }
        const root: unknown = Reflect.get(window, '__reactRouterDataRouter');
        if (!record(root) || !record(root.state) || !record(root.state.loaderData)) return;
        const layout = root.state.loaderData['authenticated-layout.route'];
        if (!record(layout) || !layout.sidebarHistory) return;
        clearInterval(timer);
        void chatGPTSidebarPage(layout.sidebarHistory, identity).then(payload => {
            if (payload) {
                emit({ kind: 'sidebar', url: location.href, ...payload });
            }
        }).catch(error => console.debug('[ChatGPT sidebar]', error));
    }, 250);
}
