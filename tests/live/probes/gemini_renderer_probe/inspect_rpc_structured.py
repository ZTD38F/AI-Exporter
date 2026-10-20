#!/usr/bin/env python3
"""Locate the same math value in RPC raw text and serialized document nodes.

Prints only matching value/path metadata; no full response is copied.
"""
import json
import sys
from pathlib import Path

def walk(value, marker, path=()):
    if isinstance(value, str) and marker in value:
        yield {'path': list(path), 'length': len(value), 'value': value}
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from walk(child, marker, path+(i,))
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, marker, path+(key,))

def load_rpc(directory):
    for file in Path(directory).glob('rpc-*.txt'):
        text = file.read_text(encoding='utf-8')
        if not text.startswith(")]}'"):
            continue
        try:
            envelope, _ = json.JSONDecoder().raw_decode(text[text.find('[['):])
            for item in envelope:
                if item[:2] == ['wrb.fr', 'hNvQHb']:
                    yield file, json.loads(item[2])
        except (ValueError, IndexError, TypeError):
            continue

if __name__ == '__main__':
    directory, marker = sys.argv[1:3]
    for file, payload in load_rpc(directory):
        matches = list(walk(payload, marker))
        if matches:
            print(json.dumps({'response': file.name, 'matches': matches}, ensure_ascii=False, indent=2))
