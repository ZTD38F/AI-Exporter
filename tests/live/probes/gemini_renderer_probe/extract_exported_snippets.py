#!/usr/bin/env python3
"""Extract unmodified contiguous Markdown spans from existing Tier 2 exports.

These are export evidence, not independently verified RPC raw responses.
"""
import json
import sys
from pathlib import Path

source_root = Path(sys.argv[1])
out = Path(sys.argv[2])
bell = next(source_root.glob('贝尔不等式推导与物理意义_*.md'))
color = next(source_root.glob('二维色码稳定子形式化与对易性证明_*.md'))
specs = {
    'case-a-multiline-display': (color, 442, 445),
    'case-b-display-after-text': (bell, 42, 43),
    'case-c-table-pipe': (bell, 130, 132),
    'case-c-alpha-pipe': (color, 673, 676),
}
for case, (path, first, last) in specs.items():
    lines = path.read_text(encoding='utf-8').splitlines(keepends=True)
    target = out/case
    target.mkdir(parents=True, exist_ok=True)
    (target/'exported-snippet.md').write_text(''.join(lines[first-1:last]), encoding='utf-8')
    (target/'source-provenance.json').write_text(json.dumps({
        'kind': 'existing Tier 2 Markdown export; RPC raw source not independently verified',
        'path': str(path), 'lineStart': first, 'lineEnd': last,
    }, ensure_ascii=False, indent=2), encoding='utf-8')
