## Current project scope (owner decision, 2026-11-08)

- Release only Gemini Export functionality: local-first, Gemini Web + Takeout, no own server, no user-conversation delete operation.
- ChatGPT, Claude, Grok remain future integration sources only: no active UI, no optional host permissions, no packaged runnable content scripts.
- **Do not enable auto-merge of this migration PR until real account E2E, Takeout ZIP roundtrip, legacy 1.7.0 migration, and account isolation are independently verified.** Do not install/reload the user's current extension or publish to Chrome Web Store without explicit approval.
- Preserve parent history d274e1448231b310a16ceeb9194dbd248ad4e8f1 and review unique code before promoting new upstream architecture. Never claim all history when provider returns provider_limit.
- Never bypass Gemini-side pagination limits or authentication. Use official Google Takeout as a supplemental authorized source.

# AI 助手与自动化协作指南 (AI Agent Guide & Rules)

本文件为所有协助开发与维护本项目（Gemini Exporter）的 AI Agent（包括 Antigravity、Claude Code、Cursor、Copilot、Codex 等）提供统一规范与操作准则。

---

## 一、核心工作流原则 (Core Principles)

1. **本地核心代码永远保持 main 的最新状态**：
   - 本地仓库主目录（Core Repo）始终停留在 `main` 分支并保持与远端最新状态同步。
   - 严禁在本地主目录的 `main` 分支上直接修改、提交或开发业务代码。

2. **使用 Git Worktree 进行功能迭代**：
   - 所有的功能开发、Bug 修复、重构与测试，必须基于 `main` 通过 `git worktree` 创建一个干净的独立工作副本和对应的新分支（如 `feature/...`、`fix/...`、`docs/...`）。
   - 在 worktree 中进行编码、测试与本地提交。

3. **严禁直接 Push 到 main，通过 PR + 自动合并 (Auto-Merge) 流程**：
   - **绝对禁止直接 push 到 `main` 分支**。
   - 开发与测试验证完成后，将特性分支推送到远程仓库并创建 Pull Request：
     ```bash
     gh pr create --base main --title "..." --body "..."
     ```
   - **全自动 CI 门禁与合并（0 人工介入）**：创建 PR 后立即启用 GitHub 服务端 Auto-Merge：
     ```bash
     gh pr merge --auto --squash --delete-branch
     ```
     GitHub 服务端会自动挂起，待门禁 CI（`Unit Tests & Syntax`、`Playwright E2E Tests`、`CodeQL`）全绿通过后自动 Squash Merge 并删除远程分支，无需任何人工审批或手动点击。
   - PR 自动合并完成后，清理本地 worktree 副本与临时分支，并在主目录执行 `git pull --ff-only` 保持与 `main` 最新同步。

---

## 二、三层测试体系规范 (Three-Tier Testing Architecture)

本项目严格区分并建立了三层测试体系，任何 AI 在提交代码或宣称功能完成前，必须严格依照下述标准执行验证：

### 第一层：CI 自动化门禁测试 (Tier 1: Fast & Headless)
* **执行命令**：
  - **全量门禁**：`npm test`（对应 `node scripts/check-zero-any.cjs && npm run type-check && python3 tests/run_tests.py && node build.js && playwright test`）。
  - **增量极速（推荐日常开发使用）**：`npm run test:changed`（基于 Git 差异进行**模块级反向依赖分析与传递闭包推导 (Transitive Impact Analysis)**，若修改底层依赖则自动递归追溯并运行所有直接与间接关联模块及对应 Playwright 规格，耗时仅 5~15 秒）。
  - **影响分析报告**：`python3 scripts/test_impact_analyzer.py --summary`（打印当前改动对全仓模块与测试的传递影响拓扑）。
  - **单点定向单元测试**：`python3 tests/run_tests.py --filter <keyword>`（如 `python3 tests/run_tests.py --filter storage`，秒级验证指定模块）。
* **适用场景**：日常功能开发与单步迭代推荐使用 `npm run test:changed` 极速自测；每次提交 PR 前必须全量通过 `npm test`，GitHub Actions 门禁对此强制校验。
* **特性**：轻量极速，包含 scoped zero-any 门禁、TypeScript 严格类型检查、当前全量单元测试套件、esbuild 生产 Bundle 打包构建校验与当前全量无头 Playwright 端到端用例（含 1:1 HTML 导出、老会话置顶升权、确证远端删除后的同 Key 原子清理、显式本地清理及 Takeout 标题升级视觉审计），完全自包含，不依赖外网与真实 Google 账号。

