export function getErrorMessage(err: unknown): string {
    if (!err) return 'Unknown error';
    if (err instanceof Error) return err.message;
    if (typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
        return err.message;
    }
    return String(err);
}

