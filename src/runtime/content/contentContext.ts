interface GeminiCredentials {
    at?: string;
    bl?: string;
    sid?: string;
    accountSlot?: string;
    lastUsed?: number;
    url?: string;
}

/** The only capability ContentContext consumes from its active client. */
export interface ActiveClientContract {
    abort?: () => void;
}

/** Browser global is the mirror; tests may explicitly inject a mirror or null. */
type ContentWindowMirror = Pick<Window,
    '__gemExporterContentContext' | '__gemExporterAborted' | '__gemExporterActiveClient'
    | '__gemExporterDevMode'
    | '__gemExporterExtractedAt' | '__gemExporterExtractedBl' | '__geminiAt'
>;

export class ContentContext {
    private _aborted = false;
    private _activeClient: ActiveClientContract | null = null;
    private _credentials: GeminiCredentials | null = null;
    private _devMode = false;

    // Resolve the browser capability once at construction. Runtime methods
    // never need to re-check a global whose availability is fixed per context.
    constructor(private readonly _window: ContentWindowMirror | null = globalThis) {
        this._syncWindowMirrors();
    }

    private _syncWindowMirrors(): void {
        if (!this._devMode || !this._window) return;
        const w = this._window;
        w.__gemExporterContentContext = this;
        w.__gemExporterAborted = this._aborted;
        w.__gemExporterActiveClient = this._activeClient;
        w.__gemExporterDevMode = this._devMode;
    }

    public isAborted(): boolean {
        return this._aborted;
    }

    public setAborted(val: boolean): void {
        this._aborted = val;
        if (this._devMode && this._window) {
            this._window.__gemExporterAborted = val;
        }
    }

    public abort(): void {
        this.setAborted(true);
        try {
            this._activeClient?.abort?.();
        } catch {
            /* intentional: best-effort abort */
        }
    }

    public getActiveClient(): ActiveClientContract | null {
        return this._activeClient;
    }

    public setActiveClient(client: ActiveClientContract | null): void {
        this._activeClient = client;
        if (this._devMode && this._window) {
            this._window.__gemExporterActiveClient = client;
        }
    }

    public setCredentials(creds: Partial<GeminiCredentials> | null): void {
        if (!creds) {
            this._credentials = null;
        } else {
            this._credentials = { ...(this._credentials || {}), ...creds };
            if (this._devMode && this._credentials.at && this._window) {
                this._window.__gemExporterExtractedAt = this._credentials.at;
                this._window.__geminiAt = this._credentials.at;
            }
            if (this._devMode && this._credentials.bl && this._window) {
                this._window.__gemExporterExtractedBl = this._credentials.bl;
            }
        }
    }

    public isDevMode(): boolean {
        return this._devMode;
    }

    public setDevMode(val: boolean): void {
        this._devMode = val;
        if (this._window) {
            this._window.__gemExporterDevMode = val;
            if (val) this._syncWindowMirrors();
        }
    }


}

export const contentContext = new ContentContext();
