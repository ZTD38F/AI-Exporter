"""Independent, complete-message checks of actual ChatGPT source and disk exports."""
import json
import re
import subprocess
import unicodedata
from pathlib import Path

from scripts.framework.html_evidence import TreeParser, read_message
from scripts.framework.cases.export import PdfExportDownloadCase
from scripts.framework.pdf_evidence import assert_pdf_turn_content


def compact(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text) if not c.isspace() and c not in '\u200b\ufeff')


def _image_control_text(match):
    """A well-formed gallery request is UI metadata, not authored prose.

    Malformed payloads and literal code must remain visible to the oracle.
    Image fidelity is checked independently against physical attachments.
    """
    try:
        value = json.loads(match[1])
    except (ValueError, TypeError):
        return match[0]
    if (isinstance(value, dict) and isinstance(value.get('query'), list)
            and value['query'] and all(isinstance(q, str) and q for q in value['query'])
            and set(value) <= {'query', 'aspect_ratio', 'layout', 'num_per_query'}):
        return ''
    return match[0]


def markdown_fact(root, text, chatgpt=False):
    if chatgpt:
        # Independent source dialect reader. Protect authored code from math rewrites.
        parts = re.split(r'(```[\s\S]*?(?:```|$)|`[^`\n]+`)', text)
        for i in range(0, len(parts), 2):
            parts[i] = re.sub(r'\ue200image_group\ue202([^\ue201]*)\ue201', _image_control_text, parts[i])
            parts[i] = re.sub(r'\\\[([\s\S]*?)\\\]', lambda m: '\n$$\n'+m[1]+'\n$$\n', parts[i])
            parts[i] = re.sub(r'\\\(((?:(?!\\\()[^\r\n])+?)\\\)', lambda m: '$'+m[1]+'$', parts[i])
        text = ''.join(parts)
    result = subprocess.run(['node', str(root/'scripts/framework/markdown_evidence.mjs')],
        input=json.dumps({'text': text, 'segments': True}), capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


def authored_messages(raw):
    from scripts.framework.chatgpt_live import current_branch
    result = []
    pending_thoughts = []
    for message in current_branch(raw):
        meta = message.get('metadata', {})
        content = message.get('content', {})
        if content.get('content_type') == 'thoughts':
            for thought in content.get('thoughts', []):
                pending_thoughts.extend(t for t in [thought.get('summary'), thought.get('content')] if t)
        if message.get('author', {}).get('role') == 'user':
            pending_thoughts = []
        role = message.get('author', {}).get('role')
        pointers = [p['asset_pointer'] for p in content.get('parts', []) if isinstance(p, dict)
                    and p.get('content_type') == 'image_asset_pointer' and p.get('asset_pointer')]
        if (role not in ('user', 'assistant') and not (role == 'tool' and pointers)) or message.get('recipient') != 'all':
            continue
        if meta.get('is_visually_hidden_from_conversation') or meta.get('is_thinking_preamble_message'):
            continue
        content = message.get('content', {})
        if content.get('content_type') not in ('text', 'multimodal_text'):
            continue
        text = ''.join(p for p in content.get('parts', []) if isinstance(p, str))
        if meta.get('model_dil_v2'):
            text = meta['model_dil_v2'].get('fallbackMarkdown', text)
        if text.strip() or pointers:
            result.append(dict(id=message['id'], role='assistant' if role == 'tool' else role,
                               text=text, thoughts=pending_thoughts, **({'imagePointers': pointers} if pointers else {})))
            pending_thoughts = []
    return result


def assert_full_exports(root, output, conversation_ids, image_cdp=None):
    result = []
    for cid in conversation_ids:
        raw = json.loads((output/f'{cid}.source.json').read_text())
        expected = authored_messages(raw)
        exports = output/'downloads'
        document = next(p for p in (exports/'json').glob('*.json')
            if json.loads(p.read_text())['conversation']['index']['key']['conversationId'] == cid)
        domain = json.loads(document.read_text())['conversation']['detail']
        if [m['id'] for m in domain['messages']] != [m['id'] for m in expected]:
            raise ValueError(f'{cid}: source branch/message count mismatch')
        markdown = (exports/'markdown'/(document.stem+'.md')).read_text()
        bodies = re.split(r'^## (?:👤|🤖)[^\n]*\n', markdown, flags=re.M)[1:]
        html = TreeParser((exports/'html'/(document.stem+'.html')).read_text()).root
        html_bodies = [n for n in html.walk() if n.classes & {'gem-prompt-content', 'gem-model-content'}]
        if len(bodies) != len(expected) or len(html_bodies) != len(expected):
            raise ValueError(f'{cid}: physical Markdown/HTML message count mismatch')
        pdf = PdfExportDownloadCase._extract_pdf_info(str(exports/'pdf'/(document.stem+'.pdf')))
        if pdf.get('error') or not pdf.get('contentRuns'):
            raise ValueError(f'{cid}: PDF has no extractable tagged content')
        codes, evidence = [], []
        for index, (source, body, html_body) in enumerate(zip(expected, bodies, html_bodies)):
            if source.get('imagePointers'):
                from scripts.framework.archive_resources import resource_references, resolve_archive_reference
                from scripts.framework.image_evidence import assert_image_files
                md_refs = resource_references(body, kind='image')
                html_refs = [n.attrs['src'] for n in html_body.walk() if n.tag == 'img']
                if len(md_refs) != len(source['imagePointers']) or len(html_refs) != len(md_refs):
                    raise ValueError(f'{cid}: generated image message missing/duplicated in physical Markdown/HTML')
                entries = []
                for md_ref, html_ref in zip(md_refs, html_refs):
                    md_name = resolve_archive_reference(document.stem+'.md', md_ref)
                    html_name = resolve_archive_reference(document.stem+'.html', html_ref)
                    if not md_name or not html_name:
                        raise ValueError(f'{cid}: image is not a local physical attachment')
                    data = (exports/'markdown'/md_name).read_bytes()
                    if data != (exports/'html'/html_name).read_bytes():
                        raise ValueError(f'{cid}: image bytes differ between formats')
                    entries.append((md_name, data))
                captured = json.loads((output/f'{cid}.image-webpage-evidence.json').read_text())
                # Each image-only tool message is a separate visible assistant
                # message. Match its native message ID rather than assuming
                # one assistant message per user turn.
                wanted_images = [item for item in captured if source['id'] in str(item.get('turn', ''))]
                if not wanted_images or image_cdp is None:
                    raise ValueError(f'{cid}: missing independent generated-image pixel evidence')
                assert_image_files(image_cdp, wanted_images, entries)
                if not source['text'].strip():
                    continue
            source_fact = markdown_fact(root, source['text'], chatgpt=True)
            target_fact = markdown_fact(root, body)
            wanted, actual = compact(source_fact['text']), compact(target_fact['text'])
            if not wanted or not actual.endswith(wanted):
                raise ValueError(f'{cid} message {index+1}: complete Markdown content differs; expected tail {wanted[-100:]!r}, actual {actual[-100:]!r}')
            html_fact = read_message(html_body, source_fact['text'])
            if compact(html_fact['text']) != wanted:
                raise ValueError(f'{cid} message {index+1}: complete HTML authored content differs')
            if source_fact['codeBlocks'] != target_fact['codeBlocks'] or source_fact['codeBlocks'] != html_fact['code_blocks']:
                raise ValueError(f'{cid} message {index+1}: code text/indentation changed')
            codes.extend(source_fact['codeBlocks'])
            if source['role'] == 'user':
                evidence.append({'prompt': source_fact['text']})
            else:
                if not evidence or 'response' in evidence[-1]:
                    raise ValueError(f'{cid}: unexpected role sequence in scenario')
                # Include independently frozen visible reasoning summaries too.
                # They precede the answer in PDF and may contain formulas/code.
                segments = [segment for thought in source['thoughts']
                    for segment in markdown_fact(root, thought, chatgpt=True)['segments']] + source_fact['segments']
                evidence[-1].update(response=''.join(s['text'] for s in segments), pdf_segments=segments)
        ok, summary = assert_pdf_turn_content(pdf, evidence)
        if not ok:
            raise ValueError(f'{cid}: {summary}')
        result.append({'conversationId': cid, 'messages': len(expected), 'codeBlocks': len(codes), 'pdfPages': pdf['pageCount']})
    return result
