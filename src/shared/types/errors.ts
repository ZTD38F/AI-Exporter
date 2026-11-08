export class GeminiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GeminiError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class TakeoutParseError extends GeminiError {
    formatDrift?: boolean;
    entryName?: string;

    constructor(message: string, formatDrift: boolean = false, entryName?: string) {
        super(message);
        this.name = 'TakeoutParseError';
        this.formatDrift = formatDrift;
        this.entryName = entryName;
    }
}
