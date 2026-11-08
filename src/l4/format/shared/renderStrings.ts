interface RendererStrings {
    thinkingSummary: string;
    thinkingProgress: string;
    thinkingProcess: string;
    sources: string;
    sizeUnknown: string;
    dateUnknown: string;
    unsupportedContent: string;
    mathFallback: string;
    systemMessage: string;
    developerMessage: string;
    unknownRole: string;
    emptyConversation: string;
    imageUnavailable: string;
    fileUnavailable: string;
    roles: Record<'user' | 'assistant' | 'system' | 'developer' | 'unknown', string>;
}

const EN: RendererStrings = {
    thinkingSummary: 'Thinking Summary',
    thinkingProgress: 'Thinking Progress',
    thinkingProcess: 'Thinking Process',
    sources: 'Sources',
    sizeUnknown: 'size unknown',
    dateUnknown: 'date unknown',
    unsupportedContent: 'Unsupported',
    mathFallback: 'Could not typeset this formula; original LaTeX preserved:',
    systemMessage: 'System message',
    developerMessage: 'Developer message',
    unknownRole: 'Unknown role',
    emptyConversation: 'Empty conversation.',
    imageUnavailable: 'Image unavailable',
    fileUnavailable: 'Attachment unavailable',
    roles: { user: 'You', assistant: 'Assistant', system: 'System', developer: 'Developer', unknown: 'Message' },
};

const ZH: RendererStrings = {
    thinkingSummary: '思考摘要',
    thinkingProgress: '思考过程',
    thinkingProcess: '思考过程',
    sources: '来源',
    sizeUnknown: '大小未知',
    dateUnknown: '日期未知',
    unsupportedContent: '不支持的内容',
    mathFallback: '无法排版该公式；保留原始 LaTeX：',
    systemMessage: '系统消息',
    developerMessage: '开发者消息',
    unknownRole: '未知角色',
    emptyConversation: '暂无对话记录。',
    imageUnavailable: '图片不可用',
    fileUnavailable: '附件不可用',
    roles: { user: '你', assistant: '助手', system: '系统', developer: '开发者', unknown: '消息' },
};

export function getRendererStrings(locale: 'zh' | 'en'): RendererStrings {
    return locale === 'en' ? EN : ZH;
}
