# Rendering Contract v1 接入 PDF 路线

> Status: SUPERSEDED
>
> This maintenance/implementation plan has been completed/re-audited.
> Do not treat unchecked historical items as active backlog.
> See CURRENT_ARCHITECTURE.md and the Post-Maintenance Closeout decision.

> 历史状态：实施基线与差异清单，2026-09-25（本路线已全面合流并经由 Canonical AST 统一）。

## 1. 采用决定与边界

以该包的 `canonical/` 作为 F2 Block AST 的**候选基线**，以 `adapters/typst-v8/` 和 `renderers/typst-v8/` 作为 Typst 路线的实现起点，以 `renderers/html/` 作为 AST 驱动 HTML 的对照实现。类型、JSON Schema、示例、实现和测试须在仓库中收敛为一套版本化契约；不能长期把 ZIP 当运行依赖，也不能把演示夹具当生产数据。

`canonical/` 表达会话身份、消息树、块/行内语义、资源、引用、来源与诊断。HTML 和 PDF 消费**同一份已验证、已选定分支的语义视图**。Typst v8 JSON 只在一次渲染内存在；`plainText`、转换后的 Typst 数学、虚拟资源路径、气泡尺寸和分页均不得写回 canonical/归档。历史 1:1 HTML 快照仅作本地对照；先检查和脱敏，不能原样提交含账号或会话数据的文件。

这不改变长期路线图 P0 的引擎选择：Typst v8 是已确定的视觉基准和首个实验实现，Typst WASM 是否成为产品运行引擎仍由离线 MV3 实验决定。若引擎不达标，canonical AST、HTML renderer 和验收夹具继续使用，PDF renderer 再接另一引擎。

## 2. 实际数据流

```text
当前 Conversation / Takeout / 将来 ChatGPT 原始数据
  → Provider normalizer（保留来源证据和旧正文）
  → CanonicalConversationBundle v1
  → 运行时校验 + 消息树/所选分支投影 + 内容完整性清单
  ├─ HTML renderer → 本地资源清单 → Writer → HTML/附件
  └─ Typst v8 adapter → 渲染 JSON + 虚拟资源/字体 → 本地编译 → PDF 字节
                                                        → Writer → PDF/可选原件
```

导出记录只能在 Writer 实际写入成功后完成；HTML/PDF 的诊断随产物关联。缺资源不能通过远程 URL 伪装为离线成功。

## 3. 首批合入前必须修的共享契约

| 项目 | 包内现状 | 接入要求与验收 |
| --- | --- | --- |
| 消息顺序 | `conversation.messages` 数组顺序是唯一权威顺序 | HTML 与 Typst 直接按数组顺序渲染；PDF 按 resources → payload → compile → deliver 四阶段执行。消息 ID 必须存在且唯一，生产导出拒绝 `MSG_BAD_ID` / `MSG_DUP_ID` |
| 标题权威 | `provider/user/derived` 不足以表达当前 `rpc/dom/takeout/sniff/api-detail/legacy` 升级规则 | 保留来源候选与权威等级，旧标题升级回归通过；不能因一次低可信观察覆盖高可信标题 |
| 未知内容 | `unknown` 可仅有 rawRef/payload，`unknownInline` 可没有可读文本 | canonical 保留原始证据；渲染视图必须有可见 fallback 或明确诊断，禁止空白吞块 |
| 资源 | `available` 是元数据；HTML 可回退 `sourceUrl` | 导出前解析真实字节、状态和归档局部路径；HTML 离线可读，PDF 虚拟文件确实存在；缺失实体给占位与诊断 |
| 渲染接口 | `RenderContext` 缺取消/进度；`ExportArtifact` 缺伴随文件 | 补 `AbortSignal`、阶段进度、资源/伴随文件计划及写入结果；与现有 Writer、批量任务对接 |
| 表示独立性 | canonical 的 `ThoughtBlock.initiallyCollapsed` 是视图状态 | 折叠默认值移到 HTML renderer 配置；归档只保留平台实际公开的思考内容与语义 |
| 输入校验 | 包内检查以示例、文件存在和名称匹配为主 | 类型与 JSON Schema 对齐；加入运行时结构/大小/路径/URL 校验和负例（缺失/重复消息 ID、伪 available、恶意链接、损坏资源）；合约测试在仓库 CI 运行 |

`ConversationKey.accountId` 依赖 F1 复合身份迁移；F2 接入不得临时造一个可能碰撞的账户 ID。来源时间未知时保持未知，`observedAt` 不冒充服务端时间。

## 4. Canonical → Typst v8 的落地策略

先复用包内 `toTypstV8Payload()` 对接原 v8 模板，随后逐项提升到目标支持范围。适配器负责校验和转换，不直接将平台正文拼入 `.typ` 源；仅可信转换器产出的数学表达式可进入 v8 的 `eval(..., mode: "math")`。

