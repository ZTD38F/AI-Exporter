import { normId } from "../../utils/pathUtils.js";

export function toOpenAIJson(chat: any): string {
    const messages = (chat.messages || []).map((m: any) => {
        const role = m.role === 'model' ? 'assistant' : 'user';
        const text = m.content || '';
        const imgs = (m.attachments || []).filter((a: any) => a.type === 'image');
        const item: any = {};

        if (imgs.length > 0) {
            const contentArr: any[] = [];
            if (text) contentArr.push({ type: 'text', text });
            for (const im of imgs) {
                contentArr.push({
                    type: 'image_url',
                    image_url: {
                        url: im.localName || im.src || im.originalUrl
                    }
                });
            }
            item.role = role;
            item.content = contentArr;
        } else {
            item.role = role;
            item.content = text;
        }

        const thoughtsRaw = (m as any).thoughts || (m as any).thinking || '';
        const thoughts = (Array.isArray(thoughtsRaw) ? thoughtsRaw.join('\n\n') : String(thoughtsRaw)).trim();
        if (thoughts) {
            item.reasoning_content = thoughts;
        }

        return item;
    });

    const convUrl = chat.url || (chat.id ? `https://gemini.google.com/app/${normId(chat.id)}` : '');
    return JSON.stringify({
        id: chat.id,
        title: chat.title,
        url: convUrl,
        created_at: chat.createdAt ? new Date(chat.createdAt).toISOString() : void 0,
        messages: messages
    }, null, 2);
}

export function toJsonStandard(chat: any): string {
    return JSON.stringify(chat, null, 2);
}

export function toJsonRaw(chat: any): string {
    return JSON.stringify(chat._raw || chat, null, 2);
}
