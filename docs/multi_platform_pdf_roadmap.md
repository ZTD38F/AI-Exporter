# Gemini Exporter：长期路线图与可执行实施方案

> 版本：第二版，2026-09-25
>
> 状态：设计与实施计划。本文描述目标、实验和验收门槛；尚未宣称这些功能已经实现。
>
> 适用范围：商店版 Chrome MV3 扩展；Gemini 稳定性治理；多平台本地归档；Markdown、HTML、PDF 等本地导出；ChatGPT 与 PDF 两条并行路线。

## 0. 如何使用这份计划

每个里程碑都有前置条件、要做的事、提交物和可否进入下一步的判定。没有完成上一个共享契约里程碑，ChatGPT 与 PDF 不能各自发明身份、消息结构和文件格式。实验结果可能否定候选技术；这时按文中的回退路径处理，不以“应该可行”代替实测。

本文中的“本地”是指会话内容、附件、归档和 PDF 的解析与生成在用户设备完成；从 AI 平台同步数据仍需访问对应网站。扩展不将对话上传至本项目服务器，不要求用户安装桌面程序，不使用调试权限或系统打印对话框生成 PDF。

“完整”必须说明**相对哪个数据源和观察范围**。校验文件哈希只能证明备份文件未损坏，不能证明平台没有隐藏其他会话。界面和报告应分别列出：已发现、已获取详情、已保存资源、已验证、失败、来源无法判定的数量，不作无证据的“零遗漏”承诺。

## 1. 长期目标与路线图

### 1.1 长期产品目标

一个用户只需要安装一个导出器，就能从已支持的 AI 平台获取自己的会话，导入平台官方数据包，把完整可取得的内容留在本地，并随时输出可阅读、可迁移、可重新导入的文件。新增平台时，重点是该平台数据的覆盖深度和可验证程度；新增格式时，不重新抓取数据。

稳定的产品不变量：

1. **多平台**：至少按 Gemini、ChatGPT 及后续平台扩展；每个平台的能力和限制分别披露，不使用一个模糊的“支持”勾选框。
2. **多格式**：Markdown、HTML、PDF 来自同一份结构化内容；还保留机器可读的版本化归档。格式差异不能改变会话身份、顺序和附件清单。
3. **本地优先**：归档、索引和渲染均在本地。扩展 IndexedDB 是工作库；用户可带走并重导入的归档包是持久备份。
4. **可验证**：同步、归档、恢复与导出都有独立证据。资源缺失、协议漂移和未知内容不得静默丢弃。
5. **有限范围**：搜索、筛选和集合可以服务于“找到并导出自己的历史”；不把提示词市场、聊天增强工具或平台内文件夹当作核心方向。

### 1.2 长期路线图

| 阶段 | 里程碑 | 核心交付物 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| S0 可信基线 | 现有 Gemini 与测试结果可信 | 旧数据/导出样本、修正的 Tier 2/3 状态语义 | 人为故障均不能假绿；Gemini 全量 Tier 1 通过 |
| S1 共享基础 | 身份、来源和内容模型收口 | 复合身份、最小 Block AST、版本化归档规范、渲染器契约 | 旧 Gemini 数据无损迁移；归档导出/重导入往返通过 |
| S2 并行开发 | ChatGPT 与 PDF | 两条路线按第 5、6 节独立推进 | 各自实验门通过；共享契约不分叉 |
| S3 首次合流 | 双平台、本地多格式 | Gemini/ChatGPT 混合归档；Gemini/ChatGPT × MD/HTML/PDF 能力矩阵 | 受支持组合均通过内容、身份和资源验收 |
| S4 归档体验 | 可检索、可验证、可恢复 | 本地全文索引、归档健康报告、恢复/迁移指南 | 换设备重导入后无需访问原平台仍能浏览和重新导出 |
| S5 更多平台 | 按平台逐个深入 | 下一个 Provider、官方导入器、覆盖报告 | 每个平台通过独立的发现、详情、附件和归档深度门槛 |

S4 的搜索索引是归档的可重建派生数据，不是第二份事实来源。S5 不预设平台数量；一次只承诺已经通过验收的能力。

## 2. 当前仓库起点