| Canonical 内容 | 现有 v8 对接 | 首版处理 |
| --- | --- | --- |
| paragraph、heading 1–3、code、普通 image/file、基本 table | 可直接映射 | 保持原顺序、链接/附件归属；检查 PDF 可提取文本和图片实体 |
| heading 4–6、nested/multi-block list、递归 quote | 当前降级或压平 | 扩展 v8 transport 与组件，保留层级、块边界和列表起始编号；未实现前仅作带诊断的原型，不计完整支持 |
| table 多表头、合并单元格、caption、对齐 | 当前丢部分结构 | 扩展 transport 与表格排版；无法正确排版时显示可读的逐行回退，不静默丢表头/单元格 |
| inline/block math | 需要受控转换；失败显示原文 | 保留原 notation/source，转换成功才交 Typst；失败输出原式与诊断 |
| citationRef/group、thought、toolCall/result、strikethrough、thematicBreak | 当前部分转文本/note | 给出明确定义的 PDF 呈现；保持可见标签、内容顺序和引用目标，所有降级记录诊断 |
| unknown/unknownInline、缺失资源 | v8 有可见 fallback | fallback 必有可读文字；资源失败显示所属消息、名称与原因 |

适配器返回 `{ payload, virtualFiles, diagnostics }` 的渲染准备结果；`virtualFiles` 从已验证的资源字节和模板/字体构造，路径由打包器生成并限制在虚拟根目录。不得仅凭 `assetPath()` 返回字符串就判断图片可用。Typst 输出再经过 PDF 解析、文本顺序和图片/附件清单校验，才允许标记成功。

## 5. HTML 接入策略

包内 AST-native HTML renderer 是迁移骨架，不是现有 1:1 HTML 的可直接替换品。它目前缺少完整交互和视觉等价证明，且读取全部分支；接入前必须改为消费共享分支投影。`href`、图片 URL、可注入的数学 HTML、内嵌 CSS/JS 建立独立信任边界；导出所需图片使用已保存实体的相对路径或内嵌字节，远程地址只可作为明确标注的原始链接。

迁移顺序为内容等价（消息、角色、顺序、代码、公式、表格、引用、思考、图片）→ 离线资源 → 视觉/交互对照（主题、复制、折叠）→ 切换正式 HTML 入口。旧解析器在等价门槛通过前保留；不能由最终 HTML 反向生成 canonical AST。

## 6. 可审查的实施 PR 与退出门

| PR/阶段 | 交付物 | 必过门槛 |
| --- | --- | --- |
| F2a 契约导入 | 选取包内 canonical TS/Schema/示例并记录来源版本；补标题候选、未知 fallback、共享投影与运行时校验 | 正负例均能识别；旧 Gemini 身份/标题不回退；树和未知块归档往返 |
| F2b Gemini normalizer | 现有正文、思考、引用、附件到 AST；原始证据与来源时间保留 | 固定脱敏样本的消息和块顺序、实体引用逐项一致 |
| F2c HTML 迁移 | AST HTML renderer、离线资源、现有交互与视觉移植 | 同一投影与旧 HTML 内容等价，断网仍可读，现有 HTML E2E 通过 |
| P0 原型 | 同一 canonical 样本喂 Typst v8 和备选引擎；真实 MV3 包、离线中文与压力测试 | 按长期路线图 P0 记录 GO/NO-GO；不提前开放菜单 |
| P1a Typst 桥 | adapter、v8 组件扩展、公式/引用/未知回退、黄金样本 | 上表承诺的节点可见且可提取；降级清单逐项有诊断 |
| P1b–P3 运行与集成 | 资源字节、虚拟文件、Worker/WASM/字体、取消进度、PDF Writer 与批量记录 | 包内离线编译、实际落盘、失败不假成功、重试不重复标记 |
| P4–P5 审计与发布 | 文本/图片/顺序自动审计，Tier 1/2/3 与发布证据 | 路线图规定的内容、性能、许可证、隐私门槛通过 |

F2a/F2b/F2c 可按风险拆成更小 PR；P0 的一次性运行风险前探可提前，但正式比较用真实 canonical 样本和最终 MV3 包。每批改动按仓库 `AGENTS.md` 在 worktree 开发，PR 前执行完整 `npm test`。

## 7. 此包已经证明与尚未证明的内容

包内 TypeScript 类型检查、canonical 示例检查与文件映射检查可通过；这些检查不验证 HTML/PDF 等价，也不实际编译 Typst。包内 HTML 参考快照和 v8 stress corpus 是对照材料。真正的交付证据须来自仓库的脱敏黄金样本、落盘产物检查和最终扩展包的离线 MV3 测试。
