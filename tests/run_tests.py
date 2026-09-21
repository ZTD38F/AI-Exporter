import os
import sys
import json
import re

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

print("=" * 60)
print(" Gemini Exporter - Comprehensive Test Suite")
print("=" * 60)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def test_json_files():
    for jf in ["manifest.json", "package.json", "_locales/zh_CN/messages.json", "_locales/en/messages.json", "scripts/test_scenario_pool.json", "scripts/test_scenario_archive.json"]:
        p = os.path.join(BASE_DIR, jf)
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
            print(f"  ✓ JSON valid: {jf}")

def test_manifest_structure():
    with open(os.path.join(BASE_DIR, "manifest.json"), "r", encoding="utf-8") as f:
        m = json.load(f)
        assert m["manifest_version"] == 3
        assert "storage" in m["permissions"]
        assert m["background"]["service_worker"] == "dist/background/background.js", "background service_worker must point to the esbuild dist output"
        cs = m["content_scripts"]
        assert cs[0]["js"] == ["dist/content/content.js"], "ISOLATED content script must load single bundled dist/content/content.js"
        main_world = [c for c in cs if c.get("world") == "MAIN"]
        assert len(main_world) == 1 and main_world[0]["js"] == ["dist/content/hook.js"], "MAIN world must load single bundled dist/content/hook.js"
        war = m["web_accessible_resources"][0]["resources"]
        assert "dist/content/hook.js" in war, "web_accessible_resources must expose dist/content/hook.js"
        print("  ✓ manifest.json scripts and permissions verified")

def test_build_pipeline():
    assert os.path.isfile(os.path.join(BASE_DIR, "build.js")), "build.js (esbuild pipeline) must exist"
    with open(os.path.join(BASE_DIR, "package.json"), "r", encoding="utf-8") as f:
        pkg = json.load(f)
    assert pkg["scripts"].get("build") == "node build.js", "package.json must define npm run build"
    assert "esbuild" in pkg.get("devDependencies", {}), "esbuild must be a devDependency"
    with open(os.path.join(BASE_DIR, ".gitignore"), "r", encoding="utf-8") as f:
        gi = f.read()
    assert re.search(r'^dist/?$', gi, re.MULTILINE), "dist/ build output must be gitignored"

    # Phase 5: verify all 5 bundle entrypoints configured in build.js
    with open(os.path.join(BASE_DIR, "build.js"), "r", encoding="utf-8") as f:
        build_content = f.read()
    assert "content/content" in build_content, "build.js must configure content/content bundle"
    assert "content/hook" in build_content, "build.js must configure content/hook bundle"
    assert "background/background" in build_content, "build.js must configure background/background bundle"
    assert "ui/popup" in build_content, "build.js must configure ui/popup bundle"
    assert "ui/options" in build_content, "build.js must configure ui/options bundle"

    # Phase 5: verify bundle artifacts if dist/ has been built
    dist_dir = os.path.join(BASE_DIR, "dist")
    if os.path.isdir(dist_dir):
        expected_bundles = [
            "dist/content/content.js",
            "dist/content/hook.js",
            "dist/background/background.js",
            "dist/ui/popup.js",
            "dist/ui/options.js",
        ]
        for bundle in expected_bundles:
            assert os.path.isfile(os.path.join(BASE_DIR, bundle)), f"Bundle artifact missing: {bundle}"
        print("  ✓ all 5 bundle artifacts verified in dist/")

    print("  ✓ esbuild build pipeline verified (build.js + npm script + devDependency)")

def test_html_includes():
    for opt_path in ["src/ui/options/options.html"]:
        with open(os.path.join(BASE_DIR, opt_path), "r", encoding="utf-8") as f:
            opt_html = f.read()
            # PR 5: options.html uses JSZip (UMD global) + single bundled dist/ui/options.js
            assert '<script src="/lib/jszip.min.js"></script>' in opt_html, f"Missing /lib/jszip.min.js in {opt_path}"
            assert '<script src="/dist/ui/options.js"></script>' in opt_html, f"Missing /dist/ui/options.js in {opt_path}"
            # Ensure legacy 50-script scatter is removed (spot-check 2 legacy entries must NOT be present)
            assert '/dist/core/protocol/protocol.js' not in opt_html or opt_html.count('<script') == 2, f"Legacy per-file scripts must be removed in {opt_path}"

    for pop_path in ["src/ui/popup/popup.html"]:
        with open(os.path.join(BASE_DIR, pop_path), "r", encoding="utf-8") as f:
            pop_html = f.read()
            # Phase 3: popup.html uses single bundled dist/ui/popup.js
            assert '<script src="/dist/ui/popup.js"></script>' in pop_html, f"Missing /dist/ui/popup.js in {pop_path}"
            # Ensure legacy per-file scripts are removed
            assert '/dist/core/protocol/protocol.js' not in pop_html or pop_html.count('<script') == 1, f"Legacy per-file scripts must be removed in {pop_path}"
    print("  ✓ options.html and popup.html script tags verified")


