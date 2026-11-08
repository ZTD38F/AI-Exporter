import type { ResourceFailure } from '../../../shared/resources/resourceResult.js';

/** Frozen public options shared by Markdown, HTML and Typst renderers. */
export interface RendererOptions {
    locale?: 'zh' | 'en';
    resourceFailures?: Readonly<Record<string, ResourceFailure>>;
}
