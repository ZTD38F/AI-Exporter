/** Fixed reading labels; authored source text always wins, independent of renderer locale. */
export const readingLabels = Object.freeze({ title: 'Untitled conversation', image: 'Image', file: 'Attachment', reasoning: 'Thinking Process' });

export function resourceLabel(explicit: string | undefined, name: string | undefined, kind: 'image' | 'file'): string {
    return explicit?.trim() ? explicit : name?.trim() ? name : readingLabels[kind];
}
