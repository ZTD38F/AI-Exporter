/** Edit length-framed captured transport without involving the production parser. */
export function editCapturedRpc(body: string, rpc: string, edit: (inner: unknown[]) => void): string {
    const lines = body.split('\n');
    let found = false;
    for (let i = 2; i < lines.length - 1; i += 2) {
        const frame = JSON.parse(lines[i + 1]) as unknown[][];
        const overhead = Number(lines[i]) - lines[i + 1].length;
        for (const row of frame) {
            if (row[0] !== 'wrb.fr' || row[1] !== rpc || typeof row[2] !== 'string') continue;
            const inner: unknown = JSON.parse(row[2]);
            if (!Array.isArray(inner)) throw new Error(`Captured ${rpc} payload is not an array`);
            edit(inner);
            row[2] = JSON.stringify(inner);
            found = true;
        }
        lines[i + 1] = JSON.stringify(frame);
        lines[i] = String(lines[i + 1].length + overhead);
    }
    if (!found) throw new Error(`Missing captured ${rpc} frame`);
    return lines.join('\n');
}