| 位置 | 已有能力 | 需解决的具体问题 |
| --- | --- | --- |
| [Provider 接口](../src/core/provider/aiProvider.ts) | 注册表、Gemini 实现。Provider interface remains the extension seam. ChatGPT / Claude / Grok adapters will be implemented only when their real production payloads are integrated and verified. | 接口中的任意类型和网站内部请求未形成稳定契约 |
| [会话类型](../src/types/conversation.ts) | 共享的 Conversation、Message、Attachment 类型 | 正文仍以字符串为主；平台字段混入通用模型；缺少可保留未知块的 AST |
| [存储服务](../src/core/storage/storageService.ts) 与 [明细库](../src/core/storage/conversationDetailStore.ts) | 元数据与详情分层，已有迁移框架 | Gemini 风格键和裸 ID 尚不能保证跨平台、跨账户隔离 |
| [HTML 模板](../src/core/engine/template/htmlTemplate.ts) | 离线 HTML 与打印 CSS | 直接解析 Markdown 字符串，含交互和懒加载资源；不能直接作为 PDF 事实来源 |
| [格式入口](../src/core/engine/chatFormatter.ts) 与 [Writer](../src/core/engine/writers/writerInterface.ts) | 现有 MD/HTML/JSON；Writer 已接受 Blob 等二进制 | Formatter 返回字符串；PDF 需要异步渲染产物；导出状态要按格式和内容版本记录 |
| [打包脚本](../build.js) 与 [manifest](../manifest.json) | 五个生产 IIFE bundle | PDF 的 Worker、WASM、字体必须进入构建与商店包，并验证 MV3 CSP |
| [Tier 2 DAG](../scripts/framework/cases/base.py) 与 [Tier 3 Agent](../scripts/visual_agent/agent.py) | 真实环境与纯视觉测试基础 | 必测项与跳过语义、Agent DONE 独立验收尚需修正 |

## 3. 长期架构图与关键契约

### 3.1 数据与导出架构

~~~mermaid
flowchart LR
    subgraph Inputs[平台与输入]
      G[Gemini 在线]
      C[ChatGPT 在线]
      O[官方数据包]
      A[旧版归档包]
    end
    Inputs --> PA[Provider / Import Adapter]
    PA --> OBS[来源观察记录与原始证据]
    PA --> CM[统一会话模型 + Block AST]
    OBS --> REPO[本地 Repository]
    CM --> REPO
    REPO --> IDX[可重建搜索索引]
    REPO --> ARC[版本化可携带归档]
    ARC --> VERIFY[校验 / 重导入 / 恢复]
    REPO --> PIPE[导出任务编排]
    PIPE --> MD[Markdown Renderer]
    PIPE --> HTML[HTML Renderer]
    PIPE --> PDF[PDF Renderer]
    MD --> WR[ZIP / 文件夹 Writer]
    HTML --> WR
    PDF --> WR
~~~

模型与归档的关系：**统一模型定义内容语义，版本化归档保存该模型、可取得的原始证据和附件；IndexedDB 保存供扩展使用的工作副本。** 从归档重建工作副本时，不允许因旧缓存而覆盖较完整的历史。原始平台负载不直接暴露给渲染器；保留它是为了诊断或将来重新解析未知内容。

### 3.2 最小数据契约

| 契约 | 必含字段或行为 | 明确禁止 |
| --- | --- | --- |
| ConversationKey | providerId、稳定的 accountId、平台原始 conversationId | 在所有平台上统一去掉 ID 前缀；仅用会话标题作为身份 |
| SourceObservation | 来源类型、抓取/导入时间、请求范围、游标/批次、原始条数、已解析条数、错误与未知字段 | 仅凭本地存量宣称平台全量 |
| Conversation | key、标题候选和来源、服务端时间与观察时间、消息树、平台扩展、schemaVersion | 用当前时间伪装未知服务端时间 |
| Message | 稳定节点 ID、角色、顺序/父子关系、内容块、时间、附件引用、平台扩展 | 把 ChatGPT 分支强行压平成唯一线性历史且丢弃其他分支 |
| Block AST | text、heading、list、code、table、math、image、file、citation、thought/tool、unknown 的最小可扩展集合 | 把 HTML、Typst 源码或 PDF 字节存作唯一正文 |
| Asset | 原始引用、可选本地实体、MIME、大小、哈希、获取状态和失败原因 | 无实体却声称附件已保存 |
| ExportArtifact | 文件名、MIME、string/Blob/Uint8Array 内容、关联资源和诊断 | 渲染失败时返回空文件并标记成功 |
| ExportRecord | ConversationKey、格式、内容修订、完成时间、目标和写入状态 | 导出过 HTML 就自动认为 PDF 已导出 |