def test_i18n_keys():
    # Dictionaries live in locales/{zh,en}.js since Phase 2b (classic-script
    # modules whose bodies are flat `key: "value"` object literals).
    dicts = {"zh": {}, "en": {}}
    for lang in ("zh", "en"):
        loc_ts = os.path.join(BASE_DIR, "src/core/utils/locales", f"{lang}.ts")
        loc_file = loc_ts if os.path.isfile(loc_ts) else os.path.join(BASE_DIR, "src/core/utils/locales", f"{lang}.js")
        with open(loc_file, "r", encoding="utf-8") as f:
            text = f.read()
        in_dict = False
        for line in text.splitlines():
            stripped = line.strip()
            if stripped == "return {":
                in_dict = True
                continue
            if in_dict:
                if stripped.startswith("};"):
                    break
                if ":" in stripped:
                    parts = stripped.split(":", 1)
                    k = parts[0].strip().strip('"').strip("'")
                    v = parts[1].strip().rstrip(",").strip().strip('"').strip("'")
                    dicts[lang][k] = v

    zh_dict = dicts["zh"]
    en_dict = dicts["en"]
    assert len(zh_dict) >= 100, f"zh locale should have 100+ keys, got {len(zh_dict)}"
    assert len(en_dict) >= 100, f"en locale should have 100+ keys, got {len(en_dict)}"

    for html_file in ["src/ui/options/options.html", "src/ui/popup/popup.html"]:
        with open(os.path.join(BASE_DIR, html_file), "r", encoding="utf-8") as f:
            content = f.read()
        html_keys = set(re.findall(r'data-i18n(?:-title|-placeholder|-html)?=["\']([^"\']+)["\']', content))
        missing_zh = html_keys - set(zh_dict.keys())
        missing_en = html_keys - set(en_dict.keys())
        assert not missing_zh, f"Missing in zh ({html_file}): {missing_zh}"
        assert not missing_en, f"Missing in en ({html_file}): {missing_en}"
    print("  ✓ i18n keys complete and matched across all HTML templates")

