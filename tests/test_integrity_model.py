"""Fault injection at the frozen webpage evidence boundary."""
import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.framework.integrity.model import validate_frozen_evidence


class FrozenEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.sent = [{'prompt': 'Analyze attached file report-123.txt'}]
        self.turns = [{**self.sent[0], 'response': 'Answer x=1', 'has_images': False,
                       'code_blocks': ['x=1'], 'execution_blocks': [{'code': 'print(1)', 'stdout': ''}],
                       'pdf_segments': [{'kind': 'text', 'text': 'Answer '}, {'kind': 'code', 'text': 'x=1'}]}]

    def check(self):
        validate_frozen_evidence('chat', self.sent, self.turns)

    def test_valid_dynamic_attachment_prompt_is_read_only(self):
        original = copy.deepcopy((self.sent, self.turns))
        self.check()
        self.assertEqual((self.sent, self.turns), original)

    def test_missing_or_wrong_field_types_fail(self):
        for field in self.turns[0]:
            for replacement in ('missing', None, 42):
                with self.subTest(field=field, replacement=replacement):
                    broken = copy.deepcopy(self.turns)
                    if replacement == 'missing':
                        del broken[0][field]
                    else:
                        broken[0][field] = replacement
                    with self.assertRaises(ValueError):
                        validate_frozen_evidence('chat', self.sent, broken)

    def test_identity_and_turn_count_fail(self):
        for chat_id, sent, final in [('', self.sent, self.turns), ('chat', [], []),
                                    ('chat', self.sent, []), ('chat', self.sent, self.turns * 2)]:
            with self.subTest(chat_id=chat_id, final=final), self.assertRaises(ValueError):
                validate_frozen_evidence(chat_id, sent, final)

    def test_scenario_prompt_cannot_replace_actual_attachment_prompt(self):
        self.turns[0]['prompt'] = 'Analyze attached file'
        with self.assertRaisesRegex(ValueError, 'actual send'):
            self.check()

    def test_response_segment_contradiction_fails(self):
        self.turns[0]['response'] += ' Missing paragraph'
        with self.assertRaisesRegex(ValueError, 'segments'):
            self.check()

    def test_code_order_and_execution_source_contamination_fail(self):
        for codes in (['print(1)'], ['x=1', 'print(1)'], [5]):
            self.turns[0]['code_blocks'] = codes
            with self.subTest(codes=codes), self.assertRaises(ValueError):
                self.check()
        self.turns[0]['response'] = 'ab'
        self.turns[0]['pdf_segments'] = [{'kind': 'code', 'text': 'a'}, {'kind': 'code', 'text': 'b'}]
        self.turns[0]['code_blocks'] = ['b', 'a']
        with self.assertRaisesRegex(ValueError, 'ordinary code'):
            self.check()

    def test_invalid_segments_and_execution_fields_fail(self):
        for segment in ({'kind': 'unknown', 'text': 'Answer x=1'}, {'kind': 'text', 'text': ''}, None):
            self.turns[0]['pdf_segments'] = [segment]
            with self.subTest(segment=segment), self.assertRaises(ValueError):
                self.check()
        self.setUp()
        self.turns[0]['execution_blocks'] = [{'code': 'print(1)'}]
        with self.assertRaisesRegex(ValueError, 'stdout'):
            self.check()

    def test_compact_presentation_tolerance_and_image_only_reply(self):
        self.turns[0]['response'] = 'Ａnswer\u200bx = 1'
        self.check()
        self.turns[0].update(response='', code_blocks=[], execution_blocks=[], pdf_segments=[], has_images=True)
        self.check()
        self.turns[0]['has_images'] = False
        with self.assertRaisesRegex(ValueError, 'empty reply'):
            self.check()


if __name__ == '__main__':
    unittest.main()
