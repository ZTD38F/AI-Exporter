# PDF 导出专项执行方案：Block AST → Typst v8 视觉 → PDF

> Status: SUPERSEDED
>
> This maintenance/implementation plan has been completed/re-audited.
> Do not treat unchecked historical items as active backlog.
> See CURRENT_ARCHITECTURE.md and the Post-Maintenance Closeout decision.

> 历史状态（2026-09-26）：**D0 PASS · D1 PASS · D2 PASS · D3 PASS · D4 PASS · D5 PASS · D6 PASS · D7 PASS · D8 PASS**（本专项全链路已合流完成）
>
> 生产 PDF 引擎（Production PDF engine）：**Typst WASM**（`@myriaddreamin/typst.ts` 生态），扩展内本地编译。
>
> 范围：先交付 Gemini 会话的本地 PDF 导出，同时建立与现有 HTML 导出共用的内容层。多平台身份、可携带归档及跨平台发布门槛遵循[长期路线图](./multi_platform_pdf_roadmap.md)；本文细化其中 F2/F4、P0–P5 的 PDF 工作。

**开发基座已明确**：用户提供的 `gemini-exporter-rendering-contract-v1.zip` 覆盖 canonical AST、Typst v8 适配器与模板、AST HTML renderer。采用范围、必修差异、逐节点映射和 PR 次序见 [Rendering Contract v1 接入方案](./pdf_rendering_contract_integration.md)。正式字段以接入并加固后的版本化 canonical 契约为准，不建立第二套 AST。

## 1. 本次确定的产品契约

1. 每个会话生成一份可搜索、可选择文字的 PDF。批量结果沿用现有 ZIP 或本地目录 Writer；首版不合并为一本巨型 PDF。
2. 生成全程在扩展本地完成，不上传对话，不调用系统打印对话框，不要求用户安装 Typst CLI。在线同步会话和获取远程附件仍需访问原平台。
3. PDF 使用 `typst_conversation_renderer_v8` 的视觉语言：用户气泡、融入页面的助手正文、浅色代码区、轻量附件、克制表格及跨页规则。v8 的 fixture JSON、`plainText`、Typst 数学表达式和虚拟路径不作为生产数据契约。
4. HTML 保持 Gemini 风格和网页交互；PDF 与 HTML 共用会话语义、Block AST、资源身份与获取状态，各自维护 CSS/Typst 排版。用户提供的 `gemini_f5a0a15bf78604a9_original.html` 只用于私下视觉与特性对照，不复制其中整站脚本、样式或账号数据，也不提交到仓库。
5. PDF 的成功条件是有效 PDF 字节已经由 Writer 落地；缺失图片、无法转换的公式和未知内容必须在输出或诊断中可见，不能被静默省略。

首版交互约束：Options 工作台保持打开时执行批量任务；关闭后未完成项不能标记成功，重开后可重试。弹窗的当前会话 PDF 入口应跳转/委托工作台，避免弹窗关闭中断重型编译。后台持续运行和 PDF/A 另立任务。

## 2. 现状与改造边界

| 现有位置 | 当前行为 | 本方案要改的边界 |
| --- | --- | --- |
| `src/types/conversation.ts` | 消息正文主要是 `content: string`；附件又分布在 `attachments/images/documents` | 保留旧字段兼容读取；增加来源格式标记和导出时生成的语义结构，不在第一批 PR 中重写全部旧库 |
| `src/core/engine/template/htmlTemplate.ts` | 自己解析 Markdown 并生成 HTML | 渐进改为消费共享 Block AST；保留现有 HTML 视觉与交互合同 |
| `src/core/engine/chatFormatter.ts` | `formatContent` 同步返回字符串 | 为 HTML/PDF 提供异步二进制 `ExportArtifact` 路径；旧格式可由适配器继续工作 |
| `src/core/engine/assetPipeline.ts` | 下载后直接写入 Writer | 提炼可复用的资源字节获取能力；PDF 编译前即可取得图片，同一资源不重复抓取 |
| `src/core/engine/export/exportOrchestrator.ts` | 主文件先写，附件随后异步排队 | PDF 分支须先准备待嵌入资源、再编译、再写入、最后更新记录 |
| `src/core/engine/writers/writerInterface.ts` | 已接受 `Uint8Array`、`ArrayBuffer`、`Blob` | 复用；验证实际 ZIP 与文件夹的 PDF 二进制写入 |
| `build.js`、`manifest.json` | 五个 IIFE bundle；未包含 PDF Worker/WASM/字体 | 将新运行资源纳入构建、打包和 MV3 CSP 验收 |

