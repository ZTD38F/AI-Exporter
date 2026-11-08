"""Match disk PDF content against independently frozen webpage segments.

Whitespace, Unicode presentation variants and PDF pagination artifacts are
ignored. Every authored prose/code segment must survive in order. Formulas
are checked for count, nonempty tagged output and placement, not TeX/glyph
semantic equality; the live compiler/fallback and resource checks remain.
"""
from collections import Counter
from bisect import bisect_left
import re
import unicodedata


def compact(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text)
                   if not c.isspace() and c not in '\u200b\ufeff\ufe00\u00ad')


def assert_pdf_turn_content(info, evidence):
    if info.get('error') or not evidence or not info.get('contentRuns'):
        return False, 'PDF lacks independently extracted content or frozen evidence'
    runs = []
    position = 0
    for source in info['contentRuns']:
        value = compact(source.get('text', ''))
        runs.append(dict(kind=source.get('kind'), text=value, start=position, end=position + len(value)))
        position += len(value)
    text = ''.join(run['text'] for run in runs)
    prompts = [compact(turn.get('prompt', '')) for turn in evidence]
    if any(not prompt for prompt in prompts):
        return False, 'PDF missing actual user prompts'
    bounds = []
    cursor = 0
    for index, prompt in enumerate(prompts):
        found = text.find(prompt, cursor)
        if found < 0:
            return False, f'PDF turn {index + 1}: actual prompt missing/out of order'
        bounds.append(found)
        cursor = found + len(prompt)
    for index, turn in enumerate(evidence):
        segments = turn.get('pdf_segments')
        if not isinstance(segments, list) or compact(''.join(s.get('text', '') for s in segments)) != compact(turn.get('response', '')):
            return False, f'PDF turn {index + 1}: complete independent webpage segments required'
        if any(s.get('kind') not in {'text', 'math', 'code'} or not compact(s.get('text', '')) for s in segments):
            return False, f'PDF turn {index + 1}: invalid source segment'
        if not segments and not turn.get('has_images'):
            return False, f'PDF turn {index + 1}: empty source reply'
        start = bounds[index] + len(prompts[index])
        end = bounds[index + 1] if index + 1 < len(bounds) else len(text)
        actual = [dict(run, text=run['text'][max(0, start-run['start']):min(len(run['text']), end-run['start'])],
                       start=max(start, run['start']), end=min(end, run['end']))
                  for run in runs if run['end'] > start and run['start'] < end]
        expected_math = sum(segment['kind'] == 'math' for segment in segments)
        math = [run for run in actual if run['kind'] == 'math']
        if len(math) != expected_math or any(not run['text'] for run in math):
            return False, f'PDF turn {index + 1}: formula count/content missing ({len(math)}/{expected_math})'
        expected_codes = [compact(s['text']) for s in segments if s['kind'] == 'code']
        for event in turn.get('execution_blocks', []):
            expected_codes += [compact(event[key]) for key in ('code', 'stdout') if event.get(key)]
        actual_codes = [run['text'] for run in actual if run['kind'] == 'code']
        if Counter(expected_codes) != Counter(actual_codes):
            return False, f'PDF turn {index + 1}: complete code/execution content mismatch'
        cursor = start
        math_cursor = 0
        for segment in segments:
            kind, value = segment['kind'], compact(segment['text'])
            if kind == 'math':
                run = math[math_cursor]
                math_cursor += 1
                if run['start'] < cursor:
                    return False, f'PDF turn {index + 1}: formula/prose order mismatch: {value[:60]!r}, at {run["start"]} after {cursor}'
                cursor = run['end']
                continue
            found = None
            for run in actual:
                if run['kind'] != kind or run['end'] <= cursor:
                    continue
                raw = run['text']
                offsets = list(range(len(raw)))
                if kind == 'text':
                    # Export source-chip labels and unrendered bold delimiters
                    # are presentation, unless this exact source segment has
                    # them literally. Keep an offset map so later segments
                    # cannot reuse already consumed content after normalization.
                    removed = set()
                    for marker in re.finditer(r'\[\d+\]|\*\*', raw):
                        # Adjacent cells may contribute one literal * each. Their
                        # concatenation is not an authored bold delimiter.
                        if marker[0] not in value and not (marker[0] == '**' and '*' in value):
                            removed.update(range(marker.start(), marker.end()))
                    offsets = [at for at in offsets if at not in removed]
                    raw = ''.join(raw[at] for at in offsets)
                at = raw.find(value, bisect_left(offsets, max(0, cursor - run['start'])))
                if at >= 0:
                    found = run['start'] + offsets[at + len(value) - 1] + 1
                    break
            if found is None:
                return False, f'PDF turn {index + 1}: complete {kind} segment missing/out of order: {segment["text"][:70]!r}'
            cursor = found
    if any(turn.get('has_images') for turn in evidence) and info.get('imageXObjectCount', 0) < sum(bool(t.get('has_images')) for t in evidence):
        return False, 'PDF model image evidence lacks embedded image objects'
    return True, f'PDF complete ordered prose/code verified: {len(evidence)} turns; formulas checked by count/order/nonempty output'
