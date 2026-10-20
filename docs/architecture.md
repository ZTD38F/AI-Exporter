# 🛡️ Gemini Exporter — System Architecture & Engineering Specification

本文档提供 **Gemini Exporter**（v1.6.0+）的深度工程架构全景说明，涵盖完整的 Chrome MV3 模块化架构图、代码库 AST 逻辑分布与架构映射矩阵、核心业务数据流全链路时序图（含数据源、数据汇与容灾处理逻辑）、安全设计不变量与三层测试体系规范。

---

## 目录 (Table of Contents)

1. [一、模块化系统架构全景 (Modular Subsystem Architecture)](#一模块化系统架构全景-modular-subsystem-architecture)
2. [二、AST 逻辑分布与架构映射矩阵 (AST Logical Distribution & Architecture Mapping)](#二ast-逻辑分布与架构映射矩阵-ast-logical-distribution--architecture-mapping)
3. [三、核心数据流全链路时序图与数据源汇规范 (Core Data Flows, Sources & Sinks)](#三核心数据流全链路时序图与数据源汇规范-core-data-flows-sources--sinks)
   - [3.1 会话增量同步与全量拉取数据流 (Incremental & Deep Scan Sync Flow)](#31-会话增量同步与全量拉取数据流-incremental--deep-scan-sync-flow)
   - [3.2 实时无感自动保存数据流 (Real-Time Live Auto-Save Flow)](#32-实时无感自动保存数据流-real-time-live-auto-save-flow)
   - [3.3 批量并发导出与流式打包数据流 (Batch Export Pipeline Flow)](#33-批量并发导出与流式打包数据流-batch-export-pipeline-flow)
   - [3.4 Google Takeout 历史脱机合流数据流 (Takeout Offline Ingestion Flow)](#34-google-takeout-历史脱机合流数据流-takeout-offline-ingestion-flow)
   - [3.5 Popup 快捷操作与单篇导出数据流 (Popup Quick Export Flow)](#35-popup-快捷操作与单篇导出数据流-popup-quick-export-flow)
   - [3.6 网络凭据嗅探与跨隔离区握手数据流 (Credential Sniffing & Cross-World Bridge Flow)](#36-网络凭据嗅探与跨隔离区握手数据流-credential-sniffing--cross-world-bridge-flow)
4. [四、核心工程设计不变量 (Key Engineering Invariants)](#四核心工程设计不变量-key-engineering-invariants)
5. [五、三层测试体系架构 (Three-Tier Testing Architecture)](#五三层测试体系架构-three-tier-testing-architecture)

---

## 一、模块化系统架构全景 (Modular Subsystem Architecture)

Gemini Exporter 严格遵循 Chrome Extension Manifest V3 规范，将系统解耦为 **主世界网络嗅探层**、**隔离世界内容脚本层**、**后台服务工作线程 (Service Worker)**、**跨平台通用 Provider 与解析核心**、**领域导出/打包引擎**、**响应式持久化层** 以及 **用户界面展示层**。

文档导出使用同一个 Canonical contract：

```text
Provider / Gemini input → Normalization → Canonical Conversation Bundle
                                         ├─ HTML renderer
                                         ├─ Typst/PDF renderer
                                         └─ Markdown renderer
```

popup、批量导出和 live-save 的 Markdown 均使用 `formatMarkdownCanonical()`。消息数组顺序是唯一权威顺序；Canonical 只保存文档语义，诊断与 raw evidence 留在 ingestion 层。JSON exports remain separate legacy/raw serialization paths where applicable，继续使用同步 `formatContent()`。

```mermaid
graph TD
    subgraph BrowserRuntime ["Chrome 运行时宿主环境 (Browser Runtime Environment)"]
        subgraph WebPageMainWorld ["Gemini 网页端宿主环境 (MAIN World)"]
            MAIN_Hook["hookCredentials.ts<br/>(网络/XHR/Fetch 拦截器 & 凭据/事件嗅探)"]
        end

        subgraph ContentScriptIsolated ["扩展隔离区内容脚本 (ISOLATED World)"]
            CS_Entry["content.ts<br/>(内容脚本总协调入口)"]
            CS_Sniffer["accountSniffer.ts<br/>(Google 真实账号/邮箱/GaiaID 身份嗅探器)"]
            CS_Bridge["messageBridge.ts<br/>(跨世界事件桥接器)"]
            CS_LiveObs["liveSaveObserver.ts<br/>(流式输出/DOM 变更监视器)"]
            CS_LiveCoord["liveSaveCoordinator.ts<br/>(实时无感保存调度器)"]
            CS_SyncEng["syncEngine.ts<br/>(分页扫描/增量同步引擎)"]
            CS_DomScraper["domScraper.ts<br/>(网页 DOM 回退解析抓取器)"]
            CS_Badge["badgeView.ts<br/>(右下角悬浮状态提示徽章)"]
        end

        subgraph BackgroundSW ["后台服务工作线程 (Service Worker)"]
            BG_Entry["background.ts<br/>(中央消息路由器 & 生命周期管理)"]
            BG_KeepAlive["keepAlive.ts<br/>(长任务心跳保活机制)"]
            BG_Abort["abortManager.ts<br/>(多账号 Slot 中断状态管理器)"]
            BG_Batch["batchFetcher.ts<br/>(后台并发批处理请求器)"]
            BG_LiveHandler["liveSaveHandler.ts<br/>(后台目录句柄写入代理 & prompt 降权返回 permission_prompt_needed)"]
            BG_TabAction["tabAction.ts<br/>(图标动态着色与激活状态感知)"]
        end

        subgraph ExtensionPages ["扩展交互前端页面 (Extension Pages: Options & Popup)"]
            subgraph PopupView ["快捷操作面板 (Popup Action Center)"]
                POP_Main["popup.ts / popup.html<br/>(当前页一键导出 / 去控制台批量导出)"]
            end

            subgraph OptionsWorkbench ["批量管理工作台 (Options Workbench)"]
                OPT_Main["options.ts / options.html<br/>(工作台总入口 & 协调器)"]
                OPT_Ctx["optionsContext.ts<br/>(工作台 DI 上下文装配中枢)"]
                OPT_Modules["optionsInit / optionsExport / optionsSync<br/>optionsTakeout / optionsSettings"]
                OPT_Store["conversationsStore.ts<br/>(响应式状态机 & 严格账号槽位隔离)"]
                OPT_Views["listView / logView / accountView<br/>dialogView / progressView"]
                OPT_Controllers["exportController / syncController<br/>takeoutController / dirHandleController (一键重授权)"]
                OPT_Tour["tourGuide.ts / tourSteps.ts<br/>(6步沉浸式新手引导与高亮遮罩)"]
            end
        end
    end

    subgraph CoreEngine ["核心领域逻辑与引擎层 (Core Domain Logic & Engine)"]
        subgraph ProviderLayer ["Provider 抽象层 (src/core/provider/)"]
            PROV_Registry["ProviderRegistry / providerResolver<br/>(多提供商动态注册表与 URL 解析)"]
            PROV_Gemini["GeminiProvider<br/>(Gemini batchexecute 协议适配)"]
        end

        subgraph ApiParserLayer ["协议通信与反序列化层 (src/core/api/)"]
            API_Client["GeminiClient (facade)<br/>rpcClient / pagination / retryPolicy / credentialManager / credStorage (严格单向隔离)"]
            API_Parser["GeminiParser (facade)<br/>parseList / parseDetail / extractors / attachments / payload"]
        end

        subgraph ExportEngines ["导出、转换与打包引擎 (src/core/engine/)"]
            ENG_Orchestrator["ExportOrchestrator & parseDrift<br/>(批量导出编排器 / AsyncQueue / 协议漂移遥测)"]
            ENG_Worker["BatchWorker<br/>(单会话抓取与任务单元)"]
            ENG_Rate["RateLimiter<br/>(自适应指数退避与熔断器)"]
            ENG_Formatter["ChatFormatter & htmlTemplate.ts<br/>(Markdown / 1:1 独立 HTML / JSON / OpenAI 转换器)"]
            ENG_Takeout["TakeoutEngine<br/>(Takeout ZIP 解析 / MediaIndex / ZipBombGuard)"]
            ENG_LiveWriter["liveSaveWriter.ts<br/>(实时 Markdown / JSON 文件流写入器)"]
            ENG_Writers["Writers: zipWriter (JSZip STORE流式防OOM) / fsWriter (FileSystem API)"]
        end

        subgraph CoreUtils ["工具库与单点真理 (src/core/utils/)"]
            UT_SSoT["utils.ts / titleUtils.ts / mergeUtils.ts<br/>(权威标题仲裁、去重、时间戳排序)"]
            UT_Path["pathUtils.ts / chipUtils.ts / progressUtils.ts / tabService.ts (Strict Tab Routing)"]
            UT_I18n["i18n.ts (locales/zh.ts, locales/en.ts)"]
        end

        subgraph StorageLayer ["两级存储与持久化层 (src/core/storage/)"]
            ST_Service["StorageService & schemaMigration<br/>(两级主控: chrome.storage.local 轻量元数据索引 & Slot 隔离)"]
            ST_Locks["withCrossTabLock / withConversationLock / withSlotLock<br/>(三把跨 tab 命名锁 + transactConversations 原子读写)"]
            ST_Detail["conversationDetailStore.ts<br/>(两级详情: IndexedDB 完整对话轮次与消息体实体仓储)"]
            ST_Live["liveStorageManager.ts<br/>(实时保存配置与目录句柄代理)"]
            ST_IDB["idbHandleStore.ts<br/>(FileSystemDirectoryHandle 跨会话持久化)"]
            ST_Session["SessionStore.ts<br/>(内存/chrome.storage.session 缓存)"]
        end
    end

    %% 跨世界通信线
    MAIN_Hook -- "window.postMessage (CrossWorldEvents)" --> CS_Bridge
    CS_Bridge --> CS_LiveObs
    CS_LiveObs --> CS_LiveCoord
    CS_Bridge --> CS_SyncEng
    CS_Entry --> CS_Sniffer
    CS_Sniffer --> ST_Service

    %% 内容脚本与后台通信
    CS_LiveCoord -- "runtime.sendMessage (liveSaveViaHandle)" --> BG_LiveHandler
    OPT_Controllers -- "runtime.sendMessage (deepScan)" --> BG_Entry
    ENG_Worker -- "runtime.sendMessage (fetchBatch)" --> BG_Entry
    BG_Entry -- "下行通道 (TabService.sendToGeminiTab → chrome.tabs.sendMessage)" --> CS_Entry
    POP_Main -- "runtime.sendMessage (fetchChat)" --> BG_Entry
    OPT_Controllers -- "runtime.sendMessage" --> BG_Entry

    %% 模块连接到核心逻辑
    CS_SyncEng --> PROV_Gemini
    CS_LiveCoord --> ENG_LiveWriter
    CS_LiveCoord --> ST_Live
    BG_LiveHandler --> ST_IDB
    BG_LiveHandler --> ENG_LiveWriter
    ST_Live --> ST_IDB
    OPT_Controllers --> ST_IDB
    OPT_Main --> OPT_Ctx

    OPT_Controllers --> ENG_Orchestrator
    OPT_Controllers --> ENG_Takeout
    ENG_Orchestrator --> ENG_Worker
    ENG_Orchestrator --> ENG_Rate
    ENG_Worker --> PROV_Gemini
    ENG_Orchestrator --> ENG_Formatter
    ENG_Orchestrator --> ENG_Writers
    POP_Main --> ENG_Formatter

    %% 存储与工具支持
    ENG_Orchestrator --> ST_Service
    ST_Service --> ST_Locks
    ST_Service --> ST_Detail
    ENG_Takeout --> UT_SSoT
    ENG_Orchestrator --> UT_SSoT
    CS_SyncEng --> UT_SSoT
```

---

## 二、AST 逻辑分布与架构映射矩阵 (AST Logical Distribution & Architecture Mapping)

下表呈现整个代码库 `src/` 目录下系统核心主干骨架模块（Core Backbone AST，全仓 115 个 TS 源文件，涵盖核心业务主干、子解析器、视图控制器与契约类型定义）的抽象语法树逻辑职责、核心导出实体、数据依赖以及在架构图中的映射定位：

| 物理源码路径 (File Path) | 架构分层 / 子系统 | 核心 AST 导出实体 (Classes / Functions / Interfaces) | 模块职责与设计不变量 (Role & Invariants) | 上游调用源 (Inflow) | 下游承接汇 (Outflow) | 架构图映射节点 |
|---|---|---|---|---|---|---|
| `src/background/background.ts` | Background SW | `background.ts` (Entrypoint), 消息监听器 | Service Worker 入口，负责中央消息路由、初始化生命周期、保持心跳及多账号中断状态。 | Chrome 运行时、Content、UI | `abortManager`, `keepAlive`, `liveSaveHandler`, `tabAction` | `BG_Entry` |
| `src/background/lifecycle.ts` | Background SW | `initSessionAccessLevel`, `initLifecycleListeners`, `initUninstallUrl` | 处理插件安装打开选项页、配置卸载反馈地址、设置 session 存储访问级别。 | `background.ts` | Chrome APIs (`runtime.onInstalled`, `storage.session`) | `BG_Entry` |
| `src/background/keepAlive.ts` | Background SW | `startKeepAlive`（返回清理函数） | 在耗时较长的批量导出与全量扫描期间派发微型心跳，防止 MV3 Service Worker 意外挂起。 | `background.ts` | Chrome runtime 端口心跳 | `BG_KeepAlive` |
| `src/background/abortManager.ts` | Background SW | `isSlotAborted`, `setSlotAborted`, `restoreAbortFlags` | 维护多账号 Slot 级别的中断标记，并在 session storage 中跨唤醒持久化。 | `background.ts`, `syncController.ts` | `chrome.storage.session` | `BG_Abort` |
| `src/background/batchFetcher.ts` | Background SW | `fetchBatch`, `sendToGeminiTab`, `getGeminiTab` | 后台代理并发抓取 batchexecute 请求，跨标签页消息转发。 | `background.ts` | `chrome.tabs.sendMessage` | `BG_Batch` |
| `src/background/liveSaveHandler.ts` | Background SW | `handleLiveSaveViaHandle`, `markDirDeletedInConfig` | 接收实时保存数据执行写入；目录句柄权限降权时返回 `{ ok:false, error:'permission_prompt_needed' }` 并写入 live 配置（`dirError`），由前台徽章提示、用户手势经 `reauthorizeDirHandle` 重授权恢复。 | `background.ts` (runtime.onMessage) | `idbHandleStore`, `liveSaveWriter` | `BG_LiveHandler` |
| `src/background/tabAction.ts` | Background SW | `updateTabActionState`, `initTabActionListeners` | 监视激活标签页 URL 是否为 Gemini 域名，动态切换彩色/灰色图标状态。 | `background.ts`, tabs 事件 | `chrome.action.setIcon` | `BG_TabAction` |
| `src/content/content.ts` | Content Script | `content.ts` (Entrypoint) | 隔离区主入口，统筹初始化 Observer、Bridge、SyncEngine、LiveSave、身份嗅探与徽章视图。 | Chrome Content Script 注入 | `cleanupRegistry`, `messageBridge`, `pageObserver`, `syncEngine` | `CS_Entry` |
| `src/content/accountSniffer.ts` | Content Script | `extractEmailFromText`, `extractNameFromLabel`, `sniffUserProfileFromDom` | 从 DOM 头像标签、aria-label 与全局 WIZ 数据安全嗅探 Google 真实账号邮箱、显示名与 Gaia ID，终结易变 URL 序号伪身份。 | `bootstrap.ts`, `syncEngine.ts` | `storageService.updateAccountSlot` | `CS_Sniffer` |
| `src/content/hookCredentials.ts` | Content Script (MAIN) | `hookCredentials.ts` (IIFE) | 注入页面主世界，拦截原生 `fetch` 与 `XMLHttpRequest`，嗅探网络凭据、删除 RPC 与流式事件。 | 原生 Gemini 页面交互 | `window.postMessage` (锁定 origin) | `MAIN_Hook` |
| `src/content/messageBridge.ts` | Content Script | `MessageBridge`, `handleWindowMessage` | 监听主世界 `postMessage`，校验来源，解包凭据、流式事件、删除 RPC 并分发给内部引擎。 | `hookCredentials.ts` | `syncEngine`, `liveSaveCoordinator`, `liveSaveObserver` | `CS_Bridge` |
| `src/content/liveSaveObserver.ts` | Content Script | `LiveSaveObserver`, `init`, `cleanup` | 监听 Gemini 对话流式生成与 DOM 变更，在生成结束时触发冷却防抖并调用协调器。 | `messageBridge`, DOM MutationObserver | `liveSaveCoordinator` | `CS_LiveObs` |
| `src/content/liveSaveCoordinator.ts` | Content Script | `LiveSaveCoordinator`, `init`, `executeLiveSave` | 实时保存总调度：拉取会话完整轮次，排重并调用 FileSystem 句柄或向后台分发写入，刷新徽章。 | `liveSaveObserver` | `liveStorageManager`, `liveSaveWriter`, `badgeView`, `bg` | `CS_LiveCoord` |
| `src/content/syncEngine.ts` | Content Script | `SyncEngine`（`syncOnce` / `tryBatchExecuteFull` / `upsertConversations` / `ingestListBatch`…） | 负责前台对话列表抓取，协调增量同步与全量分页扫描，并将结果交由 SSoT 合并入库。 | `content.ts`, `syncController` | `geminiClient`, `storageService`, `utils` | `CS_SyncEng` |
| `src/content/domScraper.ts` | Content Script | `DomScraper`（`parseDoc` / `contentFetchChatDetail` / `getConversationLinks`…） | 当 RPC 不可用或离线时，直接从宿主页面 DOM 树结构化提取会话提问、回复、附件与元数据。 | `liveSaveCoordinator`, `popup.ts` | 规范化 `ConversationDetail` 实体 | `CS_DomScraper` |
| `src/content/badgeView.ts` | Content Script | `BadgeView`, `ensureBadge`, `updateBadge` | 在 Gemini 页面右下角渲染无侵入式浮动徽章，实时显示同步进度与保存状态。 | `content.ts`, `liveSaveCoordinator` | 宿主页面 DOM (`#geminiExportBadge`) | `CS_Badge` |
| `src/content/assetFetcher.ts` | Content Script | `AssetFetcher`（`fetchGgChain` / `toHighRes` / `handleGetFileBlob` / `inferImageExt`…） | 处理用户上传附件与 AI 生成图片的高清源 URL 解析与 Blob 二进制下载。 | `liveSaveCoordinator`, `domScraper` | ArrayBuffer / Blob 二进制流 | `CS_LiveCoord` |
| `src/content/bootstrap.ts` | Content Script | `ensureCreds`（`extractAtFromPage` / `extractBlFromPage` / `detectSlotFromUrl` / `loadCredentialsMap` / `saveCredentials`…） | 页面启动引导，提取页面内嵌的初始化配置与第一手 XSRF Token。 | `content.ts` | `credentialManager` | `CS_Entry` |
| `src/content/cleanupRegistry.ts` | Content Script | `registerCleanup`, `runCleanups` | 注册页面热重载或重新注入时的注销回调，防止监听器内存泄漏。 | Content 脚本各模块 | 事件监听器解绑 | `CS_Entry` |
| `src/content/contentContext.ts` | Content Script | `contentContext` (单例上下文) | 管理注入状态、开发模式标记、取消令牌与国际化语言环境。 | Content 脚本各模块 | 上下文状态只读/写入 | `CS_Entry` |
| `src/content/messageRouter.ts` | Content Script | `MessageRouter`, `init` | 隔离区内部消息分发器，处理来自 Options/Popup 的控制指令。 | `content.ts`, Extension Pages | `syncEngine` | `CS_Bridge` |
| `src/content/pageObserver.ts` | Content Script | `PageObserver`, `init`, `cleanup` | 观察 SPA URL 路径跳转（如切换会话）与侧边栏 DOM 挂载。 | `content.ts` | `syncEngine.touchActiveConversation` | `CS_Entry` |
| `src/core/provider/aiProvider.ts` | Core: Provider | `AIProvider`, `ProviderConversationItem` | 定义跨异构 AI 模型平台的通用接口契约规范。Provider interface remains the extension seam. ChatGPT / Claude / Grok adapters will be implemented only when their real production payloads are integrated and verified. | 所有 Provider 模块 | 上层引擎统一接口 | `PROV_Registry` |
| `src/core/provider/providerRegistry.ts` | Core: Provider | `ProviderRegistryClass`, `ProviderRegistry` (单例) | 全局 Provider 注册表，支持按平台 ID 或当前页面 URL 模式匹配提供商。 | 各 Provider 自动注册 | `liveSaveCoordinator`, `exportOrchestrator` | `PROV_Registry` |
| `src/core/provider/providerResolver.ts` | Core: Provider | `resolveProvider` | 根据当前激活页面 URL 解析匹配的 `AIProvider` 适配器并自动完成注册绑定。 | `syncEngine`, `liveSaveCoordinator` | `providerRegistry.ts` | `PROV_Registry` |
| `src/core/provider/gemini/geminiProvider.ts` | Core: Provider | `GeminiProvider` (实现 `AIProvider`) | Gemini 平台适配器，封装 batchexecute RPC 调用与多账号 Slot 映射。Provider interface remains the extension seam. ChatGPT / Claude / Grok adapters will be implemented only when their real production payloads are integrated and verified. | `providerRegistry.ts` | `geminiClient`, `geminiParser` | `PROV_Gemini` |
| `src/core/provider/index.ts` | Core: Provider | `export *` (Barrel) | 统一导出多模型提供商契约、具体适配器与注册表单例。 | 业务消费方 | Provider 子模块 | `PROV_Registry` |
| `src/core/api/geminiClient.ts` | Core: API | `GeminiAPIClient` (Facade) | 统一客户端入口，封装身份认证、分页抓取、指数退避重试与 AbortSignal 控制。 | `geminiProvider`, `syncEngine`, `exportWorker` | `client/*` 子模块 | `API_Client` |
| `src/core/api/geminiParser.ts` | Core: API | `GeminiParser`（含 `GeminiResponseParserClass` facade） | 统一反序列化入口，解析 Protobuf/JSPB 复杂嵌套数组，提取轮次、思维链与附件。 | `geminiClient`, `messageBridge` | `parser/*` 子模块 | `API_Parser` |
| `src/core/api/client/credentialManager.ts` | Core: API Client | `resolveCred`, `getAtFromPage`, `detectSlot` | 统一管理 SNlM0e、at、sid 等鉴权凭据；严格按账号 Slot 单向解析，严禁跨账号借调偷用 Token。 | `geminiClient.ts` | `credStorage.ts` | `API_Client` |
| `src/core/api/client/credStorage.ts` | Core: API Client | `getCredStorage`, `markCredSessionAccessFailed` | 统一管理凭据在 `chrome.storage.session` 与内存降级回退模式之间的安全存取。 | `credentialManager.ts` | `chrome.storage.session` / 内存 | `API_Client` |
| `src/core/api/client/pagination.ts` | Core: API Client | `getAllConversations`, `getConversationDetail` | 封装 batchexecute 游标翻页机制与超时控制；默认最多翻 2000 页（`maxPages = 2000`），超限时标记 stoppedEarly 阻止 reconcile 误删。 | `geminiClient.ts` | `rpcClient.ts` | `API_Client` |
| `src/core/api/client/retryPolicy.ts` | Core: API Client | `handleHttp400` / `handleHttp401` / `handleHttp429` / `interruptibleSleep` / `parseRetryAfterMs` | 处理 HTTP 400（XSRF 过期刷新）、401（凭证失效）、429（频率限制）的指数退避与重试策略。 | `geminiClient.ts` | 网络请求调用 | `API_Client` |
| `src/core/api/client/rpcClient.ts` | Core: API Client | `postBatchexecute`, `getApiUrl` | 构造 batchexecute 原始 POST 请求负载、组装 RPC 封包并处理响应转义。 | `geminiClient.ts` | `window.fetch` | `API_Client` |
| `src/core/api/parser/parseList.ts` | Core: API Parser | `parseList`, `extractListItemTimestamp` | 从 batchexecute 响应中提取会话列表项（ID、标题、修改时间）。 | `geminiParser.ts` | 原始数组 -> 会话摘要列表 | `API_Parser` |
| `src/core/api/parser/parseDetail.ts` | Core: API Parser | `parseDetail`, `detectTurnSchemaDrift` | 递归遍历多轮对话数组，提取提问/回复角色、时间戳并检测 Schema 漂移。 | `geminiParser.ts` | 原始数组 -> 轮次列表 (`ChatMessage[]`) | `API_Parser` |
| `src/core/api/parser/extractors.ts` | Core: API Parser | `extractCandidateText`, `extractThoughts`, `extractCitations` | 提取模型思考推理过程（Thought Blocks）、候选回答文本与网络引用链接。 | `parseDetail.ts` | 候选数据块 -> 纯文本与引用元数据 | `API_Parser` |
| `src/core/api/parser/attachments.ts` | Core: API Parser | `extractImages`, `extractUserFiles`, `extractDocumentsMeta` | 提取图片附件（含 Imagen 生成图与用户上传图）、文件与 Deep Research 报告。 | `parseDetail.ts` | 附件原始元数据 -> `Attachment[]` | `API_Parser` |
| `src/core/api/parser/payload.ts` | Core: API Parser | `PayloadParser`, `extractInnerPayload`, `payloadToMs` | 深入解析 batchexecute 中转义的多层嵌套 JSON 响应字符串与时间戳转换。 | `parseDetail.ts`, `parseList.ts` | 展开的结构化数据块 | `API_Parser` |
| `src/core/engine/exportEngine.ts` | Core: Engine | `ExportEngine` (Facade 别名 `ExportOrchestrator`) | 导出引擎统一命名空间门面，对上游保持稳定契约。 | UI 控制器 | `exportOrchestrator.ts` | `ENG_Orchestrator` |
| `src/core/engine/export/exportOrchestrator.ts` | Core: Engine | `ExportOrchestrator`, `AsyncQueue` | 编排批量导出作业，维护基于并发上限的异步任务队列，驱动进度通知与异常恢复。 | `exportController.ts` | `batchWorker`, `rateLimiter`, `progressReporter` | `ENG_Orchestrator` |
| `src/core/engine/export/batchWorker.ts` | Core: Engine | `fetchChatDetail` / `resolveChat` | 独立执行单条会话详情抓取与解析（RPC 请求与详情解析），实际导出装配由 `exportOrchestrator` 协调。 | `exportOrchestrator.ts` | `geminiClient`, `conversationDetailStore` | `ENG_Worker` |
| `src/core/engine/export/parseDrift.ts` | Core: Engine | `recordParseDrift`, `getParseDriftSummary` | 记录并聚合 JSPB 协议结构漂移（Schema Drift）遥测告警，辅助诊断上游协议变更。 | `exportOrchestrator.ts`, `batchWorker.ts` | 诊断告警统计 | `ENG_Orchestrator` |
| `src/core/engine/export/rateLimiter.ts` | Core: Engine | `isRateLimited` / `calculateBackoff` / `abortableSleep` / `RateLimitManager` | 自适应限流器状态机，根据响应延迟与 429 频率动态调整请求间隔与并发数。 | `exportOrchestrator.ts` | 延迟休眠控制 | `ENG_Rate` |
| `src/core/engine/export/progressReporter.ts` | Core: Engine | `ProgressReporter` | 实时计算导出百分比、已完成/失败计数、附件统计与预估剩余时间 (ETA)。 | `exportOrchestrator.ts` | UI 进度回调通知 | `ENG_Orchestrator` |
| `src/core/engine/export/sessionRecovery.ts` | Core: Engine | `writeIndexAndMeta`, `finalizeChatExport`, `writeDiagnostics` | 导出索引归档、单聊导出记录 SSoT 持久化与开发者诊断恢复。 | `exportOrchestrator.ts` | `sessionStore.ts`, `storageService.ts` | `ENG_Orchestrator` |
| `src/core/engine/takeoutEngine.ts` | Core: Engine | `TakeoutEngine` (Facade) | Google Takeout 历史导入与脱机解析统一门面。 | UI 控制器、测试用例 | `takeout/*` 子模块 | `ENG_Takeout` |
| `src/core/engine/takeout/takeoutParser.ts` | Core: Engine | `parseTakeoutZip` | 解析官方 Takeout ZIP 归档（JSZip 全量载入，非流式），提取 HTML 会话文件与嵌入的媒体附件。 | `takeoutEngine.ts` | `takeoutHtmlParser.ts`, `mediaIndex.ts` | `ENG_Takeout` |
| `src/core/engine/takeout/takeoutHtmlParser.ts` | Core: Engine | `parseTakeoutHtmlBlocks` / `parseTakeoutPrompt` / `unescapeHtmlEntities`… | 针对 Takeout 离线 HTML 文本进行结构化清洗，提取提问时间戳与前缀临时标题。 | `takeoutParser.ts` | HTML 文本 -> 结构化会话对象 | `ENG_Takeout` |
| `src/core/engine/takeout/mediaIndex.ts` | Core: Engine | `extractC2PATimestamp`, `getTakeoutFallbackMedia` | 基于图片 C2PA 元数据与哈希建立离线媒体索引池，支持脱机媒体回填。 | `takeoutEngine.ts` | 内存媒体映射表 | `ENG_Takeout` |
| `src/core/engine/takeout/zipBombGuard.ts` | Core: Engine | `validateZipFile`, `validateZipEntries` | 安全防御模块，校验条目总数、压缩包体积与解压后总尺寸上界，杜绝 Zip 炸弹 DoS 攻击。 | `takeoutParser.ts` | 安全校验通过 / 抛出异常中断 | `ENG_Takeout` |
| `src/core/engine/template/htmlTemplate.ts` | Core: Engine | `GEM_HTML_CSS`, `GEM_HTML_SCRIPT`, `sanitizeUrl` | Canonical HTML renderer 使用的共享样式、交互脚本和安全输出 helpers。 | `renderCanonicalHtml.ts` | HTML 样式、脚本及安全字符串 | `ENG_Formatter` |
| `src/core/engine/chatFormatter.ts` | Core: Engine | `ChatFormatter`（`formatMarkdownCanonical` / `formatHtmlCanonical` / `toOpenAIJson` / `formatContent`） | Markdown / HTML 通过异步 Canonical normalizer 与 renderer 导出；JSON 保留同步独立序列化路径。 | `exportOrchestrator`, `liveSaveWriter`, `popup.ts` | 格式化文本字符串 | `ENG_Formatter` |
| `src/core/engine/liveSaveWriter.ts` | Core: Engine | `createLiveSaveWriter`, `writeLiveSaveMarkdown` | 专为实时无感保存优化的快速单篇写入器，直写 FileSystem Directory Handle。 | `liveSaveCoordinator`, `liveSaveHandler` | FileSystem API 磁盘文件 | `ENG_LiveWriter` |
| `src/core/engine/writers/writerInterface.ts` | Core: Engine Writers | `Writer`, `createWriter` | 统一文件输出抽象接口，提供跨 ZIP 内存包与本地文件系统的多态实现。 | `exportOrchestrator`, `batchWorker` | `zipWriter.ts` 或 `fsWriter.ts` | `ENG_Writers` |
| `src/core/engine/writers/zipWriter.ts` | Core: Engine Writers | `ZipWriter` (基于 JSZip) | 在内存中构建多级目录树；对多模态图片应用 `isPrecompressedAsset` (STORE 模式)，配合 200MB 安全阈值与流式分块消除内存 OOM 崩溃。 | `writerInterface.ts` | 最终 ZIP 压缩包 Blob | `ENG_Writers` |
| `src/core/engine/writers/fsWriter.ts` | Core: Engine Writers | `FsWriter` (基于 FileSystem API) | 基于现代 FileSystem Access API 直写用户本地磁盘物理文件夹。 | `writerInterface.ts` | 本地磁盘文件与目录树 | `ENG_Writers` |
| `src/core/engine/assetPipeline.ts` | Core: Engine | `AssetPipeline`（`processAsset`） | 导出时并发下载媒体附件并将其归档至 `assets/` 目录。 | `batchWorker.ts` | 物理媒体文件落盘 | `ENG_Worker` |
| `src/core/storage/storageService.ts` | Core: Storage | `StorageService` (静态单例) | 多账号 Slot 隔离存储核心，实现两级存储：local 存储轻量会话元数据索引，自动委托 IndexedDB 承载重轮次详情。 | UI Store, Controllers, SyncEngine | `chrome.storage.local`, `conversationDetailStore` | `ST_Service` |
| `src/core/storage/conversationDetailStore.ts` | Core: Storage | `saveConversationDetail`, `getConversationDetail`, `deleteConversationDetail` | 两级存储架构之 IndexedDB 实体详情仓储，承接全量 turns 与重消息体，保障 chrome.storage.local 永远处于安全轻量区。 | `storageService.ts` | IndexedDB (`gemini_conversation_details`) | `ST_Detail` |
| `src/core/storage/liveStorageManager.ts` | Core: Storage | `LiveStorageManager`, `getLiveConfig`, `setLiveConfig` | 实时保存配置管理（enabledDisk/format/includeAssets）并代理 `idbHandleStore` 目录句柄。真正实体快照落盘由 `liveSaveHandler`/`liveSaveWriter` 承载。 | `liveSaveCoordinator` | `idbHandleStore.ts`, `chrome.storage.local` | `ST_Live` |
| `src/core/storage/idbHandleStore.ts` | Core: Storage | `getStoredDirHandle`, `saveStoredDirHandle`, `getMemoryDirHandle`, `setMemoryDirHandle` | `FileSystemDirectoryHandle` 在 IndexedDB 与内存缓存中的唯一真理源 (SSoT)。 | `dirHandleController`, `liveStorageManager`, `liveSaveHandler` | IndexedDB (`gemini_exporter_idb`) | `ST_IDB` |
| `src/core/storage/schemaMigration.ts` | Core: Storage | `ensureSchemaMigrated` | 存储 Schema 版本迁移引擎，负责旧版键值结构升级与幂等迁移校验。 | `storageService.ts`, `lifecycle.ts` | `chrome.storage.local` | `ST_Service` |
| `src/core/storage/sessionStore.ts` | Core: Storage | `SessionStore` | 临时会话数据缓存，支持中途恢复与内存级热数据读取。 | `exportOrchestrator`, `background` | `chrome.storage.session` / 内存 | `ST_Session` |
| `src/core/storage/formatStore.ts` | Core: Storage | `FormatStore` | 校验并持久化用户的导出格式偏好设置与自定义模板参数。 | UI Settings, Popup | `chrome.storage.local` | `ST_Service` |
| `src/core/utils/utils.ts` | Core: Utils | `GeminiUtils` (单点真理 SSoT 集合) | 汇聚全局路径清理、标题仲裁与列表合并去重逻辑的统一门面。 | 全系统所有模块 | 格式规范与仲裁结果 | `UT_SSoT` |
| `src/core/utils/titleUtils.ts` | Core: Utils | `resolveTitle`, `resolveDetailTitle`, `cleanTitle` | 权威标题仲裁中心，实现多源标题优先级排序（RPC > 网络详情 > 前缀提问 > Takeout）。 | `utils.ts`, `geminiParser`, `syncEngine` | 统一规范标题字符串 | `UT_SSoT` |
| `src/core/utils/mergeUtils.ts` | Core: Utils | `mergeConversation`, `deduplicateConversations` | 负责多源会话合并与去重，保证高权标题与最新更新时间戳永不倒退。 | `utils.ts`, `syncEngine`, `takeoutEngine` | 合并后的稳定会话数组 | `UT_SSoT` |
| `src/core/utils/pathUtils.ts` | Core: Utils | `sanitizeRelativePath`, `buildExportFileName`, `normId`, `AccountProfile` | 严格清洗相对路径与文件名，定义多账号用户画像契约，防范路径穿越 (Path Traversal) 漏洞。 | `fsWriter`, `zipWriter`, `exportOrchestrator`, `bootstrap` | 安全合法的文件名与路径 | `UT_Path` |
| `src/core/utils/progressUtils.ts` | Core: Utils | `formatETA`, `formatByteSize`, `calculateRate` | 计算传输速率、剩余时间人类可读格式化。 | `progressReporter.ts` | 格式化文本输出 | `UT_Path` |
| `src/core/utils/tabService.ts` | Core: Utils | `TabService`, `getGeminiTab`, `sendToGeminiTab` | 严格按账号 Slot 定向检索 Gemini 标签页并建立安全通信，未找到匹配账号标签页时强校验报错，杜绝串账号盲投。 | Background, UI Controllers | `chrome.tabs` API | `UT_Path` |
| `src/core/utils/i18n.ts` | Core: Utils | `I18nClass`, `getI18n` | 中英双语轻量翻译引擎，支持动态语言切换与多级占位符替换。 | UI Views, Controllers, Tour | 国际化本地化字典 | `UT_I18n` |
| `src/core/utils/chipUtils.ts` | Core: Utils | `ChipUtils`, `isInternalChipUrl`, `stripInternalChipMarkdown` | 过滤并清洗 Gemini 内部提及 (User Mention / Model Tag) 产生的内部 Chip 标签。 | `attachments.ts`, `chatFormatter.ts` | 清洗后的 Markdown/文本 | `UT_Path` |
| `src/core/utils/constants.ts` | Core: Utils | `GeminiConstants`, `STORAGE_KEYS`, `DEFAULT_EXPORT_FOLDER_NAME` | 全局跨模块共享系统配置与存储键名真理源 (SSoT)。 | 全系统所有模块 | 配置常量定义 | `UT_SSoT` |
| `src/core/utils/environment.ts` | Core: Utils | `isLocalDevelopment` | 运行时环境感知，基于 URL 参数及调试标记判定是否处于开发者调试模式。 | UI 模块, `utils.ts` | 调试环境布尔标记 | `UT_SSoT` |
| `src/core/utils/messaging.ts` | Core: Utils | `sendTypedMessage`, `isMessageAction`, `getErrorMessage` | 强类型安全的跨世界与跨扩展上下文消息传递包装器，附带超时与异常提取。 | Background, Content, UI | `chrome.runtime.sendMessage` | `UT_SSoT` |
| `src/core/utils/moduleOverrides.ts` | Core: Utils | `__setModuleOverride`, `__resolveModule`, `__clearModuleOverrides` | 运行时模块重定向与轻量依赖注入容器，支持无头单元测试注入 Mock 实现。 | 全系统所有模块 | 动态依赖解析 | `UT_SSoT` |
| `src/core/protocol/protocol.ts` | Core: Protocol | `GeminiProtocol`, `CrossWorldEvents` | 定义 wire 级 RPC 标识符 (`RPCS.LIST`, `RPCS.DELETE`)、跨世界事件名与关键断言。 | `hookCredentials`, `messageBridge` | 协议契约常量 | `MAIN_Hook`, `CS_Bridge` |
| `src/core/protocol/events.ts` | Core: Protocol | `GeminiCredentialsPayload`, `GeminiStreamEvents` | 强类型事件 Payload 接口定义。 | 全协议层 | TypeScript 类型校验 | 契约层 |
| `src/ui/options/options.ts` | UI: Options | `options.ts` (Entrypoint) | 工作台初始化编排器，挂载上下文并装配初始化子模块。 | 用户访问 `options.html` | UI 子模块协调 | `OPT_Main` |
| `src/ui/options/optionsContext.ts` | UI: Options | `optionsContext.ts` (Dependency Container) | 工作台集中式依赖注入与上下文访问器，解耦各 UI 子模块与核心单例，提供纯净的向下单向依赖。 | `options.ts`, `options/*.ts` | 各 UI Views, Controllers, StorageService | `OPT_Main` |
| `src/ui/options/modules/optionsInit.ts` | UI: Options Module | `OptionsInit`（`init`） | 负责加载存储配置、渲染多账号选择器、初始化列表视图与绑定按键事件。 | `options.ts` | `conversationsStore`, `listView` | `OPT_Modules` |
| `src/ui/options/modules/optionsExport.ts` | UI: Options Module | `OptionsExport` | 绑定导出按钮点击事件，驱动 `ExportController` 并展示进度弹窗。 | `options.ts` | `exportController.ts` | `OPT_Modules` |
| `src/ui/options/modules/optionsSync.ts` | UI: Options Module | `OptionsSync`（`bindBroadcastListeners`） | 绑定“同步最新”与“全量拉取历史”按钮，驱动 `SyncController` 执行扫描。 | `options.ts` | `syncController.ts` | `OPT_Modules` |
| `src/ui/options/modules/optionsTakeout.ts` | UI: Options Module | `OptionsTakeout`（`init`） | 监听 Takeout ZIP 文件拖拽与选择事件，驱动 `TakeoutController` 离线解压。 | `options.ts` | `takeoutController.ts` | `OPT_Modules` |
| `src/ui/options/modules/optionsSettings.ts` | UI: Options Module | `OptionsSettings` | 语言切换（中/英）、开发者模式开关与运行诊断控制台。 | `options.ts` | `storageService`, `logView` | `OPT_Modules` |
| `src/ui/state/conversationsStore.ts` | UI: State | `ConversationsStore` (单例) | 响应式会话状态机，管理已加载会话集合、状态过滤与排序（当前选中项为 `listView` 模块变量，不在此处）。 | UI Controllers, Modules | 触发 UI View 重新渲染 | `OPT_Store` |
| `src/ui/views/listView.ts` | UI: View | `ListView`, `renderConversations` | 全量 innerHTML 会话列表渲染器（非虚拟列表），渲染选中多选框与更新状态徽章；选中态为 listView 模块变量，无 Takeout 标识。 | `conversationsStore` | DOM (`#conversationList`) | `OPT_Views` |
| `src/ui/views/progressView.ts` | UI: View | `ProgressView`（`show` / `update` / `complete` / `hide`） | 批量导出与扫描全屏进度遮罩，展示进度条、ETA 与中断取消操作。 | `exportController`, `syncController` | DOM (`#progressModal`) | `OPT_Views` |
| `src/ui/views/accountView.ts` | UI: View | `AccountView`, `renderAccountSelector` | 渲染多账号 Slot (`u0`, `u1`...) 切换下拉菜单，绑定切换事件。 | `optionsInit.ts` | DOM (`#accountSelect`) | `OPT_Views` |
| `src/ui/views/dialogView.ts` | UI: View | `DialogView`, `showConfirm`, `showRecoveryDialog` | 会话恢复提示条、二次确认弹窗与错误提示。 | UI 各 Controller | 模态交互对话框 DOM | `OPT_Views` |
| `src/ui/views/logView.ts` | UI: View | `LogView`, `appendLog` | 可折叠开发者诊断控制台视图，支持实时调试日志滚动输出。 | 全 UI 模块 | DOM (`#logContainer`) | `OPT_Views` |
| `src/ui/controllers/exportController.ts` | UI: Controller | `ExportController`（`runExport` / `abort` / `setRunning` / `isRunning`…） | 导出控制器，聚合用户选择、校验本地目录句柄、驱动 `ExportOrchestrator`。 | `optionsExport.ts` | `exportOrchestrator.ts`, `progressView.ts` | `OPT_Controllers` |
| `src/ui/controllers/syncController.ts` | UI: Controller | `SyncController`（`startIncrementalScan` / `startDeepScan` / `stopScan`…） | 同步控制器，通过 `tabService` 唤起前台内容脚本或后台发起增量/全量拉取。 | `optionsSync.ts` | `syncEngine.ts`, `conversationsStore.ts` | `OPT_Controllers` |
| `src/ui/controllers/takeoutController.ts` | UI: Controller | `TakeoutController`（`handleTakeoutImport`） | Takeout 控制器，驱动 `TakeoutEngine` 进行离线解压并将合并结果入库。 | `optionsTakeout.ts` | `takeoutEngine.ts`, `storageService.ts` | `OPT_Controllers` |
| `src/ui/controllers/dirHandleController.ts` | UI: Controller | `DirHandleController`（`requestDirHandle` / `reauthorizeDirHandle` / `verifyDirPermission` / `restoreSavedDirHandle`…） | 调用原生 `window.showDirectoryPicker()`，保存句柄至 IndexedDB 并检验读写权限。 | `optionsExport.ts` | `idbHandleStore.ts` | `OPT_Controllers` |
| `src/ui/tour/tourGuide.ts` | UI: Tour | `TourGuide`, `startTour`, `nextStep` | 6 步交互式新手向导引擎，计算遮罩镂空高亮与气泡定位。 | `optionsInit.ts` | 引导蒙层与定位计算 | `OPT_Tour` |
| `src/ui/tour/tourSteps.ts` | UI: Tour | `STEPS` (向导步骤配置) | 定义 6 步新手引导步骤的数据结构与选择器绑定目标。 | `tourGuide.ts` | 新手向导配置 | `OPT_Tour` |
| `src/ui/tour/tourPosition.ts` | UI: Tour | `positionElements` | 计算新手向导高亮气泡的视口绝对物理坐标与动态避让。 | `tourGuide.ts` | DOM 样式绝对定位 | `OPT_Tour` |
| `src/ui/tour/featureReleases.ts` | UI: Tour | `FEATURE_RELEASES`, `getLatestEligibleFeature` | 新特性发布公告配置表，支持按版本号精准触发特性高亮聚焦。 | `tourGuide.ts`, `optionsSettings.ts` | 向导触发条件判断 | `OPT_Tour` |
| `src/ui/uiCommon.ts` | UI: Common | `$`, `getI18n`, `t`, `setWorkbenchControlsDisabled` | UI 前端跨视图共享的 DOM 快捷选择器、工作台操作按钮禁用状态控制与 i18n 辅助方法。 | UI 各 Controller 与 Views | 界面 DOM 元素 | `UI_Common` |
| `src/ui/utils/domI18n.ts` | UI: Utils | `applyI18n`, `applyLangToggleUI`, `setSafeFormattedContent` | UI 专属 DOM 国际化渲染引擎与语言切换控件绑定，将 DOM 渲染彻底剥离出 Core 层。 | `uiCommon.ts`, `popup.ts`, `optionsSettings.ts` | 前台各页面真实 DOM 树 | `UI_Common` |
| `src/ui/popup/popup.ts` | UI: Popup | `popup.ts` (Entrypoint) | 扩展浮窗交互中心：当前页单篇导出与去控制台批量导出。 | 用户点击扩展图标 | `chatFormatter` | `POP_Main` |
| `src/types/index.ts` | Core: Types | `Conversation`, `ChatMessage`, `Attachment`, `ExportRecord` 等 | 全仓 9 大类型定义文件契约中心，为跨世界事件、会话实体、UI 接口与导出参数提供静态类型保障。 | 全仓所有 TS 模块 | TypeScript 编译期检查 | 契约层 |

---

## 三、核心数据流全链路时序图与数据源汇规范 (Core Data Flows, Sources & Sinks)

### 3.1 会话增量同步与全量拉取数据流 (Incremental & Deep Scan Sync Flow)

本数据流负责将云端历史同步到本地，支持从前台内容脚本发起（增量感知），也支持从 Options 工作台发起（全量深度拉取）。

* **数据源 (Data Source)**：
  - Google Gemini 官方 `batchexecute` RPC 接口（`https://gemini.google.com/_/BardChatUi/data/batchexecute`）；
  - 负载：RPC 编码 payload `[[["MaZiqc","[\"...\",...]",null,"generic"]]]`；
  - 鉴权参数：从当前活跃 Cookie 与 Session 提取的 `at` (XSRF)、`f.sid`、`bl`。
* **数据汇 (Data Sink)**：
  - `chrome.storage.local`：写入对应的账号 Slot **轻量元数据索引**（键名 `gemini_conversations_${slot}`，只保留 `id`、`title`、`timestamp`、`updatedAt`、`snippet`、`count`，彻底解除 10MB 配额瓶颈）；
  - `IndexedDB` (`gemini_conversation_details` 实体仓库)：透明承载完整对话轮次（`turns`）与附件元数据；
  - Options 工作台 DOM：响应式更新 `ConversationsStore`，驱动 `ListView` 增量刷新。
* **核心处理与容错逻辑**：
  1. `TabService.getGeminiTab(slot)` 严格查找目标 slot 标签页，杜绝跨账号盲投；
  2. `GeminiClient` 携带分页游标发送请求；
  3. 若遇到 HTTP 400 且返回报文包含 XSRF 凭据失效特征，`RetryPolicy` 自动触发隔离世界经 `getAtFromPage` 读 DOM 重新抓取 Token 并进行退避重试；
  4. `parseList` 解析返回的嵌套多维 JSPB 数组，提取会话 ID、标题及时间戳；
  5. `TitleUtils.resolveTitle` 与 `MergeUtils.mergeConversation` 作为 **单点真理 (SSoT)** 执行多源合并，若远端权威标题存在则自动替换 Takeout 临时标题；
  6. **两级存储分离写入**：`StorageService` 拆分轻量列表索引至 `chrome.storage.local`，将实体对话轮次下沉至 IndexedDB `conversationDetailStore`；
  7. 检测用户或后台发送的 `AbortSignal`，若中断则立即保存已拉取的游标并优雅终止。

```mermaid
sequenceDiagram
    autonumber
    participant UI as Options/Popup (UI)
    participant Sync as SyncController
    participant Tab as TabService (Strict Slot Match)
    participant CS as SyncEngine (Content Script)
    participant Client as GeminiClient & RetryPolicy
    participant RPC as Google Gemini batchexecute RPC
    participant SSoT as TitleUtils & MergeUtils (SSoT)
    participant Store as StorageService (两级存储主控)
    participant Local as chrome.storage.local (轻量索引)
    participant IDB as conversationDetailStore (IndexedDB 详情库)

    UI->>Sync: 用户点击【全量拉取历史】(Deep Scan)
    Sync->>Tab: getGeminiTab(slot) 严格匹配目标账号标签页
    alt 找到对应账号的存活标签页
        Tab->>CS: 派发 deepScan 消息 (附带 slot)
        loop 分页抓取直到游标为空或遇到已拉取锚点
            CS->>Client: getConversationList(cursor, slot)
            Client->>RPC: POST batchexecute (MaZiqc)
            alt HTTP 400 (Token 过期)
                Client->>Client: 隔离世界经 getAtFromPage 读 DOM 重新抓取 at/sid 凭据并指数退避
                Client->>RPC: 重新发送 POST 请求
            end
            RPC-->>Client: 返回原始 Protobuf/JSPB 文本
            Client-->>CS: parseList 结构化会话列表项
            CS->>SSoT: mergeConversation (去重与权威标题仲裁)
            CS->>Store: saveConversations(slot, list) 两级持久化
            par 两级存储分离写入
                Store->>Local: 写入轻量会话元数据索引 (去除 turns, < 10MB 配额安全)
                Store->>IDB: 实体详情下沉入库 (持久化完整 turns 与消息体)
            end
            CS-->>UI: 实时回传扫描进度 (更新 ProgressView)
        end
        CS-->>Sync: 扫描完成 (返回最新会话全量数据)
    else 标签页不存在或槽位不匹配
        Sync->>UI: 提示请在浏览器中打开对应 slot 账号标签页
    end
    Sync->>UI: 触发 ConversationsStore 刷新，ListView 重新渲染
```

---

### 3.2 实时无感自动保存与无头权限降权数据流 (Real-Time Live Auto-Save Flow with Permission-Degraded Value+Config Recovery)

本数据流负责在用户使用官方 Gemini 对话时，完全无感、实时地将新生成的回复写入本地指定目录。

* **数据源 (Data Source)**：
  - 宿主网页网络请求（MAIN World 拦截到的 batchexecute 流式响应或完成包）；
  - DOM 树变更（`liveSaveObserver` 监听的回复渲染 DOM 节点）。
* **数据汇 (Data Sink)**：
  - 本地磁盘文件系统：通过用户授权的 `FileSystemDirectoryHandle`，调用 `liveSaveWriter` 生成物理 `.md` 文件及 `assets/` 附件；
  - 页面浮动徽章：`BadgeView` 动态展现"保存中..."、"已同步"或权限过期/目录失效告警。
* **核心处理与容错逻辑**：
  1. 主世界拦截器 `hookCredentials.ts` 捕获到流式生成开始与结束事件（`CrossWorldEvents.STREAM_COMPLETE`）；
  2. 隔离区 `messageBridge` 接收到消息后唤醒 `liveSaveObserver`，启动 300ms 防抖冷却；
  3. 调度器 `liveSaveCoordinator` 拉取当前会话最新轮次数据，格式化为 CommonMark + Frontmatter；
  4. **无头环境权限降权检测与一键手势恢复（返回值 + 配置）**：
     - 若通过 Background SW 代理写入且浏览器重启导致句柄权限回退为 `'prompt'` 时，由于 MV3 Service Worker 属于无头环境，无法直接触发 `requestPermission()`（浏览器强制要求前台显式用户手势）；
     - 此时 `handleLiveSaveViaHandle` 返回 `{ ok: false, error: 'permission_prompt_needed' }` 并写入 live 配置（`setLiveConfig({ dirError: 'permission_prompt_needed' })`）——不存在广播事件，也没有 Chrome Downloads 兜底；
     - `liveSaveCoordinator` 根据返回值触发徽章警告；
     - 用户在前端页面点击即可通过真实手势执行 `reauthorizeDirHandle()` 一键恢复原生目录直写权限；
  5. 若目标目录物理句柄在磁盘上被删除，写入 live 配置（`enabledDisk: false, dirName: '', dirError: 'not_found'`），徽章展示友好警示且自动暂停同步。

```mermaid
sequenceDiagram
    autonumber
    participant Host as Gemini 宿主页面 (MAIN World)
    participant Hook as hookCredentials.ts (Interceptor)
    participant Bridge as messageBridge.ts (ISOLATED)
    participant Obs as liveSaveObserver.ts
    participant Coord as liveSaveCoordinator.ts
    participant SW as Background SW (liveSaveHandler.ts)
    participant Disk as 用户本地磁盘目录 (Native FS)
    participant UI as Options 选项页 (dirHandleController)
    participant Badge as badgeView.ts (UI 徽章)

    Host->>Host: AI 回复生成完毕 (流式网络传输结束)
    Host->>Hook: 触发原生 Fetch/XHR 结束事件
    Hook->>Bridge: window.postMessage(CrossWorldEvents.STREAM_COMPLETE)
    Bridge->>Obs: 派发流式结束通知
    Obs->>Obs: 启动 300ms 防抖冷却 (合并短时间内重复事件)
    Obs->>Coord: 触发实时同步请求 (executeLiveSave)
    Coord->>Badge: 切换状态为【正在保存...】
    Coord->>Coord: 获取完整会话详情并格式化 Markdown
    alt 前台持有活动句柄且权限有效 (queryPermission == 'granted')
        Coord->>Disk: FileSystemWritableFileStream 直写文件与图片附件
        Coord->>Badge: 切换状态为【已实时同步 (时间戳)】
    else 由后台 SW 代理写入且权限退化 (queryPermission == 'prompt')
        Coord->>SW: runtime.sendMessage(liveSaveViaHandle)
        SW->>SW: 检测到无头环境无法触发 requestPermission (User Gesture 限制)
        SW-->>Coord: 返回 { ok: false, error: 'permission_prompt_needed' } + 写 live 配置 (dirError)
        Coord->>Badge: 显示【需要恢复授权 (点击选项页恢复直写)】
        opt 用户在前台点击一键重授权
            UI->>UI: 用户手势触发 handle.requestPermission({ mode: 'readwrite' })
            UI->>Disk: 权限恢复为 'granted'，后续会话无缝恢复目录直写
        end
    else 目录在外部被删除 (NotFoundError)
        Coord->>Badge: 显示【⚠ 目标目录已删除，实时同步已暂停】
        Coord->>Coord: 停用实时磁盘同步标记 (enabledDisk: false)，等待用户重新选目
    end
```

---

### 3.3 批量并发导出与流式打包数据流 (Batch Export Pipeline Flow with JSZip OOM Prevention)

本数据流负责将多选的大量历史会话一次性导出为带有相对路径图片引用的 ZIP 压缩包或直接写入本地文件夹，并通过多模态二进制资产 STORE 模式彻底杜绝大批量导出时的 JSZip 内存 OOM 崩溃。

* **数据源 (Data Source)**：
  - 用户在 Options 工作台中勾选的会话 ID 集合；
  - `StorageService` 与 `conversationDetailStore` 中的两级历史详情；
  - Google Gemini 详细内容 RPC（或 Takeout 离线媒体池）。
* **数据汇 (Data Sink)**：
  - 模式 A：JSZip 内存打包生成的 `application/zip` Blob，触发 Chrome 下载管理器；
  - 模式 B：FileSystem Access API 直写的本地笔记目录树（如 Obsidian/Logseq 根目录）。
* **核心处理与容错逻辑**：
  1. `ExportOrchestrator` 初始化并发限制队列 `AsyncQueue`（默认并发数 3，与 `exportOrchestrator.ts` 生产代码一致，兼顾批处理吞吐与 Google 429 防护）；
  2. `RateLimiter` 动态监控网络延迟与响应状态，遭遇异常自动激活退避；
  3. `BatchWorker` 逐个处理单会话：拉取会话详情、调用 `AssetPipeline` 解析附件 URL、并发抓取图片 Blob；
  4. 图片文件名经 C2PA 元数据时间戳提取（`extractC2PATimestamp`，未做签名校验）辅助归档，存入 `assets/` 子目录；
  5. **多模态附件 STORE 流式防 OOM 机制 (P0 容灾)**：
     - 调用 `isPrecompressedAsset(path)` 检测图片/媒体文件扩展名（`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.mp4`）；
     - 对已高度压缩的二进制媒体强制使用 `compression: 'STORE'` 模式添加进 `ZipWriter`，**物理绕过 JSZip 在内存中反复膨胀 (Inflate) 和二次压缩 (Deflate) 的巨大内存/CPU 开销**；
     - 仅对纯文本 Markdown、HTML、JSON 使用 `compression: 'DEFLATE'`；
     - 结合 200MB 内存防线与 `generateInternalStream` 流式分块生成 Blob，彻底杜绝大批量导出（1000+ 对话）时的浏览器标签页 OOM 崩溃；
  6. 写入器（`ZipWriter` 或 `FsWriter`）写入，`ProgressReporter` 实时计算吞吐量与 ETA，完成时调用 `StorageService.saveExportRecord` 持久化导出记录避免重复导出。

```mermaid
sequenceDiagram
    autonumber
    participant UI as Options 工作台 (View & ProgressView)
    participant Ctrl as ExportController
    participant Orch as ExportOrchestrator (AsyncQueue)
    participant Limit as RateLimiter
    participant Worker as BatchWorker
    participant Asset as AssetPipeline
    participant Format as ChatFormatter & htmlTemplate
    participant Writer as ZipWriter (JSZip STORE 流式防 OOM)
    participant Store as StorageService

    UI->>Ctrl: 用户选中 50 条会话，点击【导出选中 → ZIP】
    Ctrl->>Orch: runExport(selectedIds, options)
    Orch->>UI: 弹出全屏进度浮层 (ProgressView)
    loop AsyncQueue 并发调度 (Concurrency = 3)
        Orch->>Limit: 检查当前限流状态与退避间隔
        Limit-->>Orch: 允许派发任务
        Orch->>Worker: 分配单会话抓取与解析任务 (fetchChatDetail / resolveChat)
        Worker-->>Orch: 返回结构化会话详情 (RPC / Takeout 本地池)
        Orch->>Asset: 提取图片/附件列表并下载 Blob
        Asset-->>Orch: 返回附件二进制流及本地相对路径
        Orch->>Format: 组装 Markdown / 1:1 HTML / JSON (嵌入图片相对路径)
        Format-->>Orch: 输出格式化文档文本
        Orch->>Writer: 添加文件 (.md / .html / .json 与 assets/ 资源)
        alt 附件属于二进制图片 (isPrecompressedAsset)
            Writer->>Writer: 以 compression: 'STORE' 模式存入 (0 内存膨胀/0 CPU 压缩浪费)
        else 文本文件 (Markdown / HTML / JSON)
            Writer->>Writer: 以 compression: 'DEFLATE' 模式压缩存入
        end
        Orch->>Store: 单会话就绪即刻持久化 (StorageService.saveExportRecord)
        Orch->>UI: 回传进度与单条状态 (onItemExported 刷新列表)
    end
    Orch->>Writer: 写入全局导航索引 (index.md / index.html) 并完成打包 (generateInternalStream)
    Writer->>Writer: 保持在 200MB 安全内存水位内生成最终 Blob
    Writer-->>Ctrl: 返回 ZIP Blob 对象
    Ctrl->>UI: downloadHandler 触发浏览器底层下载 (a.download / blobUrl)
    Ctrl->>UI: 进度条完成，展示成功完成统计
```

---

### 3.4 Google Takeout 历史脱机合流数据流 (Takeout Offline Ingestion Flow)

本数据流支持导入官方 Google Takeout 归档压缩包，找回因网页端侧边栏约 600 条分页限制（代码常量 `GeminiProtocol.LIMITS.SLIDING_WINDOW = 500`）而丢失的早期远古会话。

* **数据源 (Data Source)**：
  - 用户拖入的官方 Google Takeout 导出的 `.zip` 文件；
  - 内部包含 `Takeout/Gemini/` 路径下的 HTML 对话文件与图片附件。
* **数据汇 (Data Sink)**：
  - `TakeoutEngine` 内部构建的脱机媒体索引池 `MediaIndex`；
  - `chrome.storage.local`：合流注入并打上 `titleSource: takeout` 标记；
  - Options 工作台会话列表：无需刷新即可呈现所有恢复的远古对话。
* **核心处理与容错逻辑**：
  1. `ZipBombGuard` 首先对压缩包进行安全审查：校验文件总数（≤10000）、压缩包体积（≤500MB）与解压后总尺寸估计（≤1GB），防范 Zip 炸弹 DoS 攻击（不做压缩膨胀率检查）；
  2. `takeoutParser` 迭代解压，`takeoutHtmlParser` 清洗 HTML 标签，提取初始提问前缀作为临时标题；
  3. `MediaIndex` 提取图片内部的 C2PA 元数据与时间戳，构建离线附件映射表；
  4. 调用 `MergeUtils` 执行脱机与在线历史合流，设定 `titleSource = 'takeout'`；
  5. 明确规定：后续若通过在线 RPC（Deep Scan）扫到了同一条会话的权威云端标题，在线权威数据将无缝覆盖 Takeout 临时标题（`takeout -> rpc` 升权规则）。

```mermaid
sequenceDiagram
    autonumber
    participant User as 用户交互
    participant UI as optionsTakeout.ts (DropZone)
    participant Ctrl as TakeoutController
    participant Guard as ZipBombGuard
    participant Parser as TakeoutParser & TakeoutHtmlParser
    participant Media as MediaIndex (C2PA 时间戳索引)
    participant SSoT as TitleUtils & MergeUtils
    participant Store as StorageService

    User->>UI: 拖拽 Takeout ZIP 文件至导入区
    UI->>Ctrl: handleTakeoutImport(file)
    Ctrl->>Guard: 执行安全性校验 (validateZipFile / validateZipEntries)
    alt 检测到超过条目数或解压体积安全阈值
        Guard-->>Ctrl: 抛出安全异常 (SecurityError)
        Ctrl->>UI: 显示安全拦截告警，安全终止
    end
    Guard-->>Ctrl: 安全审查通过
    Ctrl->>Parser: JSZip 载入并迭代解析 HTML (parseTakeoutZip)
    loop 逐个 HTML 对话解包
        Parser->>Parser: 提取提问轮次、时间戳与附件引用
        Parser->>Media: 提取图片 C2PA 时间戳并建立本地媒体缓存池
    end
    Parser-->>Ctrl: 返回解析出的会话集合 (含临时标题)
    Ctrl->>SSoT: mergeConversation (设置 titleSource = 'takeout')
    Ctrl->>Store: 批量保存至两级存储 (chrome.storage.local + IndexedDB)
    Ctrl->>UI: 实时刷新列表呈现恢复的远古会话
```

---

### 3.5 Popup 快捷操作与单篇导出数据流 (Popup Quick Export Flow)

本数据流负责在扩展工具栏弹窗中实现对当前正在浏览的单篇会话执行快速抓取与单篇文件（或含附件 ZIP）导出。

* **数据源 (Data Source)**：
  - 当前激活的 Gemini 标签页 URL 与会话元数据；
  - 本地存储与 IndexedDB 中已缓存或直接通过 RPC/DOM 抓取的完整多轮对话详情。
* **数据汇 (Data Sink)**：
  - 磁盘文件下载：单篇 `.md`、`.html`、`.json`（若包含图片附件则通过 `ExportEngine` 打包为含 `assets/` 的 `.zip`）。
* **核心处理与容错逻辑**：
  1. Popup 识别当前激活标签页 URL，提取 conversationId 与 slot；
  2. 用户切换格式标签（Markdown / HTML / JSON）并点击【导出当前页面】，Popup 调用 `fetchChat` / `getConversationDetail` 获取完整结构化会话；
  3. `ChatFormatter`（及 `htmlTemplate.ts`）将会话数据格式化为用户选定的目标格式（Markdown / 1:1 独立 HTML / JSON）；
  4. 通过页面 `<a download>` Blob URL 触发浏览器下载。

```mermaid
sequenceDiagram
    autonumber
    participant User as 用户点击
    participant Popup as popup.ts (Action Center)
    participant BG as background.ts
    participant CS as content.ts (Content)
    participant Format as ChatFormatter & htmlTemplate
    participant Down as 浏览器 Blob 下载 (a.download)

    User->>Popup: 选择格式 (Markdown / HTML / JSON) 并点击【导出当前页面】
    Popup->>BG: 发送 fetchChat / getConversationDetail
    BG->>CS: 转发获取会话详情
    CS-->>BG: 返回结构化会话数据
    BG-->>Popup: 回传会话数据
    Popup->>Format: 格式化文本 (.md / .html / .json)
    Format-->>Popup: 返回格式化内容 (含附件时打包 ZIP)
    Popup->>Down: 触发 Blob URL 文件下载
```

---

### 3.6 多账号真实身份嗅探、凭据隔离与严格路由数据流 (Multi-Account Identity Sniffing, Strict Credential Isolation & Tab Routing Flow)

本数据流负责在网页加载与正常使用过程中，安全嗅探真实的 Google 账号用户画像，彻底废除脆弱易变的 `u0/u1` 登录序号依赖，并实施严格的跨槽位凭据隔离与定向标签页通信。

* **数据源 (Data Source)**：
  - 页面 DOM 头像按钮与属性（`aria-label`、`data-email`、`data-identifier`）；
  - 页面初次加载时内嵌在 HTML 内的 `WIZ_global_data` 脚本变量（提取 `oTI7oc` 作为 Gaia ID）；
  - 页面发起的所有包含 `batchexecute` 的 XHR/Fetch URL 查询参数与请求体（含 `at`、`f.sid`、`bl`、`accountSlot`）。
* **数据汇 (Data Sink)**：
  - `accountSlots` 存储：`StorageService.updateAccountSlot(slot, profile)`，持久化真实邮箱、用户名与 Gaia ID；
  - 隔离区 `CredentialManager` 内部缓存；
  - `chrome.storage.session`（受保护的扩展会话存储，Service Worker 可直接读取）；
  - Options 工作台账号下拉框：直接渲染真实身份（如 `张三 (zhangsan@gmail.com) [u0]`）。
* **核心处理与容错逻辑**：
  1. `accountSniffer.ts` 从 DOM 标签与全局变量安全嗅探真实的 Google 账号身份，形成唯一的 `accountId`；
  2. `hookCredentials.ts` 运行于 MAIN World，对原生网络请求进行只读包装（Proxy/Monkey Patch），遇到任何异常均在 `try...catch` 中吞并；
  3. 提取出有效凭据后，通过 `window.postMessage` 派发自定义事件；
  4. 隔离区 `MessageBridge` 严格校验来源合法后解包数据，分别绑定至对应 `accountSlot`；
  5. **凭据防偷调与严格隔离机制**：
     - `CredentialManager.resolveCred(slot)` 实行单向封闭解析，若目标 Slot 无可用凭据直接返回空 Token，**严禁跨槽位偷用其他账号的 Token**，彻底消除串号 403 风险；
  6. **严格槽位标签页定向路由机制**：
     - `TabService.getGeminiTab(slot)` 与 `sendToGeminiTab(msg, slot)` 严格基于 URL 中的 Slot 进行过滤；若目标 Slot 的标签页未打开，**强制抛出明确错误**，绝不盲目回退到其他账号的标签页执行请求；
  7. **空账号状态防劫持**：
     - `ConversationsStore.loadStore(slot)` 保证在切换到 0 条会话的新账号时，绝不自动跳回 `u0`；
  8. 监视如果包含 `Proto.RPCS.DELETE` 删除事件，精准提取被删除的会话 ID 并通知 Options 工作台无需刷新实时剔除该项，实现瞬态删除与本地存储的一致性同步。

```mermaid
sequenceDiagram
    autonumber
    participant Page as Gemini 官方页面 (DOM & Context)
    participant Sniffer as accountSniffer.ts (Identity Sniffer)
    participant Hook as hookCredentials.ts (MAIN World)
    participant Bridge as messageBridge.ts (ISOLATED World)
    participant CredMgr as CredentialManager (Strict Isolation)
    participant Tab as TabService (Strict Tab Routing)
    participant Store as StorageService (Slot SSoT)
    participant UI as Options 工作台 (AccountView)

    Page->>Sniffer: 页面渲染头像与账号信息
    Sniffer->>Sniffer: 嗅探 aria-label, data-email, WIZ_global_data.oTI7oc
    Sniffer-->>Store: updateAccountSlot(slot, { email, name, gaiaId, accountId })
    Store->>UI: 渲染账号下拉列表 (展示 "姓名 (邮箱) [slot]")

    Page->>Hook: 发起网络请求 (batchexecute)
    Hook->>Bridge: window.postMessage(CrossWorldEvents.CREDENTIALS, { at, sid, slot })
    Bridge->>CredMgr: 保存当前 Slot 凭据映射 (slot -> cred)

    opt 用户在 Options 工作台对账号 Slot u1 发起操作
        UI->>Tab: sendToGeminiTab(action, slot='u1')
        Tab->>Tab: filterTabsBySlot(tabs, 'u1')
        alt 存在匹配 u1 的标签页
            Tab->>Page: 派发指令至 u1 专属标签页
        else 缺少 u1 标签页
            Tab-->>UI: 抛出异常: "未找到多账号 slot u1 对应的 Gemini 标签页"
            Note over Tab,UI: 绝对禁止盲目回退并向 u0 标签页派发错误指令
        end
        UI->>CredMgr: resolveCred(slot='u1')
        alt u1 拥有已认证凭据
            CredMgr-->>UI: 返回 u1 专属 Token
        else u1 凭据缺失
            CredMgr-->>UI: 返回空 Token (绝对禁止借调 u0 凭据，杜绝串号污染)
        end
    end

    opt 用户在网页端删除了某条会话
        Page->>Hook: 发送包含 GzXR5e (DELETE RPC) 的网络请求
        Hook->>Bridge: window.postMessage(CrossWorldEvents.CONVERSATION_DELETED, { id })
        Bridge->>UI: 触发本地两级存储剔除与列表 DOM 节点实时移除
    end
```

---

## 四、核心工程设计不变量 (Key Engineering Invariants)

在系统演进过程中，所有开发者与 AI 助手必须严格维护以下设计不变量：

1. **核心逻辑零 DOM 依赖与分层基线 (Zero DOM Baseline & Layered Browser API Policy)**：
   `src/core/` 按领域职责组织模块，其中不同子层对浏览器 API 的依赖边界有明确区分：
   - **严格零 DOM / 零浏览器 API 层（纯逻辑，可在任意 JS 运行时执行）**：响应解析器（`api/parser/*`）、格式化器（`chatFormatter`）、纯工具库（`titleUtils`、`mergeUtils`、`pathUtils`、`progressUtils`、`chipUtils`）、协议常量与类型定义（`protocol/*`）、Provider 接口规范（`aiProvider.ts`）。这些模块严禁导入或依赖任何浏览器专属变量（`document`、`HTMLElement`、`window`），确保可被纯 Node.js 单元测试直接加载验证。
   - **运行时基础设施层（允许浏览器标准 API，禁止 DOM 渲染操作）**：API 客户端（`api/client/*`：`credentialManager` 通过 `querySelectorAll("script")` 只读提取页面内嵌凭据、`rpcClient` 调用 `fetch` 发送 RPC 请求、`pagination` 读取 `window.__gemExporterAborted` 作为旧版中断兼容 fallback）、持久化存储（`storage/*`：使用 `chrome.storage.local`、`IndexedDB`）、文件写入器（`writers/*`：使用 `FileSystem Access API`）、标签页服务（`tabService`：使用 `chrome.tabs`）以及导出编排引擎（`exportOrchestrator`：直接导入 `tabService` 与 `fsWriter`，调用 `chrome.tabs` 与 FileSystem Access API 完成标签页协调与磁盘直写）。这些模块允许使用 `fetch`、`chrome.*`、`IndexedDB`、`FileSystem API` 等浏览器运行时标准 API，但**严禁执行任何 DOM 渲染行为**（`createElement`、`appendChild`、`innerHTML` 赋值、样式操作等），确保 UI 渲染职责完全归属 `src/ui/` 与 `src/content/` 层。
2. **严格的 UI 分层关注点分离 (Strict UI Separation of Concerns)**：
   - `state/`：单向数据流与响应式存储数据状态管理；
   - `views/`：无状态 DOM 模版生成、虚拟列表渲染与事件冒泡绑定；
   - `controllers/`：业务工作流驱动、异步操作编排与异常提示；
   - `options.ts` / `popup.ts`：纯粹的入口挂载器与各子模块协调器。
3. **权威单点真理与标题防退化 (Single Source of Truth - SSoT)**：
   所有的路径清洗规范（`sanitizeRelativePath`）、文件名生成规则（`buildExportFileName`）、多源标题仲裁（`resolveTitle`）与列表合并去重（`mergeConversation`）统一集中在 `src/core/utils/`。任何模块严禁自行手写正则或修改标题优先级，严格保证：`RPC 权威标题 > 详情提取标题 > 提问前缀临时标题 > Takeout 离线导入标题`。
4. **沙箱式网络拦截安全隔离 (Sandboxed Interceptor Guard)**：
   `hookCredentials.ts` 必须保证在主世界中的运行处于绝对安全的只读沙箱。拦截器内所有参数嗅探与字符串正则均包裹于 `try...catch` 中，遇到畸形参数时静默降级，严禁因插件逻辑异常影响 Google 原生网页的正常功能。
5. **事件驱动的并发工作池 (`AsyncQueue`) 与可中断轮询边界**：
   所有批量导出与下载均通过 `AsyncQueue` 任务队列驱动，结合 `RateLimiter` 指数退避状态机，智能规避 Google 接口的 HTTP 429 访问受限。`setInterval` 轮询仅允许**可中断、生命周期受控**的形式：① 内容脚本 15s 同步轮询（`pageObserver.startPeriodicSync`，经 `contentContext` 注册清理函数）；② `retryPolicy.interruptibleSleep` 的 50ms abort 标志轮询（仅无 `AbortSignal` 时的兜底，任务完成后自动清理）；③ 后台 `keepAlive` 20s Service Worker 保活心跳（`startKeepAlive` 返回清理函数，扫描/导出结束时停止）；④ 新手向导 `tourGuide` 的短时 UI 等待轮询（tour 结束时 `clearInterval`）。禁止无清理函数、无中断路径的野轮询。
6. **MV3 Service Worker 保活机制 (Keepalive Resilience)**：
   在耗时较长的大批量扫描或附件打包过程中，定期向后台派发轻量保活心跳，彻底解决 Chromium 浏览器可能在后台静默终止 Service Worker 导致导出任务异常中断的问题。
7. **两级存储架构与配额安全隔离 (Two-Tier Storage & Quota Isolation)**：
   `chrome.storage.local` 严格仅存轻量列表元数据索引（`id`, `title`, `timestamp`, `updatedAt`, `snippet`, `count`），严格限制在 10MB 配额安全水位以内。所有包含完整多轮提问、回复正文与媒体附件的会话实体（`turns`）必须通过两级存储引擎下沉持久化至 IndexedDB `conversationDetailStore`，杜绝任何因会话增长导致扩展整体崩溃的数据截断。
8. **无头环境写盘降权优雅检测 (Headless FileSystem Permission Resilience)**：
   Service Worker 处于无头环境，在浏览器重启后目录句柄权限降权为 `prompt` 时，Chromium 机制物理禁止其直接请求权限。此时 `handleLiveSaveViaHandle` 返回 `{ ok: false, error: 'permission_prompt_needed' }` 并写入 live 配置（`dirError`）；内容脚本 `liveSaveCoordinator` 根据返回值触发徽章警告，用户手势经 `reauthorizeDirHandle()` 一键恢复物理直写。不存在 `DIR_HANDLE_PERMISSION_DEGRADED` 广播事件，也没有 Downloads API 兜底。
9. **多账号单向隔离与凭据零借调 (Multi-Account Strict Isolation & Zero Token Stealing)**：
   系统的账号体系以真实 Google Profile（邮箱与 Gaia ID）为锚点。各账号 Slot 之间具有完全物理隔离的凭据命名空间与会话空间，严禁跨槽位借调或回退 Token；跨标签页指令分发必须严格匹配当前激活账户的 Slot，若目标标签页不存在必须显式抛错拦截，绝不向不匹配账号的页面盲投任何 RPC 指令。

---

## 五、三层测试体系架构 (Three-Tier Testing Architecture)

本项目严格区分并建立了分层互补的三层测试体系，保障从秒级代码审查到真实端到端链路的全面稳定性：

```mermaid
flowchart TD
    subgraph Tier1 ["第一层：CI 自动化极速门禁 (Tier 1: Fast & Headless Gate)"]
        T1_Type["TypeScript 严格类型检查 (tsc --noEmit)"]
        T1_Unit["Python 驱动 103 个核心单元与系统测试套件 (tests/run_tests.py)"]
        T1_Build["esbuild 5 大 Bundle 纯打包校验 (node build.js)"]
        T1_E2E["Playwright 16 个 Spec / 38 个无头集成测试 (playwright test)"]
        T1_Type --> T1_Unit --> T1_Build --> T1_E2E --> T1_PASS["CI 门禁通过 (~20-40秒)"]
    end

    subgraph Tier2 ["第二层：真实调试 Chrome 全流程实跑 (Tier 2: Live Debug Staging)"]
        T2_Chrome["启动调试端口 Chrome (9222 端口)"]
        T2_Pool["20 题多模态动态场景池 (--pool 消费与自动补仓)"]
        T2_DAG["DAGRunner 拓扑依赖调度器 (19 大特性生命周期闭环)"]
        T2_Assert["ExportSpecificationAsserter (物理解压 ZIP 逐字与多模态黄金断言)"]
        T2_Chrome --> T2_Pool --> T2_DAG --> T2_Assert
    end

    subgraph Tier3 ["第三层：纯视觉 AI 盲测与自主质检 (Tier 3: Pure Visual Agent)"]
        T3_Perceive["纯截屏感知 (0 DOM 树泄露 / 硬件级鼠标键盘物理驱动)"]
        T3_Agent["看-想-动-验 自主闭环推演与自愈引擎"]
        T3_Vision["Gemini Vision 多模态模型在线质检"]
        T3_Report["生成 visual_audit_report.html 与 Scorecard"]
        T3_Perceive --> T3_Agent --> T3_Vision --> T3_Report
    end
```

### 1. 快速日常与门禁命令速查
- **运行 CI 全量门禁**：`npm test`
- **运行变更依赖感知增量测试（推荐日常秒级调试）**：`npm run test:changed`
- **查看依赖变更影响拓扑**：`npm run test:impact`
- **运行单点定向测试**：`python3 tests/run_tests.py --filter <keyword>`
- **启动测试专用 Chrome**：`./scripts/open_test_chrome.sh`
- **运行 Tier 2 场景池实跑测试**：`npm run test:live:pool`
- **运行 Tier 3 纯视觉自主审查**：`npm run test:visual:review`

---

## 六、已知未实现项 (Known Unimplemented Items)

以下两项为审计建议（P2-7、P2-8），经决策**明确标记为未实现**，文档如实记录、不写功能代码：

1. **P2-7 — 网页自身 protobuf 解码结果对照验证（未实现）**：
   审计曾建议插件调用或静态复用 Gemini 网页自身的 protobuf/JSPB 处理代码，并用网页解码结果交叉验证自研解析器输出。
   现状：解析器仍为自研实现（`src/core/api/parser/*`），没有接入网页自身解码管线做对照验证。该能力需要稳定的网页端钩子与结果比对框架，暂不排期。
2. **P2-8 — 导出会话断点续传（未实现）**：
   现状只有导出会话的状态记录（`sessionStore`：`status`/`lastExportedBefore` 等）与失败落盘，没有基于进度的断点续传能力。
   中断后重跑依赖增量扫描与导出记录去重跳过，而非从精确断点恢复。如需实现，需先定义可恢复的进度水位语义（与 P2-1 的 `stoppedEarly` 语义联动），暂不排期。
