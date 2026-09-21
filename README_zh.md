# 🌌 Gemini Exporter

<p align="left">
  <a href="./README.md">English</a> | <b>简体中文</b>
</p>

<p align="left">
  <a href="https://chromewebstore.google.com/detail/gemini-exporter/ldpbiafkgjlaooeplkiooljccpalpkgf?utm_source=github&utm_medium=readme_zh&utm_campaign=github_repo" target="_blank">
    <img src="https://img.shields.io/badge/Chrome%20%E5%BA%94%E7%94%A8%E5%95%86%E5%BA%97-Gemini%20Exporter-blue?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome 应用商店">
  </a>
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="开源协议: MIT">
</p>

> **简单、隐私安全、完全开源的 Google Gemini 对话批量导出与备份工具。**  
> 一键将你的全部 Gemini 历史对话导出为精美的 Markdown、JSON 或包含图片附件的完整 ZIP 压缩包，无缝导入 **Obsidian**、**Notion**、**Logseq** 等本地个人知识库。

---

## ✨ 为什么选择 Gemini Exporter？

- 🔒 **100% 本地运行与隐私零泄露**：
  - 完全在你的浏览器本地沙箱内处理数据，**绝不上报任何账号凭据、Cookie 或对话内容至外部服务器**。
- ⚡ **零配置开箱即用**：
  - 无需申请繁琐的 API Key，无需配置 Token 或输入密码。只要像平常一样在浏览器中登录使用 Google Gemini 即可。
- 📝 **精美的 Markdown 排版**：
  - 代码块全语法高亮。
  - 完美渲染 LaTeX 数学公式与方程。
  - 折叠显示 AI 深度思考推理过程（`<details>`）。
  - 完整保留网络引用来源与标注链接。
- 🖼️ **完整的图片与附件归档**：
  - 自动下载对话中你上传的文件与图片（PDF、文档等）。
  - 自动保存 AI 生成的高清画作（Imagen）。
  - 完整备份深度研究（Deep Research）独立长篇报告。
  - 所有图片与资源自动存放于 `assets/` 文件夹，并在 Markdown 中使用相对链接规范引用。
- 📊 **可视化批量管理工作台 (Workbench)**：
  - 沉浸式深色模式面板，轻松浏览、搜索与管理数百条历史对话。
  - 支持按状态智能筛选：*全部*、*未导出*、*有新回复待更新* 或 *已导出*。
  - 完整支持 **中英双语界面**，右上角一键切换。
- 🔄 **智能增量备份**：
  - 只备份新内容！当旧会话收到新的提问或回复时，工作台会自动将其标记为“待更新”，一键即可增量导出，省时省力。
- 📥 **支持 Google Takeout 历史归档导入**：
  - 轻松导入官方 Google Takeout 导出的历史数据压缩包，帮你找回因 Gemini 网页侧边栏滚动上限而无法直接拉取的更早历史对话。
- 👥 **支持多账号顺畅切换**：
  - 可以在工作台内轻松切换不同 Google 账号，各账号数据完全独立隔离。

---

## 📥 安装指南

### 方式一：Chrome 网上应用店一键安装（官方推荐）

通过 Chrome 官方商店一键获取最新正式版：

