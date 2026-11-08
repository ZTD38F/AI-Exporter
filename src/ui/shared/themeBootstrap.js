/* Apply the existing v2 Settings theme before the first visible frame.
 * Keep this tiny head script independent of the heavier Options/Popup bundles.
 * The persisted key is owned by l3a/settingsStore.ts; no second preference store. */
(() => {
    const key = 'gemini_exporter_v2_settings';
    const root = document.documentElement;
    const show = (theme) => {
        // The app's normal Settings reader may have resolved first.
        if (root.dataset.theme === 'loading') root.dataset.theme = theme === 'light' ? 'light' : 'dark';
        const reveal = () => {
            // Reveal with the stored colors while transitions remain disabled.
            // Restore ordinary animations only after one complete visible frame.
            requestAnimationFrame(() => {
                root.removeAttribute('data-theme-unready');
                requestAnimationFrame(() => root.removeAttribute('data-theme-bootstrap'));
            });
        };
        if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', reveal, { once: true });
        else reveal();
    };
    try {
        chrome.storage.local.get(key).then(data => show(data[key]?.theme)).catch(() => show('dark'));
    } catch {
        show('dark');
    }
})();
