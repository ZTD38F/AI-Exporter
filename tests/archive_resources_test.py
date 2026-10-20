import tempfile
import unittest
from pathlib import Path
from scripts.framework.archive_resources import find_archive_resource, resolve_archive_reference, validate_archive_resources, resource_references


class ArchiveResourcesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'files/nested').mkdir(parents=True)
        (self.root / 'files/foo.md').write_text('attachment')
        (self.root / 'files/nested/a b.pdf').write_bytes(b'PDF')
        (self.root / 'files/empty').touch()

    def test_exact_document_relative(self):
        self.assertEqual(resolve_archive_reference('exports/chat.html', '../files/foo.md'), 'files/foo.md')
        self.assertTrue(find_archive_resource(self.root, 'chat.html', 'files/foo.md'))
        self.assertTrue(find_archive_resource(self.root, 'exports/chat.md', '../files/nested/a%20b.pdf?x=1#part'))

    def test_wrong_directory_missing_empty_and_traversal(self):
        for ref in ('assets/files/foo.md', 'files/missing', 'files/empty', '../../foo', '%2e%2e/foo', '/files/foo.md', 'C:/files/foo.md', '..\\foo'):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                find_archive_resource(self.root, 'chat.html', ref)

    def test_html_and_markdown_attachment_false_green(self):
        # cb8bd7: same basename elsewhere cannot satisfy the broken href.
        for html, content in ((True, '<a href="assets/files/foo.md">foo</a>'), (False, '[foo](assets/files/foo.md)')):
            self.assertEqual(len(validate_archive_resources(self.root, 'cb8bd7.html' if html else 'cb8bd7.md', content, html)), 1)
            self.assertEqual(validate_archive_resources(self.root, 'chat.html' if html else 'chat.md', content.replace('assets/files/', 'files/'), html), [])

    def test_real_attachment_reference_regressions(self):
        # Reference strings from the archived cb8bd7 and 2b4994 exports.
        for filename in ('cb8bd7_test_config.json', '2b4994_============================================================.md'):
            (self.root / 'files' / filename).write_text('nonempty attachment')
            broken = f'<a href="assets/files/{filename}">attachment</a>'
            self.assertEqual(len(validate_archive_resources(self.root, 'chat.html', broken, True)), 1)
            self.assertEqual(validate_archive_resources(self.root, 'chat.html', broken.replace('assets/files/', 'files/'), True), [])

    def test_all_html_resource_tags(self):
        for tag, attr in (('img', 'src'), ('a', 'href'), ('video', 'src'), ('audio', 'src'), ('source', 'src')):
            with self.subTest(tag=tag):
                self.assertTrue(validate_archive_resources(self.root, '2b4994.html', f'<{tag} {attr}="files/missing">', True))
                self.assertFalse(validate_archive_resources(self.root, '2b4994.html', f'<{tag} {attr}="files/foo.md">', True))

    def test_external_fragment_code_and_encoded_references(self):
        content = '[external](https://example.com/a) [anchor](#part) `![example](missing.png)`\n```md\n[example](missing)\n```\n[attachment](files/nested/a%20b.pdf)'
        self.assertEqual(validate_archive_resources(self.root, 'chat.md', content), [])

    def test_markdown_oracle_rejects_same_basename(self):
        from tests.helpers.export_spec_asserter import ExportSpecificationAsserter
        oracle = ExportSpecificationAsserter(str(self.root))
        oracle.assert_multimedia_assets('[foo](assets/files/foo.md)', 'cb8bd7.md')
        self.assertEqual(len(oracle.errors), 1)
        oracle.errors.clear()
        oracle.assert_multimedia_assets('[foo](files/foo.md)', 'cb8bd7.md')
        self.assertEqual(oracle.errors, [])

    def test_math_function_application_is_not_an_attachment(self):
        # Real Tier2 STA response contains \left[...\right](\mathbf{t}) inside $$.
        for formula in (r'$$\left[W(k)\right](\mathbf{t})$$',
                        r'$\left[W(k)\right](\mathbf{t})$'):
            with self.subTest(formula=formula):
                self.assertEqual(validate_archive_resources(self.root, 'chat.md', formula), [])
                # Math parsing must not hide a real broken attachment outside math.
                self.assertEqual(len(validate_archive_resources(
                    self.root, 'chat.md', formula + '\n[attachment](assets/files/foo.md)')), 1)

    def test_real_tier2_sta_excerpt(self):
        content = (Path(__file__).parent / 'fixtures/canonical/math/tier2_sta_resource_oracle.md').read_text()
        self.assertEqual(resource_references(content), [])
        self.assertEqual(validate_archive_resources(self.root, 'chat.md', content), [])
        errors = validate_archive_resources(self.root, 'chat.md', content + '\n[attachment](files/missing.pdf)')
        self.assertEqual(len(errors), 1)
        self.assertIn('files/missing.pdf', errors[0])

    def test_currency_does_not_hide_a_real_attachment(self):
        content = r'The price changed from \$5 [receipt](files/missing.pdf) to \$10.'
        self.assertEqual(resource_references(content), ['files/missing.pdf'])
        self.assertEqual(len(validate_archive_resources(self.root, 'chat.md', content)), 1)

    def test_code_and_fenced_code_do_not_emit_references(self):
        for content in ('`[fake](files/missing.pdf)`', '```md\n[fake](files/missing.pdf)\n```'):
            with self.subTest(content=content):
                self.assertEqual(resource_references(content), [])

    def test_link_image_titles_nested_and_escaped_syntax(self):
        for content, expected in (
            ('[foo](files/foo.md)', 'files/foo.md'),
            ('![foo](assets/foo.png)', 'assets/foo.png'),
            (r'[label \(test\)](files/foo.md)', 'files/foo.md'),
            ('[label](<files/a b.pdf>)', 'files/a b.pdf'),
            (r'[label](files/a\(b\).pdf)', 'files/a(b).pdf'),
            ('[nested [label]](files/foo.md "link title")', 'files/foo.md'),
            ('| Resource |\n| --- |\n| [foo](files/foo.md) |', 'files/foo.md'),
            ('[foo][ref]\n\n[ref]: files/foo.md', 'files/foo.md'),
        ):
            with self.subTest(content=content):
                self.assertEqual(resource_references(content), [expected])

    def test_parser_failure_is_not_a_pass(self):
        from unittest.mock import patch
        with patch('scripts.framework.archive_resources.subprocess.run', side_effect=OSError('node unavailable')):
            errors = validate_archive_resources(self.root, 'chat.md', '[foo](files/foo.md)')
        self.assertEqual(len(errors), 1)
        self.assertIn('parser reference extraction failed', errors[0])

    def test_symlink_escape(self):
        (self.root / 'escape').symlink_to(self.root.parent)
        with self.assertRaises(ValueError):
            find_archive_resource(self.root, 'chat.html', 'escape/something')


if __name__ == '__main__':
    unittest.main()