Block AST 以用户提供的 `gemini-exporter-rendering-contract-v1.zip` 中 `canonical/` 为开发基座，具体采用和加固项见 [Rendering Contract v1 接入方案](./pdf_rendering_contract_integration.md)。它先覆盖 Gemini 与 ChatGPT 已知的高价值内容；未知块保留原始片段和来源标识，并保证渲染时可读回退。旧会话正文迁移时保留原字符串，同时生成 AST；转换失败仍保留原文并记录诊断。不要在一次 PR 中强迫所有旧数据重写。

### 3.3 可携带归档与完整性

归档 v1 建议是本地 ZIP，至少包含版本化 manifest、会话记录、来源观察记录和 assets 目录。manifest 记录 schemaVersion、生成器版本、平台/账户范围、会话与资源计数、每个条目的 SHA-256、失败/未知计数。平台原始负载在许可和可取得的范围内作为可选 raw 条目保留；导入器不依赖 raw 才能阅读已规范化内容。

导出归档时先写临时结果，再生成清单并完成 ZIP；成功后才更新备份状态。重导入先验证版本、文件路径安全、哈希和大小限制，再合并数据。任何资源缺失、哈希错误或不支持的未来 schema 都要停止相应写入并给出报告。归档往返必须经过全新扩展配置/空数据库测试；卸载扩展后原平台不再可访问的会话仍能从归档恢复。

完整性报告分三层：**文件完整**（哈希/结构）、**已发现对象完整**（列出的会话和已声明资源都落地）、**来源覆盖范围**（分页/官方包/实时观察的范围与未知项）。第三层可能是 UNKNOWN，不得被前两层的 PASS 覆盖。

### 3.4 Chrome MV3 运行边界

现有 Options 页面可作为首版批量任务的用户界面，PDF 计算放在扩展内的 Worker 或受控扩展文档；不能在 Gemini/ChatGPT 网页主线程做重排。首版产品契约是“Options 页面保持打开时静默批量生成；关闭页面后任务可明确中断并在重开后恢复未完成项”。后台持续运行属于后续独立能力，不作为首版的暗含承诺。

若实验改用 offscreen document，需验证它只支持 runtime 扩展 API 的限制，以及大 Blob 如何避免多次跨上下文复制。WASM、字体、模板和 Worker 脚本必须随扩展包提供；生产运行时不请求 CDN。WASM 路线需要在 manifest 的扩展页 CSP 中显式允许 wasm-unsafe-eval，并用最终商店包实测。依据：[Chrome CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)、[offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)。

## 4. 并行开发前的共享里程碑

| 里程碑 | 工作与交付物 | 自动验收与退出门 |
| --- | --- | --- |
| F0 可信测试 | 锁定脱敏旧数据/导出夹具；Tier 2 必测能力改为 PASS/FAIL/BLOCKED/NOT_APPLICABLE；Tier 3 靶场与正式门禁分开；场景池领取和结果提交分离 | 故意令关键断言失败、缺少环境、Agent 立即 DONE，三种情况均不能退出 0；完整 Tier 1 通过 |
| F1 复合身份 | 定义 ConversationKey；存储、明细、附件、导出状态、游标、UI 选择统一键；分步兼容旧 Gemini 数据 | Gemini/ChatGPT 相同原始 ID、两个账户相同原始 ID 均不串号；旧数据重复迁移幂等；失败时保留旧键 |
| F2 最小 Block AST | 接入并加固包内 canonical 类型/Schema/示例；共享树校验与分支投影、标题权威、未知回退；Gemini 规范化；旧字符串渐进转换；MD/HTML 先消费 AST | 固定夹具中的文本、代码、公式、表格、图片、思考内容和顺序与现有导出一致；HTML/PDF 同一分支；未知块可往返 |
| F3 归档 v1 | ZIP manifest、会话、来源观察、assets、哈希、版本和导入/合并流程 | 全新空库重导入后身份、消息树、资源及哈希一致；损坏包拒绝且不污染现有库 |
| F4 扩展契约 | Provider、Repository、Renderer、Writer 类型边界；格式注册表；异步二进制产物；平台能力 UI | 假 Provider 不改编排器即可导出；假 Blob Renderer 不改 Writer 即可写 ZIP/文件夹；Gemini 旧行为全绿 |

