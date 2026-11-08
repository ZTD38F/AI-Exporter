# Vendored Typst Compiler WASM

## typst_ts_web_compiler_bg.wasm (28,325,178 bytes)

- **Version**: `@myriaddreamin/typst-ts-web-compiler` 0.7.0 (paired with `@myriaddreamin/typst.ts` 0.7.0).
- **Why vendored**: Loaded via `fetch(chrome.runtime.getURL(...))` by the extension host and transferred to the sandboxed compile iframe so the extension build and packaged artifact do not depend on `node_modules` layout at runtime.
- **SHA-256**: `1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd`
