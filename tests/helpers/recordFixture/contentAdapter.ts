import { structuredBodyAttachments as collect } from '../../../src/l1/parsers/gemini/shared/contentAdapter.js';
import { extractImages } from './attachments.js';
/** Historical record captions retain the old generated image filenames. */
export function structuredBodyAttachments(message: { structuredContent?: unknown }) {
    return collect({ structuredImages: message.structuredContent ? extractImages(message.structuredContent) : [] });
}