### Tier 2/3 本地测试权限原则
* 为避免纯净重装后的平台授权弹窗阻塞自动化，Tier 2/3 共用重装入口在加载扩展期间，将 `optional_host_permissions` 临时合入 `host_permissions`，将 `optional_permissions`（若有）临时合入 `permissions`，保留已有 required 权限并去重。适用于 Gemini 及 Tier 3 的重装/重置入口。ChatGPT / Claude 默认使用 `temp/`（git-ignored）内的独立安装副本，将对应平台所需 host 权限改为 required，源 manifest 始终不变；仅专门验证 optional 授权时，可设置 `TIER2_CHATGPT_REQUIRED_HOSTS=0` / `TIER2_CLAUDE_REQUIRED_HOSTS=0`。
* 临时 manifest 只用于本地测试安装。共用重装入口在加载结束后（包括失败或异常）立即按原始字节恢复源文件；Chrome 已加载的测试实例继续使用安装时的 required 权限。手动重载或重启 Chrome 后若需继续测试，应重新走测试重装入口；ChatGPT / Claude 的临时安装副本仅保留在 ignored 目录。
* **临时权限提升严禁 check in、提交 PR 或进入发布包**。提交或打包前必须确认 `manifest.json` 没有此类差异；若进程被强制终止导致未恢复，先恢复原来的 optional 配置。不得使用 `skip-worktree` / `assume-unchanged` 隐藏差异。
* 正式产品仍使用 optional 平台权限。此测试模式不验收真实授权弹窗、拒绝或撤销权限等行为；这些场景须使用原始 optional manifest 单独验证，不能因 Tier 2/3 通过而宣称通过。

### 第二层：真实调试 Chrome 全流程实跑测试 (Tier 2: Live Debug Staging)
* **执行命令**：`npm run test:tier2`（对应 `python3 scripts/test_live_chat_and_export.py`）。
* **适用场景**：修改了 Protobuf/JSPB 解析引擎、Google Takeout 导入逻辑、会话排序、网络请求拦截或发布新版本前。
* **环境准备**：需先通过 `./scripts/open_test_chrome.sh`（Windows 环境运行 `.\scripts\open_test_chrome.ps1` 或 `.\scripts\open_test_chrome.cmd`）启动开启 9222 调试端口的独立 Chrome。三个启动器默认使用 `--headless=new`，所有平台 Tier 2 / Tier 3 共用后台虚拟窗口，避免抢占桌面焦点。首次登录手动加 `--headed`，登录后正常关闭该测试 Chrome，再不带 `--headed` 重启；不要用手动登录实例跑自动测试。已有有窗口实例不能原地切换，启动器仍拒绝替换或终止占用 9222 的浏览器。
* **运行模式与场景调度机制**：
  * **统一标准模式：动态 20 题多模态场景池机制（默认行为）**：
    1. 项目在 `scripts/test_scenario_pool.json` 维护了 20 个覆盖 10+ 领域的高价值测试场景（包含 AI 图像生成、LaTeX 公式、Markdown 表格、多语言混排、长代码等全模态特性）；
    2. 运行 `npm run test:tier2`（或 `npm run test:tier2 -- --pool`），自动从池中出队消费 2 个最新场景（不强制现场回复类型，图片能力由固定 golden 会话验收），消费记录与归档写入 `temp/scenario_pool/`（git-ignored），corpus 文件本身不被修改；
    3. **AI 补仓铁律（用 2 补 2，常驻 20 题）**：AI 助手在协同开发、跑测试或提交 PR 前，必须运行 `python3 scripts/manage_scenario_pool.py status` 检查水位。若水位低于 20 个，必须针对当前缺口领域构思全新多模态题材补充回 20 题，杜绝同一题材（如深空探测器）反复堆积。
  * **自定义外挂数据集模式 (`--dataset`)**：
    - 支持通过 `--dataset <path>` 传入自定义的 JSON 测试用例文件，执行器将直接加载并运行该数据集。

  * **结果导向**：等待器只观察新回复是否结束并稳定，不根据提示词关键词、预期文本/图片类型或扩展嗅探事件决定完成。图片验收读取实际导出的文件，按会话与轮次验证图片引用、附件可解码，并将导出画面与独立采集的网页图片比较；页面有图或附件非空均不能单独判定通过。实时回复若实际含图，其实时落盘文件执行同样核对。

  * **通用验收铁律（四大不可逾越标准）**：
    1. **全流程全特性强制闭环（物理禁止跳过）**：必须真实驱动 Gemini 发帖并等待全部流式回复物理落地；所有测试阶段（扩展重装、新手向导、实时发帖、老会话追加置顶、确证远端删除与同 Key 原子清理、Takeout 合流导入与 6 会话联合规范导出）强制 100% 完整闭环执行，测试脚本已物理移除所有跳过开关（如 `--skip-chat`、`--skip-takeout`、`--skip-reinstall`、`--skip-tour`），严禁任何形式的绕过或缩水；
    2. **必须实际检验导出 Markdown 文件内容（严禁仅凭内存判断）**：测试脚本会自动将导出的 ZIP 下载到磁盘并解压，必须逐字核对会话 1 全部 5 轮与会话 2 全部 8 轮提问与回答在 Markdown 中 100% 物理存在；
    3. **必须校验老会话追加提问实时置顶、Google Takeout 离线导入与全量历史合流及网页端确证删除与同 Key 原子清理**：
       - **老会话实时置顶升权 (Stage 2.5)**：会话 2 生成完毕后，测试流自动回访较早创建的会话 1 并发送追加提问，检验请求绑定的被动来源捕获经 L1→L2 提交 Index 活跃时间后，并在 Options 工作台中无需刷新即自动提升至列表首位（高于会话 2）；
       - **Takeout 离线合流**：测试流会自动读取预置的 `tests/fixtures/gemini_takeout_clean.zip`，检验离线导入初始提问前缀临时标题（`titleSource: derived`），随后触发【同步会话】(`btnSyncAll`) 地毯式分页同步所有云端历史，核实 Takeout 临时标题被在线 RPC 权威升级覆盖（`titleSource: provider`）；
       - **确证远端删除与同 Key 原子清理**：通过【瞬态自毁会话】(Live Ephemeral Chat) 真实验证网页端删除时通过 RPC 拦截与消息桥接在无需刷新的情况下确认请求绑定的删除回执，经 L1 唯一删除入口调用 L2，原子删除同一 ConversationKey 的 Index、Detail、ExportRecord，并在提交后通知 Options 移除该项；删除前必须确认同 Key 本地事实已存在，其他账号和无关会话保持不变。已删除会话不写 tombstone/cloudAvailability，也不保留旧删除围栏；
    4. **必须通过多模态联合导出规范断言**：当次导出会精准联合勾选 2 个现场新问答会话 + 4 种指定核心分类历史会话（AI Imagen 生图、Python 高质量代码块、Markdown 量子对比表格、深空探测长文本报告），解压后逐一核验新会话 100% 物理轮次及 4 大类别黄金语法特征与物理附件落地（索引文件、YAML Frontmatter 7 键闭合、角色交替与时间戳、0 遥测噪点、图片附件实体非空、AI Imagen 生成图模型归属断言）。

