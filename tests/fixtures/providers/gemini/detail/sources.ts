import sourceJson0 from '../../../provider/structured_rpc/live-combined-file-citations.json';
import sourceJson1 from '../../../provider/structured_rpc/wire-case-b-cand.json';
import sourceJson2 from '../../../provider/structured_rpc/wire-turn-3-12-b-stack.json';
import sourceJson3 from '../../../provider/structured_rpc/live-file-citations.json';
import sourceJson4 from '../../../provider/structured_rpc/live-optics-table-citations.json';
import sourceJson5 from '../../../provider/structured_rpc/live-blockquote.json';
import sourceJson6 from '../../../provider/structured_rpc/live-source-attributions.json';
import sourceJson7 from '../../../provider/structured_rpc/live-source-table.json';
import sourceJson8 from '../../../provider/structured_rpc/live-range-coder.json';
import sourceJson9 from '../../../provider/structured_rpc/live-imagen-panel.json';

const citationFiles = {
    'live-combined-file-citations': sourceJson0,
    'wire-case-b-cand': sourceJson1,
    'wire-turn-3-12-b-stack': sourceJson2,
    'live-file-citations': sourceJson3,
    'live-optics-table-citations': sourceJson4,
    'live-blockquote': sourceJson5,
    'live-source-attributions': sourceJson6,
    'live-source-table': sourceJson7,
    'live-range-coder': sourceJson8,
    'live-imagen-panel': sourceJson9,
};

export const citationFile = (name: keyof typeof citationFiles): unknown => {
    const data = citationFiles[name];
    if (data === undefined) throw new Error('Missing captured Gemini citation fixture ' + name);
    return structuredClone(data);
};
