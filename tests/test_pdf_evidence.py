"""Counterexamples for PDF per-turn preservation; no product renderer oracle."""
import copy
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.framework.pdf_evidence import assert_pdf_turn_content

EVIDENCE = [
    {'prompt': 'First prompt.', 'response': 'First sentence. Middle sentence. Final sentence.',
     'pdf_segments': [{'kind': 'text', 'text': 'First sentence. Middle sentence. Final sentence.'}]},
    {'prompt': 'Second prompt.', 'response': '计算比值x/y。Code:if x < 3:\n    print("中文")结束。',
     'pdf_segments': [{'kind': 'text', 'text': '计算比值'}, {'kind': 'math', 'text': 'x/y'},
                      {'kind': 'text', 'text': '。Code:'}, {'kind': 'code', 'text': 'if x < 3:\n    print("中文")'},
                      {'kind': 'text', 'text': '结束。'}], 'has_images': True},
]
INFO = {'imageXObjectCount': 1, 'contentRuns': [
    {'kind': 'text', 'text': 'Conversation metadata. First prompt. First sentence. Middle sentence. Final sentence. Second prompt.计算比值'},
    {'kind': 'math', 'text': '𝑥𝑦', 'group': 2},
    {'kind': 'text', 'text': '。Code:Python Copy'},
    {'kind': 'code', 'text': 'if x < 3:    print("中文")', 'group': 3},
    {'kind': 'text', 'text': '结束。'},
]}


class PdfEvidenceTests(unittest.TestCase):
    def test_adjacent_table_cell_asterisks_are_not_bold_delimiters(self):
        # Live LL(1) trace: one cell ends in *, the following cell starts in *.
        segments = [{'kind': 'text', 'text': value} for value in ["19", "$ E' T' F *", "* id $", "Match terminal *"]]
        evidence = [{'prompt': 'Trace.', 'response': ''.join(s['text'] for s in segments), 'pdf_segments': segments}]
        info = {'contentRuns': [{'kind': 'text', 'text': "Trace.19$ E' T' F ** id $Match terminal *"}]}
        self.assertTrue(assert_pdf_turn_content(info, evidence)[0])
        for wrong in ["Trace.19$ E' T' F * id $Match terminal *", "Trace.19$ E' T' F ** id $Match terminal +"]:
            self.assertFalse(assert_pdf_turn_content({'contentRuns': [{'kind': 'text', 'text': wrong}]}, evidence)[0])

    def test_normal_multilingual_formula_code_and_image(self):
        self.assertTrue(assert_pdf_turn_content(INFO, EVIDENCE)[0])

    def test_middle_tail_turn_loss_replacement_and_role_order_fail(self):
        for old, new in [('Middle sentence.', ''), ('Final sentence.', ''),
                         ('First sentence. Middle sentence. Final sentence.', ''),
                         ('First prompt.', 'Second prompt.'),
                         ('Second prompt.', 'First prompt.'),
                         ('Second prompt.计算比值', 'Second prompt.First sentence.')]:
            info = copy.deepcopy(INFO)
            info['contentRuns'][0]['text'] = info['contentRuns'][0]['text'].replace(old, new)
            with self.subTest(old=old):
                self.assertFalse(assert_pdf_turn_content(info, EVIDENCE)[0])

    def test_code_operators_formulas_and_images_are_required(self):
        for index, value in [(1, ''), (3, 'if x > 3: print("中文")')]:
            info = copy.deepcopy(INFO); info['contentRuns'][index]['text'] = value
            self.assertFalse(assert_pdf_turn_content(info, EVIDENCE)[0])
        info = copy.deepcopy(INFO); info['contentRuns'].pop(1)
        self.assertFalse(assert_pdf_turn_content(info, EVIDENCE)[0])
        info = copy.deepcopy(INFO); info['imageXObjectCount'] = 0
        self.assertFalse(assert_pdf_turn_content(info, EVIDENCE)[0])

    def test_full_source_segments_cannot_silently_omit_content(self):
        for bad in ([], EVIDENCE[1]['pdf_segments'][:-1]):
            ev = copy.deepcopy(EVIDENCE); ev[1]['pdf_segments'] = bad
            self.assertFalse(assert_pdf_turn_content(INFO, ev)[0])
        ev = copy.deepcopy(EVIDENCE); ev[1].pop('pdf_segments')
        self.assertFalse(assert_pdf_turn_content(INFO, ev)[0])

    def test_duplicate_formula_is_not_hidden_by_grouping(self):
        info = copy.deepcopy(INFO)
        info['contentRuns'].insert(2, dict(info['contentRuns'][1], group=99))
        self.assertFalse(assert_pdf_turn_content(info, EVIDENCE)[0])

    def test_duplicate_previous_reply_is_not_a_valid_next_reply(self):
        info = copy.deepcopy(INFO)
        info['contentRuns'] = info['contentRuns'][:1]
        info['contentRuns'][0]['text'] = 'First prompt. First sentence. Middle sentence. Final sentence. Second prompt. First sentence. Middle sentence. Final sentence.'
        self.assertFalse(assert_pdf_turn_content(info, EVIDENCE)[0])

    def test_repeated_authored_paragraphs_are_not_reused_as_evidence(self):
        ev = [{'prompt': 'Question.', 'response': 'Repeated.Repeated.', 'pdf_segments': [
            {'kind': 'text', 'text': 'Repeated.'}, {'kind': 'text', 'text': 'Repeated.'}]}]
        self.assertFalse(assert_pdf_turn_content({'contentRuns': [{'kind': 'text', 'text': 'Question.Repeated.'}]}, ev)[0])


