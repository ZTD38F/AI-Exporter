export class GeminiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GeminiError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class ExportPipelineError extends GeminiError {
    chatId?: string;
    step?: 'init' | 'fetch' | 'format' | 'write' | 'asset' | 'package';
    isPermissionRevoked?: boolean;

    constructor(message: string, chatId?: string, step?: 'init' | 'fetch' | 'format' | 'write' | 'asset' | 'package', isPermissionRevoked: boolean = false) {
        super(message);
        this.name = 'ExportPipelineError';
        this.chatId = chatId;
        this.step = step;
        this.isPermissionRevoked = isPermissionRevoked;
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

export class StorageError extends GeminiError {
    operation?: string;
    key?: string;

    constructor(message: string, operation?: string, key?: string) {
        super(message);
        this.name = 'StorageError';
        this.operation = operation;
        this.key = key;
    }
}
