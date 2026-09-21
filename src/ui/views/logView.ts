// src/ui/views/logView.ts - Log rendering, no business logic
import type { ILogView } from '../../types/ui.js';

interface LogEntry {
    time: string;
    level: string;
    tag: string;
    msg: string;
}

const buf: LogEntry[] = [];
const levelTag: Record<string, string> = { info: 'I', warn: 'W', error: 'E' };
let _renderEl: HTMLElement | null = null;

export function init(elId?: string): void {
    _renderEl = document.getElementById(elId || 'log');
}

export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (!msg) return;
    const t = new Date().toTimeString().slice(0, 8);
    const tag = levelTag[level] || 'I';
    const last = buf[buf.length - 1];
    if (last && last.msg === msg && last.level === level && last.time === t) {
        return;
    }
    buf.push({ time: t, level, tag, msg });
    if (buf.length > 500) buf.shift();
    render();
}

export function clear(): void {
    buf.length = 0;
    render();
}

export function render(): void {
    if (typeof document === 'undefined') return;
    const el = _renderEl || document.getElementById('log');
    if (!el) return;
    const filterInput = document.getElementById('logFilter') as HTMLInputElement | null;
    const kw = (filterInput ? filterInput.value : '').trim().toLowerCase();
    const levelSelect = document.getElementById('logLevel') as HTMLSelectElement | null;
    const lvl = levelSelect ? levelSelect.value : 'all';
    let list = buf;
    if (lvl === 'error') list = list.filter(x => x.level === 'error');
    else if (lvl === 'warn') list = list.filter(x => x.level === 'warn' || x.level === 'error');
    else if (lvl === 'info') list = list.filter(x => x.level === 'info' || x.level === 'warn');
    if (kw) list = list.filter(x => (`[${x.time}] [${x.tag}] ${x.msg}`).toLowerCase().includes(kw));
    el.textContent = list.map(x => `[${x.time}] [${x.tag}] ${x.msg}`).join('\n');
    el.scrollTop = el.scrollHeight;
}

export function getBuffer(): LogEntry[] {
    return buf.slice();
}

export const LogView: ILogView = {
    init,
    log,
    clear,
    render,
    getBuffer
};

(LogView as any).LogView = LogView;
(LogView as any).default = LogView;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).LogView = LogView;
}
if (typeof module === 'object' && module.exports) {
    module.exports = LogView;
}
export default LogView;
