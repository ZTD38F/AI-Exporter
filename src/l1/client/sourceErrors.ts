/** Positive native evidence of an empty conversation, distinct from an unreadable response. */
export class ConfirmedSourceEmptyError extends Error {
    constructor() {
        super('SOURCE_CONVERSATION_EMPTY: Source returned empty prompts and answers');
        this.name = 'ConfirmedSourceEmptyError';
    }
}
