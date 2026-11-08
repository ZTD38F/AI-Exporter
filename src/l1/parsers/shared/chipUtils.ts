
const INTERNAL_CHIP_TOKEN_PATTERN =
    '(?:immersive_entry_chip|deep_research(?:_confirmation_content)?|map_(?:content|location(?:_reference)?)|grounding_content|web_search(?:_content)?|youtube_content|flights_content|hotels_content|workspace_content|shopping_content|lmdx_image|image_?generation_?content|generated_image)';

const INTERNAL_CHIP_URL_RE = new RegExp(
    `https?:\\/\\/googleusercontent\\.com\\/${INTERNAL_CHIP_TOKEN_PATTERN}`,
    'i'
);

export function isInternalChipUrl(u?: string | null): boolean {
    if (!u) return false;
    return INTERNAL_CHIP_URL_RE.test(u);
}

export function stripInternalChipMarkdown(text?: string | null): string {
    if (!text) return '';

    const standaloneRe = new RegExp(
        `(?:^|\\n)\\s*(?:\\[)?https?:\\/\\/googleusercontent\\.com\\/${INTERNAL_CHIP_TOKEN_PATTERN}(?:\\/[^\\s\\n\\]]*)?(?:\\])?\\s*(?=\\n|$)`,
        'gi'
    );
    const linkWithTitleRe = new RegExp(
        `\\[([^\\]]+)\\]\\(https?:\\/\\/googleusercontent\\.com\\/${INTERNAL_CHIP_TOKEN_PATTERN}[^\\)]*\\)`,
        'gi'
    );
    const rawUrlRe = new RegExp(
        `https?:\\/\\/googleusercontent\\.com\\/${INTERNAL_CHIP_TOKEN_PATTERN}(?:\\/[^\\s\\n\\)]*)?`,
        'gi'
    );

    const imageAgentTagRe = /<Image\s+[^>]*src=["']image_agent_tag_[^"']*["'][^>]*\/?>/gi;
    const elicitationsGroupRe = /<ElicitationsGroup\b[\s\S]*?<\/ElicitationsGroup>/gi;
    const elicitationPairedRe = /<Elicitation\b[\s\S]*?<\/Elicitation>/gi;
    const elicitationSelfClosingRe = /<Elicitation\b[^>]*\/?>/gi;
    const followUpPairedRe = /<FollowUp\b[\s\S]*?<\/FollowUp>/gi;
    const followUpSelfClosingRe = /<FollowUp\b[^>]*\/?>/gi;
    const generateWidgetPairedRe = /<GenerateWidget\b[\s\S]*?<\/GenerateWidget>/gi;
    const generateWidgetSelfClosingRe = /<GenerateWidget\b[^>]*\/?>/gi;

    let cleaned = text.replace(standaloneRe, '\n');
    cleaned = cleaned.replace(linkWithTitleRe, '$1');
    cleaned = cleaned.replace(rawUrlRe, '');
    cleaned = cleaned.replace(imageAgentTagRe, '');
    cleaned = cleaned.replace(elicitationsGroupRe, '');
    cleaned = cleaned.replace(elicitationPairedRe, '');
    cleaned = cleaned.replace(elicitationSelfClosingRe, '');
    cleaned = cleaned.replace(followUpPairedRe, '');
    cleaned = cleaned.replace(followUpSelfClosingRe, '');
    cleaned = cleaned.replace(generateWidgetPairedRe, '');
    cleaned = cleaned.replace(generateWidgetSelfClosingRe, '');
    // This also receives complete Markdown answers, including fenced code.
    // Preserve authored whitespace; global blank-line cleanup changes code.
    return cleaned;
}