---

### 第三层：纯视觉 AI 盲测与 UI 质检体系 (Tier 3: Pure Visual Playground & Autonomous QA Agent)
* **架构定位**：Tier 3 采用**纯截屏感知（0 DOM 树泄露）**与硬件级鼠标/键盘物理驱动，复用 Tier 2 的确定性阻塞挂起机制，提供黑盒环境下的自主 UI 体验体检与 AI 协作靶场。**已物理彻底删除所有硬编码坐标与假 exit-0 捷径**，仅支持且必须通过两大途径执行：
  - **途径一：无 Context 子智能体自主探索 (Subagent Mode, 首选推荐)**：宿主 Agent 通过 `invoke_subagent` 拉起一个无上下文历史污染的子智能体，由子智能体基于纯视觉截屏在黑盒环境中自主探索；
  - **途径二：自定义 / 第三方 AI 接口驱动 (Custom AI API Mode)**：通过 `CustomAIVisionProvider` 连接兼容 OpenAI 或自建多模态端点，由外部大模型驱动 `AutonomousVisualAgent` 自动推演。
* **《Tier 3 AI 助手纯视觉执行铁律》**：
  1. **严禁凭空写死坐标或伪造退出**：所有 `--smoke`、硬编码坐标点击等捷径已物理删除，严禁任何 AI 助手以静态点击或假 exit 0 冒充 Tier 3 测试；
  2. **宿主 Agent 必须通过 `invoke_subagent` 拉起无 Context 子智能体**：当宿主 Agent（如 Antigravity）被指派执行 Tier 3 视觉体检任务时，**必须开启一个全新无历史上下文污染的子智能体 (`Tier 3 Visual QA Explorer`)**；
  3. **受测智能体严格隔离于 7 大受控 CLI 接口**：受测子智能体只能且仅能调用 `scripts/visual_agent/cli.py` 的 7 大原语（`screenshot`, `click`, `type`, `scroll`, `wait-on`, `reset`, `evaluate-export`），0 DOM 泄露，严禁直接注入 JS 或查询 DOM 树选择器；
  4. **必须以纯视觉截屏闭环推演并真实产出 Scorecard 与 HTML 审计报告**（保存于 `tests/output/visual_audit/` 目录）。

  5. **Subagent 模式由宿主 Agent 编排两次 Checklist 提醒，子智能体保持自主探索**：仅适用于上述途径一，具体协议见下节；不得在首次探索前向子智能体泄露 Checklist。

