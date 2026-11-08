import { describeFixtures, synthetic } from './provenance.js';
/** Native image and conversation-attachment download exchange responses. */
interface FileDownloadResponse {
    status?: string;
    download_url?: string;
    file_name?: string;
    file_size_bytes?: number;
    mime_type?: string;
    error_code?: string;
    error_type?: string;
    error_message?: string;
}

const fixtureMap = {
    'C_DIAGNOSTIC_EXPIRED_SANDBOX_01': () => ({ status: 'error', error_code: 'ace_pod_expired',
        error_type: 'GetDownloadLinkError', error_message: 'do-not-log private-path?token=secret' }),
    'C_DIAGNOSTIC_RELATIVE_DOWNLOAD_01': () => ({ status: 'success', download_url: '/private-path?token=do-not-log' }),
    'C_DIAGNOSTIC_SIGNED_DOWNLOAD_01': () => ({ status: 'success', download_url: 'https://files.example/private-path?token=do-not-log' }),
    'C_ATTACHMENT_DOWNLOAD_ACQUIRE_01': () => ({ download_url: 'https://dl/img.png' }),
    'C_FILE_DOWNLOAD_HELPERS_01': () => ({
        status: 'success', download_url: 'https://x/dl', file_name: 'a.png', file_size_bytes: 10,
    }),
    'C_FILE_DOWNLOAD_HELPERS_02': () => ({ status: 'error' }),
    'C_FILE_DOWNLOAD_ACQUIRE_01': () => ({
        status: 'success', download_url: 'https://dl/img.png', file_name: 'cat.png',
    }),
    'C_FILE_DOWNLOAD_ACQUIRE_02': () => ({ status: 'error' }),
};

export function fileDownloadGen(key: keyof typeof fixtureMap): FileDownloadResponse {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored ChatGPT protocol, content or state counterexample; no saved capture is used."));
