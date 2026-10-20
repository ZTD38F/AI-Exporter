export interface RendererStrings {
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
}

const EN: RendererStrings = {
    thinkingSummary: 'Thinking Summary',
    thinkingProgress: 'Thinking Progress',
    thinkingProcess: 'Thinking Process',
    sources: 'Sources',
    sizeUnknown: 'size unknown',
    dateUnknown: 'date unknown',
    unsupportedContent: 'Unsupported content',
    mathFallback: 'Could not typeset this formula; original LaTeX preserved:',
    systemMessage: 'System message',
    developerMessage: 'Developer message',
    unknownRole: 'Unknown role',
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
};

export function getRendererStrings(locale: 'zh' | 'en'): RendererStrings {
    return locale === 'en' ? EN : ZH;
}
