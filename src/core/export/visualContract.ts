/** Phase 1 semantic hierarchy. HTML uses px; PDF uses pt/mm.
 * Keep typography and visual spacing independent of pagination constraints.
 */
export const visual = {
    content: { maxWidth: 880, proseWidth: 720, pageSidePadding: 32 },
    spacing: { inline: 6, paragraph: 12, block: 18, section: 30, turn: 40 },
    type: {
        title: { size: 30, weight: 650, lineHeight: 1.2 },
        h2: { size: 23, weight: 650, lineHeight: 1.3 },
        h3: { size: 18, weight: 620, lineHeight: 1.4 },
        body: { size: 16, weight: 400, lineHeight: 1.7 },
        small: { size: 13, weight: 400, lineHeight: 1.5 },
        metadata: { size: 12, weight: 400, lineHeight: 1.4 },
    },
} as const;
