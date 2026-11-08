"""Compare physical exported images with independently captured webpage images."""
import base64
import json
import math
import mimetypes
import re
import time
import zipfile
from pathlib import Path

from .archive_resources import resource_references, resolve_archive_reference

# Preview and original can differ in resolution/JPEG encoding. Compare decoded RGB
# at the same resolution: at most 3% RMS channel error and 1% aspect-ratio error.
PIXEL_ERROR_LIMIT = 0.03
_NORMALIZE_IMAGE = """image => {
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, width, height).data;
    // Integrate each output cell's exact pixel coverage. Browser drawImage
    // downscaling uses different kernels for preview/original scale factors,
    // which creates false differences at text and diagram edges.
    const pixels = [];
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const left = x * width / 64, right = (x + 1) * width / 64;
        const top = y * height / 64, bottom = (y + 1) * height / 64;
        const sum = [0, 0, 0];
        for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
            const vertical = Math.min(sy + 1, bottom) - Math.max(sy, top);
            for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
                const weight = vertical * (Math.min(sx + 1, right) - Math.max(sx, left));
                const at = (sy * width + sx) * 4;
                for (let channel = 0; channel < 3; channel++) sum[channel] += rgba[at + channel] * weight;
            }
        }
        const area = (right - left) * (bottom - top);
        pixels.push(...sum.map(value => value / area));
    }
    return {width, height, pixels};
}"""
_IMAGE_PIXELS = """async data => {
    const image = await createImageBitmap(await (await fetch(data)).blob());
    return (""" + _NORMALIZE_IMAGE + """)(image);
}"""

_WEBPAGE_IMAGES = """(() => ({
    chatId: location.pathname.split('/app/')[1]?.split('/')[0],
    images: [...document.querySelectorAll('model-response')].flatMap((reply, turn) =>
        [...reply.querySelectorAll('model-response-content img')]
            .filter(img => !img.closest('thought-container, thought-box, [data-math], .katex, .katex-display, [aria-hidden="true"]'))
            .map(img => { img.scrollIntoView(); return {turn, src: img.currentSrc || img.src,
                loaded: img.complete && img.naturalWidth > 0,
                failed: img.complete && img.naturalWidth === 0}; }))
}))()"""


def image_pixels(cdp, data, mime):
    url = 'data:' + mime + ';base64,' + base64.b64encode(data).decode()
    result = cdp.eval(f'({_IMAGE_PIXELS})({json.dumps(url)})', await_promise=True, timeout=20)
    return _validate_pixels(result)


def _validate_pixels(result):
    if not isinstance(result, dict) or len(result.get('pixels', [])) != 64 * 64 * 3 or min(result.get('width', 0), result.get('height', 0)) <= 0:
        raise ValueError('Image could not be decoded into independent pixel evidence')
    return result


def capture_webpage_images(cdp, chat_id, timeout=30, provider_id='gemini', message_ids=None):
    """Read browser-loaded resources, never extension storage or exported files."""
    cdp.call('Page.enable')
    deadline = time.monotonic() + timeout
    reloaded = False
    while time.monotonic() < deadline:
        expression = _WEBPAGE_IMAGES
        if provider_id == 'chatgpt':
            expression = """(() => ({chatId:location.pathname.split('/c/')[1]?.split('/')[0],
                images:[...(document.querySelector('[role="region"][aria-label="对话"], [role="region"][aria-label="Conversation"]')?.querySelectorAll('img')||[])]
                    .filter(img=>!img.closest('.katex,[aria-hidden="true"],[data-user-message-bubble]') && img.naturalWidth>128)
                    .map(img=>{img.scrollIntoView();const reply=img.closest('[data-chatgpt-selection-message-id]'),group=img.closest('[data-chatgpt-search-message-ids]');
                        return {turn:[reply?.dataset.chatgptSelectionMessageId,group?.dataset.chatgptSearchMessageIds].filter(Boolean).join(' '),
                            src:img.currentSrc||img.src,loaded:img.complete&&img.naturalWidth>0};})}))()"""
        elif provider_id != 'gemini':
            raise ValueError('Unsupported image evidence provider')
        state = cdp.eval(expression) or {}
        images = state.get('images', [])
        if message_ids:
            images = [image for image in images if any(mid in str(image.get('turn', '')).split() for mid in message_ids)]
        if state.get('chatId') == chat_id.removeprefix('c_') and images and all(image.get('loaded') and image.get('src') for image in images):
            break
        if (provider_id == 'gemini' and not reloaded
                and state.get('chatId') == chat_id.removeprefix('c_')
                and any(image.get('failed') for image in images)):
            # A completed request with no decoded pixels will not become loaded by waiting.
            # Refresh the real page once; evidence still comes from its loaded resources.
            cdp.call('Page.reload', {'ignoreCache': True})
            reloaded = True
        time.sleep(.5)
    else:
        raise ValueError('Webpage images did not load for independent comparison')
    tree = cdp.call('Page.getResourceTree')['result']['frameTree']
    frame_id = tree['frame']['id']
    result = []
    for image in images:
        src = image['src']
        if src.startswith(('blob:', 'data:')):
            # Read the decoded element: Gemini may revoke a blob URL after loading.
            # Fetching that URL again is not evidence of the displayed picture.
            pixels = _validate_pixels(cdp.eval(f"""(() => {{
                const img = [...document.images].find(img => (img.currentSrc || img.src) === {json.dumps(src)});
                if (!img) throw new Error('Web image changed during capture');
                return ({_NORMALIZE_IMAGE})(img);
            }})()"""))
        else:
            response = cdp.call('Page.getResourceContent', {'frameId': frame_id, 'url': src})
            if response.get('error'):
                raise ValueError('Cannot read browser-loaded image: ' + str(response['error']))
            resource = response['result']
            data = base64.b64decode(resource['content']) if resource['base64Encoded'] else resource['content'].encode()
            pixels = image_pixels(cdp, data, 'application/octet-stream')
        result.append(dict(turn=image['turn'], **pixels))
    return result


