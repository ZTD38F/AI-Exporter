"""Physical JSON export checks, independent of the Markdown specification."""
import json
import re
import zipfile

from .archive_resources import resolve_archive_reference


def validate_json_archive(path, min_conversations=1, chat_id=None):
    errors, keys = [], []
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            entries = set(names)
            if len(entries) != len(names):
                errors.append('Duplicate ZIP entry names')
            documents = [name for name in names if name.lower().endswith('.json')
                         and not any(part in ('assets', 'files', 'images') for part in name.split('/')[:-1])]
            if len(documents) < min_conversations:
                errors.append(f'Expected {min_conversations} JSON conversations, found {len(documents)}')
            for name in documents:
                try:
                    data = json.loads(archive.read(name))
                    if not isinstance(data, dict) or data.get('format') != 'gemini-exporter-domain' or type(data.get('version')) is not int or data['version'] != 1:
                        raise ValueError('Unsupported JSON export format/version')
                    account, conversation = data['account'], data['conversation']
                    index, detail = conversation['index'], conversation['detail']
                    key = index['key']
                    if (not isinstance(key, dict) or not isinstance(key.get('conversationId'), str)
                            or not key['conversationId'] or key != detail['key']
                            or not isinstance(account['id'], str) or key.get('accountId') != account['id']):
                        raise ValueError('Account/index/detail key mismatch')
                    if key in keys:
                        raise ValueError('Duplicate conversation key')
                    keys.append(key)
                    messages, assets, resources = detail['messages'], detail['assets'], data['resources']
                    if not isinstance(messages, list) or not isinstance(assets, list) or not isinstance(resources, dict):
                        raise ValueError('Invalid messages/assets/resources shape')
                    if any(not isinstance(message, dict) or not isinstance(message.get('role'), str)
                           or not isinstance(message.get('content'), list) for message in messages):
                        raise ValueError('Invalid message role/content')
                    asset_ids = {asset['id'] for asset in assets if isinstance(asset, dict) and isinstance(asset.get('id'), str)}
                    for resource_id, reference in resources.items():
                        if resource_id not in asset_ids or not isinstance(reference, str):
                            raise ValueError('Resource binding has no matching asset or path')
                        target = resolve_archive_reference(name, reference)
                        if target is None or target not in entries or target.endswith('/') or not archive.read(target):
                            raise ValueError(f'Missing or empty resource: {reference}')
                except (ValueError, KeyError, TypeError, UnicodeError) as exc:
                    errors.append(f'{name}: {exc}')
            if chat_id:
                normalized = re.sub(r'^c_', '', chat_id)
                if not any(re.sub(r'^c_', '', key['conversationId']) == normalized for key in keys):
                    errors.append(f'Target conversation not found: {chat_id}')
    except (OSError, zipfile.BadZipFile) as exc:
        errors.append(str(exc))
    return not errors, 'JSON archive specification ' + ('failed' if errors else 'passed'), {
        'format': 'json', 'json_count': len(keys), 'errors': errors,
    }
