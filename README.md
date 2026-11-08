# 🌌 Gemini Exporter - Bulk Export All Chats & Auto Backup, Free!

<p align="left">
  <b>English</b> | <a href="./README_zh.md">简体中文</a>
</p>

**Your Gemini conversations are worth keeping.** Gemini Exporter is a **free, open-source, local-first** extension that saves Google Gemini chats as files you control. No API key, account registration, analytics, or tracking.

<p align="left">
  <a href="https://chromewebstore.google.com/detail/gemini-exporter/ldpbiafkgjlaooeplkiooljccpalpkgf?utm_source=github&amp;utm_medium=readme_en&amp;utm_campaign=github_repo">
    <img src="https://img.shields.io/badge/Chrome%20Web%20Store-Gemini%20Exporter-blue?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Chrome Web Store">
  </a>
  <img src="https://img.shields.io/badge/Version-2.1.1-orange.svg?style=for-the-badge" alt="Version: 2.1.1">
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="License: MIT">
</p>

![Cumulative Chrome Web Store installs](https://raw.githubusercontent.com/OTLFrostA/gemini-exporter/stats/stats/install-growth.svg)

## ✨ What you can do

- **Save one chat or many.** Export the current conversation in one click, or scan and select conversations for batch backup.
- **Choose your format.** **Markdown, HTML, PDF, or JSON**, with available images and file attachments.
- **Choose where files go.** Use browser downloads or write directly to a local folder. Multiple browser-download files are automatically bundled into a ZIP.
- **Keep up with new replies.** Incremental scans, skip-unchanged exports, and **Live Save** for Markdown in a chosen local folder.
- **Bring older chats back.** Import Google Takeout ZIP archives to supplement Gemini history accessible online.

English/简体中文 interface · Dark/light theme · Export status and retry tools

## 📸 Preview

![Gemini Exporter v2 workbench with synced Gemini conversations](./store_assets/screenshot_1_1280x800.png)

[Dark-mode workbench & local-folder settings](./store_assets/screenshot_2_1280x800.png) · [Quick-export popup](./store_assets/screenshot_popup_v2.png) · [Site access](./store_assets/screenshot_site_access_1280x800.png)

*Captured on October 25, 2026 from the current source build in real Chrome on port 9222, using synced Gemini conversations.*

## 🚀 Get started

1. **Install the extension** and open a conversation at [Google Gemini](https://gemini.google.com).
2. **Choose what to save.** Use **Export Current Conversation** in the popup, or open the **Workbench**, click **Sync All**, and select chats.
3. **Export your files.** In the Workbench, pick a format and either **Browser download** or **Save to local folder**, then click **Export selected**.

**Want automatic updates?** In the Workbench, choose **Save to local folder**, authorize a folder, select **Markdown**, and enable **Live Save**. It pauses if you switch to browser download or another format.

**Have older conversations?** Import an original [Google Takeout](https://takeout.google.com/settings/takeout) ZIP (select My Activity → Gemini Apps; this activity archive may not include every full reply) in the Workbench.

**Platform permissions:** Gemini, ChatGPT, Claude and Grok each have a separate optional site-access group. In onboarding or **Site access**, select the platforms you want to use (all are selected by default), then click **Authorize**. Chrome requests only the selected platforms’ conversation and attachment sites in one prompt. No platform access is required at installation; connecting one does not authorize the others. ChatGPT, Claude and Grok remain experimental in source builds. Grok reuses the MIT-licensed Loominary parser for citation cards and image/file attachments, with the existing renderers handling text, tables, code, math and exposed reasoning. Images visible in the open conversation are captured with exact message ownership. Unavailable attachments, unsupported tools and ambiguous branches are reported as partial. Keep a signed-in grok.com tab open for synchronization and export.

*Note:* **Sync All** updates the conversation list; **Export selected** creates backup files. Some expired source attachments may no longer be recoverable.

## 🔒 Privacy first

Your exports are processed on your device, not on a developer-operated server. The extension uses your existing browser sessions to retrieve requested conversations and resources from Google Gemini, or experimental ChatGPT, Claude and Grok sources after you grant their optional site access.

## 🛠️ Build from source

```bash
git clone https://github.com/OTLFrostA/gemini-exporter.git
cd gemini-exporter
npm install && npm run build
```

In Chrome, open `chrome://extensions/`, enable **Developer mode**, and select **Load unpacked** → the cloned folder.

## 📚 More information

[User guide & FAQ](./docs/USER_GUIDE.md) · [Privacy policy](./docs/PRIVACY_POLICY.md) · [v2 architecture](./src/README.md) · [Testing guide](./tests/README.md)

Gemini Exporter is independent and **not affiliated with or endorsed by Google**. Google and Gemini are trademarks of Google LLC.
