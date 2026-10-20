# scripts/framework/selectors/gemini.py
"""
Central Registry for DOM Selectors across Gemini Web App and Extension Workbench.
Provides single-source-of-truth constants and dynamic selector builders to isolate
DOM changes from test cases and automation logic.
"""


class GeminiSelectors:
    """Gemini 网页端 (gemini.google.com) DOM 选择器中央注册表 — 单点修改，全局生效"""

    # ─── 输入与发帖区域 ───
    EDITOR: str = 'rich-textarea div.ql-editor, div[contenteditable="true"]'
    FILE_PREVIEW: str = 'uploader-file-preview-container, uploader-file-preview, gem-attachment, .uploader-file-preview'
    SEND_BTN: str = 'button[aria-label*="Send" i], button[aria-label*="发送"], gem-icon-button.send-button button, button.send-button'
    SEND_BTN_NOT_STOP: str = 'button[aria-label*="Send"]:not(.stop), gem-icon-button.send-button:not(.stop)'
    STOP_BTN: str = 'button[aria-label*="Stop"], button[aria-label*="停止"], .send-button.stop'

    # ─── 流式生成与状态指示器 ───
    STREAMING_INDICATORS: str = '.streaming-text, .loading-dots, [data-is-streaming="true"], spark-progress'
    MODEL_RESPONSE: str = 'model-response'
    MODEL_RESPONSE_ALL: str = (
        'message-content.model-response-text, model-response, [data-test-id="model-response"], '
        '.model-response, message-content.model-message, .response-container, '
        'structured-content-container.model-response-text'
    )
    USER_QUERY: str = 'user-query'
    USER_QUERY_ALL: str = '.user-query, user-query, [data-test-id="user-query"], message-content.user-message'
    CONVERSATION_TITLE: str = '.conversation-title, [data-test-id="conversation-title"]'

    # ─── 多模态生图与富媒体附件 ───
    IMAGES: str = (
        'img.image, img[src*="blob:"], img[src*="googleusercontent"], '
        '.image-button, .image-container, picture img, img[alt*="image"], '
        'img[alt*="Image"], img[alt*="生成"], [data-image-id], mat-card-image'
    )

    # ─── 侧边栏导航与历史会话 ───
    NAV_ITEM: str = 'gem-nav-list-item'
    NAV_ITEM_ACTIVE: str = 'gem-nav-list-item.selected a, a.is-active[href*="/app/"], [aria-current="page"][href*="/app/"]'
    NEW_CHAT_BTN: str = 'a.side-nav-sparkle-button, a[href="/app"], [aria-label*="New chat"], [aria-label*="新会话"], [data-test-id="new-chat-button"]'
    OPEN_SIDEBAR_BTN: str = 'button[aria-label*="Open sidebar"], button[aria-label*="展开侧边栏"], button[aria-label*="Main menu"], button[data-test-id="side-nav-button"]'
    MORE_OPTIONS_BTN: str = 'button[aria-label*="More options"], button[aria-label*="更多选项"]'
    DELETE_ITEM_BTN: str = 'button[data-test-id="delete-button"], [role="menuitem"][data-test-id*="delete"], [role="menuitem"]:has(.delete-icon)'

    # ─── 弹窗与确认交互 ───
    DIALOG: str = 'mat-dialog-container, [role="dialog"], .mat-mdc-dialog-container'
    RETRY_BTN: str = 'button[aria-label*="Retry"], button[aria-label*="重试"]'
    TOAST: str = 'toast-content, .toast, .error-message, [role="alert"]'

    # ─── 模型与推理开关菜单 ───
    MODE_MENU_BTN: str = '[data-test-id="bard-mode-menu-button"], button.input-area-switch'
    MODE_MENU: str = 'gem-menu[data-test-id="gem-mode-menu"], [role="menu"]'
    MODE_MENU_ITEM: str = 'gem-menu-item, [role="menuitem"], [role="menuitemcheckbox"]'

    # ─── 页面端悬浮导出徽标 ───
    INPAGE_EXPORT_BADGE: str = '#geminiExportBadge, #gemini-export-badge, .gemini-export-badge, [data-test-id="gemini-export-badge"]'

    @staticmethod
    def nav_item_by_chat_id(chat_id: str) -> str:
        """构建侧边栏定位指定 chat_id 的选择器"""
        cid = str(chat_id).strip()
        return f'gem-nav-list-item a[href*="{cid}"], nav a[href*="{cid}"], a[href*="{cid}"]'


class WorkbenchSelectors:
    """扩展 Options 工作台管理界面 DOM 选择器注册表"""

    SEARCH_INPUT: str = '#chatSearchInput, #search'
    ITEM: str = '#list .item'
    CHECKBOX: str = 'input[type=checkbox]'
    CHECKED_CHECKBOX: str = '#list input[type=checkbox]:checked'
    BADGE_UPDATED: str = '.badge-updated'
    BADGE_EXPORTED: str = '.badge-exported'
    ITEM_TITLE: str = '.chat-title, .title'

    BTN_SELECT_ALL: str = '#btnSelectAll'
    BTN_SELECT_NONE: str = '#btnSelectNone'
    BTN_DEEP_SCAN: str = '#btnDeepScan'
    BTN_EXPORT: str = '#btnExport'
    LOG: str = '#log'

    TOUR_POPOVER: str = '.tour-popover'
    TOUR_BADGE: str = '.tour-step-badge'

    @staticmethod
    def item_by_chat_id(chat_id: str) -> str:
        """构建工作台列表中匹配特定会话 ID 的选择器（支持 c_ 前缀与原生 ID）"""
        clean_id = str(chat_id).strip().replace("c_", "")
        return f'#list .item[data-chat-id="{clean_id}"], #list .item[data-chat-id="c_{clean_id}"]'