class ChatGPTSourceEvidenceTests(unittest.TestCase):
    def test_gallery_controls_are_metadata_but_code_and_invalid_payloads_survive(self):
        from scripts.framework.chatgpt_evidence import markdown_fact
        root = Path(__file__).resolve().parents[1]
        marker = '\ue200image_group\ue202{"query":["alloy"],"layout":"carousel"}\ue201'
        self.assertEqual(markdown_fact(root, 'Before '+marker+' After', chatgpt=True)['text'], 'Before  After')
        self.assertIn(marker, markdown_fact(root, '`'+marker+'`', chatgpt=True)['text'])
        for invalid in ['{"query":false}', '{broken', '{"query":["alloy"],"authored":"retain"}']:
            raw = '\ue200image_group\ue202'+invalid+'\ue201'
            self.assertIn(raw, markdown_fact(root, raw, chatgpt=True)['text'])

    def test_unclosed_formula_does_not_cross_table_cells(self):
        from scripts.framework.chatgpt_evidence import markdown_fact
        root = Path(__file__).resolve().parents[1]
        source = r"""| \(f_\alpha\) \(exact) | \(f_\beta\) \(exact) |
| --- | --- |
| \(1\) | \(0\) |"""
        expected = r"""| $f_\alpha$ (exact) | $f_\beta$ (exact) |
| --- | --- |
| $1$ | $0$ |"""
        self.assertEqual(markdown_fact(root, source, chatgpt=True)['text'], markdown_fact(root, expected)['text'])

    def test_image_only_tool_message_is_visible_but_tool_chatter_is_not(self):
        from scripts.framework.chatgpt_evidence import authored_messages
        messages = [
            {'id': 'u', 'author': {'role': 'user'}, 'recipient': 'all', 'content': {'content_type': 'text', 'parts': ['Draw it']}},
            {'id': 'image', 'author': {'role': 'tool'}, 'recipient': 'all', 'content': {'content_type': 'multimodal_text', 'parts': [
                {'content_type': 'image_asset_pointer', 'asset_pointer': 'sediment://file-image'}]}},
            {'id': 'noise', 'author': {'role': 'tool'}, 'recipient': 'all', 'content': {'content_type': 'text', 'parts': ['Internal tool receipt']}},
            {'id': 'a', 'author': {'role': 'assistant'}, 'recipient': 'all', 'content': {'content_type': 'text', 'parts': ['Here is the drawing']}},
        ]
        mapping = {m['id']: {'message': m, 'parent': messages[i-1]['id'] if i else None} for i, m in enumerate(messages)}
        actual = authored_messages({'mapping': mapping, 'current_node': 'a'})
        self.assertEqual([m['id'] for m in actual], ['u', 'image', 'a'])
        self.assertEqual(actual[1]['role'], 'assistant')
        self.assertEqual(actual[1]['text'], '')
        self.assertEqual(actual[1]['imagePointers'], ['sediment://file-image'])

    def test_visible_thoughts_belong_only_to_the_following_answer(self):
        from scripts.framework.chatgpt_evidence import authored_messages
        messages = [
            {'id': 'u1', 'author': {'role': 'user'}, 'recipient': 'all', 'content': {'content_type': 'text', 'parts': ['Question']}},
            {'id': 't1', 'author': {'role': 'assistant'}, 'recipient': 'all', 'metadata': {'is_visually_hidden_from_conversation': True}, 'content': {'content_type': 'thoughts', 'thoughts': [{'summary': 'Duration', 'content': r'Ratio \(x/y\)'}]}},
            {'id': 'a1', 'author': {'role': 'assistant'}, 'recipient': 'all', 'content': {'content_type': 'text', 'parts': ['Answer']}},
            {'id': 't2', 'author': {'role': 'assistant'}, 'recipient': 'all', 'content': {'content_type': 'thoughts', 'thoughts': [{'content': 'Abandoned'}]}},
            {'id': 'u2', 'author': {'role': 'user'}, 'recipient': 'all', 'content': {'content_type': 'text', 'parts': ['Next']}},
            {'id': 'a2', 'author': {'role': 'assistant'}, 'recipient': 'all', 'content': {'content_type': 'text', 'parts': ['Second']}},
        ]
        mapping = {m['id']: {'message': m, 'parent': messages[i-1]['id'] if i else None} for i, m in enumerate(messages)}
        actual = authored_messages({'mapping': mapping, 'current_node': 'a2'})
        self.assertEqual([m['id'] for m in actual], ['u1', 'a1', 'u2', 'a2'])
        self.assertEqual(actual[1]['thoughts'], ['Duration', r'Ratio \(x/y\)'])
        self.assertEqual([actual[i]['thoughts'] for i in [0, 2, 3]], [[], [], []])


if __name__ == '__main__':
    unittest.main()
