/** Account-scoped transport deadlines survive new tasks, tabs and browser restarts. */
export async function getSourceCooldown(accountId: string): Promise<number> {
    const key = `source_cooldown_${accountId}`;
    const data = await chrome.storage.local.get<{ [key: string]: unknown }>(key);
    const value = data[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export async function extendSourceCooldown(accountId: string, until: number): Promise<number> {
    const key = `source_cooldown_${accountId}`;
    return navigator.locks.request(key, async () => {
        const deadline = Math.max(await getSourceCooldown(accountId), until);
        await chrome.storage.local.set({ [key]: deadline });
        return deadline;
    });
}
