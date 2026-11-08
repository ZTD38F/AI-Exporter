/** Deliberately small data-expression interpreter. No provider code is executed. */
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
export type Scope = Map<string, Value>;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const escapes: ReadonlyMap<string, string> = new Map([['n', '\n'], ['r', '\r'], ['t', '\t'], ['b', '\b'], ['f', '\f']]);
// Long operators precede their prefixes; each token carries its own precedence.
const operators: readonly (readonly [string, number])[] = [
    ['||', 1], ['&&', 2], ['===', 3], ['!==', 3], ['==', 3], ['!=', 3],
    ['<=', 4], ['>=', 4], ['<', 4], ['>', 4], ['+', 5], ['-', 5], ['*', 6], ['/', 6], ['%', 6],
];

export function expression(source: string, scope: Scope): Value {
    let at = 0, budget = 4000, depth = 0;
    const space = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++; };
    const take = (token: string) => { space(); if (!source.startsWith(token, at)) return false; at += token.length; return true; };
    const requireToken = (token: string) => { if (!take(token)) throw new Error('Expected expression token'); };
    const member = (value: Value, key: Value): Value => {
        if (typeof key !== 'string' && typeof key !== 'number') throw new Error('Invalid member');
        if (forbidden.has(String(key))) throw new Error('Forbidden member');
        if (key === 'length' && (Array.isArray(value) || typeof value === 'string')) return value.length;
        if (Array.isArray(value) && Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < value.length) return value[Number(key)];
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)) return value[String(key)];
        throw new Error('Unknown member');
    };
    const read = (minimum = 0): Value => {
        if (--budget < 0 || ++depth > 40) throw new Error('Expression limit');
        space(); let value: Value;
        if (take('!')) value = !read(8);
        else if (take('-')) { const v = read(8); if (typeof v !== 'number') throw new Error('Expected number'); value = -v; }
        else if (take('(')) { value = read(); requireToken(')'); }
        else if (take('[')) {
            value = []; if (!take(']')) { do { value.push(read()); } while (take(',')); requireToken(']'); }
        } else if (take('{')) {
            const object: Record<string, Value> = {};
            Object.setPrototypeOf(object, null);
            if (!take('}')) {
                do {
                    space(); let key: string;
                    if (/['"]/.test(source[at] ?? '')) { const v = atomString(); key = v; }
                    else { const m = /^[A-Za-z_$][\w$]*/.exec(source.slice(at)); if (!m) throw new Error('Invalid key'); key = m[0]; at += key.length; }
                    if (forbidden.has(key)) throw new Error('Forbidden key');
                    requireToken(':'); object[key] = read();
                } while (take(','));
                requireToken('}');
            }
            value = object;
        } else if (/['"]/.test(source[at] ?? '')) value = atomString();
        else {
            const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at));
            if (number) { value = Number(number[0]); at += number[0].length; }
            else {
                const name = /^[A-Za-z_$][\w$]*/.exec(source.slice(at))?.[0];
                if (!name || forbidden.has(name)) throw new Error('Unsupported expression');
                at += name.length;
                if (name === 'true' || name === 'false' || name === 'null') value = name === 'null' ? null : name === 'true';
                else if ((name === 'String' || name === 'Number') && take('(')) {
                    const arg = read(); requireToken(')');
                    if (arg !== null && typeof arg === 'object') throw new Error('Expected scalar');
                    value = name === 'String' ? String(arg) : Number(arg);
                } else {
                    const bound = scope.get(name);
                    if (bound === undefined) throw new Error('Unbound expression');
                    value = bound;
                }
            }
        }
        for (;;) {
            if (take('.')) {
                space(); const key = /^[A-Za-z_$][\w$]*/.exec(source.slice(at))?.[0];
                if (!key) throw new Error('Invalid member'); at += key.length;
                if (key === 'includes' && take('(')) {
                    const arg = read(); requireToken(')');
                    if (Array.isArray(value)) value = value.includes(arg);
                    else if (typeof value === 'string' && typeof arg === 'string') value = value.includes(arg);
                    else throw new Error('Unsupported includes');
                } else value = member(value, key);
            } else if (take('[')) { const key = read(); requireToken(']'); value = member(value, key); }
            else break;
        }
        for (;;) {
            space(); const operator = operators.find(([token]) => source.startsWith(token, at));
            if (!operator || operator[1] < minimum) break;
            const [op, precedence] = operator;
            at += op.length; const right = read(precedence + 1);
            if (op === '==') value = value === right;
            else if (op === '===') value = value === right;
            else if (op === '!==' || op === '!=') value = value !== right;
            else if (op === '&&') value = value ? right : value;
            else if (op === '||') value = value ? value : right;
            else if (op === '+' && (typeof value === 'string' || typeof right === 'string')) value = String(value) + String(right);
            else {
                if (typeof value !== 'number' || typeof right !== 'number') throw new Error('Expected numeric operands');
                switch (op) {
                    case '<': value = value < right; break; case '>': value = value > right; break;
                    case '<=': value = value <= right; break; case '>=': value = value >= right; break;
                    case '+': value += right; break; case '-': value -= right; break;
                    case '*': value *= right; break; case '/': value /= right; break; case '%': value %= right; break;
                }
            }
        }
        if (minimum === 0 && take('?')) { const yes = read(); requireToken(':'); const no = read(); value = value ? yes : no; }
        if (typeof value === 'string' && value.length > 1_000_000) throw new Error('Expression string limit');
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite expression');
        depth--; return value;
    };
    function atomString(): string {
        const quote = source[at++]; let result = '';
        while (at < source.length) {
            const c = source[at++]; if (c === quote) return result;
            if (c !== '\\') { result += c; continue; }
            const escaped = source[at++];
            if (escaped === 'u') { const hex = source.slice(at, at + 4); if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('Invalid escape'); result += String.fromCharCode(parseInt(hex, 16)); at += 4; }
            else result += escapes.get(escaped) ?? escaped;
        }
        throw new Error('Unterminated string');
    }
    const value = read(); space(); if (at !== source.length) throw new Error('Unsupported expression tail'); return value;
}