## 3. 真实数据契约

### 3.1 会话级外壳与 Block AST

共享模型采用包内 `canonical/src` 的 `CanonicalConversationBundle` 作为候选基线：`ConversationKey`、消息树、Block/Inline AST、assets、citations、observations、diagnostics。最初可由现有 `Conversation` 派生；将来归档 v1 保存加固后的同一版本化语义。HTML/PDF 使用同一共享分支投影，不让 PDF renderer 临时字段反向污染它。

包内 `BlockNode`/`InlineNode` 已覆盖嵌套列表、引用、代码、表格、数学、图片/文件、来源引用、公开思考、工具消息及未知节点。接入时加上运行时最大嵌套深度、节点数和字符串长度限制；`unknown` 的原始片段只作为诊断/后续重解析证据，公开 PDF/HTML 必须有可读回退。标题权威、分支选择与资源实体约束按接入方案第 3 节修订。

**内容解析原则**：新采集数据尽量标记 `contentFormat`（Markdown、HTML、plain）；旧数据按来源和受控识别规则转换。Takeout HTML 用 HTML parser 读取允许的语义元素，Markdown 用正式 parser 生成 AST；现有正则转换可作为行为参考和兼容 fallback。代码围栏、表格单元格、内联公式与图片链接在解析阶段只解析一次。无法确认结构时优先保留完整文本，并产生诊断。不得先生成 Markdown/HTML 再从最终导出文件反向提取 AST。

### 3.2 资源身份与实体

包内 `Asset` 保留资源 ID、原始引用、展示名、MIME、声明尺寸、来源和获取状态；消息通过块及 `associatedAssetIds` 关联资源。二进制存于有生命周期限制的资源解析器，由 `assetId` 查找。规范化阶段合并同一消息中 `attachments/images/documents` 的重复对象，并把正文中的图片引用指向同一资源 ID。

包内资源状态为 `available`、`remote`、`missing`、`failed`、`notFetched`；若产品需要 `omitted`，须在共享契约中定义其语义与迁移。PDF 和 HTML 都从实际解析结果决定占位内容；不能把 URL 存在等同于实体已保存。文件名和虚拟路径由打包层生成，拒绝 `..`、绝对路径和不可信协议。原附件是否另存到 ZIP/目录沿用 `includeAssets` 语义；产品界面需明确图片预览与原件保存的关系。

### 3.3 渲染器接口

以包内 `canonical/src/rendering.ts` 的 `ConversationRenderer.render(bundle, context)`、`AssetResolver` 和 `ExportArtifact` 为接口起点；接入 F4 时补取消信号、阶段进度、伴随资源计划及 Writer 写入结果。具体类型只在仓库中维护一份，不能让本文的示例接口与实现分叉。

HTML 与 PDF 各实现一个 renderer。`ExportArtifact` 的资源清单要经 Writer 路径明确落地；产物生成、实际写入和导出记录更新是三个独立阶段。旧 Markdown/JSON 同步 formatter 可先通过适配器接入，不要求第一轮改写全部格式。

## 4. PDF 专属流水线

```text
选中会话 → 获取详情与 Takeout 合流 → 语义规范化 → 资源计划/去重
        → 有界获取图片和附件 → Typst 传输数据 + 虚拟资源
        → 扩展内编译 PDF → 验证产物 → Writer 落地
        → 附件原件/诊断落地 → 完成该会话的 ExportRecord
```

