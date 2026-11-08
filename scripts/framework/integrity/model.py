"""Validate the existing frozen webpage JSON without repairing or mutating it."""
from scripts.framework.pdf_evidence import compact


def validate_frozen_evidence(chat_id, stream_turns, final_turns):
    """The driver binds webpage identity; this gate validates its returned turns.

    Prompts come from actual sends, including dynamic attachment instructions,
    rather than scenario templates. Ordinary code excludes execution disclosures
    in authored_response.js, so only ordinary code must match PDF code segments.
    """
    if not isinstance(chat_id, str) or not chat_id.strip():
        raise ValueError('Frozen evidence requires a nonempty chat_id')
    if (not isinstance(stream_turns, list) or not stream_turns
            or not isinstance(final_turns, list) or len(final_turns) != len(stream_turns)):
        raise ValueError('Frozen evidence turn count differs from actual sends')
    for index, (sent, turn) in enumerate(zip(stream_turns, final_turns), 1):
        prefix = f'Frozen evidence turn {index}: '
        if not isinstance(sent, dict) or not isinstance(sent.get('prompt'), str) or not sent['prompt'].strip():
            raise ValueError(prefix + 'actual sent prompt required')
        if not isinstance(turn, dict):
            raise ValueError(prefix + 'turn must be an object')
        for field in ('prompt', 'response'):
            if not isinstance(turn.get(field), str):
                raise ValueError(prefix + field + ' must be a string')
        if ' '.join(turn['prompt'].split()) != ' '.join(sent['prompt'].split()):
            raise ValueError(prefix + 'prompt differs from actual send')
        if not isinstance(turn.get('has_images'), bool):
            raise ValueError(prefix + 'has_images must be a boolean')
        for field in ('code_blocks', 'execution_blocks', 'pdf_segments'):
            if not isinstance(turn.get(field), list):
                raise ValueError(prefix + field + ' must be a list')
        if any(not isinstance(code, str) for code in turn['code_blocks']):
            raise ValueError(prefix + 'code_blocks must contain strings')
        for event in turn['execution_blocks']:
            if not isinstance(event, dict) or any(not isinstance(event.get(key), str) for key in ('code', 'stdout')):
                raise ValueError(prefix + 'execution_blocks require code and stdout strings')
        segments = turn['pdf_segments']
        for segment in segments:
            if (not isinstance(segment, dict) or segment.get('kind') not in ('text', 'math', 'code')
                    or not isinstance(segment.get('text'), str) or not compact(segment['text'])):
                raise ValueError(prefix + 'invalid pdf_segments entry')
        if compact(''.join(segment['text'] for segment in segments)) != compact(turn['response']):
            raise ValueError(prefix + 'response and pdf_segments differ')
        if [segment['text'] for segment in segments if segment['kind'] == 'code'] != turn['code_blocks']:
            raise ValueError(prefix + 'ordinary code differs from code segments')
        if not compact(turn['response']) and not turn['has_images']:
            raise ValueError(prefix + 'empty reply without image evidence')
