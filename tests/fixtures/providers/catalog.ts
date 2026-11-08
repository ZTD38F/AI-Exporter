/** Offline metadata inventory; importing it does not materialize fixture payloads. */
import { fixtureOrigins as chatgptOrigins } from './chatgpt.js';
import { fixtureOrigins as chatgptDeleteOrigins } from './chatgptDelete.js';
import { fixtureOrigins as chatgptDetailOrigins } from './chatgptDetail.js';
import { fixtureOrigins as chatgptFileDownloadOrigins } from './chatgptFileDownload.js';
import { fixtureOrigins as chatgptSessionOrigins } from './chatgptSession.js';
import { fixtureOrigins as chatgptSignedAssetOrigins } from './chatgptSignedAsset.js';
import { fixtureOrigins as chatgptStreamOrigins } from './chatgptStream.js';
import { fixtureOrigins as claudeDeleteOrigins } from './claudeDelete.js';
import { fixtureOrigins as claudeDetailOrigins } from './claudeDetail.js';
import { fixtureOrigins as claudeListOrigins } from './claudeList.js';
import { fixtureOrigins as claudeOrganizationsOrigins } from './claudeOrganizations.js';
import { fixtureOrigins as claudeStreamOrigins } from './claudeStream.js';
import { fixtureOrigins as geminiDetailContentCasesOrigins } from './gemini/detail/contentCases.js';
import { fixtureOrigins as geminiDetailIntegrationCasesOrigins } from './gemini/detail/integrationCases.js';
import { fixtureOrigins as geminiDetailProtocolCasesOrigins } from './gemini/detail/protocolCases.js';
import { fixtureOrigins as geminiDetailResourcesCasesOrigins } from './gemini/detail/resourcesCases.js';
import { fixtureOrigins as geminiDetailVersionCasesOrigins } from './gemini/detail/versionCases.js';
import { fixtureOrigins as geminiListCasesOrigins } from './gemini/list/cases.js';
import { fixtureOrigins as geminiDeleteOrigins } from './geminiDelete.js';
import { fixtureOrigins as geminiDeleteRequestOrigins } from './geminiDeleteRequest.js';
import { fixtureOrigins as geminiDetailRequestOrigins } from './geminiDetailRequest.js';
import { fixtureOrigins as geminiDomListOrigins } from './geminiDomList.js';
import { fixtureOrigins as geminiListRequestOrigins } from './geminiListRequest.js';
import { fixtureOrigins as geminiStreamOrigins } from './geminiStream.js';
import { fixtureOrigins as geminiStreamRequestOrigins } from './geminiStreamRequest.js';
import { fixtureOrigins as grokDetailOrigins } from './grokDetail.js';
import { fixtureOrigins as grokListOrigins } from './grokList.js';
import { fixtureOrigins as grokMetadataOrigins } from './grokMetadata.js';
import { fixtureOrigins as grokResponsesOrigins } from './grokResponses.js';
import { fixtureOrigins as grokTreeOrigins } from './grokTree.js';
import { fixtureOrigins as grokUserOrigins } from './grokUser.js';

export const fixtureCatalog = [
    ...chatgptOrigins,
    ...chatgptDeleteOrigins,
    ...chatgptDetailOrigins,
    ...chatgptFileDownloadOrigins,
    ...chatgptSessionOrigins,
    ...chatgptSignedAssetOrigins,
    ...chatgptStreamOrigins,
    ...claudeDeleteOrigins,
    ...claudeDetailOrigins,
    ...claudeListOrigins,
    ...claudeOrganizationsOrigins,
    ...claudeStreamOrigins,
    ...geminiDetailContentCasesOrigins,
    ...geminiDetailIntegrationCasesOrigins,
    ...geminiDetailProtocolCasesOrigins,
    ...geminiDetailResourcesCasesOrigins,
    ...geminiDetailVersionCasesOrigins,
    ...geminiListCasesOrigins,
    ...geminiDeleteOrigins,
    ...geminiDeleteRequestOrigins,
    ...geminiDetailRequestOrigins,
    ...geminiDomListOrigins,
    ...geminiListRequestOrigins,
    ...geminiStreamOrigins,
    ...geminiStreamRequestOrigins,
    ...grokDetailOrigins,
    ...grokListOrigins,
    ...grokMetadataOrigins,
    ...grokResponsesOrigins,
    ...grokTreeOrigins,
    ...grokUserOrigins,
];
