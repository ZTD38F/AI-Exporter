"""Independent physical-file checks for the deterministic upgrade transport."""
import argparse
from pathlib import Path
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.framework.html_evidence import assert_html_turn_content
from scripts.framework.pdf_evidence import assert_pdf_turn_content
from scripts.framework.cases.export import PdfExportDownloadCase


def source_turn(slot, index):
    code = f'value = {index} ** 2\nprint(value)'
    segments = [
        {'kind': 'text', 'text': f'Upgrade {slot} answer {index}. The complete middle paragraph preserves the measured boundary condition.'},
        {'kind': 'text', 'text': 'Exact code follows:'},
        {'kind': 'code', 'text': code},
        {'kind': 'text', 'text': 'Energy is '},
        {'kind': 'math', 'text': 'E = mc^2'},
        {'kind': 'text', 'text': f'. Final {slot} sentence {index}.'},
    ]
    return {'prompt': f'Upgrade {slot} question {index}: explain conservation and boundary conditions.',
            'response': ''.join(s['text'] for s in segments), 'pdf_segments': segments,
            'code_blocks': [code], 'execution_blocks': [], 'has_images': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('zip_path')
    parser.add_argument('slot', choices=['u0', 'u1'])
    parser.add_argument('format', choices=['html', 'pdf'])
    parser.add_argument('--first-turn-count', type=int, default=3)
    args = parser.parse_args()
    with zipfile.ZipFile(args.zip_path) as archive, tempfile.TemporaryDirectory() as directory:
        for suffix in ['111111', '222222']:
            names = [name for name in archive.namelist() if name.endswith(f'_{suffix}.{args.format}')]
            if len(names) != 1:
                raise AssertionError(f'Missing/duplicate physical {args.format}: {suffix}')
            data = archive.read(names[0])
            evidence = [source_turn(args.slot, index) for index in range(args.first_turn_count if suffix == '111111' else 3)]
            if args.format == 'html':
                ok, message = assert_html_turn_content(data.decode(), evidence)
            else:
                target = Path(directory) / 'conversation.pdf'
                target.write_bytes(data)
                ok, message = assert_pdf_turn_content(PdfExportDownloadCase._extract_pdf_info(str(target)), evidence)
            if not ok:
                raise AssertionError(message)
            print(message)


if __name__ == '__main__':
    main()
