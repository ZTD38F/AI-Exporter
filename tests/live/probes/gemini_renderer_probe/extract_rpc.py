#!/usr/bin/env python3
"""Extract a containing model-text string from a captured Gemini batchexecute response."""
import hashlib
import json
import sys
from pathlib import Path

case_dir = Path(sys.argv[1]); marker = sys.argv[2]
out_dir = Path(sys.argv[3]) if len(sys.argv)>3 else case_dir
candidates = []
def walk(value, path, rpc_hash):
    if isinstance(value, str):
        if marker in value:
            candidates.append((len(value), path, value, rpc_hash))
    elif isinstance(value, list):
        for i, child in enumerate(value): walk(child, path+[i], rpc_hash)
    elif isinstance(value, dict):
        for k, child in value.items(): walk(child, path+[k], rpc_hash)

for file in case_dir.glob('rpc-*.txt'):
    text = file.read_text(encoding='utf-8')
    try:
        packet, _ = json.JSONDecoder().raw_decode(text[text.find('[['):])
        for item in packet:
            if len(item)>2 and isinstance(item[2], str):
                walk(json.loads(item[2]), [], file.stem[4:])
    except (ValueError, IndexError):
        continue
if not candidates: raise SystemExit(f'No RPC model text containing {marker!r}')
# The complete assistant text is longer than duplicated excerpts/metadata strings.
candidates.sort(reverse=True, key=lambda x:x[0])
length, path, raw, rpc_hash = candidates[0]
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir/'raw.md').write_text(raw, encoding='utf-8')
(out_dir/'raw-source.json').write_text(json.dumps({
    'source':'Gemini batchexecute response', 'responseSha256':rpc_hash,
    'jsonPathWithinRpcPayload':path, 'length':length,
    'rawSha256':hashlib.sha256(raw.encode()).hexdigest(),
    'candidateLengths':[x[0] for x in candidates],
},indent=2),encoding='utf-8')
print(json.dumps({'length':length,'path':path,'rawSha256':hashlib.sha256(raw.encode()).hexdigest()}))