#### Tier 3 Subagent：父 Agent 三轮执行协议（1 次自由探索 + 2 次 Checklist 提醒）

当用户要求“跑 Tier 3”时，**宿主/父 Agent** 负责以下编排，而不是让子 Agent 自行读清单或管理提醒次数：

1. **首轮自由探索**：按现有流程准备一次 Playground，创建**一个**全新、无旧会话上下文的视觉子 Agent；只给它现有 Tier 3 的黑盒探索目标和 7 大 CLI 约束，**不要传 Checklist 正文、文件路径或清单主题**。子 Agent 自主探索，认为充分后返回阶段小结；这只是本轮返回，不是整场 Tier 3 的最终结束。
2. **第一次 Checklist 提醒**：父 Agent 此时才读取 [Tier 3 Exploration Checklist](docs/tier3-exploration-checklist.md)，把**完整清单正文直接作为新消息发送给刚才同一个子 Agent**（复用其 agent ID / session / 对话上下文，而非重新 spawn）。要求它回顾已探索区域并自由继续，认为充分后返回阶段小结。
3. **第二次 Checklist 提醒**：子 Agent 第二次返回后，父 Agent 再次向**同一个子 Agent**发送**同一份完整 Checklist 正文**，让它进行最后一轮自由探索。不要替换成预定点击步骤。
4. **最终汇报**：只有第三轮返回后，父 Agent 才整理三轮实际发现、未验证的功能以及现有 Tier 3 所需 Scorecard / HTML 报告。未实际操作或因环境限制无法验证的内容，不得宣称通过。

**边界**：两次提醒之间始终沿用**同一子 Agent 会话与原 Playground 的浏览器/扩展状态**；不因阶段切换重装、清空或重新初始化。无额外 Agent、Observer、覆盖率打分、强制 100% 清单通过率、时间/操作预算。Checklist 只是探索提示，不是测试脚本。父 Agent 只在子 Agent 自认本轮结束时发送下一次提醒，不应每个动作干预。

**执行能力前提**：宿主框架必须支持向既有子 Agent 继续发消息（resume/send input 等等，具体 API 随框架而异）。如果只支持一次性 spawn、无法恢复**同一个子 Agent 会话**，应明确报告该限制，**不得用三个全新子 Agent 冒充三轮续跑**，也不得声称完成此协议。自定义 AI API 模式维持现有行为，不套用此父子 Agent 编排。


---

## 三、常用辅助命令速查

```bash
# 运行 Tier 1 依赖感知增量测试 (极速 5~15s，日常开发首选)
npm run test:changed

# 查看当前改动的影响拓扑与受影响测试清单
python3 scripts/test_impact_analyzer.py --summary

# 定向过滤运行特定单元测试 (秒级完成，如仅测 storage)
python3 tests/run_tests.py --filter storage

# 启动独立调试环境 Chrome (端口 9222)
./scripts/open_test_chrome.sh          # macOS / Linux
.\scripts\open_test_chrome.ps1         # Windows PowerShell
.\scripts\open_test_chrome.cmd         # Windows CMD

# 查看场景池当前水位与领域特征分布
python3 scripts/manage_scenario_pool.py status

# 运行全量实跑测试 (标准模式：从 20 题场景池消费 2 个最新多模态场景)
npm run test:tier2
# 或: python3 scripts/test_live_chat_and_export.py

# 运行自定义外挂数据集测试
python3 scripts/test_live_chat_and_export.py --dataset <path_to_custom_dataset.json>

# 单独对任意导出解压目录运行规范断言器
python3 tests/helpers/export_spec_asserter.py <解压目录路径>

# 途径一：就绪交互靶场 (供人类或无 Context 子智能体 Subagent 探索)
python3 scripts/test_visual_agent.py --playground [--target options|popup|gemini]

# 途径二：通过自定义 AI 接口驱动自主推演
python3 scripts/test_visual_agent.py --api --endpoint <url> [--ai-review]
```