1. **资源先行**：PDF 编译需要的图片必须在编译前取得。无法取得时把该图片标为 `missing/failed`，PDF 仍保留图片位置、名称和缺失说明；下载错误写入诊断。非图片附件可作为文件卡片呈现。图片数据可能需转换为 Typst 支持的格式，转换也要保留失败状态。
2. **Typst 适配器**：以包内 `toTypstV8Payload()` 为起点，只把经验证的 AST 字段映射成 v8 所需 JSON/虚拟文件。文本始终走 JSON 数据而非拼进 `.typ` 源；URL 只允许预期协议。公式保留原始 notation/source；受控转换器能证明可转换时才产生 Typst math，失败时使用原文回退。v8 当前 `eval` 读取的 `typst` 字段绝不接受平台原文直通。嵌套列表、表格合并等不能永久以压平代替，节点升级清单见接入方案第 4 节。
3. **视觉迁入**：以包内 `renderers/typst-v8/` 为视觉与模板基线，将 theme、components、render 文件作为版本化生产资源迁入仓库，保留独立的 demo/stress 夹具做视觉回归。迁入前记录原始文件版本与必要许可证；不得把机器上的字体名当成用户环境保证。生产模板读取适配器产物，不能依赖 fixture 路径。
4. **编译容器**：Options 页启动的扩展内 Worker；WASM、模板和中英文字体随包提供。`PdfCompiler` 封装初始化、虚拟文件、编译、诊断、取消和释放资源。生产 PDF 引擎已确定为 Typst WASM（`@myriaddreamin/typst.ts` 生态），已在最终 MV3 包离线实测中验证。
5. **内存边界**：按会话编译并及时释放虚拟文件、图片字节和 PDF 中间对象；远程资源获取可有限并发，Typst 编译初版单任务串行。复用资源字节供 PDF 嵌入与原件写入，避免重复下载和跨线程反复复制大 Blob。
6. **产物验证与提交**：检查编译返回非空、PDF 签名和解析结果，之后调用 Writer。会话最终状态以 PDF 写入结果和资源诊断决定；失败不能生成空白 `.pdf` 后记成功。已落地的 PDF 不因别的会话失败而丢失。

## 5. HTML 共用层的接入方式

HTML renderer 以包内 `renderers/html/` 为迁移骨架，读取同一 Block AST、共享分支投影和资源解析结果，保留当前 Gemini 风格的用户气泡、助手正文、思考折叠、代码复制、深浅主题与打印样式。来源引用、代码、数学公式和表格由 AST 的相应节点输出；不再由 HTML 模板独立猜 Markdown 语法。包内实现当前会输出全部分支、缺资源时可退回远程 URL，正式切换前必须按接入方案修复。

迁移采用对照切换：旧 `toHtml` 暂留，新增 AST 渲染路径，使用同一固定会话比对消息数、文本顺序、附件、链接及浏览器交互；视觉对照使用用户提供的网页快照和现有 HTML 基线。通过后切换正式路径，再移除旧解析器。单文件 HTML 要真正离线可读：所需 CSS/JS 随文件内嵌，图片选择内嵌数据或明确的 ZIP 内相对路径；远程 URL 只作可选原始链接，不能作为唯一图片来源。

## 6. 具体实施批次

