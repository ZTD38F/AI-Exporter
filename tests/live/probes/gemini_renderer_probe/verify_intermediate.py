#!/usr/bin/env python3
"""Verify that hNvQHb field 12 carries the tree used by the web renderer.

Reads existing local probe artifacts only. Does not alter production code or
invoke Gemini. The positional path is an observed wire shape, not a supported API.
"""
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
cases = [
    ('A', 'case-a-multiline-display', 2, 'a-stack-structured.json', 'W^{(1)}_{RB}'),
    ('B', 'case-b-display-after-text', 1, 'b-stack-structured.json', 'A(a, \\lambda) = \\pm'),
    ('C-alpha', 'case-a-multiline-display', 0, 'table-stack-structured.json', '\\vert{}\\alpha\\vert{}^2'),
    ('C-psi', 'case-b-display-after-text', 0, 'psi-table-stack-structured.json', '\\Vert{}\\psi\\rangle'),
]

def leaves(value, path=()):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from leaves(child, path+(i,))
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from leaves(child, path+(key,))

def response(case):
    for file in (root/case).glob('rpc-*.txt'):
        data = file.read_text(encoding='utf-8')
        try:
            envelope, _ = json.JSONDecoder().raw_decode(data[data.find('[['):])
            if envelope[0][:2] == ['wrb.fr', 'hNvQHb']:
                return file, json.loads(envelope[0][2])
        except (ValueError, IndexError, TypeError):
            continue
    raise AssertionError(f'No hNvQHb response in {case}')

results = []
for name, case, turn_index, runtime_file, marker in cases:
    rpc_file, payload = response(case)
    model_payload = payload[0][turn_index][3]
    raw_markdown = model_payload[0][0][1][0]
    wire_nodes = model_payload[12][0][0]
    runtime_path = root/'parser-trace'/runtime_file
    runtime = json.loads(runtime_path.read_text(encoding='utf-8'))
    wire_hits = [(list(path), value) for path, value in leaves(wire_nodes) if marker in value]
    runtime_hits = [(list(path), value) for path, value in leaves(runtime) if marker in value]
    assert wire_hits and runtime_hits, f'{name}: target absent from wire or renderer tree'
    exact = [(p, q, v) for p, v in wire_hits for q, w in runtime_hits if v == w]
    assert exact, f'{name}: no exact wire/runtime value match'
    assert len(wire_nodes) == len(runtime['children']), f'{name}: root child count mismatch'
    result = {
        'case': name,
        'responseSha256': hashlib.sha256(rpc_file.read_bytes()).hexdigest(),
        'runtimeTreeSha256': hashlib.sha256(runtime_path.read_bytes()).hexdigest(),
        'rawMarkdownLength': len(raw_markdown),
        'wireRootPath': [0,turn_index,3,12,0,0],
        'rootChildCount': len(wire_nodes),
        'matchedWirePath': [0,turn_index,3,12,0,0]+exact[0][0],
        'matchedRuntimePath': exact[0][1],
        'matchedValue': exact[0][2],
    }
    if name.startswith('C-'):
        table = next(node for node in runtime['children'] if node.get('nodeType') == 17)
        result['tableRowCellCounts'] = [len(row['cells']) for row in table['rows']]
    results.append(result)

out = root/'parser-trace'/'intermediate-proof.json'
out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps([{'case': x['case'], 'rootChildCount': x['rootChildCount'],
                   'matchedWirePath': x['matchedWirePath'],
                   'tableRowCellCounts': x.get('tableRowCellCounts')} for x in results], ensure_ascii=False))
