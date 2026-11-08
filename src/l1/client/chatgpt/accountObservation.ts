import type { Account } from '../../../l2/accountRegistry.js';

function text(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim() || undefined : undefined;
}

/** Session evidence only. A ChatGPT archive scope is one login subject in one workspace. */
export function chatgptAccountObservation(session: unknown): Omit<Account, 'id'> | null {
    return readChatGPTSession(session).observation;
}

/** Trust only the Session fields needed by the provider. */
export function readChatGPTSession(session: unknown) {
    const raw = session !== null && typeof session === 'object' && !Array.isArray(session) ? session : null;
    const rawUser = raw && 'user' in raw ? raw.user : undefined;
    const rawWorkspace = raw && 'account' in raw ? raw.account : undefined;
    const user = rawUser !== null && typeof rawUser === 'object' && !Array.isArray(rawUser) ? rawUser : null;
    const workspace = rawWorkspace !== null && typeof rawWorkspace === 'object' && !Array.isArray(rawWorkspace) ? rawWorkspace : null;
    const userId = text(user && 'id' in user ? user.id : undefined);
    const workspaceId = text(workspace && 'id' in workspace ? workspace.id : undefined);
    const email = text(user && 'email' in user ? user.email : undefined);
    const displayName = text(user && 'name' in user ? user.name : undefined);
    const observation: Omit<Account, 'id'> | null = userId && workspaceId && workspaceId !== 'default' ? {
        providerId: 'chatgpt',
        // Canonical tuple encoding avoids ambiguous concatenation; neither ID is interchangeable.
        providerAccountId: JSON.stringify([userId, workspaceId]),
        ...(email ? { email: email.toLowerCase() } : {}),
        ...(displayName ? { displayName } : {}),
    } : null;
    const token = raw && 'accessToken' in raw ? raw.accessToken : undefined;
    return {
        accessToken: typeof token === 'string' && token.trim() ? token : null,
        accountName: email ?? displayName,
        observation,
    };
}
