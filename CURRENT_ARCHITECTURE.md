# CURRENT_ARCHITECTURE.md

> 本文档是仓库架构现状的唯一状态表。AI 审计 / 清理时**必须先读本文档**：
> multi-provider 相关代码是 near-term planned architecture，**不是 dead code**，
> 不得以"当前只有一个 production 实现"为由删除其中任何部分。

完整架构细节见 [docs/architecture.md](docs/architecture.md)。

## 平台状态表（2026-09-27）

| 平台 | 状态 | 说明 |
|---|---|---|
| Gemini (`gemini.google.com`) | **production** | 唯一生产支持的平台。`GeminiProvider` 为完整实现：batchexecute RPC、实时嗅探、多账号 slot、Takeout 导入。 |
| ChatGPT (`chatgpt.com`) | **planned** | Provider interface remains the extension seam. ChatGPT / Claude / Grok adapters will be implemented only when their real production payloads are integrated and verified. |
| Claude | **planned** | 无实现。`getAITab` 已预留 `https://claude.ai/*` 模式映射。 |
| Grok | **planned** | 无实现。`getAITab`/`sendToAITab` 对未知 providerId 按 URL pattern 直通，无需改代码即可路由。 |

## Provider 相关 symbol 边界（PR #— provider roadmap boundary audit）

Verdict 定义：
- `KEEP-contract`：四个平台都需要的中性契约，保留。
- `GEMINI-SPECIFIC-misnamed`：名字中性、实际只服务 Gemini 的，报告中标出（本 PR 不改名）。
- `SCAFFOLD-unverified`：为 planned provider 搭的架子、未经真实验证，代码内以 `// @unverified-provider-scaffold` 标记（可 grep）。
- `UNKNOWN`：拿不准的——本轮为 0，全部已分类。

### `src/core/provider/`（扩展 provider 层）

| Symbol | Verdict | 备注 |
|---|---|---|
| `AIProvider`（interface） | KEEP-contract | 中性生命周期：`checkReadiness` / `listConversations` / `fetchConversationDetail` / `matchesUrl` / `fetchAsset?`。被 `resolveProvider` 及 3 个 content 模块使用。 |
| `ProviderConversationItem` / `ProviderConversationDetail` / `ProviderPageResult<T>` / `ProviderReadiness` | KEEP-contract | 中性形状，index signature 允许平台扩展字段。 |
| `ProviderRegistry`（`register`/`unregister`/`get`/`getAll`/`findByUrl`/`getDefault`） | KEEP-contract | 通用注册表契约。`getAll()`/`unregister()` 是注册表应有 surface，不是死代码。 |
| `resolveProvider()` | KEEP-contract | `syncEngine` / `liveSaveCoordinator` / `messageRouter` 共用。 |
| `GeminiProvider` | KEEP（production 实现） | 命名诚实。`fetchConversationDetail` 把完整 Gemini detail spread 进中性返回——这是生产适配器的本职，声明返回类型保持中性。 |
| ChatGPT / Claude / Grok adapters | planned | Provider interface remains the extension seam. ChatGPT / Claude / Grok adapters will be implemented only when their real production payloads are integrated and verified. |
| `export type { Conversation, ChatMessage, Attachment, TitleSources }`（`aiProvider.ts` 重导出） | GEMINI-SPECIFIC-misnamed | 模块头注释自称 "Universal AI Provider specification"，实际重导出 Gemini pipeline 类型（`TitleSources` 含 `rpc`/`dom`/`takeout`/`sniff`；`Conversation` 含 `hitGoogleLimit`/`isTakeoutOnly`/`accountSlot`）。已核实：仓内 0 外部引用。本 PR 不动，仅标出。 |
| `getAITab` / `sendToAITab`（`tabService.ts`） | KEEP-contract | provider→tab 路由契约。当前无 production caller（仅测试）——这是 planned architecture 的预期状态，不是死代码。 |

### `scripts/framework/`（Python Tier-2/3 测试框架——与上独立的另一套概念）

