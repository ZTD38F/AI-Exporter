# 🌌 Gemini Exporter

<p align="left">
  <b>English</b> | <a href="./README_zh.md">简体中文</a>
</p>

<p align="left">
  <a href="https://chromewebstore.google.com/detail/gemini-exporter/ldpbiafkgjlaooeplkiooljccpalpkgf?utm_source=github&utm_medium=readme_en&utm_campaign=github_repo" target="_blank">
    <img src="https://img.shields.io/badge/Chrome%20Web%20Store-Gemini%20Exporter-blue?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Web Store">
  </a>
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="License: MIT">
</p>

> **The easiest, privacy-first way to export and archive your Google Gemini conversations.**  
> Batch export your chat history into clean Markdown, JSON, or a complete ZIP archive with images and attachments. Seamlessly migrate your chats into **Obsidian**, **Notion**, **Logseq**, or your local knowledge base.

---

## ✨ Why Gemini Exporter?

- 🔒 **100% Private & Local**: Runs completely inside your browser sandbox. Your conversations, credentials, and cookies are **never sent to any external server**.
- ⚡ **Zero Setup Required**: No API keys, no complicated tokens, no passwords. Just use Google Gemini as you normally do.
- 📝 **Beautiful Markdown Output**:
  - Full syntax highlighting for programming code blocks.
  - Formatted LaTeX mathematical formulas and equations.
  - Collapsible thinking / reasoning processes (`<details>`).
  - Web source citations and reference links preserved.
- 🖼️ **Complete Media & Attachment Backups**:
  - Automatically saves user-uploaded files (PDFs, docs, images).
  - Downloads AI-generated high-resolution images (Imagen).
  - Preserves Deep Research reports and documents.
  - Images and attachments are neatly placed in an `assets/` folder with relative Markdown links.
- 📊 **Visual Batch Workbench**:
  - Intuitive dark-mode dashboard to search, filter, and manage all your conversations.
  - Filter chats by status: *All*, *Unexported*, *Needs Re-export*, or *Exported*.
  - Full **Bilingual UI (English / 简体中文)** with a 1-click switcher.
- 🔄 **Smart Incremental Backup**:
  - Only export what is new! When an older chat receives new replies, it is automatically flagged so you can back it up in seconds without re-exporting everything.
- 📥 **Google Takeout Support**:
  - Easily import your official Google Takeout ZIP archive to recover older historical chats that Google's web sidebar no longer displays.
- 👥 **Multi-Account Friendly**:
  - Seamlessly switch between different Google accounts in the Workbench with isolated storage for each.

---

## 📥 Installation

### Method 1: Chrome Web Store (Recommended)

Install directly from the official Chrome Web Store with one click:

👉 **[Get Gemini Exporter on Chrome Web Store](https://chromewebstore.google.com/detail/gemini-exporter/ldpbiafkgjlaooeplkiooljccpalpkgf?utm_source=github&utm_medium=readme_en&utm_campaign=github_repo)**

*(Compatible with Google Chrome, Microsoft Edge, Brave, Arc, Vivaldi, and other Chromium browsers.)*

### Method 2: Install from Source Code (Developer / Manual)

1. Download or clone this repository:
   ```bash
   git clone https://github.com/OTLFrostA/gemini-exporter.git
   ```
2. In your browser, navigate to the Extensions page:
   - **Chrome**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (top-left) and select the project folder.

---

## 🚀 How to Use

### 1. Quick Single-Chat Export
1. Open any chat on [Google Gemini](https://gemini.google.com).
2. Click the **Gemini Exporter** icon in your browser toolbar.
3. Choose your desired format (Markdown / JSON) and click **"Export Current Page"**.

### 2. Batch Export All Chats
1. Click the extension icon and select **"Go to Workbench"** (or right-click the icon and choose "Options").
2. Follow the friendly 4-step **Onboarding Tour** on your first visit.
3. Click **"Sync Latest"** (for quick sync) or **"Deep Scan"** (to load full history).
4. Select the conversations you want to export (or click *Select All* / *Unexported Only*).
5. Choose your export format and click **"Export Selected → ZIP"** (or export directly into a local folder).

### 3. Archive Years of History via Google Takeout (Optional)
If you have thousands of chats dating back years, Google's web interface limits sidebar scrolling to around ~600 chats. You can archive your complete history using Google Takeout:
1. Open **[Google Takeout (Gemini Pre-selected)](https://takeout.google.com/settings/takeout/custom/gemini)**, click "Next step", and download your archive ZIP.
2. In the Gemini Exporter Workbench, drag and drop the Takeout ZIP into the **Google Takeout Import** box.
3. The extension will automatically index and merge your historical chats and media offline!

---

## 💡 Using with Obsidian, Notion & Knowledge Bases

- **Obsidian**: Simply unzip the exported archive directly into your Obsidian Vault folder. All Markdown notes and `assets/` images will render instantly with working relative links.
- **Notion**: Drag and drop the exported Markdown files into Notion to import them as native workspace pages.
- **Logseq / Local Folders**: Use the **"Export to Local Folder"** option in the Workbench to write directly to your local notes directory via the FileSystem API.

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><b>Is my data safe? Does this extension upload my chats anywhere?</b></summary>
Yes, your data is 100% safe. Gemini Exporter is fully open-source and operates strictly client-side inside your browser. It does not possess any backend server, does not include any analytics or tracking scripts, and never collects or transmits your personal conversations or account credentials.
</details>

<details>
<summary><b>Do I need a Gemini API key or paid subscription?</b></summary>
No! You do not need an API key or a paid Gemini Advanced plan. It works directly with your standard browser session across both free and Advanced accounts.
</details>

<details>
<summary><b>Why does the web sidebar stop scrolling around 600 chats?</b></summary>
Google Gemini's web interface enforces a server-side limitation on how far back the sidebar can paginate. This affects the official Gemini web page itself. If you need conversations beyond this threshold, use our built-in <b>Google Takeout Import</b> feature to restore and export your entire history.
</details>

---

## 🔒 Privacy & Open Source

- **Privacy Policy**: Read our detailed [Privacy Policy](./docs/PRIVACY_POLICY.md).
- **License**: Released under the **[MIT License](./LICENSE)**.
- **Developers & Contributors**: For internal architecture, subsystem design, and automated testing guides, please see the [Architecture Guide](./docs/architecture.md).

---

## ⚠️ Disclaimer

- **Gemini Exporter** is an independent, open-source personal backup tool. It is **not affiliated with, sponsored by, or endorsed by Google LLC or Google Gemini**.
- "Google" and "Gemini" are registered trademarks of Google LLC.
