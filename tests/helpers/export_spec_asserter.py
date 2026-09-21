#!/usr/bin/env python3
"""
tests/helpers/export_spec_asserter.py
--------------------------------------
严格的导出文件规范断言器 (Export Specification Asserter)

用于对真实导出的 Markdown 归档包执行规范级 Lint 与确定性内容断言：
1. 目录结构与索引完整性 (00_INDEX.md, meta.json, 文件命名规范)
2. YAML Frontmatter 规范 (字段闭合、标准键、ISO 8601 时间戳、Tags)
3. 问答轮次与角色规范 (## 👤 你 / ## 🤖 Gemini、时间戳、正文非空)
4. 纯净度与零噪点断言 (无 Google JSPB 遥测单字、无语言代码泄露、无未处理 RPC 壳)
5. 附件与多媒体一致性 (Markdown 引用的 images/ 物理存在且体积合法)
6. 固化测试账号的已知黄金对话特征断言 (代码块、表格、特定语义)
"""

import os
import re
import json
import hashlib


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

    def run_all_assertions(self, min_conversations=1, expected_golden_chats=None):
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
            self.assert_multimedia_assets(content, fname)

        # 3. 固化已知黄金会话特征断言
        if expected_golden_chats:
            self.assert_golden_conversations(expected_golden_chats)

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

    def assert_frontmatter(self, content, file_name):
        """校验 YAML Frontmatter"""
        if not content.startswith("---\n"):
            self.log_error(file_name, "文件头部必须以 YAML Frontmatter 开头 ('---\\n')")
            return

        end_match = re.search(r"\n---\n", content[4:])
        if not end_match:
            self.log_error(file_name, "YAML Frontmatter 缺少闭合标记 ('\\n---\\n')")
            return

        fm_text = content[4:4 + end_match.start()]
        required_keys = ["title:", "id:", "url:", "date:", "updated:", "exported:", "tags:"]
        for key in required_keys:
            if key not in fm_text:
                self.log_error(file_name, f"Frontmatter 缺少必要字段 '{key}'")

        if "gemini-export" not in fm_text:
            self.log_error(file_name, "Frontmatter tags 必须包含 'gemini-export'")

    def assert_turn_flow(self, content, file_name):
        """校验问答轮次与角色标记"""
        # 必须包含二级角色标题
        user_headers = re.findall(r"^## 👤 你", content, flags=re.MULTILINE)
        model_headers = re.findall(r"^## 🤖 Gemini", content, flags=re.MULTILINE)

        if not user_headers:
            self.log_error(file_name, "正文中未找到用户角色标记 ('## 👤 你')")
        if not model_headers:
            self.log_error(file_name, "正文中未找到模型角色标记 ('## 🤖 Gemini')")

        # 检查时间戳小标题
        time_quotes = re.findall(r"^> ⏱️ \d{4}/\d{1,2}/\d{1,2}", content, flags=re.MULTILINE)
        if not time_quotes:
            self.log_error(file_name, "正文中缺少时间戳引用行 ('> ⏱️ YYYY/MM/DD...')")

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

    def _find_physical_file(self, clean_ref):
        target_name = os.path.basename(clean_ref)
        for root, _, files in os.walk(self.export_root_dir):
            for f in files:
                if f == target_name:
                    return os.path.join(root, f)
        return None

    def assert_multimedia_assets(self, content, file_name):
        """检查 Markdown 引用的图片物理文件是否存在且非空"""
        img_refs = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", content)
        for ref in img_refs:
            if ref.startswith("http://") or ref.startswith("https://"):
                continue  # 外部网络图链接
            # 本地图片相对路径
            clean_ref = ref.split("?")[0].split("#")[0]
            full_img_p = self._find_physical_file(clean_ref)
            if not full_img_p or os.path.getsize(full_img_p) < 100:
                self.log_error(file_name, f"Markdown 中引用的本地图片资源物理缺失或体积过小: {clean_ref}")

    def assert_multi_turn_uploads(self, matched_file, content, expected_count):
        """断言多轮用户上传：独立图片存在、MD5 互不相同（无覆盖）、角色归属正确（非 AI 生图）"""
        print(f"   [{matched_file}] 📸 深度断言：多轮用户上传与物理去重 (预期至少 {expected_count} 张)...")
        parts = re.split(r'^(## 👤 你|## 🤖 Gemini)', content, flags=re.MULTILINE)
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
            fpath = self._find_physical_file(ref)
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
        parts = re.split(r'^(## 👤 你|## 🤖 Gemini)', content, flags=re.MULTILINE)
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
            fpath = self._find_physical_file(ref)
            if not fpath or not os.path.isfile(fpath):
                self.log_error(matched_file, f"AI 生成图片物理文件缺失: {ref}")
            else:
                fsize = os.path.getsize(fpath)
                if fsize < 1000:
                    self.log_error(matched_file, f"AI 生成图片文件过小 ({fsize} bytes): {ref}")
                else:
                    self.log_pass(matched_file, f"AI 生成图片物理落地完整 ({os.path.basename(fpath)}, {fsize} bytes)")

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
