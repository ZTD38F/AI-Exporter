"""Independent disk HTML reader for Tier 2; never imports product renderers."""
from dataclasses import dataclass, field
from html.parser import HTMLParser
import re
from scripts.framework.assertions import normalized_answer


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)

    @property
    def classes(self):
        return set(self.attrs.get('class', '').split())

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        return ''.join(child.text() if isinstance(child, Node) else child for child in self.children)


class TreeParser(HTMLParser):
    VOID = set('area base br col embed hr img input link meta param source track wbr'.split())

    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.root = Node('document')
        self.stack = [self.root]
        self.feed(text)
        self.close()
        if len(self.stack) != 1:
            raise ValueError('Unclosed HTML content')

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        if len(self.stack) == 1 or self.stack[-1].tag != tag:
            raise ValueError(f'Mismatched HTML closing tag: {tag}')
        self.stack.pop()

    def handle_data(self, data):
        self.stack[-1].children.append(data)


EXCLUDED = {'gem-model-label', 'gem-code-header', 'gem-citation-group', 'gem-citation-ref',
            'gem-image-caption', 'gem-att-card', 'gem-att-badge', 'gem-att-icon', 'gem-att-open-btn',
            'gem-math-fallback-label', 'gem-prompt-toggle'}


def math_source(node):
    annotations = [n for n in node.walk() if n.tag == 'annotation' and n.attrs.get('encoding') == 'application/x-tex']
    semantics = [n for n in node.walk() if n.tag == 'semantics']
    if len(annotations) != 1 or len(semantics) != 1:
        raise ValueError('MathML missing unique TeX source/semantics')
    visible = [n for n in semantics[0].children if isinstance(n, Node) and n.tag != 'annotation']
    if len(visible) != 1 or not visible[0].text().strip() or not annotations[0].text().strip():
        raise ValueError('Empty MathML presentation/source')
    arity = {'mfrac': 2, 'msub': 2, 'msup': 2, 'mroot': 2, 'munder': 2, 'mover': 2,
             'msubsup': 3, 'munderover': 3}
    for part in visible[0].walk():
        if part.tag in arity and len([n for n in part.children if isinstance(n, Node) and not (n.tag == 'mo' and n.text() == '\u2061')]) != arity[part.tag]:
            raise ValueError('Truncated MathML ' + part.tag)
    source = annotations[0].text()
    # Same documented display aliases used by the independent webpage reader.
    return re.sub(r'\\\\\s*\[[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:ex|em|pt|pc|px|cm|mm|in)\]', lambda _: r'\\', source).replace(r'\Vert{}', r'\|').replace(r'\vert{}', '|')


def read_message(body, visible_reference=""):
    visible = normalized_answer(visible_reference)
    code, executions, images = [], {}, []
    protected = []

    def protect(value):
        protected.append(value)
        return f'\x00{len(protected) - 1}\x00'

    def restore(value):
        return re.sub(r'\x00(\d+)\x00', lambda match: protected[int(match[1])], value)

    def authored(node):
        if isinstance(node, str):
            return node
        if 'gem-missing-asset' in node.classes:
            raise ValueError('Export resource unavailable: ' + node.text())
        if node.tag in {'script', 'style', 'button', 'svg', 'summary', 'details'} or node.classes & EXCLUDED:
            return ''
        if 'hidden' in node.attrs or node.attrs.get('aria-hidden') == 'true' or re.search(r'display\s*:\s*none|visibility\s*:\s*hidden', node.attrs.get('style', '')):
            return ''
        if node.tag == 'code' and 'gem-math-inline-fallback' in node.classes:
            return protect(node.text())
        if node.tag == 'code' and 'gem-inline-code' in node.classes:
            return protect(node.text())
        if 'gem-math-fallback-source' in node.classes:
            return protect(node.text())
        if node.tag == 'math':
            return protect(math_source(node))
        if node.tag == 'img':
            if node.attrs.get('src'):
                images.append(node.attrs['src'])
            return ''
        if node.tag == 'pre' and 'gem-math-fallback-source' not in node.classes:
            codes = [n for n in node.children if isinstance(n, Node) and n.tag == 'code']
            if len(codes) != 1:
                raise ValueError('Code block lacks unique code content')
            value = codes[0].text()
            language = codes[0].attrs.get('class', '')
            event = re.search(r'language-[\w+-]+\?(code_reference|code_stdout)&code_event_index=(\d+)', language)
            if event:
                key = 'code' if event[1] == 'code_reference' else 'stdout'
                target = executions.setdefault(event[2], {})
                if key in target:
                    raise ValueError('Duplicate execution source')
                target[key] = value
                return ''
            code.append(value)
            return protect(value)
        return ''.join(authored(n) for n in node.children)

    text = authored(body)
    # Prose-only formatting may span inline math/code nodes. Protect their
    # literal contents before handling unrendered bold presentation delimiters.
    text = restore(re.sub(r'\*\*(?=\S)([\s\S]*?\S)\*\*',
                          lambda match: match[0] if normalized_answer(restore(match[0])) in visible else match[1], text))
    if any('code' not in value for value in executions.values()):
        raise ValueError('Incomplete code execution')
    return {'text': text, 'code_blocks': code, 'images': images,
            'execution_blocks': [dict(code=e['code'], stdout=e.get('stdout', '')) for e in executions.values()]}


def assert_html_turn_content(text, evidence):
    try:
        root = TreeParser(text).root
        turns = [n for n in root.walk() if 'gem-turn' in n.classes]
        if not evidence or len(turns) != len(evidence) * 2:
            return False, f'HTML message count: {len(turns)}, expected {len(evidence) * 2}'
        for index, expected in enumerate(evidence):
            for offset, role, body_class in ((0, 'user', 'gem-prompt-content'), (1, 'model', 'gem-model-content')):
                turn = turns[2 * index + offset]
                if ('gem-turn-user' in turn.classes, 'gem-turn-model' in turn.classes) != (role == 'user', role == 'model'):
                    return False, f'HTML turn {index + 1}: wrong role/order'
                bodies = [n for n in turn.walk() if body_class in n.classes]
                if len(bodies) != 1:
                    return False, f'HTML turn {index + 1}: missing/duplicate message body'
                reference = expected.get('prompt' if role == 'user' else 'response', '')
                actual = read_message(bodies[0], reference)
                if normalized_answer(reference) != normalized_answer(actual['text']):
                    return False, f'HTML turn {index + 1} {role}: full content mismatch'
                if role == 'model':
                    clean = lambda code: [s.replace('\r\n', '\n').strip('\n') for s in code]
                    if 'code_blocks' in expected and clean(actual['code_blocks']) != clean(expected['code_blocks']):
                        return False, f'HTML turn {index + 1}: code/indentation mismatch'
                    clean_events = lambda events: [{k: e.get(k, '').replace('\r\n', '\n').strip('\n') for k in ('code', 'stdout')} for e in events]
                    if clean_events(actual['execution_blocks']) != clean_events(expected.get('execution_blocks', [])):
                        return False, f'HTML turn {index + 1}: execution mismatch'
                    if expected.get('has_images') and not actual['images']:
                        return False, f'HTML turn {index + 1}: model image missing'
                    if not reference and not expected.get('has_images'):
                        return False, f'HTML turn {index + 1}: empty source evidence'
        return True, f'HTML complete ordered content verified: {len(evidence)} turns'
    except ValueError as error:
        return False, f'HTML content parse failed: {error}'
