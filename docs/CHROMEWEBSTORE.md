# Chrome Web Store Publication & Permissions Justification

Current Chrome Web Store listing copy and permission rationale. Verify the published wording and the release `manifest.json` before submitting changes.

---

## 📋 General Information

- **Extension Name**: Gemini Exporter - Save All Your Chats
- **Chinese Extension Name**: Gemini Exporter - 保存所有对话
- **Summary / Short Description**: 100% Free & open-source • 100% local, no tracking • One-click export all chats • PDF, HTML & Markdown • Hands-off background export
- **Chinese Short Description**: 100% 免费开源 • 100% 本地处理，无追踪 • 一键导出所有对话 • PDF、HTML 与 Markdown • 自动后台导出，无需手动操作
- **Category**: Productivity / Tools
- **Default Language**: English (Supported: English, 简体中文)
- **Manifest Version**: 3
- **Privacy Policy URL**: [PRIVACY_POLICY.md](./PRIVACY_POLICY.md)
- **Support / Repository**: https://github.com/OTLFrostA/gemini-exporter

---

## 🔒 Permissions Justification (Single-Purpose Policy)

The release `manifest.json` declares these required browser permissions:

| Permission | Justification / Usage in Extension |
| :--- | :--- |
| **`storage`** | Stores user configuration settings (selected export format, toggle states) and local conversation records and export history to enable fast incremental sync across sessions without re-querying all conversations. |
| **`scripting`** | Registers and activates source scripts for platforms whose optional site access has been granted. |
| **`activeTab`** | Lets the explicitly opened popup inspect the current tab to identify the conversation to export. |
| **`unlimitedStorage`** | Required to persist conversation lists and metadata indexes for power users who have hundreds or thousands of Gemini conversations in their local browser sandbox. |

---

## 🌐 Host Permissions Justification

All platform hosts are **optional** in the release manifest. Onboarding and
**Site access** request the conversation and attachment sites only for selected
platforms. Already authorized platforms are hidden from the request list;
unchecking a choice does not revoke previously granted access.

| Platform | Optional host patterns | Justification |
| :--- | :--- | :--- |
| **Gemini** | `gemini.google.com`, `*.googleusercontent.com`, `*.usercontent.google.com`, `drive.google.com`, `lh3.google.com`, `*.gstatic.com` | Read requested conversations and retrieve associated images/files directly from Google. |
| **ChatGPT (experimental)** | `chatgpt.com`, `chat.openai.com`, `images.openai.com` | Identify the signed-in account/workspace and retrieve requested conversations and images. |
| **Claude (experimental)** | `claude.ai` | Identify the current organization and retrieve requested conversations and attachments. |
| **Grok (experimental)** | `grok.com`, `assets.grok.com` | Retrieve requested conversations and available attachments using the signed-in Grok tab. |

Use the release `manifest.json` as the authoritative permission list; temporary
required permissions used for local staging must never enter a store package.

---

## 🛡️ Privacy & Compliance Declarations

- **100% Client-Side Execution**: All parsing, image bundling, Markdown generation, and ZIP compression occur purely within the local browser sandbox.
- **No Remote Telemetry**: Zero analytics, zero third-party tracking, zero external servers.
- **No Credential Harvesting**: Never reads, stores, or transmits Google account passwords or authentication Cookies.

---

## 🏷️ Title & Promotional Assets Policy Compliance (Red Nickel Prevention)

Store listing titles, descriptions and graphics must describe the extension accurately and avoid deceptive affiliation, ranking or endorsement claims:
- **No misleading status or endorsement**: Avoid unsupported superlatives or official-affiliation claims (such as `#1`, `Best`, `Official`, or `Recommended`). A factual statement about free pricing is not a ranking or endorsement claim; it must remain accurate.
- **Factual & Feature-Oriented**: Titles and descriptions focus strictly on factual functionality (e.g., `Save All Your Chats`, `Client-Side • Unlimited • Offline`).