F2 与 F3 是长期“只装一个导出器”的前置工作，不应延迟到 ChatGPT 和 PDF 分支各自实现。F4 完成后冻结版本化契约；ChatGPT 与 PDF 才开始并行。确需修改共享契约时，先做独立基础 PR，两条分支同步后继续。

**风险前探不必等到 F4。** F0 后可用一次性、不得进入产品菜单的原型先回答两个高风险问题：普通扩展环境能否读取少量 ChatGPT 会话；本地打包的 Typst WASM 能否在 MV3 中离线生成含中文的 PDF。前探记录原型版本、打包方式、权限和失败信息。它只用于避免把基础架构建在错误假设上，不能替代 C0/P0 的完整对照实验和发布门槛。

## 5. ChatGPT 路线：实验、里程碑、验收

ChatGPT 要分别验证**官方数据包导入**和**在线同步**。前者可独立发布；后者必须在真实扩展权限与普通登录环境中证明可用。Provider interface remains the extension seam. ChatGPT / Claude / Grok adapters will be implemented only when their real production payloads are integrated and verified.

### C0：在线采集可行性实验（任何在线实现前）

**问题**：普通已登录 Chrome 中，商店版可申请的最小站点权限是否足以稳定获取会话列表、分页、详情和附件？用户退出、接口限流、响应形状变化时能否诚实失败？

**实验步骤**：

1. 在独立测试配置中打开 ChatGPT 权限，仅用扩展可用 API 发起请求；不把测试用 CDP/9222、开发者工具或页面控制台能力算作产品能力。
2. 用脱敏的测试账号构造至少 30 个已知会话，包括编辑/分支、归档会话、带图片/文件的会话和长会话；记录网页可见清单作为对照。
3. 连续运行两次完整列表分页及抽样 10 个详情；记录 HTTP 状态、游标、重复/漏项、响应字段与耗时。再分别模拟会话失效、403、429、网络中断与未知字段。
4. 以最低权限构建生产格式 ZIP，在干净 Chrome 配置中复验；记录实际安装权限提示和构建包内容。

**提交物**：脱敏响应夹具、发现/详情覆盖矩阵、接口变化风险清单、权限清单、明确的 GO/NO-GO 决策记录。**通过门槛**：30 个已知会话均被发现且无重复；抽样 10 个详情消息顺序可核对；异常不产生空会话或“成功同步”；无需调试权限。未通过则 C3 暂停，C1 官方数据包路线继续。

### C1—C5：交付里程碑

| 里程碑 | 具体实现 | 提交物 | 验收标准 |
| --- | --- | --- | --- |
| C1 官方数据包导入 | 解析实际导出 ZIP；保留会话树、当前分支、编辑版本、时间、附件引用和未知字段；同一包重复导入去重；大包防解压炸弹 | 导入器、脱敏夹具、解析报告 | 20 个覆盖分支/附件/空节点的固定会话与原包核对；重复导入计数不变；坏包不改库；归档往返通过 |
| C2 工作台接入 | 平台/账户筛选、会话来源标识、离线会话阅读、现有 MD/HTML 导出；权限与能力按实际状态展示 | UI、Provider 契约测试 | Gemini 与 ChatGPT 同 ID 不串号；C1 会话可在断网时阅读和导出；Gemini 原功能回归通过 |
| C3 在线只读同步 | 在 C0 GO 后实现列表、分页、详情、取消、限流退避、断点恢复和协议漂移检测；来源观察写入归档 | 在线 Adapter、诊断和 Tier 2 场景 | 已知 30 会话发现和详情完整；第二次同步不重复；中断后续跑；403/429/漂移为失败或 BLOCKED |
| C4 附件与实时能力 | 分别验证附件实体、归档会话、流式更新及删除感知；每项单独能力开关 | 各能力实现与覆盖报告 | 缺附件标为 partial；网页删除不能抹掉已归档副本；未通过的能力保持关闭 |
| C5 发布门 | 打包、权限、隐私文本、双平台混合导出和迁移回归 | 发布候选构建与能力矩阵 | Gemini/ChatGPT 已声明支持的组合均通过 Tier 1 与对应 Tier 2；不宣称 C0 未证实的能力 |

