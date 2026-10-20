# Privacy Policy for Gemini Exporter

**Last Updated: September 2026**

<p align="left">
  <b>English</b> | <a href="#隐私权政策-中文版">简体中文</a>
</p>

Gemini Exporter ("we", "our", or "the Extension") is committed to protecting your privacy. This Privacy Policy describes how your information is handled when you use the Gemini Exporter Chrome extension.

---

## 1. Single Purpose & Overview

Gemini Exporter is an open-source, client-side browser extension designed for a single dedicated purpose: **to allow users to export and back up their own personal Google Gemini conversation history into local files (Markdown, JSON, TXT, PDF, or ZIP archives) on their computer.**

---

## 2. Zero Data Collection & 100% Client-Side Operation

- **No Remote Servers**: Gemini Exporter does not operate, communicate with, or transmit data to any external backend server, database, cloud storage, or tracking service.
- **No Personal Data Collected**: We do not collect, harvest, store, sell, or analyze your personal information, Google account credentials, passwords, session tokens, search history, or the contents of your conversations.
- **Local Sandbox Execution**: All parsing, rendering, PDF compilation, and ZIP packaging occur entirely inside your browser's local sandbox memory. The PDF engine (Typst) runs as WebAssembly inside a local sandboxed extension page; your conversation text is passed to it as structured data and is never sent anywhere.
- **PDF Rendering Is Local**: PDF rendering and compilation run locally in the browser and do not contact external PDF, font, telemetry, or rendering services. Network access used to retrieve the user's Gemini conversations or referenced attachments remains limited to the source services required for the requested export.

---

## 3. Permissions Used and Why

The Extension requests minimal permissions strictly necessary to perform its advertised core functionality:

| Permission | Purpose & Justification |
| :--- | :--- |
| **`storage` / `unlimitedStorage`** | Used exclusively to save local user preferences (selected export format, ZIP packaging toggle, language) and local conversation index metadata to skip duplicate exports. |
| **Host Permissions (`gemini.google.com`, `*.googleusercontent.com`, `*.usercontent.google.com`, `drive.google.com`, `lh3.google.com`)** | Required to read conversation structures on Gemini and retrieve embedded user-uploaded files and AI-generated image attachments directly to your machine. |

---

## 4. Fonts & PDF Export

To render CJK text in exported PDFs, the extension may ask your permission to read the **names/metadata of fonts already installed on your device** (the browser's Local Font Access API). This is used only to pick a local font for rendering; font files and your data never leave your machine.

A small bundled math font (`NewCMMath-Regular.otf`, GUST Font License) ships with the extension so math formulas render without depending on host fonts.

---

## 5. Third-Party Services & Dependencies

- **Google Gemini**: The extension interacts locally with `gemini.google.com` to display your existing conversations. It does not send your data to any other third party.
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

**最近更新日期：2026 年 9 月**

Gemini Exporter（以下简称“本扩展”）深知用户隐私的重要性。本隐私政策旨在向您说明本扩展如何处理与保护您的数据。

### 1. 单一用途声明
Gemini Exporter 是一款纯本地运行的开源浏览器扩展，仅用于实现单一核心功能：**允许用户将自己在 Google Gemini (gemini.google.com) 中的历史对话记录导出并备份为本地文件（Markdown、JSON、TXT、PDF 或 ZIP 压缩包）。**

### 2. 零数据收集与 100% 客户端沙箱运行
- **绝无外部服务器**：本扩展不设立、不连接任何外部后端服务器、中转节点或数据收集 API。
- **不收集任何个人隐私**：我们绝不收集、上传、存储、出售或分析您的 Google 账号信息、密码、Cookie、Token、网络浏览历史或任何对话文本内容。
- **纯本地运算**：所有的网页内容解析、Markdown 生成、PDF 编译、图片附件下载与 ZIP 打包压缩操作，100% 均在您本机的浏览器内存沙箱中完成。PDF 引擎（Typst）以 WebAssembly 形式运行在本地沙箱扩展页面中；对话文本以结构化数据传入，不发送到任何地方。
- **PDF 渲染为本地行为**：PDF 的排版与编译完全在浏览器本地完成，不会连接外部 PDF、字体、遥测或渲染服务。用户主动导出时，为读取 Gemini 对话及其关联附件，扩展仍可能访问完成该导出所需的 Google/Gemini 来源服务。

### 3. 权限申请合理性说明
本扩展仅申请实现上述导出功能所必需的最小权限：
- **`storage` / `unlimitedStorage`**：仅用于在本地记录用户的导出偏好（默认格式、是否打包 ZIP、中英语言设置）以及已导出对话标记，实现增量跳过已导出记录。
- **主机权限 (`gemini.google.com`、`*.googleusercontent.com`、`*.usercontent.google.com`、`drive.google.com`、`lh3.google.com`)**：用于读取对话文本以及下载对话中内嵌的图片与用户上传附件至本地。

### 4. 字体与 PDF 导出
为在 PDF 中渲染中文，扩展可能会请求读取**您设备上已安装字体的名称/元数据**（浏览器的 Local Font Access API），仅用于挑选本地字体参与渲染；字体文件和您的数据不会离开本机。

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
