import { payloadToMs } from './payload.js';

const absent = (value: unknown): boolean => value == null || Array.isArray(value) && value.every(absent);

/** Decode native source shape once; pagination must not reinterpret raw payloads. */
export function classifyDetailBody(inner: unknown, conversationId: string):
    'metadata_only' | 'empty_turn_array' | 'confirmed_empty_turns' | undefined {
    if (!Array.isArray(inner)) return undefined;
    const metadata: unknown = Array.isArray(inner[2]) ? inner[2][0] : null;
    if (inner[0] === null && inner[1] === null && Array.isArray(metadata)
        && typeof metadata[0] === 'string' && metadata[0].startsWith('c_')) return 'metadata_only';
    if (Array.isArray(inner[0]) && inner[0].length === 0 && inner[1] === null
        && typeof inner[2] === 'string' && inner[2].trim().length > 0) return 'empty_turn_array';
    if (!Array.isArray(inner[0]) || !inner[0].length || !inner.slice(1).every(absent)) return undefined;
    const confirmed = inner[0].every((turn: unknown) => {
        if (!Array.isArray(turn) || !Array.isArray(turn[0]) || turn[0][0] !== `c_${conversationId.replace(/^c_/, '')}`
            || turn[0].length !== 2 || payloadToMs(turn[4]) === null
            || typeof turn[0][1] !== 'string' || !turn[0][1].startsWith('r_')
            || JSON.stringify(turn[2]) !== '[[""]]') return false;
        const model: unknown = turn[3];
        if (!Array.isArray(model) || !Array.isArray(model[0]) || !model[0].length) return false;
        if (!turn.every((value, index) => [0, 2, 3, 4].includes(index) || absent(value))) return false;
        if (!model.every((value, index) => index === 0 || absent(value)
            || index === 3 && typeof value === 'string' && value.startsWith('rc_')
            || index === 8 && typeof value === 'string' && /^[A-Z]{2}$/.test(value)
            || index === 24 && value === 1)) return false;
        return model[0].every((candidate: unknown) => Array.isArray(candidate)
            && typeof candidate[0] === 'string' && candidate[0].startsWith('rc_')
            && JSON.stringify(candidate[1]) === '[""]'
            && candidate.every((value, index) => index < 2 || absent(value)));
    });
    return confirmed ? 'confirmed_empty_turns' : undefined;
}