ChatGPT 官方导出可作为 C1 输入，但不同账户/工作区的导出可用性不同，不能把它当成所有用户的唯一入口。依据：[OpenAI 数据导出说明](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data)。

## 6. PDF 路线：对照实验、里程碑、验收

Block AST、HTML 共用层、v8 视觉迁入及逐批交付任务见 [PDF 导出专项执行方案](./pdf_export_implementation_plan.md)；`gemini-exporter-rendering-contract-v1.zip` 的采用边界、缺口与节点映射见 [Rendering Contract v1 接入方案](./pdf_rendering_contract_integration.md)。

PDF 的产品要求是本地、无打印对话框、可批量、文字可选择/搜索、资源可追踪。Typst v8 是视觉基准和首个实验实现；**产品运行引擎仍由 P0 选定**。Block AST 与归档格式不随引擎改变。

### P0：引擎与运行容器对照实验

**候选**：A 以包内 Typst v8 模板和 AST adapter 为起点，补随包提供的 JS/WASM/字体编译链；B 为随包提供代码和字体的文档式 JS PDF 引擎，例如 pdfmake。每个候选都从同一已验证、已投影的 Block AST 生成 PDF，并使用同一测试夹具和运行机器。Typst 浏览器示例能生成 PDF，但其默认示例可从 CDN 取代码/WASM/字体，因此不能直接证明离线 MV3 可用：[typst.ts 项目](https://github.com/Myriad-Dreamin/typst.ts)、[浏览器 PDF 示例](https://github.com/Myriad-Dreamin/typst.ts/blob/main/github-pages/preview.html)。pdfmake 的浏览器接口可取得 Blob，但复杂内容仍需实测：[pdfmake 方法文档](https://pdfmake.github.io/docs/0.3/getting-started/client-side/methods/)。

**固定样本**：至少 12 份脱敏会话，覆盖中英混排、CJK 标点、emoji、行内/块级公式、代码换行和长代码、宽表与跨页表、引用和链接、图片及其归属、附件卡片、缺失资源、单份超长会话、未知块。另生成 100 会话/至少 2,000 消息/50 MiB 附件的批量压力集，并保留小样与压力集的输入清单和哈希。

**按顺序做实验**：

1. 固定候选版本，记录许可证、依赖、字体来源及压缩包增量；禁止运行时 CDN 请求。
2. 为每个候选实现仅够 12 份样本运行的独立原型，不接入正式格式菜单。用项目现有 build.js 打包成实际 MV3 扩展 ZIP，确认 Worker/WASM/字体都进入包。
3. 在干净 Chrome 配置、断网环境下运行；记录 CSP、WASM 初始化、字体加载和安全限制。若需要 wasm-unsafe-eval，只允许 Chrome 官方规定的扩展页策略；不放宽到远程脚本或通用 eval。
4. 用 PDF 解析工具提取文本、链接、图片和页数，检查全部唯一消息标记及顺序；渲染各代表性页面进行视觉检查。检查无法显示的字形、截断、空白页和文件损坏。
5. 在同一固定机器上运行压力集 3 次，记录总耗时、峰值额外内存、失败数、输出大小和取消/重试行为。首轮目标：100 会话全部完成、无崩溃/空白文件、10 分钟内完成、峰值额外内存不超过 512 MiB、压缩商店包新增不超过 30 MiB。超预算须有单独决策记录，不得静默放行。

**GO 门槛**：两种候选中至少一种通过离线 MV3、12 份内容完整、文字可搜索、CJK 字形、100 会话压力测试和产品权限约束。选择时按完整性与可靠性、包体积、性能、维护难度排序；排版相似度排在其后。若都不通过，P1—P4 停止；记录失败原因，先缩小 PDF 首版内容范围或另选本地文档引擎，再重跑 P0。截图式 PDF 不算通过。PDF/A 是单独的后续目标，不冒充首版能力。

### P1—P5：交付里程碑

| 里程碑 | 具体实现 | 提交物 | 验收标准 |
| --- | --- | --- | --- |
| P1 AST → PDF 文档 | 以包内 adapter/v8 模板为 Typst 实现起点；扩展嵌套列表、多表头/合并单元格等缺失节点；统一转义与资源引用、可读回退和降级诊断；Typst 源仅是临时产物 | PDF Renderer、节点覆盖矩阵、12 份黄金样本 | 同一分支的全部消息块顺序及唯一文本标记存在；文字可提取；未知块、结构降级和缺资源不会无声消失 |
| P2 本地运行容器 | Options 页面启动受控 Worker/扩展文档；离线加载引擎/字体；构建与 --pack 纳入资源；记录许可证 | 商店格式扩展 ZIP、运行与权限记录 | 干净配置断网运行；无调试/打印对话框/本机程序；无远程代码和资源请求 |
| P3 批量任务接入 | 采用已有 Writer 写 Blob；每会话有限并发、进度、取消、失败隔离、任务日志及重开页面后的重试；按格式与内容修订写 ExportRecord | ZIP/文件夹 PDF 输出、任务清单 | 100 会话压力集过 P0 预算；中途关闭页面后的未完成项不标成功且可续跑；单会话失败不损坏其他文件 |
| P4 自动内容审计 | 解包后检查 PDF 可解析、文本标记/顺序、图片实体、页面异常和格式来源；加入真实扩展流程 | Tier 1 固定夹具、Tier 2 落盘断言、Tier 3 视觉报告 | 任意故意删除一轮消息或一张必需图片，测试必须失败；Agent DONE 无法绕过宿主 PDF 断言 |
| P5 发布门 | 打包体积、许可证、隐私文案、中文字体和多平台样本回归 | 发布候选与用户说明 | Gemini 与 C1/C2 已支持的 ChatGPT 内容均能本地生成 PDF；能力限制对用户清晰可见 |

首版“静默”表示用户在工作台点击批量导出后不逐份确认；页面保持打开。若以后要求关掉工作台后仍继续，另立运行生命周期实验，不把 offscreen document 当成现成后台 PDF 引擎。

## 7. 两条路线如何真正并行

~~~mermaid
flowchart LR
    F0[F0 可信测试] --> F1[F1 身份]
    F1 --> F2[F2 Block AST]
    F2 --> F3[F3 归档 v1]
    F3 --> F4[F4 Provider/Renderer 契约冻结]
    F4 --> C0[C0 ChatGPT 实验]
    F4 --> P0[P0 PDF 实验]
    C0 --> C1[C1-C5 ChatGPT]
    P0 --> P1[P1-P5 PDF]
    C1 --> INT[双线集成与发布]
    P1 --> INT
~~~

并行期间，ChatGPT 工作只修改平台适配、导入器、平台权限和平台 UI；PDF 工作只修改 PDF 渲染、字体/WASM 打包与格式菜单。共享 Block AST、归档 schema、Writer 和 ExportRecord 不允许两条分支私自演化。发现缺失字段时，提交单独的共享契约 PR，附 Gemini/ChatGPT/MD/HTML/PDF 影响评估后再继续两边。

可分别发布：C1+C2 通过即可发布 ChatGPT 离线导入；P1—P5 通过即可发布 Gemini PDF；C3 在线同步与 ChatGPT PDF 的正式组合待各自门槛通过后开放。界面按真实能力矩阵显示，而非“平台支持/不支持”的单一布尔值。

## 8. 测试、验收矩阵与发布门禁

| 维度 | 固定组合 | 必查证据 |
| --- | --- | --- |
| 身份 | Gemini/ChatGPT × 两个账户 × 同原始 ID | 列表、明细、资源、导出记录、删除互不影响 |
| 来源 | 在线同步、平台官方 ZIP、旧归档重导入 | SourceObservation、范围和未知项、重复导入结果 |
| 内容 | 文本、分支、代码、公式、表格、图片、文件、未知块 | Block AST、原始引用、渲染输出和缺失报告 |
| 格式 | MD、HTML、PDF、归档 ZIP | 顺序、标题、附件、哈希、可解析性、离线再导出 |
| 故障 | 网络中断、403/429、资源失败、取消、页面关闭、损坏归档 | 明确 FAIL/BLOCKED/PARTIAL；不得标记已完成 |

- **Tier 1**：每 PR 运行 npm test；增量测试只作为本地反馈。新增迁移、AST、归档、Provider、PDF 样本和跨格式契约断言。构建变更验证 node build.js --pack 的真实产物清单。
- **Tier 2**：对真实网站和扩展安装流程声明必测能力；断网、账号失效为 BLOCKED/FAIL。宿主检查磁盘上的 ZIP、PDF、manifest 和来源报告，而非仅检查 UI 文案。
- **Tier 3**：Agent 仍只看截图和操作 UI；功能通过由 Tier 2 可复用的独立验收器决定。视觉体验评分另列，不作为消息完整性的证明。
- **发布候选**：S1 数据迁移、C0/P0 决策记录、平台 × 格式矩阵、隐私/许可/CSP、升级与重导入、取消/重试和真实商店包必须齐备。门禁未运行记 BLOCKED，不写“已通过”。

## 9. 推荐 PR 切分与每批完成定义

1. F0a：Tier 2 必测项、跳过语义和机器可读报告。
2. F0b：Tier 3 靶场/门禁分离与宿主独立验收。
3. F0c：场景池事务、增量测试回退及 CI 文档校准。
4. F1a：ConversationKey 与旧数据兼容读取。
5. F1b：存储/详情/导出记录迁移及跨账户回归。
6. F2a：从 rendering contract 包接入 canonical 类型/Schema/示例，补树校验、共享分支投影、标题权威、UnknownBlock 可见回退和旧正文兼容转换。
7. F2b/F2c：Gemini 规范化；以包内 HTML renderer 为骨架完成 MD/HTML AST 渲染、离线资源和旧 HTML 内容/视觉/交互等价回归。
8. F3a：归档 v1 写出、manifest/哈希和来源报告。
9. F3b：归档验证、全新库导入与恢复。
10. F4a：Provider/Repository 契约及 Gemini 专用逻辑回迁。
11. F4b：异步 ExportArtifact、格式注册表、假 Provider/Renderer 验收。
12. C0 与 P0：分别提交完整实验代码和决策记录；原型不得直接开放给用户。F0 后的风险前探可提前进行，保留独立记录。
13. C1—C5 与 P1—P5：每个里程碑一个或少量可独立回滚的 PR。
14. S3 集成：跨平台、跨格式、升级、归档往返与发布候选回归。

每个 PR 描述必须回答：影响的契约版本、旧数据处理、失败后的用户状态、测试命令及结果、未覆盖场景。迁移和归档 PR 必须附恢复路径。遵循仓库 [AGENTS.md](../AGENTS.md) 的 worktree、PR、自动合并及主目录同步流程。

## 10. 当前未作的技术决定

| 决定 | 现在的状态 | 在哪里决定 |
| --- | --- | --- |
| PDF 引擎是 Typst WASM 还是 JS 文档引擎 | 未选定 | P0 同夹具、同 MV3 包、同设备实验 |
| ChatGPT 在线采集路径是否可靠 | 未证实；现有模块休眠 | C0 最小权限与真实账号实验 |
| PDF 工作台关闭后是否继续运行 | 首版不承诺；支持中断后续跑 | 后续独立生命周期实验 |
| 更多平台的优先顺序 | 未预定 | S3 后按用户问题与数据深度评估 |
| 可搜索本地 library 的索引实现 | 搜索是归档派生能力 | S4，以可重建和不联网为门槛 |

当前最先执行 F0，并同步做上述两个风险前探。F1—F4 完成后再运行使用统一模型和真实商店包的 C0/P0 完整实验；早期原型只能证明局部 API 可用，不能作为发布实现。
