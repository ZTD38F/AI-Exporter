"""Physical HTML counterexamples for content-preservation assertions."""
import copy
import html
import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.framework.html_evidence import assert_html_turn_content
from scripts.framework.cases.export import HtmlExportDownloadCase
from scripts.framework.cases.base import TestContext

CID = '0123456789abcdef'
FORMULA = r'\frac{x}{y}'
MATH = '<math><semantics><mfrac><mi>x</mi><mi>y</mi></mfrac><annotation encoding="application/x-tex">' + FORMULA + '</annotation></semantics></math>'
CODE = 'if x < 3:\n    print("中文")'
EVIDENCE = [
    {'prompt': 'Explain pressure.', 'response': 'First sentence. Middle sentence. Last sentence.', 'code_blocks': [], 'execution_blocks': [], 'has_images': False},
    {'prompt': 'Show code and math.', 'response': 'Code:' + CODE + 'Ratio:' + FORMULA,
     'code_blocks': [CODE], 'execution_blocks': [], 'has_images': True},
]


def turn(role, content):
    body = 'gem-model-content' if role == 'model' else 'gem-prompt-content'
    return f'<section class="gem-turn gem-turn-{role}"><div class="{body}">{content}</div></section>'


FIRST = turn('user', 'Explain pressure.') + turn('model', '<p>First sentence.</p><p>Middle sentence.</p><p>Last sentence.</p>')
SECOND = turn('user', 'Show code and math.') + turn('model', '<p>Code:</p><div class="gem-code-block"><div class="gem-code-header">python<button>Copy</button></div><pre><code>' + html.escape(CODE) + '</code></pre></div><p>Ratio:' + MATH + '</p><img src="assets/picture.png"><figcaption class="gem-image-caption">picture.png</figcaption>')
DOCUMENT = '<!DOCTYPE html><html><head><meta name="generator" content="Gemini Exporter"></head><body>' + FIRST + SECOND + '</body></html>'


class HtmlEvidenceTests(unittest.TestCase):
    def check_disk(self, text, evidence=EVIDENCE):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'chat.html'
            path.write_text(text)
            return assert_html_turn_content(path.read_text(), evidence)

    def test_complete_multilingual_code_math_image_document(self):
        self.assertTrue(self.check_disk(DOCUMENT)[0])

    def test_preserved_skeleton_cannot_hide_loss_or_wrong_roles(self):
        for bad in (
            DOCUMENT.replace(SECOND, ''),
            DOCUMENT.replace('<p>Middle sentence.</p>', ''),
            DOCUMENT.replace('<p>Last sentence.</p>', ''),
            DOCUMENT.replace('gem-turn-user', 'gem-turn-model', 1),
            DOCUMENT.replace(FIRST + SECOND, SECOND + FIRST),
            DOCUMENT.replace('    print', '  print'),
            DOCUMENT.replace(FORMULA, r'\frac{x}'),
            DOCUMENT.replace('<mi>y</mi>', ''),
            DOCUMENT.replace('<img src="assets/picture.png">', ''),
            DOCUMENT.replace('Middle sentence.', '<span hidden>Middle sentence.</span>'),
        ):
            with self.subTest(bad=bad):
                self.assertFalse(self.check_disk(bad)[0])

    def test_entities_and_layout_whitespace_are_equivalent_but_operators_are_not(self):
        self.assertTrue(self.check_disk(DOCUMENT.replace('First sentence.', ' First\n sentence. '))[0])
        self.assertFalse(self.check_disk(DOCUMENT.replace('x &lt; 3', 'x &gt; 3'))[0])

    def test_execution_records_are_separate_from_authored_prose(self):
        event = {'code': 'print(2)', 'stdout': '2'}
        content = 'Answer.' + '<pre><code class="language-python?code_reference&amp;code_event_index=0">print(2)</code></pre><pre><code class="language-text?code_stdout&amp;code_event_index=0">2</code></pre>'
        doc = turn('user', 'Compute.') + turn('model', content)
        evidence = [{'prompt': 'Compute.', 'response': 'Answer.', 'code_blocks': [], 'execution_blocks': [event]}]
        self.assertTrue(self.check_disk(doc, evidence)[0])
        self.assertFalse(self.check_disk(doc.replace('print(2)', 'print(3)'), evidence)[0])

    def test_case_reads_downloaded_zip_against_frozen_evidence(self):
        for text, expected in ((DOCUMENT, True), (DOCUMENT.replace('Middle sentence.', ''), False)):
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory)/'export.zip'
                with zipfile.ZipFile(archive, 'w') as zf:
                    # Current packaging puts conversation documents at the archive root.
                    zf.writestr(f'Chat_{CID[-6:]}.html', text)
                    zf.writestr('assets/picture.png', b'image bytes')
                ctx = TestContext(output_dir=directory)
                ctx.chat_records = [{'chat_id': CID, 'turn_evidence': copy.deepcopy(EVIDENCE)}]
                # This unit case proves *physical HTML* fidelity with a fake CDP.
                # The real v2 L3a/AST audit runs in the connected Tier2 scenarios;
                # verify it is invoked here instead of inspecting a MagicMock DB.
                fake_cdp = MagicMock()
                with patch.object(ctx, 'connect_options', return_value=fake_cdp), \
                     patch('scripts.framework.cases.export.select_format_targets', return_value={'matched': [CID]}), \
                     patch('scripts.framework.cases.export.time.sleep'), \
                     patch('scripts.framework.cases.export.CDPActions.clear_search_workbench'), \
                     patch('scripts.framework.cases.export.CDPActions.trigger_export_zip', return_value=str(archive)), \
                     patch('scripts.framework.cases.export.audit_l3_contracts') as audit:
                    ok, message, details = HtmlExportDownloadCase().execute(ctx)
                self.assertEqual(ok, expected, message)
                if expected:
                    self.assertEqual(details['verified_turns'], 2)
                    audit.assert_called_once_with(fake_cdp, [CID])
                else:
                    audit.assert_not_called()


if __name__ == '__main__':
    unittest.main()