| Symbol | Verdict | 备注 |
|---|---|---|
| `ChatPlatformDriver`（ABC）、`PlatformCapabilities`、`TurnResult`、`PlatformRegistry` | KEEP-contract | 平台中性 driver 契约；当前唯一实现是 Gemini，但 ABC 本身就是为 ChatGPT/Claude/Grok 预留的 seam。 |
| `FeatureTestCase` / `DAGRunner` / `TestContext` | KEEP-contract | 平台中性 scenario contract。 |
| `GeminiPlatformDriver` / `GeminiDriver` / `GeminiChatSession` | KEEP（production 测试实现） | 命名诚实。 |

### 已知非 verdict 的跟进点（不属本 PR scope）

- `syncEngine.ts` 注释承认 "the provider-neutral declared type is still stabilizing"，有一处 `as any` 绕过——待 provider 层稳定后收敛，不在本 PR 处理。
- Provider interface remains the extension seam. ChatGPT / Claude / Grok adapters will be implemented only when their real production payloads are integrated and verified.

## `scripts/framework/` 平台层级 audit（PR12，2026-09-27）

问题："为四个平台到底需要几层？" 结论：**7 层各有独立职责，无重复层**；唯一可删的是执行器上的一个已废弃入口。

| 层 | 位置 | 职责（一句话） | 谁在用 | Verdict |
|---|---|---|---|---|
| `ChatPlatformDriver`（ABC）+ `PlatformRegistry` | `scripts/framework/driver/platform_driver.py` | 平台自动化抽象契约（`build_turn_pipeline` 等）+ 驱动注册/发现 | `GeminiPlatformDriver` 实现；`cases/base.py` 经 registry 创建 | KEEP-contract（PR13） |
| `GeminiPlatformDriver` / `GeminiChatSession` | `scripts/framework/driver/gemini_driver.py` | 唯一 production driver 实现；`build_turn_pipeline` 产出 5 个原子动作序列 | cases / runner / scripts | KEEP（production 实现） |
| `SerialActionExecutor` | `scripts/framework/pipeline/executor.py` | 单飞串行执行器：状态机前置校验 + 失败即熔断 | `gemini_driver.execute_turn_pipeline`、`actions.py`、`cases/base.py` | KEEP；但 `execute_standard_turn`（硬编码 5 动作的旧入口，全仓 0 caller，已被 driver-driven 路径取代）**已删除** |
| `AtomicAction` 原语 | `scripts/framework/pipeline/actions.py` | 原子动作（AssertIdle/StagePrompt/SingleClickSend/AwaitStreamSettled/HumanCooldown/ClickNewChat/NavigateChat） | driver 的 `build_turn_pipeline`、tests | KEEP（平台中性 pipeline 原语） |
| `CDPActions` / `ExtensionActions` | `scripts/framework/actions.py` | 遗留命令式 CDP helper（静态方法）；**不是重复层**——`send_gemini_turn` 等已收敛为委托到 driver pipeline 的薄适配器 | `gemini_driver`、`cases/*`、`environment.py`、scripts、tests | KEEP（适配器层） |
| `SafeInteractionGateway` | `scripts/framework/gateway.py` | 安全守门：URL 白名单 / 冷却 / 审计日志 / CAPTCHA 熔断 | `actions.py`、`gemini_driver`、`pipeline/actions.py`、tests | KEEP |
| `FeatureRegistry` + `FeatureTestCase` + `DAGRunner` | `scripts/framework/features.py`、`scripts/framework/cases/base.py` | 特性声明注册表 + 用例基类 + 依赖 DAG 调度 | `runner.py`（FrameworkRunner）、tests | KEEP |

"两套 Actions" 澄清：`framework/actions.py`（命令式 helper）与 `pipeline/actions.py`（原子动作原语）是**不同抽象层级**，前者已委托给后者所在的 pipeline，不存在"同一职责两套实现"。

## Maintenance Convergence Status

Status: COMPLETE

### Storage

Historical storage compatibility is owned by the startup migration boundary.
Normal runtime storage readers operate on canonical storage only.

### Math Conversion

Decision: HARDEN.

The custom converter remains the production implementation.
New real-world LaTeX patterns must enter the semantic regression corpus.
Unsupported syntax must fail closed with diagnostics.

### Markdown Parsing

Decision: KEEP.

The current Canonical Markdown parser is not considered a maintenance hotspot.
No parser replacement or third-party parser migration is planned.

### Architecture Work Policy

Future architecture work must be triggered by demonstrated development friction,
not by file size, abstraction count, or speculative cleanup.
