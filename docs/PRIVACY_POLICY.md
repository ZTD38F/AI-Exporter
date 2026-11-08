# Privacy Policy for Gemini Exporter

**Last Updated: October 29, 2026**

<p align="left">
  <b>English</b> | <a href="#隐私权政策-中文版">简体中文</a>
</p>

Gemini Exporter ("we", "our", or "the Extension") is committed to protecting your privacy. This Privacy Policy describes how your information is handled when you use the Gemini Exporter Chrome extension.

---

## 1. Single Purpose & Overview

Gemini Exporter is an open-source, client-side browser extension designed to **export users' own supported AI conversation history into local Markdown, HTML, PDF or JSON files** (with automatic ZIP packaging for multi-file browser downloads). The public product focuses on Google Gemini; source builds also include experimental ChatGPT, Claude and Grok adapters.

All platform site access is optional and grouped separately for Gemini, ChatGPT, Claude and Grok. In onboarding or **Site access**, select the platforms you want to use and click **Authorize**; only the selected platforms’ conversation and attachment sites are requested together. Source builds include experimental ChatGPT, Claude and Grok adapters. Each uses your existing login directly, without a developer-operated intermediary.

---

## 2. Zero Data Collection & 100% Client-Side Operation

- **No Developer-Operated Chat Backend**: We do not operate a server to receive or store your chats. Requests for conversations and attachments go directly to the source services you authorize.
- **No Developer Data Collection**: We do not receive, sell, track or analyze your conversation contents or account credentials. The extension itself does store user preferences, local conversation facts and export records on your device for its functionality.
- **Local Sandbox Execution**: All parsing, rendering, PDF compilation, and ZIP packaging occur entirely inside your browser's local sandbox memory. The PDF engine (Typst) runs as WebAssembly inside a local sandboxed extension page; your conversation text is passed to it as structured data and is never sent anywhere.
- **PDF Rendering Is Local**: PDF rendering and compilation run locally in the browser and do not contact external PDF, font, telemetry, or rendering services. Network access used to retrieve the user's Gemini conversations or referenced attachments remains limited to the source services required for the requested export.

---

## 3. Permissions Used and Why

The Extension requests minimal permissions strictly necessary to perform its advertised core functionality:

| Permission | Purpose & Justification |
| :--- | :--- |
| **`storage` / `unlimitedStorage`** | Used exclusively to save local user preferences (selected format, delivery mode, language) and local conversation/index/export-record data to skip duplicate exports. |
| **`scripting`** | Registers and activates source scripts only for platforms with granted site access. |
| **Gemini optional sites (`gemini.google.com`, `*.googleusercontent.com`, `*.usercontent.google.com`, `drive.google.com`, `lh3.google.com`, `*.gstatic.com`)** | Requested together when Gemini is selected for authorization to read conversations and download their attachments. |
| **ChatGPT optional sites (`chatgpt.com`, `chat.openai.com`, `images.openai.com`)** | Requested together when ChatGPT is selected for authorization to identify the signed-in user/workspace and read conversations and images. |
| **Grok optional sites (`grok.com`, `assets.grok.com`)** | Requested together when Grok is selected for authorization to read conversations and download attachments. |
| **Claude optional site (`claude.ai`)** | Requested when Claude is selected for authorization to identify the current organization and read conversations and attachments. |
| **External image optional site (`cdn.sanity.io`)** | Requested separately when you click the download authorization button beside a failed image. Allows the browser to read that image directly when ordinary cross-origin access is unavailable; granting it does not start an export. |

No platform has mandatory host access or automatically injected source scripts at installation. Connecting one platform does not authorize another. No platform password or session token is saved in the local conversation database.

---

## 4. Fonts & PDF Export

PDFs are compiled locally. The renderer includes bundled fonts and can use available installed fonts when permitted; granting access to installed fonts is not required for a standard export. Font files and conversation content are not uploaded.

A small bundled math font (`NewCMMath-Regular.otf`, GUST Font License) ships with the extension so math formulas render without depending on host fonts.

---

## 5. Third-Party Services & Dependencies

