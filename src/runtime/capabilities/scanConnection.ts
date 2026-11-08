import type { SourcePlatform } from '../../shared/platformHosts.js';

/** A selected account has no verified signed-in source; website permission alone is insufficient. */
export class ScanConnectionError extends Error {
    constructor(readonly platform: SourcePlatform, message: string) {
        super(message);
        this.name = 'ScanConnectionError';
    }
}
