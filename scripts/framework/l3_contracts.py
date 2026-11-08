"""L3 wire assertions for real Tier 2 exports, additional to physical ZIP/file checks."""
import json
from scripts.framework.v2_probe import install_probe


KEY_PATHS = {
    'accounts': 'id', 'indexes': ['key.accountId', 'key.conversationId'],
    'details': ['key.accountId', 'key.conversationId'],
    'coverage': ['accountId', 'streamId'],
    'exportRecords': ['accountId', 'conversationId'], 'directoryHandles': None,
}


def assert_l3_contracts(evidence, expected_ids):
    layout = evidence['layout']
    assert layout['name'] == 'gemini_exporter_v2' and layout['version'] == 1, 'L3a database identity'
    stores = layout['stores']
    assert sorted(row['name'] for row in stores) == sorted(KEY_PATHS), 'L3a must have exactly six stores'
    for row in stores:
        assert row['keyPath'] == KEY_PATHS[row['name']] and row['autoIncrement'] is False, 'L3a key path'
        expected = [{'name': 'providerIdentity', 'keyPath': ['providerId', 'providerAccountId'],
                     'unique': True, 'multiEntry': False}] if row['name'] == 'accounts' else []
        assert row['indexes'] == expected, 'L3a index layout'
    documents = evidence['documents']
    assert len(expected_ids) == len(set(expected_ids)) > 0, 'L3 targets must be explicit and unique'
    assert sorted(row['key']['conversationId'] for row in documents) == sorted(expected_ids), 'L3 target identity'
    for row in documents:
        key, domain, account, document = row['key'], row['domain'], row['account'], row['document']
        assert domain['index']['key'] == domain['detail']['key'] == key, 'L3 ConversationKey'
        assert key['accountId'] == account['id'], 'L3 Account ownership'
        assert set(document) == {'title', 'metadata', 'messages'}, 'L3b retired document fields'
        metadata = {'id': key['conversationId'], 'provider': account['providerId']}
        for name in ('createdAt', 'updatedAt'):
            if name in domain['index']:
                metadata[name] = domain['index'][name]
                assert type(metadata[name]) is int and abs(metadata[name]) <= 2**53 - 1, 'L3b safe millisecond time'
        assert document['metadata'] == metadata, 'L3b metadata must use Index/Account facts'
        assert document['title'] == domain['index'].get('title', 'Untitled conversation'), 'L3b title'
        messages = document['messages']
        assert len(messages) == len(domain['detail']['messages']), 'L3b message count'
        number = 0
        for message, source in zip(messages, domain['detail']['messages']):
            assert set(message) <= {'role', 'timestamp', 'modelLabel', 'blocks', 'sources'}, 'L3b retired message fields'
            assert message['role'] == source['role'], 'L3b role'
            for target, origin in [('timestamp', 'timestamp'), ('modelLabel', 'model')]:
                assert (target in message) == (origin in source), 'L3b optional source fact'
                assert message.get(target) == source.get(origin), 'L3b message fact'
            if 'timestamp' in message:
                assert type(message['timestamp']) is int and abs(message['timestamp']) <= 2**53 - 1, 'L3b safe message time'
            reasoning = source.get('reasoning') or []
            blocks = message['blocks']
            if reasoning:
                assert blocks[0]['type'] == 'disclosure' and blocks[0]['kind'] == 'reasoning', 'L3b reasoning order'
                assert blocks[0]['title'] == 'Thinking Process', 'L3b fixed disclosure title'
            else:
                assert not blocks or blocks[0]['type'] != 'disclosure', 'L3b empty reasoning'
            citations = source.get('citations', [])
            assert len(message.get('sources', [])) == len(citations), 'L3b source retention'
            for item, citation in zip(message.get('sources', []), citations):
                number += 1
                expected = {'id': citation['id'], 'number': number,
                            'label': citation.get('title') or citation.get('url') or ''}
                if 'url' in citation:
                    expected['href'] = citation['url']
                assert item == expected, 'L3b source identity/number'
            def nodes(value, kind):
                if isinstance(value, list):
                    return [node for child in value for node in nodes(child, kind)]
                if isinstance(value, dict):
                    return ([value] if value.get('type') == kind else []) + [node for child in value.values() for node in nodes(child, kind)]
                return []
            expected_refs = []
            by_id = {item['id']: item for item in message.get('sources', [])}
            for ref in nodes(reasoning + source['content'], 'citationRef'):
                item = by_id[ref['citationId']]
                label = ref.get('label')
                expected = {'type': 'citation', 'id': ref['citationId'],
                            'label': label if label and label.strip() else '[' + str(item['number']) + ']'}
                if 'href' in item:
                    expected['href'] = item['href']
                expected_refs.append(expected)
            assert nodes(message['blocks'], 'citation') == expected_refs, 'L3b explicit citation labels'
        referenced, images = set(), set()
        def visit(node):
            if isinstance(node, list):
                for child in node:
                    visit(child)
            elif isinstance(node, dict):
                if node.get('type') == 'disclosure':
                    assert isinstance(node.get('title'), str), 'L3b disclosure title required'
                if node.get('type') in ('image', 'file'):
                    referenced.add(node['resourceId'])
                    if node['type'] == 'image':
                        images.add(node['resourceId'])
                if {'column', 'rowSpan', 'colSpan'} <= set(node):
                    assert 'align' not in node, 'L3b column alignment belongs to table'
                for child in node.values():
                    visit(child)
        visit(messages)
        assert sorted(referenced) == row['referencedIds'] and sorted(images) == row['imageIds'], 'L3b resource query'
        assert referenced <= {asset['id'] for asset in domain['detail']['assets']}, 'L3b closed resources'
    return evidence


def audit_l3_contracts(cdp, ids):
    install_probe(cdp)
    evidence = cdp.eval('globalThis.__tier2V2.l3Contracts(' + json.dumps(ids) + ')', await_promise=True)
    return assert_l3_contracts(evidence, ids)