- **Google Gemini (optional)**: After site access is granted, the extension interacts directly with `gemini.google.com` to display your existing conversations. It does not send your data to any other third party.
- **ChatGPT (optional)**: After site access is granted, the extension contacts ChatGPT directly using your existing login. Conversation processing and exported files remain local, without a developer-operated intermediary.
- **Claude (optional)**: After site access is granted, the extension reads conversations and attachments directly from `claude.ai` using your existing login. Processing and exports remain local.
- **Grok (optional)**: After site access is granted, the extension reads conversations and available attachments directly from Grok using your existing login. Processing and exports remain local.
- **Open-Source Libraries**: We use [JSZip](https://stuk.github.io/jszip/) (client-side JavaScript library) to compress files into `.zip` archives directly within your browser, and the Typst compiler WebAssembly + JS glue (`@myriaddreamin/typst.ts` ecosystem, Apache-2.0) to compile PDFs locally. The bundled NewCMMath font is under the GUST Font License. No external network requests are made by these components.

---

## 6. Security & Data Protection Certification

In accordance with Google Chrome Web Store Developer Program Policies:
1. We **do not sell** user data to third parties.
2. We **do not use or transfer** user data for purposes unrelated to the item's core single purpose.
3. We **do not use or transfer** user data to determine creditworthiness or for lending purposes.

---

## 7. Open Source Verification

Gemini Exporter is open-source software licensed under the MIT License. Anyone can inspect and verify our source code at:  
👉 **<https://github.com/OTLFrostA/gemini-exporter>**

---

## 8. Contact Us

If you have questions, concerns, or bug reports regarding this Privacy Policy, please contact us via:
- **GitHub Issues**: <https://github.com/OTLFrostA/gemini-exporter/issues>

---

<hr/>

<h2 id="隐私权政策-中文版">隐私权政策 (中文版)</h2>

**最近更新日期：2026 年 10 月 29 日**

Gemini Exporter（以下简称“本扩展”）深知用户隐私的重要性。本隐私政策旨在向您说明本扩展如何处理与保护您的数据。

### 1. 单一用途声明
Gemini Exporter 是一款纯本地运行的开源浏览器扩展，用于**将用户自己的、受支持 AI 平台对话导出为本地 Markdown、HTML、PDF 或 JSON 文件**（浏览器多文件下载自动打包 ZIP）。公开产品以 Google Gemini 为主；源码版也包含实验性的 ChatGPT、Claude 和 Grok 适配器。

Gemini、ChatGPT、Claude、Grok 的网站访问权限均为可选项，按平台独立申请。在新手引导或“网站授权”中勾选所需平台并点击“授权”后，一次申请所选平台会话与附件网站的访问权限。源码版包含实验性的 ChatGPT、Claude 和 Grok 适配器，通过现有登录会话直接读取您请求的数据，不经过开发者中转服务器。

### 2. 零数据收集与 100% 客户端沙箱运行
- **不使用开发者对话服务器**：我们不运行接收或保存用户聊天的后端。读取对话和附件仅直接访问用户授权的来源平台。
- **不向开发者收集数据**：我们不接收、出售、追踪或分析对话正文及账号凭据；扩展会在您的本地设备上保存必要的用户设置、对话信息及导出记录。
- **纯本地运算**：所有的网页内容解析、Markdown 生成、PDF 编译、图片附件下载与 ZIP 打包压缩操作，100% 均在您本机的浏览器内存沙箱中完成。PDF 引擎（Typst）以 WebAssembly 形式运行在本地沙箱扩展页面中；对话文本以结构化数据传入，不发送到任何地方。
- **PDF 渲染为本地行为**：PDF 的排版与编译完全在浏览器本地完成，不会连接外部 PDF、字体、遥测或渲染服务。用户主动导出时，为读取 Gemini 对话及其关联附件，扩展仍可能访问完成该导出所需的 Google/Gemini 来源服务。

### 3. 权限申请合理性说明
本扩展仅申请实现上述导出功能所必需的最小权限：
- **`storage` / `unlimitedStorage`**：仅用于在本地记录用户的导出偏好（默认格式、输出方式、中英语言设置）以及本地会话信息和导出记录，实现增量跳过已导出记录。
- **`scripting`**：仅为已授权平台注册、激活来源脚本。
- **Gemini 可选网站权限**：`gemini.google.com`、`*.googleusercontent.com`、`*.usercontent.google.com`、`drive.google.com`、`lh3.google.com`、`*.gstatic.com`，勾选 Gemini 并授权时一组申请，用于读取会话和附件。
- **ChatGPT 可选网站权限**：`chatgpt.com`、`chat.openai.com`、`images.openai.com`，勾选 ChatGPT 并授权时一组申请，用于确认用户/工作区并读取会话和图片。
- **Grok 可选网站权限**：`grok.com`、`assets.grok.com`，勾选 Grok 并授权时一组申请，用于读取会话和可获取的附件。
- **Claude 可选网站权限**：`claude.ai`，勾选 Claude 并授权时申请，用于确认组织并读取会话和附件。
- **外部图片可选网站权限**：`cdn.sanity.io`，仅在您点击失败图片旁的下载授权按钮时单独申请，用于普通跨域读取受限时直接读取该来源图片。授权本身不启动导出。

安装时不强制授予任何平台的网站访问权，也不自动注入来源脚本。连接一个平台不会授权其他平台。平台密码和会话令牌不会写入本地会话数据库。

### 4. 字体与 PDF 导出
PDF 在浏览器本地编译，提供内置字体，并可在获得授权时使用本机可用字体；标准导出不依赖授予读取本机字体的权限。字体文件及对话内容不会上传。

扩展自带一个小型数学字体（`NewCMMath-Regular.otf`，GUST Font License），保证公式渲染不依赖宿主字体。

### 5. 平台开发者规范合规承诺
本扩展严格遵守 Chrome 网上应用店开发者政策：
1. **绝不向任何第三方出售用户数据**；
2. **绝不将数据用于与本扩展导出功能无关的任何用途**；
3. **绝不将数据用于信贷审核、金融评级或广告追踪**。

### 6. 第三方组件
本扩展捆绑：Typst 编译器 WebAssembly + JS 胶水（`@myriaddreamin/typst.ts` 生态，Apache-2.0）、JSZip（MIT/GPLv3）、NewCMMath 字体（GUST Font License）。完整声明见仓库 `THIRD_PARTY_NOTICES.md`。

### 7. 源码完全开源受监督
本扩展源码在 GitHub 完全公开透明，欢迎任何人审计与监督：  
👉 **<https://github.com/OTLFrostA/gemini-exporter>**