def test_javascript_syntax():
    import subprocess
    import shutil
    # PR7: delegate syntax validation to TypeScript compiler (strict mode covers JS + TS)
    node_bin = None
    for cand in [shutil.which("node"), os.path.expanduser("~/.local/node/bin/node"), os.path.expanduser("~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"), r"C:\Program Files\nodejs\node.exe"]:
        if cand and os.path.exists(cand):
            node_bin = cand
            break

    tsc_script = os.path.join(BASE_DIR, "node_modules", "typescript", "bin", "tsc")
    if node_bin and os.path.exists(tsc_script):
        res = subprocess.run([node_bin, tsc_script, "--noEmit"], cwd=BASE_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace")
    else:
        env = os.environ.copy()
        for p in [r"C:\Program Files\nodejs", r"C:\Program Files\nodejs\npx.cmd"]:
            if p not in env.get("PATH", ""):
                env["PATH"] = p + os.pathsep + env.get("PATH", "")
        npx_bin = shutil.which("npx", path=env["PATH"]) or r"C:\Program Files\nodejs\npx.cmd" or "npx"
        res = subprocess.run(f'"{npx_bin}" tsc --noEmit', cwd=BASE_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=True, env=env)

    assert res.returncode == 0, f"TypeScript syntax check failed (tsc --noEmit):\n{res.stdout}\n{res.stderr}"
    print(f"  ✓ TypeScript strict syntax validated (tsc --noEmit)")

def test_javascript_unit_tests():
    import subprocess
    import glob
    import shutil
    import tempfile

    jsc_bin = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
    node_bin = None
    for cand in [shutil.which("node"), os.path.expanduser("~/.local/node/bin/node"), os.path.expanduser("~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"), r"C:\Program Files\nodejs\node.exe"]:
        if cand and os.path.exists(cand):
            node_bin = cand
            break

    test_files = sorted(set(glob.glob(os.path.join(BASE_DIR, "tests", "*.test.js")) + glob.glob(os.path.join(BASE_DIR, "tests", "*.test.ts"))))


    # Preload files for mock fs in JSC
    file_map = {}
    for root, dirs, files in os.walk(BASE_DIR):
        if any(x in root for x in ["node_modules", ".git", "playwright", "dist"]):
            continue
        for f in files:
            if f.endswith((".js", ".html", ".json", ".md")):
                p = os.path.join(root, f)
                with open(p, "r", encoding="utf-8") as fp:
                    content = fp.read()
                    file_map[os.path.normpath(p)] = content

    register_hook = os.path.join(BASE_DIR, "tests", "ts_register.js")

    for tf in test_files:
        rel = os.path.relpath(tf, BASE_DIR)
        if node_bin:
            cmd = [node_bin, "-r", register_hook, "--test", tf] if os.path.exists(register_hook) else [node_bin, "--test", tf]
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            assert res.returncode == 0, f"Unit test failed in {rel}:\n{res.stdout}\n{res.stderr}"
            print(f"  ✓ Unit test suite passed: {rel}")
        elif os.path.exists(jsc_bin):
            with open(tf, "r", encoding="utf-8") as f:
                test_code = f.read()

            harness = (
                "const __fileMap = " + json.dumps(file_map) + ";\n"
                "const __dirname = " + json.dumps(os.path.join(BASE_DIR, "tests")) + ";\n"
                """
            const modules = {};
            const nodeTest = (name, fn) => {
                try { fn(); }
                catch(e) { throw new Error(name + ': ' + (e.stack || e.message || e)); }
            };
            nodeTest.test = nodeTest;
            nodeTest.skip = () => {};
            nodeTest.only = nodeTest;

            function require(id) {
                if (id === 'node:test' || id === 'test') return nodeTest;
                if (id === 'node:assert' || id === 'assert') {
                    return {
                        strictEqual: (a, b) => { if (a !== b) throw new Error(a + ' !== ' + b); },
                        deepStrictEqual: (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(JSON.stringify(a) + ' !== ' + JSON.stringify(b)); },
                        ok: (a, msg) => { if (!a) throw new Error(msg || ('Expected truthy, got ' + a)); }
                    };
                }
                if (id === 'node:path' || id === 'path') {
                    return {
                        join: (...parts) => {
                            let p = parts.join('/').replace(/\\/+/g, '/');
                            const segments = p.split('/');
                            const resolved = [];
                            for (const seg of segments) {
                                if (seg === '..') resolved.pop();
                                else if (seg && seg !== '.') resolved.push(seg);
                            }
                            return (p.startsWith('/') ? '/' : '') + resolved.join('/');
                        }
                    };
                }
                if (id === 'node:fs' || id === 'fs') {
                    return {
                        readFileSync: (p, enc) => {
                            let norm = p.replace(/\\/+/g, '/');
                            const segments = norm.split('/');
                            const resolved = [];
                            for (const seg of segments) {
                                if (seg === '..') resolved.pop();
                                else if (seg && seg !== '.') resolved.push(seg);
                            }
                            norm = (norm.startsWith('/') ? '/' : '') + resolved.join('/');
                            if (__fileMap[norm]) return __fileMap[norm];
                            for (const k in __fileMap) {
                                if (k.endsWith(norm) || norm.endsWith(k)) return __fileMap[k];
                            }
                            throw new Error('File not found in mock fs: ' + p);
                        }
                    };
                }
                if (modules[id]) return modules[id];
                throw new Error('Module not found: ' + id);
            }
            """
            )

            preload_js = []
            for mod_path, mod_id in [
                ("src/core/utils/utils.js", "../src/core/utils/utils.js"),
                ("src/core/utils/utils.js", "./src/core/utils/utils.js"),
                ("src/core/utils/utils.js", "./utils.js"),
                ("src/core/utils/utils.js", "../utils.js"),
                ("src/core/api/parser/extractors.js", "./parser/extractors.js"),
                ("src/core/api/parser/extractors.js", "./extractors.js"),
                ("src/core/api/parser/extractors.js", "../src/core/api/parser/extractors.js"),
                ("src/core/api/parser/attachments.js", "./parser/attachments.js"),
                ("src/core/api/parser/attachments.js", "./attachments.js"),
                ("src/core/api/parser/attachments.js", "../src/core/api/parser/attachments.js"),
                ("src/core/api/parser/parseList.js", "./parser/parseList.js"),
                ("src/core/api/parser/parseList.js", "./parseList.js"),
                ("src/core/api/parser/parseList.js", "../src/core/api/parser/parseList.js"),
                ("src/core/api/parser/parseDetail.js", "./parser/parseDetail.js"),
                ("src/core/api/parser/parseDetail.js", "./parseDetail.js"),
                ("src/core/api/parser/parseDetail.js", "../src/core/api/parser/parseDetail.js"),
                ("src/core/api/geminiParser.js", "../src/core/api/geminiParser.js"),
                ("src/core/api/geminiParser.js", "./src/core/api/geminiParser.js"),
                ("src/core/api/geminiParser.js", "./gemini_parser.js"),
                ("src/core/api/geminiParser.js", "../gemini_parser.js"),
                ("src/core/api/client/credentialManager.js", "./client/credentialManager.js"),
                ("src/core/api/client/credentialManager.js", "./credentialManager.js"),
                ("src/core/api/client/credentialManager.js", "../src/core/api/client/credentialManager.js"),
                ("src/core/api/client/retryPolicy.js", "./client/retryPolicy.js"),
                ("src/core/api/client/retryPolicy.js", "./retryPolicy.js"),
                ("src/core/api/client/retryPolicy.js", "../src/core/api/client/retryPolicy.js"),
                ("src/core/api/client/rpcClient.js", "./client/rpcClient.js"),
                ("src/core/api/client/rpcClient.js", "./rpcClient.js"),
                ("src/core/api/client/rpcClient.js", "../src/core/api/client/rpcClient.js"),
                ("src/core/api/client/pagination.js", "./client/pagination.js"),
                ("src/core/api/client/pagination.js", "./pagination.js"),
                ("src/core/api/client/pagination.js", "../src/core/api/client/pagination.js"),
                ("src/core/api/geminiClient.js", "../src/core/api/geminiClient.js"),
                ("src/core/api/geminiClient.js", "./src/core/api/geminiClient.js"),
                ("src/core/api/geminiClient.js", "./geminiClient.js"),
                ("utils.js", "../utils.js"),
                ("utils.js", "./utils.js"),
                ("src/core/constants.js", "../src/core/constants.js"),
                ("src/core/constants.js", "./constants.js"),
                ("src/core/tabService.js", "../src/core/tabService.js"),
                ("src/core/engine/writers/zipWriter.js", "../src/core/engine/writers/zipWriter.js"),
                ("src/core/engine/writers/fsWriter.js", "../src/core/engine/writers/fsWriter.js"),
                ("src/core/engine/writers/writerInterface.js", "../src/core/engine/writers/writerInterface.js"),
                ("src/core/engine/chatFormatter.js", "../src/core/engine/chatFormatter.js"),
                ("src/core/engine/takeout/zipBombGuard.js", "./takeout/zipBombGuard.js"),
                ("src/core/engine/takeout/zipBombGuard.js", "./zipBombGuard.js"),
                ("src/core/engine/takeout/zipBombGuard.js", "../src/core/engine/takeout/zipBombGuard.js"),
                ("src/core/engine/takeout/mediaIndex.js", "./takeout/mediaIndex.js"),
                ("src/core/engine/takeout/mediaIndex.js", "./mediaIndex.js"),
                ("src/core/engine/takeout/mediaIndex.js", "../src/core/engine/takeout/mediaIndex.js"),
                ("src/core/engine/takeout/takeoutHtmlParser.js", "./takeout/takeoutHtmlParser.js"),
                ("src/core/engine/takeout/takeoutHtmlParser.js", "./takeoutHtmlParser.js"),
                ("src/core/engine/takeout/takeoutHtmlParser.js", "../src/core/engine/takeout/takeoutHtmlParser.js"),
                ("src/core/engine/takeout/takeoutParser.js", "./takeout/takeoutParser.js"),
                ("src/core/engine/takeout/takeoutParser.js", "./takeoutParser.js"),
                ("src/core/engine/takeout/takeoutParser.js", "../src/core/engine/takeout/takeoutParser.js"),
                ("src/core/engine/takeoutEngine.js", "../src/core/engine/takeoutEngine.js"),
                ("src/core/engine/takeoutEngine.js", "./src/core/engine/takeoutEngine.js"),
                ("src/core/engine/takeoutEngine.js", "./takeoutEngine.js"),
                ("src/core/engine/export/progressReporter.js", "./export/progressReporter.js"),
                ("src/core/engine/export/progressReporter.js", "./progressReporter.js"),
                ("src/core/engine/export/progressReporter.js", "../src/core/engine/export/progressReporter.js"),
                ("src/core/engine/export/sessionRecovery.js", "./export/sessionRecovery.js"),
                ("src/core/engine/export/sessionRecovery.js", "./sessionRecovery.js"),
                ("src/core/engine/export/sessionRecovery.js", "../src/core/engine/export/sessionRecovery.js"),
                ("src/core/engine/export/batchWorker.js", "./export/batchWorker.js"),
                ("src/core/engine/export/batchWorker.js", "./batchWorker.js"),
                ("src/core/engine/export/batchWorker.js", "../src/core/engine/export/batchWorker.js"),
                ("src/core/engine/export/rateLimiter.js", "./export/rateLimiter.js"),
                ("src/core/engine/export/rateLimiter.js", "./rateLimiter.js"),
                ("src/core/engine/export/rateLimiter.js", "../src/core/engine/export/rateLimiter.js"),
                ("src/core/engine/export/exportOrchestrator.js", "./export/exportOrchestrator.js"),
                ("src/core/engine/export/exportOrchestrator.js", "./exportOrchestrator.js"),
                ("src/core/engine/export/exportOrchestrator.js", "../src/core/engine/export/exportOrchestrator.js"),
                ("src/core/engine/exportEngine.js", "../src/core/engine/exportEngine.js"),
                ("src/core/engine/exportEngine.js", "./src/core/engine/exportEngine.js"),
                ("src/core/engine/exportEngine.js", "./exportEngine.js"),
                ("src/core/exporter/zipWriter.js", "../src/core/exporter/zipWriter.js"),
                ("src/core/exporter/fsWriter.js", "../src/core/exporter/fsWriter.js"),
                ("src/ui/state/conversationsStore.js", "../src/ui/state/conversationsStore.js"),
                ("src/ui/views/listView.js", "../src/ui/views/listView.js"),
                ("src/ui/views/logView.js", "../src/ui/views/logView.js"),
                ("src/ui/views/accountView.js", "../src/ui/views/accountView.js"),
                ("src/ui/views/dialogView.js", "../src/ui/views/dialogView.js"),
                ("src/ui/controllers/dirHandleController.js", "../src/ui/controllers/dirHandleController.js"),
                ("src/ui/controllers/takeoutController.js", "../src/ui/controllers/takeoutController.js"),
                ("src/ui/controllers/syncController.js", "../src/ui/controllers/syncController.js"),
                ("src/ui/controllers/exportController.js", "../src/ui/controllers/exportController.js"),
                ("storage_service.js", "../storage_service.js"),
                ("chat_formatter.js", "../chat_formatter.js"),
                ("gemini_parser.js", "../gemini_parser.js"),
                ("takeout_engine.js", "../takeout_engine.js"),
                ("src/core/utils/locales/zh.js", "./locales/zh.js"),
                ("src/core/utils/locales/en.js", "./locales/en.js"),
                ("src/core/utils/locales/zh.js", "../src/core/utils/locales/zh.js"),
                ("src/core/utils/locales/en.js", "../src/core/utils/locales/en.js"),
                ("src/core/utils/i18n.js", "../src/core/utils/i18n.js"),
                ("src/core/utils/i18n.js", "./i18n.js"),
                ("i18n.js", "../i18n.js")
            ]:
                full_p = os.path.join(BASE_DIR, mod_path)
                if not os.path.exists(full_p):
                    if mod_path.startswith("src/"):
                        dp = os.path.join(BASE_DIR, "dist", mod_path[4:])
                        if os.path.exists(dp):
                            full_p = dp
                if not os.path.exists(full_p) and mod_path.endswith('.js'):
                    tsp = full_p[:-3] + '.ts'
                    if os.path.exists(tsp):
                        full_p = tsp
                if os.path.exists(full_p):
                    with open(full_p, "r", encoding="utf-8") as mf:
                        content = mf.read()
                    preload_js.append(
                        "(function() {\n"
                        "  const module = { exports: {} };\n"
                        "  const exports = module.exports;\n"
                        + content + "\n"
                        "  modules[" + json.dumps(mod_id) + "] = module.exports;\n"
                        "})();\n"
                    )

            full_script = harness + "\n".join(preload_js) + "\n" + test_code
            res = subprocess.run([jsc_bin, "-e", full_script], capture_output=True, text=True)
            assert res.returncode == 0, f"Unit test failed in {rel}:\n{res.stderr or res.stdout}"
            print(f"  ✓ Unit test suite passed: {rel}")

def test_content_badge_flicker_prevention():
    css_path = os.path.join(BASE_DIR, "src/content/content.css")
    with open(css_path, "r", encoding="utf-8") as f:
        css = f.read()
    assert "white-space: nowrap" in css, "content.css should prevent badge text wrapping"
    assert "min-width:" in css, "content.css should define min-width to avoid width jitter"
    assert ".syncing .pulse" in css, "content.css should only pulse when syncing"
    assert re.search(r'#geminiExportBadge\s+\.pulse\s*\{[^}]*background:\s*#06b6d4', css), "content.css idle pulse should define static background #06b6d4"

    content_ts = os.path.join(BASE_DIR, "src/content/content.ts")
    js_path = content_ts if os.path.isfile(content_ts) else os.path.join(BASE_DIR, "src/content/content.js")
    with open(js_path, "r", encoding="utf-8") as f:
        js = f.read()
    badge_ts = os.path.join(BASE_DIR, "src/content/badgeView.ts")
    badge_js_path = badge_ts if os.path.isfile(badge_ts) else os.path.join(BASE_DIR, "src/content/badgeView.js")
    badge_js = ""
    if os.path.exists(badge_js_path):
        with open(badge_js_path, "r", encoding="utf-8") as f:
            badge_js = f.read()
    combined_js = js + badge_js
    assert "debouncedSyncOnce" in js, "content.js should debounce syncOnce triggers"
    assert re.search(r'changed\s*===?\s*0', js), "content.js upsertConversations should skip writes when changed === 0"
    assert "textContent" in combined_js and "targetText" in combined_js, "badgeView/content.js updateBadge should guard textContent updates"
    assert "existing.isConnected" in combined_js or "isConnected" in combined_js, "badgeView/content.js ensureBadge should check isConnected"
    print("  ✓ Content badge flicker prevention verified")

def test_exported_history_and_slot_fallback():
    storage_ts = os.path.join(BASE_DIR, "src/core/storage/storageService.ts")
    storage_js = storage_ts if os.path.isfile(storage_ts) else os.path.join(BASE_DIR, "src/core/storage/storageService.js")
    with open(storage_js, "r", encoding="utf-8") as f:
        code = f.read()
    assert "gemini_exported_u0" in code and "exportedIds" in code, "storageService should merge legacy and global exportedIds"
    assert re.search(r"updates(\['exportedIds'\]|\.exportedIds)\s*=", code), "saveExportRecord should maintain global exportedIds"
    assert "gemini_conversations_u0" in code, "storageService should check gemini_conversations_u0"

    store_ts = os.path.join(BASE_DIR, "src/ui/state/conversationsStore.ts")
    store_js = store_ts if os.path.isfile(store_ts) else os.path.join(BASE_DIR, "src/ui/state/conversationsStore.js")
    with open(store_js, "r", encoding="utf-8") as f:
        store_code = f.read()
    assert re.search(r"for\s*\(\s*(?:const|let|var)?\s*\w+\s+of\s+candidates\s*\)", store_code) or "candidates" in store_code, "conversationsStore should smartly fall back to slot with conversations"
    print("  ✓ Exported history preservation & slot fallback verified")

def test_dataset_freshness_gate():
    import tempfile
    import time
    scripts_dir = os.path.join(BASE_DIR, "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from test_live_chat_and_export import validate_dataset_freshness

    # 1. No dataset without allow_stale -> should fail
    ok, res = validate_dataset_freshness(None, allow_stale=False)
    assert not ok and "未指定测试数据集" in res, "Missing dataset should be blocked by gate"

    # 2. Stale dataset without allow_stale -> should fail
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json") as f:
        f.write('[{"id":"test","title":"Test","turns":["Q1","A1"]}]')
        f_name = f.name
    try:
        os.utime(f_name, (time.time() - 300, time.time() - 300))
        ok, res = validate_dataset_freshness(f_name, allow_stale=False)
        assert not ok and "已超过 2 分钟" in res, "Stale dataset (>120s) should be blocked by gate"

        # 3. Stale dataset with allow_stale -> should pass
        ok, res = validate_dataset_freshness(f_name, allow_stale=True)
        assert ok and isinstance(res, list), "Stale dataset with allow_stale should pass"

        # 4. Fresh dataset without allow_stale -> should pass
        os.utime(f_name, (time.time(), time.time()))
        ok, res = validate_dataset_freshness(f_name, allow_stale=False)
        assert ok and isinstance(res, list), "Fresh dataset should pass without allow_stale"

        # 5. Default dataset with allow_stale -> should pass with None
        ok, res = validate_dataset_freshness(None, allow_stale=True)
        assert ok and res is None, "Default dataset with allow_stale should pass"

        # 6. Default dataset with skip_chat -> should pass with None
        ok, res = validate_dataset_freshness(None, allow_stale=False, skip_chat=True)
        assert ok and res is None, "Default dataset with skip_chat should pass"
    finally:
        if os.path.isfile(f_name):
            os.remove(f_name)

    print("  ✓ Dataset 2-minute freshness gate & bypass options verified")

def test_scenario_pool_pipeline():
    import tempfile
    scripts_dir = os.path.join(BASE_DIR, "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from manage_scenario_pool import validate_pool, get_pool_status, consume_scenarios, topup_scenarios, DEFAULT_POOL_PATH

    # 1. Validate the default 20-scenario pool
    ok, errs, status = validate_pool(DEFAULT_POOL_PATH, strict_count=True)
    assert ok, f"Scenario pool validation failed: {errs}"
    assert status["count"] == 20, f"Expected 20 scenarios, got {status['count']}"
    assert status["has_imagen"] >= 2, f"Expected >= 2 imagen scenarios, got {status['has_imagen']}"
    assert len(status["domains"]) >= 10, f"Expected >= 10 domains, got {len(status['domains'])}"

    # 2. Dry-run consume
    selected, pool_after = consume_scenarios(DEFAULT_POOL_PATH, count=2, dry_run=True, require_imagen=True)
    assert len(selected) == 2, "Dry-run consume should return 2 scenarios"
    assert any("imagen" in s.get("features", []) for s in selected), "One of the consumed scenarios must have 'imagen' feature"

    # 3. Temp file consume and topup round-trip
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json") as f_pool:
        json.dump(status["scenarios"][:], f_pool, ensure_ascii=False)
        pool_tmp = f_pool.name
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json") as f_arch:
        json.dump([], f_arch)
        arch_tmp = f_arch.name

    try:
        consumed, remaining = consume_scenarios(pool_tmp, count=2, archive_path=arch_tmp, dry_run=False, require_imagen=True)
        assert len(consumed) == 2
        assert len(remaining) == 18

        with open(arch_tmp, "r", encoding="utf-8") as f:
            arch_data = json.load(f)
        assert len(arch_data) == 2
        assert "consumed_at" in arch_data[0]

        # Top up with the consumed items back to 20
        added, restored_pool = topup_scenarios(consumed, pool_path=pool_tmp)
        assert len(added) == 2
        assert len(restored_pool) == 20
    finally:
        for p in [pool_tmp, arch_tmp]:
            if os.path.isfile(p):
                os.remove(p)

    print("  ✓ Scenario pool pipeline, 20-scenario diversity, consume, archive & top-up verified")

def test_tour_status_indicator_styling():
    # 1. Ensure options.html does not define unscoped .ok { ... }
    for html_file in ["src/ui/options/options.html"]:
        with open(os.path.join(BASE_DIR, html_file), "r", encoding="utf-8") as f:
            content = f.read()
        assert not re.search(r'(?<!button)\.ok\s*\{', content), f"Unscoped .ok rule found in {html_file}"

    # 2. Ensure tourGuide.css explicitly sets background: transparent and high-contrast color for ok/warn indicators
    tour_css_path = os.path.join(BASE_DIR, "src/ui/tour/tourGuide.css")
    with open(tour_css_path, "r", encoding="utf-8") as f:
        tour_css = f.read()
    assert ".tour-status-indicator.ok" in tour_css and ".tour-status-indicator.tour-status-ok" in tour_css, "tourGuide.css missing tour-status-ok"
    assert "background: transparent" in tour_css, "tourGuide.css must ensure status indicators have transparent background"
    assert "#34d399" in tour_css, "tourGuide.css should use crisp high-contrast emerald color (#34d399) for status ok"

    # 3. Ensure tourGuide.js uses tour-status-ok and tour-status-warn
    tour_ts = os.path.join(BASE_DIR, "src/ui/tour/tourGuide.ts")
    tour_js_path = tour_ts if os.path.isfile(tour_ts) else os.path.join(BASE_DIR, "src/ui/tour/tourGuide.js")
    with open(tour_js_path, "r", encoding="utf-8") as f:
        tour_js = f.read()
    assert "tour-status-indicator tour-status-ok" in tour_js, "tourGuide.js missing tour-status-ok class"
    assert "tour-status-indicator tour-status-warn" in tour_js, "tourGuide.js missing tour-status-warn class"

    print("  ✓ TourGuide status indicator styles and class scoping verified")

def test_takeout_limit_modal_and_wall_detection():
    # 1. Ensure src/ui/options/options.html contains takeoutLimitModal with required actions
    for html_file in ["src/ui/options/options.html"]:
        with open(os.path.join(BASE_DIR, html_file), "r", encoding="utf-8") as f:
            content = f.read()
        assert 'id="takeoutLimitModal"' in content, f"takeoutLimitModal missing in {html_file}"
        assert 'id="btnModalImportTakeout"' in content, f"btnModalImportTakeout missing in {html_file}"
        assert 'id="btnModalOpenTakeoutWeb"' in content, f"btnModalOpenTakeoutWeb missing in {html_file}"

    # 2. Ensure geminiClient.js and syncController.js recognize Google 500+ sliding window limit & 429 errors
    client_ts = os.path.join(BASE_DIR, "src/core/api/geminiClient.ts")
    client_path = client_ts if os.path.isfile(client_ts) else os.path.join(BASE_DIR, "src/core/api/geminiClient.js")
    with open(client_path, "r", encoding="utf-8") as f:
        client_code = f.read()
    assert re.search(r'all\.length\s*>=\s*500', client_code) or "hitGoogleLimit" in client_code, "geminiClient should flag hitGoogleLimit for full scans reaching 500+ chats"
    assert "429" in client_code, "geminiClient should detect 429 rate limit wall"

    sync_ts = os.path.join(BASE_DIR, "src/ui/controllers/syncController.ts")
    sync_path = sync_ts if os.path.isfile(sync_ts) else os.path.join(BASE_DIR, "src/ui/controllers/syncController.js")
    with open(sync_path, "r", encoding="utf-8") as f:
        sync_code = f.read()
    assert re.search(r'count\s*>=\s*500', sync_code) or "hitGoogleLimit" in sync_code, "syncController.js should treat full scan >= 500 as hitGoogleLimit"
    assert "429" in sync_code, "syncController.js should treat 429 as hitGoogleLimit"

    # 3. Ensure tabService.ts/js allocates at least 300000ms (5m) for deepScan
    tab_service_ts = os.path.join(BASE_DIR, "src/core/utils/tabService.ts")
    tab_service_path = tab_service_ts if os.path.isfile(tab_service_ts) else os.path.join(BASE_DIR, "src/core/utils/tabService.js")
    with open(tab_service_path, "r", encoding="utf-8") as f:
        tab_code = f.read()
    assert re.search(r'(300000|5\s*\*\s*60\s*\*\s*1000)', tab_code) and "deepScan" in tab_code, "tabService.js should allow at least 300000ms timeout for deepScan"

    # 4. Ensure options.js checks gemini_pending_takeout_prompt on store load
    options_ts = os.path.join(BASE_DIR, "src/ui/options/options.ts")
    options_js_path = options_ts if os.path.isfile(options_ts) else os.path.join(BASE_DIR, "src/ui/options/options.js")
    with open(options_js_path, "r", encoding="utf-8") as f:
        options_code = f.read()
    assert "gemini_pending_takeout_prompt" in options_code, "options.js should check gemini_pending_takeout_prompt"
    assert "checkPendingTakeoutPrompt" in options_code, "options.js should have checkPendingTakeoutPrompt"

    # 5. Ensure content.js records gemini_pending_takeout_prompt when limit hit
    content_ts = os.path.join(BASE_DIR, "src/content/content.ts")
    content_js_path = content_ts if os.path.isfile(content_ts) else os.path.join(BASE_DIR, "src/content/content.js")
    with open(content_js_path, "r", encoding="utf-8") as f:
        content_code = f.read()
    assert "gemini_pending_takeout_prompt" in content_code, "content.js should persist gemini_pending_takeout_prompt"

    # 6. Ensure single-time tutorial prompt behavior (isTakeoutPromptCompleted & has_completed_takeout_prompt)
    storage_ts = os.path.join(BASE_DIR, "src/core/storage/storageService.ts")
    storage_path = storage_ts if os.path.isfile(storage_ts) else os.path.join(BASE_DIR, "src/core/storage/storageService.js")
    with open(storage_path, "r", encoding="utf-8") as f:
        storage_code = f.read()
    assert "has_completed_takeout_prompt" in storage_code, "storageService should track has_completed_takeout_prompt"
    assert "isTakeoutPromptCompleted" in storage_code and "setTakeoutPromptCompleted" in storage_code, "storageService should export takeout prompt completion helpers"

    dialog_ts = os.path.join(BASE_DIR, "src/ui/views/dialogView.ts")
    dialog_js_path = dialog_ts if os.path.isfile(dialog_ts) else os.path.join(BASE_DIR, "src/ui/views/dialogView.js")
    with open(dialog_js_path, "r", encoding="utf-8") as f:
        dialog_code = f.read()
    assert "isTakeoutPromptCompleted" in dialog_code and "setTakeoutPromptCompleted" in dialog_code, "dialogView.js should guard and mark takeout prompt completed"

    assert "isTakeoutPromptCompleted" in options_code, "options.js should check isTakeoutPromptCompleted"

    print("  ✓ Takeout limit modal & Google sliding window wall detection verified")

def test_stage1_architecture_ssot_and_state_isolation():
    # 1. Verify per-slot aborts in background.ts/js (or modular src/background/)
    bg_dir = os.path.join(BASE_DIR, "src/background")
    if os.path.isdir(bg_dir):
        bg_code = ""
        for bf_name in sorted(os.listdir(bg_dir)):
            if bf_name.endswith(".ts") or bf_name.endswith(".js"):
                with open(os.path.join(bg_dir, bf_name), "r", encoding="utf-8") as bf:
                    bg_code += bf.read() + "\n"
    else:
        bg_ts = os.path.join(BASE_DIR, "src/background/background.ts")
        bg_js_path = bg_ts if os.path.isfile(bg_ts) else os.path.join(BASE_DIR, "src/background/background.js")
        with open(bg_js_path, "r", encoding="utf-8") as f:
            bg_code = f.read()
    assert "__bgAborts" in bg_code and "Map" in bg_code, "background.js must isolate abort flags per account slot using Map"
    assert not re.search(r'let\s+__bgAborted\s*=\s*(?:false|true);', bg_code), "background.js must not contain mutable global __bgAborted"
    assert "isSlotAborted" in bg_code and "setSlotAborted" in bg_code, "background.js must provide slot-aware abort helpers"

    # 2. Verify per-slot Takeout cache in takeoutEngine
    takeout_ts = os.path.join(BASE_DIR, "src/core/engine/takeoutEngine.ts")
    takeout_path = takeout_ts if os.path.isfile(takeout_ts) else os.path.join(BASE_DIR, "src/core/engine/takeoutEngine.js")
    with open(takeout_path, "r", encoding="utf-8") as f:
        takeout_code = f.read()
    assert "__slotTakeouts" in takeout_code and "Map" in takeout_code, "takeoutEngine must isolate takeout dictionaries per account slot"
    assert "getStore" in takeout_code, "takeoutEngine must route through getStore(slot)"

    # 3. Verify SSoT compareConversations in content.js and options.js
    content_ts = os.path.join(BASE_DIR, "src/content/content.ts")
    content_js_path = content_ts if os.path.isfile(content_ts) else os.path.join(BASE_DIR, "src/content/content.js")
    with open(content_js_path, "r", encoding="utf-8") as f:
        content_code = f.read()
    assert "compareConversations" in content_code, "content.js upsertConversations must use compareConversations SSoT"

    options_ts = os.path.join(BASE_DIR, "src/ui/options/options.ts")
    options_js_path = options_ts if os.path.isfile(options_ts) else os.path.join(BASE_DIR, "src/ui/options/options.js")
    with open(options_js_path, "r", encoding="utf-8") as f:
        options_code = f.read()
    assert "compareConversations" in options_code, "options.js loadStore must use compareConversations SSoT"

    # 4. Verify SSoT sanitizeFileName and cleanTitle delegation in exportEngine
    export_ts = os.path.join(BASE_DIR, "src/core/engine/exportEngine.ts")
    export_path = export_ts if os.path.isfile(export_ts) else os.path.join(BASE_DIR, "src/core/engine/exportEngine.js")
    with open(export_path, "r", encoding="utf-8") as f:
        export_code = f.read()
    assert "sanitizeFileName" in export_code, "exportEngine sanitizeFileName must delegate to GeminiUtils SSoT"

    print("  ✓ Stage 1 Architecture: SSoT consolidation and per-slot state isolation verified")

def test_stage2_architecture_improvements():
    # 1. Verify sanitizeRelativePath in utils, zipWriter, fsWriter, and exportEngine
    utils_ts = os.path.join(BASE_DIR, "src/core/utils/utils.ts")
    utils_path = utils_ts if os.path.isfile(utils_ts) else os.path.join(BASE_DIR, "src/core/utils/utils.js")
    with open(utils_path, "r", encoding="utf-8") as f:
        utils_code = f.read()
    assert "sanitizeRelativePath" in utils_code, "utils must implement and export sanitizeRelativePath"

    zip_writer_ts = os.path.join(BASE_DIR, "src/core/engine/writers/zipWriter.ts")
    zip_writer_path = zip_writer_ts if os.path.isfile(zip_writer_ts) else os.path.join(BASE_DIR, "src/core/engine/writers/zipWriter.js")
    with open(zip_writer_path, "r", encoding="utf-8") as f:
        zip_code = f.read()
    assert "sanitizeRelativePath" in zip_code or "sanitizePath" in zip_code, "zipWriter must use sanitizeRelativePath"

    fs_writer_ts = os.path.join(BASE_DIR, "src/core/engine/writers/fsWriter.ts")
    fs_writer_path = fs_writer_ts if os.path.isfile(fs_writer_ts) else os.path.join(BASE_DIR, "src/core/engine/writers/fsWriter.js")
    with open(fs_writer_path, "r", encoding="utf-8") as f:
        fs_code = f.read()
    assert "sanitizeRelativePath" in fs_code, "fsWriter must use sanitizeRelativePath"
    assert "ensureSubDir" in fs_code and "writeFile" in fs_code, "fsWriter must support flexible path writing"

    # 2. Verify export orchestrator AsyncQueue and elimination of busy-polling
    export_ts = os.path.join(BASE_DIR, "src/core/engine/export/exportOrchestrator.ts")
    if not os.path.isfile(export_ts):
        export_ts = os.path.join(BASE_DIR, "src/core/engine/exportEngine.ts")
    export_path = export_ts if os.path.isfile(export_ts) else os.path.join(BASE_DIR, "src/core/engine/exportEngine.js")
    with open(export_path, "r", encoding="utf-8") as f:
        export_code = f.read()
    assert "AsyncQueue" in export_code, "exportEngine must implement event-driven AsyncQueue"
    assert not re.search(r'setTimeout\s*\(\s*\w+\s*,\s*100\s*\)', export_code), "exportEngine must not use busy-polling setTimeout(r, 100)"
    assert "attachmentQueue" in export_code, "exportEngine must properly manage attachmentQueue"
    assert "writeFileDirect" in export_code, "exportEngine must have writeFileDirect"

    # 3. Verify hookCredentials.js error sandboxing
    hook_ts = os.path.join(BASE_DIR, "src/content/hookCredentials.ts")
    hook_path = hook_ts if os.path.isfile(hook_ts) else os.path.join(BASE_DIR, "src/content/hookCredentials.js")
    with open(hook_path, "r", encoding="utf-8") as f:
        hook_code = f.read()
    assert "origFetch" in hook_code, "hookCredentials.js must guard origFetch"
    assert "origOpen" in hook_code and "origSend" in hook_code, "hookCredentials.js must guard origOpen and origSend"
    assert "RegExp.$1" not in hook_code, "hookCredentials.js must not use deprecated RegExp.$1"

    # 4. Verify geminiClient.js dynamic credential refresh on HTTP 400
    client_ts = os.path.join(BASE_DIR, "src/core/api/geminiClient.ts")
    client_path = client_ts if os.path.isfile(client_ts) else os.path.join(BASE_DIR, "src/core/api/geminiClient.js")
    with open(client_path, "r", encoding="utf-8") as f:
        client_code = f.read()
    assert "cachedCredentials" not in client_code, "geminiClient must not reference undefined cachedCredentials"
    assert "_retried" in client_code, "geminiClient must support automatic retry on 400 with fresh credentials"
    assert re.search(r'async\s+function\s+resolveCred\s*\(', client_code) or "resolveCred" in client_code, "geminiClient resolveCred must accept credential overrides"

    # 5. Verify background.ts/js MV3 keepalive
    bg_ts = os.path.join(BASE_DIR, "src/background/background.ts")
    bg_path = bg_ts if os.path.isfile(bg_ts) else os.path.join(BASE_DIR, "src/background/background.js")
    with open(bg_path, "r", encoding="utf-8") as f:
        bg_code = f.read()
    assert re.search(r'function\s+startKeepAlive\s*\(', bg_code) or "startKeepAlive" in bg_code, "background.js must implement startKeepAlive"
    assert "stopKeepAlive" in bg_code, "background.js must invoke and clean up keepalive in long-running jobs"

    print("  ✓ Stage 2 Architecture: Pipeline decoupling, event-driven AsyncQueue, and path sanitization verified")

test_json_files()
test_manifest_structure()
test_build_pipeline()
test_html_includes()
test_i18n_keys()
test_content_badge_flicker_prevention()
test_exported_history_and_slot_fallback()
test_dataset_freshness_gate()
test_scenario_pool_pipeline()
test_tour_status_indicator_styling()
test_takeout_limit_modal_and_wall_detection()
test_stage1_architecture_ssot_and_state_isolation()
test_stage2_architecture_improvements()
test_javascript_syntax()
test_javascript_unit_tests()

print("=" * 60)
print("🎉 ALL TESTS PASSED SUCCESSFULLY!")
print("=" * 60)