def image_difference(expected, actual):
    a, b = expected['pixels'], actual['pixels']
    if len(a) != 64 * 64 * 3 or len(b) != len(a):
        raise ValueError('Incomplete image pixel evidence')
    ratio_a, ratio_b = expected['width'] / expected['height'], actual['width'] / actual['height']
    if abs(ratio_a / ratio_b - 1) > .01:
        return 1.0
    return math.sqrt(sum((x-y)**2 for x, y in zip(a, b)) / len(a)) / 255


def assert_image_files(cdp, expected, entries):
    """Compare each physical image in reply order; never accept any nonempty asset."""
    if len(entries) != len(expected):
        raise ValueError(f'Image count mismatch: webpage={len(expected)}, export={len(entries)}')
    errors = []
    for source, (name, data) in zip(expected, entries):
        actual = image_pixels(cdp, data, mimetypes.guess_type(name)[0] or 'application/octet-stream')
        error = image_difference(source, actual)
        if error > PIXEL_ERROR_LIMIT:
            raise ValueError(f'Exported image differs from webpage: {name}, RGB RMS error={error:.4f}')
        errors.append(error)
    return errors


def assert_markdown_images(cdp, root, document, content, evidence):
    def read_image(reference):
        name = resolve_archive_reference(document, reference)
        if name is None:
            raise ValueError('Exported image must reference a physical local asset')
        target = (Path(root).resolve() / name).resolve()
        if not target.is_relative_to(Path(root).resolve()):
            raise ValueError('Image path escapes export directory')
        return name, target.read_bytes()
    return _assert_document_images(cdp, content, evidence, read_image)


def assert_zip_images(cdp, archive, chat_id, evidence):
    with zipfile.ZipFile(archive) as zf:
        documents = [name for name in zf.namelist() if name.endswith(f'_{chat_id[-6:]}.md')]
        if len(documents) != 1:
            raise ValueError('Image export must contain exactly one target Markdown document')
        document = documents[0]
        content = zf.read(document).decode('utf-8')
        identity = re.search(r'^id:\s*["\']?([^"\'\s]+)', content, re.MULTILINE)
        if not identity or identity[1].removeprefix('c_') != chat_id.removeprefix('c_'):
            raise ValueError('Image export belongs to another conversation')
        def read_image(reference):
            name = resolve_archive_reference(document, reference)
            if name is None:
                raise ValueError('Exported image must reference a physical local asset')
            return name, zf.read(name)
        return _assert_document_images(cdp, content, evidence, read_image)


def _assert_document_images(cdp, content, evidence, read_image):
    from .assertions import markdown_messages
    comparisons = []
    messages = markdown_messages(content)[1::2]
    if len(messages) != len(evidence):
        raise ValueError('Image evidence and exported reply counts differ')
    for turn, message in zip(evidence, messages):
        expected = turn.get('images', [])
        if turn.get('has_images') and not expected:
            raise ValueError('Missing independent webpage image pixels: ' + turn.get('image_evidence_error', 'not captured'))
        refs = resource_references(message['content'], kind='image')
        entries = [read_image(reference) for reference in refs]
        comparisons.extend(assert_image_files(cdp, expected, entries))
    return comparisons
