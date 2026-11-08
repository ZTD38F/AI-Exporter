/** Base HTMLElement lookup for operations shared by every page element. */
export function elementById(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing page element: ${id}`);
    return element;
}

/** The native tag query establishes the element type; callers cannot choose an arbitrary subtype. */
export function requiredElement<K extends keyof HTMLElementTagNameMap>(tag: K, id: string): HTMLElementTagNameMap[K] {
    const element = document.getElementsByTagName(tag).namedItem(id);
    if (!element) throw new Error(`Missing ${tag} element: ${id}`);
    return element;
}
