#!/usr/bin/env python3
"""
tests/helpers/export_spec_asserter.py
--------------------------------------
严格的导出文件规范断言器 (Export Specification Asserter)

用于对真实导出的 Markdown 归档包执行规范级 Lint 与确定性内容断言：
1. 目录结构与索引完整性 (00_INDEX.md, meta.json, 文件命名规范)
2. YAML Frontmatter 规范 (字段闭合、标准键、ISO 8601 时间戳、Tags)
3. 问答轮次与角色规范 (## 👤 You / ## 🤖 Assistant、正文非空)
4. 纯净度与零噪点断言 (无 Google JSPB 遥测单字、无语言代码泄露、无未处理 RPC 壳)
5. 附件与多媒体一致性 (Markdown 引用的 images/ 物理存在且体积合法)
6. 固化测试账号的已知黄金对话特征断言 (代码块、表格、特定语义)
"""

import os
import re
import json
import hashlib

# Support direct CLI execution as well as framework imports.
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from scripts.framework.archive_resources import find_archive_resource, validate_archive_resources


class ExportSpecificationAsserter:
    def __init__(self, export_root_dir):
        self.export_root_dir = export_root_dir
        self.errors = []
        self.warnings = []
        self.md_files = []
        self.meta_data = None
        self.index_text = ""

    def log_error(self, file_name, msg):
        err = f"[{file_name}] ❌ 规范违背: {msg}"
        self.errors.append(err)
        print(f"   {err}")

    def log_pass(self, file_name, msg):
        print(f"   [{file_name}] ✓ {msg}")

    def run_all_assertions(self, min_conversations=1, expected_golden_chats=None, target_chat_id=None, uploaded_files=None):
        """执行全量规范级断言"""
        print("\n" + "=" * 70)
        print("🔍 启动导出规范确定性断言 (Export Specification Assertion)...")
        print("=" * 70)

        # 1. 结构与元数据校验
        self.assert_bundle_structure(min_conversations)

        # 2. 深入每个导出的会话文件校验规范
        for fpath in self.md_files:
            fname = os.path.basename(fpath)
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()

            self.assert_frontmatter(content, fname)
            self.assert_turn_flow(content, fname)
            self.assert_zero_noise(content, fname)
            self.assert_multimedia_assets(content, os.path.relpath(fpath, self.export_root_dir).replace(os.sep, "/"))

        # 3. 指定目标会话存在性核验 (针对单篇或指定会话导出)
        if target_chat_id:
            self.assert_target_conversation(target_chat_id)

        # 4. 固化已知黄金会话特征断言 (针对全量历史回归)
        if expected_golden_chats:
            self.assert_golden_conversations(expected_golden_chats)

        # 5. 现场动态上传的测试文件附件严格断言 (多格式、SHA256、正文链接)
        if uploaded_files:
            self.assert_uploaded_test_files(uploaded_files)

        # 总结
        print("\n" + "=" * 70)
        if not self.errors:
            print(f"🏆 全部 {len(self.md_files)} 个会话文件与索引规范断言 100% 完美通过！")
            print("=" * 70)
            return True
        else:
            print(f"❌ 发现 {len(self.errors)} 处规范违背错误：")
            for e in self.errors:
                print(f"  • {e}")
            print("=" * 70)
            return False

    def assert_bundle_structure(self, min_conversations):
        """检查包内顶级结构与元数据"""
        print("\n[规范 1/5] 📦 校验导出包结构与索引 (Bundle Structure & Index)")

        # 递归寻找 Markdown 目录（有的在根目录，有的在 gemini_export/ 子目录）
        all_mds = []
        index_file = None
        meta_file = None

        for root, _, files in os.walk(self.export_root_dir):
            rel_root = os.path.relpath(root, self.export_root_dir)
            parts = [p.lower() for p in rel_root.replace("\\", "/").split("/")]
            if "files" in parts or "assets" in parts:
                continue
            for f in files:
                fpath = os.path.join(root, f)
                if f.endswith(".md"):
                    if f.startswith("00_INDEX") or f.startswith("_index"):
                        index_file = fpath
                    else:
                        all_mds.append(fpath)
                elif f == "meta.json":
                    meta_file = fpath

        self.md_files = sorted(all_mds)

        # 检查会话数量
        if len(self.md_files) < min_conversations:
            self.log_error("Bundle", f"导出的会话文件数不足 {min_conversations} 个 (实际找到 {len(self.md_files)})")
        else:
            self.log_pass("Bundle", f"发现 {len(self.md_files)} 个导出会话 Markdown 文件 (符合预期 >= {min_conversations})")

        # 检查 00_INDEX.md (已移除，若存在则校验有效性，不存在则符合纯净导出预期)
        if index_file:
            with open(index_file, "r", encoding="utf-8") as f:
                self.index_text = f.read()
            if "# " not in self.index_text or "| " not in self.index_text:
                self.log_error("00_INDEX.md", "索引文件缺少标题或 Markdown 对话表格列表")
            else:
                self.log_pass("00_INDEX.md", "全局索引文档有效，包含 Markdown 对话索引表")
        else:
            self.log_pass("00_INDEX.md", "纯净无冗余索引导出 (无额外 00_INDEX.md 干扰)")

        # 检查 meta.json (已移除，若存在则校验合法性)
        if meta_file:
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    self.meta_data = json.load(f)
                if not isinstance(self.meta_data, dict):
                    self.log_error("meta.json", "meta.json 不是合法的 JSON Object")
                else:
                    self.log_pass("meta.json", f"元数据合法 (导出会话数: {len(self.meta_data.get('conversations', []))})")
            except Exception as e:
                self.log_error("meta.json", f"meta.json 解析失败: {e}")

        # 检查是否包含 URL 畸变或长 URL 命名的文件 (files/*_https___... 或包含 URL 参数特征)
        malformed_files = []
        for root, _, files in os.walk(self.export_root_dir):
            for f in files:
                if "_https___" in f or "http___" in f or "download_c=" in f or "usercontent.google" in f:
                    malformed_files.append(f)
        if malformed_files:
            self.log_error("Bundle", f"发现因 URL 伪装文件名导致的严重畸变文件: {malformed_files}")
        else:
            self.log_pass("Bundle", "文件命名纯净度校验通过 (0 个 URL 畸变残留文件)")

    def assert_frontmatter(self, content, file_name):
        """校验 YAML Frontmatter 规范 (严格解析键值对非空与格式)"""
        if not content.startswith("---\n"):
            self.log_error(file_name, "文件头部必须以 YAML Frontmatter 开头 ('---\\n')")
            return

        end_match = re.search(r"\n---\n", content[4:])
        if not end_match:
            self.log_error(file_name, "YAML Frontmatter 缺少闭合标记 ('\\n---\\n')")
            return

        fm_text = content[4:4 + end_match.start()]
        
        # 逐行解析顶级键值对
        fields = {}
        for line in fm_text.splitlines():
            line_str = line.strip()
            if not line_str or line_str.startswith("#"):
                continue
            if ":" in line_str:
                k, v = line_str.split(":", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k not in fields:
                    fields[k] = v

        required_keys = ["title", "id", "provider", "exported", "tags"]
        for key in required_keys:
            if key not in fields and f"{key}:" not in fm_text:
                self.log_error(file_name, f"Frontmatter 缺少必要字段 '{key}'")
            elif key in ["title", "id", "provider", "exported"]:
                val = fields.get(key, "")
                if not val:
                    self.log_error(file_name, f"Frontmatter 字段 '{key}' 值为空非法")

        # 检查 exported 格式 (ISO 8601)
        exported_val = fields.get("exported", "")
        if exported_val and not re.match(r"^\d{4}-\d{2}-\d{2}", exported_val):
            self.log_error(file_name, f"Frontmatter 'exported' 字段格式非法 (非 ISO 8601): {exported_val}")

        # 当可选字段存在时校验其格式
        if "url" in fields:
            url_val = fields["url"]
            if not url_val or not (url_val.startswith("http://") or url_val.startswith("https://")):
                self.log_error(file_name, f"Frontmatter 'url' 字段格式非法: {url_val}")

        if "date" in fields:
            date_val = fields["date"]
            if not date_val or not re.match(r"^\d{4}-\d{2}-\d{2}", date_val):
                self.log_error(file_name, f"Frontmatter 'date' 字段格式非法 (非 ISO 8601): {date_val}")

        if "updated" in fields:
            updated_val = fields["updated"]
            if not updated_val or not re.match(r"^\d{4}-\d{2}-\d{2}", updated_val):
                self.log_error(file_name, f"Frontmatter 'updated' 字段格式非法 (非 ISO 8601): {updated_val}")

        if "gemini-export" not in fm_text:
            self.log_error(file_name, "Frontmatter tags 必须包含 'gemini-export'")

    def assert_turn_flow(self, content, file_name, min_turns: int = 1):
        """校验问答轮次、角色交替与等量匹配"""
        # 提取所有角色标头及其出现位置
        headers = []
        for m in re.finditer(r"^## 👤 You", content, flags=re.MULTILINE):
            headers.append((m.start(), "user"))
        for m in re.finditer(r"^## 🤖 Assistant", content, flags=re.MULTILINE):
            headers.append((m.start(), "model"))

        headers.sort(key=lambda x: x[0])

        if not headers:
            self.log_error(file_name, "正文中未找到任何用户或模型角色标头")
            return

        user_count = sum(1 for h in headers if h[1] == "user")
        model_count = sum(1 for h in headers if h[1] == "model")

        if user_count < min_turns:
            self.log_error(file_name, f"用户提问轮次不足: {user_count} < 预期最小 {min_turns}")
        if model_count < user_count:
            self.log_error(file_name, f"模型回复轮次不足: 模型回复 {model_count} < 用户提问 {user_count}")

        # 检查轮次是否严格交替出现 (User -> Model -> User -> Model)
        for i in range(len(headers) - 1):
            if headers[i][1] == headers[i+1][1]:
                self.log_error(file_name, f"第 {i+1} 处角色标头未交替出现: 连续两个 '{headers[i][1]}' 角色标头")

    def assert_zero_noise(self, content, file_name):
        """纯净度断言：绝不包含 Google JSPB 遥测单字符、遥测短词、语言标签泄露"""
        # 1. 检查是否有独立的遥测单词行（如单独一行的 "google", "c", "S", "6", "."）
        telemetry_lines = re.findall(r"^(?:google|c|S|6|\.)\s*$", content, flags=re.MULTILINE)
        if telemetry_lines:
            self.log_error(file_name, f"检测到泄露的 Google JSPB 遥测单行: {telemetry_lines}")

        # 2. 检查末尾泄露的语言标记（如回复结尾单独一行 zh 或 en）
        lang_leaks = re.findall(r"\n(?:zh|en)\s*\n(?=## 👤|## 🤖|$)", content)
        if lang_leaks:
            self.log_error(file_name, f"检测到泄露的语言代码标记: {lang_leaks}")

        # 3. 检查未反序列化的 Google RPC 壳或包装前缀
        if ")]}'" in content:
            self.log_error(file_name, "检测到未剥除的 Google RPC 前缀 ')]}\\''")
        if '["wrb.fr"' in content or '"hNvQHb"' in content or '"MaZiqc"' in content:
            self.log_error(file_name, "检测到泄露的原始 batchexecute RPC 包装数组")

    def _document_archive_path(self, document):
        if os.path.isabs(document):
            return os.path.relpath(document, self.export_root_dir).replace(os.sep, '/')
        # Legacy golden checks pass display filenames; resolve the document only.
        matches = [p for p in self.md_files if os.path.basename(p) == document]
        if len(matches) == 1:
            return os.path.relpath(matches[0], self.export_root_dir).replace(os.sep, '/')
        return document.replace(os.sep, '/')

    def _find_physical_file(self, reference, document):
        try:
            return find_archive_resource(self.export_root_dir, self._document_archive_path(document), reference)
        except ValueError:
            return None

    def assert_multimedia_assets(self, content, file_name):
        """Validate every rendered local Markdown image and attachment reference."""
        for error in validate_archive_resources(
            self.export_root_dir, self._document_archive_path(file_name), content,
        ):
            self.log_error(file_name, f"归档资源引用无效: {error}")

    def assert_multi_turn_uploads(self, matched_file, content, expected_count):
        """断言多轮用户上传：独立图片存在、MD5 互不相同（无覆盖）、角色归属正确（非 AI 生图）"""
        print(f"   [{matched_file}] 📸 深度断言：多轮用户上传与物理去重 (预期至少 {expected_count} 张)...")
        parts = re.split(r'^(## 👤 You|## 🤖 Assistant)', content, flags=re.MULTILINE)
        user_blocks = []
        model_blocks = []
        for i in range(1, len(parts), 2):
            role = parts[i]
            body = parts[i+1] if i+1 < len(parts) else ""
            if "👤" in role:
                user_blocks.append(body)
            elif "🤖" in role:
                model_blocks.append(body)

        # 1. 提取用户轮次中的图片引用
        user_img_refs = []
        for ub in user_blocks:
            refs = re.findall(r'!\[[^\]]*\]\(([^)]+)\)', ub)
            for r in refs:
                if not r.startswith("http://") and not r.startswith("https://"):
                    clean = r.split("?")[0].split("#")[0]
                    user_img_refs.append(clean)

        if len(user_img_refs) < expected_count:
            self.log_error(matched_file, f"多轮用户上传图片引用数不足: 找到 {len(user_img_refs)} 张，预期至少 {expected_count} 张")
            return

        # 2. 检查每张图片的物理存在并计算 MD5
        md5_map = {}
        for ref in user_img_refs:
            fpath = self._find_physical_file(ref, matched_file)
            if not fpath or not os.path.isfile(fpath):
                self.log_error(matched_file, f"用户上传图片物理文件缺失: {ref}")
                continue
            try:
                with open(fpath, "rb") as f:
                    bin_data = f.read()
                f_md5 = hashlib.md5(bin_data).hexdigest()
                md5_map[fpath] = (f_md5, len(bin_data))
            except Exception as e:
                self.log_error(matched_file, f"读取图片文件失败: {fpath} ({e})")

        # 3. MD5 唯一性断言：绝对不能存在相同 MD5（杜绝同名覆盖或 Takeout 检索首图覆盖 Bug）
        all_md5s = [info[0] for info in md5_map.values()]
        unique_md5s = set(all_md5s)
        if len(unique_md5s) < len(all_md5s):
            dup_md5s = [m for m in all_md5s if all_md5s.count(m) > 1]
            self.log_error(matched_file, f"多轮用户上传图片出现严重 MD5 重复碰撞，资源被同一张图覆盖！重复 MD5: {set(dup_md5s)}")
        else:
            self.log_pass(matched_file, f"多轮用户上传图片物理 MD5 100% 互不相同，零碰撞覆盖 (共 {len(unique_md5s)} 张不同原图: {list(unique_md5s)[:3]}...)")

        # 4. 角色归属断言：模型回复中绝对不能包含 ![Generated Image] 指向用户图片
        for mb in model_blocks:
            gen_img_refs = re.findall(r'!\[(?:Generated Image|生成图片)\]\(([^)]+)\)', mb, flags=re.IGNORECASE)
            for gr in gen_img_refs:
                clean_gr = os.path.basename(gr.split("?")[0].split("#")[0])
                for ur in user_img_refs:
                    if os.path.basename(ur) == clean_gr:
                        self.log_error(matched_file, f"用户上传图片 {clean_gr} 被错误注入为模型生成的 ![Generated Image]！")

    def assert_deep_research_documents(self, matched_file, content, cid, min_docs=1):
        """断言 Deep Research 深度研究报告：files/ 目录存在、文档存在且非空、正文引用"""
        print(f"   [{matched_file}] 📑 深度断言：AI Deep Research 深度研究生成文档 (预期至少 {min_docs} 篇)...")
        short_scope = cid[-6:] if cid and len(cid) >= 6 else (cid or "")

        # 检查 files/ 目录
        all_doc_files = []
        for root, _, files in os.walk(self.export_root_dir):
            if os.path.basename(root) == "files" or "/files" in root or "\\files" in root:
                for f in files:
                    if f.endswith(".md"):
                        all_doc_files.append(os.path.join(root, f))

        matching_docs = []
        for df in all_doc_files:
            fname = os.path.basename(df)
            if (short_scope and short_scope in fname) or (cid and cid in fname):
                matching_docs.append(df)

        if len(matching_docs) < min_docs:
            self.log_error(matched_file, f"Deep Research 生成文档数不足: 找到 {len(matching_docs)} 篇 (全包共 {len(all_doc_files)} 篇)，预期至少 {min_docs} 篇 (shortScope: {short_scope})")
            return

        for df in matching_docs:
            fsize = os.path.getsize(df)
            fname = os.path.basename(df)
            if fsize < 100:
                self.log_error(fname, f"Deep Research 生成文档体积过小 ({fsize} bytes)，疑似空文件或损坏")
            else:
                with open(df, "r", encoding="utf-8", errors="ignore") as f:
                    doc_text = f.read()
                if "# " not in doc_text:
                    self.log_error(fname, "Deep Research 生成文档缺少顶级一级标题 ('# ')")
                else:
                    self.log_pass(fname, f"Deep Research 独立报告完整有效 ({fsize} bytes)")

        self.log_pass(matched_file, f"Deep Research 文档归档通过，已生成 {len(matching_docs)} 篇完整研究报告")

    def assert_ai_generated_images(self, matched_file, content, min_images=1):
        """断言 AI 生成图片 (Imagen)：模型回复中引用、本地图片物理存在且合法"""
        print(f"   [{matched_file}] 🎨 深度断言：AI 生成图片 (Imagen)...")
        parts = re.split(r'^(## 👤 You|## 🤖 Assistant)', content, flags=re.MULTILINE)
        model_blocks = []
        for i in range(1, len(parts), 2):
            role = parts[i]
            body = parts[i+1] if i+1 < len(parts) else ""
            if "🤖" in role:
                model_blocks.append(body)

        model_img_refs = []
        for mb in model_blocks:
            refs = re.findall(r'!\[[^\]]*\]\(([^)]+)\)', mb)
            for r in refs:
                if not r.startswith("http://") and not r.startswith("https://"):
                    model_img_refs.append(r.split("?")[0].split("#")[0])

        if len(model_img_refs) < min_images:
            self.log_error(matched_file, f"模型回复中未找到 AI 生成图片引用 (找到 {len(model_img_refs)}，预期至少 {min_images})")
            return

        for ref in model_img_refs:
            fpath = self._find_physical_file(ref, matched_file)
            if not fpath or not os.path.isfile(fpath):
                self.log_error(matched_file, f"AI 生成图片物理文件缺失: {ref}")
            else:
                fsize = os.path.getsize(fpath)
                if fsize < 1000:
                    self.log_error(matched_file, f"AI 生成图片文件过小 ({fsize} bytes): {ref}")
                else:
                    self.log_pass(matched_file, f"AI 生成图片物理落地完整 ({os.path.basename(fpath)}, {fsize} bytes)")

    def assert_target_conversation(self, target_chat_id: str):
        """断言指定的会话 ID 在导出包中物理存在且对应文件已通过基础规范校验"""
        print(f"\n[目标会话断言] 🎯 校验指定目标会话存在性 (Chat ID: {target_chat_id})")
        raw_cid = str(target_chat_id).strip()
        clean_cid = raw_cid[2:] if raw_cid.startswith("c_") else raw_cid

        matched_file = None
        for fpath in self.md_files:
            fname = os.path.basename(fpath)
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()

            if (clean_cid in fname or 
                raw_cid in fname or
                f'id: "{clean_cid}"' in content or 
                f'id: "{raw_cid}"' in content or 
                f"id: '{clean_cid}'" in content or 
                f"id: '{raw_cid}'" in content or 
                f"id: {clean_cid}" in content or 
                f"id: {raw_cid}" in content or 
                f"/app/{clean_cid}" in content):
                matched_file = fname
                break

        if not matched_file:
            self.log_error("TargetChat", f"未在导出包中找到指定目标会话 (Chat ID: {target_chat_id}) 对应的 Markdown 文件")
            return None

        self.log_pass(matched_file, f"指定目标会话成功命中物理文件: {matched_file}")
        return matched_file

    def assert_golden_conversations(self, expected_golden_chats):
        """断言测试账号中已知特征对话的内容和结构"""
        print("\n[规范 5/5] 🌟 校验已知测试账号会话特征 (Golden Conversations)")
        for gold in expected_golden_chats:
            cid = gold.get("id")
            name = gold.get("name", cid)
            snippets = gold.get("expected_snippets", [])
            syntax_checks = gold.get("syntax_checks", [])

            matched_content = None
            matched_file = None

            # 1. 优先按 cid 精准检索（检查正文内容或文件名是否包含会话 ID）
            if cid:
                for fpath in self.md_files:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        text = f.read()
                    if cid in text or cid in os.path.basename(fpath):
                        matched_content = text
                        matched_file = os.path.basename(fpath)
                        break
                if not matched_content:
                    self.log_error("GoldenCheck", f"未在导出包中找到已知会话《{name}》 (ID: {cid})")
                    continue

            # 2. 仅在未指定 cid 时，按 snippets 全量匹配特征
            elif snippets:
                for fpath in self.md_files:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        text = f.read()
                    if all(snip.lower() in text.lower() for snip in snippets):
                        matched_content = text
                        matched_file = os.path.basename(fpath)
                        break
                if not matched_content:
                    self.log_error("GoldenCheck", f"未在导出包中找到符合特征内容的会话《{name}》")
                    continue

            # 校验特定文本片段
            for snip in snippets:
                if snip.lower() not in matched_content.lower():
                    self.log_error(matched_file, f"已知会话《{name}》缺失预期关键内容: 「{snip}」")
                else:
                    self.log_pass(matched_file, f"已知会话《{name}》成功命中特征内容: 「{snip[:30]}...」")

            # 校验特定语法结构（如代码块、表格）
            for syn in syntax_checks:
                if syn == "codeblock" and "```" not in matched_content:
                    self.log_error(matched_file, f"已知会话《{name}》预期包含代码块 ('```')，但未找到")
                elif syn == "table":
                    has_table = bool(re.search(r'\|\s*:?-{3,}:?\s*\|', matched_content) or "|---" in matched_content or "| ---" in matched_content)
                    if not has_table:
                        self.log_error(matched_file, f"已知会话《{name}》预期包含 Markdown 表格，但未找到")
                elif syn == "image" and "![" not in matched_content:
                    self.log_error(matched_file, f"已知会话《{name}》预期包含图片附件引用 ('![]')，但未找到")

            # 校验多轮用户上传与 MD5 去重
            exp_upload_imgs = gold.get("expected_upload_images")
            if exp_upload_imgs:
                self.assert_multi_turn_uploads(matched_file, matched_content, exp_upload_imgs)

            # 校验 Deep Research 生成文档
            exp_research_docs = gold.get("expected_research_docs")
            if exp_research_docs:
                self.assert_deep_research_documents(matched_file, matched_content, cid, exp_research_docs)

            # 校验 AI 生成图片 (Imagen)
            exp_gen_imgs = gold.get("expected_generated_images")
            if exp_gen_imgs:
                self.assert_ai_generated_images(matched_file, matched_content, exp_gen_imgs)

            # 校验用户文件附件 (如 architecture.md, test_config.json 等)
            exp_file_attachments = gold.get("expected_file_attachments")
            if exp_file_attachments:
                self.assert_user_file_attachments(matched_file, matched_content, exp_file_attachments)

    @staticmethod
    def has_attachment_link(content: str, target_name: str) -> bool:
        """检查 Markdown 正文中是否包含对附件文件的合规引用链接。
        
        Canonical Markdown 规范链接格式形如:
        `[test\_config.json](assets/files/cb8bd7_test_config.json)`
        `[gemini\_test\_1790746358\_8b68bd61.custom](assets/files/1201ab_gemini_test_1790746358_8b68bd61.custom)`
        
        解析规则：
        1. 优先提取所有非图片 Markdown 超链接 [label](target)，解析链接目标 target 并进行 URL 解码；
        2. 比对 target 的文件名 (basename)：若与 target_name 完全一致、以 _<target_name> 结尾、或包含 target_name；
        3. 同时比对反转义后的 Markdown 标签 (label)：支持诸如 test\_config.json 等转义标签，
           若其反转义后与 target_name 匹配，且链接目标位于本地归档目录 (assets/files/ 或 files/)，亦判定合规。
        """
        import urllib.parse
        target_clean = target_name.strip()
        if not target_clean:
            return False

        link_matches = re.findall(r'(?<!!)\[([^\]]+)\]\(([^)]+)\)', content)
        for label, dest in link_matches:
            dest_clean = urllib.parse.unquote(dest.split('?')[0].split('#')[0].strip())
            dest_base = os.path.basename(dest_clean)

            # 1. 优先通过链接目标 target 的 basename 进行比对
            if dest_base == target_clean or dest_base.endswith(f"_{target_clean}") or target_clean in dest_base:
                return True

            # 2. 对 label 进行 Markdown 常用转义字符还原
            unescaped_label = (
                label.replace(r'\_', '_')
                     .replace(r'\*', '*')
                     .replace(r'\[', '[')
                     .replace(r'\]', ']')
                     .replace(r'\#', '#')
                     .replace(r'\`', '`')
                     .replace(r'\\', '\\')
            ).strip()

            if unescaped_label == target_clean or target_clean in unescaped_label:
                dest_parts = dest_clean.replace('\\', '/').split('/')
                if any(p in dest_parts for p in ('files', 'assets')):
                    return True

        return False

    def assert_user_file_attachments(self, matched_file, content, expected_files):
        """断言用户上传的文件附件：files/ 目录下物理存在、非零字节、正文包含合规引用链接"""
        print(f"   [{matched_file}] 📎 深度断言：用户上传文件附件 ({len(expected_files)} 个)...")
        all_downloaded = []
        for root, _, files in os.walk(self.export_root_dir):
            rel = os.path.relpath(root, self.export_root_dir).replace("\\", "/")
            parts = rel.split("/")
            if "files" in parts or "assets" in parts:
                for f in files:
                    all_downloaded.append((f, os.path.join(root, f)))

        for target in expected_files:
            target_name = target.get("file_name") if isinstance(target, dict) else str(target)
            expected_sha = target.get("sha256") if isinstance(target, dict) else None

            matched_phys = [
                fp for (fname, fp) in all_downloaded 
                if fname == target_name or fname.endswith(f"_{target_name}") or target_name in fname
            ]
            if not matched_phys:
                self.log_error(matched_file, f"用户附件 '{target_name}' 未在导出包 files/ 目录下找到！")
                continue

            phys_path = matched_phys[0]
            fsize = os.path.getsize(phys_path)
            if fsize == 0:
                self.log_error(matched_file, f"用户附件 '{target_name}' 物理体积为 0 字节非法文件！")
            else:
                self.log_pass(matched_file, f"用户附件 '{target_name}' 物理落地有效 ({fsize} bytes: {os.path.basename(phys_path)})")

            if expected_sha:
                with open(phys_path, "rb") as f:
                    actual_sha = hashlib.sha256(f.read()).hexdigest()
                if actual_sha != expected_sha:
                    self.log_error(matched_file, f"用户附件 '{target_name}' 内容 SHA256 不匹配: 实际 {actual_sha} != 预期 {expected_sha}")
                else:
                    self.log_pass(matched_file, f"用户附件 '{target_name}' 内容 SHA256 100% 物理一致")

            # 校验正文中是否包含合规超链接引用
            if not self.has_attachment_link(content, target_name):
                self.log_error(matched_file, f"Markdown 正文中缺少对附件 '{target_name}' 的超链接引用")
            else:
                self.log_pass(matched_file, f"Markdown 正文中包含附件 '{target_name}' 的合规超链接引用")

    def assert_uploaded_test_files(self, uploaded_files):
        """断言现场动态上传的测试文件：files/ 目录下物理存在、非零字节、SHA256 完全一致、Markdown 链接存在"""
        print(f"\n[现场上传文件断言] 📎 校验现场动态上传的多格式文件附件 ({len(uploaded_files)} 个)...")
        all_downloaded = []
        for root, _, files in os.walk(self.export_root_dir):
            for f in files:
                all_downloaded.append((f, os.path.join(root, f)))

        for uf in uploaded_files:
            target_name = uf.get("file_name")
            expected_sha = uf.get("sha256")
            chat_id = uf.get("chat_id")

            matched_phys = [
                fp for (fname, fp) in all_downloaded 
                if fname == target_name or fname.endswith(f"_{target_name}") or target_name in fname
            ]
            if not matched_phys:
                self.log_error("UploadedFileCheck", f"现场上传的测试文件 '{target_name}' 未在导出包 files/ 目录下找到！")
                continue

            phys_path = matched_phys[0]
            fsize = os.path.getsize(phys_path)
            if fsize == 0:
                self.log_error(os.path.basename(phys_path), f"现场上传的测试文件 '{target_name}' 物理体积为 0 字节！")
            else:
                self.log_pass(os.path.basename(phys_path), f"现场上传的测试文件 '{target_name}' 物理落地有效 ({fsize} bytes)")

            if expected_sha:
                with open(phys_path, "rb") as f:
                    actual_sha = hashlib.sha256(f.read()).hexdigest()
                if actual_sha != expected_sha:
                    self.log_error(os.path.basename(phys_path), f"现场上传的测试文件 '{target_name}' SHA256 不匹配: 实际 {actual_sha} != 预期 {expected_sha}")
                else:
                    self.log_pass(os.path.basename(phys_path), f"现场上传的测试文件 '{target_name}' SHA256 100% 物理一致 ({actual_sha[:16]}...)")

            # 检查对应对话 markdown 中的链接
            matched_md = None
            if chat_id:
                clean_cid = str(chat_id).replace("c_", "")
                short_cid = clean_cid[-6:]
                for fpath in self.md_files:
                    fname = os.path.basename(fpath)
                    if clean_cid in fname or short_cid in fname:
                        matched_md = fpath
                        break
            if not matched_md and self.md_files:
                for fpath in self.md_files:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        if target_name in f.read():
                            matched_md = fpath
                            break

            if matched_md:
                with open(matched_md, "r", encoding="utf-8", errors="ignore") as f:
                    md_text = f.read()
                if not self.has_attachment_link(md_text, target_name):
                    self.log_error(os.path.basename(matched_md), f"会话 Markdown 正文缺少对附件 '{target_name}' 的超链接引用")
                else:
                    self.log_pass(os.path.basename(matched_md), f"会话 Markdown 包含对附件 '{target_name}' 的合规超链接引用")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("用法: python3 export_spec_asserter.py <解压目录路径> [min_conversations]")
        sys.exit(1)
    target_dir = sys.argv[1]
    min_conv = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    asserter = ExportSpecificationAsserter(target_dir)
    success = asserter.run_all_assertions(min_conversations=min_conv)
    sys.exit(0 if success else 1)