| 批次 | 改动与交付物 | 前置/退出条件 |
| --- | --- | --- |
| D0 样本与对照 | 选取脱敏在线、Takeout、长会话、Imagen、代码、公式、表格、引用、缺图样本；记录旧 HTML 与 v8 PDF 视觉基线。用户原始网页快照仅在本地对照 | 固定输入、唯一消息标记、预期资源清单可复现；不提交账号数据 |
| D1 AST 契约 | 导入并加固包内 canonical TS/Schema/示例；标题权威、共享分支投影、`unknown` 回退、运行时校验及解析限制 | 正负例校验有效；所有消息顺序与正文可核对；缺时间不伪造；未知块不丢 |
| D2 内容解析 | Markdown/Takeout HTML/plain 转 AST；附件引用合并、去重；重点覆盖嵌套列表、宽表、代码、公式 | AST 夹具与来源内容逐项比对；异常输入可回退 |
| D3 HTML 迁移 | 以包内 AST HTML renderer 为骨架，接共享分支投影，迁入现有 Gemini 风格、离线资源策略与交互 | 现有 HTML E2E、内容与视觉对照通过，断网可读，旧入口再切换 |
| D4 资源层 | 抽出 `resolveAssetBytes`、状态、Takeout 回退、缓存及取消；Writer 继续负责持久化 | 一张图只抓一次；缺图、权限失败、取消的状态准确 |
| D5 PDF 运行实验 | 用固定 AST 样本在实际打包的 MV3 中离线编译；验证 CSP、WASM、字体、包体、内存与耗时 | 满足长期路线图 P0 的 GO 门槛并写决策记录；失败则不开放菜单 |
| D6 v8 renderer | 包内 v8 模板和 AST → Typst 适配器迁入；扩展缺失节点、公式回退、引用/时间/附件占位 | demo/stress 与真实样本逐页检查；PDF 文本可提取且完整；降级项有诊断 |
| D7 导出集成 | `ExportArtifact`、PDF 分支、ZIP/目录、格式记录、取消/重试、进度与弹窗委托 | 成功以实际文件为准；单会话失败不影响其余会话 |
| D8 产品验收 | Tier 1 全量、真实落盘校验、Tier 3 视觉审计、商店包/许可证/隐私文案 | 全部门槛按长期路线图 P4/P5 留证据；未运行项标记 BLOCKED |

每批做成可独立审查、可回滚的 PR。D5 可在 D0 后先做隔离风险前探，但正式 GO 测试必须使用 D1/D2 的真实 AST 与最终格式的商店包。共享契约变更先单独合入，再让 HTML 和 PDF 分支同时升级。每次提交 PR 前运行 `npm test`；影响打包时额外验证 `node build.js --pack` 的实际资源清单。依仓库 `AGENTS.md` 使用 worktree、自动合并及主目录同步流程。

## 7. 验收矩阵与失败判定

| 测试维度 | 必查结果 |
| --- | --- |
| 内容一致性 | 每条消息的唯一标记、角色、顺序、正文块均在 HTML 与 PDF 中可核对；思考/引用按格式政策呈现或明确说明 |
| 多模态 | 已获取图片实际嵌入 PDF，HTML 在断网时可显示；附件名称和所属消息正确；缺失资源有占位与诊断 |
| 排版 | 长用户气泡、长代码、宽表/跨页表、竖图、混排、公式、30 附件等 v8 stress 项无裁切、重复或空白异常 |
| 文件与运行 | PDF 可解析、可搜索；ZIP/目录产物实际落盘；断网下引擎和字体仍可用；取消后无假成功 |
| 批量 | 100 会话/至少 2,000 消息/50 MiB 附件压力集按 P0 预算测量；单项失败隔离，重试不重复标记完成 |
| 安全与隐私 | 无远程代码/字体；模板和链接输入经约束；网页快照中的账号数据不进测试夹具或发行包 |

验收报告同时记录 `PASS`、`FAIL`、`BLOCKED` 与原因。视觉截图只能证明排版，内容完整性要检查下载到磁盘的 HTML/PDF/ZIP；人为移除一条消息或一张必需图片时，相应断言必须失败。

## 8. 尚待实验确定的技术点

1. ~~Typst WASM 的具体包、版本、初始化方式与许可证；最终以离线 MV3 包、中文字体和压力测试结果决定。~~ → **已确定**：生产引擎为 Typst WASM（`@myriaddreamin/typst.ts` 0.7.0 生态），许可证见 `THIRD_PARTY_NOTICES.md`；已通过离线 MV3 包、中文字体和压力测试验证。
2. Worker 后端需要的跨源隔离是否与当前扩展资源访问相容。（“按 P0 比较其他本地 PDF 引擎”备选方案已废弃：生产引擎已定为 Typst WASM。）
3. 字体子集和 emoji 覆盖范围；需量化商店包体增长及缺字行为。
4. 对旧 `content` 混合 HTML/Markdown 的识别边界；必须用真实脱敏样本记录误判与回退率。
5. PDF 内嵌图片与“另存原始附件”选项的最终 UI 文案，避免用户误解输出内容。

这些问题在对应批次形成决策记录；当前方案给出了执行路径和验收条件，不把未完成的实验写成已验证能力。