👉 **[前往 Chrome 应用商店安装 Gemini Exporter](https://chromewebstore.google.com/detail/gemini-exporter/ldpbiafkgjlaooeplkiooljccpalpkgf?utm_source=github&utm_medium=readme_zh&utm_campaign=github_repo)**

*(支持 Google Chrome、Microsoft Edge、Brave、Arc、Vivaldi 等所有基于 Chromium 的现代浏览器。)*

### 方式二：通过源码 / 开发者模式安装

1. 下载或克隆本仓库到本地：
   ```bash
   git clone https://github.com/OTLFrostA/gemini-exporter.git
   ```
2. 在浏览器中打开扩展管理页面：
   - **Chrome**: 在地址栏访问 `chrome://extensions/`
   - **Edge**: 在地址栏访问 `edge://extensions/`
3. 打开页面右上角的 **“开发者模式” (Developer mode)** 开关。
4. 点击左上角的 **“加载已解压的扩展程序” (Load unpacked)**，选择本项目文件夹即可完成安装。

---

## 🚀 使用指南

### 1. 快速导出当前单篇对话
1. 在浏览器中打开 [Google Gemini](https://gemini.google.com) 的任意对话。
2. 点击浏览器右上角扩展栏的 **Gemini Exporter** 图标。
3. 选择所需格式（Markdown 或 JSON），点击 **“只导当前页”** 即可瞬间保存。

### 2. 批量导出全部对话
1. 点击插件图标中的 **“去工作台选 批量导出”**（或右键插件图标选择“选项”）。
2. 初次使用时可跟随 4 步 **新手引导教程** 快速熟悉核心功能。
3. 点击 **“同步最新会话”**（快速增量同步）或 **“全量拉取历史”**（扫描所有历史）。
4. 勾选想要导出的对话（支持“全选”或“只选未导出”）。
5. 选择导出格式，点击 **“导出选中 → ZIP”** 打包下载（也可选择直接写入本地文件夹）。

### 3. 使用 Google Takeout 归档数年历史（进阶）
如果你的账号有上千条历史对话，Gemini 网页端侧边栏受技术限制通常只支持滚动浏览约 600 条记录。如需完整备份所有远古会话：
1. 点击打开 **[Google Takeout (已预选 Gemini)](https://takeout.google.com/settings/takeout/custom/gemini)**，直接点击“下一步”并创建导出，下载生成的 Takeout ZIP 压缩包。
2. 在 Gemini Exporter 工作台的 **“Google Takeout 导入”** 区域拖入该 ZIP 文件。
3. 扩展程序会在本地离线解析并合并所有远古对话及媒体附件！

---

## 💡 与 Obsidian、Notion 等知识库联动

- **Obsidian**: 直接将导出的 ZIP 压缩包解压到你的 Obsidian 仓库（Vault）文件夹中。所有 Markdown 笔记与 `assets/` 资源文件夹中的图片会自动关联显示。
- **Notion**: 将导出的 Markdown 文件直接拖入 Notion 页面，即可自动转为原生的 Notion 页面与排版块。
- **Logseq / 本地文件夹**: 在工作台中开启 **“直接保存到本地文件夹”**，利用浏览器文件系统权限直接将文件写入你的笔记根目录。

---

## ❓ 常见问题 (FAQ)

<details>
<summary><b>我的数据安全吗？插件会上传我的对话吗？</b></summary>
绝对安全。Gemini Exporter 是一款完全开源的本地工具，没有任何后端服务器，也不包含任何统计、分析或跟踪代码。所有的解析、打包与导出都在你的电脑浏览器内完成，绝不会收集或上传任何个人数据。
</details>

<details>
<summary><b>我需要购买 Gemini Advanced 或申请 API Key 吗？</b></summary>
不需要。无论是免费版 Gemini 用户还是 Advanced/Pro 付费用户均可直接使用，也无需额外购买或配置任何 API Key。
</details>

<details>
<summary><b>为什么 Gemini 网页有时滚动到约 600 条就无法继续向下滚了？</b></summary>
这是 Google Gemini 网页端自身对历史侧边栏列表的分页限制（即使不使用插件，手动在官方网页一直往下滚也会遇到）。如果你需要归档超过此数量的历史，推荐使用本项目内置的 <b>Google Takeout 导入</b> 功能，完美找回并导出全部早期记录。
</details>

---

## 🔒 隐私与开源协议

- **隐私政策**: 欢迎查阅详细的 [隐私政策 (Privacy Policy)](./docs/PRIVACY_POLICY.md)。
- **开源协议**: 本项目基于 **[MIT License](./LICENSE)** 授权开源。
- **开发者与贡献者**: 如需了解底层架构分层、模块解耦与自动化测试规范，请查阅 [架构与工程指南](./docs/architecture.md)。

---

## ⚠️ 免责声明

- **Gemini Exporter** 是一款独立的个人数据备份开源工具，**与 Google LLC 或 Google Gemini 不存在任何隶属、赞助或背书关系**。
- "Google" 与 "Gemini" 为 Google LLC 的注册商标。
