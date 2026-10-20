"""Resolve exported references exactly as a document-relative archive path."""
import posixpath
import json
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


def resolve_archive_reference(document, reference):
    """Return an archive entry, None for external/fragment refs, or raise ValueError."""
    reference = reference.strip()
    if not reference or reference.startswith('#'):
        return None
    parsed = urlsplit(reference)
    if parsed.scheme.lower() in ('http', 'https', 'mailto', 'tel', 'data', 'blob') or parsed.netloc:
        return None
    if parsed.scheme:
        raise ValueError('unsupported resource scheme')
    path = unquote(parsed.path)
    if not path or path.startswith(('/', '\\')) or '\\' in path or '\x00' in path:
        raise ValueError('invalid archive-relative resource path')
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(document), path))
    if resolved == '..' or resolved.startswith('../') or resolved.startswith('/'):
        raise ValueError('resource escapes archive root')
    return resolved


def find_archive_resource(root, document, reference):
    entry = resolve_archive_reference(document, reference)
    if entry is None:
        return None
    root = Path(root).resolve()
    target = (root / entry).resolve()
    if not target.is_relative_to(root):
        raise ValueError('resource escapes archive root')
    if not target.is_file() or target.stat().st_size == 0:
        raise ValueError(f'missing or empty resource: {entry}')
    return str(target)


class _HtmlReferences(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.references = []

    def handle_starttag(self, tag, attrs):
        key = 'href' if tag == 'a' else 'src' if tag in ('img', 'video', 'audio', 'source') else None
        if key:
            self.references.extend(value for attr, value in attrs if attr == key and value)


def resource_references(content, html=False):
    if html:
        parser = _HtmlReferences()
        parser.feed(content)
        return parser.references
    repo_root = Path(__file__).resolve().parents[2]
    command = [
        'node', '-r', str(repo_root / 'tests/ts_register.js'),
        str(repo_root / 'scripts/extract_markdown_resource_refs.ts'),
    ]
    try:
        result = subprocess.run(command, input=content, text=True, capture_output=True,
                                cwd=repo_root, timeout=30, check=True)
        references = json.loads(result.stdout)
        if not isinstance(references, list) or any(
            not isinstance(ref, dict) or ref.get('kind') not in ('link', 'image')
            or not isinstance(ref.get('reference'), str) for ref in references
        ):
            raise ValueError('invalid parser reference output')
        return [ref['reference'] for ref in references]
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise RuntimeError(f'Markdown parser reference extraction failed: {exc}') from exc


def validate_archive_resources(root, document, content, html=False):
    errors = []
    try:
        references = resource_references(content, html)
    except RuntimeError as exc:
        return [str(exc)]  # Fail closed: never fall back to syntax heuristics.
    for reference in references:
        try:
            find_archive_resource(root, document, reference)
        except ValueError as exc:
            errors.append(f'{reference}: {exc}')
    return errors
