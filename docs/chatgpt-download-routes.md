# ChatGPT attachment download routes

Checked on 2026-10-28 using the project debug Chrome and CDP. The loaded native frontend bundle was:

- URL: https://chatgpt.com/cdn/assets/7078.6cca9159bc.js
- SHA-256: `edff1fc039af2a408c0be578173d1df447cb910f2d4e6d9d94e0189c7a9c4cf7`

The native image URL exchange replaces every `#` in the file identifier with `*` before passing the identifier to `/files/download/{file_id}`. URL-encoding an unchanged composite identifier as `%23` does not perform this protocol conversion. The Domain source pointer stays unchanged; only the request path is normalized.

Uploaded attachments have a separate native exchange: `/conversation/{id}/attachment/{file_id}/download`. Native library-backed files can also use the scoped file exchange. Since older stored locators do not identify library-backed files, an uploaded-file exchange that returns 403/404 gets one scoped file-exchange fallback; HTTP 401, throttling and unrelated failures do not trigger this fallback. The image exchange remains in use for `sediment://` and `file-service://` image pointers. Download responses can carry `download_url` without a `status` field; explicit retry/error statuses must not be treated as success.

## Live verification and limits

For one existing test-account image, the old image exchange, conversation-scoped image exchange, and conversation attachment exchange all returned HTTP 200. The three signed URLs were downloaded to disk: each produced the same decodable 2,159,772-byte PNG with an identical SHA-256. No signed URLs, session credentials, or private response bodies are committed.

The production `ChatGPTProvider` was also exercised with a CDP-backed fetch function and an isolated in-memory Account registry. Its sediment image, legacy file-service image, and conversation-attachment acquisition paths each wrote identical PNG bytes to disk. This was a focused acquisition check, not a full Tier 2 run.

This verifies successful acquisition through the routes, not resolution of the reporter’s 403/404 failures. The debug profile uses a different account. Its sample did not have a composite image identifier or a failing uploaded attachment. Composite normalization and uploaded-file route selection have regression tests grounded in the native frontend implementation; those exact failing resources have not been retested.

## Sandbox-generated resources

API Markdown images and download links under `sandbox:/mnt/data/` retain their source message identity in a durable `chatgpt-sandbox:` locator. The provider exchanges the conversation ID, original provider message ID, and decoded sandbox path through `/conversation/{conversation_id}/interpreter/download`, then downloads the returned signed URL. Two messages using the same path are separate resources. Archive parsing retains ordinary sandbox paths for ZIP resource binding, and fenced code is not interpreted as a download link.

A focused CDP-backed provider check used three existing test-account API resource descriptors: a generated PNG (1,470,923 bytes), Python script (6,398 bytes), and Markdown report (11,716 bytes). All were physically downloaded. PNG decoding, Python syntax parsing, and Markdown UTF-8 checks passed. This checks acquisition from known descriptors; it is not a full UI export or a retest of the diagnostic account’s 138 resource failures.

Persistent folder write failures now include the native exception name, relative path, and failing lifecycle stage. The repeated failure in the supplied diagnostics has not been reproduced in this test profile; retaining that context supports a precise diagnosis on the next retry.

## Long attachment preparation

Diagnostics (5) recorded a 94.931-second manually cancelled folder export. Source parsing for the same conversation occurred at 3.2 and 50.7 seconds; its six attachment 404s were reported at 83.688 seconds. The previous diagnostic format recorded final failures but no per-resource start/completion timestamps, so it cannot establish an indefinitely hung request. It does establish a long interval without attachment progress and a second source parse consistent with the existing refresh/reacquisition flow.

A live check of the affected account confirmed that ChatGPT's own file preview and conversation attachment download exchange returned 404 for the same uploaded roadmap file, with the download exchange returning in about 0.8 seconds. This establishes an unavailable native locator for that file; it does not establish that all six failed attachments are unavailable, or measure the extension's entire export path.

The exporter previously treated this fresh exchange 404 like an expired signed download URL: it refreshed the conversation and reacquired every referenced attachment, including the successful ones. Native exchange 404s now retain HTTP status but use `RESOURCE_LOCATOR_UNAVAILABLE`; they produce partial delivery without refreshing and reacquiring the whole conversation. Actual signed-download 404s still use their existing recovery path. The fixed 60-second request deadline added during the initial investigation has been removed; it did not address this unnecessary reacquisition. Attachment progress and diagnostic observations remain available.
